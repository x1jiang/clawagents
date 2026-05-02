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
    };
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

