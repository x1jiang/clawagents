import dotenv from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// Load .env using cwd-relative paths (works regardless of where the TS file lives)
// Priority: clawagents/.env > parent dir .env (openclawVSdeepagents/.env)
const cwd = process.cwd();
const localEnv = resolve(cwd, ".env");
const parentEnv = resolve(cwd, "../.env");

if (existsSync(localEnv)) {
    dotenv.config({ path: localEnv, override: false });
} else if (existsSync(parentEnv)) {
    dotenv.config({ path: parentEnv, override: false });
} else {
    dotenv.config();
}

export interface EngineConfig {
    openaiApiKey: string;
    openaiModel: string;
    geminiApiKey: string;
    geminiModel: string;
    provider: "openai" | "gemini";
    maxTokens: number;
    contextWindow: number;
}

export function loadConfig(): EngineConfig {
    const openaiApiKey = process.env["OPENAI_API_KEY"] ?? "";
    const geminiApiKey = process.env["GEMINI_API_KEY"] ?? "";

    // Explicit override via PROVIDER env var, otherwise auto-detect
    let provider: "openai" | "gemini";
    const explicitProvider = process.env["PROVIDER"]?.toLowerCase();
    if (explicitProvider === "gemini") {
        provider = "gemini";
    } else if (explicitProvider === "openai") {
        provider = "openai";
    } else if (openaiApiKey) {
        provider = "openai";
    } else if (geminiApiKey) {
        provider = "gemini";
    } else {
        provider = "openai";
    }

    return {
        openaiApiKey,
        openaiModel: process.env["OPENAI_MODEL"] ?? "gpt-5-nano",
        geminiApiKey,
        geminiModel: process.env["GEMINI_MODEL"] ?? "gemini-3-flash-preview",
        provider,
        maxTokens: 4096,
        contextWindow: 128000,
    };
}
