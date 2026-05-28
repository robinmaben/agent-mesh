# agent-mesh

NATS-native agent-to-agent communication network with owner-chain traversal, information control policies, and human escalation protocols.

```
"NATS-native. Owner-chain aware. Zero silent failures."
```

## What this is

A typed, encrypted, escalation-aware messaging layer for multi-agent systems. It fills the ~30% gap left by A2A, MCP, LangGraph, and AutoGen:

| Capability | A2A | LangGraph | AutoGen | **agent-mesh** |
|---|---|---|---|---|
| NATS JetStream transport | ❌ | ❌ | ❌ | ✅ |
| Owner-chain DAG traversal | ❌ | ❌ | ❌ | ✅ |
| Escalation state machine | ❌ | partial | partial | ✅ |
| Payload encryption (E2E) | ❌ | ❌ | ❌ | ✅ |
| Need-to-know policies | ❌ | ❌ | ❌ | ✅ |
| Append-only audit log | ❌ | ❌ | ❌ | ✅ |
| Human notification bridge | ❌ | manual | manual | ✅ |

## Packages

| Package | Description |
|---|---|
| `@agent-mesh/envelope` | Zod schema for `AgentMessage` — the typed message contract |
| `@agent-mesh/transport` | NATS JetStream adapter — publish, subscribe, ACK, DLQ |
| `@agent-mesh/registry` | Redis agent registry + owner-chain DAG traversal |
| `@agent-mesh/auth` | JWT per-agent identity, signed by owner at spawn time |
| `@agent-mesh/escalation` | xstate FSM — retry → backoff → human → root → dead letter |
| `@agent-mesh/policy` | Need-to-know, PII gating, payload encryption |
| `@agent-mesh/audit` | SQLite WAL → S3/Parquet audit log |
| `@agent-mesh/notifier` | Slack/email/webhook human bridge |
| `@agent-mesh/sdk` | Public client SDK |

## Quick start

```bash
# Start local infra
docker compose up -d

# Install deps
npm install

# Build all packages
npm run build
```

## Architecture

```
Agent A ──[AgentMessage]──► NATS JetStream ──► Transport adapter
                                                    │
                                              Policy check
                                                    │
                                              Registry lookup (owner chain)
                                                    │
                                        ┌───────────▼────────────┐
                                        │   Escalation FSM        │
                                        │  PENDING → RETRYING     │
                                        │  → ESCALATED_AGENT      │
                                        │  → ESCALATED_HUMAN      │
                                        │  → DEAD_LETTER          │
                                        └───────────┬────────────┘
                                                    │
                                          ┌─────────▼──────────┐
                                          │  Human notifier     │
                                          │  Slack / email      │
                                          └────────────────────┘
```

## Message envelope

```typescript
AgentMessage {
  id: uuid
  from: "agent:{id}"
  to: "agent:{id}" | "owner" | "broadcast" | "human:{user_id}"
  type: TASK | QUERY | RESULT | ESCALATE | PING | ALERT
  priority: LOW | NORMAL | HIGH | URGENT
  payload: string  // base64 AES-256-GCM encrypted
  ttl: number      // seconds, 0 = no expiry
  requires_ack: boolean
  visibility: PRIVATE | OWNER_ONLY | NETWORK | PUBLIC
  timestamp: ISO8601
  retry_count: number
  owner_chain: string[]  // DAG path from root to sender
  correlation_id?: uuid
  severity?: INFO | WARN | ERROR | CRITICAL
}
```

## Escalation triggers

| Trigger | Target | Delay |
|---|---|---|
| `type = ESCALATE` | Direct owner agent | None |
| `retry_count >= N` | Direct human owner | Exponential backoff |
| `priority = URGENT` + ack timeout > 30s | Direct human owner | 30s |
| No local handler | Nearest capable agent (broadcast) | None |
| `type = ALERT` + `severity = CRITICAL` | All human owners | None |
| Owner TTL expired | Root human → dead-letter queue | None |

## Status

🚧 Pre-alpha — Phase 0 (envelope + transport)

## License

MIT
