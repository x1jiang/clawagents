/**
 * ClawAgents — Backend engine combining openclaw resilience with deepagents reasoning.
 *
 * This is the **library entry point** — pure exports, no side effects.
 * Importing this module does not start a server, parse argv, or write banners.
 *
 * For the CLI (gateway server, --task, --doctor, --trajectory), use:
 *   - dist/cli.js (after `npm run build`)
 *   - or `clawagents` binary when installed from npm
 *   - or `npx tsx src/cli.ts` during development
 */

// Re-export public API
export { createClawAgent, ClawAgent, LangChainToolAdapter } from "./agent.js";
export type {
    AgentState, OnEvent, EventKind, BeforeLLMHook, BeforeToolHook, AfterToolHook, HookResult,
    AgentLoopExtras, OnStreamEvent, ApprovalHandler, OutputTypeSpec,
} from "./graph/agent-loop.js";

// ── openai-agents-python parity surfaces ─────────────────────────────
export { RunContext } from "./run-context.js";
export type { ApprovalRecord } from "./run-context.js";
export { Usage, RequestUsage } from "./usage.js";
export type {
    StreamEvent, TurnStartedEvent, AssistantTextEvent, AssistantDeltaEvent,
    ToolCallPlannedEvent, ToolStartedEvent, ToolResultEvent, UsageEvent,
    GuardrailTrippedEvent, FinalOutputEvent, ErrorStreamEvent,
    ApprovalRequiredEvent, GenericStreamEvent,
} from "./stream-events.js";
export { streamEventFromKind } from "./stream-events.js";
export { RetryPolicy, DEFAULT_RETRY_POLICY } from "./retry.js";
export { RunHooks, AgentHooks, compositeHooks } from "./lifecycle.js";
export type {
    LifecyclePayload, LLMStartPayload, LLMEndPayload, ToolStartPayload, ToolEndPayload,
    AgentStartPayload, AgentEndPayload, RunStartPayload, RunEndPayload, HandoffPayload,
} from "./lifecycle.js";
export {
    GuardrailBehavior, GuardrailResult, GuardrailTripwireTriggered,
    InputGuardrail, OutputGuardrail, inputGuardrail, outputGuardrail,
} from "./guardrails.js";
export type { InputGuardrailFn, OutputGuardrailFn } from "./guardrails.js";
export { functionTool, createTool } from "./function-tool.js";
export type { FunctionToolOptions, CreateToolOptions, FunctionToolParamSpec, JsonSchemaType } from "./function-tool.js";
export { InMemorySession, JsonlFileSession, SqliteSession } from "./session/backends.js";
export type { Session } from "./session/backends.js";
export type { Tool, ToolResult, ToolRegistry } from "./tools/registry.js";
export { ResultCacheManager } from "./tools/cache.js";
export { validateToolArgs, formatValidationErrors } from "./tools/validate.js";
export type { ValidationResult, ValidationError } from "./tools/validate.js";
export { createComposeTool } from "./tools/compose.js";
export type { ComposeToolConfig, CallTool, PipelineStep, StepBuilder } from "./tools/compose.js";
export type { LLMProvider, LLMMessage, LLMResponse } from "./providers/llm.js";
export { TrajectoryRecorder, classifyFailure, pruneTrajectories } from "./trajectory/recorder.js";
export type { TurnRecord, RunSummary, ToolCallRecord } from "./trajectory/recorder.js";
export {
    extractLessons, saveLessons, loadLessons,
    buildLessonPreamble, buildRethinkWithLessons,
    shouldExtractLessons,
    exportLessons, importLessons,
} from "./trajectory/lessons.js";
export {
    computeDeterministicScore,
    detectTaskType,
    verifyTaskOutcome,
    computeAdaptiveRethinkThreshold,
} from "./trajectory/verifier.js";
export { compareSamples } from "./trajectory/compare.js";
export { judgeRun } from "./trajectory/judge.js";
export type { JudgeResult } from "./trajectory/judge.js";
export { stripThinkingTokens } from "./providers/llm.js";
export type { ContextEngine, ContextEngineConfig } from "./context/index.js";
export { DefaultContextEngine, registerContextEngine, resolveContextEngine, listContextEngines } from "./context/index.js";

// Channels & WebSocket
export type { ChannelMessage, ChannelAdapter, AgentFactory, ChannelRouterOptions } from "./channels/index.js";
export { ChannelRouter, KeyedAsyncQueue } from "./channels/index.js";
export { TelegramAdapter } from "./channels/telegram.js";
export { WhatsAppAdapter } from "./channels/whatsapp.js";
export { SignalAdapter } from "./channels/signal.js";
export type { WsRequest, WsResponse, WsEvent } from "./gateway/protocol.js";
export { attachWebSocket } from "./gateway/ws.js";
export { detectChannels, startChannelRouter } from "./channels/auto.js";
export type { DetectedChannel } from "./channels/auto.js";

// Gateway (so library users can mount it themselves if they want to)
export { startGateway } from "./gateway/server.js";

// Config helpers
export { loadConfig, getDefaultModel, resolvedEnvFile } from "./config/config.js";

// Error Taxonomy
export { ErrorClass, classifyError, getRecoveryRecipe, RECOVERY_RECIPES } from "./errors/taxonomy.js";
export type { ErrorDescriptor, RecoveryRecipe } from "./errors/taxonomy.js";

// External Hooks
export { ExternalHookRunner, loadHooksConfig, runHook } from "./hooks/external.js";
export type { HooksConfig } from "./hooks/external.js";

// Session Persistence
export { SessionWriter, SessionReader, listSessions } from "./session/persistence.js";
export type { SessionInfo, SessionEvent } from "./session/persistence.js";

// SSRF helpers (exposed so consumers / tests can verify guardrails)
export { ssrfDeps } from "./tools/web.js";
