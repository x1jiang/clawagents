import type { LLMProvider } from "../providers/llm.js";
import { countTokens } from "../tokenizer.js";

export type AgentMessage = {
    role: "system" | "user" | "assistant";
    content: string;
    timestamp?: number;
};

export const BASE_CHUNK_RATIO = 0.4;
export const MIN_CHUNK_RATIO = 0.15;
export const SAFETY_MARGIN = 1.2;
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";

export function estimateTokens(message: AgentMessage): number {
    // Uses tiktoken when available; falls back to heuristic
    return countTokens(message.content ?? "");
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
    return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

export function chunkMessagesByMaxTokens(
    messages: AgentMessage[],
    maxTokens: number,
): AgentMessage[][] {
    if (messages.length === 0) {
        return [];
    }

    const chunks: AgentMessage[][] = [];
    let currentChunk: AgentMessage[] = [];
    let currentTokens = 0;

    for (const message of messages) {
        const messageTokens = estimateTokens(message);
        if (currentChunk.length > 0 && currentTokens + messageTokens > maxTokens) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }

        currentChunk.push(message);
        currentTokens += messageTokens;

        if (messageTokens > maxTokens) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

export async function summarizeWithFallback(params: {
    llm: LLMProvider;
    messages: AgentMessage[];
    maxChunkTokens: number;
    contextWindow: number;
    previousSummary?: string;
}): Promise<string> {
    const { llm, messages, maxChunkTokens, previousSummary } = params;

    if (messages.length === 0) {
        return previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
    }

    const chunks = chunkMessagesByMaxTokens(messages, maxChunkTokens);

    let currentSummary = previousSummary || "No prior events.";

    for (const chunk of chunks) {
        const textLog = chunk
            .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
            .join("\n\n");

        const prompt = `You are a summarization engine for an AI agent. 
Compress the following event log into a concise technical summary.
Focus on actions taken, tools used, results observed, and current state.
Do NOT lose critical facts like file paths, errors, or exact values extracted.

Previous summary state:
${currentSummary}

New events to summarize into the state:
${textLog}

Return ONLY the updated comprehensive summary.`;

        try {
            const resp = await llm.chat([{ role: "user", content: prompt }]);
            currentSummary = resp.content.trim();
        } catch (e) {
            console.error("[Compaction] LLM Summarization failed, falling back to basic join.", e);
            currentSummary += `\n[Summarized ${chunk.length} messages]`;
        }
    }

    return currentSummary || DEFAULT_SUMMARY_FALLBACK;
}

export function pruneHistoryForContextShare(params: {
    messages: AgentMessage[];
    maxContextTokens: number;
    maxHistoryShare?: number;
}): {
    messages: AgentMessage[];
    droppedMessagesList: AgentMessage[];
    droppedChunks: number;
    droppedTokens: number;
    keptTokens: number;
} {
    const maxHistoryShare = params.maxHistoryShare ?? 0.5;
    const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxHistoryShare));

    const allDroppedMessages: AgentMessage[] = [];
    let droppedChunks = 0;
    let droppedTokens = 0;
    let totalTokens = estimateMessagesTokens(params.messages);
    let dropIdx = 0;

    while (dropIdx < params.messages.length && totalTokens > budgetTokens) {
        const msg = params.messages[dropIdx]!;
        const msgTokens = estimateTokens(msg);
        allDroppedMessages.push(msg);
        droppedTokens += msgTokens;
        totalTokens -= msgTokens;
        droppedChunks++;
        dropIdx++;
    }

    const keptMessages = params.messages.slice(dropIdx);

    return {
        messages: keptMessages,
        droppedMessagesList: allDroppedMessages,
        droppedChunks,
        droppedTokens,
        keptTokens: estimateMessagesTokens(keptMessages),
    };
}

// ──────────────────────────────────────────────────────────────────────
// Hardened compression (v6.5): head/tail protection + anti-thrash detector
//
// The legacy `pruneHistoryForContextShare` drops messages purely from the
// front, which can silently lose the system prompt or the active task. The
// helpers below add the guardrails real agent runs need:
//
// - **Protect head**: keep the first `protectFirstN` messages.
// - **Protect tail**: keep the last `protectLastN` messages.
// - **Preserve last user message**: even when the tail budget is small,
//   the most recent user message is *never* dropped — losing it strands
//   the agent on a stale objective.
// - **Static fallback summary**: if `summarizeWithFallback` returns the
//   default no-history string and we did drop turns, inject a visible
//   marker so the model knows context was lost.
// - **Anti-thrash detector**: `isCompressionThrashing` flags consecutive
//   ineffective compressions so callers can surface a warning instead of
//   looping endlessly.
//
// Mirrors `clawagents_py/src/clawagents/memory/compaction.py`.
// ──────────────────────────────────────────────────────────────────────

export const DEFAULT_PROTECT_FIRST = 1;
export const DEFAULT_PROTECT_LAST = 4;
export const INEFFECTIVE_SAVINGS_PCT = 10.0;
export const THRASH_THRESHOLD = 2;

const COMPRESSION_NOTE =
    "[Note: Earlier conversation turns were compacted into a handoff summary " +
    "to free context space. Build on that summary rather than re-doing work.]";

const FALLBACK_SUMMARY = (n: number): string =>
    `[Context summary unavailable — ${n} earlier turn(s) were removed to free space ` +
    `but could not be summarized. Continue based on the recent messages below ` +
    `and the current state of any files/resources.]`;

function lastUserIndex(messages: AgentMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]!.role === "user") return i;
    }
    return -1;
}

export interface CompressMessagesSafeResult {
    messages: AgentMessage[];
    droppedMessagesList: AgentMessage[];
    summary: string;
    compressionSavingsPct: number;
    effective: boolean;
}

export async function compressMessagesSafe(params: {
    llm: LLMProvider;
    messages: AgentMessage[];
    contextWindow: number;
    maxChunkTokens?: number;
    protectFirstN?: number;
    protectLastN?: number;
    previousSummary?: string;
}): Promise<CompressMessagesSafeResult> {
    const {
        llm,
        messages,
        contextWindow,
        maxChunkTokens,
        protectFirstN = DEFAULT_PROTECT_FIRST,
        protectLastN = DEFAULT_PROTECT_LAST,
        previousSummary,
    } = params;

    if (messages.length === 0) {
        return {
            messages: [],
            droppedMessagesList: [],
            summary: previousSummary ?? "No prior history.",
            compressionSavingsPct: 0,
            effective: false,
        };
    }

    const n = messages.length;
    const headEnd = Math.max(0, Math.min(protectFirstN, n));
    const tailStartNaive = Math.max(headEnd, n - Math.max(0, protectLastN));

    const lastUser = lastUserIndex(messages);
    const tailStart = lastUser >= headEnd && lastUser < tailStartNaive ? lastUser : tailStartNaive;

    const head = messages.slice(0, headEnd).map((m) => ({ ...m }));
    const middle = messages.slice(headEnd, tailStart);
    const tail = messages.slice(tailStart).map((m) => ({ ...m }));

    if (middle.length === 0) {
        return {
            messages: messages.slice(),
            droppedMessagesList: [],
            summary: previousSummary ?? "",
            compressionSavingsPct: 0,
            effective: false,
        };
    }

    const chunkTokens = maxChunkTokens ?? Math.max(512, Math.floor(contextWindow * BASE_CHUNK_RATIO));
    let summary = await summarizeWithFallback({
        llm,
        messages: middle,
        maxChunkTokens: chunkTokens,
        contextWindow,
        previousSummary,
    });

    if (!summary || summary === "No prior history.") {
        summary = FALLBACK_SUMMARY(middle.length);
    }

    if (head.length > 0 && head[0]!.role === "system" && !head[0]!.content.includes(COMPRESSION_NOTE)) {
        const sysContent = head[0]!.content ?? "";
        head[0] = {
            ...head[0]!,
            content: sysContent
                ? `${sysContent}\n\n${COMPRESSION_NOTE}`
                : COMPRESSION_NOTE,
        };
    }

    const lastHeadRole = head.length > 0 ? head[head.length - 1]!.role : "user";
    const firstTailRole = tail.length > 0 ? tail[0]!.role : "user";
    let summaryRole: AgentMessage["role"] =
        lastHeadRole === "assistant" ? "user" : "assistant";
    if (summaryRole === firstTailRole) {
        const flipped: AgentMessage["role"] =
            summaryRole === "assistant" ? "user" : "assistant";
        if (flipped !== lastHeadRole) summaryRole = flipped;
    }

    const summaryMsg: AgentMessage = { role: summaryRole, content: summary };
    const newMessages = [...head, summaryMsg, ...tail];
    const before = estimateMessagesTokens(messages);
    const after = estimateMessagesTokens(newMessages);
    const saved = before - after;
    const pct = before > 0 ? (saved / before) * 100 : 0;

    return {
        messages: newMessages,
        droppedMessagesList: middle.slice(),
        summary,
        compressionSavingsPct: pct,
        effective: pct >= INEFFECTIVE_SAVINGS_PCT,
    };
}

/**
 * Return true if the last `THRASH_THRESHOLD` compressions all saved less
 * than {@link INEFFECTIVE_SAVINGS_PCT}. Callers should append each
 * compression's `compressionSavingsPct` to a list and pass it here.
 */
export function isCompressionThrashing(savingsHistory: number[]): boolean {
    if (savingsHistory.length < THRASH_THRESHOLD) return false;
    const recent = savingsHistory.slice(-THRASH_THRESHOLD);
    return recent.every((s) => s < INEFFECTIVE_SAVINGS_PCT);
}
