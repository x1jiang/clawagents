/**
 * Prompt-Time Reinforcement Learning (PTRL) — lesson extraction & injection.
 *
 * Three layers that create a feedback loop without model fine-tuning:
 *
 *   1. Post-run self-analysis: After a run completes, the LLM reviews its own
 *      trajectory and extracts actionable lessons. Stored in .clawagents/lessons.md.
 *
 *   2. Pre-run lesson injection: Before a new run starts, any existing lessons
 *      are loaded and prepended to the system prompt.
 *
 *   3. Enhanced mid-run rethink: When consecutive failures are detected,
 *      relevant lessons are injected alongside the generic rethink prompt.
 *
 * Controlled by the CLAW_LEARN flag (or learn: true in createClawAgent).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { LLMProvider, LLMMessage } from "../providers/llm.js";
import type { RunSummary, TurnRecord } from "./recorder.js";

function getClawagentsDir(): string {
    return resolve(process.cwd(), ".clawagents");
}

function getLessonsFile(): string {
    return resolve(getClawagentsDir(), "lessons.md");
}
const MAX_LESSONS_CHARS = 4000;
const MAX_LESSONS_LINES = 250;

const SELF_ANALYSIS_PROMPT = `You are reviewing your own agent run trajectory. Analyze the run and extract \
concise, actionable lessons.

## Run Summary
- Task: {task}
- Task type: {taskType}
- Outcome: {outcome}
- Finish reason: {finishReason}
- Run score: {runScore}/3  (3=clean, 2=efficient, 1=messy success, 0=ambiguous, -1=failed)
- Quality: {quality}
- Verified score: {verifiedScore} (objective, from tool outputs; confidence={verifiedConfidence}, method={verifiedMethod})
- Total turns: {totalTurns}
- Mid-run failures: {midRunFailures}
- Format errors: {formatFailures} (bad JSON, wrong params, unknown tools)
- Logic errors: {logicFailures} (valid calls, wrong approach)
- Duration: {durationS}s

## Key Turns (failures and pivots)
{keyTurns}

## Instructions
Based on this trajectory:
1. What went wrong? (specific tool failures, bad strategies, repeated mistakes)
2. Were failures FORMAT errors (fixable by correcting syntax) or LOGIC errors (need new strategy)?
3. What worked? (successful approaches, efficient patterns)
4. What should the agent do differently next time?
5. If the verified score differs from the self-assessed run score, explain why (the verified score is objective ground truth from actual tool outputs).

Respond with a markdown list of 2-5 concise lessons. Each lesson should be a \
single line starting with "- ". Focus on ACTIONABLE advice, not vague platitudes.

Example format:
- When file X doesn't exist, check parent directory first instead of retrying the same path
- Use grep to search before attempting to read large files
- Prefer execute_command over write_file+execute for one-off scripts
`;

function extractKeyTurns(turns: TurnRecord[], maxTurns = 10): string {
    if (turns.length === 0) return "(no turns recorded)";

    const key: TurnRecord[] = [];
    let prevScore = 0;
    for (const t of turns) {
        const isFailure = t.score < 0;
        const isPivot = (t.score > 0 && prevScore < 0) || (t.score < 0 && prevScore > 0);
        if (isFailure || isPivot) key.push(t);
        prevScore = t.score;
    }
    if (turns[0] && !key.includes(turns[0])) key.unshift(turns[0]);
    if (turns[turns.length - 1] && !key.includes(turns[turns.length - 1])) key.push(turns[turns.length - 1]);

    const selected = key.slice(0, maxTurns);
    const lines: string[] = [];
    for (const t of selected) {
        const callsInfo: string[] = [];
        for (const tc of t.toolCalls) {
            const status = tc.success ? "OK" : "FAIL";
            const ftTag = tc.failureType && !tc.success ? ` [${tc.failureType}]` : "";
            const preview = (tc.outputPreview || "").slice(0, 80);
            callsInfo.push(`  - [${status}${ftTag}] ${tc.toolName}: ${preview}`);
        }
        const resp = (t.responseText || "").slice(0, 200);
        const obs = (t.observationContext || "").slice(0, 150);
        lines.push(`### Turn ${t.turnIndex} (score=${t.score}, productivity=${t.productivityScore})`);
        if (obs) lines.push(`Context: ${obs}`);
        if (resp) lines.push(`Response: ${resp}`);
        if (callsInfo.length) lines.push(callsInfo.join("\n"));
    }
    return lines.length ? lines.join("\n") : "(no key turns)";
}

export async function extractLessons(
    llm: LLMProvider,
    summary: RunSummary,
    turns: TurnRecord[],
): Promise<string | null> {
    const keyTurns = extractKeyTurns(turns);
    const vScore = summary.verifiedScore;
    const prompt = SELF_ANALYSIS_PROMPT
        .replace("{task}", summary.task)
        .replace("{taskType}", (summary as any).taskType ?? "general")
        .replace("{outcome}", summary.outcome)
        .replace("{finishReason}", summary.finishReason ?? "unknown")
        .replace("{runScore}", String(summary.runScore))
        .replace("{quality}", summary.quality)
        .replace("{verifiedScore}", vScore != null ? vScore.toFixed(2) : "N/A")
        .replace("{verifiedConfidence}", (summary as any).verifiedConfidence ?? "N/A")
        .replace("{verifiedMethod}", (summary as any).verifiedMethod ?? "N/A")
        .replace("{totalTurns}", String(summary.totalTurns))
        .replace("{midRunFailures}", String(summary.midRunFailures))
        .replace("{formatFailures}", String(summary.formatFailures ?? 0))
        .replace("{logicFailures}", String(summary.logicFailures ?? 0))
        .replace("{durationS}", String(summary.durationS))
        .replace("{keyTurns}", keyTurns);

    try {
        const messages: LLMMessage[] = [
            { role: "system", content: "You are a self-improvement analyst for an AI coding agent." },
            { role: "user", content: prompt },
        ];
        const response = await llm.chat(messages);
        return response.content?.trim() || null;
    } catch {
        return null;
    }
}

// ─── Feature 1: Quality Gate ─────────────────────────────────────────────────

export function shouldExtractLessons(summary: RunSummary): boolean {
    const { quality, runScore, hasMixedOutcomes, midRunFailures, totalTurns, verifiedScore } = summary;

    // Feature A: score disagreement is high signal
    if (verifiedScore != null) {
        const runNormalized = runScore / 3.0;
        if (Math.abs(runNormalized - verifiedScore) > 0.4) return true;
    }

    if (runScore <= -1 && totalTurns >= 3) return true;
    if (hasMixedOutcomes) return true;
    if (runScore >= 3 && midRunFailures === 0) return false;
    if (quality === "noisy") return true;
    if (runScore === 2 && midRunFailures > 0) return true;
    return false;
}

export function saveLessons(newLessons: string, task: string, outcome: string, model = ""): void {
    try {
        mkdirSync(getClawagentsDir(), { recursive: true });

        // Feature 2: tag with timestamp and model for staleness decay
        const ts = Math.floor(Date.now() / 1000);
        const modelTag = model ? ` [${model}]` : "";
        const header = `\n## Lessons from run (${outcome}) — ${task.slice(0, 80)}${modelTag} @${ts}\n`;
        const entry = header + newLessons.trim() + "\n";

        let existing = "";
        if (existsSync(getLessonsFile())) {
            existing = readFileSync(getLessonsFile(), "utf-8");
        }

        let combined = existing + "\n" + entry;
        let lines = combined.trim().split("\n");
        if (lines.length > MAX_LESSONS_LINES) {
            lines = lines.slice(-MAX_LESSONS_LINES);
        }
        const text = lines.join("\n");
        if (text.length > MAX_LESSONS_CHARS * 3) {
            const trimmed = text.slice(-(MAX_LESSONS_CHARS * 3));
            const nl = trimmed.indexOf("\n");
            writeFileSync(getLessonsFile(), (nl > 0 ? trimmed.slice(nl + 1) : trimmed) + "\n", "utf-8");
        } else {
            writeFileSync(getLessonsFile(), text + "\n", "utf-8");
        }
    } catch { /* best effort */ }
}

export function loadLessons(maxChars = MAX_LESSONS_CHARS, maxAgeS = 0): string {
    try {
        if (!existsSync(getLessonsFile())) return "";
        let text = readFileSync(getLessonsFile(), "utf-8").trim();
        if (!text) return "";

        // Feature 2: filter by age if requested
        if (maxAgeS > 0) {
            const now = Math.floor(Date.now() / 1000);
            const cutoff = now - maxAgeS;
            const blocks = text.split(/(?=\n## Lessons from run)/);
            const fresh = blocks.filter((block) => {
                const tsMatch = block.match(/@(\d{10,})/);
                if (tsMatch) {
                    return parseInt(tsMatch[1]!, 10) >= cutoff;
                }
                return true;
            });
            text = fresh.join("\n").trim();
            if (!text) return "";
        }

        if (text.length > maxChars) {
            text = text.slice(-maxChars);
            const nl = text.indexOf("\n");
            if (nl > 0) text = text.slice(nl + 1);
        }
        return text;
    } catch {
        return "";
    }
}

export function buildLessonPreamble(): string {
    const lessons = loadLessons();
    if (!lessons) return "";
    return (
        "\n\n## Lessons from Past Runs\n" +
        "These lessons were extracted from previous agent runs. " +
        "Apply them to avoid repeating past mistakes:\n\n" +
        lessons + "\n"
    );
}

export function buildRethinkWithLessons(
    genericRethink: string,
    formatFailureCount = 0,
    logicFailureCount = 0,
): string {
    const parts = [genericRethink];

    // Feature 3: format-specific guidance
    if (formatFailureCount > 0 && formatFailureCount >= logicFailureCount) {
        parts.push(
            "\n\n## Format Error Guidance\n" +
            "Your recent tool call failures are FORMAT errors (bad JSON, wrong parameter " +
            "names, unknown tools). Before retrying:\n" +
            "- Check that tool names match exactly (case-sensitive)\n" +
            "- Ensure all required parameters are provided\n" +
            "- Verify JSON syntax is valid (matching braces, quoted strings)\n" +
            "- Review the tool descriptions above for correct parameter names"
        );
    } else if (logicFailureCount > 0) {
        parts.push(
            "\n\n## Strategy Guidance\n" +
            "Your recent failures are LOGIC errors (correct tool calls, wrong approach). " +
            "The tools work but your strategy needs adjustment. " +
            "Try a fundamentally different approach."
        );
    }

    const lessons = loadLessons(1500);
    if (lessons) {
        parts.push(
            "\n\n## Relevant Lessons from Past Runs\n" +
            "Consider these lessons from previous runs:\n\n" +
            lessons
        );
    }

    return parts.join("\n");
}

export function exportLessons(outputPath?: string): string {
    const lessons = loadLessons(999999);
    const path = outputPath ?? resolve(getClawagentsDir(), "lessons_export.json");
    mkdirSync(dirname(path), { recursive: true });
    const data = {
        version: 1,
        exported_at: Math.floor(Date.now() / 1000),
        lessons_md: lessons,
    };
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
    return path;
}

export function importLessons(inputPath: string): boolean {
    try {
        const data = JSON.parse(readFileSync(inputPath, "utf-8"));
        if (data.version !== 1 || !data.lessons_md) {
            console.error("Invalid lessons export format");
            return false;
        }
        mkdirSync(getClawagentsDir(), { recursive: true });
        const lessonsFile = getLessonsFile();
        let existing = "";
        try { existing = readFileSync(lessonsFile, "utf-8"); } catch { /* new file */ }
        const combined = existing + "\n\n## Imported Lessons\n" + data.lessons_md;
        writeFileSync(lessonsFile, combined.trim() + "\n", "utf-8");
        return true;
    } catch {
        return false;
    }
}
