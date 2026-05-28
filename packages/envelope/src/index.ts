import { z } from "zod";

export const PROTOCOL_VERSION = "1.1.0";

export const MessageType = z.enum(["TASK", "QUERY", "RESULT", "ESCALATE", "PING", "ALERT"]);
export const Priority = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
export const Visibility = z.enum(["PRIVATE", "OWNER_ONLY", "NETWORK", "PUBLIC"]);
export const TrustLevel = z.enum(["NONE", "LOW", "MED", "HIGH", "CRITICAL"]);
export const Severity = z.enum(["INFO", "WARN", "ERROR", "CRITICAL"]);

// DID-format agent/human addresses
// did:agent:{network}:{org}:{id}  or  did:human:{network}:{org}:{id}
const DID = z.string().regex(/^did:(agent|human):[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/);
const Address = z.union([DID, z.literal("owner"), z.literal("broadcast")]);

export const AgentMessage = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),

  // Identity + tracing
  id: z.string().uuid(),           // UUIDv7 in production
  trace_id: z.string(),            // spans the full request chain
  parent_id: z.string().uuid().nullable().default(null),

  from: DID,
  to: Address,

  // Routing config
  routing: z.object({
    type: z.enum(["DIRECT", "BROADCAST", "OWNER"]),
    reply_to: z.string().optional(),   // NATS inbox subject for ACK
    ttl_seconds: z.number().int().positive(),
    requires_ack: z.boolean(),
  }),

  // Message semantics
  metadata: z.object({
    type: MessageType,
    priority: Priority,
    timestamp: z.string().datetime(),
    visibility: Visibility,
    trust_level_claimed: TrustLevel,
    severity: Severity.optional(),
  }),

  // Crypto provenance (omitted in dev mode)
  security: z.object({
    encryption_mode: z.enum(["ECDH_CHACHA20_POLY1305", "PLAINTEXT"]),
    sender_public_key: z.string(),
    owner_chain_jwt: z.string().optional(), // signed delegation chain
  }).optional(),

  // Encrypted blob (or plaintext in dev mode)
  payload: z.string(),

  // Set by transport layer
  retry_count: z.number().int().nonnegative().default(0),
  owner_chain: z.array(z.string()).default([]),
});

export type AgentMessage = z.infer<typeof AgentMessage>;
export type MessageType = z.infer<typeof MessageType>;
export type Priority = z.infer<typeof Priority>;
export type TrustLevel = z.infer<typeof TrustLevel>;

// Registry node — used by escalation DAG traversal
export interface DAGNode {
  id: string;         // DID
  type: "AGENT" | "HUMAN";
  status: "ACTIVE" | "UNREACHABLE" | "QUARANTINED";
  parent?: string;    // parent DID
  trust_level: z.infer<typeof TrustLevel>;
  capabilities: string[];
  last_seen: number;  // unix ms
}

// ─── ACK envelope ────────────────────────────────────────────────────────────

export const AgentAck = z.object({
  message_id: z.string().uuid(),
  from: z.string(),
  acked_at: z.string().datetime(),
  status: z.enum(["RECEIVED", "REJECTED", "ESCALATED"]),
  reason: z.string().optional(),
});

export type AgentAck = z.infer<typeof AgentAck>;
