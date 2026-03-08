/**
 * Accurate token counting with js-tiktoken (optional) and graceful fallback.
 *
 * When js-tiktoken is installed, uses BPE encoding matched to the model for
 * precise counts.  When it isn't, falls back to the legacy 4-chars-per-token
 * heuristic and logs a one-time warning.
 */

import type { LLMMessage } from "./providers/llm.js";

// ── Constants ─────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN_FALLBACK = 4;

/** Per-message overhead tokens (role, delimiters, etc.) */
const PER_MESSAGE_OVERHEAD = 4;

// ── Encoding resolution ──────────────────────────────────────────────────

/** Model prefix → tiktoken encoding name. More specific prefixes first. */
const MODEL_TO_ENCODING: [string, string][] = [
    // GPT-5 series uses o200k_base
    ["gpt-5", "o200k_base"],
    // GPT-4o series uses o200k_base
    ["gpt-4o", "o200k_base"],
    // o-series reasoning models
    ["o1", "o200k_base"],
    ["o3", "o200k_base"],
    ["o4", "o200k_base"],
    // Legacy GPT-4 / GPT-3.5
    ["gpt-4", "cl100k_base"],
    ["gpt-3.5", "cl100k_base"],
];

const DEFAULT_ENCODING = "o200k_base";

function encodingForModel(model?: string): string {
    if (model) {
        const lower = model.toLowerCase();
        for (const [prefix, enc] of MODEL_TO_ENCODING) {
            if (lower.startsWith(prefix)) return enc;
        }
    }
    return DEFAULT_ENCODING;
}

// ── Lazy encoder cache ───────────────────────────────────────────────────

type Encoder = { encode: (text: string) => number[] };

const encoderCache = new Map<string, Encoder | null>();
let fallbackWarned = false;

async function getEncoder(encodingName: string): Promise<Encoder | null> {
    if (encoderCache.has(encodingName)) {
        return encoderCache.get(encodingName) ?? null;
    }

    try {
        // js-tiktoken provides encodingForModel and getEncoding
        const tiktoken = await import("js-tiktoken");
        const encoder = tiktoken.getEncoding(encodingName as any);
        encoderCache.set(encodingName, encoder);
        return encoder;
    } catch {
        if (!fallbackWarned) {
            fallbackWarned = true;
            console.warn(
                "[tokenizer] js-tiktoken is not installed — falling back to " +
                "rough 4-chars-per-token estimation.  Install it for accurate " +
                "token counts:  npm install js-tiktoken",
            );
        }
        encoderCache.set(encodingName, null);
        return null;
    }
}

// ── Synchronous fallback (used when encoder is already cached) ───────────

function getEncoderSync(encodingName: string): Encoder | null {
    return encoderCache.get(encodingName) ?? null;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Initialize the tokenizer for a given model.
 * Call once at startup to pre-load the encoder asynchronously.
 */
export async function initTokenizer(model?: string): Promise<void> {
    const encName = encodingForModel(model);
    await getEncoder(encName);
}

/**
 * Count tokens in a text string.
 * Uses js-tiktoken when available (and initialized); otherwise heuristic.
 */
export function countTokens(text: string, model?: string): number {
    if (!text) return 0;

    const encName = encodingForModel(model);
    const encoder = getEncoderSync(encName);

    if (encoder) {
        return encoder.encode(text).length;
    }

    // Fallback: 4 chars per token
    return Math.ceil(text.length / CHARS_PER_TOKEN_FALLBACK);
}

/**
 * Count tokens for a message content field (string or multimodal array).
 */
export function countTokensContent(
    content: string | any[],
    model?: string,
    multiplier = 1.0,
): number {
    let base: number;
    if (typeof content === "string") {
        base = countTokens(content, model);
    } else {
        // Multimodal: text parts + ~500 tokens per image part
        const textChars = content.reduce((acc, p) => acc + (p.text?.length || 0), 0);
        const imageCount = content.filter((p) => p.type === "image_url").length;
        base = countTokens("x".repeat(textChars), model) + imageCount * 500;
    }
    return Math.ceil(base * multiplier);
}

/**
 * Count total tokens across a list of LLMMessage objects.
 * Adds per-message overhead (~4 tokens for role/delimiters).
 */
export function countMessagesTokens(
    messages: LLMMessage[],
    model?: string,
    multiplier = 1.0,
): number {
    let total = 0;
    for (const m of messages) {
        total += countTokensContent(m.content, model, multiplier) + PER_MESSAGE_OVERHEAD;
    }
    return total;
}

// Re-export for convenience
export { CHARS_PER_TOKEN_FALLBACK, encodingForModel };
