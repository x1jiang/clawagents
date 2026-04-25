/**
 * Mid-run steering and next-turn queueing.
 *
 * Two primitives that let an operator nudge a running agent without
 * interrupting it:
 *
 * - {@link SteerQueue} — messages to inject **into the very next LLM
 *   call** (e.g. `/steer please switch to Python`). Drained on the next
 *   `onLLMStart` hook firing, so the model sees the nudge before its
 *   next decision.
 * - {@link NextTurnQueue} — messages to surface **after the current run
 *   finishes** (e.g. `/queue summarise findings`). The library never
 *   reads this on its own — your CLI / gateway is expected to pop from
 *   it when picking the next user message.
 *
 * Both queues live on {@link RunContext}. They are populated by the
 * consumer (typically a slash-command dispatcher; see
 * `clawagents/commands.ts`) and drained by the agent loop via
 * {@link SteerHook} (a {@link RunHooks} adapter).
 *
 * Mirrors `clawagents_py/src/clawagents/steer.py`.
 *
 * @example
 * ```ts
 * import { RunContext, SteerHook, steer, runAgentGraph } from "clawagents";
 *
 * const rc = new RunContext();
 *
 * // ... operator types `/steer please be brief` somewhere ...
 * steer(rc, "please be brief");
 *
 * // Hook into the run so onLLMStart drains the queue before each LLM call.
 * await runAgentGraph({
 *     ...,
 *     runContext: rc,
 *     runHooks: new SteerHook(),
 * });
 * ```
 */

import type { LLMMessage } from "./providers/llm.js";
import { RunHooks, type LLMStartPayload } from "./lifecycle.js";
import { RunContext } from "./run-context.js";

/** A single pending nudge. */
export interface SteerMessage {
    /** Message text to inject. */
    text: string;
    /** Conversation role to use when injecting. Defaults to `"user"`. */
    role: string;
}

/**
 * Tiny FIFO queue. Single-threaded JS doesn't need a lock, but the
 * push/drain split makes intent obvious and matches the Python sibling.
 */
class _Queue {
    private items: SteerMessage[] = [];

    push(msg: string | SteerMessage, opts: { role?: string } = {}): void {
        if (typeof msg === "string") {
            this.items.push({ text: msg, role: opts.role ?? "user" });
        } else {
            this.items.push({ ...msg });
        }
    }

    extend(items: Iterable<string | SteerMessage>, opts: { role?: string } = {}): void {
        for (const it of items) this.push(it, opts);
    }

    /** Return and remove all pending messages atomically. */
    drain(): SteerMessage[] {
        const out = this.items;
        this.items = [];
        return out;
    }

    /** Return a copy of pending messages without consuming them. */
    peek(): SteerMessage[] {
        return this.items.slice();
    }

    get length(): number {
        return this.items.length;
    }
}

/** Mid-run nudges injected into the next LLM call. */
export class SteerQueue extends _Queue {}

/**
 * Messages saved for **after** the current run.
 *
 * The agent loop ignores this queue; consumers should drain it
 * themselves when picking the next user message.
 */
export class NextTurnQueue extends _Queue {}

// ── RunContext attachment helpers ──────────────────────────────────────

const STEER_KEY = "__claw_steer_queue__";
const NEXT_TURN_KEY = "__claw_next_turn_queue__";

function _getSteerQueue(rc: RunContext): SteerQueue {
    let q = rc._metadata[STEER_KEY] as SteerQueue | undefined;
    if (!(q instanceof SteerQueue)) {
        q = new SteerQueue();
        rc._metadata[STEER_KEY] = q;
    }
    return q;
}

function _getNextTurnQueue(rc: RunContext): NextTurnQueue {
    let q = rc._metadata[NEXT_TURN_KEY] as NextTurnQueue | undefined;
    if (!(q instanceof NextTurnQueue)) {
        q = new NextTurnQueue();
        rc._metadata[NEXT_TURN_KEY] = q;
    }
    return q;
}

/**
 * Push a mid-run nudge onto `rc`'s {@link SteerQueue}. The message is
 * injected into the conversation just before the next LLM call when
 * {@link SteerHook} is installed.
 */
export function steer(
    rc: RunContext,
    message: string,
    opts: { role?: string } = {},
): void {
    _getSteerQueue(rc).push(message, opts);
}

/**
 * Push a message onto the next-turn queue. Saved for the operator to
 * consume between runs; the agent loop never reads it on its own.
 */
export function queueMessage(
    rc: RunContext,
    message: string,
    opts: { role?: string } = {},
): void {
    _getNextTurnQueue(rc).push(message, opts);
}

/** Drain pending steer messages. */
export function drainSteer(rc: RunContext): SteerMessage[] {
    return _getSteerQueue(rc).drain();
}

/** Drain pending next-turn messages. */
export function drainNextTurn(rc: RunContext): SteerMessage[] {
    return _getNextTurnQueue(rc).drain();
}

/** Peek pending steer messages without consuming them. */
export function peekSteer(rc: RunContext): SteerMessage[] {
    return _getSteerQueue(rc).peek();
}

/** Peek pending next-turn messages without consuming them. */
export function peekNextTurn(rc: RunContext): SteerMessage[] {
    return _getNextTurnQueue(rc).peek();
}

// ── RunHooks adapter ───────────────────────────────────────────────────

/**
 * {@link RunHooks} subclass that drains `rc` 's steer queue on every
 * LLM call.
 *
 * Drains pending {@link SteerMessage}s on `onLLMStart` and appends each
 * as a fresh entry on the live `messages` array. The agent loop does
 * not copy this array before invoking the provider, so in-place
 * mutation here is observed by the next call.
 *
 * @example
 * ```ts
 * const hook = new SteerHook({ prefix: "[op]" });
 * await runAgentGraph({ ..., runHooks: hook });
 * ```
 */
export class SteerHook<TContext = unknown> extends RunHooks<TContext> {
    private prefix: string | null;

    constructor(opts: { prefix?: string | null } = {}) {
        super();
        this.prefix = opts.prefix === undefined ? "[steer]" : opts.prefix;
    }

    override async onLLMStart(payload: LLMStartPayload<TContext>): Promise<void> {
        const messages = payload.messages;
        if (!Array.isArray(messages)) return;
        const pending = drainSteer(payload.runContext as RunContext);
        if (pending.length === 0) return;
        const allowed: LLMMessage["role"][] = ["system", "user", "assistant", "tool"];
        for (const nudge of pending) {
            const text = this.prefix ? `${this.prefix} ${nudge.text}` : nudge.text;
            const role = (allowed as string[]).includes(nudge.role)
                ? (nudge.role as LLMMessage["role"])
                : ("user" as LLMMessage["role"]);
            messages.push({ role, content: text });
        }
    }
}
