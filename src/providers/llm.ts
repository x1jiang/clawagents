import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import type { EngineConfig } from "../config/config.js";

// ─── Public Types ─────────────────────────────────────────────────────────

export interface LLMMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;          // For role="tool": the ID this result belongs to
    toolCallsMeta?: Array<{ id: string; name: string; args: Record<string, unknown> }>;  // For role="assistant": tool calls metadata
    geminiParts?: Array<Record<string, unknown>>;  // Preserved Gemini response parts (thought/thought_signature)
}

export interface NativeToolSchema {
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean; items?: { type: string } }>;
}

export interface NativeToolCall {
    toolName: string;
    args: Record<string, unknown>;
    toolCallId: string;
}

export interface LLMResponse {
    content: string;
    model: string;
    tokensUsed: number;
    partial?: boolean;
    toolCalls?: NativeToolCall[];
    geminiParts?: Array<Record<string, unknown>>;  // Preserved Gemini response parts (thought/thought_signature)
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
        const properties: Record<string, { type: string; description: string; items?: { type: string } }> = {};
        for (const [k, v] of Object.entries(s.parameters)) {
            properties[k] = { type: v.type, description: v.description };
            if (v.items) properties[k].items = v.items;
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
        const properties: Record<string, { type: string; description: string; items?: { type: string } }> = {};
        const required: string[] = [];
        for (const [k, v] of Object.entries(s.parameters)) {
            properties[k] = { type: v.type.toUpperCase(), description: v.description };
            if (v.items) {
                properties[k].items = { type: v.items.type.toUpperCase() };
            }
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

/** Best-effort parse of possibly-truncated JSON from an LLM tool call. */
function repairJson(text: string): Record<string, unknown> {
    const trimmed = text.trim();
    if (!trimmed) return {};
    try { return JSON.parse(trimmed); } catch { /* fall through */ }

    const closers: Record<string, string> = { "{": "}", "[": "]" };
    const stack: string[] = [];
    let inString = false;
    let escape = false;
    for (const ch of trimmed) {
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"' && !escape) { inString = !inString; continue; }
        if (inString) continue;
        if (ch in closers) stack.push(closers[ch]);
        else if ((ch === "}" || ch === "]") && stack.length && stack[stack.length - 1] === ch) stack.pop();
    }

    const repaired = trimmed + stack.reverse().join("");
    try { return JSON.parse(repaired); } catch { /* fall through */ }

    for (let i = trimmed.length - 1; i > 0; i--) {
        if (trimmed[i] === "," || trimmed[i] === ":") {
            const candidate = trimmed.slice(0, i).replace(/[,: \t\n]+$/, "") + stack.join("");
            try { return JSON.parse(candidate); } catch { continue; }
        }
    }

    console.error("[llm] JSON repair failed for tool call arguments — using empty args");
    return {};
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
                args: repairJson(tc.function.arguments || "{}"),
                toolCallId: tc.id || "",
            });
        }
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

const FIXED_TEMPERATURE_MODELS: Record<string, number> = {
    "gpt-5-nano": 1.0,
    "gpt-5-mini": 1.0,
    "gpt-5": 1.0,
    "gpt-5.1": 1.0,
    "gpt-5.2": 1.0,
    "o1": 1.0,
    "o1-mini": 1.0,
    "o1-preview": 1.0,
    "o3": 1.0,
    "o3-mini": 1.0,
    "o4-mini": 1.0,
};

function resolveTemperature(model: string, requested: number): number {
    for (const [prefix, fixed] of Object.entries(FIXED_TEMPERATURE_MODELS)) {
        if (model === prefix || model.startsWith(prefix + "-")) return fixed;
    }
    return requested;
}

export class OpenAIProvider implements LLMProvider {
    name = "openai";
    private client: OpenAI;
    private model: string;
    private maxTokens: number;
    private temperature: number;

    constructor(config: EngineConfig) {
        this.client = new OpenAI({ apiKey: config.openaiApiKey });
        this.model = config.openaiModel;
        this.maxTokens = config.maxTokens;
        this.temperature = resolveTemperature(config.openaiModel, config.temperature);
    }

    async chat(messages: LLMMessage[], options?: StreamOptions): Promise<LLMResponse> {
        const formatted: Array<Record<string, unknown>> = [];
        for (const m of messages) {
            if (m.role === "tool" && m.toolCallId) {
                formatted.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
            } else if (m.role === "assistant" && m.toolCallsMeta) {
                formatted.push({
                    role: "assistant",
                    content: m.content || null,
                    tool_calls: m.toolCallsMeta.map((tc) => ({
                        id: tc.id,
                        type: "function" as const,
                        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                    })),
                });
            } else {
                formatted.push({ role: m.role, content: m.content });
            }
        }
        const oaiTools = options?.tools ? toOpenAITools(options.tools) : undefined;

        if (!options?.onChunk) {
            return withRetry("openai", () => this.requestOnce(formatted, oaiTools));
        }
        return this.streamWithRetry(formatted, options, oaiTools);
    }

    private async requestOnce(
        messages: Array<Record<string, unknown>>,
        tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
    ): Promise<LLMResponse> {
        const resp = await this.client.chat.completions.create({
            model: this.model,
            messages: messages as unknown as Parameters<typeof this.client.chat.completions.create>[0]["messages"],
            max_completion_tokens: this.maxTokens,
            temperature: this.temperature,
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
        messages: Array<Record<string, unknown>>,
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
                    messages: messages as unknown as Parameters<typeof this.client.chat.completions.create>[0]["messages"],
                    max_completion_tokens: this.maxTokens,
                    temperature: this.temperature,
                    stream: true,
                    stream_options: { include_usage: true },
                    ...(tools ? { tools } : {}),
                });

                const toolsAcc: Record<number, { id: string; name: string; arguments: string }> = {};

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
                        const deltaToolCalls = chunk.choices?.[0]?.delta?.tool_calls;
                        if (deltaToolCalls) {
                            for (const tc of deltaToolCalls) {
                                const idx = tc.index;
                                if (!(idx in toolsAcc)) toolsAcc[idx] = { id: "", name: "", arguments: "" };
                                if (tc.id) toolsAcc[idx].id = tc.id;
                                if (tc.function?.name) toolsAcc[idx].name += tc.function.name;
                                if (tc.function?.arguments) toolsAcc[idx].arguments += tc.function.arguments;
                            }
                        }
                        if (chunk.usage) {
                            finalTokens = chunk.usage.total_tokens ?? 0;
                        }
                    } catch {
                        // Malformed chunk — skip and continue
                    }
                }

                let nativeCalls: NativeToolCall[] | undefined;
                const accKeys = Object.keys(toolsAcc).map(Number).sort((a, b) => a - b);
                if (accKeys.length > 0) {
                    nativeCalls = accKeys.map((idx) => ({
                        toolName: toolsAcc[idx].name,
                        args: repairJson(toolsAcc[idx].arguments || "{}"),
                        toolCallId: toolsAcc[idx].id,
                    }));
                }

                return { content: chunks.join(""), model: this.model, tokensUsed: finalTokens, ...(nativeCalls ? { toolCalls: nativeCalls } : {}) };
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

function serializeGeminiParts(parts: any[] | undefined): Array<Record<string, unknown>> | undefined {
    if (!parts?.length) return undefined;
    const serialized: Array<Record<string, unknown>> = [];
    for (const p of parts) {
        const d: Record<string, unknown> = {};
        if (p?.text != null) d.text = p.text;
        if (p?.thought) d.thought = true;
        if (p?.thoughtSignature) d.thoughtSignature = p.thoughtSignature;
        if (p?.thought_signature) d.thought_signature = p.thought_signature;
        if (p?.functionCall) {
            d.functionCall = { name: p.functionCall.name, args: p.functionCall.args ?? {} };
            if (p.thoughtSignature) d.thoughtSignature = p.thoughtSignature;
            if (p.thought_signature) d.thought_signature = p.thought_signature;
        }
        if (Object.keys(d).length) serialized.push(d);
    }
    return serialized.length ? serialized : undefined;
}

export class GeminiProvider implements LLMProvider {
    name = "gemini";
    private client: GoogleGenAI;
    private model: string;
    private maxTokens: number;
    private temperature: number;

    constructor(config: EngineConfig) {
        this.client = new GoogleGenAI({ apiKey: config.geminiApiKey });
        this.model = config.geminiModel;
        this.maxTokens = config.maxTokens;
        this.temperature = config.temperature;
    }

    async chat(messages: LLMMessage[], options?: StreamOptions): Promise<LLMResponse> {
        const systemInstruction = messages
            .filter((m) => m.role === "system")
            .map((m) => {
                if (typeof m.content === "string") return m.content;
                if (Array.isArray(m.content)) {
                    return (m.content as Array<Record<string, unknown>>)
                        .filter((p) => p.type === "text")
                        .map((p) => p.text ?? "")
                        .join("\n");
                }
                return String(m.content);
            })
            .join("\n");

        // Build a toolCallId → toolName lookup from all assistant messages with toolCallsMeta
        const tcIdToName: Record<string, string> = {};
        for (const m of messages) {
            if (m.role === "assistant" && m.toolCallsMeta) {
                for (const tc of m.toolCallsMeta) {
                    tcIdToName[tc.id] = tc.name;
                }
            }
        }

        const contents: Array<Record<string, unknown>> = [];
        for (const m of messages.filter((msg) => msg.role !== "system")) {
            if (m.role === "tool" && m.toolCallId) {
                const toolName = tcIdToName[m.toolCallId] || "unknown";
                contents.push({ role: "user", parts: [{ functionResponse: { name: toolName, response: { result: m.content } } }] });
            } else if (m.role === "assistant" && m.toolCallsMeta) {
                if (m.geminiParts) {
                    contents.push({ role: "model", parts: m.geminiParts });
                } else {
                    const parts: Array<Record<string, unknown>> = [];
                    if (m.content) parts.push({ text: m.content });
                    for (const tc of m.toolCallsMeta) {
                        parts.push({ functionCall: { name: tc.name, args: tc.args } });
                    }
                    contents.push({ role: "model", parts });
                }
            } else if (m.role === "assistant" && m.geminiParts) {
                contents.push({ role: "model", parts: m.geminiParts });
            } else {
                const role = m.role === "assistant" ? "model" : "user";
                if (typeof m.content === "string") {
                    contents.push({ role, parts: [{ text: m.content }] });
                } else if (Array.isArray(m.content)) {
                    const parts: Array<Record<string, unknown>> = [];
                    for (const part of m.content as Array<Record<string, unknown>>) {
                        if (part.type === "text") {
                            parts.push({ text: part.text ?? "" });
                        } else if (part.type === "image_url") {
                            const url = (part.image_url as Record<string, string>)?.url ?? "";
                            if (url.startsWith("data:")) {
                                const [header, b64] = url.slice(5).split(";base64,");
                                parts.push({ inlineData: { mimeType: header, data: b64 } });
                            }
                        }
                    }
                    contents.push({ role, parts });
                } else {
                    contents.push({ role, parts: [{ text: String(m.content) }] });
                }
            }
        }

        const configObj: Record<string, unknown> = {
            maxOutputTokens: this.maxTokens,
            temperature: this.temperature,
        };
        if (systemInstruction) configObj.systemInstruction = systemInstruction;
        if (options?.tools?.length) {
            configObj.tools = [{ functionDeclarations: toGeminiTools(options.tools) }];
        }

        const gOptions = {
            model: this.model,
            contents: contents,
            config: configObj,
        };

        if (!options?.onChunk) {
            return withRetry("gemini", async () => {
                const resp = await this.client.models.generateContent(gOptions);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const parts = resp.candidates?.[0]?.content?.parts as any[] | undefined;
                const rawParts = serializeGeminiParts(parts);
                const fnCalls = parts
                    ?.filter((p) => p?.functionCall)
                    .map((p) => ({
                        toolName: p.functionCall.name as string,
                        args: (p.functionCall.args ?? {}) as Record<string, unknown>,
                        toolCallId: `gemini_${Math.random().toString(36).substring(2, 10)}`,
                    }));
                const extractedText = parts
                    ?.filter((p) => typeof p?.text === "string" && !p?.thought)
                    .map((p) => p.text)
                    .join("") ?? "";

                return {
                    content: extractedText,
                    model: this.model,
                    tokensUsed: resp.usageMetadata?.candidatesTokenCount || 0,
                    ...(fnCalls?.length ? { toolCalls: fnCalls } : {}),
                    ...(rawParts ? { geminiParts: rawParts } : {}),
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
            const fnCalls: NativeToolCall[] = [];
            const allStreamParts: any[] = [];

            try {
                const stream = await this.client.models.generateContentStream(gOptions);

                for await (const chunk of withStallDetection(stream, RETRY.chunkStallMs)) {
                    if (options.signal?.aborted) {
                        return { content: chunks.join(""), model: this.model, tokensUsed: finalTokens, partial: true, ...(fnCalls.length ? { toolCalls: fnCalls } : {}), ...(allStreamParts.length ? { geminiParts: serializeGeminiParts(allStreamParts) } : {}) };
                    }

                    try {
                        if ((chunk as any).text) {
                            chunks.push((chunk as any).text);
                            try { options.onChunk!((chunk as any).text); } catch { /* callback error — isolated */ }
                        }
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const candidates = (chunk as any).candidates;
                        if (candidates) {
                            for (const candidate of candidates) {
                                const parts = candidate?.content?.parts;
                                if (parts) {
                                    for (const p of parts) {
                                        allStreamParts.push(p);
                                        if (p?.functionCall) {
                                            fnCalls.push({
                                                toolName: p.functionCall.name as string,
                                                args: (p.functionCall.args ?? {}) as Record<string, unknown>,
                                                toolCallId: `gemini_${Math.random().toString(36).substring(2, 10)}`,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        if ((chunk as any).usageMetadata) {
                            finalTokens = (chunk as any).usageMetadata.candidatesTokenCount || 0;
                        }
                    } catch {
                        // Malformed chunk — skip and continue
                    }
                }

                const rawParts = serializeGeminiParts(allStreamParts);
                return { content: chunks.join(""), model: this.model, tokensUsed: finalTokens, ...(fnCalls.length ? { toolCalls: fnCalls } : {}), ...(rawParts ? { geminiParts: rawParts } : {}) };
            } catch (err) {
                lastError = err;

                if (chunks.length > 0) {
                    const partial = chunks.join("");
                    console.error(
                        `  [gemini] Stream interrupted after ${partial.length} chars — returning partial content`,
                    );
                    const rawParts = serializeGeminiParts(allStreamParts);
                    return { content: partial, model: this.model, tokensUsed: finalTokens, partial: true, ...(rawParts ? { geminiParts: rawParts } : {}) };
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
