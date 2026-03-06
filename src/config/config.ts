import dotenv from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// Load .env using cwd-relative paths (works regardless of where the TS file lives)
// Priority: clawagents/.env > parent dir .env (openclawVSdeepagents/.env)
const cwd = process.cwd();
const localEnv = resolve(cwd, ".env");
const parentEnv = resolve(cwd, "../.env");

if (existsSync(localEnv)) {
    dotenv.config({ path: localEnv, override: true });
} else if (existsSync(parentEnv)) {
    dotenv.config({ path: parentEnv, override: true });
} else {
    dotenv.config();
}

export interface EngineConfig {
    openaiApiKey: string;
    openaiModel: string;
    geminiApiKey: string;
    geminiModel: string;
    maxTokens: number;
    temperature: number;
    contextWindow: number;
    streaming: boolean;
}

export function loadConfig(): EngineConfig {
    const streamingEnv = process.env["STREAMING"]?.toLowerCase();
    const streaming = streamingEnv !== "0" && streamingEnv !== "false" && streamingEnv !== "no";

    return {
        openaiApiKey: process.env["OPENAI_API_KEY"] ?? "",
        openaiModel: process.env["OPENAI_MODEL"] ?? "gpt-5-nano",
        geminiApiKey: process.env["GEMINI_API_KEY"] ?? "",
        geminiModel: process.env["GEMINI_MODEL"] ?? "gemini-3-flash-preview",
        maxTokens: Number(process.env["MAX_TOKENS"] ?? 8192) || 8192,
        temperature: Number(process.env["TEMPERATURE"] ?? 0),
        contextWindow: Number(process.env["CONTEXT_WINDOW"] ?? 1000000) || 1000000,
        streaming,
    };
}

/** Infer provider from model name: "gemini*" → gemini, everything else → openai. */
export function isGeminiModel(model: string): boolean {
    return model.toLowerCase().startsWith("gemini");
}

/** Pick the default model. PROVIDER env var is a hint when both API keys exist. */
export function getDefaultModel(config: EngineConfig): string {
    const hint = process.env["PROVIDER"]?.toLowerCase();
    if (hint === "gemini" && config.geminiApiKey) return config.geminiModel;
    if (hint === "openai" && config.openaiApiKey) return config.openaiModel;
    if (config.openaiApiKey) return config.openaiModel;
    if (config.geminiApiKey) return config.geminiModel;
    return config.openaiModel;
}
