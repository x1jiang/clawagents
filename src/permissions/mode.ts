/**
 * PermissionMode enum + write-class tool registry.
 *
 * The permission mode determines how aggressive the tool registry is at
 * gating state-changing operations. It lives on `RunContext` so hooks,
 * tools, and the registry all consult the same value.
 *
 * Modes (mirror clawagents_py + claude-code-main):
 *
 * - DEFAULT — normal behavior, no extra gating.
 * - PLAN — read-only exploration only. Write-class tools refuse before
 *          executing. The model is expected to call `exit_plan_mode`
 *          to leave.
 * - ACCEPT_EDITS — auto-approve write-class edits without prompting.
 * - BYPASS — bypass all permission prompts (dangerous; opt-in).
 *
 * The mode is set via the dedicated `enter_plan_mode` / `exit_plan_mode`
 * tools. Tools never reach into agent state directly; they only mutate
 * `runContext.permissionMode`.
 */

export enum PermissionMode {
    DEFAULT = "default",
    PLAN = "plan",
    ACCEPT_EDITS = "acceptEdits",
    BYPASS = "bypassPermissions",
}

export interface PermissionDecision {
    allowed: boolean;
    requiresConfirmation: boolean;
    reason: string;
}

export const SENSITIVE_PATH_PATTERNS: readonly string[] = [
    "*/.ssh/*",
    "*/.aws/credentials",
    "*/.aws/config",
    "*/.config/gcloud/*",
    "*/.azure/*",
    "*/.gnupg/*",
    "*/.docker/config.json",
    "*/.kube/config",
    "*/.clawagents/credentials.json",
];

/**
 * Tools whose execution mutates state (filesystem, processes, network
 * side effects). Listed by canonical tool name. The registry consults
 * this set pre-execute when `runContext.permissionMode === PLAN` and
 * refuses with a structured error.
 */
export const WRITE_CLASS_TOOLS: ReadonlySet<string> = new Set([
    // Filesystem writers
    "write_file",
    "edit_file",
    "create_file",
    "replace_in_file",
    "insert_in_file",
    "patch_file",
    "delete_file",
    // Shell / process
    "execute",
    "exec",
    "bash",
    // Composite / sub-agent tools that may issue writes.
    "task",
    "subagent",
    "compose",
]);

export function isWriteClassTool(toolName: string): boolean {
    return WRITE_CLASS_TOOLS.has(toolName);
}

export function evaluateToolPermission(
    toolName: string,
    opts: {
        mode?: PermissionMode;
        isReadOnly?: boolean;
        filePath?: string;
        command?: string;
    } = {},
): PermissionDecision {
    const mode = opts.mode ?? PermissionMode.DEFAULT;
    if (opts.filePath) {
        for (const candidate of policyMatchPaths(opts.filePath)) {
            for (const pattern of SENSITIVE_PATH_PATTERNS) {
                if (globMatch(candidate, pattern)) {
                    return {
                        allowed: false,
                        requiresConfirmation: false,
                        reason: `Access denied: ${opts.filePath} is a sensitive credential path (matched built-in pattern '${pattern}')`,
                    };
                }
            }
        }
    }
    if (mode === PermissionMode.BYPASS) {
        return { allowed: true, requiresConfirmation: false, reason: "bypassPermissions allows this tool" };
    }
    if (opts.isReadOnly) {
        return { allowed: true, requiresConfirmation: false, reason: "read-only tools are allowed" };
    }
    if (mode === PermissionMode.PLAN && isWriteClassTool(toolName)) {
        return { allowed: false, requiresConfirmation: false, reason: "Plan mode blocks mutating tools until exit_plan_mode" };
    }
    if (mode === PermissionMode.ACCEPT_EDITS && isWriteClassTool(toolName)) {
        return { allowed: true, requiresConfirmation: false, reason: "acceptEdits allows write-class tools" };
    }
    const hint = commandPermissionHint(opts.command);
    return {
        allowed: false,
        requiresConfirmation: true,
        reason: `Mutating tools require user confirmation in default mode.${hint ? ` ${hint}` : ""}`,
    };
}

function policyMatchPaths(filePath: string): string[] {
    const normalized = filePath.replace(/\/+$/, "");
    return normalized ? [normalized, `${normalized}/`] : [filePath];
}

function globMatch(value: string, pattern: string): boolean {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`).test(value);
}

function commandPermissionHint(command?: string): string {
    if (!command) return "";
    const lowered = command.toLowerCase();
    const markers = [
        "npm install", "pnpm install", "yarn install", "bun install",
        "pip install", "uv pip install", "poetry install", "cargo install",
        "create-next-app", "npm create ", "pnpm create ", "yarn create ",
        "bun create ", "npx create-", "npm init ", "pnpm init ", "yarn init ",
    ];
    return markers.some((marker) => lowered.includes(marker))
        ? "Package installation and scaffolding commands change the workspace."
        : "";
}

/**
 * Coerce a free-form string to a PermissionMode. Accepts the canonical
 * wire values plus the upper-case enum names. Defaults to DEFAULT.
 */
export function permissionModeFromString(value: string | null | undefined): PermissionMode {
    if (!value) return PermissionMode.DEFAULT;
    const s = String(value).trim();
    // Try canonical wire value first.
    const wireMatch = (Object.values(PermissionMode) as string[]).find((v) => v === s);
    if (wireMatch) return wireMatch as PermissionMode;
    // Try enum name (case-insensitive, with - or _ → _).
    const name = s.toUpperCase().replace(/-/g, "_");
    if (name === "BYPASS") return PermissionMode.BYPASS;
    if (name === "ACCEPT_EDITS") return PermissionMode.ACCEPT_EDITS;
    if (name === "PLAN") return PermissionMode.PLAN;
    if (name === "DEFAULT") return PermissionMode.DEFAULT;
    return PermissionMode.DEFAULT;
}
