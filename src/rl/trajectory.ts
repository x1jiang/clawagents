/**
 * Normalised trajectory data model for RL fine-tuning.
 *
 * A {@link Trajectory} is a serialisable record of one agent run, in a
 * shape that's friendly to TRL / Atropos / SLIME training pipelines.
 * Each {@link TrajectoryStep} corresponds to a single message
 * (system / user / assistant / tool). The structure round-trips
 * losslessly through JSON and converts cleanly to ChatML.
 *
 * Mirrors `clawagents.rl.trajectory` on the Python side.
 */

import * as crypto from "node:crypto";

export type TrajectoryRole = "system" | "user" | "assistant" | "tool";

/**
 * A single tool invocation captured during an assistant turn.
 *
 * Mirrors the OpenAI / ChatML `tool_call` shape so downstream
 * converters don't have to reshape the data.
 */
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result: string;
    success: boolean;
    error?: string;
    durationMs: number;
}

export function toolCall(
    init: Partial<ToolCall> & { id: string; name: string }
): ToolCall {
    return {
        id: init.id,
        name: init.name,
        arguments: init.arguments ?? {},
        result: init.result ?? "",
        success: init.success ?? true,
        error: init.error,
        durationMs: init.durationMs ?? 0,
    };
}

export function toolCallToJson(tc: ToolCall): Record<string, unknown> {
    const out: Record<string, unknown> = {
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        result: tc.result,
        success: tc.success,
        duration_ms: tc.durationMs,
    };
    if (tc.error) out.error = tc.error;
    return out;
}

export function toolCallFromJson(d: Record<string, unknown>): ToolCall {
    return {
        id: String(d.id ?? ""),
        name: String(d.name ?? ""),
        arguments: (d.arguments as Record<string, unknown>) ?? {},
        result: String(d.result ?? ""),
        success: Boolean(d.success ?? true),
        error: typeof d.error === "string" ? d.error : undefined,
        durationMs: Number(d.duration_ms ?? 0),
    };
}

/**
 * One message in a trajectory.
 *
 * For `role: "assistant"` the `toolCalls` field captures any tool
 * invocations the model emitted on this turn. For `role: "tool"` the
 * `toolCallId` field links back to the originating call.
 */
export interface TrajectoryStep {
    role: TrajectoryRole;
    content: string;
    toolCalls: ToolCall[];
    toolCallId?: string;
    name?: string;
    metadata: Record<string, unknown>;
}

export function trajectoryStep(
    init: Partial<TrajectoryStep> & { role: TrajectoryRole }
): TrajectoryStep {
    return {
        role: init.role,
        content: init.content ?? "",
        toolCalls: init.toolCalls ?? [],
        toolCallId: init.toolCallId,
        name: init.name,
        metadata: init.metadata ?? {},
    };
}

export function stepToJson(step: TrajectoryStep): Record<string, unknown> {
    const out: Record<string, unknown> = {
        role: step.role,
        content: step.content,
    };
    if (step.toolCalls.length > 0) {
        out.tool_calls = step.toolCalls.map(toolCallToJson);
    }
    if (step.toolCallId) out.tool_call_id = step.toolCallId;
    if (step.name) out.name = step.name;
    if (Object.keys(step.metadata).length > 0) out.metadata = step.metadata;
    return out;
}

export function stepFromJson(d: Record<string, unknown>): TrajectoryStep {
    let role = d.role as TrajectoryRole | string;
    if (
        role !== "system" &&
        role !== "user" &&
        role !== "assistant" &&
        role !== "tool"
    ) {
        role = "user";
    }
    const rawCalls = (d.tool_calls as Array<Record<string, unknown>>) ?? [];
    return {
        role: role as TrajectoryRole,
        content: String(d.content ?? ""),
        toolCalls: rawCalls.map(toolCallFromJson),
        toolCallId: typeof d.tool_call_id === "string" ? d.tool_call_id : undefined,
        name: typeof d.name === "string" ? d.name : undefined,
        metadata: (d.metadata as Record<string, unknown>) ?? {},
    };
}

function makeRunId(): string {
    return crypto.randomBytes(6).toString("hex");
}

/**
 * A complete agent run normalised for training pipelines.
 *
 * `Trajectory` is intentionally a class with mutating `addUser` /
 * `addAssistant` / `addTool` helpers — recording is naturally
 * stateful, and threading immutable updates through every event
 * handler would obscure the simple cases. Use {@link Trajectory.toJson}
 * to capture a snapshot.
 */
export class Trajectory {
    public runId: string;
    public task: string;
    public model: string;
    public steps: TrajectoryStep[];
    public reward: number | null;
    public rewards: Record<string, number>;
    public createdAt: number;
    public metadata: Record<string, unknown>;

    constructor(
        init: {
            runId?: string;
            task?: string;
            model?: string;
            steps?: TrajectoryStep[];
            reward?: number | null;
            rewards?: Record<string, number>;
            createdAt?: number;
            metadata?: Record<string, unknown>;
        } = {}
    ) {
        this.runId = init.runId ?? makeRunId();
        this.task = init.task ?? "";
        this.model = init.model ?? "";
        this.steps = init.steps ?? [];
        this.reward = init.reward ?? null;
        this.rewards = init.rewards ?? {};
        this.createdAt = init.createdAt ?? Date.now() / 1000;
        this.metadata = init.metadata ?? {};
    }

    addSystem(content: string, metadata: Record<string, unknown> = {}): TrajectoryStep {
        const s = trajectoryStep({ role: "system", content, metadata });
        this.steps.push(s);
        return s;
    }

    addUser(content: string, metadata: Record<string, unknown> = {}): TrajectoryStep {
        const s = trajectoryStep({ role: "user", content, metadata });
        this.steps.push(s);
        return s;
    }

    addAssistant(
        content = "",
        toolCalls: ToolCall[] = [],
        metadata: Record<string, unknown> = {}
    ): TrajectoryStep {
        const s = trajectoryStep({
            role: "assistant",
            content,
            toolCalls: [...toolCalls],
            metadata,
        });
        this.steps.push(s);
        return s;
    }

    addTool(
        result: string,
        opts: {
            toolCallId?: string;
            name?: string;
            metadata?: Record<string, unknown>;
        } = {}
    ): TrajectoryStep {
        const s = trajectoryStep({
            role: "tool",
            content: result,
            toolCallId: opts.toolCallId,
            name: opts.name,
            metadata: opts.metadata ?? {},
        });
        this.steps.push(s);
        return s;
    }

    /** Concatenated assistant content — used by string-matching scorers. */
    get assistantText(): string {
        return this.steps
            .filter((s) => s.role === "assistant" && s.content)
            .map((s) => s.content)
            .join("\n");
    }

    /** All non-assistant content joined for length-based scoring. */
    get promptText(): string {
        return this.steps
            .filter((s) => s.role === "system" || s.role === "user")
            .map((s) => s.content)
            .join("\n");
    }

    /** Final assistant message, or null if the trajectory has none. */
    get finalAssistant(): TrajectoryStep | null {
        for (let i = this.steps.length - 1; i >= 0; i--) {
            if (this.steps[i].role === "assistant") return this.steps[i];
        }
        return null;
    }

    get length(): number {
        return this.steps.length;
    }

    toJson(): Record<string, unknown> {
        const out: Record<string, unknown> = {
            run_id: this.runId,
            task: this.task,
            model: this.model,
            steps: this.steps.map(stepToJson),
            created_at: this.createdAt,
        };
        if (this.reward !== null) out.reward = this.reward;
        if (Object.keys(this.rewards).length > 0) out.rewards = { ...this.rewards };
        if (Object.keys(this.metadata).length > 0) out.metadata = { ...this.metadata };
        return out;
    }

    toJsonString(): string {
        return JSON.stringify(this.toJson());
    }

    static fromJson(d: Record<string, unknown>): Trajectory {
        const rewards = (d.rewards as Record<string, unknown>) ?? {};
        const numericRewards: Record<string, number> = {};
        for (const [k, v] of Object.entries(rewards)) {
            numericRewards[k] = Number(v);
        }
        return new Trajectory({
            runId: typeof d.run_id === "string" ? d.run_id : undefined,
            task: typeof d.task === "string" ? d.task : "",
            model: typeof d.model === "string" ? d.model : "",
            steps: ((d.steps as Array<Record<string, unknown>>) ?? []).map(stepFromJson),
            reward: typeof d.reward === "number" ? d.reward : null,
            rewards: numericRewards,
            createdAt: typeof d.created_at === "number" ? d.created_at : undefined,
            metadata: (d.metadata as Record<string, unknown>) ?? {},
        });
    }

    static fromJsonString(s: string): Trajectory {
        return Trajectory.fromJson(JSON.parse(s) as Record<string, unknown>);
    }
}
