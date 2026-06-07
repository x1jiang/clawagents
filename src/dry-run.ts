import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { LocalBackend } from "./sandbox/local.js";
import { ToolRegistry } from "./tools/registry.js";
import { createFilesystemTools } from "./tools/filesystem.js";
import { createExecTools } from "./tools/exec.js";
import { createAdvancedFsTools } from "./tools/advanced-fs.js";
import { webTools } from "./tools/web.js";
import { todolistTools } from "./tools/todolist.js";
import { thinkTools } from "./tools/think.js";
import { interactiveTools } from "./tools/interactive.js";
import { createToolDiscoveryTools } from "./tools/catalog.js";
import { createBackgroundTaskTools } from "./tools/background-task.js";
import { resolveProviderProfile } from "./provider-profiles.js";
import { resolveHarnessProfile } from "./harness-profiles.js";

export interface DryRunPreview {
    dryRun: true;
    status: "ready" | "blocked";
    provider: {
        profile: string | null;
        provider: string;
        model?: string;
        baseUrl: string;
        apiVersion: string;
        auth: "configured" | "missing";
    };
    task: string;
    toolCount: number;
    matchingTools: string[];
    nextActions: string[];
    skillsPreview: string[];
    hooksPreview: string[];
    mcpPreview: string[];
    harnessProfile: string | null;
}

export async function buildDryRunPreview(opts: {
    task?: string;
    profile?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    apiVersion?: string;
} = {}): Promise<DryRunPreview> {
    const resolved = resolveProviderProfile(opts.profile, opts);
    const catalog = buildToolCatalog();
    const ready = Boolean(resolved.baseUrl || resolved.apiKey || !resolved.profile);
    return {
        dryRun: true,
        status: ready ? "ready" : "blocked",
        provider: {
            profile: resolved.profile,
            provider: resolved.provider,
            model: resolved.model,
            baseUrl: resolved.baseUrl ?? "",
            apiVersion: resolved.apiVersion ?? "",
            auth: resolved.apiKey || resolved.baseUrl ? "configured" : "missing",
        },
        task: opts.task ?? "",
        toolCount: catalog.length,
        matchingTools: matchingTools(opts.task ?? "", catalog),
        nextActions: ready ? ["run the prompt directly"] : ["set an API key or choose a local/base-url profile"],
        skillsPreview: skillsPreview(),
        hooksPreview: hooksPreview(),
        mcpPreview: mcpPreview(),
        harnessProfile: harnessProfilePreview(resolved.model),
    };
}

function skillsPreview(): string[] {
    const names: string[] = [];
    for (const root of [join(process.cwd(), "skills"), join(homedir(), ".clawagents", "skills")]) {
        if (!existsSync(root) || !statSync(root).isDirectory()) continue;
        for (const child of readdirSync(root).sort()) {
            const skillMd = join(root, child, "SKILL.md");
            if (existsSync(skillMd) && statSync(skillMd).isFile()) names.push(child);
        }
    }
    return names.slice(0, 20);
}

function hooksPreview(): string[] {
    const hooksDir = join(process.cwd(), ".clawagents", "hooks");
    if (!existsSync(hooksDir) || !statSync(hooksDir).isDirectory()) return [];
    return readdirSync(hooksDir)
        .filter((name) => /\.(py|ts|js)$/.test(name))
        .sort();
}

function mcpPreview(): string[] {
    const paths = [
        join(process.cwd(), ".clawagents", "mcp.json"),
        join(homedir(), ".clawagents", "mcp.json"),
    ];
    const servers: string[] = [];
    for (const path of paths) {
        if (!existsSync(path)) continue;
        try {
            const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
            const mcpServers = (raw.mcpServers ?? raw.servers ?? raw) as Record<string, unknown>;
            if (mcpServers && typeof mcpServers === "object") {
                servers.push(...Object.keys(mcpServers).sort());
            }
        } catch {
            // skip invalid mcp config
        }
    }
    return servers.slice(0, 20);
}

function harnessProfilePreview(model?: string): string | null {
    const profile = resolveHarnessProfile(model);
    return profile?.name ?? null;
}

function buildToolCatalog() {
    const sb = new LocalBackend();
    const registry = new ToolRegistry();
    for (const tool of [
        ...todolistTools,
        ...thinkTools,
        ...interactiveTools,
        ...createFilesystemTools(sb),
        ...createExecTools(sb),
        ...createAdvancedFsTools(sb),
        ...webTools.filter((tool) => tool.name === "web_fetch"),
        ...createBackgroundTaskTools(),
    ]) {
        registry.register(tool);
    }
    for (const tool of createToolDiscoveryTools(registry)) {
        registry.register(tool);
    }
    return registry.inspectTools();
}

function matchingTools(task: string, catalog: ReturnType<ToolRegistry["inspectTools"]>): string[] {
    const tokens = task.toLowerCase().replace(/[_-]/g, " ").split(/\s+/).filter((token) => token.length > 2);
    const out = ["tool_discover"];
    for (const entry of catalog) {
        const haystack = [entry.name, entry.description, ...entry.keywords].join(" ").toLowerCase();
        if (tokens.some((token) => haystack.includes(token)) && !out.includes(entry.name)) {
            out.push(entry.name);
        }
        if (out.length >= 10) break;
    }
    return out;
}

