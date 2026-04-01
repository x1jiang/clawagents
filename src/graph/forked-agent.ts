/**
 * Forked Agent Pattern (learned from Claude Code).
 *
 * Provides the ability to run sandboxed sub-agents that share the parent's
 * context but operate with restricted tool sets and limited turn budgets.
 *
 * Usage:
 *   import { runForkedAgent } from "./graph/forked-agent.js";
 *
 *   const result = await runForkedAgent({
 *     forkPrompt: "Analyze this error and suggest fixes",
 *     llm, tools, parentMessages: messages.slice(0, 1),
 *     allowedTools: ["read_file", "grep"],
 *     maxTurns: 5,
 *   });
 */

import type { LLMProvider, LLMMessage } from "../providers/llm.js";
import type { ToolRegistry, Tool } from "../tools/registry.js";
import type { AgentState, OnEvent } from "./agent-loop.js";

export interface ForkedAgentOptions {
    forkPrompt: string;
    llm: LLMProvider;
    tools?: ToolRegistry;
    parentMessages?: LLMMessage[];
    allowedTools?: string[];
    blockedTools?: string[];
    maxTurns?: number;
    contextWindow?: number;
    streaming?: boolean;
    onEvent?: OnEvent;
}

export async function runForkedAgent(options: ForkedAgentOptions): Promise<AgentState> {
    // Check feature flag
    const envVal = process.env["CLAW_FEATURE_FORKED_AGENTS"] ?? "0";
    if (!["1", "true", "yes", "on"].includes(envVal.toLowerCase())) {
        throw new Error("Forked agents feature is not enabled. Set CLAW_FEATURE_FORKED_AGENTS=1");
    }

    const { runAgentGraph } = await import("./agent-loop.js");
    const { ToolRegistry: TR } = await import("../tools/registry.js");

    // Create restricted tool registry if filtering is needed
    let forkRegistry = options.tools;
    if (options.tools && (options.allowedTools || options.blockedTools)) {
        forkRegistry = new TR();
        for (const tool of options.tools.list()) {
            if (options.allowedTools && !options.allowedTools.includes(tool.name)) continue;
            if (options.blockedTools && options.blockedTools.includes(tool.name)) continue;
            forkRegistry.register(tool);
        }
    }

    // Extract system prompt from parent context
    let systemPrompt: string | undefined;
    if (options.parentMessages?.length) {
        const first = options.parentMessages[0];
        if (first?.role === "system") {
            systemPrompt = typeof first.content === "string" ? first.content : String(first.content);
        }
    }

    const noop: OnEvent = () => {};

    return runAgentGraph(
        options.forkPrompt,
        options.llm,
        forkRegistry,              // tools
        systemPrompt,              // systemPrompt
        options.maxTurns ?? 5,     // maxIterations
        options.streaming ?? false, // streaming
        options.contextWindow ?? 200_000, // contextWindow
        options.onEvent ?? noop,   // onEvent
        undefined, // beforeLLM
        undefined, // beforeTool
        undefined, // afterTool
        true,      // useNativeTools
        false,     // trajectory
        false,     // rethink
        false,     // learn
    );
}
