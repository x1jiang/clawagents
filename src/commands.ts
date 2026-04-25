/**
 * Central slash-command registry for clawagents.
 *
 * Mirrors `clawagents_py/src/clawagents/commands.py`. Single source of truth
 * for slash commands shared by every consumer (CLI help, gateway dispatch,
 * autocomplete, REPL).
 *
 * This module is intentionally tiny: it knows how to *describe* and *resolve*
 * slash commands, but does **not** wire them to the agent loop. Concrete
 * behaviour (e.g. `/steer` injecting a message) is implemented elsewhere
 * (see `steer.ts`); the registry just gives every consumer a consistent
 * vocabulary.
 *
 * Usage:
 * ```ts
 * import { resolveCommand, formatHelp } from "clawagents";
 *
 * const r = resolveCommand("/steer please switch to TypeScript");
 * if (r) {
 *   if (r.command.name === "steer") runContext.steerQueue.push(r.args);
 * }
 *
 * console.log(formatHelp());                       // full help
 * console.log(formatHelp({ category: "Session" })); // filtered
 * ```
 */

/**
 * How a slash-command interacts with the LLM prompt cache.
 *
 * - `"none"` — command does not mutate system-prompt state (most help/info
 *   commands, redaction toggles, history viewers). Safe to run mid-session.
 * - `"deferred"` — command **does** mutate system-prompt state (skills,
 *   permission mode, model, persona, …) but the change defaults to **next
 *   session** to preserve the active prompt cache. Use `--now` to opt
 *   into immediate invalidation. Mirrors Hermes' policy so that the common
 *   case (toggling permissions during a long-running run) does not blow
 *   away the prefix cache and force a full reload.
 * - `"immediate"` — command always invalidates the prompt cache. `/new`,
 *   `/clear`, and `/compress` are inherently immediate because they
 *   rewrite history.
 */
export type CacheImpact = "none" | "deferred" | "immediate";

export interface CommandDef {
    /** Canonical name without leading slash, e.g. `"steer"`. */
    readonly name: string;
    /** One-line human-readable description. */
    readonly description: string;
    /** Display category (`"Session"`, `"Permission"`, `"Info"`, …). */
    readonly category: string;
    /** Alternative names. `["bg"]` lets `/bg` resolve to the same command. */
    readonly aliases?: readonly string[];
    /** Argument placeholder shown in help, e.g. `"<prompt>"`. */
    readonly argsHint?: string;
    /** Tab-completable subcommands (purely informational here). */
    readonly subcommands?: readonly string[];
    /** Hide from gateway / messaging consumers. */
    readonly cliOnly?: boolean;
    /** Hide from the local CLI consumer. */
    readonly gatewayOnly?: boolean;
    /** Prompt-cache impact. Defaults to `"none"`. See {@link CacheImpact}. */
    readonly cacheImpact?: CacheImpact;
}

export interface ResolvedCommand {
    readonly command: CommandDef;
    /** Argument tail (everything after the command name, with `--now` stripped). */
    readonly args: string;
    /**
     * Whether the change should be applied immediately (cache-invalidating).
     *
     * Computed from `command.cacheImpact` and an optional `--now` flag in
     * the original arguments:
     * - `"immediate"` commands → always `true`.
     * - `"deferred"` commands → `true` only when the user passed `--now`.
     * - `"none"` commands → always `false`.
     */
    readonly applyNow: boolean;
}

/** Recognised forms of the "apply this change immediately" override. */
// Only flag-shaped forms; bare `now` is reserved as a normal argument so that
// steer/queue prompts like `/q now do the next thing` are unaffected.
const NOW_FLAGS = new Set(["--now", "-now"]);

// ─── Central registry ──────────────────────────────────────────────────

/** Mutable registry. Use `registerCommand()` to extend at runtime. */
export const COMMAND_REGISTRY: CommandDef[] = [
    // Session control. /new and /clear rewrite history → cache must invalidate.
    { name: "new", description: "Start a new session (fresh history + run id)",
      category: "Session", aliases: ["reset"], cacheImpact: "immediate" },
    { name: "clear", description: "Clear screen and start a new session",
      category: "Session", cliOnly: true, cacheImpact: "immediate" },
    { name: "history", description: "Show conversation history",
      category: "Session", cliOnly: true },
    { name: "save", description: "Save the current conversation / trajectory",
      category: "Session" },
    { name: "retry", description: "Re-send the last user message to the agent",
      category: "Session" },
    { name: "undo", description: "Remove the last user/assistant exchange",
      category: "Session", cacheImpact: "immediate" },
    { name: "title", description: "Set a title for the current session",
      category: "Session", argsHint: "[name]" },
    // /compress rewrites history → cache must invalidate.
    { name: "compress", description: "Manually compress the conversation context",
      category: "Session", argsHint: "[focus topic]", cacheImpact: "immediate" },
    { name: "stop", description: "Cancel the current run / kill background tasks",
      category: "Session" },

    // Mid-run nudges (see `steer.ts`).
    { name: "steer",
      description: "Inject guidance after the next tool call (does not interrupt)",
      category: "Steer", argsHint: "<message>" },
    { name: "queue",
      description: "Queue a message for the next turn (does not interrupt)",
      category: "Steer", aliases: ["q"], argsHint: "<message>" },
    { name: "background", description: "Start a prompt running in the background",
      category: "Steer", aliases: ["bg"], argsHint: "<prompt>" },
    { name: "agents", description: "Show active background agents / tasks",
      category: "Steer", aliases: ["tasks"] },

    // Permission / safety. These reshape system-prompt-level rules and so
    // qualify as "deferred" by default — pass `--now` to invalidate the
    // cache and apply immediately. Mirrors Hermes prompt-cache policy.
    { name: "plan",
      description: "Switch to read-only plan mode (blocks write tools)",
      category: "Permission", cacheImpact: "deferred" },
    { name: "accept-edits",
      description: "Auto-approve write-class edits this run",
      category: "Permission", aliases: ["accept"], cacheImpact: "deferred" },
    { name: "default", description: "Restore the default permission mode",
      category: "Permission", cacheImpact: "deferred" },
    { name: "bypass",
      description: "Disable all permission gates (DANGEROUS, opt-in)",
      category: "Permission", cacheImpact: "deferred" },
    { name: "redact",
      description: "Show or change output redaction (on/off/warn)",
      category: "Permission", argsHint: "[on|off|warn]" },

    // Info / diagnostics
    { name: "help", description: "Show this help (optionally for one command)",
      category: "Info", argsHint: "[command]" },
    { name: "status", description: "Show run status, model, token usage",
      category: "Info" },
    { name: "profile",
      description: "Show active profile name and home directory",
      category: "Info" },
    { name: "version", description: "Show clawagents version", category: "Info" },
    { name: "tools", description: "List currently registered tools",
      category: "Info" },
    { name: "models",
      description: "List known model profiles and routing", category: "Info" },
    { name: "trace", description: "Show the most recent trajectory turn",
      category: "Info" },
];

// ─── Mutable index ─────────────────────────────────────────────────────

const INDEX = new Map<string, CommandDef>();

function rebuildIndex(): void {
    INDEX.clear();
    for (const cmd of COMMAND_REGISTRY) {
        INDEX.set(cmd.name, cmd);
        for (const alias of cmd.aliases ?? []) INDEX.set(alias, cmd);
    }
}

rebuildIndex();

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Append a custom `CommandDef` to the registry.
 * Idempotent: re-registering the same canonical name overwrites the prior
 * entry (and refreshes alias mappings).
 */
export function registerCommand(cmd: CommandDef): void {
    const i = COMMAND_REGISTRY.findIndex((c) => c.name === cmd.name);
    if (i >= 0) {
        COMMAND_REGISTRY[i] = cmd;
    } else {
        COMMAND_REGISTRY.push(cmd);
    }
    rebuildIndex();
}

/**
 * Strip a `--now` (or `-now` / `now`) flag from the argument list.
 *
 * The flag may appear anywhere; returns the cleaned-up arguments and a
 * boolean indicating whether the flag was found.
 */
function stripNowFlag(args: string): { args: string; found: boolean } {
    if (!args) return { args: "", found: false };
    const tokens = args.split(/\s+/).filter(Boolean);
    const rest = tokens.filter((t) => !NOW_FLAGS.has(t.toLowerCase()));
    return { args: rest.join(" "), found: rest.length !== tokens.length };
}

/**
 * Parse `text` as a slash command. Returns `null` if `text` does not begin
 * with `/` or names an unknown command. Trailing whitespace around the
 * argument tail is stripped. A trailing `--now` flag is consumed (not
 * returned in `args`) and used to populate {@link ResolvedCommand.applyNow}
 * for `"deferred"` cache-impact commands.
 */
export function resolveCommand(text: string): ResolvedCommand | null {
    if (!text || !text.startsWith("/")) return null;
    const body = text.slice(1).trim();
    if (!body) return null;
    const spaceIdx = body.indexOf(" ");
    const head = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
    const tail = (spaceIdx === -1 ? "" : body.slice(spaceIdx + 1)).trim();
    const cmd = INDEX.get(head);
    if (!cmd) return null;

    const { args: cleaned, found: nowFlag } = stripNowFlag(tail);
    const cacheImpact: CacheImpact = cmd.cacheImpact ?? "none";
    let applyNow: boolean;
    if (cacheImpact === "immediate") applyNow = true;
    else if (cacheImpact === "deferred") applyNow = nowFlag;
    else applyNow = false;

    return { command: cmd, args: cleaned, applyNow };
}

export interface ListCommandsOpts {
    category?: string;
    audience?: "cli" | "gateway";
}

/** Return all registered commands, optionally filtered. */
export function listCommands(opts: ListCommandsOpts = {}): CommandDef[] {
    const out: CommandDef[] = [];
    for (const cmd of COMMAND_REGISTRY) {
        if (opts.category !== undefined && cmd.category !== opts.category) continue;
        if (opts.audience === "cli" && cmd.gatewayOnly) continue;
        if (opts.audience === "gateway" && cmd.cliOnly) continue;
        out.push(cmd);
    }
    return out;
}

/**
 * Render a categorized help string for the registry. Plain text suitable
 * for a terminal or chat gateway. Categories appear in the order they are
 * first registered.
 */
export function formatHelp(opts: ListCommandsOpts = {}): string {
    const cmds = listCommands(opts);
    if (cmds.length === 0) return "(no commands)";

    const groups = new Map<string, CommandDef[]>();
    for (const cmd of cmds) {
        const arr = groups.get(cmd.category) ?? [];
        arr.push(cmd);
        groups.set(cmd.category, arr);
    }

    const lines: string[] = [];
    for (const [cat, group] of groups) {
        lines.push(`=== ${cat} ===`);
        const lefts = group.map(formatLeft);
        const maxLeft = Math.max(...lefts.map((l) => l.length));
        for (let i = 0; i < group.length; i++) {
            lines.push(`  ${lefts[i].padEnd(maxLeft)}  ${group[i].description}`);
        }
        lines.push("");
    }
    return lines.join("\n").replace(/\s+$/, "");
}

function formatLeft(cmd: CommandDef): string {
    const parts: string[] = [`/${cmd.name}`];
    if (cmd.aliases && cmd.aliases.length > 0) {
        parts.push("(" + cmd.aliases.map((a) => "/" + a).join(", ") + ")");
    }
    if (cmd.argsHint) parts.push(cmd.argsHint);
    return parts.join(" ");
}

/** Return every recognised command name (handy for autocomplete). */
export function allCommandNames(opts: { includeAliases?: boolean } = {}): string[] {
    const includeAliases = opts.includeAliases ?? true;
    if (includeAliases) return [...INDEX.keys()].sort();
    return COMMAND_REGISTRY.map((c) => c.name).sort();
}

// Test-only escape hatch so tests can clean up state after registering and
// removing commands. Not part of the public API surface.
/** @internal */
export function _rebuildCommandIndex(): void {
    rebuildIndex();
}
