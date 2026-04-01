/**
 * Continuous Background Memory Extraction (learned from Claude Code).
 *
 * Instead of extracting lessons only at end-of-run, this module provides
 * a background extraction mechanism that runs every N turns during the
 * agent loop.
 */

import { writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const EXTRACTION_INTERVAL = 5;

const MEMORY_EXTRACTION_PROMPT = `\
You are analyzing a recent segment of an AI agent's conversation to extract \
durable, reusable memories.

## Recent Conversation Segment (turns {startTurn} to {endTurn})
{conversationSegment}

## Instructions
Extract 0-3 short, typed memories from this conversation segment. Each memory \
should be a reusable fact, preference, or project detail that would help the agent \
in future runs.

Respond with a JSON array. Each entry:
\`\`\`json
[
  {
    "type": "project|user|feedback|reference",
    "content": "one-line actionable memory",
    "confidence": 0.0-1.0
  }
]
\`\`\`

Only extract HIGH-CONFIDENCE memories (>0.7). If nothing is worth remembering, \
respond with \`[]\`.
`;

function formatMessagesSegment(messages: any[], start: number, end: number): string {
    const lines: string[] = [];
    for (let i = start; i < Math.min(end, messages.length); i++) {
        const msg = messages[i];
        const role = (msg.role || "unknown").toUpperCase();
        const content = (typeof msg.content === "string" ? msg.content : String(msg.content)).slice(0, 300);
        lines.push(`[${role} turn ${i}]: ${content}`);
    }
    return lines.join("\n");
}

export interface ExtractedMemory {
    type: string;
    content: string;
    confidence: number;
}

export async function extractBackgroundMemories(
    llm: any,
    messages: any[],
    startTurn: number,
    endTurn: number,
): Promise<ExtractedMemory[]> {
    const segment = formatMessagesSegment(messages, startTurn, endTurn);
    const prompt = MEMORY_EXTRACTION_PROMPT
        .replace("{startTurn}", String(startTurn))
        .replace("{endTurn}", String(endTurn))
        .replace("{conversationSegment}", segment);

    try {
        const response = await llm.chat([{ role: "user", content: prompt }]);
        let text = response.content?.trim() ?? "";

        // Handle fenced code blocks
        const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        if (fenceMatch) text = fenceMatch[1]!.trim();

        const memories = JSON.parse(text);
        if (!Array.isArray(memories)) return [];

        return memories.filter(
            (m: any) => typeof m === "object" && m && (m.confidence ?? 0) >= 0.7,
        ) as ExtractedMemory[];
    } catch {
        return [];
    }
}

export function saveMemories(memories: ExtractedMemory[], turnIndex: number): string | null {
    if (memories.length === 0) return null;

    try {
        const memDir = resolve(process.cwd(), ".clawagents", "memories");
        mkdirSync(memDir, { recursive: true });

        const ts = Math.floor(Date.now() / 1000);
        const entries = memories.map((m) =>
`---
type: ${m.type}
confidence: ${m.confidence}
turn: ${turnIndex}
timestamp: ${ts}
---
${m.content}
`);

        const memFile = resolve(memDir, "extracted.md");
        appendFileSync(memFile, entries.join("\n") + "\n", "utf-8");
        return memFile;
    } catch {
        return null;
    }
}

export async function maybeExtractMemories(
    llm: any,
    messages: any[],
    roundIdx: number,
    lastExtractionTurn: number,
    interval = EXTRACTION_INTERVAL,
): Promise<number> {
    try {
        const envVal = process.env["CLAW_FEATURE_BACKGROUND_MEMORY"] ?? "0";
        if (!["1", "true", "yes", "on"].includes(envVal.toLowerCase())) return lastExtractionTurn;
    } catch { return lastExtractionTurn; }

    if (roundIdx - lastExtractionTurn < interval) return lastExtractionTurn;

    try {
        const start = Math.max(0, lastExtractionTurn);
        const end = Math.min(messages.length, roundIdx + 2);
        const memories = await extractBackgroundMemories(llm, messages, start, end);
        if (memories.length > 0) {
            saveMemories(memories, roundIdx);
        }
    } catch {
        // Background extraction failure should never block the loop
    }

    return roundIdx;
}
