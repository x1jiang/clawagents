import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface ProviderProfile {
    name: string;
    provider: string;
    model: string;
    baseUrl?: string;
    apiKey?: string;
    apiVersion?: string;
}

export interface ResolvedProviderProfile {
    profile: string | null;
    provider: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    apiVersion?: string;
}

export const BUILTIN_PROVIDER_PROFILES: Record<string, ProviderProfile> = {
    openai: { name: "openai", provider: "openai", model: "gpt-5-nano" },
    gemini: { name: "gemini", provider: "gemini", model: "gemini-3-flash-preview" },
    anthropic: { name: "anthropic", provider: "anthropic", model: "claude-sonnet-4-5" },
    ollama: { name: "ollama", provider: "openai", model: "llama3.1", baseUrl: "http://localhost:11434/v1", apiKey: "ollama" },
};

function profilePaths(): string[] {
    return [
        resolve(homedir(), ".clawagents", "profiles.json"),
        resolve(process.cwd(), ".clawagents", "profiles.json"),
    ];
}

export function loadProviderProfiles(paths: string[] = profilePaths()): Record<string, ProviderProfile> {
    const profiles: Record<string, ProviderProfile> = { ...BUILTIN_PROVIDER_PROFILES };
    for (const path of paths) {
        if (!existsSync(path)) continue;
        let raw: unknown;
        try {
            raw = JSON.parse(readFileSync(path, "utf-8"));
        } catch {
            continue;
        }
        const src = raw && typeof raw === "object" && "profiles" in raw
            ? (raw as any).profiles
            : raw;
        if (!src || typeof src !== "object") continue;
        for (const [name, value] of Object.entries(src as Record<string, any>)) {
            if (!value || typeof value !== "object") continue;
            profiles[name] = {
                name,
                provider: String(value.provider ?? value.api_format ?? "openai"),
                model: String(value.model ?? value.default_model ?? ""),
                baseUrl: value.baseUrl ?? value.base_url,
                apiKey: value.apiKey ?? value.api_key,
                apiVersion: value.apiVersion ?? value.api_version,
            };
        }
    }
    return profiles;
}

export function resolveProviderProfile(
    profile?: string | null,
    overrides: {
        model?: string;
        apiKey?: string;
        baseUrl?: string;
        apiVersion?: string;
    } = {},
): ResolvedProviderProfile {
    if (!profile) {
        return {
            profile: null,
            provider: process.env["PROVIDER"] ?? "auto",
            model: overrides.model,
            apiKey: overrides.apiKey,
            baseUrl: overrides.baseUrl,
            apiVersion: overrides.apiVersion,
        };
    }
    const selected = loadProviderProfiles()[profile];
    if (!selected) throw new Error(`Unknown provider profile: ${profile}`);
    return {
        profile,
        provider: selected.provider,
        model: overrides.model ?? selected.model,
        apiKey: overrides.apiKey ?? selected.apiKey,
        baseUrl: overrides.baseUrl ?? selected.baseUrl,
        apiVersion: overrides.apiVersion ?? selected.apiVersion,
    };
}

