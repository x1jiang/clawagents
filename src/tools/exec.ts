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

const BLOCKED_PATTERNS = ["rm -rf /", "mkfs", "dd if=", "> /dev/sd"];

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

            for (const pattern of BLOCKED_PATTERNS) {
                if (command.includes(pattern)) {
                    return {
                        success: false,
                        output: "",
                        error: `Blocked potentially destructive command: ${command}`,
                    };
                }
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

export const execTools: Tool[] = createExecTools(new LocalBackend());

// Backward-compatible named export
export const execTool: Tool = execTools[0]!;
