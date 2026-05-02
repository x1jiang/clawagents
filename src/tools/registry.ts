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
    /** Optional search aliases used by compact tool discovery. */
    keywords?: string[];
    parameters: Record<string, { type: string; description: string; required?: boolean; items?: { type: string } }>;
    /**
     * Execute the tool with the given arguments.
     *
     * Tools that want access to the typed user context, live token usage,
     * or the per-call approval store can declare a second parameter; the
     * loop will pass a {@link RunContext} through when available. Keeping
     * the parameter optional preserves backward compatibility with tools
     * that only care about `args`.
     */
    execute(
        args: Record<string, unknown>,
        runContext?: import("../run-context.js").RunContext<unknown>,
    ): Promise<ToolResult>;
    /** When true, results are cached by (name, args) with a configurable TTL. */
    cacheable?: boolean;
    /**
     * When true, the tool may run concurrently with other parallel-safe tools.
     * Defaults to membership in `DEFAULT_PARALLEL_SAFE_TOOLS`.
     */
    parallelSafe?: boolean;
    /**
     * Name of the argument that identifies the resource the tool touches.
     * Used to keep two parallel-safe tools that target the same path serial.
     * Defaults to `DEFAULT_PATH_SCOPED_ARGS[name]` when not declared.
     */
    pathScopedArg?: string;
}

export interface ParsedToolCall {
    toolName: string;
    args: Record<string, unknown>;
}

export interface ToolCatalogEntry {
    name: string;
    description: string;
    parameters: Tool["parameters"];
    keywords: string[];
    cacheable: boolean;
    parallelSafe: boolean;
    pathScopedArg: string | null;
}

import { ResultCacheManager } from "./cache.js";
import { validateToolArgs, formatValidationErrors } from "./validate.js";
import { resolve } from "node:path";
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";

// ─── Lazy Factory Tool ──────────────────────────────────────────────────────
// Like LazyTool but accepts a factory function instead of module+class.
// Defers tool creation to first execute() call.

export class LazyFactoryTool implements Tool {
    private _factory: (() => Promise<Tool>) | null;
    private _resolved: Tool | null = null;

    constructor(
        public readonly name: string,
        public readonly description: string,
        public readonly parameters: Record<string, { type: string; description: string; required?: boolean; items?: { type: string } }>,
        factory: () => Promise<Tool>,
        public readonly keywords?: string[],
    ) {
        this._factory = factory;
    }

    async execute(
        args: Record<string, unknown>,
        runContext?: import("../run-context.js").RunContext<unknown>,
    ): Promise<ToolResult> {
        if (!this._resolved) {
            this._resolved = await this._factory!();
            this._factory = null;
        }
        return this._resolved.execute(args, runContext);
    }
}

// ─── Constants (aligned with deepagents/openclaw) ─────────────────────────

const MAX_TOOL_OUTPUT_CHARS = 12_000;
const TRUNCATION_HEAD_CHARS = 5_000;
const TRUNCATION_TAIL_CHARS = 2_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;


// ─── Parallel-execution policy (learned from Hermes) ──────────────────────
// A tool is run concurrently with siblings only when it is parallel-safe AND
// its path scope (if any) does not collide with another call's path scope.

export const NEVER_PARALLEL_TOOLS: ReadonlySet<string> = new Set([
    "ask_user", "clarify", "confirm", "approve_action",
]);

export const DEFAULT_PARALLEL_SAFE_TOOLS: ReadonlySet<string> = new Set([
    "read_file", "list_dir", "glob", "search_files", "grep",
    "web_fetch", "shell",
]);

export const DEFAULT_PATH_SCOPED_ARGS: Readonly<Record<string, string>> = {
    read_file: "path",
    list_dir: "path",
    glob: "path",
    search_files: "path",
    grep: "path",
    web_fetch: "url",
};

export const MAX_PARALLEL_TOOL_WORKERS = 8;

function isParallelSafe(tool: Tool): boolean {
    if (NEVER_PARALLEL_TOOLS.has(tool.name)) return false;
    if (tool.parallelSafe === true) return true;
    if (tool.parallelSafe === false) return false;
    return DEFAULT_PARALLEL_SAFE_TOOLS.has(tool.name);
}

function pathScopeOf(tool: Tool, args: Record<string, unknown>): string | null {
    const argName = tool.pathScopedArg ?? DEFAULT_PATH_SCOPED_ARGS[tool.name];
    if (!argName) return null;
    const v = args[argName];
    if (v === undefined || v === null) return null;
    return String(v);
}

export function truncateToolOutput(
    output: string | any[],
    maxChars = MAX_TOOL_OUTPUT_CHARS,
): string | any[] {
    if (typeof output !== "string") return output;
    if (output.length <= maxChars) return output;
    const markerBudget = 40;
    const payloadBudget = Math.max(20, maxChars - markerBudget);
    const headChars = Math.min(TRUNCATION_HEAD_CHARS, Math.max(1, Math.floor(payloadBudget * 0.7)));
    const tailChars = Math.min(TRUNCATION_TAIL_CHARS, Math.max(1, payloadBudget - headChars));
    const head = output.slice(0, headChars);
    const tail = output.slice(-tailChars);
    const dropped = Math.max(0, output.length - head.length - tail.length);
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

    async execute(
        args: Record<string, unknown>,
        runContext?: import("../run-context.js").RunContext<unknown>,
    ): Promise<ToolResult> {
        if (!this._resolved) {
            // Dynamic import using the module path (relative or absolute)
            const mod = await import(this.modulePath);
            const Cls = mod[this.className];
            if (typeof Cls !== "function") {
                throw new Error(`LazyTool: class '${this.className}' not found in module '${this.modulePath}'`);
            }
            this._resolved = new Cls() as Tool;
        }
        return this._resolved.execute(args, runContext);
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
        resultCache?: ResultCacheManager;
    }) {
        this._toolTimeoutMs = toolTimeoutMs;
        this._resultCache = opts?.resultCache ?? new ResultCacheManager(
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

    inspectTools(): ToolCatalogEntry[] {
        return this.list().map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            keywords: tool.keywords ?? [],
            cacheable: tool.cacheable === true,
            parallelSafe: isParallelSafe(tool),
            pathScopedArg: tool.pathScopedArg ?? DEFAULT_PATH_SCOPED_ARGS[tool.name] ?? null,
        }));
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

    async executeTool(
        toolName: string,
        args: Record<string, unknown>,
        runContext?: import("../run-context.js").RunContext<unknown>,
    ): Promise<ToolResult> {
        const tool = this.get(toolName);
        if (!tool) {
            return { success: false, output: "", error: `Unknown tool: ${toolName}` };
        }

        // Plan-mode gate: refuse write-class tools when runContext is in PLAN
        // mode. Kept at the registry level (not in agent-loop) so all
        // execution paths see the same gate, including parallel dispatch.
        if (runContext) {
            const { evaluateToolPermission } = await import("../permissions/mode.js");
            const filePath =
                typeof args.path === "string" ? args.path :
                    typeof args.filePath === "string" ? args.filePath :
                        typeof args.file_path === "string" ? args.file_path :
                            undefined;
            const decision = evaluateToolPermission(toolName, {
                mode: runContext.permissionMode,
                filePath,
                command: typeof args.command === "string" ? args.command : undefined,
            });
            if (!decision.allowed && !decision.requiresConfirmation) {
                return {
                    success: false,
                    output: "",
                    error:
                        `Refused: '${toolName}' is a write-class tool and you are in ` +
                        "plan mode. Call exit_plan_mode first, or restrict yourself " +
                        "to read-only tools while planning.",
                };
            }
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
                tool.execute(effectiveArgs, runContext),
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

    async executeToolsParallel(
        calls: ParsedToolCall[],
        runContext?: import("../run-context.js").RunContext<unknown>,
    ): Promise<ToolResult[]> {
        if (calls.length === 0) return [];
        if (calls.length === 1) return [await this.executeTool(calls[0].toolName, calls[0].args, runContext)];

        // Partition calls into ordered batches:
        //   * never-parallel / unsafe tools form singleton batches
        //   * parallel-safe tools merge into the trailing batch when their
        //     path scope (if any) does not collide with existing scopes
        type Slot = { idx: number; call: ParsedToolCall };
        const batches: Slot[][] = [];
        const scopesPerBatch: Set<string>[] = [];

        for (let i = 0; i < calls.length; i++) {
            const call = calls[i];
            const tool = this.tools.get(call.toolName);
            const psafe = !!(tool && isParallelSafe(tool));
            const scope = tool ? pathScopeOf(tool, call.args) : null;

            if (!psafe) {
                batches.push([{ idx: i, call }]);
                scopesPerBatch.push(new Set());
                continue;
            }

            if (batches.length > 0) {
                const last = batches[batches.length - 1];
                const lastScopes = scopesPerBatch[scopesPerBatch.length - 1];
                const lastTool = this.tools.get(last[0].call.toolName);
                const lastPsafe = !!(lastTool && isParallelSafe(lastTool));
                if (
                    lastPsafe
                    && (scope === null || !lastScopes.has(scope))
                    && last.length < MAX_PARALLEL_TOOL_WORKERS
                ) {
                    last.push({ idx: i, call });
                    if (scope !== null) lastScopes.add(scope);
                    continue;
                }
            }

            batches.push([{ idx: i, call }]);
            scopesPerBatch.push(scope !== null ? new Set([scope]) : new Set());
        }

        const results: (ToolResult | undefined)[] = new Array(calls.length).fill(undefined);
        for (const batch of batches) {
            if (batch.length === 1) {
                const { idx, call } = batch[0];
                try {
                    results[idx] = await this.executeTool(call.toolName, call.args, runContext);
                } catch (err) {
                    results[idx] = { success: false, output: "", error: `Tool error: ${String(err)}` };
                }
            } else {
                const settled = await Promise.allSettled(
                    batch.map(({ call }) => this.executeTool(call.toolName, call.args, runContext)),
                );
                for (let j = 0; j < batch.length; j++) {
                    const { idx } = batch[j];
                    const r = settled[j];
                    results[idx] = r.status === "fulfilled"
                        ? r.value
                        : { success: false, output: "", error: `Tool error: ${String(r.reason)}` };
                }
            }
        }

        return results.map((r) => r ?? { success: false, output: "", error: "missing result" });
    }
}
