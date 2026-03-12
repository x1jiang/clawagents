/**
 * Skill Loader — ported from openclaw's SKILL.md progressive disclosure system
 *
 * Skills are markdown files with YAML frontmatter that teach the agent
 * specialized capabilities. The agent can list available skills and
 * load them on demand to learn new abilities.
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import type { Tool, ToolResult } from "./registry.js";

export interface Skill {
    name: string;
    description: string;
    content: string;
    path: string;
    /** Tool names the skill recommends using (from YAML `allowed-tools` field). */
    allowedTools?: string[];
    /** Runtime eligibility requirements parsed from YAML frontmatter. */
    requires?: {
        os?: string;
        bins?: string[];
        env?: string[];
    };
}

/**
 * Parse a SKILL.md file into a Skill object.
 * Extracts YAML frontmatter for name/description and keeps the full markdown body.
 */
function parseSkillFile(content: string, filePath: string): Skill {
    const defaultName = basename(filePath, ".md");
    let name = defaultName;
    let description = "";
    let body = content;
    let allowedTools: string[] = [];
    let requires: Skill["requires"];

    // Parse YAML frontmatter if present
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (frontmatterMatch) {
        const yaml = frontmatterMatch[1] ?? "";
        body = frontmatterMatch[2] ?? "";

        const nameMatch = yaml.match(/^name:\s*(.+)$/m);
        if (nameMatch) name = nameMatch[1]!.trim();

        const descMatch = yaml.match(/^description:\s*"?([^"]+)"?$/m);
        if (descMatch) description = descMatch[1]!.trim();

        // Parse allowed-tools: space-delimited string or YAML list
        const toolsMatch = yaml.match(/^allowed-tools:\s*(.+)$/m);
        if (toolsMatch) {
            allowedTools = toolsMatch[1]!.split(/[\s,]+/).filter(Boolean);
        }

        // Parse requires block for eligibility gating
        const osMatch = yaml.match(/^requires\.os:\s*(.+)$/m)
            ?? yaml.match(/^\s+os:\s*(.+)$/m);
        const binsMatch = yaml.match(/^requires\.bins:\s*(.+)$/m)
            ?? yaml.match(/^\s+bins:\s*(.+)$/m);
        const envMatch = yaml.match(/^requires\.env:\s*(.+)$/m)
            ?? yaml.match(/^\s+env:\s*(.+)$/m);

        if (osMatch || binsMatch || envMatch) {
            const parseList = (raw: string): string[] =>
                raw.replace(/[\[\]"']/g, "").split(/[\s,]+/).filter(Boolean);

            requires = {
                os: osMatch ? osMatch[1]!.trim() : undefined,
                bins: binsMatch ? parseList(binsMatch[1]!) : undefined,
                env: envMatch ? parseList(envMatch[1]!) : undefined,
            };
        }
    }

    return { name, description, content: body.trim(), path: filePath, allowedTools, requires };
}

function isSkillEligible(skill: Skill): boolean {
    if (!skill.requires) return true;
    const req = skill.requires;
    if (req.os && process.platform !== req.os) return false;
    if (req.bins) {
        for (const bin of req.bins) {
            try {
                execSync(`which ${bin}`, { stdio: "ignore" });
            } catch {
                return false;
            }
        }
    }
    if (req.env) {
        for (const envVar of req.env) {
            if (!process.env[envVar]) return false;
        }
    }
    return true;
}

// ─── Skill Store ───────────────────────────────────────────────────────────

export class SkillStore {
    private skills = new Map<string, Skill>();
    private skillDirs: string[] = [];

    addDirectory(dir: string): void {
        if (existsSync(dir)) {
            this.skillDirs.push(dir);
        }
    }

    async loadAll(): Promise<void> {
        for (const dir of this.skillDirs) {
            try {
                const entries = await readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    try {
                        if (entry.isDirectory()) {
                            const skillFile = resolve(dir, entry.name, "SKILL.md");
                            if (existsSync(skillFile)) {
                                const content = await readFile(skillFile, "utf-8");
                                const skill = parseSkillFile(content, skillFile);
                                if (isSkillEligible(skill)) {
                                    this.skills.set(skill.name, skill);
                                }
                            }
                        } else if (entry.name.endsWith(".md")) {
                            const skillFile = resolve(dir, entry.name);
                            const content = await readFile(skillFile, "utf-8");
                            const skill = parseSkillFile(content, skillFile);
                            if (isSkillEligible(skill)) {
                                this.skills.set(skill.name, skill);
                            }
                        }
                    } catch { /* unreadable skill file — skip */ }
                }
            } catch {
                // Directory not readable, skip
            }
        }
    }

    list(): Skill[] {
        return Array.from(this.skills.values());
    }

    get(name: string): Skill | undefined {
        return this.skills.get(name);
    }
}

// ─── Skill Tools ───────────────────────────────────────────────────────────

export function createSkillTools(store: SkillStore): Tool[] {
    const listSkillsTool: Tool = {
        name: "list_skills",
        description: "List all available skills the agent can use.",
        parameters: {},
        async execute(): Promise<ToolResult> {
            const skills = store.list();
            if (skills.length === 0) {
                return { success: true, output: "No skills available." };
            }
            const lines = skills.map((s) => {
                let line = `- **${s.name}**: ${s.description || "(no description)"}`;
                if (s.allowedTools && s.allowedTools.length > 0) {
                    line += `\n  → Allowed tools: ${s.allowedTools.join(", ")}`;
                }
                return line;
            });
            return { success: true, output: `Available skills (${skills.length}):\n${lines.join("\n")}` };
        },
    };

    const useSkillTool: Tool = {
        name: "use_skill",
        description:
            "Load and read a specific skill to learn its instructions. Use list_skills first to see what's available.",
        parameters: {
            name: { type: "string", description: "Name of the skill to load", required: true },
        },
        async execute(args): Promise<ToolResult> {
            const name = String(args["name"] ?? "");
            const skill = store.get(name);
            if (!skill) {
                const available = store
                    .list()
                    .map((s) => s.name)
                    .join(", ");
                return {
                    success: false,
                    output: "",
                    error: `Skill "${name}" not found. Available: ${available || "none"}`,
                };
            }
            return {
                success: true,
                output: `# Skill: ${skill.name}\n\n${skill.content}`,
            };
        },
    };

    return [listSkillsTool, useSkillTool];
}
