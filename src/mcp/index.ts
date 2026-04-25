/**
 * MCP (Model Context Protocol) client integration for clawagents.
 *
 * Bridges external MCP servers into the clawagents ToolRegistry so the agent
 * loop can call them like any other tool.
 *
 * Mirrors `clawagents_py/src/clawagents/mcp/__init__.py`.
 *
 * Public surface:
 *   - MCPServer (abstract)
 *   - MCPServerStdio
 *   - MCPServerSse
 *   - MCPServerStreamableHttp
 *   - MCPServerManager
 *   - MCPLifecyclePhase
 *   - MCPToolDescriptor
 *   - MCPBridgedTool
 *   - mcpToolToClawagentsTool
 *   - isMCPSdkAvailable / requireMCPSdk
 *
 * The optional ``@modelcontextprotocol/sdk`` package is loaded lazily —
 * importing this module does not require the SDK; only ``connect()`` does.
 */

export {
    MCPServer,
    MCPServerStdio,
    MCPServerSse,
    MCPServerStreamableHttp,
    MCPLifecyclePhase,
    isMCPSdkAvailable,
    requireMCPSdk,
    scrubEnvForStdio,
} from "./server.js";
export type {
    MCPServerStdioParams,
    MCPServerSseParams,
    MCPServerStreamableHttpParams,
    MCPServerOptions,
    MCPToolDescriptor,
    ToolFilter,
} from "./server.js";

export { MCPServerManager } from "./manager.js";
export type { MCPServerManagerOptions } from "./manager.js";

export {
    MCPBridgedTool,
    mcpToolToClawagentsTool,
    normalizeInputSchema,
    stringifyCallResult,
} from "./tool_bridge.js";
