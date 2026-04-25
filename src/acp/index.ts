/**
 * Agent Client Protocol (ACP) adapter for ClawAgents.
 *
 * This module wires a ClawAgents agent into Zed's Agent Client Protocol
 * — a JSON-RPC stdio protocol used by IDEs to drive external coding
 * agents. The runtime dependency on the `@zed-industries/agent-client-protocol`
 * package is *optional*: only `AcpServer.serve()` actually requires it.
 * The message dataclasses, session bridge, and `AcpServer.runPrompt()`
 * test path work without the package installed.
 *
 * Mirrors `clawagents.acp` on the Python side.
 */

export { AcpError, MissingAcpDependencyError } from "./errors.js";
export type {
    AgentMessageChunk,
    AgentThoughtChunk,
    PermissionDecision,
    PermissionRequest,
    PromptRequest,
    SessionUpdate,
    StopReason,
    ToolCallComplete,
    ToolCallStart,
} from "./messages.js";
export {
    StopReasonValues,
    agentMessageChunk,
    agentThoughtChunk,
    decodeUpdate,
    encodeUpdate,
    permissionDecisionFromDict,
    promptFromDict,
    promptToDict,
    toolCallStart,
} from "./messages.js";
export type {
    PermissionRequester,
    SessionEventSink,
    AgentSessionOptions,
} from "./session.js";
export { AgentSession } from "./session.js";
export type { AcpServerOptions, AgentLike, PromptRunner } from "./server.js";
export { ACP_AVAILABLE, AcpServer, defaultRunner, serve } from "./server.js";
