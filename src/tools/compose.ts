/**
 * ComposeTool — Deterministic multi-tool pipelines without LLM in the loop.
 *
 * Chains multiple tool calls programmatically, passing results between steps.
 * Lighter-weight than sub-agents for predictable, deterministic workflows.
 *
 * Inspired by ToolUniverse's ComposeTool pattern.
 *
 * @example
 * ```ts
 * const pipeline = createComposeTool({
 *   name: "read_and_grep",
 *   description: "Read a file then search for a pattern",
 *   parameters: {
 *     path: { type: "string", description: "File path", required: true },
 *     pattern: { type: "string", description: "Search pattern", required: true },
 *   },
 *   steps: (args, callTool) => [
 *     () => callTool("read_file", { path: args.path }),
 *     (prev) => callTool("grep", { pattern: args.pattern, content: prev.output }),
 *   ],
 * });
 * registry.register(pipeline);
 * ```
 */

import type { Tool, ToolResult, ToolRegistry } from "./registry.js";

// ─── Step function types ──────────────────────────────────────────────────

/**
 * A tool invocation helper: calls a tool by name with args,
 * returning its ToolResult.
 */
export type CallTool = (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * A pipeline step receives the previous step's result (undefined for the first step)
 * and returns a ToolResult.
 */
export type PipelineStep = (previous: ToolResult | undefined) => Promise<ToolResult>;

/**
 * A step builder receives the original args and the callTool helper,
 * and returns an ordered array of pipeline step functions.
 */
export type StepBuilder = (
    args: Record<string, unknown>,
    callTool: CallTool,
) => PipelineStep[];

// ─── Compose Tool Config ──────────────────────────────────────────────────

export interface ComposeToolConfig {
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    steps: StepBuilder;
}

// ─── Implementation ───────────────────────────────────────────────────────

class ComposeToolImpl implements Tool {
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    private stepBuilder: StepBuilder;
    private registry: ToolRegistry;

    constructor(config: ComposeToolConfig, registry: ToolRegistry) {
        this.name = config.name;
        this.description = config.description;
        this.parameters = config.parameters;
        this.stepBuilder = config.steps;
        this.registry = registry;
    }

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const callTool: CallTool = (toolName, toolArgs) =>
            this.registry.executeTool(toolName, toolArgs);

        const steps = this.stepBuilder(args, callTool);
        if (steps.length === 0) {
            return { success: false, output: "", error: "ComposeTool has no steps" };
        }

        let prev: ToolResult | undefined;
        const outputs: string[] = [];

        for (let i = 0; i < steps.length; i++) {
            try {
                prev = await steps[i]!(prev);
            } catch (err) {
                return {
                    success: false,
                    output: outputs.join("\n---\n"),
                    error: `Step ${i + 1}/${steps.length} failed: ${String(err)}`,
                };
            }

            if (!prev.success) {
                return {
                    success: false,
                    output: outputs.join("\n---\n"),
                    error: `Step ${i + 1}/${steps.length} failed: ${prev.error ?? "unknown error"}`,
                };
            }

            if (typeof prev.output === "string") {
                outputs.push(prev.output);
            }
        }

        return prev ?? { success: true, output: outputs.join("\n---\n") };
    }
}

/**
 * Create a deterministic multi-tool pipeline.
 * The registry is needed so steps can call other registered tools.
 */
export function createComposeTool(config: ComposeToolConfig, registry: ToolRegistry): Tool {
    return new ComposeToolImpl(config, registry);
}
