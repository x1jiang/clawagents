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
    output: string;
    error?: string;
}

export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ParsedToolCall {
    toolName: string;
    args: Record<string, unknown>;
}

// ─── Constants (aligned with deepagents/openclaw) ─────────────────────────

const MAX_TOOL_OUTPUT_CHARS = 12_000;
const TRUNCATION_HEAD_CHARS = 5_000;
const TRUNCATION_TAIL_CHARS = 2_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export function truncateToolOutput(
    output: string,
    maxChars = MAX_TOOL_OUTPUT_CHARS,
): string {
    if (output.length <= maxChars) return output;
    const head = output.slice(0, TRUNCATION_HEAD_CHARS);
    const tail = output.slice(-TRUNCATION_TAIL_CHARS);
    const dropped = output.length - TRUNCATION_HEAD_CHARS - TRUNCATION_TAIL_CHARS;
    return `${head}\n\n[… truncated ${dropped} characters …]\n\n${tail}`;
}

// ─── Tool Registry ─────────────────────────────────────────────────────────

export class ToolRegistry {
    private tools = new Map<string, Tool>();
    private _descriptionCache: string | null = null;
    private _toolTimeoutMs: number;

    constructor(toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
        this._toolTimeoutMs = toolTimeoutMs;
    }

    register(tool: Tool): void {
        this.tools.set(tool.name, tool);
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
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                tool.execute(args),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(
                        `Tool "${toolName}" timed out after ${this._toolTimeoutMs / 1000}s. ` +
                        "For long-running commands, consider using a timeout parameter.",
                    )), this._toolTimeoutMs);
                }),
            ]);
            return { ...result, output: truncateToolOutput(result.output) };
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
