/**
 * Benchmark: ClawAgents vs DeepAgents (TypeScript)
 * 5 tasks × 2 models × 2 frameworks = 20 trials
 */

import { config } from "dotenv";
import { writeFileSync } from "fs";
import { resolve } from "path";

// Load .env from project root (parent dir)
config({ path: resolve(process.cwd(), "../.env") });
config(); // also try local .env

// LangChain uses GOOGLE_API_KEY, our .env uses GEMINI_API_KEY
if (process.env["GEMINI_API_KEY"] && !process.env["GOOGLE_API_KEY"]) {
    process.env["GOOGLE_API_KEY"] = process.env["GEMINI_API_KEY"];
}

const TASKS = [
    { name: "file_listing", prompt: "List all files in the current directory and tell me how many there are." },
    { name: "read_analyze", prompt: "Read the file .env and tell me what provider is configured and what model names are set." },
    { name: "write_file", prompt: "Create a file called benchmark_test.txt with the content 'Hello from benchmark' and confirm it was created." },
    { name: "multi_step", prompt: "List the current directory, then read .env file, and create a summary.md file that lists the files and the provider from .env." },
    { name: "reasoning", prompt: "What is 17 * 23 + 42 - 15? Show your work and give the final answer." },
];

const MODELS = [
    { name: "gemini-2.5-flash", provider: "gemini" },
    { name: "gpt-5-mini", provider: "openai" },
];

interface BenchResult {
    framework: string; model: string; task: string; success: boolean;
    wall_time: number; tool_calls: number; iterations: number;
    result: string; error: string;
}

// ─── ClawAgents TS ────────────────────────────────────────────────────────

async function runClawagents(prompt: string, modelName: string): Promise<BenchResult> {
    const { createClawAgent } = await import("./src/agent.js");
    const t0 = performance.now();
    try {
        const agent = await createClawAgent({ model: modelName, streaming: false, onEvent: () => { } });
        const state = await agent.invoke(prompt, 10);
        const elapsed = (performance.now() - t0) / 1000;
        return {
            framework: "clawagents_ts", model: modelName, task: "", success: state.status === "done",
            wall_time: elapsed, tool_calls: state.toolCalls, iterations: state.iterations,
            result: (state.result || "").slice(0, 200), error: ""
        };
    } catch (err: any) {
        return {
            framework: "clawagents_ts", model: modelName, task: "", success: false,
            wall_time: (performance.now() - t0) / 1000, tool_calls: 0, iterations: 0,
            result: "", error: String(err).slice(0, 200)
        };
    }
}

// ─── DeepAgents TS ────────────────────────────────────────────────────────

async function runDeepagents(prompt: string, modelName: string, provider: string): Promise<BenchResult> {
    const deepagentsPath = resolve(process.cwd(), "../deepagentsjs-main/libs/deepagents/src/index.js");
    const { createDeepAgent } = await import(deepagentsPath);
    const { HumanMessage } = await import("@langchain/core/messages");
    const t0 = performance.now();
    try {
        let model: any;
        if (provider === "openai") {
            const { ChatOpenAI } = await import("@langchain/openai");
            model = new ChatOpenAI({ model: modelName });
        } else {
            const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai");
            model = new ChatGoogleGenerativeAI({ model: modelName });
        }
        const agent = createDeepAgent({ model });
        const result = await agent.invoke(
            { messages: [new HumanMessage(prompt)] },
            { recursionLimit: 50 },
        );
        const elapsed = (performance.now() - t0) / 1000;
        const messages = result.messages || [];
        const lastMsg = messages[messages.length - 1];
        const content = typeof lastMsg?.content === "string" ? lastMsg.content : JSON.stringify(lastMsg?.content);
        const toolCalls = messages.filter((m: any) => m.tool_calls?.length > 0).length;
        return {
            framework: "deepagents_ts", model: modelName, task: "", success: true,
            wall_time: elapsed, tool_calls: toolCalls, iterations: messages.length,
            result: (content || "").slice(0, 200), error: ""
        };
    } catch (err: any) {
        return {
            framework: "deepagents_ts", model: modelName, task: "", success: false,
            wall_time: (performance.now() - t0) / 1000, tool_calls: 0, iterations: 0,
            result: "", error: String(err).slice(0, 200)
        };
    }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
    const results: BenchResult[] = [];
    console.log("=".repeat(80));
    console.log("  BENCHMARK: ClawAgents vs DeepAgents (TypeScript)");
    console.log("=".repeat(80));

    for (const m of MODELS) {
        console.log(`\n${"─".repeat(60)}\n  MODEL: ${m.name} (${m.provider})\n${"─".repeat(60)}`);
        for (const task of TASKS) {
            // ClawAgents
            process.stdout.write(`\n  [${m.name}] ${task.name} — clawagents_ts ...`);
            const r1 = await runClawagents(task.prompt, m.name);
            r1.task = task.name; results.push(r1);
            console.log(` ${r1.success ? "✓" : "✗"} ${r1.wall_time.toFixed(1)}s, ${r1.tool_calls} tools${r1.error ? " ERR: " + r1.error.slice(0, 60) : ""}`);

            // DeepAgents
            process.stdout.write(`  [${m.name}] ${task.name} — deepagents_ts  ...`);
            const r2 = await runDeepagents(task.prompt, m.name, m.provider);
            r2.task = task.name; results.push(r2);
            console.log(` ${r2.success ? "✓" : "✗"} ${r2.wall_time.toFixed(1)}s, ${r2.tool_calls} tools${r2.error ? " ERR: " + r2.error.slice(0, 60) : ""}`);
        }
    }

    // Summary table
    console.log("\n" + "=".repeat(80) + "\n  RESULTS SUMMARY\n" + "=".repeat(80));
    console.log(`${"Framework".padEnd(18)} ${"Model".padEnd(20)} ${"Task".padEnd(15)} ${"OK?".padEnd(5)} ${"Time".padEnd(8)} ${"Tools".padEnd(7)}`);
    console.log("-".repeat(75));
    for (const r of results) {
        console.log(`${r.framework.padEnd(18)} ${r.model.padEnd(20)} ${r.task.padEnd(15)} ${(r.success ? "✓" : "✗").padEnd(5)} ${r.wall_time.toFixed(1).padStart(5)}s  ${String(r.tool_calls).padEnd(7)}`);
    }

    // Averages
    console.log(`\n${"─".repeat(60)}\n  AVERAGES\n${"─".repeat(60)}`);
    for (const fw of ["clawagents_ts", "deepagents_ts"]) {
        for (const m of MODELS) {
            const s = results.filter(r => r.framework === fw && r.model === m.name);
            if (!s.length) continue;
            const avg = s.reduce((a, r) => a + r.wall_time, 0) / s.length;
            const tools = s.reduce((a, r) => a + r.tool_calls, 0) / s.length;
            const ok = s.filter(r => r.success).length;
            console.log(`  ${fw.padEnd(18)} ${m.name.padEnd(20)} avg=${avg.toFixed(1)}s  tools=${tools.toFixed(1)}  success=${ok}/${s.length}`);
        }
    }

    writeFileSync(resolve(process.cwd(), "benchmark_results_ts.json"), JSON.stringify(results, null, 2));
    console.log(`\n  Saved to benchmark_results_ts.json`);
}

main().catch(err => { console.error(`\n❌ ${err}`); process.exit(1); });
