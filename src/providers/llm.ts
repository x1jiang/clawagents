import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import type { EngineConfig } from "../config/config.js";

export interface LLMMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface LLMResponse {
    content: string;
    model: string;
    tokensUsed: number;
}

export interface LLMProvider {
    name: string;
    chat(messages: LLMMessage[], options?: { onChunk?: (chunk: string) => void }): Promise<LLMResponse>;
}

// ─── OpenAI Provider ───────────────────────────────────────────────────────

export class OpenAIProvider implements LLMProvider {
    name = "openai";
    private client: OpenAI;
    private model: string;

    constructor(config: EngineConfig) {
        this.client = new OpenAI({ apiKey: config.openaiApiKey });
        this.model = config.openaiModel;
    }

    async chat(messages: LLMMessage[], options?: { onChunk?: (chunk: string) => void }): Promise<LLMResponse> {
        if (!options?.onChunk) {
            // Non-streaming fallback
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: messages.map((m) => ({ role: m.role, content: m.content })),
            });
            return {
                content: response.choices[0]?.message.content ?? "",
                model: this.model,
                tokensUsed: response.usage?.total_tokens ?? 0,
            };
        }

        // Streaming implementation
        const responseStream = await this.client.chat.completions.create({
            model: this.model,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            stream: true,
            stream_options: { include_usage: true },
        });

        let fullContent = "";
        let finalTokens = 0;

        for await (const chunk of responseStream) {
            if (chunk.choices[0]?.delta?.content) {
                fullContent += chunk.choices[0].delta.content;
                options.onChunk(chunk.choices[0].delta.content);
            }
            if (chunk.usage) {
                finalTokens = chunk.usage.total_tokens ?? 0;
            }
        }

        return {
            content: fullContent,
            model: this.model,
            tokensUsed: finalTokens,
        };
    }
}

// ─── Gemini Provider ───────────────────────────────────────────────────────

export class GeminiProvider implements LLMProvider {
    name = "gemini";
    private client: GoogleGenAI;
    private model: string;

    constructor(config: EngineConfig) {
        this.client = new GoogleGenAI({ apiKey: config.geminiApiKey });
        this.model = config.geminiModel;
    }

    async chat(messages: LLMMessage[], options?: { onChunk?: (chunk: string) => void }): Promise<LLMResponse> {
        // Convert messages to Gemini format
        const systemInstruction = messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n");

        const userMessages = messages
            .filter((m) => m.role !== "system")
            .map((m) => m.content)
            .join("\n\n");

        const gOptions = {
            model: this.model,
            contents: userMessages,
            config: {
                systemInstruction: systemInstruction || undefined,
            },
        };

        if (!options?.onChunk) {
            const response = await this.client.models.generateContent(gOptions);
            return {
                content: response.text ?? "",
                model: this.model,
                tokensUsed: response.usageMetadata?.candidatesTokenCount ?? 0,
            };
        }

        const stream = await this.client.models.generateContentStream(gOptions);
        let fullContent = "";
        let finalTokens = 0;

        for await (const chunk of stream) {
            if (chunk.text) {
                fullContent += chunk.text;
                options.onChunk(chunk.text);
            }
            if (chunk.usageMetadata) {
                finalTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
            }
        }

        return {
            content: fullContent,
            model: this.model,
            tokensUsed: finalTokens,
        };
    }
}

// ─── Factory ───────────────────────────────────────────────────────────────

export function createProvider(config: EngineConfig): LLMProvider {
    if (config.provider === "gemini") {
        return new GeminiProvider(config);
    }
    return new OpenAIProvider(config);
}
