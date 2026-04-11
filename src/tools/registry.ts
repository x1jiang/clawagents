/**
 * ClawAgents Tool System
 *
 * Hybrid tool framework combining:
 * - deepagents' middleware-injected function tools (ls, read_file, write_file, execute)
 * - openclaw's SKILL.md progressive disclosure system
 * - Parallel multi-tool execution when the LLM returns multiple calls
 *
 * Optimizations learned from deepagents/openclaw:
 * - Tool description caching (invalidated on register)
 * - Per-execution timeout (120s default, configurable)
 * - Head+tail truncation with per-tool context budget
 */

// ─── Tool Interface ────────────────────────────────────────────────────────

export interface ToolResult {
    success: boolean;
    output: string | any[];
    error?: string;
}

export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean; items?: { type: string } }>;
    execute(args: Record<string, unknown>): Promise<ToolResult>;
    /** When true, results are cached by (name, args) with a configurable TTL. */
    cacheable?: boolean;
}

export interface ParsedToolCall {
    toolName: string;
    args: Record<string, unknown>;
}

import { ResultCacheManager } from "./cache.js";
import { validateToolArgs, formatValidationErrors } from "./validate.js";
import { resolve } from "node:path";
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";

// ─── Constants (aligned with deepagents/openclaw) ─────────────────────────

const MAX_TOOL_OUTPUT_CHARS = 12_000;
const TRUNCATION_HEAD_CHARS = 5_000;
const TRUNCATION_TAIL_CHARS = 2_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export function truncateToolOutput(
    output: string | any[],
    maxChars = MAX_TOOL_OUTPUT_CHARS,
): string | any[] {
    if (typeof output !== "string") return output;
    if (output.length <= maxChars) return output;
    const head = output.slice(0, TRUNCATION_HEAD_CHARS);
    const tail = output.slice(-TRUNCATION_TAIL_CHARS);
    const dropped = output.length - TRUNCATION_HEAD_CHARS - TRUNCATION_TAIL_CHARS;
    return `${head}\n\n[… truncated ${dropped} characters …]\n\n${tail}`;
}


// ─── File Snapshots (learned from Claude Code: fileHistoryMakeSnapshot) ────
// Before write tools modify a file, snapshot it for undo/rollback capability.

export const WRITE_TOOLS = new Set([
    "write_file", "edit_file", "create_file", "replace_in_file",
    "insert_in_file", "patch_file",
]);

export function snapshotBeforeWrite(toolName: string, args: Record<string, unknown>): void {
    try {
        const envVal = process.env["CLAW_FEATURE_FILE_SNAPSHOTS"] ?? "1";
        if (!["1", "true", "yes", "on"].includes(envVal.toLowerCase())) return;
    } catch { return; }

    if (!WRITE_TOOLS.has(toolName)) return;

    const pathStr = (args.path || args.file_path || args.target_path || "") as string;
    if (!pathStr) return;

    try {
        if (!existsSync(pathStr) || !statSync(pathStr).isFile()) return;

        const ts = Math.floor(Date.now() / 1000);
        const snapDir = resolve(process.cwd(), ".clawagents", "snapshots", String(ts));
        mkdirSync(snapDir, { recursive: true });

        const basename = pathStr.split("/").pop() || pathStr.split("\\").pop() || "file";
        copyFileSync(pathStr, resolve(snapDir, basename));
    } catch {
        // Snapshot failure should never block tool execution
    }
}

// ─── Lazy Tool ────────────────────────────────────────────────────────────────

/**
 * Deferred tool — the backing module is imported only on first execute().
 * Useful for reducing startup latency when many tools are registered but
 * only a subset are used in any given run.
 */
export class LazyTool implements Tool {
    private _resolved: Tool | null = null;

    constructor(
        public readonly name: string,
        public readonly description: string,
        public readonly parameters: Record<string, { type: string; description: string; required?: boolean; items?: { type: string } }>,
        private readonly modulePath: string,
        private readonly className: string,
    ) {}

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        if (!this._resolved) {
            // Dynamic import using the module path (relative or absolute)
            const mod = await import(this.modulePath);
            const Cls = mod[this.className];
            if (typeof Cls !== "function") {
                throw new Error(`LazyTool: class '${this.className}' not found in module '${this.modulePath}'`);
            }
            this._resolved = new Cls() as Tool;
        }
        return this._resolved.execute(args);
    }
}

// ─── Tool Registry ─────────────────────────────────────────────────────────

export class ToolRegistry {
    private tools = new Map<string, Tool>();
    private _descriptionCache: string | null = null;
    private _toolTimeoutMs: number;
    private _resultCache: ResultCacheManager;
    private _validateArgs: boolean;

    constructor(toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS, opts?: {
        cacheMaxSize?: number;
        cacheTtlMs?: number;
        validateArgs?: boolean;
    }) {
        this._toolTimeoutMs = toolTimeoutMs;
        this._resultCache = new ResultCacheManager(
            opts?.cacheMaxSize ?? 256,
            opts?.cacheTtlMs ?? 60_000,
        );
        this._validateArgs = opts?.validateArgs ?? true;
    }

    get resultCache(): ResultCacheManager {
        return this._resultCache;
    }

    register(tool: Tool): void {
        this.tools.set(tool.name, tool);
        this._descriptionCache = null;
    }

    /**
     * Register a tool that will be imported only when first executed.
     * The backing module is loaded lazily on the first call to execute().
     */
    registerLazy(
        name: string,
        description: string,
        parameters: Record<string, { type: string; description: string; required?: boolean; items?: { type: string } }>,
        modulePath: string,
        className: string,
    ): void {
        const lazy = new LazyTool(name, description, parameters, modulePath, className);
        this.tools.set(name, lazy);
        this._descriptionCache = null;
    }

    get(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    list(): Tool[] {
        return Array.from(this.tools.values());
    }

    describeForLLM(): string {
        if (this._descriptionCache !== null) return this._descriptionCache;

        const tools = this.list();
        if (tools.length === 0) { this._descriptionCache = ""; return ""; }

        const parts: string[] = [
            "## Available Tools\n",
            "You can call tools by responding with a JSON block. For a **single** tool call:",
            '```json\n{"tool": "tool_name", "args": {"param": "value"}}\n```\n',
            "For **multiple independent** tool calls that can run in parallel, use an array:",
            "```json\n[\n" +
            '  {"tool": "read_file", "args": {"path": "a.txt"}},\n' +
            '  {"tool": "read_file", "args": {"path": "b.txt"}}\n' +
            "]\n```\n",
            "Use the array form when the calls are independent (no call depends on another's result).\n",
        ];

        for (const tool of tools) {
            parts.push(`### ${tool.name}\n${tool.description}`);
            const params = Object.entries(tool.parameters);
            if (params.length > 0) {
                parts.push("Parameters:");
                for (const [name, info] of params) {
                    const req = info.required ? " (required)" : "";
                    parts.push(`- \`${name}\` (${info.type}${req}): ${info.description}`);
                }
            }
            parts.push("");
        }

        this._descriptionCache = parts.join("\n");
        return this._descriptionCache;
    }

    /** Convert registered tools into NativeToolSchema[] for native function calling. */
    toNativeSchemas(): import("../providers/llm.js").NativeToolSchema[] {
        return this.list().map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        }));
    }

    parseToolCall(response: string): ParsedToolCall | null {
        const calls = this.parseToolCalls(response);
        return calls.length > 0 ? calls[0] : null;
    }

    parseToolCalls(response: string): ParsedToolCall[] {
        const tryParse = (text: string): ParsedToolCall[] => {
            try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed)) {
                    return parsed
                        .filter((item) => item?.tool && typeof item.tool === "string")
                        .map((item) => ({ toolName: item.tool, args: item.args ?? {} }));
                }
                if (parsed?.tool && typeof parsed.tool === "string") {
                    return [{ toolName: parsed.tool, args: parsed.args ?? {} }];
                }
            } catch { /* not valid JSON */ }
            return [];
        };

        const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
        let match: RegExpExecArray | null;
        while ((match = fenceRe.exec(response)) !== null) {
            const calls = tryParse(match[1]);
            if (calls.length > 0) return calls;
        }

        const calls = tryParse(response.trim());
        if (calls.length > 0) return calls;

        return [];
    }

    async executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
        const tool = this.get(toolName);
        if (!tool) {
            return { success: false, output: "", error: `Unknown tool: ${toolName}` };
        }

        // Parameter validation with lenient coercion
        let effectiveArgs = args;
        if (this._validateArgs) {
            const validation = validateToolArgs(tool, args);
            if (!validation.valid) {
                return {
                    success: false,
                    output: "",
                    error: `Invalid parameters:\n${formatValidationErrors(validation.errors)}`,
                };
            }
            effectiveArgs = validation.coerced;
        }

        // Cache lookup for cacheable tools
        if (tool.cacheable) {
            const cached = this._resultCache.get(toolName, effectiveArgs);
            if (cached) return cached;
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            // File snapshot before write tools (Claude Code pattern)
            snapshotBeforeWrite(toolName, effectiveArgs);

            const result = await Promise.race([
                tool.execute(effectiveArgs),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(
                        `Tool "${toolName}" timed out after ${this._toolTimeoutMs / 1000}s. ` +
                        "For long-running commands, consider using a timeout parameter.",
                    )), this._toolTimeoutMs);
                }),
            ]);
            const truncated = { ...result, output: truncateToolOutput(result.output) };

            // Cache successful results for cacheable tools
            if (tool.cacheable && truncated.success) {
                this._resultCache.set(toolName, effectiveArgs, truncated);
            }

            return truncated;
        } catch (err) {
            return { success: false, output: "", error: `Tool error: ${String(err)}` };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    async executeToolsParallel(calls: ParsedToolCall[]): Promise<ToolResult[]> {
        if (calls.length === 0) return [];
        if (calls.length === 1) return [await this.executeTool(calls[0].toolName, calls[0].args)];

        const settled = await Promise.allSettled(
            calls.map((call) => this.executeTool(call.toolName, call.args)),
        );

        return settled.map((result) =>
            result.status === "fulfilled"
                ? result.value
                : { success: false, output: "", error: `Tool error: ${String(result.reason)}` },
        );
    }
}
