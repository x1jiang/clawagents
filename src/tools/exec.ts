/**
 * Exec Tool — backed by a pluggable SandboxBackend.
 *
 * Provides shell command execution with timeout and output capture.
 *
 * The pre-execute pipeline is:
 *
 * 1. Obfuscation detector (`detectObfuscation`) — refuses on hit.
 * 2. Bash semantic validator (`validateBash`) — BLOCK refuses, WARN
 *    prepends a notice (and refuses in PLAN mode for DESTRUCTIVE).
 * 3. Legacy `isDangerousCommand` denylist (kept for back-compat).
 * 4. Sandbox exec.
 *
 * Each phase runs inside its own `toolSpan` so traces show where time
 * went.
 */

import type { Tool, ToolResult } from "./registry.js";
import type { SandboxBackend } from "../sandbox/backend.js";
import { LocalBackend } from "../sandbox/local.js";
import { PermissionMode } from "../permissions/mode.js";
import {
    CommandCategory,
    Decision,
    validateBash,
} from "./bash-validator.js";
import { detectObfuscation } from "./exec-obfuscation.js";
import { toolSpan } from "../tracing/index.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 10_000;

// Legacy substring backstop — must never widen policy beyond the bash
// validator. Substring match, so anything added here that overlaps with
// a valid command (e.g. `"curl http"` matching `https://`) breaks real
// workloads.
const BLOCKED_PATTERNS = [
    ":(){ :|:& };:",
];

const DANGEROUS_RE =
    /(?:sudo\s+)?rm\s+(?:-\w*[rf]\w*\s+)*\/\s*$|>\s*['"]?\/dev\/sd|mkfs\.|dd\s+if=|:\(\)\s*\{/i;

export function isDangerousCommand(command: string): boolean {
    if (DANGEROUS_RE.test(command)) return true;
    return BLOCKED_PATTERNS.some((p) => command.includes(p));
}

function createExecTool(sb: SandboxBackend): Tool {
    return {
        name: "execute",
        keywords: ["shell", "bash", "command", "run script", "terminal"],
        description:
            "Execute a shell command and return its output. Use for running scripts, installing packages, checking system state, etc. Commands run in the current working directory.",
        parameters: {
            command: { type: "string", description: "The shell command to execute", required: true },
            timeout: {
                type: "number",
                description: `Timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}`,
            },
        },
        async execute(args, runContext): Promise<ToolResult> {
            const command = String(args["command"] ?? "");
            const timeout = Math.max(100, Number(args["timeout"] ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);

            if (!command) {
                return { success: false, output: "", error: "No command provided" };
            }

            const permissionMode =
                runContext?.permissionMode ?? PermissionMode.DEFAULT;

            type ValidatePhase =
                | { kind: "refuse"; result: ToolResult }
                | { kind: "ok"; warningPrefix: string };

            const validateResult: ValidatePhase = toolSpan<ValidatePhase>(
                "exec.validate",
                (): ValidatePhase => {
                    // 1. Obfuscation detector
                    const ob = detectObfuscation(command);
                    if (ob) {
                        return {
                            kind: "refuse",
                            result: {
                                success: false,
                                output: "",
                                error:
                                    `Refused: obfuscated/encoded command detected ` +
                                    `(${ob.matchedPatterns.join(", ")}): ${ob.reasons.join("; ")}`,
                            },
                        };
                    }

                    // 2. Bash semantic validator
                    const decision = validateBash(command);
                    if (decision.decision === Decision.BLOCK) {
                        return {
                            kind: "refuse",
                            result: {
                                success: false,
                                output: "",
                                error:
                                    `Blocked by bash validator (${decision.category}): ` +
                                    decision.reason,
                            },
                        };
                    }
                    if (
                        permissionMode === PermissionMode.PLAN &&
                        decision.category === CommandCategory.DESTRUCTIVE
                    ) {
                        return {
                            kind: "refuse",
                            result: {
                                success: false,
                                output: "",
                                error:
                                    `Blocked: destructive command refused in plan mode ` +
                                    `(${decision.reason})`,
                            },
                        };
                    }
                    let warningPrefix = "";
                    if (decision.decision === Decision.WARN) {
                        warningPrefix =
                            `[bash_validator: WARN ${decision.category} — ${decision.reason}]\n`;
                    }

                    // 3. Legacy denylist (back-compat)
                    if (isDangerousCommand(command)) {
                        return {
                            kind: "refuse",
                            result: {
                                success: false,
                                output: "",
                                error: `Blocked potentially destructive command: ${command}`,
                            },
                        };
                    }

                    return { kind: "ok", warningPrefix };
                },
                { command },
            );

            if (validateResult.kind === "refuse") return validateResult.result;
            const warningPrefix = validateResult.warningPrefix;

            return await toolSpan<ToolResult>(
                "exec.run",
                async () => {
                    try {
                        const result = await sb.exec(command, { timeout });

                        if (result.killed) {
                            return {
                                success: false,
                                output: "",
                                error: `Command timed out after ${timeout}ms: ${command}`,
                            };
                        }

                        let output = result.stdout || "";
                        if (result.stderr) {
                            output += (output ? "\n" : "") + `[stderr] ${result.stderr}`;
                        }

                        if (output.length > MAX_OUTPUT_CHARS) {
                            const originalLen = output.length;
                            output =
                                output.slice(0, MAX_OUTPUT_CHARS / 2) +
                                `\n\n... [truncated ${originalLen - MAX_OUTPUT_CHARS} chars] ...\n\n` +
                                output.slice(-MAX_OUTPUT_CHARS / 2);
                        }

                        const success = result.exitCode === 0;
                        if (!success && !output) {
                            return {
                                success: false,
                                output: result.stderr ?? "",
                                error: `Command failed with exit code ${result.exitCode}: ${command}`,
                            };
                        }

                        return {
                            success,
                            output: warningPrefix + (output || "(no output)"),
                        };
                    } catch (err: unknown) {
                        const error = err as { stderr?: string; message?: string };
                        return {
                            success: false,
                            output: error.stderr ?? "",
                            error: `Command failed: ${error.message ?? String(err)}`,
                        };
                    }
                },
                { command, timeout_ms: timeout },
            );
        },
    };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function createExecTools(backend: SandboxBackend): Tool[] {
    return [createExecTool(backend)];
}

let _cachedExecTools: Tool[] | null = null;

export function getExecTools(): Tool[] {
    if (!_cachedExecTools) {
        _cachedExecTools = createExecTools(new LocalBackend());
    }
    return _cachedExecTools;
}

export const execTools: Tool[] = createExecTools(new LocalBackend());
export const execTool: Tool = execTools[0]!;
