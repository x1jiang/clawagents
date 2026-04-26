import type { LLMMessage } from "./providers/llm.js";

export interface TextEnvInit {
    observations: LLMMessage[];
    metadata?: Record<string, unknown>;
}

export interface TextEnvStepOutput {
    observations: LLMMessage[];
    reward: number;
    done: boolean;
    metadata?: Record<string, unknown>;
    postprocessedAction?: string;
}

export interface TextEnvironment {
    init(): TextEnvInit | Promise<TextEnvInit>;
    step(action: string): TextEnvStepOutput | Promise<TextEnvStepOutput>;
    close?(): void | Promise<void>;
    getMetrics?(): Record<string, unknown>;
}

export type TextResponder = (messages: LLMMessage[]) => string | Promise<string>;

export type AgentEnvInit = TextEnvInit;
export type AgentEnvStepOutput = TextEnvStepOutput;
export type AgentEnvironment = TextEnvironment;
export type AgentResponder = TextResponder;

export interface TextEvaluationStep {
    action: string;
    observations: LLMMessage[];
    reward: number;
    done: boolean;
    metadata: Record<string, unknown>;
}

export interface TextEvaluationResult {
    steps: TextEvaluationStep[];
    totalReward: number;
    metrics: Record<string, unknown>;
    metadata: Record<string, unknown>;
}

export type AgentEvaluationStep = TextEvaluationStep;
export type AgentEvaluationResult = TextEvaluationResult;

export async function runTextEnvironment(
    responder: TextResponder,
    env: TextEnvironment,
    opts: { maxTurns?: number } = {},
): Promise<TextEvaluationResult> {
    const maxTurns = Math.max(1, opts.maxTurns ?? 20);
    const initial = await env.init();
    let messages = [...initial.observations];
    const steps: TextEvaluationStep[] = [];
    let totalReward = 0;

    try {
        for (let turn = 0; turn < maxTurns; turn++) {
            const action = await responder(messages);
            const step = await env.step(action);
            totalReward += step.reward;
            steps.push({
                action: step.postprocessedAction ?? action,
                observations: [...step.observations],
                reward: step.reward,
                done: step.done,
                metadata: { ...(step.metadata ?? {}) },
            });
            messages = [...messages, { role: "assistant", content: action }, ...step.observations];
            if (step.done) break;
        }
    } finally {
        await env.close?.();
    }

    return {
        steps,
        totalReward,
        metrics: env.getMetrics?.() ?? {},
        metadata: { ...(initial.metadata ?? {}) },
    };
}

export async function runAgentEnvironment(
    responder: AgentResponder,
    env: AgentEnvironment,
    opts: { maxTurns?: number } = {},
): Promise<AgentEvaluationResult> {
    return await runTextEnvironment(responder, env, opts);
}
