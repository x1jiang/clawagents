/**
 * Structured trajectory logging for ClawAgents.
 *
 * Records every agent turn as NDJSON — one line per turn, one file per run.
 * Storage: .clawagents/trajectories/{runId}.jsonl
 *
 * Enable via createClawAgent({ trajectory: true }) or CLAW_TRAJECTORY=1 in .env.
 *
 * Scoring (inspired by CUDA-Agent discrete reward bands):
 *   Turn score: weighted by tool type — execution tools count double.
 *   Run score:  -1 (failed), 0 (ambiguous), +1 (completed),
 *               +2 (efficient), +3 (clean first-attempt success).
 *   Quality:    "clean" / "noisy" / "failed" — for trajectory filtering.
 */

import { mkdirSync, appendFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

function getTrajectoriesDir(): string {
    return resolve(process.cwd(), ".clawagents", "trajectories");
}

/** Tools whose results are not meaningful reward signals (gameable / no side effects) */
const SCORELESS_TOOLS = new Set([
    "think", "todolist", "todo_write", "todo_read",
    "use_skill", "ask_user",
]);

/** Tools whose success/failure carries extra weight (real execution with side effects) */
const HIGH_WEIGHT_TOOLS = new Set([
    "execute", "execute_command", "run_command", "bash",
]);

export interface ToolCallRecord {
    toolName: string;
    args: Record<string, unknown>;
    success: boolean;
    outputPreview: string;
    error?: string;
    durationMs?: number;
    failureType?: string;     // "format" | "logic" | "" (Feature 3)
}

export interface TurnRecord {
    runId: string;
    turnIndex: number;
    timestamp: number;
    responseText: string;
    model: string;
    tokensUsed: number;
    toolCalls: ToolCallRecord[];
    score: number;            // weighted turn score
    cumulativeScore: number;
    observationContext: string;        // what agent saw before deciding (Feature 4)
    productivityScore: number;        // per-step productivity: -1.0 to 1.0 (Feature 4)
    deterministicScore: number | null; // objective score from exec tools (Feature A)
    promptTokenCount: number;          // tokens in prompt at this step (Feature E)
    responseTokenCount: number;        // tokens in response at this step (Feature E)
    thinking: string | null;           // preserved <think> content (Feature H)
    metadata: Record<string, unknown>;
}

export interface RunSummary {
    runId: string;
    task: string;
    model: string;
    totalTurns: number;
    totalToolCalls: number;
    toolSuccessRate: number;
    turnScores: number[];
    outcome: string;          // "success" | "error" | "cancelled" | "max_iterations"
    aggregateScore: number;
    runScore: number;         // discrete band: -1, 0, +1, +2, +3
    quality: string;          // "clean" | "noisy" | "failed"
    midRunFailures: number;
    formatFailures: number;   // count of format-type failures (Feature 3)
    logicFailures: number;    // count of logic-type failures (Feature 3)
    hasMixedOutcomes: boolean; // True if run had both successes and failures (Feature 1)
    finishReason: string;     // why the run ended (Feature 4)
    taskType: string;         // auto-detected: "coding"|"file"|"search"|"refactor"|"general" (Feature C)
    verifiedScore: number | null;  // deterministic score from tool outputs (Feature A)
    verifiedConfidence: string;    // "high"|"medium"|"low" (Feature A)
    verifiedMethod: string;        // how the score was computed (Feature A)
    judgeScore: number | null;     // LLM-as-Judge score 0-3 (Feature G)
    judgeJustification: string;    // LLM judge's reasoning (Feature G)
    durationS: number;
    tokensTotal: number;
    trajectoryFile: string;
}

// ─── Feature 3: Format vs. Logic Failure Classification ───────────────────

const FORMAT_ERROR_PATTERNS = [
    "invalid json", "json decode", "json parse", "unexpected token",
    "missing required", "unknown tool", "unrecognized tool",
    "no tool named", "expected string", "expected number",
    "not a valid", "malformed", "syntax error in args",
    "missing parameter", "unknown parameter", "extra parameter",
];

export function classifyFailure(toolName: string, error?: string, output?: string): string {
    if (!error && !output) return "unknown";
    const text = ((error ?? "") + " " + (output ?? "")).toLowerCase();
    for (const pattern of FORMAT_ERROR_PATTERNS) {
        if (text.includes(pattern)) return "format";
    }
    return "logic";
}

// ─── Feature 4: Per-Step Productivity Scoring ─────────────────────────────

function computeProductivity(
    calls: ToolCallRecord[],
    prevCumulative: number,
): number {
    if (calls.length === 0) return 0;

    const scored = calls.filter((c) => !SCORELESS_TOOLS.has(c.toolName));
    if (scored.length === 0) return 0;

    const successes = scored.filter((c) => c.success).length;
    const failures = scored.length - successes;
    let base = (successes - failures) / scored.length;

    if (prevCumulative < 0 && base > 0) {
        base = Math.min(base + 0.2, 1.0);
    }

    return Math.round(base * 100) / 100;
}

function scoreTurn(calls: ToolCallRecord[]): number {
    if (calls.length === 0) return 0;

    let total = 0;
    let scoredCount = 0;
    for (const tc of calls) {
        if (SCORELESS_TOOLS.has(tc.toolName)) continue;
        scoredCount++;
        const weight = HIGH_WEIGHT_TOOLS.has(tc.toolName) ? 2 : 1;
        total += tc.success ? weight : -weight;
    }

    if (scoredCount === 0) return 0;
    return total > 0 ? 1 : total < 0 ? -1 : 0;
}

function computeRunScore(
    outcome: string,
    turns: TurnRecord[],
    midRunFailures: number,
): number {
    if (["error", "cancelled", "max_iterations"].includes(outcome)) return -1;
    if (outcome === "done" && turns.length === 0) return 0;

    if (outcome === "done" || outcome === "success") {
        if (midRunFailures === 0) return 3;
        const scoredTurns = turns.filter((t) => t.score !== 0);
        if (scoredTurns.length === 0) return 1;
        const failureRate = midRunFailures / scoredTurns.length;
        return failureRate <= 0.2 ? 2 : 1;
    }
    return 0;
}

function computeQuality(runScore: number, midRunFailures: number, totalTurns: number): string {
    if (runScore <= 0) return "failed";
    if (runScore >= 2) return "clean";
    if (totalTurns > 0 && midRunFailures / Math.max(totalTurns, 1) > 0.4) return "noisy";
    return "clean";
}

export class TrajectoryRecorder {
    public readonly runId: string;
    public readonly task: string;
    public model: string;

    private turns: TurnRecord[] = [];
    private cumulativeScore = 0;
    private totalTokens = 0;
    private midRunFailures = 0;
    private hasSuccesses = false;
    private hasFailures = false;
    private filePath: string;
    private t0: number;
    private responseChars: number;

    constructor(task: string, model = "", responseChars = 500) {
        this.runId = randomUUID().replace(/-/g, "").slice(0, 12);
        this.task = task;
        this.model = model;
        this.responseChars = responseChars;
        this.filePath = resolve(getTrajectoriesDir(), `${this.runId}.jsonl`);
        this.t0 = Date.now();
        this.ensureDir();
    }

    private ensureDir(): void {
        try {
            mkdirSync(getTrajectoriesDir(), { recursive: true });
        } catch { /* best effort */ }
    }

    recordTurn(
        responseText: string,
        model: string,
        tokensUsed: number,
        toolCalls?: ToolCallRecord[],
        metadata?: Record<string, unknown>,
        observationContext?: string,
        promptTokenCount?: number,
        responseTokenCount?: number,
        thinking?: string | null,
    ): TurnRecord {
        if (model && !this.model) this.model = model;

        const calls = toolCalls ?? [];
        const score = scoreTurn(calls);

        // Feature 3: classify failure types
        for (const tc of calls) {
            if (!tc.success && !tc.failureType) {
                tc.failureType = classifyFailure(tc.toolName, tc.error, tc.outputPreview);
            }
        }

        if (score < 0) this.midRunFailures++;
        if (score > 0) this.hasSuccesses = true;
        if (score < 0) this.hasFailures = true;

        // Feature 4: per-step productivity
        const productivity = computeProductivity(calls, this.cumulativeScore);

        // Feature A: deterministic score from execution tools
        let detScore: number | null = null;
        try {
            const { computeDeterministicScore } = require("./verifier.js");
            const callDicts = calls.map((c) => ({
                toolName: c.toolName, success: c.success,
                outputPreview: c.outputPreview, error: c.error,
            }));
            detScore = computeDeterministicScore(callDicts);
        } catch { /* best effort */ }

        this.cumulativeScore += score;
        this.totalTokens += tokensUsed;

        const turn: TurnRecord = {
            runId: this.runId,
            turnIndex: this.turns.length,
            timestamp: Date.now(),
            responseText: responseText.slice(0, this.responseChars),
            model,
            tokensUsed,
            toolCalls: calls,
            score,
            cumulativeScore: this.cumulativeScore,
            observationContext: (observationContext ?? "").slice(0, 300),
            productivityScore: productivity,
            deterministicScore: detScore,
            promptTokenCount: promptTokenCount ?? 0,
            responseTokenCount: responseTokenCount ?? 0,
            thinking: thinking ? thinking.slice(0, 500) : null,
            metadata: metadata ?? {},
        };

        this.turns.push(turn);
        this.writeTurn(turn);
        return turn;
    }

    private writeTurn(turn: TurnRecord): void {
        try {
            appendFileSync(this.filePath, JSON.stringify(turn) + "\n", "utf-8");
        } catch { /* best effort */ }
    }

    finalize(outcome: string): RunSummary {
        const elapsed = (Date.now() - this.t0) / 1000;
        const toolTotal = this.turns.reduce((s, t) => s + t.toolCalls.length, 0);
        const toolOk = this.turns.reduce(
            (s, t) => s + t.toolCalls.filter((tc) => tc.success).length, 0,
        );
        const scores = this.turns.map((t) => t.score);

        const runScore = computeRunScore(outcome, this.turns, this.midRunFailures);
        const quality = computeQuality(runScore, this.midRunFailures, this.turns.length);

        // Feature 3: count format vs. logic failures
        let formatFailures = 0;
        let logicFailures = 0;
        for (const t of this.turns) {
            for (const tc of t.toolCalls) {
                if (!tc.success) {
                    if (tc.failureType === "format") formatFailures++;
                    else if (tc.failureType === "logic") logicFailures++;
                }
            }
        }

        // Feature 4: finish reason mapping
        const finishReasonMap: Record<string, string> = {
            done: "success", success: "success",
            error: "error", cancelled: "cancelled",
            max_iterations: "max_iterations",
        };

        // Feature C + A: task type detection and verification
        let taskType = "";
        let verifiedScore: number | null = null;
        let verifiedConfidence = "";
        let verifiedMethod = "";
        try {
            const { detectTaskType, verifyTaskOutcome } = require("./verifier.js");
            taskType = detectTaskType(this.task);
            const result = verifyTaskOutcome(taskType, this.turns, outcome);
            verifiedScore = result.verifiedScore;
            verifiedConfidence = result.confidence ?? "";
            verifiedMethod = result.method ?? "";
        } catch { /* best effort */ }

        const summary: RunSummary = {
            runId: this.runId,
            task: this.task.slice(0, 200),
            model: this.model,
            totalTurns: this.turns.length,
            totalToolCalls: toolTotal,
            toolSuccessRate: toolTotal > 0 ? toolOk / toolTotal : 1.0,
            turnScores: scores,
            outcome,
            aggregateScore: this.turns.length > 0
                ? this.cumulativeScore / this.turns.length
                : 0,
            runScore,
            quality,
            midRunFailures: this.midRunFailures,
            formatFailures,
            logicFailures,
            hasMixedOutcomes: this.hasSuccesses && this.hasFailures,
            finishReason: finishReasonMap[outcome] ?? outcome,
            taskType,
            verifiedScore,
            verifiedConfidence,
            verifiedMethod,
            judgeScore: null,
            judgeJustification: "",
            durationS: Math.round(elapsed * 100) / 100,
            tokensTotal: this.totalTokens,
            trajectoryFile: this.filePath,
        };

        this.writeSummary(summary);
        return summary;
    }

    private writeSummary(summary: RunSummary): void {
        try {
            const runsFile = resolve(getTrajectoriesDir(), "runs.jsonl");
            appendFileSync(runsFile, JSON.stringify(summary) + "\n", "utf-8");
        } catch { /* best effort */ }

        // Feature E: export RFT-ready transitions
        try {
            const { writeFileSync } = require("node:fs");
            const rftFile = resolve(getTrajectoriesDir(), `${this.runId}_rft.json`);
            const transitions = this.exportRftTransitions();
            writeFileSync(rftFile, JSON.stringify({
                runId: this.runId,
                task: this.task,
                model: this.model,
                outcome: summary.outcome,
                runScore: summary.runScore,
                quality: summary.quality,
                verifiedScore: summary.verifiedScore,
                taskType: summary.taskType,
                transitions,
            }, null, 2), "utf-8");
        } catch { /* best effort */ }
    }

    /**
     * Feature E: Export turns as RFT-ready (observation, action, reward, done) transitions.
     */
    exportRftTransitions(): Array<Record<string, unknown>> {
        return this.turns.map((turn, i) => {
            const isLast = i === this.turns.length - 1;
            const reward = turn.deterministicScore ?? turn.productivityScore;
            return {
                observation: turn.observationContext,
                action: {
                    responseText: turn.responseText,
                    toolCalls: turn.toolCalls.map((tc) => ({
                        toolName: tc.toolName,
                        args: tc.args,
                        success: tc.success,
                        outputPreview: tc.outputPreview,
                        failureType: tc.failureType,
                    })),
                },
                reward: Math.round((reward ?? 0) * 1000) / 1000,
                done: isLast,
                stepIndex: turn.turnIndex,
                timestamp: turn.timestamp,
                model: turn.model,
                promptTokens: turn.promptTokenCount,
                responseTokens: turn.responseTokenCount,
                heuristicScore: turn.score,
                cumulativeScore: turn.cumulativeScore,
            };
        });
    }

    getTurns(): TurnRecord[] {
        return [...this.turns];
    }
}

export function pruneTrajectories(maxAgeDays = 30): number {
    const trajDir = getTrajectoriesDir();
    if (!existsSync(trajDir)) return 0;
    const cutoff = Date.now() - maxAgeDays * 86400000;
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
    return removed;
}
