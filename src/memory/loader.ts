/**
 * AGENTS.md / CLAWAGENTS.md memory loader with typed memory support.
 *
 * Reads project-specific memory files and returns their combined content
 * for injection into the agent's system prompt.
 *
 * Typed Memory (learned from Claude Code):
 *   Memory files can include YAML frontmatter with type/name/description metadata.
 *   This enables type-based filtering and recall precision.
 *
 *   Supported types:
 *     - user:      User preferences ("prefers pytest -x")
 *     - feedback:  Corrections to agent behavior ("stop summarizing diffs")
 *     - project:   Project-specific facts ("sprint deadline is March 15")
 *     - reference: Reference values ("staging URL: https://...")
 */

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";

// ─── Frontmatter Parser (learned from Claude Code: typed memory taxonomy) ──

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

export const VALID_MEMORY_TYPES = new Set(["user", "feedback", "project", "reference", "general"]);

export interface ParsedMemory {
    type: string;
    name: string;
    description: string;
    content: string;
}

export function parseMemoryFrontmatter(content: string): ParsedMemory {
    const match = FRONTMATTER_RE.exec(content);
    if (!match) {
        return { type: "general", name: "", description: "", content };
    }

    const meta: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
        const trimmed = line.trim();
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx > 0) {
            meta[trimmed.slice(0, colonIdx).trim()] = trimmed.slice(colonIdx + 1).trim();
        }
    }

    let memType = meta.type || "general";
    if (!VALID_MEMORY_TYPES.has(memType)) memType = "general";

    return {
        type: memType,
        name: meta.name || "",
        description: meta.description || "",
        content: content.slice(match[0].length).trim(),
    };
}

export function loadMemoryFiles(paths: string[], filterType?: string): string | null {
    // Check feature flag for typed memory
    let typedMemoryEnabled = false;
    try {
        const envVal = process.env["CLAW_FEATURE_TYPED_MEMORY"] ?? "0";
        typedMemoryEnabled = ["1", "true", "yes", "on"].includes(envVal.toLowerCase());
    } catch { /* default off */ }

    const sections: string[] = [];

    for (const p of paths) {
        if (!existsSync(p)) continue;
        try {
            const s = statSync(p);
            if (!s.isFile()) continue;
            const raw = readFileSync(p, "utf-8").trim();
            if (!raw) continue;

            const source = basename(p);

            if (typedMemoryEnabled) {
                const parsed = parseMemoryFrontmatter(raw);

                // Apply type filter
                if (filterType && parsed.type !== filterType) continue;

                const typeAttr = parsed.type !== "general" ? ` type="${parsed.type}"` : "";
                const nameAttr = parsed.name ? ` name="${parsed.name}"` : "";
                sections.push(`<agent_memory source="${source}"${typeAttr}${nameAttr}>\n${parsed.content}\n</agent_memory>`);
            } else {
                sections.push(`<agent_memory source="${source}">\n${raw}\n</agent_memory>`);
            }
        } catch {
            continue;
        }
    }

    if (sections.length === 0) return null;
    return "## Agent Memory\n\n" + sections.join("\n\n");
}

export function loadMemoryDirectory(dirPath: string, filterType?: string): string | null {
    if (!existsSync(dirPath)) return null;
    try {
        const s = statSync(dirPath);
        if (!s.isDirectory()) return null;
    } catch { return null; }

    const files = readdirSync(dirPath)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => resolve(dirPath, f));

    if (files.length === 0) return null;
    return loadMemoryFiles(files, filterType);
}
