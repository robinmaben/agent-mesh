import { connect, NatsConnection } from "@nats-io/transport-node";
import {
  jetstream,
  jetstreamManager,
  JetStreamClient,
  JetStreamManager,
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
} from "@nats-io/jetstream";
import { Kvm, KV } from "@nats-io/kv";
import type { AgentMessage, AgentAck } from "@agent-mesh/envelope";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ─── Subject helpers ──────────────────────────────────────────────────────────

export function subjectFor(to: string, from: string): string {
  if (to === "broadcast") return "agents.broadcast";
  if (to === "owner") return `agents.${from}.owner`;
  return `agents.${to}`;
}

// ─── Stream + KV names ────────────────────────────────────────────────────────

const STREAM_MESSAGES = "AGENT_MESSAGES";
const STREAM_AUDIT = "AGENT_AUDIT";
const KV_REGISTRY = "AGENT_REGISTRY";

// ─── MeshTransport ───────────────────────────────────────────────────────────

export interface TransportConfig {
  servers: string | string[];
  agentId: string;
}

export class MeshTransport {
  private nc!: NatsConnection;
  private js!: JetStreamClient;
  private jsm!: JetStreamManager;
  private kvm!: Kvm;
  public registry!: KV;

  static async connect(config: TransportConfig): Promise<MeshTransport> {
    const t = new MeshTransport();
    t.nc = await connect({ servers: config.servers });
    t.jsm = await jetstreamManager(t.nc);
    t.js = jetstream(t.nc);
    t.kvm = new Kvm(t.nc);
    await t._ensureStreams();
    t.registry = await t.kvm.create(KV_REGISTRY, { ttl: 30_000 });
    return t;
  }

  private async _ensureStreams() {
    // Messages stream — work queue, one consumer per message
    try {
      await this.jsm.streams.info(STREAM_MESSAGES);
    } catch {
      await this.jsm.streams.add({
        name: STREAM_MESSAGES,
        subjects: ["agents.>"],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        max_age: 24 * 60 * 60 * 1e9, // 24h in nanoseconds
        num_replicas: 1,
      });
    }

    // Audit stream — append-only
    try {
      await this.jsm.streams.info(STREAM_AUDIT);
    } catch {
      await this.jsm.streams.add({
        name: STREAM_AUDIT,
        subjects: ["audit.>"],
        storage: StorageType.File,
        num_replicas: 1,
      });
    }
  }

  /** Publish an AgentMessage onto the mesh */
  async publish(msg: AgentMessage): Promise<void> {
    const subject = subjectFor(msg.to, msg.from);
    await this.js.publish(subject, enc.encode(JSON.stringify(msg)));
    // Mirror to audit stream
    await this.js.publish(
      `audit.${msg.from}`,
      enc.encode(JSON.stringify({ ...msg, _audit: true }))
    );
  }

  /** Subscribe to messages addressed to this agent */
  async subscribe(
    agentId: string,
    handler: (msg: AgentMessage, ack: () => Promise<void>) => Promise<void>
  ): Promise<void> {
    const consumerName = `consumer-${agentId}`;
    const subject = `agents.${agentId}`;

    try {
      await this.jsm.consumers.info(STREAM_MESSAGES, consumerName);
    } catch {
      await this.jsm.consumers.add(STREAM_MESSAGES, {
        name: consumerName,
        durable_name: consumerName,
        filter_subject: subject,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_deliver: 5,
        ack_wait: 30_000_000_000, // 30s in nanoseconds
      });
    }

    const consumer = await this.js.consumers.get(STREAM_MESSAGES, consumerName);
    const messages = await consumer.consume();

    for await (const m of messages) {
      try {
        const envelope = JSON.parse(dec.decode(m.data)) as AgentMessage;
        await handler(envelope, async () => {
          m.ack();
          await this._publishAck(envelope, agentId, "RECEIVED");
        });
      } catch (err) {
        m.nak();
        console.error(`[transport] handler error for agent ${agentId}:`, err);
      }
    }
  }

  /** Subscribe to broadcast messages */
  async subscribeBroadcast(
    agentId: string,
    handler: (msg: AgentMessage) => Promise<void>
  ): Promise<void> {
    const consumerName = `broadcast-${agentId}`;

    try {
      await this.jsm.consumers.info(STREAM_MESSAGES, consumerName);
    } catch {
      await this.jsm.consumers.add(STREAM_MESSAGES, {
        name: consumerName,
        durable_name: consumerName,
        filter_subject: "agents.broadcast",
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.New,
      });
    }

    const consumer = await this.js.consumers.get(STREAM_MESSAGES, consumerName);
    const messages = await consumer.consume();

    for await (const m of messages) {
      const envelope = JSON.parse(dec.decode(m.data)) as AgentMessage;
      m.ack();
      await handler(envelope);
    }
  }

  /** Publish an ACK back to the sender */
  private async _publishAck(
    original: AgentMessage,
    ackingAgent: string,
    status: AgentAck["status"]
  ): Promise<void> {
    if (!original.routing.requires_ack) return;
    const ack: AgentAck = {
      message_id: original.id,
      from: ackingAgent,
      acked_at: new Date().toISOString(),
      status,
    };
    await this.nc.publish(
      `agents.ack.${original.from}`,
      enc.encode(JSON.stringify(ack))
    );
  }

  /** Register this agent in the KV heartbeat registry */
  async heartbeat(
    agentId: string,
    meta: Record<string, unknown> = {}
  ): Promise<void> {
    await this.registry.put(
      agentId,
      enc.encode(JSON.stringify({ agentId, ...meta, ts: Date.now() }))
    );
  }

  /** Drain and close */
  async close(): Promise<void> {
    await this.nc.drain();
  }
}
