import { describe, it, expect } from "vitest";
import { AgentMessage, AgentAck } from "@agent-mesh/envelope";

describe("AgentMessage schema", () => {
  it("parses a valid message", () => {
    const raw = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      trace_id: "trace-001",
      parent_id: null,
      from: "did:agent:mesh:org1:planner",
      to: "did:agent:mesh:org1:executor",
      routing: {
        type: "DIRECT",
        ttl_seconds: 60,
        requires_ack: true,
      },
      metadata: {
        type: "TASK",
        priority: "NORMAL",
        timestamp: new Date().toISOString(),
        visibility: "PRIVATE",
        trust_level_claimed: "MED",
      },
      payload: "aGVsbG8=",
    };

    const result = AgentMessage.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.protocol_version).toBe("1.1.0");
      expect(result.data.retry_count).toBe(0);
      expect(result.data.owner_chain).toEqual([]);
    }
  });

  it("rejects invalid from address", () => {
    const result = AgentMessage.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      trace_id: "t",
      parent_id: null,
      from: "not-a-did",
      to: "broadcast",
      routing: { type: "BROADCAST", ttl_seconds: 30, requires_ack: false },
      metadata: {
        type: "PING",
        priority: "LOW",
        timestamp: new Date().toISOString(),
        visibility: "NETWORK",
        trust_level_claimed: "NONE",
      },
      payload: "x",
    });
    expect(result.success).toBe(false);
  });

  it("parses AgentAck", () => {
    const ack = AgentAck.safeParse({
      message_id: "550e8400-e29b-41d4-a716-446655440000",
      from: "did:agent:mesh:org1:executor",
      acked_at: new Date().toISOString(),
      status: "RECEIVED",
    });
    expect(ack.success).toBe(true);
  });
});
