import type { DAGNode } from "@agent-mesh/envelope";

export const FAIL_SAFE = {
  PARTITION_ISOLATION: "PARTITION_ISOLATION", // >60s offline → freeze + 503
  DEAD_LETTER: "DEAD_LETTER",                 // all routes exhausted → DLQ
  BREAK_GLASS: "BREAK_GLASS",                 // signed master key → cluster halt
} as const;

export interface EscalationContext {
  nodes: Map<string, DAGNode>;
  dlq: Array<{ message: unknown; reason: string; ts: number }>;
  maxRetries: number;
  /** Called when a node needs to receive a message. Returns true if delivered. */
  deliver: (targetId: string, message: unknown) => Promise<boolean>;
  /** Out-of-band alert (SMS, PagerDuty) — independent of NATS/Redis */
  alertOOB: (payload: unknown) => Promise<void>;
}

/**
 * Walk the ownership DAG upward from `startId`.
 * Returns the first ACTIVE node encountered, or null if none found.
 * Cycle-safe via visited set.
 */
export async function resolveOwner(
  startId: string,
  ctx: EscalationContext
): Promise<string | null> {
  const visited = new Set<string>();
  let cursor: string | undefined = startId;

  while (cursor) {
    if (visited.has(cursor)) {
      // Cycle detected — bail out
      await panic(ctx, { from: startId }, `Cycle at node: ${cursor}`);
      return null;
    }
    visited.add(cursor);

    const node = ctx.nodes.get(cursor);
    if (!node) {
      await panic(ctx, { from: startId }, `Unregistered node: ${cursor}`);
      return null;
    }

    const parent = node.parent;
    if (!parent) break; // reached root with no human found

    const parentNode = ctx.nodes.get(parent);
    if (!parentNode) {
      await panic(ctx, { from: startId }, `Broken parent pointer: ${parent}`);
      return null;
    }

    if (parentNode.status === "ACTIVE") return parent;

    cursor = parent; // node unreachable — keep walking up
  }

  return null;
}

/**
 * Find the highest human authority in the network.
 * Used as last-resort before dead-letter.
 */
export function findRootHuman(
  startId: string,
  nodes: Map<string, DAGNode>
): string | null {
  let cursor: string | undefined = startId;
  let lastHuman: string | null = null;

  while (cursor) {
    const node = nodes.get(cursor);
    if (!node) break;
    if (node.type === "HUMAN") lastHuman = cursor;
    cursor = node.parent;
  }

  return lastHuman;
}

/**
 * Main escalation entry point.
 * Tries: direct owner → walk DAG → root human → dead letter
 */
export async function escalate(
  agentId: string,
  message: unknown,
  ctx: EscalationContext
): Promise<void> {
  // 1. Try direct owner
  const owner = await resolveOwner(agentId, ctx);
  if (owner) {
    const delivered = await ctx.deliver(owner, message);
    if (delivered) return;
  }

  // 2. Try root human
  const root = findRootHuman(agentId, ctx.nodes);
  if (root) {
    const delivered = await ctx.deliver(root, message);
    if (delivered) return;
  }

  // 3. All routes exhausted → dead letter
  await panic(ctx, message, "All escalation paths exhausted");
}

async function panic(
  ctx: EscalationContext,
  message: unknown,
  reason: string
): Promise<void> {
  const entry = { message, reason, ts: Date.now() };
  ctx.dlq.push(entry);
  await ctx.alertOOB(entry).catch(() => {
    // OOB alert must never throw — log silently
    console.error("[agent-mesh] OOB alert failed:", reason);
  });
}
