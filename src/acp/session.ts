/**
 * Bridge between a ClawAgents agent loop and ACP session updates.
 *
 * Mirrors `clawagents.acp.session` on the Python side: accepts events
 * emitted by the agent loop (`message_text`, `reasoning`,
 * `tool.started`, `tool.completed`, `run_finished`) and translates them
 * into wire-form ACP `session/update` payloads.
 */

import * as crypto from "node:crypto";
import {
    StopReason,
    StopReasonValues,
    PermissionDecision,
    PermissionRequest,
    SessionUpdate,
    agentMessageChunk,
    agentThoughtChunk,
    encodeUpdate,
    toolCallStart,
} from "./messages.js";

// A sink may be sync or async. Sync is used in tests; async in real
// servers (`await conn.session_update(...)`).
export type SessionEventSink = (
    raw: Record<string, unknown>
) => void | Promise<void>;

export type PermissionRequester = (
    req: PermissionRequest
) => Promise<PermissionDecision>;

export interface AgentSessionOptions {
    sessionId: string;
    sink?: SessionEventSink;
    permissionRequester?: PermissionRequester;
}

/** Wraps an ACP session and translates agent events into updates. */
export class AgentSession {
    readonly sessionId: string;
    private sink?: SessionEventSink;
    private permissionRequester?: PermissionRequester;
    private toolIdsByName: Map<string, string[]> = new Map();
    private toolArgsById: Map<string, Record<string, unknown>> = new Map();
    private _emitted: Record<string, unknown>[] = [];
    private _stopReason: StopReason | null = null;

    constructor(opts: AgentSessionOptions) {
        this.sessionId = opts.sessionId;
        this.sink = opts.sink;
        this.permissionRequester = opts.permissionRequester;
    }

    get emitted(): Record<string, unknown>[] {
        return [...this._emitted];
    }

    get stopReason(): StopReason | null {
        return this._stopReason;
    }

    resetEmitted(): void {
        this._emitted = [];
    }

    /** Translate one agent-loop event into zero or more ACP updates. */
    dispatch(
        kind: string,
        payload: Record<string, unknown> = {}
    ): Record<string, unknown>[] {
        const updates = this.translate(kind, payload);
        const wire: Record<string, unknown>[] = [];
        for (const u of updates) {
            const raw = encodeUpdate(u);
            this._emitted.push(raw);
            wire.push(raw);
            this.emitSync(raw);
        }
        return wire;
    }

    /** Async variant for use with async sinks. */
    async adispatch(
        kind: string,
        payload: Record<string, unknown> = {}
    ): Promise<Record<string, unknown>[]> {
        const updates = this.translate(kind, payload);
        const wire: Record<string, unknown>[] = [];
        for (const u of updates) {
            const raw = encodeUpdate(u);
            this._emitted.push(raw);
            wire.push(raw);
            await this.emitAsync(raw);
        }
        return wire;
    }

    /** Ask the IDE whether a particular tool call may proceed. */
    async requestPermission(
        name: string,
        args: Record<string, unknown> = {},
        description?: string
    ): Promise<PermissionDecision> {
        if (!this.permissionRequester) {
            return {
                allowed: true,
                rationale: "no requester configured",
                oneTime: true,
            };
        }
        const req: PermissionRequest = {
            toolCallId: makeToolCallId(),
            name,
            arguments: { ...args },
            description,
        };
        return await this.permissionRequester(req);
    }

    // ── internal ──────────────────────────────────────────────────

    private translate(
        kind: string,
        payload: Record<string, unknown>
    ): SessionUpdate[] {
        const k = kind.replace(/\./g, "_");
        const out: SessionUpdate[] = [];

        if (k === "llm_delta" || k === "message_delta" || k === "message_text") {
            const text = coerceText(payload.text ?? payload.delta);
            if (text) out.push(agentMessageChunk(text));
            return out;
        }
        if (
            k === "reasoning" ||
            k === "reasoning_delta" ||
            k === "thought" ||
            k === "thinking"
        ) {
            const text = coerceText(payload.text ?? payload.delta);
            if (text) out.push(agentThoughtChunk(text));
            return out;
        }
        if (k === "tool_started" || k === "tool_start") {
            const name = String(payload.name ?? payload.tool ?? "tool");
            const args = coerceArgs(payload.arguments ?? payload.args);
            const tc = toolCallStart(name, args);
            const queue = this.toolIdsByName.get(name) ?? [];
            queue.push(tc.toolCallId);
            this.toolIdsByName.set(name, queue);
            this.toolArgsById.set(tc.toolCallId, args);
            out.push(tc);
            return out;
        }
        if (
            k === "tool_completed" ||
            k === "tool_complete" ||
            k === "tool_finished" ||
            k === "tool_end"
        ) {
            const name = String(payload.name ?? payload.tool ?? "tool");
            const queue = this.toolIdsByName.get(name);
            const tcId = queue && queue.length > 0 ? queue.shift()! : makeToolCallId();
            const args = this.toolArgsById.get(tcId);
            this.toolArgsById.delete(tcId);
            const errorVal = payload.error;
            const output = payload.output ?? payload.result;
            out.push({
                kind: "tool_call_complete",
                toolCallId: tcId,
                name,
                output: errorVal ? undefined : output,
                error: errorVal ? String(errorVal) : undefined,
                arguments: args,
            });
            return out;
        }
        if (k === "run_finished" || k === "agent_finished" || k === "stop") {
            this._stopReason = coerceStop(payload.reason);
            return out;
        }
        if (k === "run_error" || k === "agent_error" || k === "error") {
            this._stopReason = StopReasonValues.ERROR;
            return out;
        }
        return out;
    }

    private emitSync(raw: Record<string, unknown>): void {
        if (!this.sink) return;
        const result = this.sink(raw);
        if (result && typeof (result as Promise<unknown>).then === "function") {
            // Caller passed an async sink to a sync dispatch — tell them.
            // Fire-and-forget is bug-prone; require explicit choice.
            (result as Promise<unknown>).catch(() => undefined);
            throw new TypeError(
                "AgentSession.dispatch() received an async sink. " +
                    "Use AgentSession.adispatch() instead."
            );
        }
    }

    private async emitAsync(raw: Record<string, unknown>): Promise<void> {
        if (!this.sink) return;
        const result = this.sink(raw);
        if (result && typeof (result as Promise<unknown>).then === "function") {
            await result;
        }
    }
}

// ── helpers ─────────────────────────────────────────────────────────

function coerceText(value: unknown): string {
    if (value === null || value === undefined) return "";
    return String(value);
}

function coerceArgs(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return { ...(value as Record<string, unknown>) };
    }
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return { ...parsed };
            }
        } catch {
            return { raw: value };
        }
    }
    return {};
}

function coerceStop(value: unknown): StopReason {
    if (typeof value === "string") {
        const lc = value.toLowerCase();
        const valid: StopReason[] = [
            "end_turn",
            "max_tokens",
            "max_turn_requests",
            "refusal",
            "cancelled",
            "error",
        ];
        if ((valid as string[]).includes(lc)) return lc as StopReason;
    }
    return StopReasonValues.END_TURN;
}

function makeToolCallId(): string {
    return `tc_${crypto.randomBytes(6).toString("hex")}`;
}
