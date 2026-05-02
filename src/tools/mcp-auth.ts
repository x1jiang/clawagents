import type { Tool, ToolResult } from "./registry.js";
import type { MCPServerManager } from "../mcp/manager.js";

export function createMcpAuthTool(manager: MCPServerManager): Tool {
    return {
        name: "mcp_auth",
        description: "Configure auth for an MCP server and reconnect active sessions when possible.",
        keywords: ["mcp", "auth", "bearer", "header", "env", "reconnect"],
        parameters: {
            server_name: { type: "string", description: "Configured MCP server name.", required: true },
            mode: { type: "string", description: "Auth mode: bearer, header, or env.", required: true },
            value: { type: "string", description: "Secret value to apply.", required: true },
            key: { type: "string", description: "Header or env key override." },
        },
        async execute(args: Record<string, unknown>): Promise<ToolResult> {
            try {
                await manager.updateServerAuth(String(args.server_name ?? ""), {
                    mode: String(args.mode ?? ""),
                    value: String(args.value ?? ""),
                    key: args.key === undefined || args.key === null ? undefined : String(args.key),
                    reconnect: true,
                });
                return { success: true, output: `Saved MCP auth for ${String(args.server_name ?? "")}` };
            } catch (err) {
                return { success: false, output: "", error: String(err) };
            }
        },
    };
}

