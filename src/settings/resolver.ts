/**
 * Settings hierarchy resolver — user / project / local / flag / policy.
 *
 * Mirrors `clawagents_py/src/clawagents/settings/resolver.py`.
 *
 * Five layers, lowest to highest precedence (Policy ALWAYS wins):
 *   1. user     — `~/.clawagents/settings.json`
 *   2. project  — `<repo>/.clawagents/settings.json` (committed)
 *   3. local    — `<repo>/.clawagents/settings.local.json` (gitignored)
 *   4. flag     — runtime flags passed to `resolveSettings`
 *   5. policy   — `/etc/clawagents/policy-settings.json` (or env var
 *                 `CLAWAGENTS_POLICY_SETTINGS_PATH`)
 *
 * Pure stdlib — no extra runtime dependencies.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const POLICY_SETTINGS_PATH_ENV = "CLAWAGENTS_POLICY_SETTINGS_PATH";
export const DEFAULT_POLICY_SETTINGS_PATH = "/etc/clawagents/policy-settings.json";

export enum SettingsLayer {
    USER = "user",
    PROJECT = "project",
    LOCAL = "local",
    FLAG = "flag",
    POLICY = "policy",
}

export type SettingsValue =
    | string
    | number
    | boolean
    | null
    | SettingsValue[]
    | { [k: string]: SettingsValue };

export type SettingsObject = Record<string, unknown>;

export interface ResolveSettingsOptions {
    /** Runtime-injected flags. Treated as already-loaded JSON. */
    flagOverrides?: SettingsObject;
    /** Override the auto-detected repo root. Defaults to walking up from CWD. */
    repoRoot?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function loadJsonFile(filePath: string): SettingsObject {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, "utf-8");
    } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e && e.code === "ENOENT") return {};
        // Other I/O errors — warn and skip.
        // eslint-disable-next-line no-console
        console.warn(`clawagents.settings: cannot read ${filePath}: ${String(e?.message ?? e)}`);
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err: unknown) {
        const e = err as Error;
        // eslint-disable-next-line no-console
        console.warn(`clawagents.settings: malformed JSON in ${filePath}: ${e.message}`);
        return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        // eslint-disable-next-line no-console
        console.warn(
            `clawagents.settings: ${filePath} does not contain a JSON object; skipping`,
        );
        return {};
    }
    return parsed as SettingsObject;
}

function isPlainObject(v: unknown): v is SettingsObject {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base: SettingsObject, overlay: SettingsObject): SettingsObject {
    const out: SettingsObject = { ...base };
    for (const [k, v] of Object.entries(overlay)) {
        const prev = out[k];
        if (isPlainObject(prev) && isPlainObject(v)) {
            out[k] = deepMerge(prev, v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

const REPO_MARKERS = [".git", "pyproject.toml", "package.json"] as const;

export function findRepoRoot(start?: string): string {
    let cur = path.resolve(start ?? process.cwd());
    // Walk up until root.
    while (true) {
        for (const marker of REPO_MARKERS) {
            try {
                fs.accessSync(path.join(cur, marker));
                return cur;
            } catch {
                /* not here */
            }
        }
        const parent = path.dirname(cur);
        if (parent === cur) {
            // Reached filesystem root with no marker.
            return path.resolve(start ?? process.cwd());
        }
        cur = parent;
    }
}

function userSettingsPath(): string {
    return path.join(os.homedir(), ".clawagents", "settings.json");
}

function projectSettingsPath(repoRoot: string): string {
    return path.join(repoRoot, ".clawagents", "settings.json");
}

function localSettingsPath(repoRoot: string): string {
    return path.join(repoRoot, ".clawagents", "settings.local.json");
}

function policySettingsPath(): string {
    const override = process.env[POLICY_SETTINGS_PATH_ENV];
    if (override && override.length > 0) return override;
    return DEFAULT_POLICY_SETTINGS_PATH;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Collapse all settings layers into a single object.
 *
 * Precedence (highest wins, except policy which ALWAYS wins):
 *   user < project < local < flag < policy
 */
export function resolveSettings(options: ResolveSettingsOptions = {}): SettingsObject {
    const root = findRepoRoot(options.repoRoot);

    const user = loadJsonFile(userSettingsPath());
    const project = loadJsonFile(projectSettingsPath(root));
    const local = loadJsonFile(localSettingsPath(root));
    const flag: SettingsObject = options.flagOverrides ? { ...options.flagOverrides } : {};
    const policy = loadJsonFile(policySettingsPath());

    let merged: SettingsObject = {};
    merged = deepMerge(merged, user);
    merged = deepMerge(merged, project);
    merged = deepMerge(merged, local);
    merged = deepMerge(merged, flag);
    // Policy is applied LAST: wins over everything, including flags.
    merged = deepMerge(merged, policy);
    return merged;
}

export interface GetSettingOptions extends ResolveSettingsOptions {
    /** Pre-resolved settings dict; if provided, skips re-resolution. */
    settings?: SettingsObject;
}

/**
 * Read a dotted path out of resolved settings.
 *
 * @example
 *   getSetting("hooks.before_tool")   // → string[] | undefined
 */
export function getSetting<T = unknown>(
    pathStr: string,
    defaultValue?: T,
    options: GetSettingOptions = {},
): T | undefined {
    const src: SettingsObject = options.settings ?? resolveSettings(options);
    let cur: unknown = src;
    for (const segment of pathStr.split(".")) {
        if (!isPlainObject(cur) || !(segment in cur)) {
            return defaultValue;
        }
        cur = cur[segment];
    }
    return cur as T;
}
