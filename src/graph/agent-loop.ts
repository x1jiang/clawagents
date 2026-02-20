/**
 * ClawAgents State-Graph Engine
 *
 * A custom state-graph executor inspired by deepagents' langgraph DAG.
 * Now with tool support: the Act node can detect and execute tool calls.
 *
 * Flow: Understand -> Act (with tool loop) -> Verify -> (loop or done)
 */

import type { LLMProvider, LLMMessage } from "../providers/llm.js";
import type { ToolRegistry } from "../tools/registry.js";

// ─── State ─────────────────────────────────────────────────────────────────

export type AgentStatus = "understanding" | "acting" | "verifying" | "done" | "error";

export interface AgentState {
    messages: LLMMessage[];
    currentTask: string;
    status: AgentStatus;
    result: string;
    iterations: number;
    maxIterations: number;
    toolCalls: number;
}

// ─── System Prompt (ported from deepagents BASE_AGENT_PROMPT) ──────────────

const BASE_SYSTEM_PROMPT = `You are a ClawAgent, an AI assistant that helps users accomplish tasks using tools. You respond with text and tool calls.

## Core Behavior
- Be concise and direct. Don't over-explain unless asked.
- NEVER add unnecessary preamble ("Sure!", "Great question!", "I'll now...").
- If the request is ambiguous, ask questions before acting.

## Doing Tasks
When the user asks you to do something:
1. **Understand first** — read relevant files, check existing patterns.
2. **Act** — use tools to implement the solution. Work quickly but accurately.
3. **Verify** — check your work against what was asked, not against your own output.

Keep working until the task is fully complete.`;

// ─── Node Functions ────────────────────────────────────────────────────────

async function understandNode(
    state: AgentState,
    llm: LLMProvider,
    toolDesc: string,
): Promise<AgentState> {
    console.log(`  [Understand] Analyzing task: "${state.currentTask}"`);

    const messages: LLMMessage[] = [
        { role: "system", content: BASE_SYSTEM_PROMPT + "\n\n" + toolDesc },
        ...state.messages,
        {
            role: "user",
            content: `Analyze this task and create a brief plan of action. Task: "${state.currentTask}". List the tools you'll use and in what order. Be concise (2-3 sentences).`,
        },
    ];

    const response = await llm.chat(messages, {
        onChunk: (chunk) => process.stdout.write(chunk)
    });
    console.log(); // Add newline after stream ends

    return {
        ...state,
        messages: [
            ...state.messages,
            { role: "assistant", content: `[Understanding] ${response.content}` },
        ],
        status: "acting",
    };
}

const MAX_TOOL_CALLS_PER_ACT = 5;

async function actNode(
    state: AgentState,
    llm: LLMProvider,
    tools: ToolRegistry,
    toolDesc: string,
): Promise<AgentState> {
    console.log("  [Act] Executing planned actions...");

    let messages: LLMMessage[] = [
        { role: "system", content: BASE_SYSTEM_PROMPT + "\n\n" + toolDesc },
        ...state.messages,
        {
            role: "user",
            content:
                "Now execute the task using tools. If a tool is needed, respond with ONLY the JSON tool call block. If no tools are needed, provide the final result directly.",
        },
    ];

    let currentMessages = [...state.messages];
    let totalToolCalls = state.toolCalls;
    let lastResult = "";

    // Tool execution loop — the agent can call multiple tools in sequence
    for (let i = 0; i < MAX_TOOL_CALLS_PER_ACT; i++) {
        const response = await llm.chat(messages, {
            onChunk: (chunk) => process.stdout.write(chunk)
        });
        console.log(); // Add newline after stream ends
        const toolCall = tools.parseToolCall(response.content);

        if (!toolCall) {
            // No tool call — this is the final answer
            lastResult = response.content;
            currentMessages.push({
                role: "assistant",
                content: `[Action] ${response.content}`,
            });
            break;
        }

        // Execute the tool
        console.log(`    -> Tool: ${toolCall.toolName}(${JSON.stringify(toolCall.args)})`);
        const toolResult = await tools.executeTool(toolCall.toolName, toolCall.args);
        totalToolCalls++;

        const toolOutput = toolResult.success
            ? toolResult.output
            : `Error: ${toolResult.error}`;
        console.log(`    <- ${toolResult.success ? "OK" : "FAIL"}: ${toolOutput.slice(0, 100)}...`);

        // Add tool call and result to conversation
        currentMessages.push({
            role: "assistant",
            content: `[Tool Call] ${toolCall.toolName}: ${JSON.stringify(toolCall.args)}`,
        });
        currentMessages.push({
            role: "user",
            content: `[Tool Result] ${toolOutput}`,
        });

        // Update messages for next iteration
        messages = [
            { role: "system", content: BASE_SYSTEM_PROMPT + "\n\n" + toolDesc },
            ...currentMessages,
            {
                role: "user",
                content:
                    "Continue executing. Use another tool if needed, or provide the final result if done.",
            },
        ];

        lastResult = toolOutput;
    }

    return {
        ...state,
        messages: currentMessages,
        result: lastResult,
        status: "verifying",
        toolCalls: totalToolCalls,
    };
}

async function verifyNode(
    state: AgentState,
    llm: LLMProvider,
    toolDesc: string,
): Promise<AgentState> {
    console.log("  [Verify] Checking results...");

    const messages: LLMMessage[] = [
        { role: "system", content: BASE_SYSTEM_PROMPT },
        ...state.messages,
        {
            role: "user",
            content: `Verify the quality of the result. Is the task complete and correct? Reply with ONLY "PASS" if the result is satisfactory, or "RETRY: <reason>" if it needs improvement.`,
        },
    ];

    const response = await llm.chat(messages, {
        onChunk: (chunk) => process.stdout.write(chunk)
    });
    console.log(); // Add newline after stream ends
    const verdict = response.content.trim();

    if (verdict.startsWith("PASS") || state.iterations >= state.maxIterations) {
        return { ...state, status: "done", iterations: state.iterations + 1 };
    }

    console.log(`  [Verify] Needs improvement: ${verdict}`);
    return {
        ...state,
        messages: [
            ...state.messages,
            { role: "assistant", content: `[Verification] ${verdict}` },
        ],
        status: "understanding",
        iterations: state.iterations + 1,
    };
}

// ─── Graph Executor ────────────────────────────────────────────────────────

export async function runAgentGraph(
    task: string,
    llm: LLMProvider,
    tools?: ToolRegistry,
    maxIterations = 3,
): Promise<AgentState> {
    const toolDesc = tools?.describeForLLM() ?? "";

    let state: AgentState = {
        messages: [{ role: "user", content: task }],
        currentTask: task,
        status: "understanding",
        result: "",
        iterations: 0,
        maxIterations,
        toolCalls: 0,
    };

    console.log(`\n🦞 ClawAgent starting task: "${task}"`);
    console.log(`   Provider: ${llm.name} | Max iterations: ${maxIterations}`);
    console.log(`   Tools: ${tools ? tools.list().map((t) => t.name).join(", ") : "none"}\n`);

    while (state.status !== "done" && state.status !== "error") {
        try {
            switch (state.status) {
                case "understanding":
                    state = await understandNode(state, llm, toolDesc);
                    break;
                case "acting":
                    state = await actNode(state, llm, tools ?? new (await import("../tools/registry.js")).ToolRegistry(), toolDesc);
                    break;
                case "verifying":
                    state = await verifyNode(state, llm, toolDesc);
                    break;
                default:
                    state = { ...state, status: "error", result: `Unknown status: ${state.status}` };
            }
        } catch (err) {
            console.error(`  Error in ${state.status} node:`, err);
            state = { ...state, status: "error", result: String(err) };
        }
    }

    console.log(`\n🦞 ClawAgent finished. Status: ${state.status} | Tool calls: ${state.toolCalls}`);
    return state;
}
