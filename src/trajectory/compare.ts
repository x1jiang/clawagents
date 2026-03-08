/**
 * Feature B: Multi-sample comparison (GRPO-inspired).
 *
 * Runs the same task N times and picks the best result based on objective scoring.
 * Inspired by SkyRL's Group Relative Policy Optimization.
 */

import { readFileSync } from "node:fs";
import type { LLMProvider } from "../providers/llm.js";
import type { ToolRegistry } from "../tools/registry.js";

interface CompareSamplesOptions {
    task: string;
    llm: LLMProvider;
    tools?: ToolRegistry;
    systemPrompt?: string;
    nSamples?: number;
    maxIterations?: number;
    streaming?: boolean;
    contextWindow?: number;
    onEvent?: (kind: string, data: Record<string, unknown>) => void;
    useNativeTools?: boolean;
    rethink?: boolean;
    learn?: boolean;
    previewChars?: number;
    responseChars?: number;
}

interface SampleResult {
    index: number;
    result: string;
    status: string;
    iterations: number;
    toolCalls: number;
    trajectoryFile: string;
    compositeScore: number;
    scoringMethod: string;
}

interface CompareResult {
    bestResult: string;
    bestScore: number;
    bestIndex: number;
    allScores: SampleResult[];
    comparisonMethod: string;
    nSamples: number;
}

export async function compareSamples(opts: CompareSamplesOptions): Promise<CompareResult> {
    const { runAgentGraph } = await import("../graph/agent-loop.js");
    const nSamples = opts.nSamples ?? 3;
    const samples: Array<Record<string, unknown>> = [];

    for (let i = 0; i < nSamples; i++) {
        try {
            const state = await runAgentGraph(
                opts.task,
                opts.llm,
                opts.tools,
                opts.systemPrompt,
                opts.maxIterations ?? 200,
                false,  // streaming
                opts.contextWindow ?? 1_000_000,
                opts.onEvent as any,
                undefined,  // beforeLLM
                undefined,  // beforeTool
                undefined,  // afterTool
                opts.useNativeTools ?? true,
                true,  // trajectory
                opts.rethink ?? true,
                false, // learn - don't learn during comparison
                opts.previewChars ?? 120,
                opts.responseChars ?? 500,
            );
            samples.push({
                index: i,
                result: state.result,
                status: state.status,
                iterations: state.iterations,
                toolCalls: state.toolCalls,
                trajectoryFile: state.trajectoryFile ?? "",
            });
        } catch (e) {
            samples.push({
                index: i,
                result: String(e),
                status: "error",
                iterations: 0,
                toolCalls: 0,
                trajectoryFile: "",
            });
        }
    }

    const scored = scoreSamples(samples);
    const best = scored.reduce((a, b) => a.compositeScore >= b.compositeScore ? a : b, scored[0]!);

    return {
        bestResult: best.result,
        bestScore: best.compositeScore,
        bestIndex: best.index,
        allScores: scored,
        comparisonMethod: best.scoringMethod,
        nSamples,
    };
}

function scoreSamples(samples: Array<Record<string, unknown>>): SampleResult[] {
    return samples.map((s) => {
        let score = 0;
        let method = "status";

        if (s.status === "done") score = 0.5;
        else if (s.status === "error") score = -1.0;

        const iterations = (s.iterations as number) ?? 0;
        if (iterations > 0 && s.status === "done") {
            const efficiency = Math.max(0, 1.0 - iterations / 100);
            score += efficiency * 0.3;
            method = "efficiency";
        }

        const trajFile = (s.trajectoryFile as string) ?? "";
        if (trajFile) {
            try {
                const { computeDeterministicScore } = require("./verifier.js");
                const lines = readFileSync(trajFile, "utf-8").trim().split("\n");
                const allCalls: Array<Record<string, unknown>> = [];
                for (const line of lines) {
                    try {
                        const turn = JSON.parse(line);
                        for (const tc of turn.toolCalls ?? []) allCalls.push(tc);
                    } catch { /* skip */ }
                }
                const det = computeDeterministicScore(allCalls);
                if (det !== null) {
                    score = det;
                    method = "deterministic";
                }
            } catch { /* best effort */ }
        }

        return {
            index: s.index as number,
            result: (s.result as string) ?? "",
            status: (s.status as string) ?? "",
            iterations,
            toolCalls: (s.toolCalls as number) ?? 0,
            trajectoryFile: trajFile,
            compositeScore: Math.round(score * 1000) / 1000,
            scoringMethod: method,
        };
    });
}
