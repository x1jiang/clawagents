#!/usr/bin/env node
/**
 * ClawAgents — Backend engine combining openclaw resilience with deepagents reasoning.
 *
 * Usage:
 *   npx tsx src/index.ts                      # Start gateway server
 *   npx tsx src/index.ts --task "..."         # Run a single task from CLI
 *   npx tsx src/index.ts --doctor             # Check configuration health
 *   npx tsx src/index.ts --trajectory [N]     # Inspect last N run summaries
 */

import { loadConfig, getDefaultModel, resolvedEnvFile } from "./config/config.js";
import { createClawAgent } from "./agent.js";
import { startGateway } from "./gateway/server.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Re-export public API
export { createClawAgent, ClawAgent, LangChainToolAdapter } from "./agent.js";
export type { AgentState, OnEvent, EventKind, BeforeLLMHook, BeforeToolHook, AfterToolHook } from "./graph/agent-loop.js";
export type { Tool, ToolResult, ToolRegistry } from "./tools/registry.js";
export type { LLMProvider, LLMMessage, LLMResponse } from "./providers/llm.js";
export { TrajectoryRecorder, classifyFailure, pruneTrajectories } from "./trajectory/recorder.js";
export type { TurnRecord, RunSummary, ToolCallRecord } from "./trajectory/recorder.js";
export {
    extractLessons, saveLessons, loadLessons,
    buildLessonPreamble, buildRethinkWithLessons,
    shouldExtractLessons,
    exportLessons, importLessons,
} from "./trajectory/lessons.js";
export {
    computeDeterministicScore,
    detectTaskType,
    verifyTaskOutcome,
    computeAdaptiveRethinkThreshold,
} from "./trajectory/verifier.js";
export { compareSamples } from "./trajectory/compare.js";
export { judgeRun } from "./trajectory/judge.js";
export type { JudgeResult } from "./trajectory/judge.js";
export { stripThinkingTokens } from "./providers/llm.js";

// ─── Banner ──────────────────────────────────────────────────────────────

function buildBanner(): string {
    const config = loadConfig();
    const model = getDefaultModel(config);
    const provider = process.env["PROVIDER"] ?? "auto";
    const envSrc = resolvedEnvFile ?? "none";

    const flags: string[] = [];
    if (["1", "true", "yes"].includes(process.env["CLAW_LEARN"]?.toLowerCase() ?? "")) flags.push("learn");
    if (["1", "true", "yes"].includes(process.env["CLAW_RETHINK"]?.toLowerCase() ?? "")) flags.push("rethink");
    if (["1", "true", "yes"].includes(process.env["CLAW_TRAJECTORY"]?.toLowerCase() ?? "")) flags.push("trajectory");
    const flagStr = flags.length ? flags.join("+") : "none";

    return `ClawAgents | provider=${provider} model=${model} env=${envSrc} ptrl=${flagStr}`;
}

// ─── Doctor ──────────────────────────────────────────────────────────────

function check(label: string, ok: boolean, detail = ""): boolean {
    const mark = ok ? "✓" : "✗";
    let msg = `  ${mark} ${label}`;
    if (detail) msg += ` — ${detail}`;
    process.stderr.write(msg + "\n");
    return ok;
}

async function cmdDoctor() {
    process.stderr.write("\nClawAgents Doctor\n" + "=".repeat(40) + "\n\n");
    let issues = 0;

    // 1. .env file
    if (resolvedEnvFile) {
        check(".env file", true, resolvedEnvFile);
    } else {
        check(".env file", false, "not found in cwd or parent");
        issues++;
    }

    // 2. Load config
    const config = loadConfig();
    const hasOpenai = !!config.openaiApiKey;
    const hasGemini = !!config.geminiApiKey;
    const hasBaseUrl = !!config.openaiBaseUrl;

    // 3. API keys
    if (hasOpenai) {
        check("OpenAI API key", true, config.openaiApiKey.slice(0, 8) + "...");
    } else if (hasBaseUrl) {
        check("OpenAI API key", true, "not needed (baseUrl set for local model)");
    } else {
        check("OpenAI API key", false, "OPENAI_API_KEY not set");
        issues++;
    }

    if (hasGemini) {
        check("Gemini API key", true, config.geminiApiKey.slice(0, 8) + "...");
    } else {
        check("Gemini API key", false, "GEMINI_API_KEY not set");
        if (!hasOpenai && !hasBaseUrl) issues++;
    }

    // 4. Active model
    if (hasOpenai || hasGemini || hasBaseUrl) {
        const model = getDefaultModel(config);
        const provider = process.env["PROVIDER"] ?? "auto-detect";
        check("Active model", true, `provider=${provider}  model=${model}`);
    } else {
        check("Active model", false, "no API key or base_url configured");
        issues++;
    }

    // 5. Custom endpoint
    if (hasBaseUrl) {
        check("Custom endpoint", true, config.openaiBaseUrl);
        if (config.openaiApiVersion) {
            check("Azure API version", true, config.openaiApiVersion);
        }
    }

    // 6. LLM settings
    process.stderr.write(`\n  LLM Settings:\n`);
    process.stderr.write(`    maxTokens=${config.maxTokens}  temperature=${config.temperature}  contextWindow=${config.contextWindow}  streaming=${config.streaming}\n`);

    // 7. PTRL flags
    const traj = ["1", "true", "yes"].includes(process.env["CLAW_TRAJECTORY"]?.toLowerCase() ?? "");
    const rethink = ["1", "true", "yes"].includes(process.env["CLAW_RETHINK"]?.toLowerCase() ?? "");
    const learn = ["1", "true", "yes"].includes(process.env["CLAW_LEARN"]?.toLowerCase() ?? "");
    const maxIter = process.env["MAX_ITERATIONS"] ?? "200";

    process.stderr.write(`\n  PTRL: trajectory=${traj ? "on" : "off"}  rethink=${rethink ? "on" : "off"}  learn=${learn ? "on" : "off"}  max_iterations=${maxIter}\n`);

    // 8. Local endpoint reachability
    if (hasBaseUrl && (config.openaiBaseUrl.includes("localhost") || config.openaiBaseUrl.includes("127.0.0.1"))) {
        try {
            const url = config.openaiBaseUrl.replace(/\/$/, "") + "/models";
            const resp = await fetch(url, {
                headers: { "Authorization": `Bearer ${config.openaiApiKey || "not-needed"}` },
                signal: AbortSignal.timeout(3000),
            });
            check("Local endpoint reachable", resp.ok, url);
        } catch (e: any) {
            check("Local endpoint reachable", false, `${config.openaiBaseUrl} — ${e.message ?? e}`);
            issues++;
        }
    }

    // 9. Trajectory history
    const runsFile = resolve(process.cwd(), ".clawagents", "trajectories", "runs.jsonl");
    if (existsSync(runsFile)) {
        const lineCount = readFileSync(runsFile, "utf-8").trim().split("\n").length;
        check("Trajectory history", true, `${lineCount} runs in ${runsFile}`);
    } else if (traj) {
        check("Trajectory history", true, "enabled but no runs yet");
    } else {
        check("Trajectory history", true, "disabled (set CLAW_TRAJECTORY=1 to enable)");
    }

    // 10. AGENTS.md
    const agentsMd = resolve(process.cwd(), "AGENTS.md");
    if (existsSync(agentsMd)) {
        const size = readFileSync(agentsMd).length;
        check("AGENTS.md", true, `${size} bytes`);
    } else {
        check("AGENTS.md", true, "not found (optional)");
    }

    process.stderr.write("\n" + "=".repeat(40) + "\n");
    if (issues === 0) {
        process.stderr.write("✓ All checks passed. Ready to run.\n\n");
    } else {
        process.stderr.write(`✗ ${issues} issue(s) found. Fix the items above.\n\n`);
    }
}

// ─── Trajectory Inspector ────────────────────────────────────────────────

function cmdTrajectory(n: number = 1) {
    const runsFile = resolve(process.cwd(), ".clawagents", "trajectories", "runs.jsonl");
    if (!existsSync(runsFile)) {
        process.stderr.write("No trajectory data found.\n");
        process.stderr.write("Enable with: CLAW_TRAJECTORY=1 in .env or trajectory: true in createClawAgent()\n");
        return;
    }

    const lines = readFileSync(runsFile, "utf-8").trim().split("\n").filter(Boolean);
    if (!lines.length) {
        process.stderr.write("Trajectory file is empty — no runs recorded yet.\n");
        return;
    }

    const lastN = lines.slice(-n);
    for (let i = 0; i < lastN.length; i++) {
        let run: any;
        try { run = JSON.parse(lastN[i]!); } catch { continue; }

        const runId = (run.run_id ?? "?").slice(0, 12);
        const model = run.model ?? "?";
        const task = run.task ?? "?";
        const turns = run.total_turns ?? 0;
        const calls = run.total_tool_calls ?? 0;
        const score = run.run_score ?? "?";
        const quality = run.quality ?? "?";
        const duration = run.duration_s ?? 0;
        const successRate = run.tool_success_rate ?? 0;
        const judge = run.judge_score;
        const judgeText = run.judge_justification ?? "";
        const taskType = run.task_type ?? "";
        const fmtFail = run.format_failures ?? 0;
        const logicFail = run.logic_failures ?? 0;
        const verified = run.verified_score;

        if (lastN.length > 1) {
            process.stderr.write(`\n── Run ${i + 1}/${lastN.length} ──\n`);
        } else {
            process.stderr.write("\n── Latest Run ──\n");
        }

        process.stderr.write(`  Run ID:    ${runId}\n`);
        process.stderr.write(`  Model:     ${model}\n`);
        process.stderr.write(`  Task:      ${task.slice(0, 80)}${task.length > 80 ? "..." : ""}\n`);
        if (taskType) process.stderr.write(`  Type:      ${taskType}\n`);
        process.stderr.write(`  Duration:  ${duration.toFixed(1)}s\n`);
        process.stderr.write(`  Turns:     ${turns}  Tool calls: ${calls}  Success rate: ${(successRate * 100).toFixed(0)}%\n`);
        process.stderr.write(`  Score:     ${score}/3  Quality: ${quality}\n`);

        if (fmtFail || logicFail) {
            process.stderr.write(`  Failures:  format=${fmtFail}  logic=${logicFail}\n`);
        }
        if (verified != null) {
            process.stderr.write(`  Verified:  ${verified.toFixed(2)} (${run.verified_method ?? ""})\n`);
        }
        if (judge != null) {
            process.stderr.write(`  Judge:     ${judge}/3`);
            if (judgeText) process.stderr.write(` — ${judgeText.slice(0, 100)}`);
            process.stderr.write("\n");
        }
    }
    process.stderr.write("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv;

    // --doctor
    if (args.includes("--doctor")) {
        await cmdDoctor();
        return;
    }

    // --trajectory [N]
    const trajIdx = args.indexOf("--trajectory");
    if (trajIdx !== -1) {
        const n = trajIdx + 1 < args.length && !args[trajIdx + 1]!.startsWith("--")
            ? parseInt(args[trajIdx + 1]!, 10) || 1
            : 1;
        cmdTrajectory(n);
        return;
    }

    // --prune-trajectories N
    if (args.includes("--prune-trajectories")) {
        const idx = args.indexOf("--prune-trajectories");
        const days = parseInt(args[idx + 1] ?? "30", 10);
        const trajDir = resolve(process.cwd(), ".clawagents", "trajectories");
        if (!existsSync(trajDir)) {
            console.log("No trajectories directory found.");
            process.exit(0);
        }
        const cutoff = Date.now() - days * 86400000;
        const { readdirSync, statSync, unlinkSync } = await import("node:fs");
        let removed = 0;
        for (const f of readdirSync(trajDir)) {
            const path = resolve(trajDir, f);
            try {
                if (statSync(path).mtimeMs < cutoff) {
                    unlinkSync(path);
                    removed++;
                }
            } catch { /* skip */ }
        }
        console.log(`Pruned ${removed} trajectory file(s) older than ${days} days.`);
        process.exit(0);
    }

    // --verbose / -v and --quiet / -q
    const verbose = args.includes("--verbose") || args.includes("-v");
    const quiet = args.includes("--quiet") || args.includes("-q");

    // --timeout N
    const timeoutIdx = args.indexOf("--timeout");
    const timeoutS = timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1] ?? "0", 10) : 0;

    // --task "..."
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
        const banner = buildBanner();
        const config = loadConfig();
        const activeModel = getDefaultModel(config);
        const agent = await createClawAgent({ model: activeModel, streaming: config.streaming, timeoutS });
        const toolCount = agent.tools.list().length;
        if (!quiet) process.stderr.write(`${banner} | ${toolCount} tools\n`);
        if (verbose) process.stderr.write(`[verbose] timeout=${timeoutS}s model=${activeModel}\n`);
        await agent.invoke(task);
        process.exit(0);
    }

    // --port N
    let port = 3000;
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && portIdx + 1 < args.length) {
        port = parseInt(args[portIdx + 1]!, 10) || 3000;
    }

    // --help
    if (args.includes("--help") || args.includes("-h")) {
        process.stderr.write(`
ClawAgents — lean, full-stack agentic AI framework

Usage:
  npx tsx src/index.ts --task "..."              Run a single task
  npx tsx src/index.ts --doctor                  Check configuration health
  npx tsx src/index.ts --trajectory [N]          Show last N run summaries (default: 1)
  npx tsx src/index.ts --prune-trajectories [N]  Delete trajectory files older than N days (default: 30)
  npx tsx src/index.ts --port 8080               Start gateway server on custom port
  npx tsx src/index.ts                           Start gateway server (port 3000)

Options:
  --verbose, -v       Verbose output
  --quiet, -q         Quiet mode (suppress banner)
  --timeout N         Global timeout in seconds (0 = no limit)

Quick start:
  npm install git+https://github.com/x1jiang/clawagents.git
  cp .env.example .env
  # Edit .env with your API key
  npx tsx src/index.ts --task "List all files"
`);
        return;
    }

    // Default: start gateway
    const banner = buildBanner();
    process.stderr.write(`${banner} | gateway on port ${port}\n`);
    await startGateway(port);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
