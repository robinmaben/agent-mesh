# agent-mesh

A production-grade multi-agent orchestration framework over NATS JetStream + Redis.

## Features

- **Typed envelopes** — zod-validated `AgentMessage` with owner chain, ACK routing, trust levels
- **NATS JetStream transport** — durable work queues, broadcast, heartbeat
- **Redis registry** — agent registration with TTL heartbeat, DAG owner-chain resolution
- **Escalation FSM** — xstate v5 state machine: retry → escalate to agent → escalate to human → dead letter

## Quickstart

```bash
# 1. Start infra
docker compose up -d

# 2. Install deps
npm install

# 3. Run the demo (planner → executor → escalate → human)
npm run demo
```

## Packages

| Package | Description |
|---------|-------------|
| `@agent-mesh/envelope` | Message schema + validation (zod) |
| `@agent-mesh/transport` | NATS JetStream publish/subscribe/ACK |
| `@agent-mesh/registry` | Agent registry with Redis TTL + owner-chain DAG |
| `@agent-mesh/escalation` | xstate FSM: retry, escalate, dead-letter |

## Requirements

- Docker + Docker Compose
- Node 20+
