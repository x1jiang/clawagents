import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import type { EngineConfig } from "../config/config.js";

// ─── Public Types ─────────────────────────────────────────────────────────

export interface LLMMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface NativeToolSchema {
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

export interface NativeToolCall {
    toolName: string;
    args: Record<string, unknown>;
}

export interface LLMResponse {
    content: string;
    model: string;
    tokensUsed: number;
    partial?: boolean;
    toolCalls?: NativeToolCall[];
}

export interface StreamOptions {
    onChunk?: (chunk: string) => void;
    signal?: AbortSignal;
    tools?: NativeToolSchema[];
}

export interface LLMProvider {
    name: string;
    chat(messages: LLMMessage[], options?: StreamOptions): Promise<LLMResponse>;
}

// ─── Streaming Robustness Internals ───────────────────────────────────────

const RETRY = {
    maxAttempts: 3,
    initialDelayMs: 1_000,
    maxDelayMs: 16_000,
    chunkStallMs: 60_000,
    retryableStatusCodes: new Set([429, 500, 502, 503, 504]),
} as const;

function isRetryable(err: unknown): boolean {
    if (err instanceof OpenAI.APIError) {
        return RETRY.retryableStatusCodes.has(err.status);
    }
    if (err instanceof Error) {
        const m = err.message.toLowerCase();
        return (
            m.includes("econnreset") ||
            m.includes("socket hang up") ||
            m.includes("network") ||
            m.includes("timeout") ||
            m.includes("fetch failed") ||
            m.includes("stream stalled") ||
            m.includes("rate limit") ||
            m.includes("too many requests") ||
            m.includes("service unavailable") ||
            /\b(429|500|502|503|504)\b/.test(m)
        );
    }
    return false;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function jitteredDelay(attempt: number): number {
    const base = RETRY.initialDelayMs * 2 ** attempt;
    return Math.min(base + Math.random() * base * 0.1, RETRY.maxDelayMs);
}

/**
 * Race a promise against a wall-clock timer.
 * Used to detect stalled streams (no chunk for `ms` milliseconds).
 */
function raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

/**
 * Wrap an async iterable with per-chunk stall detection.
 * If no chunk arrives within `timeoutMs`, iteration aborts with an error.
 */
async function* withStallDetection<T>(
    iterable: AsyncIterable<T>,
    timeoutMs: number,
): AsyncGenerator<T> {
    const iter = iterable[Symbol.asyncIterator]();
    try {
        while (true) {
            const result = await raceTimeout(
                iter.next(),
                timeoutMs,
                "Stream stalled: no data received",
            );
            if (result.done) return;
            yield result.value;
        }
    } finally {
        try { await iter.return?.(); } catch { /* iterator cleanup */ }
    }
}

/**
 * Generic retry wrapper with exponential backoff + jitter.
 */
async function withRetry<T>(
    tag: string,
    fn: () => Promise<T>,
): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY.maxAttempts; attempt++) {
        if (attempt > 0) {
            const delay = jitteredDelay(attempt - 1);
            console.error(`  [${tag}] Retry ${attempt}/${RETRY.maxAttempts} after ${Math.round(delay)}ms`);
            await sleep(delay);
        }
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (!isRetryable(err)) break;
        }
    }
    throw lastError;
}

// ─── Native Tool Schema Converters ────────────────────────────────────────

/** Convert NativeToolSchema[] → OpenAI ChatCompletionTool[] (JSON Schema). */
function toOpenAITools(
    schemas: NativeToolSchema[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return schemas.map((s) => {
        const required: string[] = [];
        const properties: Record<string, { type: string; description: string }> = {};
        for (const [k, v] of Object.entries(s.parameters)) {
            properties[k] = { type: v.type, description: v.description };
            if (v.required) required.push(k);
        }
        return {
            type: "function" as const,
            function: {
                name: s.name,
                description: s.description,
                parameters: {
                    type: "object",
                    properties,
                    ...(required.length > 0 ? { required } : {}),
                },
            },
        };
    });
}

/** Convert NativeToolSchema[] → Gemini FunctionDeclaration[]. */
function toGeminiTools(schemas: NativeToolSchema[]): object[] {
    return schemas.map((s) => {
        const properties: Record<string, { type: string; description: string }> = {};
        const required: string[] = [];
        for (const [k, v] of Object.entries(s.parameters)) {
            properties[k] = { type: v.type.toUpperCase(), description: v.description };
            if (v.required) required.push(k);
        }
        return {
            name: s.name,
            description: s.description,
            parameters: {
                type: "OBJECT",
                properties,
                ...(required.length > 0 ? { required } : {}),
            },
        };
    });
}

/** Extract NativeToolCall[] from OpenAI tool_calls (handles function vs custom union). */
function parseOpenAIToolCalls(
    toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
): NativeToolCall[] | undefined {
    if (!toolCalls?.length) return undefined;
    const result: NativeToolCall[] = [];
    for (const tc of toolCalls) {
        if (tc.type === "function") {
            result.push({
                toolName: tc.function.name,
                args: JSON.parse(tc.function.arguments || "{}"),
            });
        }
        // Skip custom tool calls — we only generate function tools
    }
    return result.length > 0 ? result : undefined;
}

// ─── OpenAI Provider ──────────────────────────────────────────────────────
//
// Uses the Chat Completions API (chat.completions.create). Supports native
// function calling via the `tools` parameter for models like GPT-4o, GPT-5,
// GPT-5-nano, GPT-5.1, and GPT-5.2 (non-Codex).
//
// NOTE: GPT-5.2-Codex and similar models use the Responses API
// (client.responses.create) which has a different tool-calling interface.
// Those would need a separate ResponsesAPIProvider.

export class OpenAIProvider implements LLMProvider {
    name = "openai";
    private client: OpenAI;
    private model: string;

    constructor(config: EngineConfig) {
        this.client = new OpenAI({ apiKey: config.openaiApiKey });
        this.model = config.openaiModel;
    }

    async chat(messages: LLMMessage[], options?: StreamOptions): Promise<LLMResponse> {
        const formatted = messages.map((m) => ({ role: m.role, content: m.content }));
        const oaiTools = options?.tools ? toOpenAITools(options.tools) : undefined;

        if (!options?.onChunk) {
            return withRetry("openai", () => this.requestOnce(formatted, oaiTools));
        }
        return this.streamWithRetry(formatted, options, oaiTools);
    }

    private async requestOnce(
        messages: Array<{ role: string; content: string }>,
        tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
    ): Promise<LLMResponse> {
        const resp = await this.client.chat.completions.create({
            model: this.model,
            messages: messages as Parameters<typeof this.client.chat.completions.create>[0]["messages"],
            ...(tools ? { tools } : {}),
        });
        const msg = resp.choices[0]?.message;
        const nativeToolCalls = parseOpenAIToolCalls(msg?.tool_calls);
        return {
            content: msg?.content ?? "",
            model: this.model,
            tokensUsed: resp.usage?.total_tokens ?? 0,
            ...(nativeToolCalls ? { toolCalls: nativeToolCalls } : {}),
        };
    }

    private async streamWithRetry(
        messages: Array<{ role: string; content: string }>,
        options: StreamOptions,
        tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
    ): Promise<LLMResponse> {
        let lastError: unknown;

        for (let attempt = 0; attempt <= RETRY.maxAttempts; attempt++) {
            if (attempt > 0) {
                const delay = jitteredDelay(attempt - 1);
                console.error(`  [openai] Stream retry ${attempt}/${RETRY.maxAttempts} after ${Math.round(delay)}ms`);
                await sleep(delay);
            }

            const chunks: string[] = [];
            let finalTokens = 0;

            try {
                const stream = await this.client.chat.completions.create({
                    model: this.model,
                    messages: messages as Parameters<typeof this.client.chat.completions.create>[0]["messages"],
                    stream: true,
                    stream_options: { include_usage: true },
                    ...(tools ? { tools } : {}),
                });

                for await (const chunk of withStallDetection(stream, RETRY.chunkStallMs)) {
                    if (options.signal?.aborted) {
                        try { stream.controller.abort(); } catch { /* best-effort abort */ }
                        return { content: chunks.join(""), model: this.model, tokensUsed: finalTokens, partial: true };
                    }

                    try {
                        if (chunk.choices?.[0]?.delta?.content) {
                            const text = chunk.choices[0].delta.content;
                            chunks.push(text);
                            try { options.onChunk!(text); } catch { /* callback error — isolated */ }
                        }
                        if (chunk.usage) {
                            finalTokens = chunk.usage.total_tokens ?? 0;
                        }
                    } catch {
                        // Malformed chunk — skip and continue
                    }
                }

                return { content: chunks.join(""), model: this.model, tokensUsed: finalTokens };
            } catch (err) {
                lastError = err;

                if (chunks.length > 0) {
                    const partial = chunks.join("");
                    console.error(
                        `  [openai] Stream interrupted after ${partial.length} chars — returning partial content`,
                    );
                    return { content: partial, model: this.model, tokensUsed: finalTokens, partial: true };
                }
                if (!isRetryable(err)) break;
            }
        }

        throw lastError;
    }
}

// ─── Gemini Provider ──────────────────────────────────────────────────────

export class GeminiProvider implements LLMProvider {
    name = "gemini";
    private client: GoogleGenAI;
    private model: string;

    constructor(config: EngineConfig) {
        this.client = new GoogleGenAI({ apiKey: config.geminiApiKey });
        this.model = config.geminiModel;
    }

    async chat(messages: LLMMessage[], options?: StreamOptions): Promise<LLMResponse> {
        const systemInstruction = messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n");

        const userMessages = messages
            .filter((m) => m.role !== "system")
            .map((m) => m.content)
            .join("\n\n");

        const configObj: Record<string, unknown> = {};
        if (systemInstruction) configObj.systemInstruction = systemInstruction;
        if (options?.tools?.length) {
            configObj.tools = [{ functionDeclarations: toGeminiTools(options.tools) }];
        }

        const gOptions = {
            model: this.model,
            contents: userMessages,
            config: configObj,
        };

        if (!options?.onChunk) {
            return withRetry("gemini", async () => {
                const resp = await this.client.models.generateContent(gOptions);
                // Extract native function calls from Gemini response parts
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const parts = resp.candidates?.[0]?.content?.parts as any[] | undefined;
                const fnCalls = parts
                    ?.filter((p) => p?.functionCall)
                    .map((p) => ({
                        toolName: p.functionCall.name as string,
                        args: (p.functionCall.args ?? {}) as Record<string, unknown>,
                    }));
                return {
                    content: resp.text ?? "",
                    model: this.model,
                    tokensUsed: resp.usageMetadata?.candidatesTokenCount || 0,
                    ...(fnCalls?.length ? { toolCalls: fnCalls } : {}),
                };
            });
        }

        return this.streamWithRetry(gOptions, options);
    }

    private async streamWithRetry(
        gOptions: Parameters<GoogleGenAI["models"]["generateContentStream"]>[0],
        options: StreamOptions,
    ): Promise<LLMResponse> {
        let lastError: unknown;

        for (let attempt = 0; attempt <= RETRY.maxAttempts; attempt++) {
            if (attempt > 0) {
                const delay = jitteredDelay(attempt - 1);
                console.error(`  [gemini] Stream retry ${attempt}/${RETRY.maxAttempts} after ${Math.round(delay)}ms`);
                await sleep(delay);
            }

            const chunks: string[] = [];
            let finalTokens = 0;

            try {
                const stream = await this.client.models.generateContentStream(gOptions);

                for await (const chunk of withStallDetection(stream, RETRY.chunkStallMs)) {
                    if (options.signal?.aborted) {
                        return { content: chunks.join(""), model: this.model, tokensUsed: finalTokens, partial: true };
                    }

                    try {
                        if (chunk.text) {
                            chunks.push(chunk.text);
                            try { options.onChunk!(chunk.text); } catch { /* callback error — isolated */ }
                        }
                        if (chunk.usageMetadata) {
                            finalTokens = chunk.usageMetadata.candidatesTokenCount || 0;
                        }
                    } catch {
                        // Malformed chunk — skip and continue
                    }
                }

                return { content: chunks.join(""), model: this.model, tokensUsed: finalTokens };
            } catch (err) {
                lastError = err;

                if (chunks.length > 0) {
                    const partial = chunks.join("");
                    console.error(
                        `  [gemini] Stream interrupted after ${partial.length} chars — returning partial content`,
                    );
                    return { content: partial, model: this.model, tokensUsed: finalTokens, partial: true };
                }
                if (!isRetryable(err)) break;
            }
        }

        throw lastError;
    }
}

// ─── Factory ──────────────────────────────────────────────────────────────

/**
 * Create a single LLM provider. The provider is inferred from the model name:
 * names starting with "gemini" → GeminiProvider, everything else → OpenAIProvider.
 */
export function createProvider(modelName: string, config: EngineConfig): LLMProvider {
    if (modelName.toLowerCase().startsWith("gemini")) {
        config.geminiModel = modelName;
        return new GeminiProvider(config);
    }
    config.openaiModel = modelName;
    return new OpenAIProvider(config);
}
