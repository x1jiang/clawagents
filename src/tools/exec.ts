/**
 * Exec Tool — backed by a pluggable SandboxBackend.
 *
 * Provides shell command execution with timeout and output capture.
 */

import type { Tool, ToolResult } from "./registry.js";
import type { SandboxBackend } from "../sandbox/backend.js";
import { LocalBackend } from "../sandbox/local.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 10_000;

const BLOCKED_PATTERNS = [
    "rm -rf /", "rm -rf /*", "rm -rf .", "rm -rf ~",
    "mkfs", "dd if=", "> /dev/sd", ":(){ :|:& };:",
    "chmod -R 777 /", "chown -R", "> /dev/null",
];

const DANGEROUS_RE = /(?:sudo\s+)?rm\s+(?:-\w*[rf]\w*\s+)\/\s*$|>\s*\/dev\/sd|mkfs\.|dd\s+if=|:\(\)\s*\{/i;

function isDangerousCommand(command: string): boolean {
    if (DANGEROUS_RE.test(command)) return true;
    return BLOCKED_PATTERNS.some((p) => command.includes(p));
}

function createExecTool(sb: SandboxBackend): Tool {
    return {
        name: "execute",
        description:
            "Execute a shell command and return its output. Use for running scripts, installing packages, checking system state, etc. Commands run in the current working directory.",
        parameters: {
            command: { type: "string", description: "The shell command to execute", required: true },
            timeout: {
                type: "number",
                description: `Timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}`,
            },
        },
        async execute(args): Promise<ToolResult> {
            const command = String(args["command"] ?? "");
            const timeout = Math.max(100, Number(args["timeout"] ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);

            if (!command) {
                return { success: false, output: "", error: "No command provided" };
            }

            if (isDangerousCommand(command)) {
                return {
                    success: false,
                    output: "",
                    error: `Blocked potentially destructive command: ${command}`,
                };
            }

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

                return { success, output: output || "(no output)" };
            } catch (err: unknown) {
                const error = err as { stderr?: string; message?: string };
                return {
                    success: false,
                    output: error.stderr ?? "",
                    error: `Command failed: ${error.message ?? String(err)}`,
                };
            }
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
