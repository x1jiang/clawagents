/**
 * Class-based lifecycle hooks.
 *
 * The existing function-style hooks — `beforeLLM`, `beforeTool`,
 * `afterTool`, `onEvent` — are preserved for backward compatibility.
 * This module adds a richer, class-based API inspired by
 * openai-agents-python's `RunHooks` / `AgentHooks` so callers can
 * override only the methods they care about instead of wiring up
 * multiple separate callables.
 *
 * Hook methods receive a single **payload object** so new fields can
 * be added without breaking call sites. Every payload carries
 * `runContext` and `agentName` to mirror openai-agents-python's
 * `RunContextWrapper` + current-agent context.
 *
 * Both legacy function-style hooks and class-style hooks fire in the
 * loop — class-style hooks are observation-only (hook exceptions are
 * caught and logged by the agent loop), while function-style hooks
 * still get the final word on blocking / arg rewriting.
 */

import type { RunContext } from "./run-context.js";
import type { LLMResponse } from "./providers/llm.js";
import type { ToolResult } from "./tools/registry.js";
import type { AgentState } from "./graph/agent-loop.js";

// ── Payload types ───────────────────────────────────────────────────

export interface LifecyclePayload<TContext = unknown> {
    runContext: RunContext<TContext>;
    agentName: string;
}

export interface RunStartPayload<TContext = unknown>
    extends LifecyclePayload<TContext> {
    task: string;
}

export interface RunEndPayload<TContext = unknown>
    extends LifecyclePayload<TContext> {
    state: AgentState;
}

export interface AgentStartPayload<TContext = unknown>
    extends LifecyclePayload<TContext> {
    task: string;
}

export interface AgentEndPayload<TContext = unknown>
    extends LifecyclePayload<TContext> {
    result: string;
}

export interface LLMStartPayload<TContext = unknown>
    extends LifecyclePayload<TContext> {
    iteration: number;
}

export interface LLMEndPayload<TContext = unknown>
    extends LifecyclePayload<TContext> {
    response: LLMResponse;
}

export interface ToolStartPayload<TContext = unknown>
    extends LifecyclePayload<TContext> {
    toolName: string;
    args: Record<string, unknown>;
    toolCallId: string;
}

export interface ToolEndPayload<TContext = unknown>
    extends LifecyclePayload<TContext> {
    toolName: string;
    args: Record<string, unknown>;
    result: ToolResult;
    toolCallId: string;
}

export interface HandoffPayload<TContext = unknown>
    extends LifecyclePayload<TContext> {
    fromAgent: string;
    toAgent: string;
}

// ── Hook classes ────────────────────────────────────────────────────

/**
 * Base class for run-level and agent-level lifecycle hooks. Subclass
 * and override only the methods you care about. All methods are
 * async and observation-only — exceptions are swallowed by the agent
 * loop (and surfaced via a `warn` event) so a buggy hook cannot
 * abort a run.
 */
export class RunHooks<TContext = unknown> {
    async onRunStart(_payload: RunStartPayload<TContext>): Promise<void> {}
    async onRunEnd(_payload: RunEndPayload<TContext>): Promise<void> {}
    async onAgentStart(_payload: AgentStartPayload<TContext>): Promise<void> {}
    async onAgentEnd(_payload: AgentEndPayload<TContext>): Promise<void> {}
    async onLLMStart(_payload: LLMStartPayload<TContext>): Promise<void> {}
    async onLLMEnd(_payload: LLMEndPayload<TContext>): Promise<void> {}
    async onToolStart(_payload: ToolStartPayload<TContext>): Promise<void> {}
    async onToolEnd(_payload: ToolEndPayload<TContext>): Promise<void> {}
    async onHandoff(_payload: HandoffPayload<TContext>): Promise<void> {}
}

/**
 * Per-agent hooks. Alias for {@link RunHooks}; kept as a separate class
 * so future multi-agent graphs can diverge without breaking callers.
 */
export class AgentHooks<TContext = unknown> extends RunHooks<TContext> {}

/**
 * Combine multiple {@link RunHooks} into a single composite so callers
 * can layer observability (tracing, metrics, logging) without wiring
 * each one individually.
 */
export function compositeHooks<TContext = unknown>(
    ...hooks: RunHooks<TContext>[]
): RunHooks<TContext> {
    const all = hooks.filter((h): h is RunHooks<TContext> => !!h);
    if (all.length === 0) return new RunHooks<TContext>();
    if (all.length === 1) return all[0]!;

    const composite = new RunHooks<TContext>();
    const methods: (keyof RunHooks<TContext>)[] = [
        "onRunStart", "onRunEnd",
        "onAgentStart", "onAgentEnd",
        "onLLMStart", "onLLMEnd",
        "onToolStart", "onToolEnd",
        "onHandoff",
    ];
    for (const method of methods) {
        (composite as any)[method] = async (payload: unknown) => {
            for (const h of all) {
                try { await (h as any)[method](payload); }
                catch { /* observation-only; swallowed here as well */ }
            }
        };
    }
    return composite;
}
