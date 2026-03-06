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

import { mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const TRAJECTORIES_DIR = resolve(process.cwd(), ".clawagents", "trajectories");

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
    durationS: number;
    tokensTotal: number;
    trajectoryFile: string;
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
    private filePath: string;
    private t0: number;
    private responseChars: number;

    constructor(task: string, model = "", responseChars = 500) {
        this.runId = randomUUID().replace(/-/g, "").slice(0, 12);
        this.task = task;
        this.model = model;
        this.responseChars = responseChars;
        this.filePath = resolve(TRAJECTORIES_DIR, `${this.runId}.jsonl`);
        this.t0 = Date.now();
        this.ensureDir();
    }

    private ensureDir(): void {
        try {
            mkdirSync(TRAJECTORIES_DIR, { recursive: true });
        } catch { /* best effort */ }
    }

    recordTurn(
        responseText: string,
        model: string,
        tokensUsed: number,
        toolCalls?: ToolCallRecord[],
        metadata?: Record<string, unknown>,
    ): TurnRecord {
        if (model && !this.model) this.model = model;

        const calls = toolCalls ?? [];
        const score = scoreTurn(calls);

        if (score < 0) this.midRunFailures++;

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
            durationS: Math.round(elapsed * 100) / 100,
            tokensTotal: this.totalTokens,
            trajectoryFile: this.filePath,
        };

        this.writeSummary(summary);
        return summary;
    }

    private writeSummary(summary: RunSummary): void {
        try {
            const runsFile = resolve(TRAJECTORIES_DIR, "runs.jsonl");
            appendFileSync(runsFile, JSON.stringify(summary) + "\n", "utf-8");
        } catch { /* best effort */ }
    }

    getTurns(): TurnRecord[] {
        return [...this.turns];
    }
}
