/**
 * Permission system for clawagents.
 *
 * Exposes `PermissionMode` and the write-class tool registry. Inspired by
 * claude-code-main/src/utils/permissions/PermissionMode.ts.
 */

export {
    PermissionMode,
    SENSITIVE_PATH_PATTERNS,
    WRITE_CLASS_TOOLS,
    evaluateToolPermission,
    isWriteClassTool,
    permissionModeFromString,
} from "./mode.js";
export type { PermissionDecision } from "./mode.js";
