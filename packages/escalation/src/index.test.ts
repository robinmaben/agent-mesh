import { describe, it, expect, vi } from "vitest";
import { createActor } from "xstate";
import { createEscalationMachine } from "./index.js";
import type { AgentRegistry } from "@agent-mesh/registry";
import type { AgentMessage } from "@agent-mesh/envelope";

// Minimal stub message
const baseMsg: AgentMessage = {
  protocol_version: "1.1.0",
  id: "550e8400-e29b-41d4-a716-446655440000",
  trace_id: "trace-001",
  parent_id: null,
  from: "did:agent:mesh:org1:executor",
  to: "did:agent:mesh:org1:planner",
  routing: { type: "DIRECT", ttl_seconds: 60, requires_ack: true },
  metadata: {
    type: "TASK",
    priority: "NORMAL",
    timestamp: new Date().toISOString(),
    visibility: "PRIVATE",
    trust_level_claimed: "MED",
  },
  payload: "dGVzdA==",
  retry_count: 0,
  owner_chain: [],
};

const mockRegistry = {
  resolveOwner: vi.fn().mockResolvedValue("did:human:mesh:org1:robin"),
  ownerChain: vi.fn().mockResolvedValue([
    "did:agent:mesh:org1:executor",
    "did:agent:mesh:org1:planner",
    "did:human:mesh:org1:robin",
  ]),
} as unknown as AgentRegistry;

function makeHandlers() {
  return {
    onRetry: vi.fn().mockResolvedValue(undefined),
    onEscalateToAgent: vi.fn().mockResolvedValue(undefined),
    onEscalateToHuman: vi.fn().mockResolvedValue(undefined),
    onEscalateToAllHumans: vi.fn().mockResolvedValue(undefined),
    onDeadLetter: vi.fn().mockResolvedValue(undefined),
  };
}

function waitForFinal(actor: ReturnType<typeof createActor>): Promise<void> {
  return new Promise((resolve) => {
    actor.subscribe((state) => {
      if (state.status === "done") resolve();
    });
  });
}

describe("EscalationMachine", () => {
  it("resolves owner on entry", async () => {
    const handlers = makeHandlers();
    const machine = createEscalationMachine(
      { message: baseMsg, agentId: "did:agent:mesh:org1:executor", maxRetries: 3 },
      mockRegistry,
      handlers
    );
    const actor = createActor(machine).start();
    // After resolving owner, lands in pending
    await new Promise(r => setTimeout(r, 50));
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("pending");
    expect(snap.context.ownerDid).toBe("did:human:mesh:org1:robin");
    actor.stop();
  });

  it("escalates to human when ACK timeout fires", async () => {
    const handlers = makeHandlers();
    const machine = createEscalationMachine(
      { message: baseMsg, agentId: "did:agent:mesh:org1:executor", maxRetries: 3 },
      mockRegistry,
      handlers
    );
    const actor = createActor(machine).start();
    await new Promise(r => setTimeout(r, 50)); // wait for resolving_owner
    actor.send({ type: "TIMEOUT" });
    await waitForFinal(actor);
    expect(handlers.onEscalateToHuman).toHaveBeenCalledWith(
      expect.objectContaining({ ownerDid: "did:human:mesh:org1:robin" }),
      "did:human:mesh:org1:robin"
    );
  });

  it("transitions to done on ACK_RECEIVED", async () => {
    const handlers = makeHandlers();
    const machine = createEscalationMachine(
      { message: baseMsg, agentId: "did:agent:mesh:org1:executor", maxRetries: 3 },
      mockRegistry,
      handlers
    );
    const actor = createActor(machine).start();
    await new Promise(r => setTimeout(r, 50));
    actor.send({ type: "ACK_RECEIVED" });
    await new Promise(r => setTimeout(r, 20));
    expect(actor.getSnapshot().value).toBe("done");
    actor.stop();
  });

  it("escalates all humans on CRITICAL_ALERT", async () => {
    const handlers = makeHandlers();
    const machine = createEscalationMachine(
      { message: baseMsg, agentId: "did:agent:mesh:org1:executor", maxRetries: 3 },
      mockRegistry,
      handlers
    );
    const actor = createActor(machine).start();
    await new Promise(r => setTimeout(r, 50));
    actor.send({ type: "CRITICAL_ALERT" });
    await waitForFinal(actor);
    expect(handlers.onEscalateToAllHumans).toHaveBeenCalled();
  });
});
