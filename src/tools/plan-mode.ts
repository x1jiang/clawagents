/**
 * enter_plan_mode / exit_plan_mode built-in tools.
 *
 * Plan mode is a soft-readonly stance the model can opt into to design an
 * approach before mutating state. While in plan mode, the registry refuses
 * write-class tools (see ../permissions/mode.ts).
 *
 * Each tool produces a tool result whose `output` is a system-generated
 * reminder describing the new mode — so the model sees its constraints
 * in the next observation, not in a system-prompt flag.
 */

import { PermissionMode } from "../permissions/mode.js";
import type { RunContext } from "../run-context.js";
import type { Tool, ToolResult } from "./registry.js";

const ENTER_REMINDER =
    "<system-reminder>\n" +
    "You are now in PLAN MODE. Until you call exit_plan_mode, the registry " +
    "will refuse write-class tools (write_file, edit_file, execute, ...).\n" +
    "Do:\n" +
    "  - Read the codebase, search, gather context.\n" +
    "  - Design a concrete plan with steps and impacted files.\n" +
    "  - When ready, call exit_plan_mode and resume normal operation.\n" +
    "Don't:\n" +
    "  - Write or edit files.\n" +
    "  - Run shell commands that modify state.\n" +
    "</system-reminder>";

const EXIT_REMINDER =
    "<system-reminder>\n" +
    "You have exited plan mode. Permission mode is back to DEFAULT. " +
    "Write-class tools are unblocked.\n" +
    "</system-reminder>";

export const enterPlanModeTool: Tool = {
    name: "enter_plan_mode",
    description:
        "Enter PLAN MODE — a read-only exploration phase. While in plan mode, " +
        "write-class tools (write_file, edit_file, execute, ...) are refused. " +
        "Use this before non-trivial implementation tasks to design an approach " +
        "before touching files. Call exit_plan_mode when ready to implement.",
    parameters: {},
    async execute(
        _args: Record<string, unknown>,
        runContext?: RunContext<unknown>,
    ): Promise<ToolResult> {
        if (!runContext) {
            return {
                success: false,
                output: "",
                error:
                    "enter_plan_mode requires a RunContext to mutate the " +
                    "permission mode; this run does not propagate one.",
            };
        }
        runContext.permissionMode = PermissionMode.PLAN;
        return { success: true, output: ENTER_REMINDER };
    },
};

export const exitPlanModeTool: Tool = {
    name: "exit_plan_mode",
    description:
        "Exit PLAN MODE and return to DEFAULT permission mode. Write-class " +
        "tools are unblocked after this call.",
    parameters: {},
    async execute(
        _args: Record<string, unknown>,
        runContext?: RunContext<unknown>,
    ): Promise<ToolResult> {
        if (!runContext) {
            return {
                success: false,
                output: "",
                error:
                    "exit_plan_mode requires a RunContext to mutate the " +
                    "permission mode; this run does not propagate one.",
            };
        }
        runContext.permissionMode = PermissionMode.DEFAULT;
        return { success: true, output: EXIT_REMINDER };
    },
};

/** Return the [enter_plan_mode, exit_plan_mode] tool pair. */
export function createPlanModeTools(): Tool[] {
    return [enterPlanModeTool, exitPlanModeTool];
}
