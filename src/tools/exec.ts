/**
 * Exec Tool — ported from deepagents SandboxBackend + openclaw bash command
 *
 * Provides shell command execution with timeout and output capture.
 */

import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolResult } from "./registry.js";

const execAsync = promisify(execCb);
const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_OUTPUT_CHARS = 10_000;

export const execTool: Tool = {
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

        // Safety: block obviously destructive commands
        const blocked = ["rm -rf /", "mkfs", "dd if=", "> /dev/sd"];
        for (const pattern of blocked) {
            if (command.includes(pattern)) {
                return {
                    success: false,
                    output: "",
                    error: `Blocked potentially destructive command: ${command}`,
                };
            }
        }

        try {
            const { stdout, stderr } = await execAsync(command, {
                timeout,
                maxBuffer: 1024 * 1024, // 1MB
                cwd: process.cwd(),
                env: { ...process.env, PAGER: "cat" },
            });

            let output = stdout || "";
            if (stderr) {
                output += (output ? "\n" : "") + `[stderr] ${stderr}`;
            }

            if (output.length > MAX_OUTPUT_CHARS) {
                const originalLen = output.length;
                output =
                    output.slice(0, MAX_OUTPUT_CHARS / 2) +
                    `\n\n... [truncated ${originalLen - MAX_OUTPUT_CHARS} chars] ...\n\n` +
                    output.slice(-MAX_OUTPUT_CHARS / 2);
            }

            return { success: true, output: output || "(no output)" };
        } catch (err: unknown) {
            const error = err as { stderr?: string; message?: string; killed?: boolean };
            if (error.killed) {
                return {
                    success: false,
                    output: "",
                    error: `Command timed out after ${timeout}ms: ${command}`,
                };
            }
            return {
                success: false,
                output: error.stderr ?? "",
                error: `Command failed: ${error.message ?? String(err)}`,
            };
        }
    },
};

export const execTools: Tool[] = [execTool];
