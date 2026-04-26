import type { Tool, ToolRegistry } from "./registry.js";
import { isWriteClassTool } from "../permissions/mode.js";

export type ToolProfileName = "minimal" | "read-only" | "write" | "full";

const DISCOVERY_TOOL_NAMES = new Set(["tool_discover", "tool_describe", "tool_profile"]);
const SEARCH_STOP_WORDS = new Set(["a", "an", "and", "for", "in", "of", "or", "the", "to", "with"]);

function normalizeSearchText(value: string): string {
    return value.toLowerCase().replace(/[_-]+/g, " ");
}

function queryTokens(query: string): string[] {
    return normalizeSearchText(query)
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length > 0 && !SEARCH_STOP_WORDS.has(token));
}

function matchesToolQuery(tool: Tool, query: string): boolean {
    const q = normalizeSearchText(query).trim();
    if (!q) return true;
    const haystack = normalizeSearchText([
        tool.name,
        tool.description,
        ...(tool.keywords ?? []),
    ].join(" "));
    if (haystack.includes(q)) return true;
    const tokens = queryTokens(q);
    return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

export function namesForToolProfile(
    registry: ToolRegistry,
    profile: ToolProfileName | string = "full",
): string[] {
    const tools = registry.list().map((tool) => tool.name);
    if (profile === "minimal") return tools.filter((name) => DISCOVERY_TOOL_NAMES.has(name));
    if (profile === "read-only") {
        return tools.filter((name) => DISCOVERY_TOOL_NAMES.has(name) || !isWriteClassTool(name));
    }
    if (profile === "write") {
        return tools.filter((name) => DISCOVERY_TOOL_NAMES.has(name) || isWriteClassTool(name));
    }
    return tools;
}

function compactTool(tool: Tool): Record<string, unknown> {
    const keywords = tool.keywords ?? [];
    return {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        keywords,
        cacheable: tool.cacheable === true,
        parallel_safe: tool.parallelSafe === true,
    };
}

export function createToolDiscoveryTools(
    registry: ToolRegistry,
    opts: { maxResults?: number; maxProfile?: ToolProfileName } = {},
): Tool[] {
    const maxDefault = Math.max(1, opts.maxResults ?? 25);
    const maxProfile = opts.maxProfile ?? "full";

    function allowedNames(profile: string): Set<string> {
        const boundary = new Set(namesForToolProfile(registry, maxProfile));
        return new Set(namesForToolProfile(registry, profile).filter((name) => boundary.has(name)));
    }

    const discover: Tool = {
        name: "tool_discover",
        description: "Search the compact tool catalog by name, description, or named profile.",
        parameters: {
            query: { type: "string", description: "Optional case-insensitive search text." },
            profile: { type: "string", description: "Tool profile: minimal, read-only, write, or full." },
            limit: { type: "number", description: "Maximum results to return." },
        },
        parallelSafe: true,
        async execute(args) {
            const q = String(args.query ?? "").trim().toLowerCase();
            const profile = String(args.profile ?? "full");
            const limit = Math.max(1, Number(args.limit ?? maxDefault) || maxDefault);
            const allowed = allowedNames(profile);
            const found = registry
                .list()
                .filter((tool) => allowed.has(tool.name))
                .filter((tool) => profile === "minimal" || !DISCOVERY_TOOL_NAMES.has(tool.name))
                .filter((tool) => matchesToolQuery(tool, q))
                .slice(0, limit)
                .map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    ...(tool.keywords?.length ? { keywords: tool.keywords } : {}),
                }));
            return { success: true, output: JSON.stringify(found) };
        },
    };

    const describe: Tool = {
        name: "tool_describe",
        description: "Return the full schema for one registered tool.",
        parameters: {
            name: { type: "string", description: "Tool name to describe.", required: true },
        },
        parallelSafe: true,
        async execute(args) {
            const name = String(args.name ?? "");
            const tool = registry.get(name);
            if (!tool) return { success: false, output: "", error: `Unknown tool: ${name}` };
            if (!allowedNames("full").has(name)) {
                return { success: false, output: "", error: `Tool is outside discovery profile: ${name}` };
            }
            return { success: true, output: JSON.stringify(compactTool(tool)) };
        },
    };

    const profileTool: Tool = {
        name: "tool_profile",
        description: "List tool names included in a compact profile.",
        parameters: {
            profile: { type: "string", description: "Profile: minimal, read-only, write, or full.", required: true },
        },
        parallelSafe: true,
        async execute(args) {
            const profile = String(args.profile ?? "full");
            return { success: true, output: JSON.stringify([...allowedNames(profile)]) };
        },
    };

    return [discover, describe, profileTool];
}
