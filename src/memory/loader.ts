/**
 * AGENTS.md / CLAWAGENTS.md memory loader.
 *
 * Reads project-specific memory files and returns their combined content
 * for injection into the agent's system prompt.
 */

import { readFileSync, existsSync, statSync } from "node:fs";

export function loadMemoryFiles(paths: string[]): string | null {
    const sections: string[] = [];

    for (const p of paths) {
        if (!existsSync(p)) continue;
        try {
            const s = statSync(p);
            if (!s.isFile()) continue;
            const content = readFileSync(p, "utf-8").trim();
            if (!content) continue;

            const source = p.split("/").pop() ?? p;
            sections.push(`<agent_memory source="${source}">\n${content}\n</agent_memory>`);
        } catch {
            continue;
        }
    }

    if (sections.length === 0) return null;
    return "## Agent Memory\n\n" + sections.join("\n\n");
}
