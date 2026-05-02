import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface PluginSkill {
    name: string;
    description: string;
    path: string;
}

export interface PluginCommand {
    name: string;
    description: string;
    path: string;
}

export interface LoadedCompatPlugin {
    name: string;
    description: string;
    path: string;
    skills: PluginSkill[];
    commands: PluginCommand[];
    hooks: Record<string, unknown>;
    mcpServers: Record<string, unknown>;
}

export function loadPlugin(path: string): LoadedCompatPlugin | null {
    const manifestPath = findManifest(path);
    if (!manifestPath) return null;
    let manifest: any;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
        return null;
    }
    if (!manifest || typeof manifest !== "object") return null;
    const mcpRaw = loadJsonObject(join(path, String(manifest.mcp_file ?? ".mcp.json")));
    const mcpServers = typeof mcpRaw.servers === "object" && mcpRaw.servers ? mcpRaw.servers as Record<string, unknown> : mcpRaw;
    return {
        name: String(manifest.name ?? basename(path)),
        description: String(manifest.description ?? ""),
        path,
        skills: loadSkills(join(path, String(manifest.skills_dir ?? "skills"))),
        commands: loadCommands(join(path, String(manifest.commands_dir ?? "commands"))),
        hooks: loadJsonObject(join(path, String(manifest.hooks_file ?? "hooks.json"))),
        mcpServers,
    };
}

export function discoverPlugins(root: string): LoadedCompatPlugin[] {
    if (!existsSync(root)) return [];
    return readdirSync(root)
        .map((name) => join(root, name))
        .filter((path) => statSync(path).isDirectory())
        .map(loadPlugin)
        .filter((plugin): plugin is LoadedCompatPlugin => plugin !== null);
}

function findManifest(root: string): string | null {
    for (const candidate of [join(root, "plugin.json"), join(root, ".claude-plugin", "plugin.json")]) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

function walkMarkdown(root: string): string[] {
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const name of readdirSync(root)) {
        const path = join(root, name);
        const stat = statSync(path);
        if (stat.isDirectory()) out.push(...walkMarkdown(path));
        else if (name.toLowerCase().endsWith(".md")) out.push(path);
    }
    return out.sort();
}

function frontmatterValue(text: string, key: string): string {
    if (!text.startsWith("---")) return "";
    const end = text.indexOf("\n---", 3);
    if (end < 0) return "";
    for (const line of text.slice(3, end).split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        if (line.slice(0, idx).trim() === key) {
            return line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
        }
    }
    return "";
}

function loadSkills(root: string): PluginSkill[] {
    return walkMarkdown(root).map((path) => {
        const text = readFileSync(path, "utf-8");
        const name = frontmatterValue(text, "name") || (basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path, ".md"));
        return { name, description: frontmatterValue(text, "description"), path };
    });
}

function loadCommands(root: string): PluginCommand[] {
    return walkMarkdown(root).map((path) => {
        const text = readFileSync(path, "utf-8");
        const first = text.split(/\r?\n/).find((line) => line.trim())?.replace(/^#+/, "").trim() ?? "";
        return { name: basename(path, ".md"), description: first, path };
    });
}

function loadJsonObject(path: string): Record<string, unknown> {
    try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
        return {};
    }
}
