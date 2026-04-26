import type { Tool, ToolRegistry, ToolResult } from "./registry.js";

export interface ToolProgramOptions {
    allowedTools?: Iterable<string>;
    maxSteps?: number;
}

type ProgramStep = {
    id?: string;
    tool: string;
    args?: Record<string, unknown>;
};

const DEFAULT_ALLOWED_TOOLS = new Set([
    "ls", "read_file", "grep", "glob", "tree", "diff", "web_fetch", "echo",
]);

function substitute(value: unknown, results: Map<string, ToolResult>): unknown {
    if (typeof value === "string") {
        return value.replace(/\$\{([A-Za-z0-9_.-]+)\.output\}/g, (_m, key: string) => {
            const found = results.get(key);
            return found ? String(found.output) : "";
        });
    }
    if (Array.isArray(value)) return value.map((item) => substitute(item, results));
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = substitute(v, results);
        return out;
    }
    return value;
}

export function createToolProgramTool(
    registry: ToolRegistry,
    opts: ToolProgramOptions = {},
): Tool {
    const allowedTools = new Set(opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS);
    const maxSteps = Math.max(1, opts.maxSteps ?? 8);

    return {
        name: "tool_program",
        description:
            "Run a bounded read-only sequence of tool calls with ${step.output} substitutions. " +
            "Use this for deterministic multi-step lookups without returning every intermediate result.",
        parameters: {
            steps: {
                type: "array",
                description: "Ordered steps: {id?: string, tool: string, args?: object}.",
                required: true,
                items: { type: "object" },
            },
        },
        async execute(args): Promise<ToolResult> {
            const steps = args["steps"];
            if (!Array.isArray(steps)) {
                return { success: false, output: "", error: "tool_program requires a steps array" };
            }
            if (steps.length > maxSteps) {
                return { success: false, output: "", error: `tool_program supports at most ${maxSteps} steps` };
            }

            const results = new Map<string, ToolResult>();
            let last: ToolResult = { success: true, output: "" };

            for (let i = 0; i < steps.length; i++) {
                const step = steps[i] as ProgramStep;
                if (!step || typeof step.tool !== "string") {
                    return { success: false, output: "", error: `Step ${i + 1} is missing a tool name` };
                }
                if (step.tool === "tool_program" || !allowedTools.has(step.tool)) {
                    return { success: false, output: "", error: `Step ${i + 1} uses disallowed tool: ${step.tool}` };
                }

                const effectiveArgs = substitute(step.args ?? {}, results) as Record<string, unknown>;
                last = await registry.executeTool(step.tool, effectiveArgs);
                const key = step.id || String(i);
                results.set(key, last);
                results.set(String(i), last);

                if (!last.success) {
                    return {
                        success: false,
                        output: "",
                        error: `Step ${i + 1}/${steps.length} (${step.tool}) failed: ${last.error ?? "unknown error"}`,
                    };
                }
            }

            return last;
        },
    };
}
