import type { LLMProvider } from "../providers/llm.js";

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
    // Rough estimation: 4 chars per token
    return Math.ceil((message.content?.length || 0) / 4);
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

    let keptMessages = [...params.messages];
    const allDroppedMessages: AgentMessage[] = [];
    let droppedChunks = 0;
    let droppedTokens = 0;

    // Simple pruning logic based on token limits
    while (keptMessages.length > 0 && estimateMessagesTokens(keptMessages) > budgetTokens) {
        // Drop older messages from the beginning
        const dropped = keptMessages.shift();
        if (dropped) {
            allDroppedMessages.push(dropped);
            droppedTokens += estimateTokens(dropped);
            droppedChunks++;
        }
    }

    return {
        messages: keptMessages,
        droppedMessagesList: allDroppedMessages,
        droppedChunks,
        droppedTokens,
        keptTokens: estimateMessagesTokens(keptMessages),
    };
}
