# agent-mesh — Implementation Plan
_Last updated: 2026-05-28_

## What it is
NATS-native agent-to-agent communication network with owner-chain traversal, information control policies, and escalation-to-human protocols. Fills the ~30% gap left by A2A, MCP, LangGraph, and AutoGen.

---

## What to fork vs build

| Component | Source | Action |
|---|---|---|
| Agent Card schema | `a2aproject/a2a-js` @0.3.13 | Adapt/extend for interop |
| Envelope schema | Informed by OpenAgentIO (Go) | Build from scratch |
| NATS JetStream transport | `@nats-io/*` v3 scoped packages | Integrate directly |
| Agent execution runtime | `@mastra/core` v1.37.1 | Integrate (verify ee/ license) |
| Escalation FSM | `xstate` v5 | Build state machine on top of |
| Owner-chain DAG registry | Redis + ioredis | Build from scratch |
| Info policy engine | — | Build from scratch |
| JWT agent auth | `jose` v6.2.3 | Build on top of |
| Payload encryption | `@noble/ciphers` v2, `@noble/curves` v2 | Build on top of |
| Audit log | `better-sqlite3` + `@dsnp/parquetjs` | Build on top of |
| Human notifier | `@slack/webhook` + `nodemailer` | Build on top of |

**Key find:** `jbellsolutions/hermes-super-agent` combines A2A + NATS + Temporal — closest existing project. Read for design decisions.

---

## Monorepo structure

```
agent-mesh/
├── packages/
│   ├── envelope/          # Zod schema for AgentMessage
│   ├── transport/         # NATS JetStream adapter
│   ├── registry/          # Redis agent registry + DAG traversal
│   ├── auth/              # JWT per-agent identity
│   ├── escalation/        # xstate FSM — the core novel component
│   ├── policy/            # Need-to-know, PII gating, encryption
│   ├── audit/             # SQLite WAL → S3/Parquet
│   ├── notifier/          # Slack/email human bridge
│   └── sdk/               # Public-facing client SDK
├── apps/
│   ├── web/               # Landing page (Next.js)
│   └── demo/              # Demo agent network (3 agents + 1 human escalation)
├── docs/
└── docker-compose.yml     # NATS + Redis for local dev
```

---

## Phase plan

### Phase 0 — Foundations (Week 1–2)
**`packages/envelope`**
- Define `AgentMessage` Zod schema with all fields
- Types: TASK | QUERY | RESULT | ESCALATE | PING | ALERT
- Add `retry_count`, `owner_chain[]`, `correlation_id`, `severity` extension fields
- Export TypeScript types from schema

**`packages/transport`**
- NATS JetStream adapter
- Subject naming: `agents.{from}.{to}`, `agents.broadcast`, `agents.human.{user_id}`
- Streams: `AGENT_MESSAGES` (WorkQueuePolicy), `AGENT_AUDIT` (append-only)
- KV bucket: `AGENT_REGISTRY` for heartbeat presence
- Use `@nats-io/jetstream` + `@nats-io/kv` (NOT legacy `nats` monolith)

**Verification:** unit tests for schema validation, NATS publish/subscribe round-trip

### Phase 1 — Registry + Auth (Week 3)
**`packages/registry`**
- `AgentRecord`: `{ agent_id, owner_id, capabilities[], public_key, spawn_time, last_seen }`
- Redis TTL-based heartbeat (30s TTL, refreshed every 20s)
- `resolveOwner(agent_id)`: walk `owner_id` links upward until `human:` prefix found
- `findCapable(capability)`: scan registry for agents matching capability

**`packages/auth`**
- JWT: `{ sub: agent_id, iss: owner_id, capabilities[], iat, exp }`
- Sign with owner's Ed25519 key (via `jose`) at spawn time
- Verify: registry lookup of owner's public key → validate JWT

**Verification:** spawn agent, verify JWT, revoke (TTL expiry), verify rejection

### Phase 2 — Escalation Engine (Week 4–5)
**`packages/escalation`** — The core novel component

Six triggers modelled as xstate states:
1. `ESCALATE` type → owner agent (default path, no delay)
2. `retry_count >= N` → direct human owner (exponential backoff)
3. `URGENT + ack_timeout > 30s` → direct human owner
4. No local handler → network broadcast → nearest capable agent
5. `ALERT + severity=CRITICAL` → all human owners in network
6. Owner TTL expired → root human → dead-letter queue

`walkToRootHuman(agent_id)`: traverse `owner_chain` DAG until `human:` prefix or no parent

**Verification:** e2e test — agent fails N times → escalation fires → human notified

### Phase 3 — Information Control (Week 6)
**`packages/policy`**
- **Need-to-know**: check `visibility` + sender/receiver capability intersection before delivery
- **Owner transparency**: direct owner bypasses need-to-know for child agent messages
- **PII gating**: regex/NLP scan on payload metadata; block if receiver not in `pii_allowed_agents[]`
- **Payload encryption**: ECDH key agreement (sender + recipient public keys) → AES-256-GCM
  - `PRIVATE/OWNER_ONLY`: per-pair key from registry
  - `NETWORK/PUBLIC`: stream-level shared key

### Phase 4 — Human Notification (Week 7)
**`packages/notifier`**
- NATS JetStream delivery queue (retry-safe, dedup via Redis `SETNX` on `notification:{msg_id}`)
- Slack: Block Kit message — agent chain, severity, message ID, Approve/Deny action buttons
- Email: `nodemailer` HTML template as fallback
- Webhook: generic POST to configured URL

### Phase 5 — Audit Log (Week 8)
**`packages/audit`**
- Every message appended to SQLite WAL synchronously via dedicated worker thread
- Schema: `id, from, to, type, priority, visibility, timestamp, owner_chain, ack_received, escalation_path`
- Batch compaction every hour → Parquet file → S3 upload
- WAL mode: zero lock contention with concurrent reads

---

## Landing page (`apps/web`)

**Stack:** Next.js 15 + Tailwind v4 + `shadcn/ui` minimal (no component library feel)

**Design direction:** Tailscale / Temporal / NATS.io aesthetic — dark, technical, credible

**Palette:**
- Background: `#0a0b0e` | Surface: `#111318` | Border: `#1e2028`
- Primary: `#4ade80` (green — terminal output) | Alert: `#f87171` (escalation)
- Text: `#e2e8f0` | Muted: `#64748b`

**Typography:** Inter (body) + JetBrains Mono (code)

**Sections (in order):**
1. Hero — single-sentence value prop + SVG agent → owner chain → human diagram. `npm install` CTA.
2. Problem strip — 3 cols: "Agents fail silently. Humans find out too late. No audit trail."
3. Architecture diagram — SVG technical flow (NATS → envelope → registry → escalation → Slack)
4. Envelope schema — syntax-highlighted `AgentMessage` type block (THIS is the hook for devs)
5. Escalation flow — interactive state machine diagram (hover = trigger explanation)
6. Quickstart — 3-step terminal walkthrough with typed animation
7. Comparison table — vs A2A / LangGraph / AutoGen. Honest. Checkmarks for: NATS, owner-chain, encryption, escalation, audit
8. Footer — GitHub, spec, Discord. No pricing page.

**Tone:** technical peer, not vendor. Specific. Shows the schema. No "seamless", "powerful", "revolutionary".
Tagline: `"NATS-native. Owner-chain aware. Zero silent failures."`

---

## Open design decisions (answer before Phase 2)

1. **Sync vs async?** Fire-and-forget for TASK/PING; request-reply with ACK for QUERY/RESULT/ESCALATE
2. **Trust transitivity?** Proposed: owner's trust level caps child's. Child cannot exceed parent trust.
3. **Cross-network comms?** Start isolated; federated via A2A Agent Cards as Phase 6
4. **Rate limiting?** Per-agent message budget (configurable) + URGENT flood protection (circuit breaker after 3 URGENT in 60s)

---

## Key gotchas

- Use `@nats-io/*` scoped packages (v3), NOT legacy `nats` monolith
- A2A spec is v0.3, still evolving — use for Agent Cards only, not transport
- Mastra HITL may be in `ee/` (enterprise-licensed) dirs — verify before depending on it
- Public key distribution needs a round-trip to registry before first encrypted message — cache at spawn time for known recipients
- SQLite WAL: batch writes if >10k msgs/sec; use dedicated worker thread

---

## Repo
https://github.com/robinmaben/agent-mesh
