/**
 * Adapt an MCP tool descriptor into a clawagents Tool.
 */

import type { Tool, ToolResult } from "../tools/registry.js";
import type { MCPServer, MCPToolDescriptor } from "./server.js";

const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

/**
 * Convert an MCP-tool JSON-Schema ``inputSchema`` into clawagents' parameter shape.
 *
 * clawagents tools use a flat ``{name: {type, description, required}}``;
 * MCP tools use full JSON Schema. We extract just the top-level properties.
 */
export function normalizeInputSchema(
    inputSchema: Record<string, unknown>,
): Record<string, { type: string; description: string; required?: boolean }> {
    if (!inputSchema || typeof inputSchema !== "object") return {};
    const props = (inputSchema as { properties?: unknown }).properties;
    if (!props || typeof props !== "object") return {};
    const requiredArr = (inputSchema as { required?: unknown }).required;
    const required = new Set(Array.isArray(requiredArr) ? (requiredArr as string[]) : []);
    const out: Record<string, { type: string; description: string; required?: boolean }> = {};
    for (const [pname, raw] of Object.entries(props as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as { type?: unknown; description?: unknown };
        let ptype: string | undefined;
        if (typeof r.type === "string") {
            ptype = r.type;
        } else if (Array.isArray(r.type)) {
            ptype = (r.type as string[]).find((t) => t !== "null") ?? "string";
        }
        if (!ptype || !PRIMITIVE_TYPES.has(ptype)) ptype = "string";
        out[pname] = {
            type: ptype,
            description: typeof r.description === "string" ? r.description : "",
            required: required.has(pname),
        };
    }
    return out;
}

/**
 * Reduce an MCP CallToolResult to clawagents' ``ToolResult`` shape.
 *
 * The SDK returns ``{ content: [...blocks], isError? }``. We concatenate
 * text blocks; non-text blocks are summarised by their ``type``.
 */
export function stringifyCallResult(result: any): ToolResult {
    if (!result) return { success: true, output: "" };
    const isError = Boolean(result.isError);
    const content: any[] = Array.isArray(result.content) ? result.content : [];
    const parts: string[] = [];
    for (const block of content) {
        if (block && typeof block.text === "string") {
            parts.push(block.text);
        } else {
            const t = block?.type ?? "unknown";
            parts.push(`[${t} block]`);
        }
    }
    const output = parts.join("\n");
    if (isError) {
        return {
            success: false,
            output,
            error: output || "MCP tool reported isError=true",
        };
    }
    return { success: true, output };
}

/**
 * A clawagents-shaped Tool backed by an MCP server. Each instance forwards
 * ``execute()`` calls to ``server.invokeTool()``.
 */
export class MCPBridgedTool implements Tool {
    public readonly name: string;
    public readonly description: string;
    public readonly parameters: Record<
        string,
        { type: string; description: string; required?: boolean }
    >;
    public readonly serverName: string;
    public readonly originalToolName: string;
    private readonly _server: MCPServer;

    constructor(
        descriptor: MCPToolDescriptor,
        server: MCPServer,
        opts: { namePrefix?: string } = {},
    ) {
        this._server = server;
        this.originalToolName = descriptor.name;
        this.serverName = server.name;
        this.name = opts.namePrefix
            ? `${opts.namePrefix}.${descriptor.name}`
            : descriptor.name;
        this.description =
            descriptor.description ||
            `MCP tool '${descriptor.name}' from server '${server.name}'.`;
        this.parameters = normalizeInputSchema(descriptor.inputSchema);
    }

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const raw = await this._server.invokeTool(this.originalToolName, args);
            return stringifyCallResult(raw);
        } catch (err) {
            return {
                success: false,
                output: "",
                error: `MCP tool '${this.originalToolName}' on server '${this.serverName}' failed: ${String(err)}`,
            };
        }
    }
}

/** Public factory matching the function-style spec in the task brief. */
export function mcpToolToClawagentsTool(
    descriptor: MCPToolDescriptor,
    server: MCPServer,
    opts: { namePrefix?: string } = {},
): MCPBridgedTool {
    return new MCPBridgedTool(descriptor, server, opts);
}
