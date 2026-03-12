/**
 * Feature G: LLM-as-Judge verification.
 *
 * After a run completes, makes a separate, focused LLM call to evaluate
 * whether the agent actually accomplished the task. Returns a 0-3 score
 * with justification, stored alongside heuristic scores.
 * Controlled by learn=true (same flag as PTRL).
 */

import type { LLMProvider, LLMMessage } from "../providers/llm.js";
import type { RunSummary, TurnRecord } from "./recorder.js";

const JUDGE_PROMPT = `You are an impartial judge evaluating whether an AI coding agent successfully completed a task. You are NOT the agent — you are a separate evaluator.

## Task
{task}

## Task Type
{taskType}

## Run Summary
- Outcome reported by agent: {outcome}
- Total turns: {totalTurns}
- Tool calls: {totalToolCalls} ({toolSuccessRate} success rate)
- Duration: {durationS}s
- Mid-run failures: {midRunFailures}
- Deterministic score: {verifiedScore} (from actual tool outputs)

## Final Result
{finalResult}

## Key Events
{keyEvents}

## Scoring Rubric
Rate the run on a 0-3 scale:

- **3 — Full success**: Task is completely and correctly accomplished. Evidence of correct output visible in tool results.
- **2 — Partial success**: Task is mostly done but with minor issues (e.g., works but has edge cases, missing error handling).
- **1 — Minimal progress**: Agent made some progress but did not complete the task (e.g., identified the problem but didn't fix it).
- **0 — Failure**: Task was not accomplished. Agent may have gone in circles, hit errors it couldn't recover from, or produced wrong output.

## Response Format
Respond with EXACTLY two lines:
SCORE: <0|1|2|3>
REASON: <one sentence justification>

Do not add any other text.`;

export interface JudgeResult {
    judgeScore: number | null;
    judgeJustification: string;
}

export async function judgeRun(
    llm: LLMProvider,
    task: string,
    summary: Partial<RunSummary>,
    finalResult: string,
    keyTurns?: Partial<TurnRecord>[],
): Promise<JudgeResult> {
    const keyEvents = formatKeyEvents(keyTurns || [], 8);
    const vScore = summary.verifiedScore;

    const sr = (summary.toolSuccessRate ?? 0) * 100;
    const prompt = JUDGE_PROMPT
        .replace("{task}", task)
        .replace("{taskType}", summary.taskType || "general")
        .replace("{outcome}", summary.outcome || "unknown")
        .replace("{totalTurns}", String(summary.totalTurns ?? 0))
        .replace("{totalToolCalls}", String(summary.totalToolCalls ?? 0))
        .replace("{toolSuccessRate}", `${sr.toFixed(0)}%`)
        .replace("{durationS}", String(summary.durationS ?? 0))
        .replace("{midRunFailures}", String(summary.midRunFailures ?? 0))
        .replace("{verifiedScore}", vScore != null ? vScore.toFixed(2) : "N/A")
        .replace("{finalResult}", (finalResult || "").slice(0, 500))
        .replace("{keyEvents}", keyEvents);

    try {
        const messages: LLMMessage[] = [
            { role: "system", content: "You are an impartial task completion judge." },
            { role: "user", content: prompt },
        ];
        const response = await llm.chat(messages);
        const text = (response.content || "").trim();
        return parseJudgeResponse(text);
    } catch {
        return { judgeScore: null, judgeJustification: "judge call failed" };
    }
}

function formatKeyEvents(turns: Partial<TurnRecord>[], maxEvents: number): string {
    if (!turns.length) return "(no events recorded)";

    const events: string[] = [];
    for (const t of turns.slice(0, maxEvents)) {
        const idx = t.turnIndex ?? "?";
        const calls = t.toolCalls || [];
        for (const tc of calls) {
            const name = tc.toolName ?? "?";
            const status = tc.success ? "OK" : "FAIL";
            const preview = (tc.outputPreview || "").slice(0, 100);
            events.push(`Turn ${idx}: [${status}] ${name} — ${preview}`);
        }
    }

    return events.length ? events.join("\n") : "(no tool events)";
}

function parseJudgeResponse(text: string): JudgeResult {
    let score: number | null = null;
    let reason = "";

    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.toUpperCase().startsWith("SCORE:")) {
            const val = trimmed.split(":")[1]?.trim();
            const n = parseInt(val || "", 10);
            if (!isNaN(n)) {
                score = Math.max(0, Math.min(3, n));
            }
        } else if (trimmed.toUpperCase().startsWith("REASON:")) {
            reason = trimmed.split(":").slice(1).join(":").trim();
        }
    }

    if (score === null) {
        const m = text.match(/\b([0-3])\b/);
        if (m) {
            score = parseInt(m[1]!, 10);
            reason = reason || text.slice(0, 200);
        }
    }

    return {
        judgeScore: score,
        judgeJustification: reason || text.slice(0, 200),
    };
}
