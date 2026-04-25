/**
 * Profile-aware filesystem paths for ClawAgents.
 *
 * ClawAgents uses two complementary on-disk locations:
 *
 * - **Workspace** (per-project): `<cwd>/.clawagents/...` — trajectories,
 *   sessions, and lessons that are scoped to a specific repository or
 *   working tree. This is the legacy behavior; older modules still
 *   default to it.
 * - **Home** (per-user, profile-aware): `~/.clawagents/<profile>/...` —
 *   user-level state shared across projects (global lessons, identity
 *   caches, persistent memory, credential pools).
 *
 * Pick the right one for your data:
 *
 * | Data                                       | Recommended scope |
 * | ------------------------------------------ | ----------------- |
 * | Trajectory of a specific run               | workspace         |
 * | Lessons distilled from one repo            | workspace         |
 * | Cross-project lesson library               | home              |
 * | Per-user agent identity / preferences      | home              |
 * | Per-user MCP server credentials            | home              |
 *
 * ## Environment overrides
 *
 * - `CLAWAGENTS_HOME` — absolute path overriding `~/.clawagents`.
 *   Useful for sandboxed CI runs or testing.
 * - `CLAWAGENTS_PROFILE` — name of the active profile (default
 *   `"default"`). Profiles let one user keep separate state for, say,
 *   personal vs. work agents.
 * - `CLAWAGENTS_WORKSPACE` — absolute path overriding `<cwd>`. Mainly
 *   useful for tests.
 *
 * Mirrors `clawagents_py/src/clawagents/paths.py`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_PROFILE = "default";
export const WORKSPACE_DIRNAME = ".clawagents";
export const HOME_DIRNAME = ".clawagents";

function profileName(profile?: string): string {
    if (profile && profile.length > 0) return profile;
    const env = process.env.CLAWAGENTS_PROFILE;
    if (env && env.length > 0) return env;
    return DEFAULT_PROFILE;
}

function expandUser(p: string): string {
    if (p.startsWith("~")) {
        return path.join(os.homedir(), p.slice(1));
    }
    return p;
}

/** Options for path resolvers that can create their target on demand. */
export interface PathOpts {
    /** Profile name. Falls back to `CLAWAGENTS_PROFILE` then `"default"`. */
    profile?: string;
    /** If true, mkdirs (recursive) the resolved path before returning. */
    create?: boolean;
}

/**
 * Return the active per-user, profile-scoped home directory.
 *
 * By default this is `~/.clawagents/<profile>/`. Set `CLAWAGENTS_HOME`
 * to override the parent (`~/.clawagents`); the profile suffix is
 * always applied unless `CLAWAGENTS_HOME` already ends with the profile
 * name.
 */
export function getClawagentsHome(opts: PathOpts = {}): string {
    const name = profileName(opts.profile);
    const override = process.env.CLAWAGENTS_HOME;
    let home: string;
    if (override) {
        const base = expandUser(override);
        // Treat the override as the *parent* unless it already ends with
        // the profile dir.
        home = path.basename(base) === name ? base : path.join(base, name);
    } else {
        home = path.join(os.homedir(), HOME_DIRNAME, name);
    }
    if (opts.create) fs.mkdirSync(home, { recursive: true });
    return home;
}

/**
 * Return the per-project workspace directory.
 *
 * Defaults to `<cwd>/.clawagents/`. Override the working directory via
 * `CLAWAGENTS_WORKSPACE`.
 */
export function getClawagentsWorkspaceDir(opts: { create?: boolean } = {}): string {
    const override = process.env.CLAWAGENTS_WORKSPACE;
    const base = override ? expandUser(override) : process.cwd();
    const ws = path.join(base, WORKSPACE_DIRNAME);
    if (opts.create) fs.mkdirSync(ws, { recursive: true });
    return ws;
}

export type Scope = "workspace" | "home";

interface ScopedPathOpts extends PathOpts {
    scope?: Scope;
}

function scopedDir(child: string, scope: Scope, opts: PathOpts): string {
    let parent: string;
    if (scope === "home") {
        parent = getClawagentsHome({ profile: opts.profile });
    } else if (scope === "workspace") {
        parent = getClawagentsWorkspaceDir();
    } else {
        throw new Error(`unknown scope ${JSON.stringify(scope)} (expected 'workspace' or 'home')`);
    }
    const out = path.join(parent, child);
    if (opts.create) fs.mkdirSync(out, { recursive: true });
    return out;
}

/** Trajectories directory under the chosen scope. Default: workspace. */
export function getTrajectoriesDir(opts: ScopedPathOpts = {}): string {
    return scopedDir("trajectories", opts.scope ?? "workspace", opts);
}

/** Sessions directory under the chosen scope. Default: workspace. */
export function getSessionsDir(opts: ScopedPathOpts = {}): string {
    return scopedDir("sessions", opts.scope ?? "workspace", opts);
}

/**
 * Lessons directory under the chosen scope. Defaults to `home` so
 * lessons survive across projects.
 */
export function getLessonsDir(opts: ScopedPathOpts = {}): string {
    return scopedDir("lessons", opts.scope ?? "home", opts);
}

/**
 * Return a user-facing string for the active profile home directory.
 *
 * Resolves the same path as {@link getClawagentsHome}, but renders
 * paths under `$HOME` as `~/...` so tool descriptions, approval prompts,
 * and trajectory messages show the user a familiar shorthand rather than
 * a fully-resolved absolute path that may include the sandbox or
 * profile chosen via `CLAWAGENTS_HOME`/`CLAWAGENTS_PROFILE`.
 *
 * Use this whenever a path is shown to humans (tool schemas, log lines,
 * README snippets); use {@link getClawagentsHome} when the code itself
 * needs to read or write a file.
 *
 * Mirrors `display_clawagents_home()` in `clawagents_py` and Hermes'
 * `display_hermes_home()`.
 */
export function displayClawagentsHome(profile?: string): string {
    const home = getClawagentsHome({ profile });
    const homedir = os.homedir();
    if (home === homedir) return "~";
    if (home.startsWith(homedir + path.sep)) {
        return "~/" + home.slice(homedir.length + 1);
    }
    return home;
}

/**
 * Return a user-facing string for the active workspace directory.
 *
 * Like {@link displayClawagentsHome} but for the per-project workspace.
 */
export function displayClawagentsWorkspaceDir(): string {
    const ws = getClawagentsWorkspaceDir();
    const homedir = os.homedir();
    if (ws === homedir) return "~";
    if (ws.startsWith(homedir + path.sep)) {
        return "~/" + ws.slice(homedir.length + 1);
    }
    return ws;
}

/**
 * Enumerate profile directories under `~/.clawagents/` (or the
 * `CLAWAGENTS_HOME` override). Returns names sorted alphabetically;
 * returns `[]` if the parent doesn't exist.
 */
export function listProfiles(): string[] {
    const override = process.env.CLAWAGENTS_HOME;
    const parent = override ? expandUser(override) : path.join(os.homedir(), HOME_DIRNAME);
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => e.name)
        .sort();
}
