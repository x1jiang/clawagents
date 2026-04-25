/**
 * Sub-agent delegation via the `task` tool.
 *
 * Spawns an isolated runAgentGraph() with a fresh context window.
 * Only the final result is returned to the parent agent.
 *
 * Supports typed SubAgentSpec for per-agent configuration (name, prompt, tools, etc.)
 */

import type { LLMProvider } from "../providers/llm.js";
import type { Tool, ToolResult, ToolRegistry } from "./registry.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { isEnabled } from "../config/features.js";
import { IterationBudget } from "../iteration-budget.js";
import { MAX_SUBAGENT_DEPTH, RunContext } from "../run-context.js";
import * as os from "node:os";

/** Keys that must NOT be inherited by child agents — prevents parent context leakage. */
export const EXCLUDED_STATE_KEYS: ReadonlySet<string> = new Set([
    "messages", "todos", "trajectory", "lessons", "session",
]);

/**
 * Specification for a named sub-agent with its own configuration.
 * When the parent dispatches a task with a matching `agent` name,
 * these settings override the defaults.
 */
export interface SubAgentSpec {
    /** Unique name for this sub-agent type (e.g., "researcher", "coder"). */
    name: string;
    /** Human-readable description of what this sub-agent does. */
    description: string;
    /** System prompt for this sub-agent. */
    systemPrompt?: string;
    /** Max tool rounds. Default: 5. */
    maxIterations?: number;
    /** Whether to use native tool calling for this sub-agent. */
    useNativeTools?: boolean;
    /**
     * When true (and the credential_proxy feature flag is on), start a local
     * credential proxy so the sub-agent never receives raw API keys.
     */
    credentialProxy?: boolean;
}

/**
 * Test-only seam: lets unit tests inject a stub for the dynamically imported
 * `runAgentGraph`. ESM module-namespace exports are read-only at runtime, so
 * we cannot monkey-patch `agent-loop.js` from a test file. Production code
 * leaves this `undefined` and the real `runAgentGraph` is dynamically imported.
 */
export type RunAgentGraphFn = typeof import("../graph/agent-loop.js")["runAgentGraph"];

export class TaskTool implements Tool {
    name = "task";
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    private useQueue: boolean;
    private runAgentGraphImpl?: RunAgentGraphFn;

    constructor(
        private llm: LLMProvider,
        private tools: ToolRegistry,
        private subagents: SubAgentSpec[] = [],
        useQueue = false,
        runAgentGraphImpl?: RunAgentGraphFn,
    ) {
        this.useQueue = useQueue;
        this.runAgentGraphImpl = runAgentGraphImpl;
        const agentNames = subagents.map((s) => s.name);
        const agentList = agentNames.length > 0
            ? ` Available specialized agents: ${agentNames.join(", ")}.`
            : "";
        this.description =
            "Delegate a task to a sub-agent with its own isolated context window. " +
            "Use for complex sub-tasks that would clutter your main context. " +
            "The sub-agent has access to the same tools but a fresh conversation." +
            agentList;
        this.parameters = {
            description: {
                type: "string" as const,
                description: "What the sub-agent should accomplish",
                required: true as const,
            },
            agent: {
                type: "string" as const,
                description: `Optional: name of a specialized sub-agent to use.${agentList ? " Options: " + agentNames.join(", ") : ""}`,
            },
            max_iterations: {
                type: "number" as const,
                description: "Max tool rounds for the sub-agent. Default: 5",
            },
        };
    }

    async execute(
        args: Record<string, unknown>,
        runContext?: RunContext<unknown>,
    ): Promise<ToolResult> {
        // ── Hermes-parity depth cap ────────────────────────────────────
        // Subagents may delegate, but recursion is bounded at
        // MAX_SUBAGENT_DEPTH (=2) to keep token / time blow-up bounded.
        const parentDepth = runContext?.depth ?? 0;
        if (parentDepth >= MAX_SUBAGENT_DEPTH) {
            return {
                success: false,
                output: "",
                error:
                    `Sub-agent delegation refused: depth cap of ${MAX_SUBAGENT_DEPTH} ` +
                    `reached (parent depth=${parentDepth}). Recursive delegation is ` +
                    `disallowed; the parent should perform the work directly or split ` +
                    `it into siblings rather than nesting another \`task\` call.`,
            };
        }

        // Dynamic import to avoid circular dependency. Tests may inject
        // a stub via the constructor's `runAgentGraphImpl` parameter.
        const runAgentGraph: RunAgentGraphFn =
            this.runAgentGraphImpl ??
            (await import("../graph/agent-loop.js")).runAgentGraph;

        const description = String(args["description"] ?? "");
        const agentName = args["agent"] ? String(args["agent"]) : undefined;
        const rawIter = Number(args["max_iterations"] ?? 5);
        const maxIter = Number.isFinite(rawIter) && rawIter > 0 ? Math.floor(rawIter) : 5;

        if (!description) {
            return { success: false, output: "", error: "No task description provided" };
        }

        const spec = agentName
            ? this.subagents.find((s) => s.name === agentName)
            : undefined;

        const effectiveMaxIter = spec?.maxIterations ?? maxIter;
        const effectivePrompt = spec?.systemPrompt;
        const effectiveNativeTools = spec?.useNativeTools ?? true;

        const useCredProxy = Boolean(spec?.credentialProxy && isEnabled("credential_proxy"));

        const doRun = async () => {
            const { CredentialProxy } = await import("../sandbox/credential-proxy.js");
            let proxy: InstanceType<typeof CredentialProxy> | null = null;
            const oldEnv: Record<string, string | undefined> = {};

            if (useCredProxy) {
                const credHeaders: Record<string, string> = {};
                const openaiKey = process.env["OPENAI_API_KEY"];
                if (openaiKey) credHeaders["Authorization"] = `Bearer ${openaiKey}`;
                const anthropicKey = process.env["ANTHROPIC_API_KEY"];
                if (anthropicKey) credHeaders["x-api-key"] = anthropicKey;

                if (Object.keys(credHeaders).length > 0) {
                    proxy = new CredentialProxy(credHeaders);
                    const proxyUrl = proxy.start();
                    const overrides: Record<string, string> = {
                        OPENAI_BASE_URL: proxyUrl,
                        ANTHROPIC_BASE_URL: proxyUrl,
                        OPENAI_API_KEY: "proxy",
                        ANTHROPIC_API_KEY: "proxy",
                    };
                    for (const [k, v] of Object.entries(overrides)) {
                        oldEnv[k] = process.env[k];
                        process.env[k] = v;
                    }
                }
            }

            // Build an isolated child RunContext: increment depth, disable
            // parent memory access (Hermes parity), and give the child a
            // *fresh* IterationBudget sized to its own ``effectiveMaxIter``
            // so a runaway subagent cannot starve the parent's remaining
            // turns. This mirrors Hermes' ``delegation.max_iterations``
            // contract: each delegated agent has its own budget.
            const childCtx = new RunContext<unknown>({
                permissionMode: runContext?.permissionMode,
                depth: parentDepth + 1,
                skipMemory: true,
                iterationBudget: new IterationBudget(
                    Math.max(1, Math.floor(effectiveMaxIter)),
                ),
            });

            try {
                const state = await runAgentGraph(
                    description,
                    this.llm,
                    this.tools,
                    effectivePrompt,
                    effectiveMaxIter,
                    false,
                    128_000,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    effectiveNativeTools,
                    false, // trajectory
                    false, // rethink
                    false, // learn
                    120,   // previewChars
                    500,   // responseChars
                    0,     // timeoutS
                    undefined, // features
                    undefined, // advisorLLM
                    3,         // advisorMaxCalls
                    { runContext: childCtx },
                );

                if (state.status === "error") {
                    return {
                        success: false,
                        output: state.result || "",
                        error: `Sub-agent failed: ${state.result}`,
                    } as ToolResult;
                }

                const agentLabel = spec ? `Sub-agent [${spec.name}]` : "Sub-agent";
                return {
                    success: true,
                    output: `[${agentLabel} completed: ${state.toolCalls} tool calls, ${state.iterations} iterations]\n\n${state.result}`,
                } as ToolResult;
            } finally {
                // Restore original env vars and stop credential proxy
                for (const [k, orig] of Object.entries(oldEnv)) {
                    if (orig === undefined) {
                        delete process.env[k];
                    } else {
                        process.env[k] = orig;
                    }
                }
                if (proxy !== null) proxy.stop();
            }
        };

        try {
            if (this.useQueue) {
                return await enqueueCommandInLane(CommandLane.Subagent, doRun);
            }
            return await doRun();
        } catch (err) {
            return { success: false, output: "", error: `Sub-agent error: ${String(err)}` };
        }
    }
}

export function createTaskTool(
    llm: LLMProvider,
    tools: ToolRegistry,
    subagents: SubAgentSpec[] = [],
    useQueue = false,
): Tool {
    return new TaskTool(llm, tools, subagents, useQueue);
}
