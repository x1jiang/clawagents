/**
 * External hook system for ClawAgents.
 *
 * Hooks are shell commands configured in .clawagents/hooks.json or via
 * environment variables. They run before/after tool execution and LLM calls,
 * receiving JSON on stdin and returning JSON on stdout.
 *
 * Inspired by claw-code-main's hook system.
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const HOOK_TIMEOUT_MS = 10_000;

export interface HooksConfig {
    pre_tool_use?: string | null;
    post_tool_use?: string | null;
    pre_llm?: string | null;
    post_llm?: string | null;
}

function hasAnyHook(config: HooksConfig): boolean {
    return !!(config.pre_tool_use || config.post_tool_use || config.pre_llm || config.post_llm);
}

export function loadHooksConfig(): HooksConfig | null {
    const config: HooksConfig = {};

    // 1. Try .clawagents/hooks.json
    const hooksFile = resolve(process.cwd(), ".clawagents", "hooks.json");
    if (existsSync(hooksFile)) {
        try {
            const data = JSON.parse(readFileSync(hooksFile, "utf-8"));
            config.pre_tool_use = data.pre_tool_use ?? null;
            config.post_tool_use = data.post_tool_use ?? null;
            config.pre_llm = data.pre_llm ?? null;
            config.post_llm = data.post_llm ?? null;
        } catch (err) {
            console.error(`[hooks] Failed to load hooks.json: ${err}`);
        }
    }

    // 2. Env var overrides
    const envMap: Array<[keyof HooksConfig, string]> = [
        ["pre_tool_use", "CLAW_HOOK_PRE_TOOL_USE"],
        ["post_tool_use", "CLAW_HOOK_POST_TOOL_USE"],
        ["pre_llm", "CLAW_HOOK_PRE_LLM"],
        ["post_llm", "CLAW_HOOK_POST_LLM"],
    ];
    for (const [attr, envKey] of envMap) {
        const val = process.env[envKey];
        if (val) config[attr] = val;
    }

    return hasAnyHook(config) ? config : null;
}

export async function runHook(
    command: string,
    inputData: Record<string, unknown>,
    timeoutMs = HOOK_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
    return new Promise((resolvePromise) => {
        try {
            const proc = spawn("sh", ["-c", command], {
                stdio: ["pipe", "pipe", "pipe"],
            });

            const timer = setTimeout(() => {
                proc.kill("SIGTERM");
                console.error(`[hooks] Hook ${command} timed out after ${timeoutMs}ms — proceeding without`);
                resolvePromise(null);
            }, timeoutMs);

            const chunks: Buffer[] = [];
            const errChunks: Buffer[] = [];

            proc.stdout.on("data", (data: Buffer) => chunks.push(data));
            proc.stderr.on("data", (data: Buffer) => errChunks.push(data));

            proc.on("close", (code) => {
                clearTimeout(timer);
                if (code !== 0) {
                    const stderr = Buffer.concat(errChunks).toString("utf-8").slice(0, 200);
                    console.error(`[hooks] Hook ${command} exited ${code}: ${stderr}`);
                    resolvePromise(null);
                    return;
                }
                const stdout = Buffer.concat(chunks).toString("utf-8").trim();
                if (!stdout) { resolvePromise(null); return; }
                try {
                    resolvePromise(JSON.parse(stdout));
                } catch {
                    console.error(`[hooks] Hook ${command} returned invalid JSON`);
                    resolvePromise(null);
                }
            });

            proc.on("error", (err) => {
                clearTimeout(timer);
                console.error(`[hooks] Hook ${command} failed: ${err}`);
                resolvePromise(null);
            });

            proc.stdin.write(JSON.stringify(inputData));
            proc.stdin.end();
        } catch (err) {
            console.error(`[hooks] Hook ${command} spawn failed: ${err}`);
            resolvePromise(null);
        }
    });
}

export class ExternalHookRunner {
    constructor(private config: HooksConfig) {}

    async preToolUse(
        toolName: string,
        args: Record<string, unknown>,
    ): Promise<{ allowed: boolean; args: Record<string, unknown> }> {
        if (!this.config.pre_tool_use) return { allowed: true, args };

        const result = await runHook(this.config.pre_tool_use, {
            event: "pre_tool_use",
            tool: toolName,
            args,
        });
        if (!result) return { allowed: true, args }; // fail-open

        return {
            allowed: (result.allowed as boolean) ?? true,
            args: (result.updated_input as Record<string, unknown>) ?? args,
        };
    }

    async postToolUse(
        toolName: string,
        args: Record<string, unknown>,
        toolResult: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        if (!this.config.post_tool_use) return toolResult;

        const result = await runHook(this.config.post_tool_use, {
            event: "post_tool_use",
            tool: toolName,
            args,
            result: toolResult,
        });
        if (!result) return toolResult; // fail-open

        return (result.updated_result as Record<string, unknown>) ?? toolResult;
    }

    async preLLM(
        messageCount: number,
        lastRole: string,
    ): Promise<Array<{ role: string; content: string }> | null> {
        if (!this.config.pre_llm) return null;

        const result = await runHook(this.config.pre_llm, {
            event: "pre_llm",
            message_count: messageCount,
            last_role: lastRole,
        });
        if (!result) return null;

        return (result.messages as Array<{ role: string; content: string }>) ?? null;
    }

    async postLLM(responsePreview: string, toolCallsCount: number): Promise<void> {
        if (!this.config.post_llm) return;

        await runHook(this.config.post_llm, {
            event: "post_llm",
            response_preview: responsePreview.slice(0, 500),
            tool_calls_count: toolCallsCount,
        });
    }
}
