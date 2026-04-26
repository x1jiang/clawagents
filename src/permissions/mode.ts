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
