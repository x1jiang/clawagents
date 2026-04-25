/**
 * Capture live agent runs as {@link Trajectory} objects.
 *
 * {@link RLRecorder} plugs into an agent's event stream (via the
 * `observe(kind, payload)` method) and assembles a training-ready
 * trajectory as the agent runs. Use {@link RLRecorder.finalise} when
 * the agent is done to attach the final assistant message and metadata.
 *
 * Example:
 * ```ts
 * const rec = new RLRecorder({ task: "solve x^2 = 16" });
 * agent.onEvent = (kind, payload) => rec.observe(kind, payload);
 * const answer = await agent.run("solve x^2 = 16");
 * const traj = rec.finalise({ prompt: "solve x^2 = 16", final: answer });
 * ```
 *
 * Mirrors `clawagents.rl.recorder.RLRecorder` on the Python side.
 */

import * as crypto from "node:crypto";

import { Trajectory, ToolCall, toolCall } from "./trajectory.js";

export interface RecorderConfig {
    /** Truncate tool results larger than this (default 8000). */
    maxToolResultChars?: number;
    /** Capture <think>...</think> blocks too (default false). */
    captureThinking?: boolean;
    /** Keep system prompts in the trajectory (default true). */
    captureSystemPrompt?: boolean;
    /** Replace tool args with `{ _redacted: true }` (default false). */
    redactToolArgs?: boolean;
}

interface PendingToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

interface PendingToolMessage {
    id: string;
    name: string;
    result: string;
    success: boolean;
}

const DEFAULT_CONFIG: Required<RecorderConfig> = {
    maxToolResultChars: 8000,
    captureThinking: false,
    captureSystemPrompt: true,
    redactToolArgs: false,
};

function makeRunId(): string {
    return crypto.randomBytes(6).toString("hex");
}

function makeCallId(): string {
    return crypto.randomBytes(4).toString("hex");
}

/**
 * Streams agent events into a {@link Trajectory}.
 *
 * The recorder is *additive*: every call to `observe` appends to the
 * in-progress trajectory. After `finalise`, further events are ignored.
 */
export class RLRecorder {
    public readonly trajectory: Trajectory;
    public readonly config: Required<RecorderConfig>;

    private pendingCalls: Map<string, PendingToolCall> = new Map();
    private currentAssistant: string | null = null;
    private currentToolCalls: ToolCall[] = [];
    /** Tool messages must follow the assistant turn that issued them. */
    private pendingToolMessages: PendingToolMessage[] = [];
    private finalised = false;

    constructor(opts: { task?: string; model?: string; config?: RecorderConfig } = {}) {
        this.config = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
        this.trajectory = new Trajectory({
            runId: makeRunId(),
            task: opts.task ?? "",
            model: opts.model ?? "",
        });
    }

    // ── public API ──────────────────────────────────────────────────

    /**
     * Event handler — bind this to `agent.onEvent`.
     *
     * Mirrors the Python `OnEvent` contract: unknown event kinds are
     * silently ignored, and exceptions never leak out.
     */
    observe(kind: string, payload: Record<string, unknown> | undefined = {}): void {
        if (this.finalised) return;
        const data = { ...(payload ?? {}) };
        try {
            const handler = this.dispatch[kind];
            if (handler) handler(data);
        } catch {
            /* never let RL break the agent */
        }
    }

    /** Async-safe alias — `observe` is fully synchronous, but some
     *  agents prefer `await`-able sinks. */
    async aobserve(
        kind: string,
        payload: Record<string, unknown> | undefined = {}
    ): Promise<void> {
        this.observe(kind, payload);
    }

    addUser(content: string, metadata: Record<string, unknown> = {}): void {
        this.trajectory.addUser(content, metadata);
    }

    addSystem(content: string, metadata: Record<string, unknown> = {}): void {
        if (this.config.captureSystemPrompt) {
            this.trajectory.addSystem(content, metadata);
        }
    }

    /**
     * Flush any pending assistant turn and return the trajectory.
     *
     * `prompt`, if given, is prepended as a `user` step *only* if the
     * trajectory doesn't already have a user/system step. `final` is
     * appended as a final assistant message if non-empty *and*
     * different from the current final assistant content.
     */
    finalise(opts: {
        prompt?: string;
        final?: string;
        reward?: number;
        metadata?: Record<string, unknown>;
    } = {}): Trajectory {
        if (this.finalised) return this.trajectory;

        if (
            opts.prompt &&
            !this.trajectory.steps.some(
                (s) => s.role === "user" || s.role === "system"
            )
        ) {
            this.trajectory.addUser(opts.prompt);
        }

        this.flushAssistant();

        const finalStep = this.trajectory.finalAssistant;
        const lastFinalContent = finalStep ? finalStep.content : null;
        if (opts.final && opts.final !== lastFinalContent) {
            this.trajectory.addAssistant(opts.final);
        }

        if (opts.reward !== undefined) {
            this.trajectory.reward = opts.reward;
        }
        if (opts.metadata) {
            Object.assign(this.trajectory.metadata, opts.metadata);
        }

        this.finalised = true;
        return this.trajectory;
    }

    // ── event handlers ──────────────────────────────────────────────

    private dispatch: Record<string, (data: Record<string, unknown>) => void> = {
        assistant_message: (data) => this.onAssistantMessage(data),
        assistant_delta: (data) => this.onAssistantDelta(data),
        tool_call: (data) => this.onToolCall(data),
        tool_started: (data) => this.onToolCall(data),
        tool_result: (data) => this.onToolResult(data),
        turn_started: () => this.flushAssistant(),
        agent_done: () => this.flushAssistant(),
        final_content: (data) => this.onFinalContent(data),
        final_output: (data) => this.onFinalOutput(data),
    };

    private onAssistantMessage(data: Record<string, unknown>): void {
        const text = String(data.content ?? data.message ?? "");
        if (!text) return;
        // If we already have results from a prior tool round, the prior
        // assistant turn is complete — flush before starting a new one.
        if (this.pendingToolMessages.length > 0) {
            this.flushAssistant();
        }
        if (this.currentAssistant === null) {
            this.currentAssistant = text;
        } else {
            this.currentAssistant = `${this.currentAssistant}\n${text}`.trim();
        }
    }

    private onAssistantDelta(data: Record<string, unknown>): void {
        const delta = String(data.delta ?? data.content ?? "");
        if (!delta) return;
        if (this.pendingToolMessages.length > 0) {
            this.flushAssistant();
        }
        if (this.currentAssistant === null) {
            this.currentAssistant = delta;
        } else {
            this.currentAssistant += delta;
        }
    }

    private onToolCall(data: Record<string, unknown>): void {
        const callId = String(data.id ?? data.call_id ?? makeCallId());
        const name = String(data.name ?? data.tool ?? "");
        if (!name) return;
        if (this.pendingCalls.has(callId)) return;
        let args = (data.arguments ?? data.args ?? {}) as Record<string, unknown>;
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
            args = { _raw: args as unknown };
        }
        if (this.config.redactToolArgs) {
            args = { _redacted: true };
        }
        this.pendingCalls.set(callId, { id: callId, name, arguments: { ...args } });
    }

    private onToolResult(data: Record<string, unknown>): void {
        let callId = String(data.id ?? data.call_id ?? "");
        const toolName = String(data.name ?? data.tool ?? "");
        let result = data.result ?? data.output ?? "";
        if (typeof result !== "string") {
            try {
                result = JSON.stringify(result);
            } catch {
                result = String(result);
            }
        }
        if ((result as string).length > this.config.maxToolResultChars) {
            result = `${(result as string).slice(0, this.config.maxToolResultChars)}…`;
        }
        const success = Boolean(data.success ?? true);
        const error = data.error;
        const durationMs = Number(data.duration_ms ?? 0);

        let pending = this.pendingCalls.get(callId);
        if (pending) {
            this.pendingCalls.delete(callId);
        } else if (toolName) {
            // Re-pair by name when call ids weren't propagated.
            for (const [pid, p] of this.pendingCalls.entries()) {
                if (p.name === toolName) {
                    pending = p;
                    this.pendingCalls.delete(pid);
                    if (!callId) callId = pid;
                    break;
                }
            }
        }

        if (!pending) {
            pending = {
                id: callId || makeCallId(),
                name: toolName || "unknown",
                arguments: {},
            };
        }

        this.currentToolCalls.push(
            toolCall({
                id: pending.id,
                name: pending.name,
                arguments: pending.arguments,
                result: result as string,
                success,
                error: error ? String(error) : undefined,
                durationMs,
            })
        );
        this.pendingToolMessages.push({
            id: pending.id,
            name: pending.name,
            result: result as string,
            success,
        });
    }

    private onFinalContent(data: Record<string, unknown>): void {
        const text = String(data.content ?? data.text ?? "");
        if (!text) return;
        if (this.currentAssistant === null) {
            this.currentAssistant = text;
        } else {
            this.currentAssistant = `${this.currentAssistant}\n${text}`.trim();
        }
    }

    private onFinalOutput(data: Record<string, unknown>): void {
        const out = data.output;
        let text = "";
        if (typeof out === "string") {
            text = out;
        } else if (out && typeof out === "object") {
            const o = out as Record<string, unknown>;
            text = String(o.content ?? o.text ?? "");
        }
        if (text) this.onFinalContent({ content: text });
    }

    private flushAssistant(): void {
        if (
            this.currentAssistant === null &&
            this.currentToolCalls.length === 0 &&
            this.pendingToolMessages.length === 0
        ) {
            return;
        }
        if (this.currentAssistant !== null || this.currentToolCalls.length > 0) {
            this.trajectory.addAssistant(
                this.currentAssistant ?? "",
                [...this.currentToolCalls]
            );
        }
        for (const msg of this.pendingToolMessages) {
            this.trajectory.addTool(msg.result, {
                toolCallId: msg.id,
                name: msg.name,
                metadata: { success: msg.success },
            });
        }
        this.currentAssistant = null;
        this.currentToolCalls = [];
        this.pendingToolMessages = [];
    }
}
