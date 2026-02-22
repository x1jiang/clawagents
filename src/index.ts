#!/usr/bin/env node
/**
 * ClawAgents — Backend engine combining openclaw resilience with deepagents reasoning.
 *
 * Usage:
 *   npx tsx src/index.ts                  # Start gateway server
 *   npx tsx src/index.ts --task "..."     # Run a single task from CLI
 */

import { loadConfig, getDefaultModel } from "./config/config.js";
import { createClawAgent } from "./agent.js";
import { startGateway } from "./gateway/server.js";

// Re-export public API
export { createClawAgent, ClawAgent, LangChainToolAdapter } from "./agent.js";
export type { AgentState, OnEvent, EventKind, BeforeLLMHook, BeforeToolHook, AfterToolHook } from "./graph/agent-loop.js";
export type { Tool, ToolResult, ToolRegistry } from "./tools/registry.js";
export type { LLMProvider, LLMMessage, LLMResponse } from "./providers/llm.js";

async function main() {
    const config = loadConfig();
    const activeModel = getDefaultModel(config);

    const agent = await createClawAgent({
        model: activeModel,
        streaming: config.streaming,
    });

    const toolCount = agent.tools.list().length;
    process.stderr.write(`ClawAgents | ${activeModel} | ${toolCount} tools\n`);

    // Check for --task flag for CLI mode
    const args = process.argv;
    let task = "";
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--task" && i + 1 < args.length) {
            task = args[i + 1]!;
            break;
        } else if (args[i]?.startsWith("--task=")) {
            task = args[i]!.substring(7);
            break;
        }
    }

    if (task) {
        await agent.invoke(task);
        process.exit(0);
    }

    // Default: start gateway server
    startGateway(3000);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
