import dotenv from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

let _loaded = false;
export let resolvedEnvFile: string | null = null;

function discoverEnvFile(): void {
    if (_loaded) return;
    _loaded = true;

    const cwd = process.cwd();
    const explicit = process.env["CLAWAGENTS_ENV_FILE"];
    const localEnv = resolve(cwd, ".env");
    const parentEnv = resolve(cwd, "../.env");

    if (explicit && existsSync(explicit)) {
        dotenv.config({ path: explicit, override: true });
        resolvedEnvFile = explicit;
    } else if (existsSync(localEnv)) {
        dotenv.config({ path: localEnv, override: true });
        resolvedEnvFile = localEnv;
    } else if (existsSync(parentEnv)) {
        dotenv.config({ path: parentEnv, override: true });
        resolvedEnvFile = parentEnv;
    } else {
        dotenv.config();
    }
}

export interface EngineConfig {
    openaiApiKey: string;
    openaiModel: string;
    openaiBaseUrl: string;
    openaiApiVersion: string;
    openaiApiType: string;
    geminiApiKey: string;
    geminiModel: string;
    anthropicApiKey: string;
    anthropicModel: string;
    maxTokens: number;
    temperature: number;
    contextWindow: number;
    streaming: boolean;
    gatewayApiKey: string;
    clawLearnModel: string;
}

export function loadConfig(): EngineConfig {
    discoverEnvFile();

    const streamingEnv = process.env["STREAMING"]?.toLowerCase();
    const streaming = streamingEnv !== "0" && streamingEnv !== "false" && streamingEnv !== "no";

    return {
        openaiApiKey: process.env["OPENAI_API_KEY"] ?? "",
        openaiModel: process.env["OPENAI_MODEL"] ?? "gpt-5-nano",
        openaiBaseUrl: process.env["OPENAI_BASE_URL"] ?? "",
        openaiApiVersion: process.env["OPENAI_API_VERSION"] ?? "",
        openaiApiType: process.env["OPENAI_API_TYPE"] ?? "",
        geminiApiKey: process.env["GEMINI_API_KEY"] ?? "",
        geminiModel: process.env["GEMINI_MODEL"] ?? "gemini-3-flash-preview",
        anthropicApiKey: process.env["ANTHROPIC_API_KEY"] ?? "",
        anthropicModel: process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-5",
        maxTokens: Number(process.env["MAX_TOKENS"] ?? 8192) || 8192,
        temperature: Number(process.env["TEMPERATURE"] ?? 0),
        contextWindow: Number(process.env["CONTEXT_WINDOW"] ?? 1000000) || 1000000,
        streaming,
        gatewayApiKey: process.env["GATEWAY_API_KEY"] ?? "",
        clawLearnModel: process.env["CLAW_LEARN_MODEL"] ?? "",
    };
}

/** Infer provider from model name: "gemini*" → gemini, everything else → openai. */
export function isGeminiModel(model: string): boolean {
    return model.toLowerCase().startsWith("gemini");
}

export function isAnthropicModel(model: string): boolean {
    const l = model.toLowerCase();
    return l.startsWith("claude") || l.startsWith("anthropic");
}

/** Pick the default model. PROVIDER env var is a hint when both API keys exist. */
export function getDefaultModel(config: EngineConfig): string {
    const hint = process.env["PROVIDER"]?.toLowerCase();
    if (hint === "gemini" && config.geminiApiKey) return config.geminiModel;
    if (hint === "anthropic" && config.anthropicApiKey) return config.anthropicModel;
    if (hint === "openai" && config.openaiApiKey) return config.openaiModel;
    if (config.openaiApiKey) return config.openaiModel;
    if (config.geminiApiKey) return config.geminiModel;
    if (config.anthropicApiKey) return config.anthropicModel;
    return config.openaiModel;
}
