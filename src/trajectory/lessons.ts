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
import { resolve } from "node:path";
import type { LLMProvider, LLMMessage } from "../providers/llm.js";
import type { RunSummary, TurnRecord } from "./recorder.js";

const CLAWAGENTS_DIR = resolve(process.cwd(), ".clawagents");
const LESSONS_FILE = resolve(CLAWAGENTS_DIR, "lessons.md");
const MAX_LESSONS_CHARS = 4000;
const MAX_LESSONS_LINES = 250;

const SELF_ANALYSIS_PROMPT = `You are reviewing your own agent run trajectory. Analyze the run and extract \
concise, actionable lessons.

## Run Summary
- Task: {task}
- Outcome: {outcome}
- Run score: {runScore}/3  (3=clean, 2=efficient, 1=messy success, 0=ambiguous, -1=failed)
- Quality: {quality}
- Total turns: {totalTurns}
- Mid-run failures: {midRunFailures}
- Duration: {durationS}s

## Key Turns (failures and pivots)
{keyTurns}

## Instructions
Based on this trajectory:
1. What went wrong? (specific tool failures, bad strategies, repeated mistakes)
2. What worked? (successful approaches, efficient patterns)
3. What should the agent do differently next time?

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
            const preview = (tc.outputPreview || "").slice(0, 80);
            callsInfo.push(`  - [${status}] ${tc.toolName}: ${preview}`);
        }
        const resp = (t.responseText || "").slice(0, 200);
        lines.push(`### Turn ${t.turnIndex} (score=${t.score})`);
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
    const prompt = SELF_ANALYSIS_PROMPT
        .replace("{task}", summary.task)
        .replace("{outcome}", summary.outcome)
        .replace("{runScore}", String(summary.runScore))
        .replace("{quality}", summary.quality)
        .replace("{totalTurns}", String(summary.totalTurns))
        .replace("{midRunFailures}", String(summary.midRunFailures))
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

export function saveLessons(newLessons: string, task: string, outcome: string): void {
    try {
        mkdirSync(CLAWAGENTS_DIR, { recursive: true });

        const header = `\n## Lessons from run (${outcome}) — ${task.slice(0, 80)}\n`;
        const entry = header + newLessons.trim() + "\n";

        let existing = "";
        if (existsSync(LESSONS_FILE)) {
            existing = readFileSync(LESSONS_FILE, "utf-8");
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
            writeFileSync(LESSONS_FILE, (nl > 0 ? trimmed.slice(nl + 1) : trimmed) + "\n", "utf-8");
        } else {
            writeFileSync(LESSONS_FILE, text + "\n", "utf-8");
        }
    } catch { /* best effort */ }
}

export function loadLessons(maxChars = MAX_LESSONS_CHARS): string {
    try {
        if (!existsSync(LESSONS_FILE)) return "";
        let text = readFileSync(LESSONS_FILE, "utf-8").trim();
        if (!text) return "";
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

export function buildRethinkWithLessons(genericRethink: string): string {
    const lessons = loadLessons(1500);
    if (!lessons) return genericRethink;
    return (
        genericRethink + "\n\n" +
        "## Relevant Lessons from Past Runs\n" +
        "Consider these lessons from previous runs:\n\n" +
        lessons + "\n"
    );
}
