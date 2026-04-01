/**
 * Coordinator/Swarm Orchestration Mode (learned from Claude Code: coordinatorMode.ts).
 *
 * Two-tier execution model:
 *   Coordinator: Plans and delegates, synthesizes results. No direct tool access.
 *   Workers: Execute specific tasks with full tool access but limited context.
 *
 * Controlled by: CLAW_FEATURE_COORDINATOR=1
 */

import type { LLMProvider, LLMMessage } from "../providers/llm.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { OnEvent } from "./agent-loop.js";

const COORDINATOR_SYSTEM_PROMPT = `\
You are a Coordinator Agent. You plan and delegate tasks to Worker agents.

## Your Role
- Analyze the user's request and break it down into sub-tasks
- Delegate each sub-task to a Worker agent
- Synthesize Worker results into a final answer
- You do NOT have direct tool access (no filesystem, no execute)

## Communication Protocol
To delegate a task to a Worker, respond with:
\`\`\`json
{"action": "delegate", "tasks": [
  {"id": "task_1", "prompt": "Detailed sub-task description", "tools": ["read_file", "grep"]},
  {"id": "task_2", "prompt": "Another sub-task", "tools": ["execute", "write_file"]}
]}
\`\`\`

To provide the final synthesized answer:
\`\`\`json
{"action": "complete", "result": "Your final answer here"}
\`\`\`

## Rules
1. Break complex tasks into 2-5 independent sub-tasks
2. Each sub-task should be self-contained with clear success criteria
3. Specify which tools each Worker needs
4. After receiving all Worker results, synthesize and provide the final answer
5. If a Worker fails, you may retry with a modified prompt or work around it
`;

export interface WorkerTask {
    id: string;
    prompt: string;
    tools: string[];
    status: "pending" | "running" | "done" | "error";
    result: string;
    durationS: number;
}

export interface CoordinatorState {
    task: string;
    workers: WorkerTask[];
    rounds: number;
    status: "running" | "done" | "error";
    finalResult: string;
}

async function runWorker(
    workerTask: WorkerTask,
    llm: LLMProvider,
    tools: ToolRegistry | undefined,
    contextWindow: number,
): Promise<WorkerTask> {
    const { runForkedAgent } = await import("./forked-agent.js");

    const t0 = Date.now();
    try {
        const state = await runForkedAgent({
            forkPrompt: workerTask.prompt,
            llm,
            tools,
            allowedTools: workerTask.tools.length > 0 ? workerTask.tools : undefined,
            maxTurns: 8,
            contextWindow,
        });
        workerTask.status = state.status === "done" ? "done" : "error";
        workerTask.result = state.result;
    } catch (err) {
        workerTask.status = "error";
        workerTask.result = `Worker error: ${err}`;
    } finally {
        workerTask.durationS = (Date.now() - t0) / 1000;
    }
    return workerTask;
}

function parseCoordinatorResponse(content: string): Record<string, unknown> {
    const stripped = content.trim();
    try { return JSON.parse(stripped); } catch { /* fall through */ }

    const fenceMatch = stripped.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
        try { return JSON.parse(fenceMatch[1]!.trim()); } catch { /* fall through */ }
    }

    return { action: "complete", result: content };
}

export async function runCoordinator(options: {
    task: string;
    llm: LLMProvider;
    tools?: ToolRegistry;
    maxWorkers?: number;
    maxRounds?: number;
    contextWindow?: number;
    onEvent?: OnEvent;
}): Promise<CoordinatorState> {
    const envVal = process.env["CLAW_FEATURE_COORDINATOR"] ?? "0";
    if (!["1", "true", "yes", "on"].includes(envVal.toLowerCase())) {
        throw new Error("Coordinator mode is not enabled. Set CLAW_FEATURE_COORDINATOR=1");
    }

    const maxWorkers = options.maxWorkers ?? 3;
    const maxRounds = options.maxRounds ?? 10;
    const contextWindow = options.contextWindow ?? 200_000;
    const emit = options.onEvent ?? (() => {});

    const state: CoordinatorState = {
        task: options.task,
        workers: [],
        rounds: 0,
        status: "running",
        finalResult: "",
    };

    const messages: LLMMessage[] = [
        { role: "system", content: COORDINATOR_SYSTEM_PROMPT },
        { role: "user", content: options.task },
    ];

    for (let roundIdx = 0; roundIdx < maxRounds; roundIdx++) {
        state.rounds = roundIdx + 1;

        let response;
        try {
            response = await options.llm.chat(messages);
        } catch (err) {
            state.status = "error";
            state.finalResult = `Coordinator LLM error: ${err}`;
            break;
        }

        messages.push({ role: "assistant", content: response.content });

        const parsed = parseCoordinatorResponse(response.content);
        const action = (parsed.action as string) ?? "complete";

        if (action === "complete") {
            state.status = "done";
            state.finalResult = (parsed.result as string) ?? response.content;
            emit("agent_done", { message: `Coordinator completed in ${state.rounds} rounds with ${state.workers.length} workers` });
            break;
        }

        if (action === "delegate") {
            const tasks = (parsed.tasks as any[]) ?? [];
            if (tasks.length === 0) {
                messages.push({ role: "user", content: "[System] No tasks specified. Please provide tasks or complete." });
                continue;
            }

            const workerTasks: WorkerTask[] = tasks.slice(0, maxWorkers).map((t: any, i: number) => ({
                id: t.id ?? `task_${state.workers.length + i + 1}`,
                prompt: t.prompt ?? "",
                tools: t.tools ?? [],
                status: "running" as const,
                result: "",
                durationS: 0,
            }));

            state.workers.push(...workerTasks);
            emit("context", { message: `Coordinator delegating ${workerTasks.length} tasks: ${workerTasks.map(t => t.id)}` });

            await Promise.all(workerTasks.map(wt => runWorker(wt, options.llm, options.tools, contextWindow)));

            const resultsText = workerTasks.map(wt => {
                emit("tool_result", { name: `worker:${wt.id}`, success: wt.status === "done", preview: wt.result.slice(0, 120) });
                return `[Worker Result: ${wt.id}]\nStatus: ${wt.status}\nDuration: ${wt.durationS.toFixed(1)}s\nResult: ${wt.result.slice(0, 2000)}`;
            });

            messages.push({ role: "user", content: "## Worker Results\n\n" + resultsText.join("\n\n") });
            continue;
        }

        // Unknown action — treat as final
        state.status = "done";
        state.finalResult = response.content;
        break;
    }

    if (state.status === "running") {
        state.status = "error";
        state.finalResult = `Coordinator exceeded ${maxRounds} rounds without completing.`;
    }

    return state;
}
