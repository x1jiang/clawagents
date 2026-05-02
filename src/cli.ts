#!/usr/bin/env node
/**
 * ClawAgents CLI entrypoint.
 *
 * Public API symbols live in `./index.ts`. This file owns the runtime
 * (banner, doctor, trajectory, gateway, --task) so that
 * `import "clawagents"` from a Node app does not start a server as a
 * side-effect.
 *
 * Usage:
 *   npx tsx src/cli.ts                       # Start gateway server
 *   npx tsx src/cli.ts --task "..."          # Run a single task from CLI
 *   npx tsx src/cli.ts --doctor              # Check configuration health
 *   npx tsx src/cli.ts --trajectory [N]      # Inspect last N run summaries
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig, getDefaultModel, resolvedEnvFile } from "./config/config.js";
import { createClawAgent } from "./agent.js";
import { startGateway } from "./gateway/server.js";
import { detectChannels } from "./channels/auto.js";

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

    const config = loadConfig();

    if (resolvedEnvFile) {
        check(".env file", true, resolvedEnvFile);
    } else {
        check(".env file", false, "not found in cwd or parent");
        issues++;
    }
    const hasOpenai = !!config.openaiApiKey;
    const hasGemini = !!config.geminiApiKey;
    const hasBaseUrl = !!config.openaiBaseUrl;

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

    if (hasOpenai || hasGemini || hasBaseUrl) {
        const model = getDefaultModel(config);
        const provider = process.env["PROVIDER"] ?? "auto-detect";
        check("Active model", true, `provider=${provider}  model=${model}`);
    } else {
        check("Active model", false, "no API key or base_url configured");
        issues++;
    }

    if (hasBaseUrl) {
        check("Custom endpoint", true, config.openaiBaseUrl);
        if (config.openaiApiVersion) {
            check("Azure API version", true, config.openaiApiVersion);
        }
    }

    process.stderr.write(`\n  LLM Settings:\n`);
    process.stderr.write(`    maxTokens=${config.maxTokens}  temperature=${config.temperature}  contextWindow=${config.contextWindow}  streaming=${config.streaming}\n`);

    const traj = ["1", "true", "yes"].includes(process.env["CLAW_TRAJECTORY"]?.toLowerCase() ?? "");
    const rethink = ["1", "true", "yes"].includes(process.env["CLAW_RETHINK"]?.toLowerCase() ?? "");
    const learn = ["1", "true", "yes"].includes(process.env["CLAW_LEARN"]?.toLowerCase() ?? "");
    const maxIter = process.env["MAX_ITERATIONS"] ?? "200";

    process.stderr.write(`\n  PTRL: trajectory=${traj ? "on" : "off"}  rethink=${rethink ? "on" : "off"}  learn=${learn ? "on" : "off"}  max_iterations=${maxIter}\n`);

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

    const runsFile = resolve(process.cwd(), ".clawagents", "trajectories", "runs.jsonl");
    if (existsSync(runsFile)) {
        const lineCount = readFileSync(runsFile, "utf-8").trim().split("\n").length;
        check("Trajectory history", true, `${lineCount} runs in ${runsFile}`);
    } else if (traj) {
        check("Trajectory history", true, "enabled but no runs yet");
    } else {
        check("Trajectory history", true, "disabled (set CLAW_TRAJECTORY=1 to enable)");
    }

    const agentsMd = resolve(process.cwd(), "AGENTS.md");
    if (existsSync(agentsMd)) {
        const size = readFileSync(agentsMd).length;
        check("AGENTS.md", true, `${size} bytes`);
    } else {
        check("AGENTS.md", true, "not found (optional)");
    }

    const detected = detectChannels();
    if (detected.length > 0) {
        check("Messaging channels", true, detected.map(c => c.description).join(", "));
    } else {
        check("Messaging channels", true, "none configured (set TELEGRAM_BOT_TOKEN, WHATSAPP_AUTH_DIR, or SIGNAL_ACCOUNT)");
    }

    const catalog = await buildBuiltinToolCatalog();
    check("Tool catalog", catalog.length > 0, `${catalog.length} built-in tools inspectable`);

    process.stderr.write("\n" + "=".repeat(40) + "\n");
    if (issues === 0) {
        process.stderr.write("✓ All checks passed. Ready to run.\n\n");
    } else {
        process.stderr.write(`✗ ${issues} issue(s) found. Fix the items above.\n\n`);
    }
}

async function buildBuiltinToolCatalog() {
    const { ToolRegistry } = await import("./tools/registry.js");
    const { LocalBackend } = await import("./sandbox/local.js");
    const { createFilesystemTools } = await import("./tools/filesystem.js");
    const { createExecTools } = await import("./tools/exec.js");
    const { createAdvancedFsTools } = await import("./tools/advanced-fs.js");
    const { webTools } = await import("./tools/web.js");
    const { todolistTools } = await import("./tools/todolist.js");
    const { thinkTools } = await import("./tools/think.js");
    const { interactiveTools } = await import("./tools/interactive.js");
    const { createToolProgramTool } = await import("./tools/tool-program.js");
    const { createBackgroundTaskTools } = await import("./tools/background-task.js");

    const sb = new LocalBackend();
    const registry = new ToolRegistry();
    for (const tool of [
        ...todolistTools,
        ...thinkTools,
        ...interactiveTools,
        ...createFilesystemTools(sb),
        ...createExecTools(sb),
        ...createAdvancedFsTools(sb),
        ...webTools.filter((t) => t.name === "web_fetch"),
        ...createBackgroundTaskTools(),
    ]) {
        registry.register(tool);
    }
    registry.register(createToolProgramTool(registry));
    return registry.inspectTools();
}

async function cmdTools(json = false) {
    const catalog = await buildBuiltinToolCatalog();
    if (json) {
        process.stdout.write(JSON.stringify(catalog, null, 2) + "\n");
        return;
    }
    for (const tool of catalog) {
        const params = Object.entries(tool.parameters)
            .map(([name, spec]) => `${name}${spec.required ? "*" : ""}`)
            .join(", ");
        process.stdout.write(`${tool.name}${params ? ` (${params})` : ""} — ${tool.description}\n`);
    }
}

async function cmdDryRun(task = "", profile?: string, json = false) {
    const { buildDryRunPreview } = await import("./dry-run.js");
    const preview = await buildDryRunPreview({ task, profile });
    if (json) {
        process.stdout.write(JSON.stringify(preview, null, 2) + "\n");
        return;
    }
    process.stdout.write(`Dry run: ${preview.status}\n`);
    process.stdout.write(`Provider: profile=${preview.provider.profile ?? "none"} provider=${preview.provider.provider} model=${preview.provider.model ?? ""}\n`);
    process.stdout.write(`Auth: ${preview.provider.auth}  Base URL: ${preview.provider.baseUrl || "default"}\n`);
    process.stdout.write(`Tools: ${preview.toolCount} inspectable\n`);
    process.stdout.write(`Likely tools: ${preview.matchingTools.join(", ")}\n`);
    process.stdout.write(`Next actions: ${preview.nextActions.join("; ")}\n`);
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

    if (args.includes("--doctor")) {
        await cmdDoctor();
        return;
    }

    if (args.includes("--tools")) {
        await cmdTools(args.includes("--json"));
        return;
    }

    const profileIdx = args.indexOf("--profile");
    const profile = profileIdx >= 0 && profileIdx + 1 < args.length ? args[profileIdx + 1] : undefined;

    const trajIdx = args.indexOf("--trajectory");
    if (trajIdx !== -1) {
        const n = trajIdx + 1 < args.length && !args[trajIdx + 1]!.startsWith("--")
            ? parseInt(args[trajIdx + 1]!, 10) || 1
            : 1;
        cmdTrajectory(n);
        return;
    }

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

    if (args.includes("--sessions")) {
        const { listSessions } = await import("./session/persistence.js");
        const sessions = listSessions(20);
        if (sessions.length === 0) {
            console.log("No saved sessions found.");
            console.log("Enable session persistence: CLAW_FEATURE_SESSION_PERSISTENCE=1");
        } else {
            console.log(`${"Session ID".padEnd(35)} ${"Turns".padStart(5)}  ${"Status".padEnd(10)}  Task`);
            console.log("-".repeat(90));
            for (const s of sessions) {
                console.log(`${s.sessionId.padEnd(35)} ${String(s.turnCount).padStart(5)}  ${s.status.padEnd(10)}  ${s.task.slice(0, 40)}`);
            }
        }
        return;
    }

    const resumeIdx = args.indexOf("--resume");
    if (resumeIdx !== -1) {
        const { listSessions, SessionReader } = await import("./session/persistence.js");
        let sessionId = resumeIdx + 1 < args.length && !args[resumeIdx + 1]!.startsWith("--")
            ? args[resumeIdx + 1]!
            : "latest";
        let sessionPath: string;

        if (sessionId === "latest") {
            const sessions = listSessions(1);
            if (sessions.length === 0) { console.error("No sessions found to resume."); process.exit(1); }
            sessionId = sessions[0]!.sessionId;
            sessionPath = sessions[0]!.path;
        } else {
            sessionPath = resolve(process.cwd(), ".clawagents", "sessions", `${sessionId}.jsonl`);
            if (!existsSync(sessionPath)) { console.error(`Session file not found: ${sessionPath}`); process.exit(1); }
        }

        const reader = new SessionReader(sessionPath);
        const task = reader.getTask();
        process.stderr.write(`Resuming session ${sessionId} (${reader.events.length} events, task: ${task.slice(0, 60)})\n`);

        const config = loadConfig();
        const activeModel = getDefaultModel(config);
        const agent = await createClawAgent({ model: activeModel, streaming: config.streaming });
        const result = await agent.invoke(`[Resumed session] Continue from where you left off. Original task: ${task}`);
        if (result.result) process.stdout.write(result.result + "\n");
        return;
    }

    const verbose = args.includes("--verbose") || args.includes("-v");
    const quiet = args.includes("--quiet") || args.includes("-q");

    const timeoutIdx = args.indexOf("--timeout");
    const timeoutS = timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1] ?? "0", 10) : 0;

    let advisorModel: string | undefined;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--advisor" && i + 1 < args.length) {
            advisorModel = args[i + 1]!;
            break;
        } else if (args[i]?.startsWith("--advisor=")) {
            advisorModel = args[i]!.substring(10);
            break;
        }
    }

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

    if (args.includes("--dry-run")) {
        await cmdDryRun(task, profile, args.includes("--json"));
        return;
    }

    if (task) {
        const banner = buildBanner();
        const config = loadConfig();
        const activeModel = getDefaultModel(config);
        const agent = await createClawAgent({
            model: activeModel,
            profile,
            streaming: config.streaming,
            timeoutS,
            advisorModel: advisorModel ?? (config.advisorModel || undefined),
        });
        const toolCount = agent.tools.list().length;
        if (!quiet) process.stderr.write(`${banner} | ${toolCount} tools\n`);
        if (verbose) process.stderr.write(`[verbose] timeout=${timeoutS}s model=${activeModel}${agent.advisorLLM ? ` advisor=${advisorModel || config.advisorModel}` : ""}\n`);
        await agent.invoke(task);
        process.exit(0);
    }

    let port = 3000;
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && portIdx + 1 < args.length) {
        port = parseInt(args[portIdx + 1]!, 10) || 3000;
    }

    if (args.includes("--help") || args.includes("-h")) {
        process.stderr.write(`
ClawAgents — lean, full-stack agentic AI framework

Usage:
  clawagents --task "..."              Run a single task
  clawagents --dry-run --task "..."    Preview runtime readiness without model/tool execution
  clawagents --doctor                  Check configuration health
  clawagents --tools [--json]          Inspect built-in tool schemas
  clawagents --trajectory [N]          Show last N run summaries (default: 1)
  clawagents --prune-trajectories [N]  Delete trajectory files older than N days (default: 30)
  clawagents --sessions                List saved sessions
  clawagents --resume [ID|latest]      Resume a saved session
  clawagents --port 8080               Start gateway server on custom port
  clawagents                           Start gateway server (port 3000)

Options:
  --verbose, -v       Verbose output
  --quiet, -q         Quiet mode (suppress banner)
  --timeout N         Global timeout in seconds (0 = no limit)
  --advisor MODEL     Stronger model for strategic guidance (e.g. gpt-5.4, claude-opus-4-6)
  --profile NAME      Named provider profile (e.g. openai, gemini, anthropic, ollama)

Quick start:
  npm install clawagents
  cp .env.example .env
  # Edit .env with your API key
  clawagents --task "List all files"
`);
        return;
    }

    const banner = buildBanner();
    process.stderr.write(`${banner} | gateway on port ${port}\n`);
    await startGateway(port);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
