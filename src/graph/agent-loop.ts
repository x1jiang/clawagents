/**
 * ClawAgents ReAct Agent Loop
 *
 * Single-loop ReAct executor inspired by deepagents/openclaw architecture.
 * Eliminates the separate Understand/Verify phases that added 2 unnecessary
 * LLM round-trips per iteration.
 *
 * Flow: LLM → tool calls → LLM → tool calls → ... → final text answer
 *
 * Robustness features retained:
 *   - Tool loop detection
 *   - Context-window guard with auto-compaction
 *   - Parallel tool execution
 *   - Tool-output truncation
 *   - Structured event callbacks (onEvent)
 *
 * Efficiency features (learned from deepagents/openclaw):
 *   - Adaptive token estimation multiplier (auto-calibrates after overflow)
 *   - Tool argument truncation in older messages (saves tokens)
 *   - Single-pass message filtering
 */

import type { LLMProvider, LLMMessage, StreamOptions, LLMResponse, NativeToolSchema } from "../providers/llm.js";
import type { ToolRegistry, ParsedToolCall } from "../tools/registry.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ─── Dangling Tool Call Repair (learned from deepagents) ──────────────────
// When native function calling is used and the agent loop is interrupted mid-execution,
// the next LLM call sees tool_calls without matching tool results — most APIs reject this.
// This pass inserts synthetic "cancelled" responses for any dangling tool calls.

function patchDanglingToolCalls(messages: LLMMessage[]): LLMMessage[] {
    if (messages.length === 0) return messages;

    const patched: LLMMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        patched.push(msg);

        // Look for assistant messages that contain JSON tool calls without a following [Tool Result]
        if (msg.role === "assistant" && msg.content.startsWith('{"tool":')) {
            const hasResult = i + 1 < messages.length &&
                messages[i + 1]!.role === "user" &&
                messages[i + 1]!.content.startsWith("[Tool Result]");
            if (!hasResult) {
                patched.push({
                    role: "user",
                    content: "[Tool Result] Tool call was cancelled — the agent was interrupted before it could complete.",
                });
            }
        }
    }
    return patched;
}

// ─── Tool Result Eviction (learned from deepagents) ───────────────────────
// When tool output exceeds a threshold, write the full result to a file and
// replace it with a head/tail preview + file path, preserving data without
// bloating the context window.

const EVICTION_CHARS_THRESHOLD = 80_000; // ~20K tokens at 4 chars/token
const EVICTION_DIR = resolve(process.cwd(), ".clawagents", "large_results");

function createContentPreview(content: string, headLines = 5, tailLines = 5): string {
    const lines = content.split("\n");
    if (lines.length <= headLines + tailLines + 2) return content;

    const head = lines.slice(0, headLines).map((l, i) => `${i + 1}: ${l}`).join("\n");
    const tail = lines.slice(-tailLines).map((l, i) => `${lines.length - tailLines + i + 1}: ${l}`).join("\n");
    const omitted = lines.length - headLines - tailLines;
    return `${head}\n... [${omitted} lines truncated] ...\n${tail}`;
}

function evictLargeToolResult(toolName: string, output: string): string {
    if (output.length < EVICTION_CHARS_THRESHOLD) return output;

    try {
        mkdirSync(EVICTION_DIR, { recursive: true });
        const ts = Date.now();
        const sanitized = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
        const filePath = resolve(EVICTION_DIR, `${sanitized}_${ts}.txt`);
        writeFileSync(filePath, output, "utf-8");

        const preview = createContentPreview(output);
        return (
            `[Result too large (${output.length} chars) — saved to ${filePath}]\n` +
            `Use read_file to access the full result. Preview:\n\n${preview}`
        );
    } catch {
        // If eviction fails, fall back to simple truncation
        return output.slice(0, EVICTION_CHARS_THRESHOLD) + "\n...(output truncated)";
    }
}

// ─── Model-Aware Context Budget (learned from deepagents) ─────────────────
// Uses known model context windows to set fraction-based triggers instead of
// a single fixed ratio.

interface ModelProfile {
    maxInputTokens: number;
    budgetRatio: number;
}

const MODEL_PROFILES: Record<string, ModelProfile> = {
    // OpenAI
    "gpt-5": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    "gpt-5-mini": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    "gpt-5-nano": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    "gpt-4o": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    "gpt-4o-mini": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    // Gemini
    "gemini-3-flash": { maxInputTokens: 1_000_000, budgetRatio: 0.90 },
    "gemini-3-flash-preview": { maxInputTokens: 1_000_000, budgetRatio: 0.90 },
    "gemini-2.5-flash": { maxInputTokens: 1_000_000, budgetRatio: 0.90 },
    "gemini-2.5-pro": { maxInputTokens: 1_000_000, budgetRatio: 0.90 },
    // Claude
    "claude-sonnet-4-5": { maxInputTokens: 200_000, budgetRatio: 0.85 },
    "claude-3-5-sonnet": { maxInputTokens: 200_000, budgetRatio: 0.85 },
};

function resolveContextBudget(modelName: string, contextWindow: number): { window: number; ratio: number } {
    // Try exact match, then prefix match
    const profile = MODEL_PROFILES[modelName] ??
        Object.entries(MODEL_PROFILES).find(([k]) => modelName.startsWith(k))?.[1];

    if (profile) {
        return { window: profile.maxInputTokens, ratio: profile.budgetRatio };
    }
    return { window: contextWindow, ratio: 0.75 };
}

// ─── State ─────────────────────────────────────────────────────────────────

export type AgentStatus = "running" | "done" | "error";

export interface AgentState {
    messages: LLMMessage[];
    currentTask: string;
    status: AgentStatus;
    result: string;
    iterations: number;
    maxIterations: number;
    toolCalls: number;
}

// ─── Event System ─────────────────────────────────────────────────────────

export type EventKind =
    | "tool_call"
    | "tool_result"
    | "retry"
    | "agent_done"
    | "warn"
    | "error"
    | "context"
    | "final_content"
    | "approval_required"
    | "tool_skipped";

export type OnEvent = (kind: EventKind, data: Record<string, unknown>) => void;

// ─── Hook Types ───────────────────────────────────────────────────────────

export type BeforeLLMHook = (messages: LLMMessage[]) => LLMMessage[];
export type BeforeToolHook = (toolName: string, args: Record<string, unknown>) => boolean;
export type AfterToolHook = (toolName: string, args: Record<string, unknown>, result: import("../tools/registry.js").ToolResult) => import("../tools/registry.js").ToolResult;

function defaultOnEvent(kind: EventKind, data: Record<string, unknown>): void {
    switch (kind) {
        case "tool_call":
            process.stderr.write(`🔧 ${data.name}\n`);
            break;
        case "retry":
            process.stderr.write(`[retry] ${data.reason}\n`);
            break;
        case "agent_done":
            process.stderr.write(
                `\n✓ ${data.tool_calls} tool calls · ${data.iterations} iterations · ${(data.elapsed as number).toFixed(1)}s\n`,
            );
            break;
        case "final_content":
            process.stdout.write(data.content as string);
            process.stdout.write("\n");
            break;
        case "warn":
            process.stderr.write(`[warn] ${data.message}\n`);
            break;
        case "error":
            process.stderr.write(`[error] ${data.phase}: ${data.message}\n`);
            break;
        case "context":
            process.stderr.write(`[context] ${data.message}\n`);
            break;
    }
}

// ─── System Prompt ─────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are a ClawAgent, an AI assistant that helps users accomplish tasks using tools. You respond with text and tool calls.

## Core Behavior
- Be concise and direct. Don't over-explain unless asked.
- NEVER add unnecessary preamble ("Sure!", "Great question!", "I'll now...").
- If the request is ambiguous, ask questions before acting.

## Doing Tasks
When the user asks you to do something:
1. Think briefly about your approach, then act immediately using tools.
2. After getting tool results, continue using more tools or provide the final answer.
3. When done, provide the final answer directly. Do NOT ask if the user wants more.

Keep working until the task is fully complete.`;

// ─── Adaptive Token Estimation (learned from deepagents) ──────────────────

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string, multiplier: number): number {
    return Math.ceil((text.length / CHARS_PER_TOKEN) * multiplier);
}

function estimateMessagesTokens(messages: LLMMessage[], multiplier: number): number {
    let total = 0;
    for (const m of messages) total += estimateTokens(m.content, multiplier);
    return total;
}

// ─── Tool Argument Truncation in Old Messages (learned from deepagents) ───

const MAX_ARG_LENGTH = 2000;
const ARG_TRUNCATION_MARKER = "...(argument truncated)";
const RECENT_PROTECTED_COUNT = 20;
const TRUNCATABLE_RE = /\{"tool":\s*"(write_file|edit_file|create_file)".*?"args":\s*\{/;

function truncateOldToolArgs(messages: LLMMessage[], protectRecent: number): LLMMessage[] {
    if (messages.length <= protectRecent) return messages;

    const cutoff = messages.length - protectRecent;
    const result: LLMMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (i < cutoff && m.role === "assistant" && TRUNCATABLE_RE.test(m.content)) {
            if (m.content.length > MAX_ARG_LENGTH) {
                result.push({
                    role: m.role,
                    content: m.content.slice(0, MAX_ARG_LENGTH) + ARG_TRUNCATION_MARKER,
                });
                continue;
            }
        }
        result.push(m);
    }
    return result;
}

// ─── Tool Loop Detection ──────────────────────────────────────────────────

export function stableStringify(obj: unknown): string {
    try {
        return JSON.stringify(obj, (_key, value) => {
            if (value && typeof value === "object" && !Array.isArray(value)) {
                return Object.keys(value).sort().reduce((acc: Record<string, unknown>, k) => {
                    acc[k] = value[k];
                    return acc;
                }, {});
            }
            return value;
        });
    } catch {
        return String(obj);
    }
}

export class ToolCallTracker {
    private history: string[] = [];

    constructor(
        private windowSize = 12,
        private maxRepeats = 3,
    ) { }

    record(toolName: string, args: Record<string, unknown>): void {
        this.history.push(`${toolName}:${stableStringify(args)}`);
        if (this.history.length > this.windowSize) this.history.shift();
    }

    isLooping(toolName: string, args: Record<string, unknown>): boolean {
        const key = `${toolName}:${stableStringify(args)}`;
        return this.history.filter((h) => h === key).length >= this.maxRepeats;
    }

    isLoopingBatch(calls: ParsedToolCall[]): boolean {
        return calls.some((c) => this.isLooping(c.toolName, c.args));
    }

    recordBatch(calls: ParsedToolCall[]): void {
        for (const c of calls) this.record(c.toolName, c.args);
    }
}

// ─── Context Window Guard with Auto-Compaction ────────────────────────────

const CONTEXT_BUDGET_RATIO = 0.75; // fallback; overridden by model-aware budget
const RECENT_MESSAGES_TO_KEEP = 6;

async function compactIfNeeded(
    messages: LLMMessage[],
    contextWindow: number,
    llm: LLMProvider,
    emit: OnEvent,
    tokenMultiplier: number,
): Promise<LLMMessage[]> {
    // Phase 1: truncate tool args in older messages (cheap, no LLM call)
    messages = truncateOldToolArgs(messages, RECENT_PROTECTED_COUNT);

    const budget = Math.floor(contextWindow * CONTEXT_BUDGET_RATIO);
    const currentTokens = estimateMessagesTokens(messages, tokenMultiplier);

    if (currentTokens <= budget) return messages;

    emit("context", { message: `~${currentTokens} tokens exceeds budget ${budget} — compacting` });

    // Single-pass split
    const systemMessages: LLMMessage[] = [];
    const nonSystem: LLMMessage[] = [];
    for (const m of messages) {
        (m.role === "system" ? systemMessages : nonSystem).push(m);
    }

    if (nonSystem.length <= RECENT_MESSAGES_TO_KEEP) return messages;

    const recentCount = Math.min(RECENT_MESSAGES_TO_KEEP, nonSystem.length);
    const older = nonSystem.slice(0, -recentCount);
    const recent = nonSystem.slice(-recentCount);

    const parts: string[] = [];
    for (const m of older) parts.push(`[${m.role.toUpperCase()}]: ${m.content}`);
    const textLog = parts.join("\n\n");

    const summaryPrompt =
        "Compress the following agent conversation history into a concise summary. " +
        "Keep key facts, file paths, errors, and tool results. Be brief.\n\n" +
        textLog;

    // Phase 8: Offload full history before summarizing
    const offloadPath = offloadHistory(older);
    if (offloadPath) {
        emit("context", { message: `offloaded ${older.length} messages to ${offloadPath}` });
    }

    try {
        const resp = await llm.chat([{ role: "user", content: summaryPrompt }]);
        if (!resp.content.trim()) {
            emit("context", { message: "compaction returned empty summary — dropping oldest" });
            return [...systemMessages, ...recent];
        }
        const summary: LLMMessage = {
            role: "assistant",
            content: `[Compacted History] ${resp.content}`,
        };
        emit("context", { message: `compacted ${older.length} messages into summary` });
        return [...systemMessages, summary, ...recent];
    } catch {
        emit("context", { message: "compaction failed — dropping oldest messages" });
        return [...systemMessages, ...recent];
    }
}

// ─── History Offloading ───────────────────────────────────────────────────

const HISTORY_DIR = resolve(process.cwd(), ".clawagents", "history");

function offloadHistory(messages: LLMMessage[]): string | null {
    try {
        mkdirSync(HISTORY_DIR, { recursive: true });
        const ts = Date.now();
        const path = resolve(HISTORY_DIR, `compacted_${ts}_${messages.length}msgs.json`);
        const data = messages.map((m) => ({ role: m.role, content: m.content }));
        writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
        return path;
    } catch {
        return null;
    }
}

// ─── ReAct Loop ───────────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 15;

export async function runAgentGraph(
    task: string,
    llm: LLMProvider,
    tools?: ToolRegistry,
    systemPrompt?: string,
    maxIterations = MAX_TOOL_ROUNDS,
    streaming = true,
    contextWindow = 128_000,
    onEvent?: OnEvent,
    beforeLLM?: BeforeLLMHook,
    beforeTool?: BeforeToolHook,
    afterTool?: AfterToolHook,
    useNativeTools = false,
): Promise<AgentState> {
    const registry = tools;
    const nativeSchemas: NativeToolSchema[] | undefined =
        useNativeTools && registry ? registry.toNativeSchemas() : undefined;
    const toolDesc = (!useNativeTools && registry) ? registry.describeForLLM() : "";
    const loopTracker = new ToolCallTracker();
    const emit = onEvent ?? defaultOnEvent;

    let tokenMultiplier = 1.0;

    const promptToUse = systemPrompt || BASE_SYSTEM_PROMPT;

    let messages: LLMMessage[] = [
        { role: "system", content: promptToUse + "\n\n" + toolDesc },
        { role: "user", content: task },
    ];

    const state: AgentState = {
        messages,
        currentTask: task,
        status: "running",
        result: "",
        iterations: 0,
        maxIterations,
        toolCalls: 0,
    };

    const ac = new AbortController();
    const onSigint = () => {
        emit("warn", { message: "interrupted" });
        ac.abort();
    };
    process.on("SIGINT", onSigint);

    const effectiveMaxRounds = Math.min(
        maxIterations > 0 ? maxIterations : MAX_TOOL_ROUNDS,
        MAX_TOOL_ROUNDS,
    );

    const t0 = Date.now();

    try {
        for (let roundIdx = 0; roundIdx < effectiveMaxRounds; roundIdx++) {
            if (ac.signal.aborted) {
                state.status = "done";
                state.result = state.result || "[cancelled]";
                break;
            }

            // Patch dangling tool calls before sending to LLM
            messages = patchDanglingToolCalls(messages);
            messages = await compactIfNeeded(messages, contextWindow, llm, emit, tokenMultiplier);

            if (beforeLLM) {
                try {
                    const hooked = beforeLLM(messages);
                    if (Array.isArray(hooked) && hooked.length > 0) messages = hooked;
                    else emit("warn", { message: "beforeLLM returned invalid value — ignored" });
                } catch (hookErr) { emit("warn", { message: `beforeLLM hook error: ${hookErr}` }); }
            }

            let response: LLMResponse;
            try {
                const buf: string[] = [];
                const chatOptions: StreamOptions | undefined = streaming
                    ? { onChunk: (chunk: string) => buf.push(chunk), signal: ac.signal, tools: nativeSchemas }
                    : nativeSchemas ? { tools: nativeSchemas } : undefined;
                response = await llm.chat(messages, chatOptions);
            } catch (err) {
                const errMsg = String(err);
                if (errMsg.toLowerCase().includes("context") || errMsg.toLowerCase().includes("token")) {
                    const observedRatio = contextWindow / Math.max(estimateMessagesTokens(messages, 1.0), 1);
                    tokenMultiplier = Math.min(observedRatio * 1.1, 3.0);
                    emit("context", { message: `token overflow — calibrated multiplier to ${tokenMultiplier.toFixed(2)}` });
                    messages = await compactIfNeeded(messages, contextWindow, llm, emit, tokenMultiplier);
                    continue;
                }
                emit("error", { phase: "llm_call", message: errMsg });
                state.status = "error";
                state.result = errMsg;
                break;
            }

            if (response.partial && !response.content.trim()) {
                emit("warn", { message: "interrupted — no content received" });
                state.status = "done";
                state.result = state.result || "[interrupted]";
                break;
            }

            // Use exclusively native or text-based tool calls based on user-provided mode
            const toolCalls = useNativeTools
                ? (response.toolCalls?.map((tc) => ({ toolName: tc.toolName, args: tc.args })) ?? [])
                : (registry?.parseToolCalls(response.content) ?? []);

            if (toolCalls.length === 0) {
                state.result = response.content;
                state.status = "done";
                state.iterations += 1;
                emit("final_content", { content: response.content });
                messages.push({ role: "assistant", content: response.content });
                break;
            }

            if (loopTracker.isLoopingBatch(toolCalls)) {
                const names = toolCalls.map((c) => c.toolName).join(", ");
                emit("warn", { message: `tool loop detected (${names}) — breaking` });
                state.status = "done";
                state.result = `Tool loop detected (${names}). Stopping.`;
                state.iterations += 1;
                break;
            }

            if (toolCalls.length === 1) {
                const call = toolCalls[0]!;
                emit("tool_call", { name: call.toolName });

                if (beforeTool) {
                    let approved = false;
                    try { approved = !!beforeTool(call.toolName, call.args); }
                    catch (hookErr) { emit("warn", { message: `beforeTool hook error: ${hookErr}` }); }
                    if (!approved) {
                        emit("tool_skipped", { name: call.toolName });
                        messages.push({ role: "assistant", content: `{"tool": "${call.toolName}", "args": ${JSON.stringify(call.args)}}` });
                        messages.push({ role: "user", content: `[Tool Skipped] ${call.toolName} was not approved.` });
                        continue;
                    }
                }

                loopTracker.record(call.toolName, call.args);

                let toolResult = await registry!.executeTool(call.toolName, call.args);
                state.toolCalls++;

                if (afterTool) {
                    try {
                        const hooked = afterTool(call.toolName, call.args, toolResult);
                        if (hooked && typeof hooked.success === "boolean" && typeof hooked.output === "string") {
                            toolResult = hooked;
                        } else { emit("warn", { message: "afterTool returned invalid ToolResult — ignored" }); }
                    } catch (hookErr) { emit("warn", { message: `afterTool hook error: ${hookErr}` }); }
                }

                const rawOutput = toolResult.success
                    ? toolResult.output
                    : `Error: ${toolResult.error}`;
                const toolOutput = evictLargeToolResult(call.toolName, rawOutput);

                emit("tool_result", {
                    name: call.toolName,
                    success: toolResult.success,
                    preview: toolOutput.slice(0, 120),
                });

                messages.push({
                    role: "assistant",
                    content: `{"tool": "${call.toolName}", "args": ${JSON.stringify(call.args)}}`,
                });
                messages.push({
                    role: "user",
                    content: `[Tool Result] ${toolOutput}`,
                });
            } else {
                let approvedCalls = toolCalls;
                if (beforeTool) {
                    approvedCalls = toolCalls.filter((call) => {
                        let approved = false;
                        try { approved = !!beforeTool(call.toolName, call.args); }
                        catch (hookErr) { emit("warn", { message: `beforeTool hook error: ${hookErr}` }); }
                        if (!approved) emit("tool_skipped", { name: call.toolName });
                        else emit("tool_call", { name: call.toolName });
                        return approved;
                    });
                } else {
                    for (const call of toolCalls) {
                        emit("tool_call", { name: call.toolName });
                    }
                }

                if (approvedCalls.length === 0) {
                    messages.push({ role: "user", content: "[All tools were rejected by approval hook]" });
                    continue;
                }

                loopTracker.recordBatch(approvedCalls);

                const results = await registry!.executeToolsParallel(approvedCalls);
                state.toolCalls += approvedCalls.length;

                const callSummaries: string[] = [];
                for (let j = 0; j < approvedCalls.length; j++) {
                    const call = approvedCalls[j]!;
                    let result = results[j]!;
                    if (afterTool) {
                        try {
                            const hooked = afterTool(call.toolName, call.args, result);
                            if (hooked && typeof hooked.success === "boolean" && typeof hooked.output === "string") {
                                result = hooked;
                            } else { emit("warn", { message: "afterTool returned invalid ToolResult — ignored" }); }
                        } catch (hookErr) { emit("warn", { message: `afterTool hook error: ${hookErr}` }); }
                    }
                    const rawOut = result.success ? result.output : `Error: ${result.error}`;
                    const output = evictLargeToolResult(call.toolName, rawOut);
                    emit("tool_result", {
                        name: call.toolName,
                        success: result.success,
                        preview: output.slice(0, 120),
                    });
                    callSummaries.push(`${call.toolName}(${JSON.stringify(call.args)}) => ${output}`);
                }

                const toolCallStr = JSON.stringify(
                    approvedCalls.map((c) => ({ tool: c.toolName, args: c.args })),
                );
                messages.push({ role: "assistant", content: toolCallStr });
                messages.push({
                    role: "user",
                    content: `[Tool Results]\n${callSummaries.join("\n")}`,
                });
            }
        }

        if (state.status === "running") {
            emit("warn", { message: `reached max ${effectiveMaxRounds} tool rounds` });
            state.status = "done";
            state.result = state.result || `Reached maximum of ${effectiveMaxRounds} tool rounds.`;
            state.iterations += 1;
        }
    } catch (err) {
        emit("error", { phase: "agent_loop", message: String(err) });
        state.status = "error";
        state.result = String(err);
    } finally {
        process.off("SIGINT", onSigint);
    }

    const elapsed = (Date.now() - t0) / 1000;
    state.messages = messages;
    emit("agent_done", {
        tool_calls: state.toolCalls,
        iterations: state.iterations,
        elapsed,
    });
    return state;
}
