import Redis from "ioredis";
import type { DAGNode } from "@agent-mesh/envelope";

export type { DAGNode };

const KEY = (id: string) => `agent:${id}`;
const TTL_SECONDS = 35; // slightly above the 30s heartbeat interval

export class AgentRegistry {
  constructor(private redis: Redis) {}

  static fromUrl(url = "redis://localhost:6379"): AgentRegistry {
    return new AgentRegistry(new Redis(url, { lazyConnect: true }));
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }

  /** Register or refresh an agent record */
  async register(node: DAGNode): Promise<void> {
    await this.redis.set(
      KEY(node.id),
      JSON.stringify({ ...node, last_seen: Date.now() }),
      "EX",
      TTL_SECONDS
    );
  }

  /** Refresh TTL without changing record — call every 20s */
  async heartbeat(id: string): Promise<void> {
    const raw = await this.redis.get(KEY(id));
    if (!raw) throw new Error(`Agent ${id} not registered`);
    const node: DAGNode = JSON.parse(raw);
    await this.register({ ...node, last_seen: Date.now() });
  }

  /** Get a single agent record */
  async get(id: string): Promise<DAGNode | null> {
    const raw = await this.redis.get(KEY(id));
    return raw ? (JSON.parse(raw) as DAGNode) : null;
  }

  /** Remove an agent (deregister) */
  async deregister(id: string): Promise<void> {
    await this.redis.del(KEY(id));
  }

  /**
   * Walk owner_id links upward until we hit a human: DID.
   * Returns the human DID, or null if the chain is broken / no human found.
   */
  async resolveOwner(agentId: string): Promise<string | null> {
    let current = agentId;
    const visited = new Set<string>();

    while (true) {
      if (visited.has(current)) return null; // cycle guard
      visited.add(current);

      if (current.startsWith("did:human:")) return current;

      const node = await this.get(current);
      if (!node || !node.parent) return null;
      current = node.parent;
    }
  }

  /**
   * Walk the full owner chain from agentId to root, return ordered list.
   * e.g. [agentId, parentId, ..., humanId]
   */
  async ownerChain(agentId: string): Promise<string[]> {
    const chain: string[] = [];
    let current = agentId;
    const visited = new Set<string>();

    while (current) {
      if (visited.has(current)) break;
      visited.add(current);
      chain.push(current);

      if (current.startsWith("did:human:")) break;

      const node = await this.get(current);
      if (!node?.parent) break;
      current = node.parent;
    }

    return chain;
  }

  /**
   * Find all ACTIVE agents with a given capability.
   * Uses SCAN — safe for production, no KEYS.
   */
  async findCapable(capability: string): Promise<DAGNode[]> {
    const results: DAGNode[] = [];
    let cursor = "0";

    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", "agent:*", "COUNT", 100);
      cursor = next;

      if (keys.length > 0) {
        const values = await this.redis.mget(...keys);
        for (const raw of values) {
          if (!raw) continue;
          const node: DAGNode = JSON.parse(raw);
          if (
            node.status === "ACTIVE" &&
            node.capabilities.includes(capability)
          ) {
            results.push(node);
          }
        }
      }
    } while (cursor !== "0");

    return results;
  }
}
