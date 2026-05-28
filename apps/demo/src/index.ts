/**
 * agent-mesh demo
 *
 * Topology:
 *   human:mesh:org1:robin (owner)
 *     └── agent:mesh:org1:planner
 *           └── agent:mesh:org1:executor
 *
 * Flow:
 *   1. planner sends TASK to executor
 *   2. executor fails 3 times (retry_count hits threshold)
 *   3. executor sends ESCALATE to owner (planner)
 *   4. planner escalates to human
 *   5. human handler logs the alert and ACKs
 */

import { v4 as uuid } from "uuid";
import { AgentMessage } from "@agent-mesh/envelope";
import { MeshTransport } from "@agent-mesh/transport";
import { AgentRegistry } from "@agent-mesh/registry";

const NATS = process.env.NATS_URL ?? "nats://localhost:4222";
const REDIS = process.env.REDIS_URL ?? "redis://localhost:6379";

const HUMAN_ID = "did:human:mesh:org1:robin";
const PLANNER_ID = "did:agent:mesh:org1:planner";
const EXECUTOR_ID = "did:agent:mesh:org1:executor";

const MAX_RETRIES = 3;

function msg(overrides: Partial<Parameters<typeof AgentMessage.parse>[0]> & {
  id?: string;
  from: string;
  to: string;
  type: "TASK" | "QUERY" | "RESULT" | "ESCALATE" | "PING" | "ALERT";
  priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  correlation_id?: string;
}): ReturnType<typeof AgentMessage.parse> {
  return AgentMessage.parse({
    id: overrides.id ?? uuid(),
    trace_id: overrides.correlation_id ?? uuid(),
    parent_id: null,
    from: overrides.from,
    to: overrides.to,
    routing: {
      type: overrides.to === "broadcast" ? "BROADCAST" : overrides.to === "owner" ? "OWNER" : "DIRECT",
      ttl_seconds: 60,
      requires_ack: true,
    },
    metadata: {
      type: overrides.type,
      priority: overrides.priority ?? "NORMAL",
      timestamp: new Date().toISOString(),
      visibility: "PRIVATE",
      trust_level_claimed: "MED",
    },
    payload: Buffer.from(JSON.stringify(overrides)).toString("base64"),
    ...(overrides.correlation_id ? { correlation_id: overrides.correlation_id } : {}),
  });
}

async function main() {
  console.log("🔌 Connecting to NATS and Redis...");

  const registry = AgentRegistry.fromUrl(REDIS);
  await registry.connect();

  // Register the agent topology
  await registry.register({
    id: PLANNER_ID,
    type: "AGENT",
    status: "ACTIVE",
    parent: HUMAN_ID,
    trust_level: "MED",
    capabilities: ["planning", "task-dispatch"],
    last_seen: Date.now(),
  });

  await registry.register({
    id: EXECUTOR_ID,
    type: "AGENT",
    status: "ACTIVE",
    parent: PLANNER_ID,
    trust_level: "LOW",
    capabilities: ["execution", "file-write"],
    last_seen: Date.now(),
  });

  // Connect 3 transport instances (one per agent)
  const [tPlanner, tExecutor, tHuman] = await Promise.all([
    MeshTransport.connect({ servers: NATS, agentId: PLANNER_ID }),
    MeshTransport.connect({ servers: NATS, agentId: EXECUTOR_ID }),
    MeshTransport.connect({ servers: NATS, agentId: HUMAN_ID }),
  ]);

  console.log("✅ Connected. Starting demo...\n");

  const taskId = uuid();
  let done = false;

  // ── HUMAN handler ────────────────────────────────────────────────────────
  const humanLoop = tHuman.subscribe(HUMAN_ID, async (envelope, ack) => {
    console.log(`\n👤 [HUMAN] Received ${envelope.metadata.type} from ${envelope.from}`);
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString());
    console.log(`   Payload: ${JSON.stringify(payload)}`);
    console.log(`   → Human reviewing escalation. Acknowledged.`);
    await ack();
    done = true;
  });

  // ── PLANNER handler ──────────────────────────────────────────────────────
  const plannerLoop = tPlanner.subscribe(PLANNER_ID, async (envelope, ack) => {
    console.log(`\n🗂  [PLANNER] Received ${envelope.metadata.type} from ${envelope.from}`);

    if (envelope.metadata.type === "ESCALATE") {
      console.log(`   Executor escalated (retry_count: ${envelope.retry_count}). Forwarding to human.`);
      await ack();

      const escalateToHuman = msg({
        from: PLANNER_ID,
        to: HUMAN_ID,
        type: "ESCALATE",
        priority: "HIGH",
        correlation_id: taskId,
      });
      await tPlanner.publish(escalateToHuman);
      console.log(`   📤 [PLANNER] Escalated to human ${HUMAN_ID}`);
    }
  });

  // ── EXECUTOR handler ─────────────────────────────────────────────────────
  const executorLoop = tExecutor.subscribe(EXECUTOR_ID, async (envelope, ack) => {
    console.log(`\n⚙️  [EXECUTOR] Received ${envelope.metadata.type} from ${envelope.from}`);

    if (envelope.metadata.type === "TASK") {
      const retries = envelope.retry_count ?? 0;
      console.log(`   Attempt ${retries + 1}/${MAX_RETRIES}`);

      if (retries < MAX_RETRIES - 1) {
        // Simulate failure — NAK so transport retries
        console.log(`   ❌ Execution failed. Requesting retry.`);
        await ack(); // ack receipt but re-publish with incremented retry_count

        // Re-publish with incremented retry_count
        const retry = msg({
          ...envelope,
          from: PLANNER_ID,
          to: EXECUTOR_ID,
          type: "TASK",
          correlation_id: taskId,
        });
        // Manually bump retry count by overriding after parse
        (retry as any).retry_count = retries + 1;
        await tPlanner.publish(retry);
      } else {
        // Max retries hit — escalate to owner
        console.log(`   🚨 Max retries hit. Escalating to owner.`);
        await ack();

        const escalate = msg({
          from: EXECUTOR_ID,
          to: "owner",
          type: "ESCALATE",
          priority: "HIGH",
          correlation_id: taskId,
        });

        // Resolve actual owner and send directly
        const ownerDid = await registry.resolveOwner(EXECUTOR_ID);
        console.log(`   Owner chain resolved: ${ownerDid}`);

        const escalateDirect = msg({
          from: EXECUTOR_ID,
          to: PLANNER_ID,
          type: "ESCALATE",
          priority: "HIGH",
          correlation_id: taskId,
        });
        await tExecutor.publish(escalateDirect);
        console.log(`   📤 [EXECUTOR] Sent ESCALATE to ${PLANNER_ID}`);
      }
    }
  });

  // ── Kick off: planner sends initial TASK to executor ────────────────────
  await new Promise(r => setTimeout(r, 200)); // let consumers spin up

  const task = msg({
    id: taskId,
    from: PLANNER_ID,
    to: EXECUTOR_ID,
    type: "TASK",
    correlation_id: taskId,
  });

  await tPlanner.publish(task);
  console.log(`📤 [PLANNER] Sent TASK ${taskId} to executor`);

  // Wait for escalation to complete
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (done) {
        clearInterval(check);
        resolve();
      }
    }, 100);
    setTimeout(() => { clearInterval(check); resolve(); }, 15_000);
  });

  console.log("\n✅ Demo complete. Shutting down.");
  await Promise.all([tPlanner.close(), tExecutor.close(), tHuman.close()]);
  await registry.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
