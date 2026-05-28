import { createMachine, assign, fromPromise } from "xstate";
import type { AgentMessage } from "@agent-mesh/envelope";
import type { AgentRegistry } from "@agent-mesh/registry";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EscalationContext {
  message: AgentMessage;
  agentId: string;
  retryCount: number;
  maxRetries: number;
  ownerDid: string | null;
  rootHumanDid: string | null;
  error: string | null;
}

export type EscalationEvent =
  | { type: "RETRY" }
  | { type: "FAIL"; error: string }
  | { type: "ESCALATE_EXPLICIT" }         // message type = ESCALATE
  | { type: "TIMEOUT" }                    // ack_timeout exceeded
  | { type: "OWNER_DEAD" }                 // owner TTL expired
  | { type: "CRITICAL_ALERT" }             // severity=CRITICAL
  | { type: "ACK_RECEIVED" }
  | { type: "OWNER_RESOLVED"; ownerDid: string; rootHumanDid: string };

export type EscalationState =
  | "idle"
  | "resolving_owner"
  | "pending"
  | "retrying"
  | "escalated_agent"
  | "escalated_human"
  | "escalated_all_humans"
  | "dead_letter"
  | "done";

// ─── Callbacks the machine calls out to ──────────────────────────────────────

export interface EscalationHandlers {
  onRetry: (ctx: EscalationContext) => Promise<void>;
  onEscalateToAgent: (ctx: EscalationContext, targetDid: string) => Promise<void>;
  onEscalateToHuman: (ctx: EscalationContext, humanDid: string) => Promise<void>;
  onEscalateToAllHumans: (ctx: EscalationContext) => Promise<void>;
  onDeadLetter: (ctx: EscalationContext) => Promise<void>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createEscalationMachine(
  initial: Pick<EscalationContext, "message" | "agentId" | "maxRetries">,
  registry: AgentRegistry,
  handlers: EscalationHandlers
) {
  return createMachine(
    {
      id: "escalation",
      types: {} as {
        context: EscalationContext;
        events: EscalationEvent;
      },

      context: {
        ...initial,
        retryCount: initial.message.retry_count ?? 0,
        ownerDid: null,
        rootHumanDid: null,
        error: null,
      },

      initial: "resolving_owner",

      states: {
        // ── Resolve owner chain before doing anything ──────────────────────
        resolving_owner: {
          invoke: {
            src: fromPromise(async ({ input }: { input: EscalationContext }) => {
              const ownerDid = await registry.resolveOwner(input.agentId);
              const chain = await registry.ownerChain(input.agentId);
              const rootHumanDid = chain.find(id => id.startsWith("did:human:")) ?? null;
              return { ownerDid, rootHumanDid };
            }),
            input: ({ context }) => context,
            onDone: {
              target: "pending",
              actions: assign({
                ownerDid: ({ event }) => (event as any).output.ownerDid,
                rootHumanDid: ({ event }) => (event as any).output.rootHumanDid,
              }),
            },
            onError: {
              target: "dead_letter",
              actions: assign({ error: ({ event }) => String((event as any).error) }),
            },
          },
        },

        // ── Waiting for outcome ────────────────────────────────────────────
        pending: {
          on: {
            ACK_RECEIVED: "done",
            FAIL: {
              actions: assign({
                retryCount: ({ context }) => context.retryCount + 1,
                error: ({ event }) => (event as EscalationEvent & { type: "FAIL" }).error,
              }),
              target: "retrying",
            },
            ESCALATE_EXPLICIT: "escalated_agent",
            TIMEOUT: "escalated_human",
            OWNER_DEAD: "escalated_human",
            CRITICAL_ALERT: "escalated_all_humans",
          },
        },

        // ── Retry with backoff ─────────────────────────────────────────────
        retrying: {
          always: [
            { guard: "maxRetriesExceeded", target: "escalated_human" },
          ],
          invoke: {
            src: fromPromise(async ({ input }: { input: EscalationContext }) => {
              const delay = Math.min(1000 * 2 ** input.retryCount, 30_000);
              await new Promise(r => setTimeout(r, delay));
              await handlers.onRetry(input);
            }),
            input: ({ context }) => context,
            onDone: "pending",
            onError: {
              target: "dead_letter",
              actions: assign({ error: ({ event }) => String((event as any).error) }),
            },
          },
        },

        // ── Escalate to direct owner agent ────────────────────────────────
        escalated_agent: {
          invoke: {
            src: fromPromise(async ({ input }: { input: EscalationContext }) => {
              const target = input.ownerDid;
              if (!target) throw new Error("No owner to escalate to");
              await handlers.onEscalateToAgent(input, target);
            }),
            input: ({ context }) => context,
            onDone: "done",
            onError: "escalated_human", // if owner agent unreachable, go to human
          },
        },

        // ── Escalate to human owner ───────────────────────────────────────
        escalated_human: {
          invoke: {
            src: fromPromise(async ({ input }: { input: EscalationContext }) => {
              const human = input.rootHumanDid;
              if (!human) throw new Error("No human in owner chain");
              await handlers.onEscalateToHuman(input, human);
            }),
            input: ({ context }) => context,
            onDone: "done",
            onError: "dead_letter",
          },
        },

        // ── Broadcast to ALL humans (CRITICAL severity) ───────────────────
        escalated_all_humans: {
          invoke: {
            src: fromPromise(async ({ input }: { input: EscalationContext }) => {
              await handlers.onEscalateToAllHumans(input);
            }),
            input: ({ context }) => context,
            onDone: "done",
            onError: "dead_letter",
          },
        },

        // ── Dead letter — nothing worked ──────────────────────────────────
        dead_letter: {
          invoke: {
            src: fromPromise(async ({ input }: { input: EscalationContext }) => {
              await handlers.onDeadLetter(input);
            }),
            input: ({ context }) => context,
            onDone: "done",
          },
        },

        done: { type: "final" },
      },
    },
    {
      guards: {
        maxRetriesExceeded: ({ context }) => context.retryCount >= context.maxRetries,
      },
    }
  );
}
