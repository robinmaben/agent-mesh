/**
 * agent-mesh POC demo
 * Simulates: agent_worker → agent_supervisor → human:alice
 *
 * Run: npx tsx apps/demo/src/index.ts
 * (No NATS/Redis needed — uses in-process mock transport)
 */

import type { DAGNode } from "../../packages/envelope/src/index.js";
import {
  escalate,
  findRootHuman,
  FAIL_SAFE,
  type EscalationContext,
} from "../../packages/escalation/src/index.js";

// ─── Mock network topology ──────────────────────────────────────────────────

const nodes = new Map<string, DAGNode>([
  [
    "did:agent:net1:orgA:worker",
    {
      id: "did:agent:net1:orgA:worker",
      type: "AGENT",
      status: "ACTIVE",
      parent: "did:agent:net1:orgA:supervisor",
      trust_level: "LOW",
      capabilities: ["process-task"],
      last_seen: Date.now(),
    },
  ],
  [
    "did:agent:net1:orgA:supervisor",
    {
      id: "did:agent:net1:orgA:supervisor",
      type: "AGENT",
      status: "UNREACHABLE", // <-- intentionally down to force escalation
      parent: "did:human:net1:orgA:alice",
      trust_level: "MED",
      capabilities: ["supervise", "approve"],
      last_seen: Date.now() - 90_000, // 90s ago — past TTL
    },
  ],
  [
    "did:human:net1:orgA:alice",
    {
      id: "did:human:net1:orgA:alice",
      type: "HUMAN",
      status: "ACTIVE",
      parent: undefined,
      trust_level: "CRITICAL",
      capabilities: ["*"],
      last_seen: Date.now(),
    },
  ],
]);

// ─── Mock context ────────────────────────────────────────────────────────────

const dlq: EscalationContext["dlq"] = [];

const ctx: EscalationContext = {
  nodes,
  dlq,
  maxRetries: 3,

  deliver: async (targetId, message) => {
    const node = nodes.get(targetId);
    if (!node || node.status !== "ACTIVE") {
      console.log(`  ✗ Delivery FAILED → ${targetId} (${node?.status ?? "unknown"})`);
      return false;
    }
    if (node.type === "HUMAN") {
      console.log(`  ✓ Delivered to HUMAN ${targetId} — would fire Slack/email webhook`);
    } else {
      console.log(`  ✓ Delivered to AGENT ${targetId}`);
    }
    return true;
  },

  alertOOB: async (payload) => {
    console.log("  🚨 OOB alert fired (SMS/PagerDuty):", JSON.stringify(payload, null, 2));
  },
};

// ─── Simulate a message that needs escalation ────────────────────────────────

const message = {
  id: crypto.randomUUID(),
  trace_id: crypto.randomUUID(),
  from: "did:agent:net1:orgA:worker",
  to: "owner",
  metadata: {
    type: "ESCALATE",
    priority: "URGENT",
    timestamp: new Date().toISOString(),
    visibility: "OWNER_ONLY",
    trust_level_claimed: "LOW",
  },
  payload: "Worker failed after 3 retries: task_id=abc123",
  retry_count: 3,
};

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log("\n=== agent-mesh POC ===\n");
console.log("Topology:");
for (const [id, node] of nodes) {
  const parentArrow = node.parent ? ` → ${node.parent}` : " (root)";
  console.log(`  ${node.type.padEnd(5)} [${node.status}] ${id}${parentArrow}`);
}

console.log(`\nRoot human: ${findRootHuman("did:agent:net1:orgA:worker", nodes)}`);

console.log("\nEscalating message from worker...");
console.log(`  Reason: retry_count=${message.retry_count}, priority=${message.metadata.priority}\n`);

await escalate("did:agent:net1:orgA:worker", message, ctx);

if (dlq.length > 0) {
  console.log("\nDead-letter queue:", dlq.length, "item(s)");
  console.log(`  Fail-safe state: ${FAIL_SAFE.DEAD_LETTER}`);
}

console.log("\nDone.");
