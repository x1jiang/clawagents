/** Machine-readable CLI output formats (OpenHarness-style). */

import type { AgentState, EventKind, OnEvent } from "./graph/agent-loop.js";

export type OutputFormat = "text" | "json" | "stream-json";

export function parseOutputFormat(value?: string): OutputFormat {
    const normalized = (value ?? "text").trim().toLowerCase();
    if (normalized === "text" || normalized === "json" || normalized === "stream-json") {
        return normalized;
    }
    throw new Error(`Unsupported output format: ${JSON.stringify(value)} (use text, json, stream-json)`);
}

export function serializeAgentState(state: AgentState): Record<string, unknown> {
    const usage = state.usage?.toJSON?.() ?? state.usage ?? {};
    return {
        status: state.status,
        result: state.result,
        iterations: state.iterations,
        maxIterations: state.maxIterations,
        toolCalls: state.toolCalls,
        finalOutput: state.finalOutput,
        guardrailTripped: state.guardrailTripped,
        trajectoryFile: state.trajectoryFile,
        sessionFile: state.sessionFile,
        usage,
    };
}

export function printAgentOutput(state: AgentState, fmt: OutputFormat): void {
    if (fmt === "text") {
        if (state.result) process.stdout.write(`${state.result}\n`);
        return;
    }
    if (fmt === "json") {
        process.stdout.write(`${JSON.stringify(serializeAgentState(state))}\n`);
        return;
    }
    process.stdout.write(`${JSON.stringify({ type: "result", ...serializeAgentState(state) })}\n`);
}

export function makeStreamJsonEmitter(): OnEvent {
    return (kind: EventKind, data: Record<string, unknown>) => {
        process.stdout.write(`${JSON.stringify({ type: kind, ...data })}\n`);
    };
}
