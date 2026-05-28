import { z } from "zod";

// ─── Enum schemas ────────────────────────────────────────────────────────────

export const MessageType = z.enum([
  "TASK",
  "QUERY",
  "RESULT",
  "ESCALATE",
  "PING",
  "ALERT",
]);

export const Priority = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);

export const Visibility = z.enum([
  "PRIVATE",
  "OWNER_ONLY",
  "NETWORK",
  "PUBLIC",
]);

export const Severity = z.enum(["INFO", "WARN", "ERROR", "CRITICAL"]);

// ─── Address schemas ─────────────────────────────────────────────────────────

/** agent_id, "owner", "broadcast", or "human:{user_id}" */
export const Address = z.union([
  z.string().regex(/^agent:[a-zA-Z0-9_-]+$/, "must be agent:{id}"),
  z.literal("owner"),
  z.literal("broadcast"),
  z.string().regex(/^human:[a-zA-Z0-9_@.-]+$/, "must be human:{user_id}"),
]);

// ─── Core envelope ───────────────────────────────────────────────────────────

export const AgentMessage = z.object({
  /** Unique message ID (UUIDv4) */
  id: z.string().uuid(),

  /** Sender agent ID */
  from: z.string().regex(/^agent:[a-zA-Z0-9_-]+$/),

  /** Target address: agent_id | "owner" | "broadcast" | "human:{user_id}" */
  to: Address,

  /** Message type */
  type: MessageType,

  /** Delivery priority */
  priority: Priority,

  /**
   * Encrypted payload — base64-encoded AES-256-GCM ciphertext.
   * For NETWORK/PUBLIC visibility, encrypted with stream-level shared key.
   * For PRIVATE/OWNER_ONLY, encrypted with recipient's public key via ECDH.
   */
  payload: z.string().base64(),

  /** Message TTL in seconds. 0 = no expiry. */
  ttl: z.number().int().nonnegative(),

  /** Whether the sender expects an explicit ACK from the recipient */
  requires_ack: z.boolean(),

  /** Who can see this message */
  visibility: Visibility,

  /** ISO8601 send timestamp */
  timestamp: z.string().datetime(),

  // ─── Extension fields ───────────────────────────────────────────────────

  /** How many times delivery has been attempted */
  retry_count: z.number().int().nonnegative().default(0),

  /**
   * Resolved ownership chain at send time — [root_agent, ..., direct_owner]
   * Populated by the transport layer via registry DAG traversal.
   */
  owner_chain: z.array(z.string()).default([]),

  /** Links a RESULT or ESCALATE back to its originating TASK/QUERY */
  correlation_id: z.string().uuid().optional(),

  /** For ALERT messages — severity level */
  severity: Severity.optional(),

  /** Arbitrary metadata (not encrypted, visible to transport layer) */
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type AgentMessage = z.infer<typeof AgentMessage>;
export type MessageType = z.infer<typeof MessageType>;
export type Priority = z.infer<typeof Priority>;
export type Visibility = z.infer<typeof Visibility>;
export type Severity = z.infer<typeof Severity>;
export type Address = z.infer<typeof Address>;

// ─── ACK envelope ────────────────────────────────────────────────────────────

export const AgentAck = z.object({
  message_id: z.string().uuid(),
  from: z.string(),
  acked_at: z.string().datetime(),
  status: z.enum(["RECEIVED", "REJECTED", "ESCALATED"]),
  reason: z.string().optional(),
});

export type AgentAck = z.infer<typeof AgentAck>;
