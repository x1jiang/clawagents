/** Compact oversized tool results before summarization (DeepAgents 1.10.2). */

import type { LLMMessage } from "../providers/llm.js";

function contentChars(content: string): number {
    return content.length;
}

export function compactToolResults(
    messages: LLMMessage[],
    opts: {
        maxInputTokens: number;
        tokenMultiplier?: number;
        headroomRatio?: number;
    },
): [messages: LLMMessage[], modified: boolean] {
    const tokenMultiplier = opts.tokenMultiplier ?? 1.0;
    const headroomRatio = opts.headroomRatio ?? 0.7;

    const toolIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
        if (messages[i]!.role === "tool") toolIndices.push(i);
    }
    if (toolIndices.length === 0) return [messages, false];

    const toolIndexSet = new Set(toolIndices);
    let nonToolChars = 0;
    for (let i = 0; i < messages.length; i++) {
        if (!toolIndexSet.has(i)) {
            nonToolChars += contentChars(String(messages[i]!.content));
        }
    }

    const adjustedMax = Math.max(Math.floor(opts.maxInputTokens / Math.max(tokenMultiplier, 0.1)), 1000);
    const budgetForTools = Math.max(Math.floor(adjustedMax * 4 * headroomRatio) - nonToolChars, 4000);
    const perToolChars = Math.max(Math.floor(budgetForTools / toolIndices.length), 500);

    let modified = false;
    const out = messages.map((m) => ({ ...m }));
    for (const idx of toolIndices) {
        const m = messages[idx]!;
        const content = String(m.content);
        if (content.length > perToolChars) {
            out[idx] = {
                ...m,
                content: content.slice(0, perToolChars) + "\n...(result truncated before compaction)",
            };
            modified = true;
        }
    }
    return [out, modified];
}
