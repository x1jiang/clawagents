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
import { stripThinkingTokens } from "../providers/llm.js";
import type { ToolRegistry, ParsedToolCall } from "../tools/registry.js";
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { setOverrides } from "../config/features.js";

// ─── Model Control Token Sanitization ─────────────────────────────────────
// Strip leaked model control tokens from assistant text (GLM-5, DeepSeek, etc.)
const MODEL_CONTROL_TOKEN_RE = /<[｜|][^>]*?[｜|]>/g;

function sanitizeAssistantText(text: string): string {
    return text.replace(MODEL_CONTROL_TOKEN_RE, "").trim();
}

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
        if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.startsWith('{"tool":')) {
            const hasResult = i + 1 < messages.length &&
                messages[i + 1]!.role === "user" &&
                typeof messages[i + 1]!.content === "string" &&
                (messages[i + 1]!.content as string).startsWith("[Tool Result]");
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
function getEvictionDir(): string {
    return resolve(process.cwd(), ".clawagents", "large_results");
}

const PREVIEW_MAX_CHARS = 2000;

function createContentPreview(content: string, headLines = 5, tailLines = 5): string {
    const lines = content.split("\n");
    if (lines.length <= headLines + tailLines + 2 && content.length <= PREVIEW_MAX_CHARS) return content;

    if (lines.length <= headLines + tailLines + 2) {
        const half = Math.floor(PREVIEW_MAX_CHARS / 2);
        return content.slice(0, half) +
            `\n... [${content.length - PREVIEW_MAX_CHARS} chars truncated] ...\n` +
            content.slice(-half);
    }

    const head = lines.slice(0, headLines).map((l, i) => `${i + 1}: ${l}`).join("\n");
    const tail = lines.slice(-tailLines).map((l, i) => `${lines.length - tailLines + i + 1}: ${l}`).join("\n");
    const omitted = lines.length - headLines - tailLines;
    return `${head}\n... [${omitted} lines truncated] ...\n${tail}`;
}

function evictLargeToolResult(toolName: string, output: string): string {
    if (output.length < EVICTION_CHARS_THRESHOLD) return output;

    try {
        const evictionDir = getEvictionDir();
        mkdirSync(evictionDir, { recursive: true });
        const ts = Date.now();
        const sanitized = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
        const filePath = resolve(evictionDir, `${sanitized}_${ts}.txt`);
        writeFileSync(filePath, output, "utf-8");

        const preview = createContentPreview(output);
        return (
            `[Result too large (${output.length} chars) — saved to ${filePath}]\n` +
            `Use read_file to access the full result. Preview:\n\n${preview}`
        );
    } catch {
        // If eviction fails, fall back to head+tail truncation
        const half = Math.floor(EVICTION_CHARS_THRESHOLD / 2);
        return output.slice(0, half) +
            `\n\n... [truncated ${output.length - EVICTION_CHARS_THRESHOLD} chars] ...\n\n` +
            output.slice(-half);
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
    trajectoryFile?: string;
    sessionFile?: string;
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

Keep working until the task is fully complete.

## Efficiency Rules
- NEVER re-read a file you already have in context. Use the data from previous tool results.
- NEVER call the same tool with the same arguments twice. If you already have the result, use it.
- Batch independent tool calls into a single response when possible (use the array syntax).
- Prefer fewer, well-targeted tool calls over many exploratory ones.`;

// ─── Adaptive Token Estimation (learned from deepagents) ──────────────────
// Now uses js-tiktoken for accurate BPE counting (with fallback to heuristic).

import {
    initTokenizer,
    countTokensContent,
    countMessagesTokens,
    CHARS_PER_TOKEN_FALLBACK,
} from "../tokenizer.js";

// Keep CHARS_PER_TOKEN for the Tier-3 preflight char-budget calculation only
const CHARS_PER_TOKEN = CHARS_PER_TOKEN_FALLBACK;

function estimateTokens(text: string | any[], multiplier: number, model?: string): number {
    return countTokensContent(text, model, multiplier);
}

function estimateMessagesTokens(messages: LLMMessage[], multiplier: number, model?: string): number {
    return countMessagesTokens(messages, model, multiplier);
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
        if (i < cutoff && m.role === "assistant" && typeof m.content === "string" && TRUNCATABLE_RE.test(m.content)) {
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
    private resultHashes = new Map<string, string>();
    private noProgressCount = 0;
    private softWarnings = 0;

    constructor(
        private windowSize = 30,
        private softLimit = 3,
        private hardLimit = 6,
        private circuitBreakerLimit = 30,
    ) { }

    private hashResult(output: string): string {
        const sample = output.slice(0, 500);
        let hash = 0;
        for (let i = 0; i < sample.length; i++) {
            hash = ((hash << 5) - hash + sample.charCodeAt(i)) | 0;
        }
        return String(hash);
    }

    record(toolName: string, args: Record<string, unknown>): void {
        this.history.push(`${toolName}:${stableStringify(args)}`);
        if (this.history.length > this.windowSize) this.history.shift();
    }

    /** Record the result of a tool call for no-progress detection. */
    recordResult(toolName: string, args: Record<string, unknown>, output: string): void {
        const key = `${toolName}:${stableStringify(args)}`;
        const resultHash = this.hashResult(output);
        const prevHash = this.resultHashes.get(key);
        if (prevHash === resultHash) {
            this.noProgressCount++;
        } else {
            this.noProgressCount = Math.max(0, this.noProgressCount - 1);
        }
        this.resultHashes.set(key, resultHash);
    }

    /** Detect A→B→A→B ping-pong oscillation (last 6 entries). */
    isPingPonging(): boolean {
        if (this.history.length < 4) return false;
        const recent = this.history.slice(-6);
        if (recent.length < 4) return false;
        const unique = new Set(recent);
        if (unique.size !== 2) return false;
        for (let i = 0; i < recent.length - 1; i++) {
            if (recent[i] === recent[i + 1]) return false;
        }
        return true;
    }

    /** Global circuit breaker: too many no-progress calls. */
    isCircuitBroken(): boolean {
        return this.noProgressCount >= this.circuitBreakerLimit;
    }

    private countOccurrences(toolName: string, args: Record<string, unknown>): number {
        const key = `${toolName}:${stableStringify(args)}`;
        return this.history.filter((h) => h === key).length;
    }

    /** Soft loop: repeated enough to warrant a warning nudge (injected into messages). */
    isSoftLooping(toolName: string, args: Record<string, unknown>): boolean {
        return this.countOccurrences(toolName, args) >= this.softLimit;
    }

    /** Hard loop: repeated so many times it must be stopped. */
    isHardLooping(toolName: string, args: Record<string, unknown>): boolean {
        return this.countOccurrences(toolName, args) >= this.hardLimit;
    }

    isSoftLoopingBatch(calls: ParsedToolCall[]): boolean {
        return calls.some((c) => this.isSoftLooping(c.toolName, c.args));
    }

    isHardLoopingBatch(calls: ParsedToolCall[]): boolean {
        return calls.some((c) => this.isHardLooping(c.toolName, c.args));
    }

    recordBatch(calls: ParsedToolCall[]): void {
        for (const c of calls) this.record(c.toolName, c.args);
    }

    bumpSoftWarning(): number {
        return ++this.softWarnings;
    }
}

// ─── Consecutive Failure Detection ────────────────────────────────────────
// Tracks tool-call success/failure to detect persistent failure streaks.
// When N consecutive tool calls fail, injects a "step back and rethink"
// message — lightweight online adaptation inspired by OpenClaw-RL's
// next-state reward signal.

const RETHINK_THRESHOLD = 3;
const MAX_RETHINKS = 3;

function rethinkMessage(n: number): string {
    return (
        `[System] Your last ${n} tool calls all failed. ` +
        "Stop and reconsider your approach before trying again. " +
        "Review the errors above, think about what went wrong, " +
        "and try a fundamentally different strategy."
    );
}

const SCORELESS_TOOLS = new Set([
    "think", "todolist", "todo_write", "todo_read", "use_skill", "ask_user",
]);

class FailureTracker {
    private results: boolean[] = [];  // true = success, false = failure
    private rethinkCount = 0;
    public threshold: number;   // Feature F: mutable for adaptive threshold

    constructor(
        threshold = RETHINK_THRESHOLD,
        private maxRethinks = MAX_RETHINKS,
    ) {
        this.threshold = threshold;
    }

    record(success: boolean, toolName = ""): void {
        if (SCORELESS_TOOLS.has(toolName)) return;
        this.results.push(success);
    }

    recordBatch(entries: Array<{ success: boolean; toolName: string }>): void {
        for (const e of entries) this.record(e.success, e.toolName);
    }

    shouldRethink(): boolean {
        if (this.rethinkCount >= this.maxRethinks) return false;
        if (this.results.length < this.threshold) return false;
        return this.results.slice(-this.threshold).every((s) => !s);
    }

    get consecutiveFailures(): number {
        let count = 0;
        for (let i = this.results.length - 1; i >= 0; i--) {
            if (!this.results[i]) count++;
            else break;
        }
        return count;
    }

    bumpRethink(): number {
        this.rethinkCount++;
        this.results.length = 0;
        return this.rethinkCount;
    }
}

// ─── Pre-flight Context Guard ─────────────────────────────────────────────

const MAX_OVERFLOW_RETRIES = 3;

function preflightContextCheck(
    messages: LLMMessage[],
    contextWindow: number,
    toolDesc: string,
    nativeSchemas: NativeToolSchema[] | undefined,
    registry: ToolRegistry | undefined,
    emit: OnEvent,
    modelName?: string,
): { messages: LLMMessage[]; toolDesc: string; nativeSchemas: NativeToolSchema[] | undefined } {
    const resolved = modelName
        ? resolveContextBudget(modelName, contextWindow)
        : { window: contextWindow, ratio: CONTEXT_BUDGET_RATIO };
    const budget = Math.floor(resolved.window * resolved.ratio);

    let nativeSchemaTokens = 0;
    if (nativeSchemas) {
        const schemaText = JSON.stringify(nativeSchemas.map((s) => ({
            name: s.name, description: s.description, parameters: s.parameters,
        })));
        nativeSchemaTokens = estimateTokens(schemaText, 1.0);
    }

    const payloadTokens = () => estimateMessagesTokens(messages, 1.0) + nativeSchemaTokens;

    if (payloadTokens() <= budget) {
        return { messages, toolDesc, nativeSchemas };
    }

    emit("context", {
        message: `pre-flight: initial payload ~${payloadTokens()} tokens exceeds budget ${budget}`,
    });

    // Tier 1: Truncate parameter descriptions
    if (toolDesc && registry) {
        const shortParts = ["## Available Tools\n"];
        for (const tool of registry.list()) {
            shortParts.push(`### ${tool.name}\n${tool.description}`);
            if (tool.parameters) {
                const params = Object.entries(tool.parameters)
                    .map(([k, v]) => `\`${k}\` (${v.type || "string"}${v.required ? "*" : ""})`)
                    .join(", ");
                shortParts.push("Parameters: " + params);
            }
            shortParts.push("");
        }
        const shortDesc = shortParts.join("\n");
        const sysMsg = messages[0];
        messages = [
            { ...sysMsg, content: sysMsg.content.replace(toolDesc, shortDesc) },
            ...messages.slice(1),
        ];
        toolDesc = shortDesc;
        emit("context", { message: `tier-1: shortened tool descriptions -> ~${payloadTokens()} tokens` });
    }

    if (payloadTokens() <= budget) return { messages, toolDesc, nativeSchemas };

    // Tier 2: Drop text tool descriptions if native schemas exist
    if (toolDesc && nativeSchemas) {
        const sysMsg = messages[0];
        messages = [
            { ...sysMsg, content: sysMsg.content.replace(toolDesc, "").trim() },
            ...messages.slice(1),
        ];
        toolDesc = "";
        emit("context", { message: `tier-2: removed text tool descriptions -> ~${payloadTokens()} tokens` });
    }

    if (payloadTokens() <= budget) return { messages, toolDesc, nativeSchemas };

    // Tier 3: Truncate system prompt
    const sysContent = messages[0].content;
    const userTokens = messages.length > 1 ? estimateTokens(messages[1].content, 1.0) : 0;
    const maxSysChars = Math.floor((budget - nativeSchemaTokens - userTokens) * CHARS_PER_TOKEN * 0.8);
    if (maxSysChars > 200 && sysContent.length > maxSysChars) {
        const truncated = sysContent.slice(0, maxSysChars) + "\n\n...(system prompt truncated to fit context window)";
        messages = [{ ...messages[0], content: truncated }, ...messages.slice(1)];
        emit("context", { message: `tier-3: truncated system prompt -> ~${payloadTokens()} tokens` });
    }

    if (payloadTokens() > budget) {
        emit("warn", {
            message: `pre-flight: payload still ~${payloadTokens()} tokens after all shedding (budget ${budget}). Consider increasing CONTEXT_WINDOW or reducing tools/instruction.`,
        });
    }

    return { messages, toolDesc, nativeSchemas };
}


// ─── Micro-Compact: clear old tool results (learned from Claude Code) ─────
// Unlike soft-trim which truncates, micro-compact completely replaces old tool
// result content with a placeholder. The model still sees the tool_use →
// tool_result structure (knows *what* it did) but not the raw output.

const COMPACTABLE_TOOLS = new Set([
    "read_file", "execute", "execute_command", "bash", "run_command",
    "grep", "glob", "ls", "tree", "web_fetch", "web_search",
    "search_files", "list_dir", "find_files",
]);

const MICRO_COMPACT_KEEP_RECENT = 3;

export function microCompactToolResults(
    messages: LLMMessage[],
    keepRecent = MICRO_COMPACT_KEEP_RECENT,
): LLMMessage[] {
    // Check feature flag
    try {
        // Dynamic import not feasible in sync function — inline check
        const envVal = process.env["CLAW_FEATURE_MICRO_COMPACT"] ?? "1";
        if (!["1", "true", "yes", "on"].includes(envVal.toLowerCase())) return messages;
    } catch { /* proceed with default on */ }

    // Collect compactable tool call IDs in order
    const compactableIds: string[] = [];
    const compactableTextIndices: number[] = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        if (msg.role === "assistant") {
            // Native tool calls
            if (msg.toolCallsMeta) {
                for (const tc of msg.toolCallsMeta) {
                    if (COMPACTABLE_TOOLS.has(tc.name)) {
                        compactableIds.push(tc.id);
                    }
                }
            }
            // Text-based tool calls
            else if (typeof msg.content === "string") {
                try {
                    const parsed = JSON.parse(msg.content);
                    if (typeof parsed === "object" && parsed !== null) {
                        if (!Array.isArray(parsed) && COMPACTABLE_TOOLS.has(parsed.tool)) {
                            compactableTextIndices.push(i);
                        } else if (Array.isArray(parsed)) {
                            if (parsed.some((item: any) => COMPACTABLE_TOOLS.has(item?.tool))) {
                                compactableTextIndices.push(i);
                            }
                        }
                    }
                } catch { /* not JSON */ }
            }
        }
    }

    // Keep the most recent N compactable tool results
    const keepIds = new Set(compactableIds.slice(-keepRecent));
    const keepTextIndices = new Set(compactableTextIndices.slice(-keepRecent));

    // Clear old compactable tool results
    const result: LLMMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;

        // Native tool results
        if (msg.role === "tool" && msg.toolCallId) {
            if (compactableIds.includes(msg.toolCallId) && !keepIds.has(msg.toolCallId)) {
                result.push({
                    role: "tool",
                    content: "[Old tool result cleared to save context]",
                    toolCallId: msg.toolCallId,
                });
                continue;
            }
        }
        // Text-based tool results
        else if (msg.role === "user" && typeof msg.content === "string" && msg.content.startsWith("[Tool Result]")) {
            if (i > 0 && compactableTextIndices.includes(i - 1) && !keepTextIndices.has(i - 1)) {
                result.push({
                    role: "user",
                    content: "[Tool Result] [Old tool result cleared to save context]",
                });
                continue;
            }
        }

        result.push(msg);
    }

    return result;
}


// ─── Soft-Trim: prune stale/low-value content before compaction ───────────

const SOFT_TRIM_RATIO = 0.60;
const SOFT_TRIM_RESULT_MAX_CHARS = 1000;
const SOFT_TRIM_RESULT_KEEP_CHARS = 500;
const SOFT_TRIM_RECENT_PROTECTED = 10;

function softTrimMessages(
    messages: LLMMessage[],
    contextWindow: number,
    tokenMultiplier: number,
    emit: OnEvent,
    modelName?: string,
): LLMMessage[] {
    const { window: effectiveWindow } = modelName
        ? resolveContextBudget(modelName, contextWindow)
        : { window: contextWindow };
    const softBudget = Math.floor(effectiveWindow * SOFT_TRIM_RATIO);
    const currentTokens = estimateMessagesTokens(messages, tokenMultiplier);

    if (currentTokens <= softBudget) return messages;

    const protectFrom = Math.max(0, messages.length - SOFT_TRIM_RECENT_PROTECTED * 2);
    let trimCount = 0;
    const seen = new Map<string, number>(); // tool-call key → latest index
    const result: LLMMessage[] = [];

    // First pass: identify duplicate tool results and mark latest index
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!;
        if (m.role === "tool" || (m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Tool Result]"))) {
            // Look at the preceding assistant message for tool identity
            if (i > 0) {
                const prev = messages[i - 1]!;
                if (prev.role === "assistant" && typeof prev.content === "string") {
                    const key = prev.content.slice(0, 200) + "|" + (typeof m.content === "string" ? m.content.slice(0, 200) : "");
                    seen.set(key, i);
                }
            }
        }
    }

    // Second pass: trim/prune
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!;

        if (i >= protectFrom) {
            result.push(m);
            continue;
        }

        // Prune image-only tool results from early turns
        if ((m.role === "tool" || (m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Tool Result]"))) &&
            typeof m.content === "string") {
            const trimmedContent = m.content.replace(/^\[Tool Result\]\s*/, "").trim();
            if (/^\[image data\]$/i.test(trimmedContent) || /^\[image\]$/i.test(trimmedContent)) {
                result.push({ ...m, content: "[Tool Result] [image data removed — stale]" });
                trimCount++;
                continue;
            }
        }

        // Remove duplicate tool results (keep only the most recent)
        if (m.role === "tool" || (m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Tool Result]"))) {
            if (i > 0) {
                const prev = messages[i - 1]!;
                if (prev.role === "assistant" && typeof prev.content === "string") {
                    const key = prev.content.slice(0, 200) + "|" + (typeof m.content === "string" ? m.content.slice(0, 200) : "");
                    const latestIdx = seen.get(key);
                    if (latestIdx !== undefined && latestIdx !== i) {
                        result.push({ ...m, content: "[Tool Result] [duplicate — see later result]" });
                        trimCount++;
                        continue;
                    }
                }
            }
        }

        // Trim large old tool results
        if ((m.role === "tool" || (m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Tool Result]")))) {
            const content = typeof m.content === "string" ? m.content : String(m.content);
            if (content.length > SOFT_TRIM_RESULT_MAX_CHARS) {
                const half = Math.floor(SOFT_TRIM_RESULT_KEEP_CHARS / 2);
                const trimmed = content.slice(0, half) +
                    `\n...[soft-trimmed ${content.length - SOFT_TRIM_RESULT_KEEP_CHARS} chars]...\n` +
                    content.slice(-half);
                result.push({ ...m, content: trimmed });
                trimCount++;
                continue;
            }
        }

        result.push(m);
    }

    if (trimCount > 0) {
        emit("context", { message: `soft-trim: trimmed ${trimCount} old tool results` });
    }
    return result;
}


// ─── Context Window Guard with Auto-Compaction ────────────────────────────

const CONTEXT_BUDGET_RATIO = 0.75; // fallback; overridden by model-aware budget
const RECENT_MESSAGES_TO_KEEP = 20;
const COMPACTION_CHUNK_TOKENS = 30_000;
const COMPACTION_MAX_RETRIES = 3;

const IDENTIFIER_PRESERVATION = `
CRITICAL: Preserve these verbatim (do not paraphrase or omit):
- File paths (e.g., src/utils/auth.ts)
- Function/variable/class names (e.g., handleAuth, userToken)
- Error messages and stack traces
- Command-line commands that were run
- Configuration values and URLs`;

function findSafeSplitIndex(nonSystem: LLMMessage[], desiredRecent: number): number {
    let split = Math.max(0, nonSystem.length - desiredRecent);
    while (split < nonSystem.length - 1) {
        const msg = nonSystem[split]!;
        if (msg.role === "tool" && msg.toolCallId) {
            split++;
            continue;
        }
        break;
    }
    return split;
}

async function summarizeChunk(
    llm: LLMProvider,
    chunkText: string,
    taskContext: string,
): Promise<string> {
    const prompt =
        "You are summarizing a chunk of an AI agent's conversation history.\n\n" +
        `## Original Task\n${taskContext}\n\n` +
        `## Conversation Chunk\n${chunkText}\n\n` +
        "## Instructions\n" +
        "Write a structured summary preserving:\n" +
        "- What tools were called and their key results (file paths, data, errors)\n" +
        "- What has been accomplished\n" +
        "- Any critical facts, variable values, or decisions made\n" +
        IDENTIFIER_PRESERVATION + "\n" +
        "Be concise but preserve all actionable information.";

    let lastError: unknown;
    for (let attempt = 0; attempt < COMPACTION_MAX_RETRIES; attempt++) {
        try {
            const resp = await llm.chat([{ role: "user", content: prompt }]);
            if (resp.content.trim()) return resp.content.trim();
        } catch (e) {
            lastError = e;
        }
        if (attempt < COMPACTION_MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
    }
    throw lastError ?? new Error("Summarization returned empty");
}

async function compactIfNeeded(
    messages: LLMMessage[],
    contextWindow: number,
    llm: LLMProvider,
    emit: OnEvent,
    tokenMultiplier: number,
    modelName?: string,
): Promise<LLMMessage[]> {
    messages = truncateOldToolArgs(messages, RECENT_PROTECTED_COUNT);

    const { window: effectiveWindow, ratio } = modelName
        ? resolveContextBudget(modelName, contextWindow)
        : { window: contextWindow, ratio: CONTEXT_BUDGET_RATIO };
    const budget = Math.floor(effectiveWindow * ratio);
    const currentTokens = estimateMessagesTokens(messages, tokenMultiplier);

    if (currentTokens <= budget) return messages;

    emit("context", { message: `~${currentTokens} tokens exceeds budget ${budget} — compacting` });

    const systemMessages: LLMMessage[] = [];
    const nonSystem: LLMMessage[] = [];
    for (const m of messages) {
        (m.role === "system" ? systemMessages : nonSystem).push(m);
    }

    if (nonSystem.length <= RECENT_MESSAGES_TO_KEEP) return messages;

    const splitIdx = findSafeSplitIndex(nonSystem, RECENT_MESSAGES_TO_KEEP);
    if (splitIdx <= 0) return messages;

    const older = nonSystem.slice(0, splitIdx);
    const recent = nonSystem.slice(splitIdx);

    const offloadPath = offloadHistory(older);
    if (offloadPath) {
        emit("context", { message: `offloaded ${older.length} messages to ${offloadPath}` });
    }

    let taskContext = "";
    for (const m of nonSystem) {
        if (m.role === "user" && typeof m.content === "string" && !m.content.startsWith("[Tool Result]")) {
            taskContext = m.content.slice(0, 500);
            break;
        }
    }

    const textParts: string[] = [];
    for (const m of older) {
        const content = typeof m.content === "string" ? m.content : String(m.content);
        if (m.role === "assistant" && m.toolCallsMeta) {
            const calls = m.toolCallsMeta.map((tc) => tc.name).join(", ");
            textParts.push(`[TOOL CALLS: ${calls}] ${content.slice(0, 200)}`);
        } else if (m.role === "tool") {
            textParts.push(`[TOOL RESULT]: ${content.slice(0, 200)}`);
        } else {
            textParts.push(`[${m.role.toUpperCase()}]: ${content.slice(0, 500)}`);
        }
    }

    const totalTokens = estimateTokens(textParts.join("\n\n"), tokenMultiplier);

    try {
        let summaryText: string;

        if (totalTokens <= COMPACTION_CHUNK_TOKENS) {
            const textLog = textParts.join("\n\n");
            summaryText = await summarizeChunk(llm, textLog, taskContext);
        } else {
            const chunks: string[] = [];
            let currentChunk: string[] = [];
            let currentChunkTokens = 0;

            for (const part of textParts) {
                const partTokens = estimateTokens(part, tokenMultiplier);
                if (currentChunkTokens + partTokens > COMPACTION_CHUNK_TOKENS && currentChunk.length > 0) {
                    chunks.push(currentChunk.join("\n\n"));
                    currentChunk = [];
                    currentChunkTokens = 0;
                }
                currentChunk.push(part);
                currentChunkTokens += partTokens;
            }
            if (currentChunk.length > 0) {
                chunks.push(currentChunk.join("\n\n"));
            }

            emit("context", { message: `splitting ${textParts.length} parts into ${chunks.length} chunks for summarization` });

            const chunkSummaries: string[] = [];
            for (let i = 0; i < chunks.length; i++) {
                const chunkSummary = await summarizeChunk(llm, chunks[i]!, taskContext);
                chunkSummaries.push(`### Chunk ${i + 1}/${chunks.length}\n${chunkSummary}`);
            }
            summaryText = chunkSummaries.join("\n\n");
        }

        if (!summaryText.trim()) {
            emit("context", { message: "compaction returned empty summary — dropping oldest" });
            return [...systemMessages, ...recent];
        }

        const summary: LLMMessage = {
            role: "user",
            content: `[System — Compacted History]\n${summaryText}`,
        };
        emit("context", { message: `compacted ${older.length} messages into summary` });
        return [...systemMessages, summary, ...recent];
    } catch {
        emit("context", { message: "compaction failed — dropping oldest messages" });
        return [...systemMessages, ...recent];
    }
}

// ─── History Offloading ───────────────────────────────────────────────────

function getHistoryDir(): string {
    return resolve(process.cwd(), ".clawagents", "history");
}

function offloadHistory(messages: LLMMessage[]): string | null {
    try {
        const historyDir = getHistoryDir();
        mkdirSync(historyDir, { recursive: true });
        const ts = Date.now();
        const path = resolve(historyDir, `compacted_${ts}_${messages.length}msgs.json`);
        const data = messages.map((m) => ({ role: m.role, content: m.content }));
        writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
        return path;
    } catch {
        return null;
    }
}

// ─── Write-Ahead Log (learned from Claude Code) ──────────────────────────
// Persist the latest message before each LLM API call so that if the process
// crashes mid-call, the user's last message isn't lost.

export function walWrite(messages: LLMMessage[]): void {
    try {
        const envVal = process.env["CLAW_FEATURE_WAL"] ?? "0";
        if (!["1", "true", "yes", "on"].includes(envVal.toLowerCase())) return;
    } catch { return; }

    try {
        const walPath = resolve(process.cwd(), ".clawagents", "wal.jsonl");
        mkdirSync(resolve(process.cwd(), ".clawagents"), { recursive: true });
        const lastMsg = messages[messages.length - 1];
        if (!lastMsg) return;
        const content = typeof lastMsg.content === "string" ? lastMsg.content : String(lastMsg.content);
        const entry = JSON.stringify({
            role: lastMsg.role,
            content: content.slice(0, 500),
            ts: Date.now() / 1000,
            msgCount: messages.length,
        });
        appendFileSync(walPath, entry + "\n", "utf-8");
    } catch {
        // WAL failure should never block the agent loop
    }
}


// ─── Truncated JSON Detection ─────────────────────────────────────────────

const TRUNCATED_JSON_RE = /\{\s*"tool"\s*:/;

function looksLikeTruncatedJson(text: string): boolean {
    const stripped = text.trim();
    if (!stripped || !TRUNCATED_JSON_RE.test(stripped)) return false;
    try {
        const parsed = JSON.parse(stripped);
        if (typeof parsed === "object" && parsed !== null) return false;
    } catch { /* not valid JSON */ }
    // Check fence-wrapped
    const fenceRe = /```(?:json)?\s*\n?(.*?)(?:```|$)/gs;
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(stripped)) !== null) {
        const inner = m[1].trim();
        if (TRUNCATED_JSON_RE.test(inner)) {
            try { JSON.parse(inner); return false; } catch { return true; }
        }
    }
    return true;
}

// ─── ReAct Loop ───────────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 1000;

export async function runAgentGraph(
    task: string,
    llm: LLMProvider,
    tools?: ToolRegistry,
    systemPrompt?: string,
    maxIterations = MAX_TOOL_ROUNDS,
    streaming = true,
    contextWindow = 1_000_000,
    onEvent?: OnEvent,
    beforeLLM?: BeforeLLMHook,
    beforeTool?: BeforeToolHook,
    afterTool?: AfterToolHook,
    useNativeTools = true,
    trajectory = false,
    rethink = false,
    learn = false,
    previewChars = 120,
    responseChars = 500,
    timeoutS = 0,
    features?: Record<string, boolean>,
): Promise<AgentState> {
    if (features) {
        setOverrides(features);
    }

    const registry = tools;
    let nativeSchemas: NativeToolSchema[] | undefined =
        useNativeTools && registry ? registry.toNativeSchemas() : undefined;
    let toolDesc = (!useNativeTools && registry) ? registry.describeForLLM() : "";
    const loopTracker = new ToolCallTracker();
    const emit = onEvent ?? defaultOnEvent;

    // Feature C + F: detect task type for adaptive rethink threshold
    let _taskType = "general";
    let adaptiveThreshold = RETHINK_THRESHOLD;
    if (rethink || learn) {
        try {
            const { detectTaskType, computeAdaptiveRethinkThreshold } = await import("../trajectory/verifier.js");
            _taskType = detectTaskType(task);
            adaptiveThreshold = computeAdaptiveRethinkThreshold(_taskType, 0, 0);
        } catch { /* fallback */ }
    }
    const failureTracker = rethink ? new FailureTracker(adaptiveThreshold) : undefined;

    // Trajectory recorder (opt-in; learn implies trajectory)
    let recorder: import("../trajectory/recorder.js").TrajectoryRecorder | undefined;
    if (trajectory || learn) {
        const { TrajectoryRecorder } = await import("../trajectory/recorder.js");
        recorder = new TrajectoryRecorder(task, "", responseChars);
    }

    // Feature: Session Persistence — save session as append-only JSONL
    let sessionWriter: import("../session/persistence.js").SessionWriter | undefined;
    {
        const { isEnabled } = await import("../config/features.js");
        if (isEnabled("session_persistence")) {
            const { SessionWriter } = await import("../session/persistence.js");
            sessionWriter = new SessionWriter();
            emit("context", { message: `session: ${sessionWriter.sessionId} → ${sessionWriter.path}` });
        }
    }

    // Feature: External Hooks — load shell hooks from .clawagents/hooks.json or env
    let extHookRunner: import("../hooks/external.js").ExternalHookRunner | undefined;
    {
        const { isEnabled } = await import("../config/features.js");
        if (isEnabled("external_hooks")) {
            const { loadHooksConfig, ExternalHookRunner } = await import("../hooks/external.js");
            const hooksCfg = loadHooksConfig();
            if (hooksCfg) {
                extHookRunner = new ExternalHookRunner(hooksCfg);
                emit("context", { message: "external hooks: loaded" });
            }
        }
    }

    let tokenMultiplier = 1.0;
    let resolvedModelName: string | undefined;

    let promptToUse = systemPrompt || BASE_SYSTEM_PROMPT;

    // PTRL Layer 1: Pre-run lesson injection
    if (learn) {
        const { buildLessonPreamble } = await import("../trajectory/lessons.js");
        const preamble = buildLessonPreamble();
        if (preamble) {
            promptToUse = promptToUse + preamble;
            emit("context", { message: "PTRL: injected lessons from past runs" });
        }
    }

    // Insert __CACHE_BOUNDARY__ between static (instructions + tools) and dynamic content.
    // The Anthropic provider splits on this marker to enable prompt caching.
    const systemContent = promptToUse + "\n\n" + toolDesc + "\n__CACHE_BOUNDARY__";
    let messages: LLMMessage[] = [
        { role: "system", content: systemContent },
        { role: "user", content: task },
    ];

    // Session: write initial state
    if (sessionWriter) {
        sessionWriter.writeSystemPrompt(systemContent);
    }

    // Initialize tokenizer encoder for accurate token counting
    await initTokenizer(resolvedModelName);

    // Pre-flight: ensure initial payload fits in context window
    ({ messages, toolDesc, nativeSchemas } = preflightContextCheck(
        messages, contextWindow, toolDesc, nativeSchemas, registry, emit,
    ));

    const state: AgentState = {
        messages,
        currentTask: task,
        status: "running",
        result: "",
        iterations: 0,
        maxIterations,
        toolCalls: 0,
    };

    let overflowRetries = 0;
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
    const checkTimeout = () => {
        if (timeoutS > 0 && (Date.now() - t0) / 1000 > timeoutS) {
            throw new Error(`Agent run exceeded ${timeoutS}s global timeout`);
        }
    };

    try {
        for (let roundIdx = 0; roundIdx < effectiveMaxRounds; roundIdx++) {
            if (ac.signal.aborted) {
                state.status = "done";
                state.result = state.result || "[cancelled]";
                break;
            }

            // Session: mark turn start
            if (sessionWriter) sessionWriter.writeTurnStarted(roundIdx);

            try {
                checkTimeout();
            } catch (err) {
                emit("warn", { message: String(err) });
                state.status = "error";
                state.result = String(err);
                break;
            }

            // Write-ahead log: persist last message before API call (Claude Code pattern)
            walWrite(messages);

            // Patch dangling tool calls before sending to LLM
            messages = patchDanglingToolCalls(messages);
            messages = microCompactToolResults(messages);  // Claude Code pattern: clear old tool results
            messages = softTrimMessages(messages, contextWindow, tokenMultiplier, emit, resolvedModelName);
            messages = await compactIfNeeded(messages, contextWindow, llm, emit, tokenMultiplier, resolvedModelName);

            // External pre_llm hook (runs before programmatic hook)
            if (extHookRunner) {
                try {
                    const lastRole = messages.length > 0 ? messages[messages.length - 1]!.role : "";
                    const extraMsgs = await extHookRunner.preLLM(messages.length, lastRole);
                    if (extraMsgs) {
                        for (const em of extraMsgs) {
                            messages.push({ role: em.role as "user" | "assistant", content: em.content });
                        }
                    }
                } catch (hookErr) { emit("warn", { message: `external preLLM hook error: ${hookErr}` }); }
            }

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
                if (!resolvedModelName && response.model) resolvedModelName = response.model;

                // Session: write usage
                if (sessionWriter) {
                    sessionWriter.writeUsage(
                        response.tokensUsed,
                        response.cacheReadTokens ?? 0,
                        response.cacheCreationTokens ?? 0,
                    );
                }

                // External post_llm hook (fire-and-forget)
                if (extHookRunner) {
                    try {
                        await extHookRunner.postLLM(
                            response.content.slice(0, 500),
                            (response.toolCalls ?? []).length,
                        );
                    } catch { /* fire-and-forget */ }
                }
            } catch (err) {
                // Feature: Error Taxonomy — classify and apply recovery recipe
                const { classifyError, ErrorClass } = await import("../errors/taxonomy.js");
                const descriptor = classifyError(err);
                emit("error", {
                    phase: "llm_call",
                    message: String(err),
                    errorClass: descriptor.errorClass,
                    retryable: descriptor.retryable,
                    recoveryHint: descriptor.recoveryHint,
                });

                if (descriptor.errorClass === ErrorClass.CONTEXT_WINDOW) {
                    overflowRetries++;
                    if (overflowRetries > MAX_OVERFLOW_RETRIES) {
                        emit("error", {
                            phase: "llm_call",
                            message: `context overflow persists after ${MAX_OVERFLOW_RETRIES} retries. Increase CONTEXT_WINDOW, reduce tools, or shorten your instruction.`,
                        });
                        state.status = "error";
                        state.result = String(err);
                        break;
                    }
                    const observedRatio = contextWindow / Math.max(estimateMessagesTokens(messages, 1.0), 1);
                    tokenMultiplier = Math.min(observedRatio * 1.1, 3.0);
                    emit("context", { message: `token overflow — calibrated multiplier to ${tokenMultiplier.toFixed(2)} (retry ${overflowRetries}/${MAX_OVERFLOW_RETRIES})` });
                    messages = softTrimMessages(messages, contextWindow, tokenMultiplier, emit, resolvedModelName);
                    messages = await compactIfNeeded(messages, contextWindow, llm, emit, tokenMultiplier, resolvedModelName);
                    continue;
                }

                state.status = "error";
                state.result = `[${descriptor.errorClass}] ${descriptor.recoveryHint}`;
                break;
            }

            if (response.partial && !response.content.trim()) {
                emit("warn", { message: "interrupted — no content received" });
                state.status = "done";
                state.result = state.result || "[interrupted]";
                break;
            }

            // Feature H: extract and preserve thinking tokens (<think>...</think>)
            let _thinkingContent: string | null = null;
            if (response.content && response.content.includes("<think>")) {
                const [clean, thinking] = stripThinkingTokens(response.content);
                _thinkingContent = thinking;
                response = {
                    ...response,
                    content: clean,
                };
            }

            // Use exclusively native or text-based tool calls based on user-provided mode
            const nativeToolCallObjects = useNativeTools ? (response.toolCalls ?? []) : [];
            const toolCalls = useNativeTools
                ? nativeToolCallObjects.map((tc) => ({ toolName: tc.toolName, args: tc.args }))
                : (registry?.parseToolCalls(response.content) ?? []);

            if (toolCalls.length === 0) {
                if (!useNativeTools && looksLikeTruncatedJson(response.content)) {
                    emit("warn", { message: "truncated JSON tool call detected — asking LLM to retry" });
                    messages.push({ role: "assistant", content: response.content, thinking: _thinkingContent });
                    messages.push({
                        role: "user",
                        content: "Your previous response was cut off mid-JSON. Please resend the complete tool call as valid JSON.",
                    });
                    continue;
                }

                if (recorder) {
                    recorder.recordTurn(
                        response.content || "",
                        response.model,
                        response.tokensUsed,
                        undefined, undefined, undefined, undefined, undefined,
                        _thinkingContent,
                    );
                }
                state.result = sanitizeAssistantText(response.content);
                state.status = "done";
                state.iterations += 1;
                emit("final_content", { content: state.result });
                messages.push({ role: "assistant", content: response.content, thinking: _thinkingContent });
                break;
            }

            if (loopTracker.isCircuitBroken()) {
                emit("warn", { message: `circuit breaker tripped (${loopTracker["noProgressCount"]} no-progress calls) — breaking` });
                state.status = "done";
                state.result = "Circuit breaker: too many tool calls with no progress. Stopping.";
                state.iterations += 1;
                break;
            }

            if (loopTracker.isHardLoopingBatch(toolCalls)) {
                const names = toolCalls.map((c) => c.toolName).join(", ");
                emit("warn", { message: `tool loop detected (${names}) — breaking` });
                state.status = "done";
                state.result = `Tool loop detected (${names}). Stopping.`;
                state.iterations += 1;
                break;
            }

            if (loopTracker.isPingPonging()) {
                const recent = [...new Set(loopTracker["history"].slice(-6))];
                emit("warn", { message: `ping-pong oscillation detected (${recent.join(" ↔ ")}) — breaking` });
                state.status = "done";
                state.result = "Ping-pong loop detected between tools. Stopping.";
                state.iterations += 1;
                break;
            }

            if (loopTracker.isSoftLoopingBatch(toolCalls)) {
                loopTracker.recordBatch(toolCalls);
                const n = loopTracker.bumpSoftWarning();
                const repeatedNames = toolCalls
                    .filter((c) => loopTracker.isSoftLooping(c.toolName, c.args))
                    .map((c) => c.toolName)
                    .join(", ");
                emit("warn", { message: `repeated tool call warning #${n}: ${repeatedNames}` });
                messages.push({
                    role: "user",
                    content: `[System] You are re-calling ${repeatedNames} with the same arguments. You already have the result in the conversation above. Use the existing data instead of re-reading. If you believe the task is complete, provide your final answer now.`,
                });
                state.iterations += 1;
                continue;
            }

            // Session: write assistant message with tool calls
            if (sessionWriter) {
                const tcMeta = nativeToolCallObjects.map((tc) => ({ id: tc.toolCallId, name: tc.toolName, args: tc.args }));
                sessionWriter.writeAssistantMessage(
                    response.content || "",
                    tcMeta.length > 0 ? tcMeta : undefined,
                    _thinkingContent,
                );
            }

            if (toolCalls.length === 1) {
                let call = toolCalls[0]!;
                const nativeTc = nativeToolCallObjects[0];
                emit("tool_call", { name: call.toolName });

                // External pre_tool_use hook
                if (extHookRunner) {
                    try {
                        const { allowed, args: extArgs } = await extHookRunner.preToolUse(call.toolName, call.args);
                        if (!allowed) {
                            emit("tool_skipped", { name: call.toolName, reason: "blocked by external hook" });
                            messages.push({ role: "user", content: `[Tool Skipped] ${call.toolName} was blocked by external hook.` });
                            continue;
                        }
                        call = { toolName: call.toolName, args: extArgs };
                    } catch (hookErr) { emit("warn", { message: `external preToolUse hook error: ${hookErr}` }); }
                }

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

                // External post_tool_use hook
                if (extHookRunner) {
                    try {
                        const extResult = await extHookRunner.postToolUse(
                            call.toolName, call.args,
                            { success: toolResult.success, output: String(toolResult.output).slice(0, 1000) },
                        );
                        if ("success" in extResult && "output" in extResult) {
                            toolResult = {
                                success: extResult.success as boolean,
                                output: extResult.output as string,
                                error: extResult.error as string | undefined,
                            };
                        }
                    } catch (hookErr) { emit("warn", { message: `external postToolUse hook error: ${hookErr}` }); }
                }

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

                let toolOutput: string | any[];
                let preview: string;
                if (typeof rawOutput !== "string") {
                    toolOutput = rawOutput;
                    preview = "[Multimodal Array Content]";
                } else {
                    toolOutput = evictLargeToolResult(call.toolName, rawOutput);
                    preview = toolOutput.slice(0, previewChars);
                }

                emit("tool_result", {
                    name: call.toolName,
                    success: toolResult.success,
                    preview,
                });

                // Session: write tool result
                if (sessionWriter) {
                    sessionWriter.writeToolResult(
                        nativeTc?.toolCallId ?? "",
                        call.toolName,
                        toolResult.success,
                        String(toolResult.output).slice(0, 2000),
                        !toolResult.success ? toolResult.error : undefined,
                    );
                }

                // Record result hash for no-progress / circuit breaker detection
                if (typeof toolOutput === "string") {
                    loopTracker.recordResult(call.toolName, call.args, toolOutput);
                }

                // ── Failure tracking + trajectory ──
                failureTracker?.record(toolResult.success, call.toolName);
                if (recorder) {
                    // Feature 4: capture observation context
                    let obsCtx = "";
                    for (let mi = messages.length - 1; mi >= 0; mi--) {
                        const mm = messages[mi]!;
                        if ((mm.role === "user" || mm.role === "tool") && typeof mm.content === "string" && mm.content.startsWith("[Tool Result]")) {
                            obsCtx = mm.content.slice(0, 300);
                            break;
                        }
                    }
                    recorder.recordTurn(
                        response.content || "",
                        response.model,
                        response.tokensUsed,
                        [{
                            toolName: call.toolName,
                            args: call.args,
                            success: toolResult.success,
                            outputPreview: typeof preview === "string" ? preview : "[multimodal]",
                            error: !toolResult.success ? toolResult.error : undefined,
                        }],
                        undefined,
                        obsCtx,
                        undefined, undefined,
                        _thinkingContent,
                    );
                }

                // Use proper tool role messages when native tools are enabled
                if (useNativeTools && nativeTc?.toolCallId) {
                    messages.push({
                        role: "assistant",
                        content: response.content || "",
                        toolCallsMeta: [{ id: nativeTc.toolCallId, name: call.toolName, args: call.args }],
                        ...(response.geminiParts ? { geminiParts: response.geminiParts } : {}),
                        thinking: _thinkingContent,
                    });
                    const toolContent = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput);
                    messages.push({
                        role: "tool",
                        content: toolContent,
                        toolCallId: nativeTc.toolCallId,
                    });
                } else {
                    messages.push({
                        role: "assistant",
                        content: `{"tool": "${call.toolName}", "args": ${JSON.stringify(call.args)}}`,
                        thinking: _thinkingContent,
                    });
                    messages.push({
                        role: "user",
                        content: typeof toolOutput === "string" ? `[Tool Result] ${toolOutput}` : toolOutput as any,
                    });
                }

                // ── Rethink injection with adaptive threshold ──
                if (failureTracker) {
                    try {
                        const { computeAdaptiveRethinkThreshold } = await import("../trajectory/verifier.js");
                        failureTracker.threshold = computeAdaptiveRethinkThreshold(
                            _taskType, roundIdx, state.toolCalls,
                        );
                    } catch { /* fallback */ }
                    if (failureTracker.shouldRethink()) {
                        const nFails = failureTracker.consecutiveFailures;
                        const rethinkNum = failureTracker.bumpRethink();
                        emit("warn", { message: `rethink #${rethinkNum}: ${nFails} consecutive failures (threshold=${failureTracker.threshold})` });
                        let rethinkMsg = rethinkMessage(nFails);
                        if (learn) {
                            const { buildRethinkWithLessons } = await import("../trajectory/lessons.js");
                            const fmtCnt = recorder ? recorder.getTurns().reduce((s, t) => s + t.toolCalls.filter(tc => !tc.success && tc.failureType === "format").length, 0) : 0;
                            const logicCnt = recorder ? recorder.getTurns().reduce((s, t) => s + t.toolCalls.filter(tc => !tc.success && tc.failureType === "logic").length, 0) : 0;
                            rethinkMsg = buildRethinkWithLessons(rethinkMsg, fmtCnt, logicCnt);
                        }
                        messages.push({ role: "user", content: rethinkMsg });
                    }
                }

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
                const toolOutputs: string[] = [];
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
                    let output: string | any[];
                    let preview: string;
                    if (typeof rawOut !== "string") {
                        output = rawOut;
                        preview = "[Multimodal Array Content]";
                    } else {
                        output = evictLargeToolResult(call.toolName, rawOut);
                        preview = output.slice(0, previewChars);
                    }
                    emit("tool_result", {
                        name: call.toolName,
                        success: result.success,
                        preview,
                    });

                    if (typeof output === "string") {
                        callSummaries.push(`${call.toolName}(${JSON.stringify(call.args)}) => ${output}`);
                        toolOutputs.push(output);
                    } else {
                        callSummaries.push(`${call.toolName}(${JSON.stringify(call.args)}) => [Multimodal Output Length: ${output.length}]`);
                        callSummaries.push(JSON.stringify(output));
                        toolOutputs.push(JSON.stringify(output));
                    }
                }

                // Record result hashes for no-progress / circuit breaker detection
                for (let j = 0; j < approvedCalls.length; j++) {
                    if (typeof toolOutputs[j] === "string") {
                        loopTracker.recordResult(approvedCalls[j]!.toolName, approvedCalls[j]!.args, toolOutputs[j]!);
                    }
                }

                // ── Failure tracking + trajectory (parallel) ──
                failureTracker?.recordBatch(
                    approvedCalls.map((c, j) => ({ success: results[j]!.success, toolName: c.toolName })),
                );
                if (recorder) {
                    const tcRecords = approvedCalls.map((call, j) => {
                        const r = results[j]!;
                        const rawPreview = r.success
                            ? (typeof r.output === "string" ? r.output : "[multimodal]")
                            : (r.error || "");
                        return {
                            toolName: call.toolName,
                            args: call.args,
                            success: r.success,
                            outputPreview: rawPreview.slice(0, previewChars),
                            error: !r.success ? r.error : undefined,
                        };
                    });
                    // Feature 4: capture observation context
                    let obsCtx = "";
                    for (let mi = messages.length - 1; mi >= 0; mi--) {
                        const mm = messages[mi]!;
                        if ((mm.role === "user" || mm.role === "tool") && typeof mm.content === "string" && mm.content.startsWith("[Tool Result")) {
                            obsCtx = mm.content.slice(0, 300);
                            break;
                        }
                    }
                    recorder.recordTurn(
                        response.content || "",
                        response.model,
                        response.tokensUsed,
                        tcRecords,
                        undefined,
                        obsCtx,
                        undefined, undefined,
                        _thinkingContent,
                    );
                }

                // Use proper tool role messages when native tools are enabled
                if (useNativeTools && nativeToolCallObjects.length > 0) {
                    // Build mapping: approved call index -> native tool call object
                    // (handles filtered parallel calls where approvedCalls is a subset of toolCalls)
                    const nativeTcMap: Record<number, typeof nativeToolCallObjects[number]> = {};
                    let approvedIdx = 0;
                    for (let i = 0; i < toolCalls.length && approvedIdx < approvedCalls.length; i++) {
                        if (toolCalls[i] === approvedCalls[approvedIdx]) {
                            if (i < nativeToolCallObjects.length) {
                                nativeTcMap[approvedIdx] = nativeToolCallObjects[i]!;
                            }
                            approvedIdx++;
                        }
                    }
                    const tcMeta = approvedCalls.map((call, idx) => {
                        const ntc = nativeTcMap[idx];
                        return { id: ntc?.toolCallId || `fallback_${idx}`, name: call.toolName, args: call.args };
                    });
                    messages.push({
                        role: "assistant",
                        content: response.content || "",
                        toolCallsMeta: tcMeta,
                        ...(response.geminiParts ? { geminiParts: response.geminiParts } : {}),
                        thinking: _thinkingContent,
                    });
                    for (let idx = 0; idx < approvedCalls.length; idx++) {
                        const ntc = nativeTcMap[idx];
                        messages.push({
                            role: "tool",
                            content: toolOutputs[idx] ?? "",
                            toolCallId: ntc?.toolCallId || `fallback_${idx}`,
                        });
                    }
                } else {
                    const toolCallStr = JSON.stringify(
                        approvedCalls.map((c) => ({ tool: c.toolName, args: c.args })),
                    );
                    messages.push({ role: "assistant", content: toolCallStr, thinking: _thinkingContent });
                    messages.push({
                        role: "user",
                        content: `[Tool Results]\n${callSummaries.join("\n")}`,
                    });
                }

                // ── Rethink injection with adaptive threshold (parallel) ──
                if (failureTracker) {
                    try {
                        const { computeAdaptiveRethinkThreshold } = await import("../trajectory/verifier.js");
                        failureTracker.threshold = computeAdaptiveRethinkThreshold(
                            _taskType, roundIdx, state.toolCalls,
                        );
                    } catch { /* fallback */ }
                    if (failureTracker.shouldRethink()) {
                        const nFails = failureTracker.consecutiveFailures;
                        const rethinkNum = failureTracker.bumpRethink();
                        emit("warn", { message: `rethink #${rethinkNum}: ${nFails} consecutive failures (threshold=${failureTracker.threshold})` });
                        let rethinkMsg = rethinkMessage(nFails);
                        if (learn) {
                            const { buildRethinkWithLessons } = await import("../trajectory/lessons.js");
                            const fmtCnt = recorder ? recorder.getTurns().reduce((s, t) => s + t.toolCalls.filter(tc => !tc.success && tc.failureType === "format").length, 0) : 0;
                            const logicCnt = recorder ? recorder.getTurns().reduce((s, t) => s + t.toolCalls.filter(tc => !tc.success && tc.failureType === "logic").length, 0) : 0;
                            rethinkMsg = buildRethinkWithLessons(rethinkMsg, fmtCnt, logicCnt);
                        }
                        messages.push({ role: "user", content: rethinkMsg });
                    }
                }
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

    // Session: write final turn_completed
    if (sessionWriter) {
        sessionWriter.writeTurnCompleted(state.iterations, state.toolCalls, state.status);
        state.sessionFile = sessionWriter.path;
    }

    // ── Finalize trajectory ──
    let runSummary: import("../trajectory/recorder.js").RunSummary | undefined;
    if (recorder) {
        const outcome = (state.status as string) === "running" ? "success" : state.status;
        runSummary = recorder.finalize(outcome);
        state.trajectoryFile = runSummary.trajectoryFile;
        emit("context", { message: `trajectory saved to ${runSummary.trajectoryFile}` });
    }

    // ── Feature G: LLM-as-Judge verification ──
    if (learn && recorder && runSummary) {
        try {
            const { judgeRun } = await import("../trajectory/judge.js");
            const judgeResult = await judgeRun(
                llm, task, runSummary, state.result ?? "", recorder.getTurns(),
            );
            runSummary.judgeScore = judgeResult.judgeScore;
            runSummary.judgeJustification = judgeResult.judgeJustification;
            emit("context", {
                message: `LLM Judge: score=${runSummary.judgeScore}/3 — ${(runSummary.judgeJustification ?? "").slice(0, 80)}`,
            });
        } catch { /* best effort */ }
    }

    // ── PTRL Layer 3: Post-run self-analysis (with quality gate) ──
    if (learn && recorder && runSummary) {
        try {
            const { extractLessons, saveLessons, shouldExtractLessons } = await import("../trajectory/lessons.js");

            // Feature 1: Quality gate — only extract lessons from informative runs
            if (shouldExtractLessons(runSummary)) {
                const lessonsText = await extractLessons(llm, runSummary, recorder.getTurns());
                if (lessonsText) {
                    saveLessons(lessonsText, runSummary.task, runSummary.outcome, runSummary.model);
                    emit("context", { message: "PTRL: extracted and saved lessons from this run" });
                }
            } else {
                emit("context", {
                    message: `PTRL: skipped lesson extraction (quality=${runSummary.quality}, ` +
                        `mixed=${runSummary.hasMixedOutcomes}, score=${runSummary.runScore})`,
                });
            }
        } catch { /* best effort */ }
    }

    emit("agent_done", {
        tool_calls: state.toolCalls,
        iterations: state.iterations,
        elapsed,
    });
    return state;
}
