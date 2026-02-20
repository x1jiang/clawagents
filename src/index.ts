#!/usr/bin/env node
/**
 * ClawAgents — Backend engine combining openclaw resilience with deepagents reasoning.
 *
 * Usage:
 *   npx tsx src/index.ts                  # Start gateway server
 *   npx tsx src/index.ts --task "..."     # Run a single task from CLI
 */

import { loadConfig } from "./config/config.js";
import { createProvider } from "./providers/llm.js";
import { ToolRegistry } from "./tools/registry.js";
import { filesystemTools } from "./tools/filesystem.js";
import { execTools } from "./tools/exec.js";
import { SkillStore, createSkillTools } from "./tools/skills.js";
import { runAgentGraph } from "./graph/agent-loop.js";
import { startGateway } from "./gateway/server.js";
import { resolve } from "node:path";

async function initializeTools(): Promise<ToolRegistry> {
    const registry = new ToolRegistry();

    // Register filesystem tools (deepagents-style)
    for (const tool of filesystemTools) {
        registry.register(tool);
    }

    // Register exec tool
    for (const tool of execTools) {
        registry.register(tool);
    }

    // Load and register skills (openclaw-style)
    const skillStore = new SkillStore();
    // Check for skills in common locations
    skillStore.addDirectory(resolve(process.cwd(), "skills"));
    skillStore.addDirectory(resolve(process.cwd(), "../openclaw-main/skills"));
    await skillStore.loadAll();

    const skillTools = createSkillTools(skillStore);
    for (const tool of skillTools) {
        registry.register(tool);
    }

    const skills = skillStore.list();
    if (skills.length > 0) {
        console.log(`   Skills loaded: ${skills.length} (${skills.map((s) => s.name).join(", ")})`);
    }

    return registry;
}

async function main() {
    const config = loadConfig();
    const llm = createProvider(config);
    const tools = await initializeTools();
    const activeModel = config.provider === "openai" ? config.openaiModel : config.geminiModel;

    console.log(`\n🦞 ClawAgents Engine v1.0`);
    console.log(`   Provider: ${llm.name} | Model: ${activeModel}`);
    console.log(`   Tools: ${tools.list().map((t) => t.name).join(", ")}`);

    // Check for --task flag for CLI mode
    const taskIdx = process.argv.indexOf("--task");
    if (taskIdx !== -1 && process.argv[taskIdx + 1]) {
        const task = process.argv[taskIdx + 1]!;

        const result = await runAgentGraph(task, llm, tools);
        console.log("\n━━━ Final Result ━━━");
        console.log(result.result);
        console.log(`━━━ Tool calls: ${result.toolCalls} | Iterations: ${result.iterations} ━━━\n`);
        process.exit(0);
    }

    // Default: start gateway server
    startGateway(3000);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
