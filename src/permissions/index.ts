/**
 * Permission system for clawagents.
 *
 * Exposes `PermissionMode` and the write-class tool registry. Inspired by
 * claude-code-main/src/utils/permissions/PermissionMode.ts.
 */

export {
    PermissionMode,
    WRITE_CLASS_TOOLS,
    isWriteClassTool,
    permissionModeFromString,
} from "./mode.js";
