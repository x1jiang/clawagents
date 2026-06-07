/** Harness profiles — model-specific prompt/middleware bundles (DeepAgents 1.10.2). */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface HarnessProfile {
    name: string;
    matchModels: readonly string[];
    baseSystemPrompt: string;
    systemPromptSuffix: string;
    excludedTools: readonly string[];
    compactionHeadroomRatio: number | null;
    loopDetectionOverrides: Record<string, unknown>;
    metadata: Record<string, unknown>;
}

export const BUILTIN_HARNESS_PROFILES: Record<string, HarnessProfile> = {
    "anthropic-sonnet": {
        name: "anthropic-sonnet",
        matchModels: ["claude-sonnet", "claude-4.6-sonnet", "claude-4.5-sonnet"],
        baseSystemPrompt: "",
        systemPromptSuffix:
            "Prefer concise tool use. When editing files, read before write. " +
            "Batch independent reads in parallel when the runtime allows.",
        excludedTools: [],
        compactionHeadroomRatio: 0.75,
        loopDetectionOverrides: {},
        metadata: {},
    },
    "anthropic-opus": {
        name: "anthropic-opus",
        matchModels: ["claude-opus", "claude-opus-4"],
        baseSystemPrompt: "",
        systemPromptSuffix:
            "Think step-by-step for multi-file refactors; verify with tests before claiming done.",
        excludedTools: [],
        compactionHeadroomRatio: 0.8,
        loopDetectionOverrides: {},
        metadata: {},
    },
    "openai-codex": {
        name: "openai-codex",
        matchModels: ["gpt-5.3-codex", "gpt-5.1-codex", "gpt-5-codex", "codex"],
        baseSystemPrompt: "",
        systemPromptSuffix: "Minimize scope. Surgical diffs only. Run verification commands before completion.",
        excludedTools: [],
        compactionHeadroomRatio: null,
        loopDetectionOverrides: { critical_threshold: 5 },
        metadata: {},
    },
    "local-ollama": {
        name: "local-ollama",
        matchModels: ["llama", "gemma", "mistral", "qwen", "deepseek"],
        baseSystemPrompt: "",
        systemPromptSuffix: "Keep responses short. One tool at a time when uncertain.",
        excludedTools: [],
        compactionHeadroomRatio: 0.65,
        loopDetectionOverrides: {},
        metadata: {},
    },
};

function profilePaths(): string[] {
    return [
        join(homedir(), ".clawagents", "harness-profiles.json"),
        resolve(process.cwd(), ".clawagents", "harness-profiles.json"),
    ];
}

export function loadHarnessProfiles(): Record<string, HarnessProfile> {
    const profiles: Record<string, HarnessProfile> = { ...BUILTIN_HARNESS_PROFILES };
    for (const path of profilePaths()) {
        if (!existsSync(path)) continue;
        try {
            const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
            for (const [name, spec] of Object.entries(raw)) {
                if (!spec || typeof spec !== "object") continue;
                const s = spec as Record<string, unknown>;
                profiles[name] = {
                    name,
                    matchModels: Array.isArray(s.match_models) ? s.match_models.map(String) : [],
                    baseSystemPrompt: String(s.base_system_prompt ?? ""),
                    systemPromptSuffix: String(s.system_prompt_suffix ?? ""),
                    excludedTools: Array.isArray(s.excluded_tools) ? s.excluded_tools.map(String) : [],
                    compactionHeadroomRatio:
                        typeof s.compaction_headroom_ratio === "number" ? s.compaction_headroom_ratio : null,
                    loopDetectionOverrides:
                        s.loop_detection_overrides && typeof s.loop_detection_overrides === "object"
                            ? (s.loop_detection_overrides as Record<string, unknown>)
                            : {},
                    metadata:
                        s.metadata && typeof s.metadata === "object"
                            ? (s.metadata as Record<string, unknown>)
                            : {},
                };
            }
        } catch {
            // skip invalid profile files
        }
    }
    return profiles;
}

export function resolveHarnessProfile(model?: string | null, explicit?: string | null): HarnessProfile | null {
    const profiles = loadHarnessProfiles();
    if (explicit && profiles[explicit]) return profiles[explicit];
    if (!model) return null;
    const modelLower = model.toLowerCase();
    for (const profile of Object.values(profiles)) {
        for (const prefix of profile.matchModels) {
            const p = prefix.toLowerCase();
            if (modelLower.startsWith(p) || modelLower.includes(p)) return profile;
        }
    }
    return null;
}

export function applyHarnessProfileToPrompt(base: string, profile: HarnessProfile | null): string {
    if (!profile) return base;
    let out = profile.baseSystemPrompt || base;
    if (profile.systemPromptSuffix) {
        out = `${out.replace(/\s+$/, "")}\n\n${profile.systemPromptSuffix.trim()}`;
    }
    return out;
}
