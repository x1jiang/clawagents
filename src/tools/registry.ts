/**
 * ClawAgents Tool System
 *
 * Hybrid tool framework combining:
 * - deepagents' middleware-injected function tools (ls, read_file, write_file, execute)
 * - openclaw's SKILL.md progressive disclosure system
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

// ─── Tool Registry ─────────────────────────────────────────────────────────

export class ToolRegistry {
    private tools = new Map<string, Tool>();

    register(tool: Tool): void {
        this.tools.set(tool.name, tool);
    }

    get(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    list(): Tool[] {
        return Array.from(this.tools.values());
    }

    /**
     * Generate a tool description block for inclusion in LLM system prompts.
     * This is how the LLM knows what tools are available.
     */
    describeForLLM(): string {
        const tools = this.list();
        if (tools.length === 0) return "";

        let desc = "## Available Tools\n\nYou can use the following tools by responding with a JSON block like:\n```json\n{\"tool\": \"tool_name\", \"args\": {\"param\": \"value\"}}\n```\n\n";

        for (const tool of tools) {
            desc += `### ${tool.name}\n${tool.description}\n`;
            const params = Object.entries(tool.parameters);
            if (params.length > 0) {
                desc += "Parameters:\n";
                for (const [name, info] of params) {
                    const req = info.required ? " (required)" : "";
                    desc += `- \`${name}\` (${info.type}${req}): ${info.description}\n`;
                }
            }
            desc += "\n";
        }

        return desc;
    }

    /**
     * Parse an LLM response to extract tool calls.
     * Looks for JSON blocks with {tool, args} structure.
     */
    parseToolCall(response: string): { toolName: string; args: Record<string, unknown> } | null {
        // Try to find a JSON block in the response
        const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        if (jsonMatch?.[1]) {
            try {
                const parsed = JSON.parse(jsonMatch[1]) as { tool?: string; args?: Record<string, unknown> };
                if (parsed.tool && typeof parsed.tool === "string") {
                    return { toolName: parsed.tool, args: parsed.args ?? {} };
                }
            } catch {
                // Not valid JSON
            }
        }

        // Also try direct JSON (no code fence)
        try {
            const parsed = JSON.parse(response.trim()) as { tool?: string; args?: Record<string, unknown> };
            if (parsed.tool && typeof parsed.tool === "string") {
                return { toolName: parsed.tool, args: parsed.args ?? {} };
            }
        } catch {
            // Not JSON at all
        }

        return null;
    }

    /**
     * Execute a tool call by name with the given arguments.
     */
    async executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
        const tool = this.get(toolName);
        if (!tool) {
            return { success: false, output: "", error: `Unknown tool: ${toolName}` };
        }
        try {
            return await tool.execute(args);
        } catch (err) {
            return { success: false, output: "", error: `Tool error: ${String(err)}` };
        }
    }
}
