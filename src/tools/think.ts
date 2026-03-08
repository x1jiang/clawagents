/**
 * Think Tool — lets the agent reason without side effects.
 *
 * This is a no-op tool: the agent's "thought" is recorded and returned.
 * Reduces unnecessary tool calls by giving the agent a structured place
 * to plan, reason, or reflect before acting.
 */

import type { Tool, ToolResult } from "./registry.js";

export const thinkTool: Tool = {
    name: "think",
    description:
        "Use this tool to think, plan, or reason about the task without taking any action. " +
        "Great for breaking down complex problems, evaluating options, or reflecting on results. " +
        "Your thought is recorded but has no side effects.",
    parameters: {
        thought: {
            type: "string",
            description: "Your reasoning, plan, or analysis",
            required: true,
        },
    },
    async execute(args): Promise<ToolResult> {
        const thought = String(args["thought"] ?? "");
        if (!thought) {
            return { success: false, output: "", error: "No thought provided" };
        }
        return { success: true, output: `[Thought recorded]\n${thought}` };
    },
};

export const thinkTools: Tool[] = [thinkTool];
