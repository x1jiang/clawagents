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
import type { ToolRegistry, ParsedToolCall, ToolResult } from "../tools/registry.js";
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { setOverrides } from "../config/features.js";
import { RunContext, type ApprovalRecord } from "../run-context.js";
import { Usage } from "../usage.js";
import { streamEventFromKind, type StreamEvent } from "../stream-events.js";
import type { RunHooks } from "../lifecycle.js";
import {
    type InputGuardrail,
    type OutputGuardrail,
    GuardrailBehavior,
    GuardrailTripwireTriggered,
} from "../guardrails.js";
import type { Session } from "../session/backends.js";
import {
    DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS,
    runWithHeartbeat,
} from "../session/heartbeat.js";
import { RetryPolicy } from "../retry.js";
import { handoffSpan } from "../tracing/context.js";

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

    // Build set of all toolCallId values that have a matching role="tool" response
    const respondedIds = new Set<string>();
    for (const msg of messages) {
        if (msg.role === "tool" && msg.toolCallId) {
            respondedIds.add(msg.toolCallId);
        }
    }

    const patched: LLMMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        patched.push(msg);

        // Text-mode: look for assistant messages with JSON tool calls without a following [Tool Result]
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

        // Native tool calls: inject synthetic role="tool" for any missing responses
        else if (msg.role === "assistant" && msg.toolCallsMeta) {
            for (const tc of msg.toolCallsMeta) {
                if (tc.id && !respondedIds.has(tc.id)) {
                    patched.push({
                        role: "tool",
                        content: "Tool call was cancelled — the agent was interrupted before it could complete.",
                        toolCallId: tc.id,
                    });
                    respondedIds.add(tc.id);
                }
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

function toolObservation(result: ToolResult): string | any[] {
    if (result.success) return result.output;
    const error = result.error ? `Error: ${result.error}` : "Error: Tool failed";
    if (Array.isArray(result.output)) return [error, ...result.output];
    const output = String(result.output ?? "").trim();
    return output ? `${error}\nOutput:\n${output}` : error;
}

// ─── Model-Aware Context Budget (learned from deepagents) ─────────────────
// Uses known model context windows to set fraction-based triggers instead of
// a single fixed ratio.

interface ModelProfile {
    maxInputTokens: number;
    budgetRatio: number;
}

// NOTE: Order matters for the prefix-match fallback below. List the *most
// specific* keys first so e.g. "gpt-5.4-medium" resolves to the "gpt-5.4"
// profile rather than falling back to "gpt-5".
const MODEL_PROFILES: Record<string, ModelProfile> = {
    // ── OpenAI — GPT-5 family (400K context) ───────────────────────────
    "gpt-5.4-mini": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5.4-nano": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5.4": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5.3-codex": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5.3-mini": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5.3": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5.2-mini": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5.2": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5.1-codex": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5.1-mini": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5.1": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5-codex": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5-mini": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5-nano": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    "gpt-5": { maxInputTokens: 400_000, budgetRatio: 0.85 },
    // ── OpenAI — GPT-4.1 (1M context) ──────────────────────────────────
    "gpt-4.1-mini": { maxInputTokens: 1_000_000, budgetRatio: 0.85 },
    "gpt-4.1-nano": { maxInputTokens: 1_000_000, budgetRatio: 0.85 },
    "gpt-4.1": { maxInputTokens: 1_000_000, budgetRatio: 0.85 },
    // ── OpenAI — GPT-4o (128K context) ─────────────────────────────────
    "gpt-4o-mini": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    "gpt-4o": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    // ── OpenAI — reasoning (o-series) ──────────────────────────────────
    "o4-mini": { maxInputTokens: 200_000, budgetRatio: 0.80 },
    "o3-mini": { maxInputTokens: 200_000, budgetRatio: 0.80 },
    "o3": { maxInputTokens: 200_000, budgetRatio: 0.80 },
    "o1-pro": { maxInputTokens: 200_000, budgetRatio: 0.80 },
    "o1-mini": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    "o1": { maxInputTokens: 200_000, budgetRatio: 0.80 },
    // ── Google — Gemini 3.x (1M–2M context) ────────────────────────────
    "gemini-3.1-pro": { maxInputTokens: 2_000_000, budgetRatio: 0.90 },
    "gemini-3.1-flash": { maxInputTokens: 1_000_000, budgetRatio: 0.90 },
    "gemini-3.1": { maxInputTokens: 1_000_000, budgetRatio: 0.90 },
    "gemini-3-pro": { maxInputTokens: 2_000_000, budgetRatio: 0.90 },
    "gemini-3-flash-preview": { maxInputTokens: 1_000_000, budgetRatio: 0.90 },
    "gemini-3-flash": { maxInputTokens: 1_000_000, budgetRatio: 0.90 },
    // ── Google — Gemini 2.5 ────────────────────────────────────────────
    "gemini-2.5-pro": { maxInputTokens: 2_000_000, budgetRatio: 0.90 },
    "gemini-2.5-flash": { maxInputTokens: 1_000_000, budgetRatio: 0.90 },
    // ── Anthropic — Claude 4.x ─────────────────────────────────────────
    "claude-opus-4-7": { maxInputTokens: 200_000, budgetRatio: 0.85 },
    "claude-opus-4-5": { maxInputTokens: 200_000, budgetRatio: 0.85 },
    "claude-opus-4": { maxInputTokens: 200_000, budgetRatio: 0.85 },
    "claude-4.6-sonnet": { maxInputTokens: 1_000_000, budgetRatio: 0.85 },
    "claude-4.5-sonnet": { maxInputTokens: 1_000_000, budgetRatio: 0.85 },
    "claude-sonnet-4-5": { maxInputTokens: 1_000_000, budgetRatio: 0.85 },
    "claude-sonnet-4": { maxInputTokens: 200_000, budgetRatio: 0.85 },
    // ── Anthropic — Claude 3.x ─────────────────────────────────────────
    "claude-3-7-sonnet": { maxInputTokens: 200_000, budgetRatio: 0.85 },
    "claude-3-5-sonnet": { maxInputTokens: 200_000, budgetRatio: 0.85 },
    "claude-3-5-haiku": { maxInputTokens: 200_000, budgetRatio: 0.85 },
    // ── Ollama / local OpenAI-compatible models ────────────────────────
    // NOTE: prefix-matching walks in insertion order. Put specific tags
    // (`gemma4:e4b`) before generic families (`gemma4`) before legacy
    // prefixes (`gemma3`/`gemma`) so "gemma4:e4b" doesn't collapse to
    // the 8K Gemma-1 default.
    // ── Google — Gemma 4 (released 2026-04-02; Apache-2.0) ─────────────
    "gemma4:e2b": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    "gemma4:e4b": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    "gemma4:26b": { maxInputTokens: 256_000, budgetRatio: 0.85 },
    "gemma4:31b": { maxInputTokens: 256_000, budgetRatio: 0.85 },
    "gemma4": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    // ── Google — Gemma 3n (edge/mobile 32K) ────────────────────────────
    "gemma3n:e4b": { maxInputTokens: 32_000, budgetRatio: 0.80 },
    "gemma3n:e2b": { maxInputTokens: 32_000, budgetRatio: 0.80 },
    "gemma3n": { maxInputTokens: 32_000, budgetRatio: 0.80 },
    // ── Google — Gemma 3 / 2 / 1 ───────────────────────────────────────
    "gemma3": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    "gemma2": { maxInputTokens: 8_192, budgetRatio: 0.75 },
    "gemma": { maxInputTokens: 8_192, budgetRatio: 0.75 },
    "llama3.3": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    "llama3.2": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    "llama3.1": { maxInputTokens: 128_000, budgetRatio: 0.80 },
    "qwen2.5-coder": { maxInputTokens: 32_768, budgetRatio: 0.80 },
    "qwen2.5": { maxInputTokens: 32_768, budgetRatio: 0.80 },
    "deepseek-r1": { maxInputTokens: 64_000, budgetRatio: 0.75 },
    "mistral": { maxInputTokens: 32_768, budgetRatio: 0.80 },
    "phi4": { maxInputTokens: 16_384, budgetRatio: 0.75 },
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

export type AgentStatus = "running" | "done" | "error" | "max_iterations";

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
    /** Per-run token usage accumulator (mirrors openai-agents-python). */
    usage?: Usage;
    /** Typed/parsed final output when `outputType` is configured. */
    finalOutput?: unknown;
    /** The RunContext threaded through tools, hooks, and guardrails. */
    runContext?: RunContext<unknown>;
    /** Guardrail tripwire info, if any guardrail rejected content or raised. */
    guardrailTripped?: { source: "input" | "output"; guardrail: string; behavior: GuardrailBehavior; message?: string };
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
    | "tool_skipped"
    // Typed stream events (mirrors openai-agents-python)
    | "turn_started"
    | "assistant_text"
    | "assistant_delta"
    | "tool_call_planned"
    | "tool_started"
    | "tool_result_typed"
    | "usage"
    | "guardrail_tripped"
    | "handoff_occurred"
    | "final_output";

export type OnEvent = (kind: EventKind, data: Record<string, unknown>) => void;

// ─── Hook Types ───────────────────────────────────────────────────────────

export type BeforeLLMHook = (messages: LLMMessage[]) => LLMMessage[];

/**
 * Rich result from a BeforeToolHook.
 *
 * Allows hooks to deny execution with a reason, rewrite tool arguments,
 * or inject messages into the conversation — instead of a bare boolean.
 */
export interface HookResult {
    allowed: boolean;
    reason?: string;
    updatedArgs?: Record<string, unknown>;
    messages?: LLMMessage[];
}

/**
 * BeforeToolHook is backward-compatible: old hooks returning boolean still work.
 * New hooks may return a HookResult for richer control.
 */
export type BeforeToolHook = (toolName: string, args: Record<string, unknown>) => boolean | HookResult;
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
- Prefer fewer, well-targeted tool calls over many exploratory ones.
- Use todo/planning tools only for broad or long-running tasks. Skip todo bookkeeping for bounded lookup, read, compare, or JSON-report tasks.
- Once tool results contain enough evidence to answer, stop calling tools and answer directly. Do not call tools only to mark progress complete.`;

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

const SOFT_TRIM_BUDGET_FRACTION = 0.75; // soft-trim at 75% of the compaction budgetRatio
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
    const { window: effectiveWindow, ratio: budgetRatio } = modelName
        ? resolveContextBudget(modelName, contextWindow)
        : { window: contextWindow, ratio: CONTEXT_BUDGET_RATIO };
    const softBudget = Math.floor(effectiveWindow * budgetRatio * SOFT_TRIM_BUDGET_FRACTION);
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

    let taskContext = "";
    for (const m of nonSystem) {
        if (m.role === "user" && typeof m.content === "string" && !m.content.startsWith("[Tool Result]")) {
            taskContext = m.content.slice(0, 500);
            break;
        }
    }

    archivePreCompactTranscript(older, taskContext);

    const offloadPath = offloadHistory(older);
    if (offloadPath) {
        emit("context", { message: `offloaded ${older.length} messages to ${offloadPath}` });
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

// ─── Pre-Compact Transcript Archival ─────────────────────────────────────

function archivePreCompactTranscript(olderMessages: LLMMessage[], taskContext: string): void {
    const envVal = process.env["CLAW_FEATURE_TRANSCRIPT_ARCHIVAL"] ?? "0";
    if (!["1", "true", "yes", "on"].includes(envVal.toLowerCase())) return;

    try {
        const transcriptDir = resolve(process.cwd(), ".clawagents", "transcripts");
        mkdirSync(transcriptDir, { recursive: true });
        const ts = Math.floor(Date.now() / 1000);
        const path = resolve(transcriptDir, `pre_compact_${ts}_${olderMessages.length}msgs.md`);

        const lines: string[] = [
            "## Pre-Compact Transcript\n",
            `\nTask: ${taskContext}\n`,
            "\n### Messages\n\n",
        ];
        for (const m of olderMessages) {
            const content = typeof m.content === "string" ? m.content : String(m.content);
            lines.push(`**${m.role}**: ${content.slice(0, 2000)}\n\n`);
        }
        writeFileSync(path, lines.join(""), "utf-8");
    } catch {
        // Archival failure should never block compaction
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

// ─── Rich Extras (mirrors openai-agents-python surfaces) ──────────────────

/** Callback invoked for every typed stream event. */
export type OnStreamEvent = (event: StreamEvent) => void | Promise<void>;

/**
 * Per-tool-call approval callback. Called when the agent is about to run a
 * tool for which no sticky approval record exists on the RunContext. Return
 * a record (approved or rejected) to proceed; return undefined to reject
 * the call with a generic "approval not granted" reason.
 */
export type ApprovalHandler = (args: {
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
    runContext: RunContext<unknown>;
}) => Promise<ApprovalRecord | undefined> | ApprovalRecord | undefined;

/**
 * Structured output coercion. When provided, the agent will attempt to
 * parse the final assistant text into this schema and populate
 * `state.finalOutput`. Two shapes are supported:
 *   • a Zod-like schema exposing `.safeParse(value)`
 *   • a plain function `(text: string) => T`
 */
export type OutputTypeSpec =
    | { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: unknown } }
    | ((text: string) => unknown);

export interface AgentLoopExtras<TContext = unknown> {
    /** Pre-initialised RunContext. A fresh one is created if omitted. */
    runContext?: RunContext<TContext>;
    /** Optional user context value to seed `runContext.context`. */
    context?: TContext;
    /** Lifecycle hooks (on_run_start / on_tool_end / …). */
    hooks?: RunHooks<TContext>;
    /** Per-agent hooks; fires on_agent_start/end in addition to run-level hooks. */
    agentHooks?: RunHooks<TContext>;
    /** Input guardrails — run before the first LLM call. */
    inputGuardrails?: InputGuardrail<TContext>[];
    /** Output guardrails — run against the final assistant text. */
    outputGuardrails?: OutputGuardrail<TContext>[];
    /** Structured output coercion. Sets `state.finalOutput` when it parses. */
    outputType?: OutputTypeSpec;
    /** Pluggable conversation-history backend. */
    session?: Session;
    /** Max prior session messages to preload; null disables the cap. */
    sessionPreloadLimit?: number | null;
    /** Typed stream-event sink (in addition to the legacy `onEvent`). */
    onStreamEvent?: OnStreamEvent;
    /** Consulted when a tool call has no sticky approval on the RunContext. */
    approvalHandler?: ApprovalHandler;
    /** Name exposed to hooks as the current agent's identity. */
    agentName?: string;
    /** Composable retry policy (not yet wired into every LLM call — exposed for downstream use). */
    retryPolicy?: RetryPolicy;
    /** Handoff descriptors surfaced to the LLM as ``transfer_to_<name>`` tools. */
    handoffs?: import("../handoffs.js").Handoff<TContext>[];
}

export async function runAgentGraph<TContext = unknown>(
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
    advisorLLM?: LLMProvider,
    advisorMaxCalls = 3,
    extras?: AgentLoopExtras<TContext>,
): Promise<AgentState> {
    if (features) {
        setOverrides(features);
    }

    // ── Rich-surface bootstrap (openai-agents-python parity) ────────
    const runContext: RunContext<TContext> = (extras?.runContext ??
        new RunContext<TContext>({ context: extras?.context })) as RunContext<TContext>;
    if (!runContext.usage) runContext.usage = new Usage();
    const usage = runContext.usage;

    // Per-agent iteration budget (Hermes parity). When the caller has not
    // already attached one (e.g., through a subagent-spawning path that
    // creates a fresh budget), build one sized to ``maxIterations`` so the
    // loop has a single source of truth for "are we out of turns?". The
    // existing ``for roundIdx < effectiveMaxRounds`` loop still acts as a
    // belt-and-braces hard ceiling, but the budget is the user-visible
    // control surface and is what subagents reset.
    if (runContext.iterationBudget === undefined) {
        const { IterationBudget: _IterBudget } = await import("../iteration-budget.js");
        const _budgetSize = Math.max(0, maxIterations > 0 ? maxIterations : MAX_TOOL_ROUNDS);
        runContext.iterationBudget = new _IterBudget(_budgetSize);
    }
    const hooks: RunHooks<TContext> | undefined = extras?.hooks;
    const agentHooks: RunHooks<TContext> | undefined = extras?.agentHooks;
    const inputGuardrails = extras?.inputGuardrails ?? [];
    const outputGuardrails = extras?.outputGuardrails ?? [];
    const outputType = extras?.outputType;
    const sessionBackend: Session | undefined = extras?.session;
    const sessionPreloadLimit = extras?.sessionPreloadLimit === undefined
        ? 200
        : extras.sessionPreloadLimit;
    const onStreamEvent = extras?.onStreamEvent;
    const approvalHandler = extras?.approvalHandler;
    const agentName = extras?.agentName ?? "ClawAgent";

    const registry = tools;
    let nativeSchemas: NativeToolSchema[] | undefined =
        useNativeTools && registry ? registry.toNativeSchemas() : undefined;
    let toolDesc = (!useNativeTools && registry) ? registry.describeForLLM() : "";
    const loopTracker = new ToolCallTracker();

    // ── Synthesise handoff tools (v6.4) ──
    // Each Handoff becomes a synthetic tool the LLM can call. We DO NOT
    // add these to the registry — they're dispatched directly by the loop
    // so they can switch the active agent rather than execute a tool.
    const handoffList: import("../handoffs.js").Handoff<TContext>[] =
        extras?.handoffs ? [...extras.handoffs] : [];
    const handoffMap: Map<string, import("../handoffs.js").Handoff<TContext>> = new Map(
        handoffList.map((h) => [h.name, h]),
    );
    if (handoffList.length > 0) {
        const handoffParams = {
            reason: {
                type: "string",
                description: "Free-text rationale for why the handoff is appropriate.",
                required: false,
            },
        };
        if (useNativeTools) {
            if (!nativeSchemas) nativeSchemas = [];
            for (const h of handoffList) {
                nativeSchemas.push({
                    name: h.name,
                    description: h.description,
                    parameters: handoffParams as any,
                });
            }
        } else {
            const lines = ["", "## Handoffs"];
            for (const h of handoffList) {
                lines.push(`### ${h.name}\n${h.description}`);
                lines.push("Parameters:");
                lines.push("- `reason` (string): Free-text rationale.");
                lines.push("");
            }
            toolDesc = (toolDesc || "") + "\n" + lines.join("\n");
        }
    }

    // Wrap the legacy `emit` so every event also lifts into the typed stream.
    const legacyEmit = onEvent ?? defaultOnEvent;
    const emit: OnEvent = (kind, data) => {
        try { legacyEmit(kind, data); } catch { /* observer errors should not break the run */ }
        if (onStreamEvent) {
            try {
                const ev = streamEventFromKind(kind as any, data);
                void onStreamEvent(ev);
            } catch { /* observer errors should not break the run */ }
        }
    };

    const fireHook = async (
        event: keyof RunHooks<TContext>,
        payload: Record<string, unknown>,
    ): Promise<void> => {
        const targets: RunHooks<TContext>[] = [];
        if (hooks) targets.push(hooks);
        if (agentHooks) targets.push(agentHooks);
        for (const target of targets) {
            const fn = (target as any)[event];
            if (typeof fn !== "function") continue;
            try {
                await fn.call(target, { runContext, agentName, ...payload });
            } catch (hookErr) {
                emit("warn", { message: `${String(event)} hook error: ${hookErr}` });
            }
        }
    };

    await fireHook("onRunStart", { task });
    await fireHook("onAgentStart", { task });

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
    // Subagents (skipMemory=true) run isolated from parent memory — Hermes parity.
    if (learn && !runContext.skipMemory) {
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
    ];

    // ── Session backend preload (pluggable Session protocol) ───────────
    let sessionStartCursor = messages.length;
    if (sessionBackend) {
        try {
            const preloaded = await sessionBackend.getItems(sessionPreloadLimit ?? undefined);
            if (preloaded.length > 0) {
                messages.push(...preloaded);
                emit("context", { message: `session: preloaded ${preloaded.length} item(s) from ${sessionBackend.constructor.name}` });
            }
            sessionStartCursor = messages.length;
        } catch (err) {
            emit("warn", { message: `session preload failed: ${err}` });
        }
    }

    messages.push({ role: "user", content: task });

    // Session: write initial state
    if (sessionWriter) {
        sessionWriter.writeSystemPrompt(systemContent);
    }

    // ── Advisor model: phone-a-friend for strategic guidance ────────
    let advisorCallCount = 0;
    const consultAdvisor = async (msgs: LLMMessage[], trigger: string): Promise<void> => {
        if (!advisorLLM || advisorCallCount >= advisorMaxCalls) return;
        advisorCallCount++;
        emit("context", { message: `advisor consultation #${advisorCallCount} (${trigger})` });
        try {
            const advisorResponse = await advisorLLM.chat([
                { role: "system", content: "You are a senior advisor. Review the agent's full transcript and provide concise strategic guidance. Under 150 words. Use numbered steps, not explanations." },
                ...msgs,
                { role: "user", content: `[Advisor Request — ${trigger}] Review the conversation above and provide strategic guidance for the next steps.` },
            ]);
            if (advisorResponse.content) {
                msgs.push({ role: "user", content: `[Advisor Guidance]\n${advisorResponse.content}` });
                emit("context", { message: `advisor: ${advisorResponse.content.slice(0, 120)}...` });
            }
        } catch (err) {
            emit("warn", { message: `advisor consultation failed: ${err}` });
        }
    };

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
        usage,
        runContext: runContext as RunContext<unknown>,
    };

    // ── Input guardrails ─────────────────────────────────────────────
    let inputGuardrailRejected = false;
        for (const gr of inputGuardrails) {
            let result;
            try {
                result = await (gr as InputGuardrail<TContext>).run(runContext, task);
            } catch (grErr) {
                emit("warn", { message: `input guardrail '${gr.name}' threw: ${grErr}` });
                continue;
            }
            if (result.behavior === GuardrailBehavior.ALLOW) continue;
            emit("guardrail_tripped", {
                source: "input",
                guardrail: gr.name,
                behavior: result.behavior,
                message: result.message,
            });
            state.guardrailTripped = {
                source: "input",
                guardrail: gr.name,
                behavior: result.behavior,
                message: result.message,
            };
            if (result.behavior === GuardrailBehavior.REJECT_CONTENT) {
                state.status = "done";
                state.result = result.replacementOutput
                    ?? result.message
                    ?? `Input rejected by guardrail '${gr.name}'.`;
                inputGuardrailRejected = true;
                break;
            }
            if (result.behavior === GuardrailBehavior.RAISE_EXCEPTION) {
                await fireHook("onAgentEnd", { result: state.result });
                await fireHook("onRunEnd", { state });
                throw new GuardrailTripwireTriggered(gr.name, "input", result);
            }
        }

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
        for (let roundIdx = 0; !inputGuardrailRejected && roundIdx < effectiveMaxRounds; roundIdx++) {
            if (ac.signal.aborted) {
                state.status = "done";
                state.result = state.result || "[cancelled]";
                break;
            }

            // Consume one unit of the iteration budget. When exhausted,
            // surface the same "max_iterations" outcome as Hermes so
            // trajectory recorders flag the run as truncated rather than
            // successful. Round 0 always succeeds because the budget was
            // sized to ``maxIterations`` above.
            if (runContext.iterationBudget && !runContext.iterationBudget.consume()) {
                emit("warn", {
                    message:
                        `iteration budget exhausted ` +
                        `(${runContext.iterationBudget.used}/${runContext.iterationBudget.maxTotal})`,
                });
                state.status = "max_iterations";
                state.result = state.result || "[iteration budget exhausted]";
                break;
            }

            // Emit typed turn_started marker (openai-agents parity).
            emit("turn_started", { iteration: roundIdx, agent: agentName });
            await fireHook("onLLMStart", { iteration: roundIdx, messages });

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

            // ── Advisor: consult after initial orientation (first tool results in transcript)
            if (advisorLLM && roundIdx === 1 && advisorCallCount === 0) {
                await consultAdvisor(messages, "planning");
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

                // ── Usage accumulation (openai-agents parity) ─────────
                {
                    const totalTokens = response.tokensUsed ?? 0;
                    const inputTokens = response.promptTokens ?? 0;
                    const outputTokens = Math.max(totalTokens - inputTokens, 0);
                    const req = usage.addResponse({
                        model: response.model ?? "",
                        inputTokens,
                        outputTokens,
                        totalTokens,
                        cachedInputTokens: response.cacheReadTokens ?? 0,
                        cacheCreationTokens: response.cacheCreationTokens ?? 0,
                    });
                    emit("usage", {
                        model: req.model,
                        inputTokens: req.inputTokens,
                        outputTokens: req.outputTokens,
                        totalTokens: req.totalTokens,
                        cachedInputTokens: req.cachedInputTokens,
                        cacheCreationTokens: req.cacheCreationTokens,
                        cumulative: usage.totalTokens,
                    });
                }
                await fireHook("onLLMEnd", { response });

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

                // ── Advisor: final check before declaring done ──
                if (advisorLLM && advisorCallCount > 0 && advisorCallCount < advisorMaxCalls && state.toolCalls > 0) {
                    messages.push({ role: "assistant", content: response.content, thinking: _thinkingContent });
                    await consultAdvisor(messages, "final-check");
                    // If advisor injected guidance, let the LLM process it
                    if (messages[messages.length - 1]?.content?.toString().startsWith("[Advisor Guidance]")) {
                        continue;
                    }
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

            // ── Handoff dispatch (v6.4) ──────────────────────────────
            // If the LLM called a synthetic handoff tool, transfer
            // control to the target agent and return its terminal state.
            // We honour only the first handoff in a batch — multiple
            // handoffs in one turn don't make sense (a transfer is
            // exclusive).
            if (handoffMap.size > 0) {
                let handoffCallIdx = -1;
                for (let i = 0; i < toolCalls.length; i++) {
                    if (handoffMap.has(toolCalls[i]!.toolName)) {
                        handoffCallIdx = i;
                        break;
                    }
                }
                if (handoffCallIdx >= 0) {
                    const hc = toolCalls[handoffCallIdx]!;
                    const hObj = handoffMap.get(hc.toolName)!;
                    const reasonText = typeof (hc.args as Record<string, unknown>)?.reason === "string"
                        ? String((hc.args as Record<string, unknown>).reason)
                        : "";
                    const nativeTc = useNativeTools && handoffCallIdx < nativeToolCallObjects.length
                        ? nativeToolCallObjects[handoffCallIdx]
                        : undefined;

                    let targetAgent: import("../agent.js").ClawAgent;
                    try {
                        targetAgent = hObj.targetAgentFactory();
                    } catch (resolveErr) {
                        emit("warn", { message: `handoff target resolution failed: ${resolveErr}` });
                        messages.push({
                            role: "user",
                            content: `[Handoff Error] Could not resolve target agent: ${resolveErr}`,
                        });
                        state.iterations += 1;
                        continue;
                    }

                    const targetName = (targetAgent as unknown as { name?: unknown }).name as string | undefined ?? hc.toolName;
                    const fromName = agentName;

                    // Stamp the assistant message that triggered the handoff
                    // so the input filter sees a complete transcript, then
                    // synthesise a tool-result acknowledgement (most providers
                    // reject orphan tool calls).
                    if (useNativeTools && nativeTc?.toolCallId) {
                        messages.push({
                            role: "assistant",
                            content: response.content || "",
                            toolCallsMeta: [{
                                id: nativeTc.toolCallId,
                                name: hc.toolName,
                                args: hc.args,
                            }],
                            ...(response.geminiParts ? { geminiParts: response.geminiParts } : {}),
                            thinking: _thinkingContent,
                        });
                        messages.push({
                            role: "tool",
                            content: `[Handoff] transferred to ${targetName}`,
                            toolCallId: nativeTc.toolCallId,
                        });
                    } else {
                        messages.push({
                            role: "assistant",
                            content: `{"tool": "${hc.toolName}", "args": ${JSON.stringify(hc.args)}}`,
                            thinking: _thinkingContent,
                        });
                        messages.push({
                            role: "user",
                            content: `[Handoff] transferred to ${targetName}`,
                        });
                    }

                    const handoffPayload: import("../handoffs.js").HandoffInputData<TContext> = {
                        inputHistory: [...messages],
                        preHandoffItems: messages.slice(0, sessionStartCursor) as unknown[],
                        newItems: messages.slice(sessionStartCursor) as unknown[],
                        runContext,
                    };
                    let filteredPayload = handoffPayload;
                    if (hObj.inputFilter) {
                        try {
                            filteredPayload = hObj.inputFilter(handoffPayload);
                        } catch (filterErr) {
                            emit("warn", { message: `handoff inputFilter raised: ${filterErr}` });
                        }
                    }
                    const filteredMessages = filteredPayload.inputHistory;

                    if (hObj.onHandoff) {
                        try {
                            await hObj.onHandoff(runContext);
                        } catch (hkErr) {
                            emit("warn", { message: `handoff onHandoff raised: ${hkErr}` });
                        }
                    }
                    await fireHook("onHandoff", { fromAgent: fromName, toAgent: targetName });

                    emit("warn", { message: `handoff: ${fromName} → ${targetName}` });
                    emit("handoff_occurred", {
                        fromAgent: fromName,
                        toAgent: targetName,
                        toolName: hc.toolName,
                        reason: reasonText,
                    });

                    // Forward the most recent user message (or the original
                    // task) and pre-load any other non-system messages via
                    // a transient session protocol.
                    let forwardTask: string = task;
                    for (let i = filteredMessages.length - 1; i >= 0; i--) {
                        const m = filteredMessages[i]!;
                        if (m.role === "user" && typeof m.content === "string") {
                            forwardTask = m.content;
                            break;
                        }
                    }
                    let preload = filteredMessages.filter((m) => m.role !== "system");
                    if (
                        preload.length > 0 &&
                        preload[preload.length - 1]!.role === "user" &&
                        typeof preload[preload.length - 1]!.content === "string" &&
                        preload[preload.length - 1]!.content === forwardTask
                    ) {
                        preload = preload.slice(0, -1);
                    }

                    const transientSession: Session | undefined = preload.length > 0
                        ? {
                              sessionId: `handoff:${hc.toolName}`,
                              async getItems(): Promise<LLMMessage[]> {
                                  return [...preload];
                              },
                              async addItems(_items: LLMMessage[]): Promise<void> {
                                  /* no-op */
                              },
                              async popItem(): Promise<LLMMessage | null> {
                                  return null;
                              },
                              async clearSession(): Promise<void> {
                                  /* no-op */
                              },
                          }
                        : undefined;

                    let childState;
                    try {
                        childState = await handoffSpan(
                            hc.toolName,
                            async () => targetAgent.invoke(forwardTask, undefined, undefined, undefined, undefined, {
                                runContext: runContext as RunContext<unknown> as RunContext<TContext>,
                                onStreamEvent,
                                ...(transientSession ? { session: transientSession } : {}),
                            }),
                            { fromAgent: fromName, toAgent: targetName },
                        );
                    } catch (runErr) {
                        emit("warn", { message: `handoff target raised: ${runErr}` });
                        messages.push({
                            role: "user",
                            content: `[Handoff Error] Target agent failed: ${runErr}`,
                        });
                        state.iterations += 1;
                        continue;
                    }

                    state.result = childState.result;
                    state.status = childState.status === "running" ? "done" : childState.status;
                    state.finalOutput = childState.finalOutput !== undefined && childState.finalOutput !== null
                        ? childState.finalOutput
                        : childState.result;
                    state.toolCalls += childState.toolCalls;
                    state.iterations += 1;
                    state.messages = [...messages, ...childState.messages];
                    break;
                }
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
                const repeatedCalls = toolCalls.filter((c) =>
                    loopTracker.isSoftLooping(c.toolName, c.args),
                );
                const repeatedNames = repeatedCalls.map((c) => c.toolName).join(", ");
                const hasRepeatedExecute = repeatedCalls.some((c) => c.toolName === "execute");
                emit("warn", { message: `repeated tool call warning #${n}: ${repeatedNames}` });
                messages.push({
                    role: "user",
                    content: hasRepeatedExecute
                        ? `[System] You are re-calling the same execute command with the same arguments. The command already ran; if the previous result has success=false or a nonzero exit_code, treat stdout/stderr as diagnostic feedback, not as a tool failure. Read the prior output, then edit code or inspect new evidence before trying again. Do not rerun this command until something relevant changed. If you believe the task is complete, provide your final answer now.`
                        : `[System] You are re-calling ${repeatedNames} with the same arguments. You already have the result in the conversation above. Use the existing data instead of re-reading. If you believe the task is complete, provide your final answer now.`,
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
                    let approved = true;
                    let hookReason = "rejected by before_tool hook";
                    try {
                        const hookRaw = beforeTool(call.toolName, call.args);
                        if (hookRaw !== null && typeof hookRaw === "object") {
                            approved = hookRaw.allowed;
                            if (hookRaw.reason) hookReason = hookRaw.reason;
                            if (hookRaw.allowed && hookRaw.updatedArgs !== undefined) {
                                call = { toolName: call.toolName, args: hookRaw.updatedArgs };
                            }
                            if (hookRaw.messages) messages.push(...hookRaw.messages);
                        } else {
                            approved = !!hookRaw;
                        }
                    } catch (hookErr) { emit("warn", { message: `beforeTool hook error: ${hookErr}` }); }
                    if (!approved) {
                        emit("tool_skipped", { name: call.toolName, reason: hookReason });
                        messages.push({ role: "assistant", content: `{"tool": "${call.toolName}", "args": ${JSON.stringify(call.args)}}` });
                        messages.push({ role: "user", content: `[Tool Skipped] ${call.toolName} was not approved. Reason: ${hookReason}` });
                        continue;
                    }
                }

                // ── Per-call approval (sticky via RunContext) ──────
                const callId = nativeTc?.toolCallId || `synthetic-${roundIdx}-${call.toolName}`;
                const existingApproval = runContext.isToolApproved(callId, { toolName: call.toolName });
                let approvedByUser = existingApproval;
                if (existingApproval === undefined && approvalHandler) {
                    try {
                        const record = await approvalHandler({
                            toolName: call.toolName,
                            toolCallId: callId,
                            args: call.args,
                            runContext: runContext as RunContext<unknown>,
                        });
                        if (record) {
                            if (record.approved) runContext.approveTool(callId, { always: record.always, toolName: call.toolName });
                            else runContext.rejectTool(callId, { always: record.always, toolName: call.toolName, reason: record.reason });
                            approvedByUser = record.approved;
                        }
                    } catch (apprErr) { emit("warn", { message: `approvalHandler error: ${apprErr}` }); }
                }
                if (existingApproval === undefined && approvedByUser === undefined && inputGuardrails.length === 0 && !approvalHandler) {
                    approvedByUser = true; // default: no approval gate configured → allow
                }
                if (approvedByUser === undefined) {
                    emit("approval_required", { name: call.toolName, callId, args: call.args });
                    approvedByUser = false;
                }
                if (!approvedByUser) {
                    const reason = runContext.getApproval(callId, { toolName: call.toolName })?.reason ?? "approval not granted";
                    emit("tool_skipped", { name: call.toolName, reason });
                    messages.push({ role: "assistant", content: `{"tool": "${call.toolName}", "args": ${JSON.stringify(call.args)}}` });
                    messages.push({ role: "user", content: `[Tool Skipped] ${call.toolName} was not approved. Reason: ${reason}` });
                    continue;
                }

                loopTracker.record(call.toolName, call.args);

                await fireHook("onToolStart", { toolName: call.toolName, args: call.args, toolCallId: callId });
                emit("tool_started", { name: call.toolName, callId, args: call.args });
                // ── Activity heartbeats (Hermes parity) ─────────────────
                // Long-running tools (slow web fetches, deep bash runs)
                // would otherwise produce zero events between start and
                // finish; upstream proxies and chat-platform gateways
                // interpret that as "idle" and kill the connection.
                // Emit a periodic ``tool_heartbeat`` while the call is in
                // flight so listeners can keep the channel alive and surface
                // progress.
                let toolResult = await runWithHeartbeat(
                    registry!.executeTool(
                        call.toolName,
                        call.args,
                        runContext as RunContext<unknown>,
                    ),
                    {
                        onEvent: (kind, payload) => emit(kind as EventKind, payload),
                        kind: "tool_heartbeat",
                        payload: { tool_name: call.toolName, call_id: callId },
                        intervalMs: DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS,
                    },
                );
                state.toolCalls++;
                await fireHook("onToolEnd", { toolName: call.toolName, args: call.args, result: toolResult, toolCallId: callId });

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

                const rawOutput = toolObservation(toolResult);

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
                        // ── Advisor: consult when stuck ──
                        await consultAdvisor(messages, "stuck");
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
                let approvedOrigIndices = toolCalls.map((_, idx) => idx);
                if (beforeTool) {
                    const remapped: import("../tools/registry.js").ParsedToolCall[] = [];
                    const remappedOrigIndices: number[] = [];
                    for (let idx = 0; idx < toolCalls.length; idx++) {
                        const call = toolCalls[idx]!;
                        let approved = true;
                        let remappedCall = call;
                        try {
                            const hookRaw = beforeTool(call.toolName, call.args);
                            if (hookRaw !== null && typeof hookRaw === "object") {
                                approved = hookRaw.allowed;
                                if (hookRaw.allowed && hookRaw.updatedArgs !== undefined) {
                                    remappedCall = { toolName: call.toolName, args: hookRaw.updatedArgs };
                                }
                                if (hookRaw.messages) messages.push(...hookRaw.messages);
                            } else {
                                approved = !!hookRaw;
                            }
                        } catch (hookErr) { emit("warn", { message: `beforeTool hook error: ${hookErr}` }); }
                        if (!approved) emit("tool_skipped", { name: call.toolName });
                        else {
                            remapped.push(remappedCall);
                            remappedOrigIndices.push(idx);
                        }
                    }
                    approvedCalls = remapped;
                    approvedOrigIndices = remappedOrigIndices;
                }

                // ── Per-call approval (sticky via RunContext) — parallel ─────
                const gatedCalls: import("../tools/registry.js").ParsedToolCall[] = [];
                const gatedOrigIndices: number[] = [];
                const approvedCallIds: string[] = [];
                for (let idx = 0; idx < approvedCalls.length; idx++) {
                    const call = approvedCalls[idx]!;
                    const origIdx = approvedOrigIndices[idx] ?? idx;
                    const ntc = nativeToolCallObjects[origIdx];
                    const callId = ntc?.toolCallId || `synthetic-${roundIdx}-${origIdx}-${call.toolName}`;
                    let approved = runContext.isToolApproved(callId, { toolName: call.toolName });
                    if (approved === undefined && approvalHandler) {
                        try {
                            const record = await approvalHandler({
                                toolName: call.toolName,
                                toolCallId: callId,
                                args: call.args,
                                runContext: runContext as RunContext<unknown>,
                            });
                            if (record) {
                                if (record.approved) runContext.approveTool(callId, { always: record.always, toolName: call.toolName });
                                else runContext.rejectTool(callId, { always: record.always, toolName: call.toolName, reason: record.reason });
                                approved = record.approved;
                            }
                        } catch (apprErr) { emit("warn", { message: `approvalHandler error: ${apprErr}` }); }
                    }
                    if (approved === undefined && !approvalHandler) {
                        approved = true;
                    }
                    if (approved === false) {
                        const reason = runContext.getApproval(callId, { toolName: call.toolName })?.reason ?? "approval not granted";
                        emit("tool_skipped", { name: call.toolName, reason });
                        messages.push({ role: "user", content: `[Tool Skipped] ${call.toolName} was not approved. Reason: ${reason}` });
                        continue;
                    }
                    if (approved === undefined) {
                        emit("approval_required", { name: call.toolName, callId, args: call.args });
                        messages.push({ role: "user", content: `[Tool Skipped] ${call.toolName} requires approval but none was granted.` });
                        continue;
                    }
                    gatedCalls.push(call);
                    gatedOrigIndices.push(origIdx);
                    approvedCallIds.push(callId);
                }
                approvedCalls = gatedCalls;
                approvedOrigIndices = gatedOrigIndices;

                if (approvedCalls.length === 0) {
                    messages.push({ role: "user", content: "[All tools were rejected by approval hook]" });
                    continue;
                }

                loopTracker.recordBatch(approvedCalls);

                // onToolStart for each approved call
                for (let idx = 0; idx < approvedCalls.length; idx++) {
                    const call = approvedCalls[idx]!;
                    const callId = approvedCallIds[idx]!;
                    emit("tool_call", { name: call.toolName });
                    await fireHook("onToolStart", { toolName: call.toolName, args: call.args, toolCallId: callId });
                    emit("tool_started", { name: call.toolName, callId, args: call.args });
                }

                // Heartbeat across the parallel batch; ``call_ids`` lets
                // listeners disambiguate which group is currently in flight.
                const results = await runWithHeartbeat(
                    registry!.executeToolsParallel(
                        approvedCalls,
                        runContext as RunContext<unknown>,
                    ),
                    {
                        onEvent: (kind, payload) => emit(kind as EventKind, payload),
                        kind: "tool_heartbeat",
                        payload: {
                            parallel: true,
                            tool_names: approvedCalls.map((c) => c.toolName),
                            call_ids: approvedCallIds,
                        },
                        intervalMs: DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS,
                    },
                );
                state.toolCalls += approvedCalls.length;

                // onToolEnd for each approved call
                for (let idx = 0; idx < approvedCalls.length; idx++) {
                    const call = approvedCalls[idx]!;
                    const callId = approvedCallIds[idx]!;
                    await fireHook("onToolEnd", { toolName: call.toolName, args: call.args, result: results[idx], toolCallId: callId });
                }

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
                    const rawOut = toolObservation(result);
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
                    const tcMeta = approvedCalls.map((call, idx) => {
                        const ntc = nativeToolCallObjects[approvedOrigIndices[idx] ?? idx];
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
                        const ntc = nativeToolCallObjects[approvedOrigIndices[idx] ?? idx];
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
                        // ── Advisor: consult when stuck ──
                        await consultAdvisor(messages, "stuck");
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
    // Skipped for subagents (skipMemory=true) so they don't pollute parent lessons.
    if (learn && recorder && runSummary && !runContext.skipMemory) {
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

    // ── Output guardrails ────────────────────────────────────────────
    if (!inputGuardrailRejected && outputGuardrails.length > 0 && state.result) {
        for (const gr of outputGuardrails) {
            let result;
            try {
                result = await (gr as OutputGuardrail<TContext>).run(runContext, state.result);
            } catch (grErr) {
                emit("warn", { message: `output guardrail '${gr.name}' threw: ${grErr}` });
                continue;
            }
            if (result.behavior === GuardrailBehavior.ALLOW) continue;
            emit("guardrail_tripped", {
                source: "output",
                guardrail: gr.name,
                behavior: result.behavior,
                message: result.message,
            });
            state.guardrailTripped = {
                source: "output",
                guardrail: gr.name,
                behavior: result.behavior,
                message: result.message,
            };
            if (result.behavior === GuardrailBehavior.REJECT_CONTENT) {
                state.result = result.replacementOutput
                    ?? result.message
                    ?? `Output rejected by guardrail '${gr.name}'.`;
                break;
            }
            if (result.behavior === GuardrailBehavior.RAISE_EXCEPTION) {
                await fireHook("onAgentEnd", { result: state.result });
                await fireHook("onRunEnd", { state });
                throw new GuardrailTripwireTriggered(gr.name, "output", result);
            }
        }
    }

    // ── Structured output parsing (outputType) ─────────────────────
    if (outputType && state.status === "done" && state.result) {
        try {
            if (typeof outputType === "function") {
                state.finalOutput = outputType(state.result);
            } else if (typeof (outputType as any).safeParse === "function") {
                // Try to JSON.parse first; pass raw string through if parse fails.
                let candidate: unknown = state.result;
                try { candidate = JSON.parse(state.result); } catch { /* fallthrough */ }
                const parsed = (outputType as { safeParse(v: unknown): { success: true; data: unknown } | { success: false; error: unknown } }).safeParse(candidate);
                if (parsed.success) state.finalOutput = parsed.data;
                else emit("warn", { message: `outputType.safeParse failed: ${String((parsed as { error: unknown }).error)}` });
            }
            if (state.finalOutput !== undefined) {
                emit("final_output", { finalOutput: state.finalOutput });
            }
        } catch (err) {
            emit("warn", { message: `outputType parse error: ${err}` });
        }
    }

    // ── Session backend persistence (final flush) ─────────────────
    if (sessionBackend) {
        try {
            const newItems = messages.slice(sessionStartCursor);
            if (newItems.length > 0) await sessionBackend.addItems(newItems);
        } catch (err) {
            emit("warn", { message: `session persistence failed: ${err}` });
        }
    }

    await fireHook("onAgentEnd", { result: state.result });
    await fireHook("onRunEnd", { state });

    emit("agent_done", {
        tool_calls: state.toolCalls,
        iterations: state.iterations,
        elapsed,
    });
    return state;
}
