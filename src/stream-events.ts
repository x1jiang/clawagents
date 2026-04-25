/**
 * Typed discriminated union for agent stream events.
 *
 * The legacy `onEvent(kind: EventKind, data: Record<string, unknown>)`
 * callback is preserved. In parallel, callers can opt into a strongly
 * typed event via {@link ClawAgentOptions.onStreamEvent}, which fires
 * with a {@link StreamEvent} built from the same `(kind, data)` pair.
 *
 * Unknown kinds fall back to the base {@link GenericStreamEvent} so
 * adding new event kinds never crashes subscribers.
 */

export interface BaseStreamEvent {
    kind: string;
    data: Record<string, unknown>;
}

export interface TurnStartedEvent extends BaseStreamEvent {
    kind: "turn_started";
    iteration: number;
}

export interface AssistantTextEvent extends BaseStreamEvent {
    kind: "assistant_message";
    content: string;
}

export interface AssistantDeltaEvent extends BaseStreamEvent {
    kind: "assistant_delta";
    delta: string;
}

export interface ToolCallPlannedEvent extends BaseStreamEvent {
    kind: "tool_call";
    toolName: string;
    callId: string;
    args: Record<string, unknown>;
}

export interface ToolStartedEvent extends BaseStreamEvent {
    kind: "tool_started";
    toolName: string;
    callId: string;
    args: Record<string, unknown>;
}

export interface ToolResultEvent extends BaseStreamEvent {
    kind: "tool_result";
    toolName: string;
    callId: string;
    success: boolean;
    output: string;
    error?: string | null;
}

export interface ApprovalRequiredEvent extends BaseStreamEvent {
    kind: "approval_required";
    toolName: string;
    callId: string;
    args: Record<string, unknown>;
}

export interface UsageEvent extends BaseStreamEvent {
    kind: "usage";
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model: string;
}

export interface GuardrailTrippedEvent extends BaseStreamEvent {
    kind: "guardrail_tripped";
    guardrailName: string;
    where: "input" | "output" | string;
    behavior: string;
    message: string;
}

export interface HandoffOccurredEvent extends BaseStreamEvent {
    kind: "handoff_occurred";
    fromAgent: string;
    toAgent: string;
    toolName: string;
    reason: string;
}

export interface FinalOutputEvent extends BaseStreamEvent {
    kind: "final_output";
    output: unknown;
    raw: string;
}

export interface ErrorStreamEvent extends BaseStreamEvent {
    kind: "error";
    error: string;
    recoverable: boolean;
}

export interface GenericStreamEvent extends BaseStreamEvent {
    kind: string;
}

export type StreamEvent =
    | TurnStartedEvent
    | AssistantTextEvent
    | AssistantDeltaEvent
    | ToolCallPlannedEvent
    | ToolStartedEvent
    | ToolResultEvent
    | ApprovalRequiredEvent
    | UsageEvent
    | GuardrailTrippedEvent
    | HandoffOccurredEvent
    | FinalOutputEvent
    | ErrorStreamEvent
    | GenericStreamEvent;

function num(v: unknown, fallback = 0): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback = ""): string {
    return typeof v === "string" ? v : fallback;
}
function bool(v: unknown, fallback = false): boolean {
    return typeof v === "boolean" ? v : fallback;
}
function rec(v: unknown): Record<string, unknown> {
    return v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : {};
}

/** Promote a legacy `(kind, data)` event into the matching typed variant. */
export function streamEventFromKind(
    kind: string,
    data: Record<string, unknown> = {},
): StreamEvent {
    const base = { kind, data };
    switch (kind) {
        case "turn_started":
            return { ...base, kind, iteration: num(data.iteration) };
        case "assistant_message":
            return { ...base, kind, content: str(data.content) };
        case "assistant_delta":
            return { ...base, kind, delta: str(data.delta) };
        case "tool_call":
            return {
                ...base,
                kind,
                toolName: str(data.toolName ?? data.tool_name ?? data.name),
                callId: str(data.callId ?? data.call_id ?? data.id),
                args: rec(data.args ?? data.arguments),
            };
        case "tool_started":
            return {
                ...base,
                kind,
                toolName: str(data.toolName ?? data.tool_name ?? data.name),
                callId: str(data.callId ?? data.call_id ?? data.id),
                args: rec(data.args ?? data.arguments),
            };
        case "tool_result":
            return {
                ...base,
                kind,
                toolName: str(data.toolName ?? data.tool_name ?? data.name),
                callId: str(data.callId ?? data.call_id ?? data.id),
                success: bool(data.success, true),
                output: str(data.output),
                error: typeof data.error === "string" ? data.error : null,
            };
        case "approval_required":
            return {
                ...base,
                kind,
                toolName: str(data.toolName ?? data.tool_name ?? data.name),
                callId: str(data.callId ?? data.call_id ?? data.id),
                args: rec(data.args ?? data.arguments),
            };
        case "usage":
            return {
                ...base,
                kind,
                model: str(data.model),
                inputTokens: num(data.inputTokens ?? data.input_tokens),
                outputTokens: num(data.outputTokens ?? data.output_tokens),
                totalTokens: num(data.totalTokens ?? data.total_tokens),
            };
        case "guardrail_tripped":
            return {
                ...base,
                kind,
                guardrailName: str(data.guardrailName ?? data.guardrail_name),
                where: str(data.where),
                behavior: str(data.behavior),
                message: str(data.message),
            };
        case "handoff_occurred":
            return {
                ...base,
                kind,
                fromAgent: str(data.fromAgent ?? data.from_agent),
                toAgent: str(data.toAgent ?? data.to_agent),
                toolName: str(data.toolName ?? data.tool_name),
                reason: str(data.reason),
            };
        case "final_output":
            return { ...base, kind, output: data.output, raw: str(data.raw) };
        case "error":
            return {
                ...base,
                kind,
                error: str(data.error ?? data.message),
                recoverable: bool(data.recoverable),
            };
        default:
            return base;
    }
}
