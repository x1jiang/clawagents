/**
 * Agent-to-agent handoffs.
 *
 * A handoff is an LLM-visible tool (`transfer_to_<name>`) that, when called,
 * switches the running agent. The new agent takes over the conversation —
 * distinct from `ClawAgent.asTool`, where the parent calls the nested agent
 * and resumes after.
 *
 * Inspired by openai-agents-python's `agents.handoffs` module but kept
 * backward-compatible with the existing `runAgentGraph` flow.
 */

import type { LLMMessage } from "./providers/llm.js";
import type { RunContext } from "./run-context.js";
import type { ClawAgent } from "./agent.js";

/**
 * Snapshot of conversation state at the moment a handoff fires.
 *
 * `inputHistory` is the parent agent's full message list (system +
 * user + any tool exchanges) up to the assistant turn that emitted the
 * handoff tool call. `preHandoffItems` and `newItems` mirror the
 * upstream layout but, for the ClawAgent loop, are kept as opaque
 * lists so filters can stay forward-compatible if richer item types
 * land later. `runContext` is the live RunContext for this run —
 * filters may inspect it but should not mutate it in surprising ways.
 */
export interface HandoffInputData<TContext = unknown> {
    inputHistory: LLMMessage[];
    preHandoffItems?: unknown[];
    newItems?: unknown[];
    runContext?: RunContext<TContext>;
}

/** Filter run by the loop on the {@link HandoffInputData} before transfer. */
export type InputFilter<TContext = unknown> = (
    data: HandoffInputData<TContext>,
) => HandoffInputData<TContext>;

/**
 * A handoff descriptor surfaced to the LLM as a synthetic tool.
 *
 * The agent loop turns each `Handoff` on the running agent into a
 * tool entry called `name` (default: `transfer_to_<agent_name>`)
 * with a single `reason` string parameter. When the LLM calls it,
 * the loop runs the input filter, fires `RunHooks.onHandoff`, and
 * re-enters the loop with `targetAgentFactory()` as the active
 * agent.
 */
export interface Handoff<TContext = unknown> {
    /** Tool name surfaced to the LLM (default: `transfer_to_<agent_name>`). */
    name: string;
    /** Description shown to the LLM — explains when to use this handoff. */
    description: string;
    /** Zero-arg factory returning the target agent. */
    targetAgentFactory: () => ClawAgent;
    /** Optional filter applied to the conversation before transfer. */
    inputFilter?: InputFilter<TContext>;
    /** Optional async side-effect fired right before the transfer. */
    onHandoff?: (ctx: RunContext<TContext>) => Promise<void>;
}

function defaultHandoffName(agentName: string): string {
    return `transfer_to_${agentName.replace(/\s+/g, "_")}`;
}

function defaultHandoffDescription(agentName: string): string {
    return (
        `Hand off the conversation to the '${agentName}' agent. ` +
        "Use this when the request is better handled by that agent. " +
        "The other agent will take over the conversation; you will not " +
        "resume after it finishes."
    );
}

function agentDisplayName(agent: ClawAgent): string {
    const raw = (agent as unknown as { name?: unknown }).name;
    if (typeof raw === "string" && raw) return raw;
    const sp = (agent as unknown as { systemPrompt?: unknown }).systemPrompt;
    if (typeof sp === "string" && sp.trim()) {
        const first = sp.trim().split(/\r?\n/)[0] ?? "";
        const slug = first.toLowerCase().split(/\s+/).join("_").slice(0, 32);
        if (slug) return slug;
    }
    return "agent";
}

/**
 * Build a {@link Handoff} from an agent or agent factory.
 *
 * `target` may be either a `ClawAgent` instance or a zero-arg
 * callable returning one. The latter is preferred when the target
 * needs lazy construction.
 */
export function handoff<TContext = unknown>(
    target: ClawAgent | (() => ClawAgent),
    opts: {
        name?: string;
        description?: string;
        inputFilter?: InputFilter<TContext>;
        onHandoff?: (ctx: RunContext<TContext>) => Promise<void>;
    } = {},
): Handoff<TContext> {
    let factory: () => ClawAgent;
    let label: string;
    if (typeof target === "function") {
        factory = target;
        try {
            const probe = target();
            label = agentDisplayName(probe);
        } catch {
            label = "agent";
        }
    } else {
        const instance = target;
        factory = () => instance;
        label = agentDisplayName(instance);
    }

    return {
        name: opts.name ?? defaultHandoffName(label),
        description: opts.description ?? defaultHandoffDescription(label),
        targetAgentFactory: factory,
        inputFilter: opts.inputFilter,
        onHandoff: opts.onHandoff,
    };
}
