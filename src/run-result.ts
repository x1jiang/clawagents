import type { LLMMessage } from "./providers/llm.js";
import type { Session } from "./session/backends.js";
import type { AgentState, AgentStatus } from "./graph/agent-loop.js";

export interface RunResultState {
    messages: LLMMessage[];
    task: string;
    status: AgentStatus;
    final_output: unknown;
    result: string;
    iterations: number;
    max_iterations: number;
    tool_calls: number;
    trajectory_file?: string;
    session_file?: string;
    interruptions?: Array<Record<string, unknown>>;
    new_items?: LLMMessage[];
}

function cloneMessage(m: LLMMessage): LLMMessage {
    return {
        role: m.role,
        content: m.content,
        ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
        ...(m.toolCallsMeta !== undefined ? { toolCallsMeta: m.toolCallsMeta.map((tc) => ({ ...tc, args: { ...tc.args } })) } : {}),
        ...(m.thinking !== undefined ? { thinking: m.thinking } : {}),
    };
}

export class RunResult {
    readonly messages: LLMMessage[];
    readonly task: string;
    readonly status: AgentStatus;
    readonly finalOutput: unknown;
    readonly result: string;
    readonly iterations: number;
    readonly maxIterations: number;
    readonly toolCalls: number;
    readonly trajectoryFile?: string;
    readonly sessionFile?: string;
    readonly interruptions: Array<Record<string, unknown>>;
    readonly newItems: LLMMessage[];

    constructor(init: {
        messages: LLMMessage[];
        task: string;
        status: AgentStatus;
        finalOutput: unknown;
        result: string;
        iterations: number;
        maxIterations: number;
        toolCalls: number;
        trajectoryFile?: string;
        sessionFile?: string;
        interruptions?: Array<Record<string, unknown>>;
        newItems?: LLMMessage[];
    }) {
        this.messages = init.messages.map(cloneMessage);
        this.task = init.task;
        this.status = init.status;
        this.finalOutput = init.finalOutput;
        this.result = init.result;
        this.iterations = init.iterations;
        this.maxIterations = init.maxIterations;
        this.toolCalls = init.toolCalls;
        this.trajectoryFile = init.trajectoryFile;
        this.sessionFile = init.sessionFile;
        this.interruptions = init.interruptions ?? [];
        this.newItems = (init.newItems ?? init.messages).map(cloneMessage);
    }

    static fromAgentState(state: AgentState, opts: { newItems?: LLMMessage[]; interruptions?: Array<Record<string, unknown>> } = {}): RunResult {
        return new RunResult({
            messages: state.messages,
            task: state.currentTask,
            status: state.status,
            finalOutput: state.finalOutput ?? state.result,
            result: state.result,
            iterations: state.iterations,
            maxIterations: state.maxIterations,
            toolCalls: state.toolCalls,
            trajectoryFile: state.trajectoryFile,
            sessionFile: state.sessionFile,
            interruptions: opts.interruptions,
            newItems: opts.newItems,
        });
    }

    static fromState(state: RunResultState): RunResult {
        return new RunResult({
            messages: state.messages,
            task: state.task,
            status: state.status,
            finalOutput: state.final_output,
            result: state.result,
            iterations: state.iterations,
            maxIterations: state.max_iterations,
            toolCalls: state.tool_calls,
            trajectoryFile: state.trajectory_file,
            sessionFile: state.session_file,
            interruptions: state.interruptions,
            newItems: state.new_items,
        });
    }

    toState(): RunResultState {
        return {
            messages: this.messages.map(cloneMessage),
            task: this.task,
            status: this.status,
            final_output: this.finalOutput,
            result: this.result,
            iterations: this.iterations,
            max_iterations: this.maxIterations,
            tool_calls: this.toolCalls,
            trajectory_file: this.trajectoryFile,
            session_file: this.sessionFile,
            interruptions: this.interruptions.map((x) => ({ ...x })),
            new_items: this.newItems.map(cloneMessage),
        };
    }

    async resumeInto(session: Session): Promise<void> {
        await session.addItems(this.messages);
    }
}
