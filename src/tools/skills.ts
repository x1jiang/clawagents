/**
 * Skill Loader — ported from openclaw's SKILL.md progressive disclosure system
 *
 * Skills are markdown files with YAML frontmatter that teach the agent
 * specialized capabilities. The agent can list available skills and
 * load them on demand to learn new abilities.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, basename, dirname, relative, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { Tool, ToolResult } from "./registry.js";

// Agent Skills spec limits (agentskills.io; mirrored from deepagents/Claude
// Code). Violations warn — they never reject a skill.
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
// Oversized SKILL.md files are skipped outright (openclaw caps at 256K,
// deepagents at 10M; 1M is a safe middle ground for an instruction file).
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;

const MAX_RESOURCE_ENTRIES = 20;

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
    /** Actions the skill explicitly forbids (from YAML `forbidden-actions` field). */
    forbiddenActions?: string[];
    /** Expected workspace layout description (from YAML `workspace-layout` field). */
    workspaceLayout?: string;
    /** Success criteria description (from YAML `success-criteria` field). */
    successCriteria?: string;
    /** Ordered workflow steps (from YAML `workflow-steps` field). */
    workflowSteps?: string[];
    /** Spec-conformance warnings (lenient: the skill still loads). */
    warnings?: string[];
    /** Claude Code / openclaw `disable-model-invocation`: keep the skill out
     *  of the model-facing catalog and refuse use_skill (user-only). */
    disableModelInvocation?: boolean;
}

/** Directory containing the skill file (bundled resources live beside it). */
export function skillBaseDir(skill: Skill): string {
    return dirname(skill.path);
}

/** True for `<dir>/SKILL.md` skills, which own their directory. */
function isDirSkill(skill: Skill): boolean {
    return basename(skill.path).toLowerCase() === "skill.md";
}

/** `<dir>/SKILL.md` is named after the directory (Claude Code rule);
 *  flat `foo.md` skills fall back to the file stem. */
function defaultSkillName(filePath: string): string {
    if (basename(filePath).toLowerCase() === "skill.md") {
        const dir = basename(dirname(filePath));
        if (dir) return dir;
    }
    return basename(filePath, ".md");
}

function validateSkillName(name: string, filePath: string): string[] {
    const warnings: string[] = [];
    if (name.length > MAX_SKILL_NAME_LENGTH) {
        warnings.push(`skill name exceeds ${MAX_SKILL_NAME_LENGTH} chars: ${name.slice(0, 40)}…`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        warnings.push(
            `skill name "${name}" is not spec-conformant ` +
            "(lowercase letters/digits/hyphens; no leading/trailing/double hyphen)",
        );
    }
    const parent = basename(dirname(filePath));
    if (basename(filePath).toLowerCase() === "skill.md" && parent && name !== parent) {
        warnings.push(`skill name "${name}" does not match its directory "${parent}"`);
    }
    return warnings;
}

/** First meaningful markdown line (Claude Code fallback for a missing
 *  description) so bare .md skills still surface something in the catalog. */
function fallbackDescription(body: string): string {
    for (const line of (body ?? "").split("\n")) {
        const text = line.trim();
        if (!text || /^(#|```|<!--|---|\|)/.test(text)) continue;
        const cleaned = text.replace(/[*_`>]+/g, "").trim();
        if (cleaned) return cleaned.slice(0, 200);
    }
    return "";
}

function parseInlineList(raw: string): string[] {
    return raw.replace(/[\[\]"']/g, "").split(/[\s,]+/).filter(Boolean);
}

/** Parse skill description (plain, quoted, or YAML block scalar). */
function parseFrontmatterDescription(yaml: string): string {
    const block = yaml.match(/^description:\s*[|>]-?\s*\n((?:[ \t]+.*\n?)+)/m);
    if (block) {
        return block[1]!
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .join(" ")
            .trim();
    }
    const quoted = yaml.match(/^description:\s*"(.*)"\s*$/m);
    if (quoted) return quoted[1]!.trim();
    const single = yaml.match(/^description:\s*'(.*)'\s*$/m);
    if (single) return single[1]!.trim();
    const plain = yaml.match(/^description:\s*(.+)$/m);
    if (plain) return plain[1]!.trim().replace(/^["']|["']$/g, "");
    return "";
}

/**
 * Parse eligibility requirements without false-matching other blocks.
 *
 * Accepts, in priority order:
 *   1. dotted keys at top level: `requires.os: darwin`
 *   2. a scoped `requires:` block (indented os/bins/env, inline or block lists)
 *   3. openclaw-style single-line JSON metadata:
 *      `metadata: {"openclaw": {"os": [...], "requires": {"bins": [...]}}}`
 *
 * Earlier versions matched `^\s+os:` anywhere in the frontmatter, so an
 * indented key inside an unrelated block (e.g. `metadata:`) silently gated
 * the skill.
 */
function parseRequires(yaml: string): Skill["requires"] {
    let os: string | undefined;
    let bins: string[] | undefined;
    let env: string[] | undefined;

    const dottedOs = yaml.match(/^requires\.os:\s*(.+)$/m);
    if (dottedOs) os = dottedOs[1]!.trim();
    const dottedBins = yaml.match(/^requires\.bins:\s*(.+)$/m);
    if (dottedBins) bins = parseInlineList(dottedBins[1]!);
    const dottedEnv = yaml.match(/^requires\.env:\s*(.+)$/m);
    if (dottedEnv) env = parseInlineList(dottedEnv[1]!);

    const blockMatch = yaml.match(/^requires:\s*\n((?:[ \t]+[^\n]*\n?)+)/m);
    if (blockMatch) {
        const block = blockMatch[1]!;
        const blockValue = (key: string): string[] | undefined => {
            const inline = block.match(new RegExp(`^[ \\t]+${key}:[ \\t]*(\\S.*)$`, "m"));
            if (inline?.[1]?.trim()) return parseInlineList(inline[1]);
            const list = block.match(
                new RegExp(`^([ \\t]+)${key}:\\s*\\n((?:\\1[ \\t]+-[^\\n]*\\n?)+)`, "m"),
            );
            if (list) {
                return [...list[2]!.matchAll(/-\s*([^\n]+)/g)]
                    .map((m) => m[1]!.trim())
                    .filter(Boolean);
            }
            return undefined;
        };
        const osItems = blockValue("os");
        if (os === undefined && osItems?.length) os = osItems.join(" ");
        if (bins === undefined) bins = blockValue("bins");
        if (env === undefined) env = blockValue("env");
    }

    if (os === undefined && bins === undefined && env === undefined) {
        const metaMatch = yaml.match(/^metadata:\s*(\{.+\})\s*$/m);
        if (metaMatch) {
            try {
                const meta = JSON.parse(metaMatch[1]!);
                const oc = meta && typeof meta === "object" ? meta.openclaw : undefined;
                if (oc && typeof oc === "object") {
                    if (Array.isArray(oc.os) && oc.os.length) os = oc.os.map(String).join(" ");
                    const req = oc.requires;
                    if (req && typeof req === "object") {
                        if (Array.isArray(req.bins)) bins = req.bins.map(String);
                        if (Array.isArray(req.env)) env = req.env.map(String);
                    }
                }
            } catch { /* not strict JSON — ignore */ }
        }
    }

    if (os === undefined && bins === undefined && env === undefined) return undefined;
    return { os, bins, env };
}

/**
 * Parse a SKILL.md file into a Skill object.
 * Extracts YAML frontmatter for name/description and keeps the full markdown body.
 */
export function parseSkillFile(content: string, filePath: string): Skill {
    let name = defaultSkillName(filePath);
    let description = "";
    let body = content;
    let allowedTools: string[] = [];
    let requires: Skill["requires"];
    const warnings: string[] = [];
    let disableModelInvocation = false;

    // Parse YAML frontmatter if present (closing `---` may sit at EOF).
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n([\s\S]*))?$/);
    if (frontmatterMatch) {
        const yaml = frontmatterMatch[1] ?? "";
        body = frontmatterMatch[2] ?? "";

        const nameMatch = yaml.match(/^name:\s*(.+)$/m);
        if (nameMatch) {
            const explicit = nameMatch[1]!.trim().replace(/^["']|["']$/g, "");
            if (explicit) name = explicit;
        }

        description = parseFrontmatterDescription(yaml);

        // Parse allowed-tools: space/comma-delimited string
        const toolsMatch = yaml.match(/^allowed-tools:\s*(.+)$/m);
        if (toolsMatch) {
            allowedTools = toolsMatch[1]!.split(/[\s,]+/).filter(Boolean);
        }

        // Only the literal true counts (Claude Code boolean parsing rule).
        disableModelInvocation = /^disable-model-invocation:\s*["']?true["']?\s*$/m.test(yaml);

        requires = parseRequires(yaml);
    }

    let forbiddenActions: string[] = [];
    let workspaceLayout = "";
    let successCriteria = "";
    let workflowSteps: string[] = [];

    if (frontmatterMatch) {
        const yaml = frontmatterMatch[1] ?? "";

        const parseBlockList = (key: string): string[] | undefined => {
            const block = yaml.match(
                new RegExp(`^${key}:\\s*\\n((?:[ \\t]+-[^\\n]*\\n?)+)`, "m"),
            );
            if (block) {
                return [...block[1]!.matchAll(/^[ \t]+-\s+(.+)$/gm)]
                    .map((m) => m[1]!.trim())
                    .filter(Boolean);
            }
            const inline = yaml.match(new RegExp(`^${key}:[ \\t]+(\\S.*)$`, "m"));
            if (inline) return parseInlineList(inline[1]!.trim());
            return undefined;
        };

        forbiddenActions = parseBlockList("forbidden-actions") ?? [];
        workflowSteps = parseBlockList("workflow-steps") ?? [];

        const layoutMatch = yaml.match(/^workspace-layout:\s*\|?\s*"?([^"|\n][^"]*)"?$/m);
        if (layoutMatch) {
            workspaceLayout = layoutMatch[1]!.trim();
        } else {
            const layoutBlock = yaml.match(/^workspace-layout:\s*\|\s*\n((?:[ \t]+[^\n]*\n?)+)/m);
            if (layoutBlock) workspaceLayout = layoutBlock[1]!;
        }

        const criteriaMatch = yaml.match(/^success-criteria:\s*"?([^"\n]+)"?$/m);
        if (criteriaMatch) successCriteria = criteriaMatch[1]!.trim();
    }

    if (!description) description = fallbackDescription(body);
    if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
        warnings.push(`description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} chars; truncated`);
        description = description.slice(0, MAX_SKILL_DESCRIPTION_LENGTH - 1).trimEnd() + "…";
    }
    warnings.push(...validateSkillName(name, filePath));

    return {
        name, description, content: body.trim(), path: filePath,
        allowedTools, requires,
        forbiddenActions, workspaceLayout, successCriteria, workflowSteps,
        warnings,
        disableModelInvocation,
    };
}

const OS_ALIASES: Record<string, string> = {
    darwin: "darwin", macos: "darwin", mac: "darwin", osx: "darwin",
    win32: "win32", windows: "win32", win: "win32",
    linux: "linux",
};

/** Map user-facing OS names (macos, windows, …) to process.platform values. */
function normalizeOsValues(raw: string): string[] {
    const out: string[] = [];
    for (const part of (raw ?? "").trim().toLowerCase().split(/[\s,]+/)) {
        if (!part) continue;
        if (part === "any" || part === "all" || part === "*") return []; // matches everything
        out.push(OS_ALIASES[part] ?? part);
    }
    return out;
}

/** Why a skill cannot run here, or null if eligible. */
export function skillIneligibilityReason(skill: Skill): string | null {
    if (!skill.requires) return null;
    const req = skill.requires;
    if (req.os) {
        const wanted = normalizeOsValues(req.os);
        if (wanted.length > 0 && !wanted.includes(process.platform)) {
            return `requires os ${req.os} (current: ${process.platform})`;
        }
    }
    for (const bin of req.bins ?? []) {
        // `bin` comes from untrusted SKILL.md YAML. Never interpolate it
        // into a shell string — a value like `x;touch /tmp/pwned` would
        // execute arbitrary commands at skill-load time. Reject anything
        // that isn't a plain program name, then look it up shell-free.
        if (!/^[\w.+-]+$/.test(bin)) return `invalid binary name: ${bin}`;
        try {
            execFileSync("which", [bin], { stdio: "ignore" });
        } catch {
            return `missing binary: ${bin}`;
        }
    }
    for (const envVar of req.env ?? []) {
        if (!process.env[envVar]) return `missing env var: ${envVar}`;
    }
    return null;
}

export function isSkillEligible(skill: Skill): boolean {
    return skillIneligibilityReason(skill) === null;
}

// ─── Load-time content inspection (supply-chain hardening) ──────────────────
// Auto-discovered skills reach the model prompt with no human in the loop, so
// a SKILL.md planted in a scanned directory can smuggle instructions the
// operator never sees. Two documented vectors: invisible-Unicode smuggling
// (Unicode Tags block, bidi overrides — "Rules File Backdoor" / Trojan
// Source) and remote-exec one-liners in the body (ClawHub / VirusTotal).
// Defense-in-depth ONLY — scanners are evadable, never a trust decision. On a
// high-signal hit the skill is quarantined (kept for diagnostics, kept out of
// the catalog, refused by use_skill) rather than deleted.

// Unicode Tags block — invisible chars models still read; ~zero legit use.
const TAG_CHARS_RE = /[\u{E0000}-\u{E007F}]/u;
// Bidirectional overrides / isolates (Trojan Source).
const BIDI_OVERRIDE_RE = /[‪-‮⁦-⁩]/;
// Zero-width / soft-hyphen / BOM — stripped as hygiene + warned, not blocked.
const ZERO_WIDTH_RE = /[​-‍⁠﻿­]/g;
// C0/C1 control chars except tab/newline/carriage-return.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[ --]/g;

// High-signal remote-execution signatures — precision-tuned. Lower-signal
// mentions (bare `rm -rf` / `subprocess.` / `eval(`) are intentionally absent;
// they occur in legitimate skill instructions and belong to the stricter
// authoring-time gate (skill-workshop scanner), not the load gate.
const DANGEROUS_LOAD_PATTERNS: Array<[RegExp, string]> = [
    [
        /\b(?:curl|wget|fetch)\b[^\n|]{0,400}\|\s*(?:sudo\s+)?(?:ba|z|k|a)?sh\b/i,
        "pipes a network download straight into a shell",
    ],
    [
        /\b(?:iex|invoke-expression)\s*[("']/i,
        "PowerShell Invoke-Expression of dynamic content",
    ],
    [/new-object\s+net\.webclient/i, "PowerShell remote download via Net.WebClient"],
    [
        /base64\s+(?:-d|--decode|-D)\b[^\n]{0,200}\|\s*(?:ba)?sh/i,
        "base64-decodes content and pipes it to a shell",
    ],
    [
        /\|\s*base64\s+(?:-d|--decode|-D)\b[^\n]{0,80}\|\s*(?:python|node|perl|ruby)/i,
        "base64-decodes content and pipes it to an interpreter",
    ],
];

/** Remove zero-width / soft-hyphen / BOM / control chars (tab/newline/CR
 *  preserved). Returns [cleaned, removedCount]. */
export function stripInvisible(text: string): [string, number] {
    if (!text) return [text, 0];
    const removed =
        (text.match(ZERO_WIDTH_RE)?.length ?? 0) + (text.match(CONTROL_RE)?.length ?? 0);
    const cleaned = removed ? text.replace(ZERO_WIDTH_RE, "").replace(CONTROL_RE, "") : text;
    return [cleaned, removed];
}

/** High-signal findings that quarantine a skill at load time (covers the
 *  always-injected name+description and the body). Empty = passed. */
export function scanSkillContent(name: string, description: string, body: string): string[] {
    const findings: string[] = [];
    for (const [label, text] of [
        ["name", name],
        ["description", description],
        ["body", body],
    ] as const) {
        if (TAG_CHARS_RE.test(text || "")) {
            findings.push(`invisible Unicode Tag characters in ${label}`);
        }
        if (BIDI_OVERRIDE_RE.test(text || "")) {
            findings.push(`bidirectional-override characters in ${label}`);
        }
    }
    for (const [pattern, why] of DANGEROUS_LOAD_PATTERNS) {
        if (pattern.test(body || "")) findings.push(why);
    }
    return [...new Set(findings)];
}

/** Load-time quarantine is on unless CLAW_SKILL_SCAN=off (invisible-char
 *  stripping still runs regardless — pure hygiene). */
function skillScanEnabled(): boolean {
    const v = (process.env["CLAW_SKILL_SCAN"] ?? "").trim().toLowerCase();
    return v !== "off" && v !== "0" && v !== "false" && v !== "no";
}

// ─── Skill Store ───────────────────────────────────────────────────────────

/**
 * Loads skills from directories.
 *
 * Precedence: directories are loaded in the order added and a later
 * directory overrides an earlier one on name collision (openclaw semantics)
 * — callers must add lowest-precedence roots (e.g. bundled) first.
 */
export class SkillStore {
    private skills = new Map<string, Skill>();
    private skillDirs: string[] = [];
    private seenDirs = new Set<string>();
    /** name → reason for skills whose runtime requirements failed. */
    readonly ineligible = new Map<string, string>();
    /** name → reason for skills that failed the load-time content scan
     *  (invisible-Unicode / remote-exec). Kept out of the model catalog. */
    readonly quarantined = new Map<string, string>();
    /** Human-readable loader diagnostics (spec violations, skipped files). */
    readonly warnings: string[] = [];

    addDirectory(dir: string): void {
        if (!existsSync(dir)) return;
        let key = dir;
        try {
            key = realpathSync(dir);
        } catch { /* fall back to raw path */ }
        if (this.seenDirs.has(key)) return;
        this.seenDirs.add(key);
        this.skillDirs.push(dir);
    }

    private async loadSkillFile(skillFile: string): Promise<void> {
        let content: string;
        try {
            const info = await stat(skillFile);
            if (info.size > MAX_SKILL_FILE_BYTES) {
                this.warnings.push(
                    `${skillFile}: skipped (exceeds ${Math.floor(MAX_SKILL_FILE_BYTES / 1024)}KB limit)`,
                );
                return;
            }
            content = await readFile(skillFile, "utf-8");
        } catch {
            return; // unreadable skill file — skip
        }
        const skill = parseSkillFile(content, skillFile);
        if (!skill.name.trim()) {
            this.warnings.push(`${skillFile}: skipped (empty skill name)`);
            return;
        }

        // ── Trust boundary: inspect content before it can reach the prompt ──
        // Scan the RAW text first (so smuggled chars can't hide from the
        // scanner behind the same chars we then strip), then sanitize
        // everything that gets injected.
        const findings = scanSkillContent(skill.name, skill.description, skill.content);
        const [cleanName, nName] = stripInvisible(skill.name);
        const [cleanDesc, nDesc] = stripInvisible(skill.description);
        const [cleanBody, nBody] = stripInvisible(skill.content);
        skill.name = cleanName;
        skill.description = cleanDesc;
        skill.content = cleanBody;
        if (!skill.name.trim()) {
            this.warnings.push(`${skillFile}: skipped (skill name empty after sanitize)`);
            return;
        }
        if (nName + nDesc + nBody > 0) {
            this.warnings.push(
                `${skillFile}: stripped ${nName + nDesc + nBody} invisible/control char(s) from skill text`,
            );
        }

        for (const w of skill.warnings ?? []) {
            this.warnings.push(`${skillFile}: ${w}`);
        }

        if (findings.length > 0 && skillScanEnabled()) {
            const reason = findings.join("; ");
            this.quarantined.set(skill.name, reason);
            this.warnings.push(
                `${skillFile}: QUARANTINED (content scan) — ${reason}. ` +
                    `Set CLAW_SKILL_SCAN=off to load anyway after review.`,
            );
            this.skills.delete(skill.name);
            return;
        }
        if (findings.length > 0) {
            this.warnings.push(
                `${skillFile}: content-scan findings ignored (CLAW_SKILL_SCAN=off) — ${findings.join("; ")}`,
            );
        }

        const reason = skillIneligibilityReason(skill);
        if (reason !== null) {
            this.ineligible.set(skill.name, reason);
            return;
        }
        this.skills.set(skill.name, skill);
        // A clean load supersedes stale ineligible/quarantine records.
        this.ineligible.delete(skill.name);
        this.quarantined.delete(skill.name);
    }

    async loadAll(): Promise<void> {
        const SKIP_FLAT_MD = new Set(["skill.md", "readme.md", "agents.md", "claude.md"]);
        for (const dir of this.skillDirs) {
            // Directory itself is a skill (…/caveman/SKILL.md)
            const selfSkill = resolve(dir, "SKILL.md");
            if (existsSync(selfSkill)) {
                await this.loadSkillFile(selfSkill);
            }
            try {
                const entries = (await readdir(dir, { withFileTypes: true }))
                    .sort((a, b) => a.name.localeCompare(b.name));
                for (const entry of entries) {
                    if (entry.name.startsWith(".")) continue;
                    try {
                        // Dirent does not follow symlinks; probe symlinked
                        // entries as directories first (plugin caches symlink
                        // skill dirs), then fall back to flat-file handling.
                        const nestedSkill = resolve(dir, entry.name, "SKILL.md");
                        if ((entry.isDirectory() || entry.isSymbolicLink()) && existsSync(nestedSkill)) {
                            await this.loadSkillFile(nestedSkill);
                        } else if (
                            !entry.isDirectory() &&
                            entry.name.endsWith(".md") &&
                            !SKIP_FLAT_MD.has(entry.name.toLowerCase())
                        ) {
                            await this.loadSkillFile(resolve(dir, entry.name));
                        }
                    } catch { /* unreadable skill file — skip */ }
                }
            } catch {
                // Directory not readable, skip
            }
        }
    }

    /** Model-invocable skills (feeds the catalog and skill tools). */
    list(): Skill[] {
        return Array.from(this.skills.values()).filter((s) => !s.disableModelInvocation);
    }

    /** Every loaded skill, including user-invocation-only ones. */
    listAll(): Skill[] {
        return Array.from(this.skills.values());
    }

    get(name: string): Skill | undefined {
        return this.skills.get(name);
    }
}

// ─── Name resolution (fuzzy) ───────────────────────────────────────────────

function normSkillKey(name: string): string {
    return (name ?? "").trim().toLowerCase().replace(/[\s\-]+/g, "_");
}

/** Resolve a skill by exact, case-insensitive, or hyphen/underscore-normalized name. */
export function resolveSkill(store: SkillStore, name: string): Skill | undefined {
    const raw = (name ?? "").trim();
    if (!raw) return undefined;
    const hit = store.get(raw);
    if (hit) return hit;
    const skills = store.list();
    const lower = skills.find((s) => s.name.toLowerCase() === raw.toLowerCase());
    if (lower) return lower;
    const key = normSkillKey(raw);
    return skills.find((s) => normSkillKey(s.name) === key);
}

/** Simple similarity for typo suggestions (bigram Dice coefficient). */
function similarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const bigrams = (s: string): Map<string, number> => {
        const m = new Map<string, number>();
        for (let i = 0; i < s.length - 1; i++) {
            const bg = s.slice(i, i + 2);
            m.set(bg, (m.get(bg) ?? 0) + 1);
        }
        return m;
    };
    const ma = bigrams(a);
    const mb = bigrams(b);
    let overlap = 0;
    for (const [bg, count] of ma) {
        overlap += Math.min(count, mb.get(bg) ?? 0);
    }
    return (2 * overlap) / (a.length - 1 + b.length - 1);
}

/** Close name matches for use_skill typos / near-misses. */
export function suggestSkills(store: SkillStore, name: string, limit = 5): string[] {
    const raw = (name ?? "").trim();
    if (!raw) return [];
    const names = store.list().map((s) => s.name);
    if (names.length === 0) return [];
    const scored = names
        .map((n) => ({ n, score: Math.max(similarity(raw, n), similarity(normSkillKey(raw), normSkillKey(n))) }))
        .filter(({ score }) => score >= 0.45)
        .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ n }) => n);
}

/** Relative paths of files bundled with a dir-based skill (scripts/,
 *  references/, assets/, …) so the agent can read or run them. */
async function listSkillResources(skill: Skill): Promise<string[]> {
    if (!isDirSkill(skill)) return [];
    const base = skillBaseDir(skill);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        if (out.length > MAX_RESOURCE_ENTRIES) return;
        let entries;
        try {
            entries = (await readdir(dir, { withFileTypes: true }))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            return;
        }
        for (const entry of entries) {
            if (out.length > MAX_RESOURCE_ENTRIES) return;
            if (entry.name.startsWith(".")) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.isFile() && entry.name !== "SKILL.md") {
                out.push(relative(base, full));
            }
        }
    };
    await walk(base);
    if (out.length > MAX_RESOURCE_ENTRIES) {
        return [...out.slice(0, MAX_RESOURCE_ENTRIES), "…"];
    }
    return out;
}

// ─── Skill Tools ───────────────────────────────────────────────────────────

export function createSkillTools(store: SkillStore): Tool[] {
    const listSkillsTool: Tool = {
        name: "list_skills",
        description:
            "List all available skill names and short descriptions. " +
            "Prefer the skills catalog already in the system prompt; call this " +
            "only when that catalog was truncated or you need a skill not shown.",
        parameters: {},
        async execute(): Promise<ToolResult> {
            const skills = store.list();
            if (skills.length === 0 && store.ineligible.size === 0 && store.quarantined.size === 0) {
                return { success: true, output: "No skills available." };
            }
            const lines = skills.map((s) => {
                let line = `- **${s.name}**: ${s.description || "(no description)"}`;
                if (s.allowedTools && s.allowedTools.length > 0) {
                    line += `\n  → Allowed tools: ${s.allowedTools.join(", ")}`;
                }
                return line;
            });
            let output = `Available skills (${skills.length}):\n${lines.join("\n")}`;
            if (store.ineligible.size > 0) {
                const unavailable = [...store.ineligible.entries()]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([name, reason]) => `- **${name}**: ${reason}`)
                    .join("\n");
                output += `\n\nUnavailable (requirements not met):\n${unavailable}`;
            }
            if (store.quarantined.size > 0) {
                const blocked = [...store.quarantined.entries()]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([name, reason]) => `- **${name}**: ${reason}`)
                    .join("\n");
                output += `\n\nQuarantined (failed security content scan — not loaded):\n${blocked}`;
            }
            return { success: true, output };
        },
    };

    const useSkillTool: Tool = {
        name: "use_skill",
        description:
            "Load full instructions for one skill by name. Call this early when " +
            "a listed skill matches the user's task (project setup, cohort/SQL " +
            "workflows, document formats, etc.) — do not reinvent that workflow. " +
            "Names are matched case-insensitively; hyphens/underscores are equivalent.",
        parameters: {
            name: { type: "string", description: "Name of the skill to load", required: true },
        },
        async execute(args): Promise<ToolResult> {
            const name = String(args["name"] ?? "").trim();
            const skill = resolveSkill(store, name);
            if (skill?.disableModelInvocation) {
                return {
                    success: false,
                    output: "",
                    error: `Skill "${skill.name}" sets disable-model-invocation and can only be invoked by the user, not by the model.`,
                };
            }
            if (!skill) {
                const available = store.list().map((s) => s.name).sort().join(", ");
                const suggestions = suggestSkills(store, name, 5);
                const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
                let ineligibleNote = "";
                for (const [qname, reason] of store.quarantined) {
                    if (normSkillKey(qname) === normSkillKey(name)) {
                        ineligibleNote = ` Skill "${qname}" was QUARANTINED by the content scanner and cannot be loaded: ${reason}.`;
                        break;
                    }
                }
                if (!ineligibleNote) {
                    for (const [iname, reason] of store.ineligible) {
                        if (normSkillKey(iname) === normSkillKey(name)) {
                            ineligibleNote = ` Skill "${iname}" exists but is unavailable: ${reason}.`;
                            break;
                        }
                    }
                }
                return {
                    success: false,
                    output: "",
                    error: `Skill "${name}" not found.${ineligibleNote}${hint} Available: ${available || "none"}`,
                };
            }
            const parts: string[] = [`# Skill: ${skill.name}`];
            // Resources referenced by the skill body (scripts/…, references/…)
            // resolve relative to this directory — without it the agent cannot
            // locate them (Claude Code prepends the same line).
            parts.push(`Base directory for this skill: ${skillBaseDir(skill)}`);
            const resources = await listSkillResources(skill);
            if (resources.length > 0) {
                parts.push(`Bundled resources (relative to base directory): ${resources.join(", ")}`);
            }

            if (skill.forbiddenActions && skill.forbiddenActions.length > 0) {
                parts.push("\n## Forbidden Actions");
                for (const action of skill.forbiddenActions) {
                    parts.push(`- ${action}`);
                }
            }

            if (skill.workspaceLayout) {
                parts.push("\n## Workspace Layout");
                parts.push(skill.workspaceLayout);
            }

            if (skill.successCriteria) {
                parts.push("\n## Success Criteria");
                parts.push(skill.successCriteria);
            }

            if (skill.workflowSteps && skill.workflowSteps.length > 0) {
                parts.push("\n## Workflow Steps");
                skill.workflowSteps.forEach((step, i) => parts.push(`${i + 1}. ${step}`));
            }

            parts.push(`\n${skill.content}`);
            return {
                success: true,
                output: parts.join("\n"),
            };
        },
    };

    return [listSkillsTool, useSkillTool];
}
