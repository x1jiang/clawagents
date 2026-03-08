/**
 * Task verification and deterministic reward signals.
 *
 * Feature A: Deterministic rewards from tool execution — uses exit codes and
 *            tool outputs as objective ground truth instead of LLM self-grading.
 * Feature C: Task-type-aware verification — auto-detects task type and applies
 *            the right verifier (coding, file, search, general).
 * Feature F: Adaptive rethink threshold — adjusts rethink sensitivity based on
 *            task complexity and run progress.
 */

import type { ToolCallRecord } from "./recorder.js";

// ─── Feature A: Deterministic Rewards from Tool Execution ─────────────────

const EXEC_TOOL_NAMES = new Set([
    "execute", "execute_command", "run_command", "bash", "shell",
]);

interface ToolCallDict {
    toolName?: string;
    tool_name?: string;
    success?: boolean;
    outputPreview?: string;
    output_preview?: string;
    error?: string;
}

function getToolName(tc: ToolCallDict): string {
    return tc.toolName ?? tc.tool_name ?? "";
}

function getOutputPreview(tc: ToolCallDict): string {
    return tc.outputPreview ?? tc.output_preview ?? "";
}

function filterExecutionCalls(toolCalls: ToolCallDict[]): ToolCallDict[] {
    return toolCalls.filter((tc) => EXEC_TOOL_NAMES.has(getToolName(tc)));
}

function hasTestResults(output: string): boolean {
    const lower = output.toLowerCase();
    return (
        /\d+\s+(passed|failed|error)/i.test(output) ||
        /\b(PASS|FAIL|OK)\b/.test(output) ||
        (lower.includes("test") && (lower.includes("pass") || lower.includes("fail")))
    );
}

function scoreTestOutput(output: string): number {
    const passMatch = output.match(/(\d+)\s+passed/i);
    const passed = passMatch ? parseInt(passMatch[1]!, 10) : 0;
    const failMatch = output.match(/(\d+)\s+failed/i);
    const failed = failMatch ? parseInt(failMatch[1]!, 10) : 0;

    const total = passed + failed;
    if (total === 0) {
        if (output.includes("PASS") || output.includes("OK")) return 1.0;
        if (output.includes("FAIL")) return -0.5;
        return 0.5;
    }
    return Math.round(((passed - failed) / total) * 100) / 100;
}

function hasExitCodeZero(output: string): boolean {
    const lower = output.toLowerCase();
    return lower.includes("exit code: 0") || lower.includes("exit code 0");
}

function isCompilationError(text: string): boolean {
    const t = text.toLowerCase();
    return ["syntaxerror", "compileerror", "compile error",
        "indentationerror", "nameerror", "typeerror",
        "cannot find module", "module not found",
    ].some((p) => t.includes(p));
}

function isTestFailure(text: string): boolean {
    const t = text.toLowerCase();
    return ["assertionerror", "failed", "failure", "error"].some((p) => t.includes(p));
}

export function computeDeterministicScore(toolCalls: ToolCallDict[]): number | null {
    const execTools = filterExecutionCalls(toolCalls);
    if (execTools.length === 0) return null;

    const scores: number[] = [];
    for (const tc of execTools) {
        const output = getOutputPreview(tc);
        const error = tc.error ?? "";
        const success = tc.success ?? false;

        if (success) {
            if (hasTestResults(output)) {
                scores.push(scoreTestOutput(output));
            } else if (hasExitCodeZero(output)) {
                scores.push(1.0);
            } else {
                scores.push(0.8);
            }
        } else {
            if (isCompilationError(error + output)) {
                scores.push(-1.0);
            } else if (isTestFailure(error + output)) {
                scores.push(-0.5);
            } else {
                scores.push(-0.7);
            }
        }
    }

    if (scores.length === 0) return null;
    return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;
}

// ─── Feature C: Task-Type-Aware Verification ──────────────────────────────

const TASK_TYPE_PATTERNS: Record<string, RegExp[]> = {
    coding: [
        /write.*code/i, /implement/i, /create.*function/i, /add.*test/i,
        /fix.*bug/i, /build.*module/i, /create.*class/i,
        /write.*script/i, /write.*program/i, /create.*api/i,
        /write.*function/i, /function.*that/i, /sort.*list/i,
    ],
    file: [
        /create.*file/i, /move.*file/i, /rename/i, /organize/i,
        /copy.*file/i, /delete.*file/i, /create.*directory/i,
    ],
    search: [
        /find.*all/i, /search.*for/i, /list.*all/i, /how many/i,
        /where.*is/i, /what.*is/i, /analyze/i, /summarize/i,
    ],
    refactor: [
        /refactor/i, /rename.*across/i, /update.*imports/i,
        /migrate/i, /convert.*to/i,
    ],
};

export function detectTaskType(task: string): string {
    const scores: Record<string, number> = {};
    for (const [taskType, patterns] of Object.entries(TASK_TYPE_PATTERNS)) {
        scores[taskType] = patterns.filter((p) => p.test(task)).length;
    }

    let maxType = "general";
    let maxScore = 0;
    for (const [taskType, score] of Object.entries(scores)) {
        if (score > maxScore) {
            maxScore = score;
            maxType = taskType;
        }
    }
    return maxType;
}

interface VerificationResult {
    verifiedScore: number | null;
    confidence: "high" | "medium" | "low";
    method: string;
}

export function verifyTaskOutcome(
    taskType: string,
    turns: Array<Record<string, unknown>>,
    outcome: string,
): VerificationResult {
    if (taskType === "coding") return verifyCoding(turns, outcome);
    if (taskType === "file") return verifyFile(turns, outcome);
    if (taskType === "refactor") return verifyRefactor(turns, outcome);
    return verifyGeneral(turns, outcome);
}

function extractToolCalls(turns: Array<Record<string, unknown>>): ToolCallDict[] {
    const all: ToolCallDict[] = [];
    for (const t of turns) {
        const calls = (t.toolCalls ?? t.tool_calls ?? []) as ToolCallDict[];
        for (const tc of calls) all.push(tc);
    }
    return all;
}

function verifyCoding(turns: Array<Record<string, unknown>>, outcome: string): VerificationResult {
    const allCalls = extractToolCalls(turns);
    const execCalls = allCalls.filter((tc) => EXEC_TOOL_NAMES.has(getToolName(tc)));

    if (execCalls.length === 0) {
        return { verifiedScore: null, confidence: "low", method: "no_execution_tools" };
    }

    const lastExec = execCalls[execCalls.length - 1]!;
    const score = computeDeterministicScore([lastExec]);

    if (score !== null && hasTestResults(getOutputPreview(lastExec))) {
        return { verifiedScore: score, confidence: "high", method: "test_results" };
    }
    if (score !== null) {
        return { verifiedScore: score, confidence: "medium", method: "exit_code" };
    }
    return { verifiedScore: null, confidence: "low", method: "no_objective_signal" };
}

function verifyFile(turns: Array<Record<string, unknown>>, outcome: string): VerificationResult {
    const allCalls = extractToolCalls(turns);
    const fileOps = allCalls.filter((tc) => ["write_file", "edit_file", "create_file"].includes(getToolName(tc)));

    if (fileOps.length === 0) {
        return { verifiedScore: null, confidence: "low", method: "no_file_ops" };
    }

    const succeeded = fileOps.filter((op) => op.success).length;
    const rate = succeeded / fileOps.length;
    return {
        verifiedScore: Math.round((rate * 2 - 1) * 100) / 100,
        confidence: "medium",
        method: `file_ops_${succeeded}/${fileOps.length}`,
    };
}

function verifyRefactor(turns: Array<Record<string, unknown>>, outcome: string): VerificationResult {
    const allCalls = extractToolCalls(turns);
    const edits = allCalls.filter((tc) => ["edit_file", "write_file"].includes(getToolName(tc)));
    const testResults = allCalls.filter((tc) => EXEC_TOOL_NAMES.has(getToolName(tc)));

    if (edits.length === 0) {
        return { verifiedScore: null, confidence: "low", method: "no_edits" };
    }

    const editSuccess = edits.filter((e) => e.success).length / edits.length;

    if (testResults.length > 0) {
        const lastTest = testResults[testResults.length - 1]!;
        const testScore = computeDeterministicScore([lastTest]);
        if (testScore !== null) {
            const combined = Math.round(((editSuccess + (testScore + 1) / 2) / 2 * 2 - 1) * 100) / 100;
            return { verifiedScore: combined, confidence: "high", method: "edits_plus_tests" };
        }
    }

    return {
        verifiedScore: Math.round((editSuccess * 2 - 1) * 100) / 100,
        confidence: "medium",
        method: `edits_only_${edits.filter((e) => e.success).length}/${edits.length}`,
    };
}

function verifyGeneral(turns: Array<Record<string, unknown>>, outcome: string): VerificationResult {
    const allCalls = extractToolCalls(turns);
    const det = computeDeterministicScore(allCalls);
    if (det !== null) {
        return { verifiedScore: det, confidence: "medium", method: "execution_heuristic" };
    }
    return { verifiedScore: null, confidence: "low", method: "no_objective_signal" };
}

// ─── Feature F: Adaptive Rethink Threshold ────────────────────────────────

const BASE_THRESHOLD = 3;
const MIN_THRESHOLD = 2;
const MAX_THRESHOLD = 6;

export function computeAdaptiveRethinkThreshold(
    taskType: string,
    currentTurn: number,
    totalToolCount: number,
): number {
    const complexityBonus: Record<string, number> = {
        coding: 2,
        refactor: 2,
        general: 1,
        search: 0,
        file: 0,
    };

    let threshold = BASE_THRESHOLD + (complexityBonus[taskType] ?? 1);

    if (currentTurn > 50) {
        threshold = MIN_THRESHOLD;
    } else if (currentTurn > 20) {
        threshold = Math.max(threshold - 1, MIN_THRESHOLD);
    }

    return Math.min(threshold, MAX_THRESHOLD);
}
