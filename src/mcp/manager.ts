/**
 * MCPServerManager — lifecycles a list of MCPServers.
 */

import type { ToolRegistry } from "../tools/registry.js";
import { customSpan } from "../tracing/index.js";
import { MCPServer } from "./server.js";
import { mcpToolToClawagentsTool } from "./tool_bridge.js";

export interface MCPServerManagerOptions {
    /** When true, registered tool names are prefixed with the server name. */
    namePrefixWithServer?: boolean;
}

/**
 * Lifecycles a collection of MCPServer instances. The agent factory feeds
 * its ``mcpServers=`` list into a manager, which connects each server, lists
 * its tools, bridges them into the supplied ToolRegistry, and registers a
 * shutdown finalizer.
 */
export class MCPServerManager {
    public readonly servers: MCPServer[];
    public readonly namePrefixWithServer: boolean;

    private _started = false;
    private _registeredToolNames: string[] = [];

    constructor(servers: Iterable<MCPServer>, opts: MCPServerManagerOptions = {}) {
        this.servers = Array.from(servers);
        this.namePrefixWithServer = opts.namePrefixWithServer ?? false;
    }

    public get started(): boolean {
        return this._started;
    }

    /**
     * Connect every server and bridge their tools into ``registry``.
     * Returns the list of tool names registered. Idempotent.
     */
    public async start(registry: ToolRegistry): Promise<string[]> {
        if (this._started) return [...this._registeredToolNames];

        return await customSpan(
            "mcp.manager.start",
            async () => {
                for (const server of this.servers) {
                    await server.connect();
                    const tools = await server.listTools();
                    const namePrefix = this.namePrefixWithServer ? server.name : undefined;
                    for (const descriptor of tools) {
                        const bridged = mcpToolToClawagentsTool(descriptor, server, { namePrefix });
                        registry.register(bridged);
                        this._registeredToolNames.push(bridged.name);
                    }
                }
                this._started = true;
                return [...this._registeredToolNames];
            },
            { server_count: this.servers.length },
        );
    }

    /**
     * Shut every server down sequentially. We deliberately avoid Promise.all
     * here so that transports relying on per-task affinity (any future
     * channel-based transport) cannot have their cleanup interleaved.
     */
    public async shutdown(): Promise<void> {
        if (this.servers.length === 0) {
            this._started = false;
            return;
        }
        await customSpan(
            "mcp.manager.shutdown",
            async () => {
                for (const server of this.servers) {
                    try {
                        await server.shutdown();
                    } catch (err) {
                        customSpan(
                            "mcp.manager.shutdown_error",
                            () => undefined,
                            { server: server.name, error: String(err) },
                        );
                    }
                }
                this._started = false;
            },
            { server_count: this.servers.length },
        );
    }

    public async listAllTools(): Promise<Record<string, any[]>> {
        const out: Record<string, any[]> = {};
        for (const server of this.servers) {
            out[server.name] = await server.listTools();
        }
        return out;
    }

    public async invokeTool(
        serverName: string,
        toolName: string,
        args: Record<string, unknown> = {},
    ): Promise<any> {
        for (const server of this.servers) {
            if (server.name === serverName) {
                return await server.invokeTool(toolName, args);
            }
        }
        throw new Error(`No MCP server registered with name '${serverName}'`);
    }
}
