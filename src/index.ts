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
export {
    BUILTIN_PROVIDER_PROFILES,
    loadProviderProfiles,
    resolveProviderProfile,
} from "./provider-profiles.js";
export type { ProviderProfile, ResolvedProviderProfile } from "./provider-profiles.js";
export { buildDryRunPreview } from "./dry-run.js";
export type { DryRunPreview } from "./dry-run.js";
export { loadPlugin, discoverPlugins } from "./plugin-compat.js";
export type { LoadedCompatPlugin, PluginSkill, PluginCommand } from "./plugin-compat.js";
export type {
    AgentState, OnEvent, EventKind, BeforeLLMHook, BeforeToolHook, AfterToolHook, HookResult,
    AgentLoopExtras, OnStreamEvent, ApprovalHandler, OutputTypeSpec,
} from "./graph/agent-loop.js";

// ── openai-agents-python parity surfaces ─────────────────────────────
export { RunContext, MAX_SUBAGENT_DEPTH } from "./run-context.js";
export type { ApprovalRecord } from "./run-context.js";
export {
    IterationBudget,
    DEFAULT_DELEGATION_MAX_ITERATIONS,
} from "./iteration-budget.js";
export { PluginManager } from "./plugins.js";
export type { Plugin } from "./plugins.js";
export { Usage, RequestUsage } from "./usage.js";
export type {
    StreamEvent, TurnStartedEvent, AssistantTextEvent, AssistantDeltaEvent,
    ToolCallPlannedEvent, ToolStartedEvent, ToolResultEvent, UsageEvent,
    GuardrailTrippedEvent, HandoffOccurredEvent, FinalOutputEvent, ErrorStreamEvent,
    ApprovalRequiredEvent, GenericStreamEvent,
} from "./stream-events.js";
export { streamEventFromKind } from "./stream-events.js";

// ── Handoffs (v6.4) ──────────────────────────────────────────────────
export { handoff } from "./handoffs.js";
export type { Handoff, HandoffInputData, InputFilter } from "./handoffs.js";
export { removeAllTools, nestHandoffHistory } from "./handoff-filters.js";
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
export type { ToolCatalogEntry } from "./tools/registry.js";
export { ResultCacheManager, SqliteResultCacheManager } from "./tools/cache.js";
export { validateToolArgs, formatValidationErrors } from "./tools/validate.js";
export type { ValidationResult, ValidationError } from "./tools/validate.js";
export { createToolDiscoveryTools, namesForToolProfile } from "./tools/catalog.js";
export type { ToolProfileName } from "./tools/catalog.js";
export { createComposeTool } from "./tools/compose.js";
export type { ComposeToolConfig, CallTool, PipelineStep, StepBuilder } from "./tools/compose.js";
export { createToolProgramTool } from "./tools/tool-program.js";
export type { ToolProgramOptions } from "./tools/tool-program.js";
export { runTextEnvironment, runAgentEnvironment } from "./eval.js";
export type {
    TextEnvironment, TextEnvInit, TextEnvStepOutput,
    TextEvaluationResult, TextEvaluationStep, TextResponder,
    AgentEnvironment, AgentEnvInit, AgentEnvStepOutput,
    AgentEvaluationResult, AgentEvaluationStep, AgentResponder,
} from "./eval.js";
export { RunResult } from "./run-result.js";
export type { RunResultState } from "./run-result.js";
export { createExplorerTools } from "./explorer.js";
export type { ExplorerToolsOptions } from "./explorer.js";
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

// PromptHook (LLM-evaluated guardrail, v6.4)
export { PromptHook, parseVerdict } from "./hooks/prompt-hook.js";
export type { PromptHookVerdict, PromptHookOptions } from "./hooks/prompt-hook.js";

// Session Persistence
export { SessionWriter, SessionReader, listSessions } from "./session/persistence.js";
export type { SessionInfo, SessionEvent } from "./session/persistence.js";

// SSRF helpers (exposed so consumers / tests can verify guardrails)
export { ssrfDeps } from "./tools/web.js";
export { DockerBackend } from "./sandbox/docker.js";
export type { DockerBackendOptions } from "./sandbox/docker.js";
export { normalizeSandboxManifest } from "./sandbox/manifest.js";
export type {
    SandboxManifest,
    SandboxManifestEntry,
    NormalizedSandboxManifest,
    NormalizedSandboxManifestEntry,
} from "./sandbox/manifest.js";

// ── Settings hierarchy (v6.4) ────────────────────────────────────────
export {
    SettingsLayer, resolveSettings, getSetting, findRepoRoot,
    POLICY_SETTINGS_PATH_ENV, DEFAULT_POLICY_SETTINGS_PATH,
} from "./settings/index.js";
export type {
    SettingsObject, SettingsValue, ResolveSettingsOptions, GetSettingOptions,
} from "./settings/index.js";

// ── Tracing (v6.4) ───────────────────────────────────────────────────
export {
    Span, SpanKind, SpanStatus, newTraceId,
    TracingProcessor, TracingExporter,
    BatchTraceProcessor, NoopSpanExporter, ConsoleSpanExporter, JsonlSpanExporter,
    setDefaultProcessor, getDefaultProcessor, addTraceProcessor,
    flushTraces, shutdownTracing,
    withSpan, agentSpan, turnSpan, generationSpan, toolSpan,
    handoffSpan, guardrailSpan, customSpan,
    currentSpan, currentTraceId,
} from "./tracing/index.js";
export type { SpanInit } from "./tracing/index.js";

// ── Structured HITL (v6.4) ───────────────────────────────────────────
export {
    askUserQuestionTool,
    OTHER_OPTION,
    QUESTION_MAX_CHARS, HEADER_MAX_CHARS,
    MIN_QUESTIONS, MAX_QUESTIONS, MIN_OPTIONS, MAX_OPTIONS,
} from "./tools/ask-user-question.js";
export type {
    QuestionSpec, AnswerSpec, OnAskCallback, AskUserQuestionOptions,
} from "./tools/ask-user-question.js";

// ── Multimodal helpers (v6.4) ────────────────────────────────────────
export {
    sanitizeImageBlock, sanitizeToolOutput, isSharpAvailable,
    DEFAULT_MAX_DIM, DEFAULT_MAX_BYTES, DEFAULT_QUALITY_STEPS,
} from "./media/images.js";
export type {
    ContentBlock as MediaContentBlock,
    ImageBlock, ImageBlockBase64Source, ImageBlockUrlSource,
    SanitizeOptions,
} from "./media/images.js";

// ── Exec Safety v2 (v6.4) ────────────────────────────────────────────
export {
    PermissionMode, WRITE_CLASS_TOOLS,
    SENSITIVE_PATH_PATTERNS,
    evaluateToolPermission,
    isWriteClassTool, permissionModeFromString,
} from "./permissions/mode.js";
export type { PermissionDecision as ToolPermissionDecision } from "./permissions/mode.js";
export {
    CommandCategory, Decision, validateBash,
} from "./tools/bash-validator.js";
export type { BashDecision } from "./tools/bash-validator.js";
export { detectObfuscation } from "./tools/exec-obfuscation.js";
export type { ObfuscationFinding } from "./tools/exec-obfuscation.js";
export {
    enterPlanModeTool, exitPlanModeTool, createPlanModeTools,
} from "./tools/plan-mode.js";
export { createBackgroundTaskTools } from "./tools/background-task.js";
export { createMcpAuthTool } from "./tools/mcp-auth.js";

// ── MCP (Model Context Protocol) integration (v6.4) ──────────────────
// The optional ``@modelcontextprotocol/sdk`` package is loaded lazily —
// these classes import without the SDK installed and only fail on connect().
export {
    MCPServer,
    MCPServerStdio,
    MCPServerSse,
    MCPServerStreamableHttp,
    MCPServerManager,
    MCPLifecyclePhase,
    MCPBridgedTool,
    mcpToolToClawagentsTool,
    isMCPSdkAvailable,
    requireMCPSdk,
} from "./mcp/index.js";
export type {
    MCPServerStdioParams,
    MCPServerSseParams,
    MCPServerStreamableHttpParams,
    MCPServerOptions,
    MCPServerManagerOptions,
    MCPToolDescriptor,
    ToolFilter as MCPToolFilter,
} from "./mcp/index.js";

// ── Slash-command registry (v6.5) ────────────────────────────────────
export {
    COMMAND_REGISTRY,
    registerCommand,
    resolveCommand,
    listCommands,
    formatHelp,
    allCommandNames,
} from "./commands.js";
export type { CommandDef, ResolvedCommand, ListCommandsOpts } from "./commands.js";

// ── Mid-run nudges (v6.5) ────────────────────────────────────────────
export {
    SteerQueue, NextTurnQueue, SteerHook,
    steer, queueMessage,
    drainSteer, drainNextTurn,
    peekSteer, peekNextTurn,
} from "./steer.js";
export type { SteerMessage } from "./steer.js";

// ── Display-layer redaction (v6.5) ───────────────────────────────────
export { redact, redactObj, redactEnv, addPattern } from "./redact.js";

// ── Profile-aware filesystem paths (v6.5) ────────────────────────────
export {
    DEFAULT_PROFILE,
    WORKSPACE_DIRNAME,
    HOME_DIRNAME,
    getClawagentsHome,
    getClawagentsWorkspaceDir,
    getTrajectoriesDir,
    getSessionsDir,
    getLessonsDir,
    displayClawagentsHome,
    displayClawagentsWorkspaceDir,
    listProfiles,
} from "./paths.js";
export type { Scope as ClawagentsPathScope, PathOpts as ClawagentsPathOpts } from "./paths.js";

// ── Auxiliary model registry (v6.5) ──────────────────────────────────
export {
    AuxModelTask,
    AuxModelRegistry,
    coerceAuxSpec,
    withOverrides as withAuxOverrides,
} from "./aux-models.js";
export type { AuxModelSpec } from "./aux-models.js";

// ── Transport abstraction (v6.5) ─────────────────────────────────────
export { Transport, TransportRegistry, LegacyChatTransport } from "./transport.js";
export type { TransportRequest, TransportResponse } from "./transport.js";

// ── Background jobs (v6.5) ───────────────────────────────────────────
export { BackgroundJobManager } from "./background.js";
export type {
    BackgroundJob,
    JobNotifier,
    StartOptions as BackgroundStartOptions,
} from "./background.js";

// ── Browser tools (v6.6) ─────────────────────────────────────────────
// Playwright is an optional peer dependency — `import` works without it,
// only `BrowserSession.start()` throws if the runtime is missing.
export {
    BrowserSession,
    BrowserError,
    ElementNotFoundError,
    MissingPlaywrightError,
    NavigationBlockedError,
    SnapshotError,
    LocalProvider,
    BrowserbaseProviderStub,
    BrowserUseProviderStub,
    getProvider as getBrowserProvider,
    createBrowserTools,
    renderSnapshot,
    MAX_NODES as BROWSER_SNAPSHOT_MAX_NODES,
    resolveBrowserConfig,
    checkUrl as checkBrowserUrl,
} from "./browser/index.js";
export type {
    BrowserConfig,
    ResolvedBrowserConfig,
    BrowserHandle,
    BrowserSnapshot,
    SnapshotElement,
    AxNode,
    CloudBrowserProvider,
    CreateBrowserToolsOptions,
} from "./browser/index.js";

// ── Cron / scheduled jobs (v6.6) ─────────────────────────────────────
// Interval and one-shot schedules work out of the box. Cron expressions
// require the optional `cron-parser` peer (`npm install cron-parser`).
export {
    Scheduler,
    SchedulerError,
    CRONITER_AVAILABLE,
    parseDuration,
    parseSchedule,
    computeNextRun,
    createJob,
    getJob,
    listJobs,
    updateJob,
    pauseJob,
    resumeJob,
    triggerJob,
    removeJob,
    markJobRun,
    advanceNextRun,
    getDueJobs,
    saveJobOutput,
    loadJobs,
    saveJobs,
} from "./cron/index.js";
export type {
    Job,
    JobRepeat,
    JobRunner,
    ParsedSchedule,
    ScheduleKind,
    SchedulerOptions,
    SchedulerStats,
    CreateJobOptions,
    UpdateJobInput,
} from "./cron/index.js";

// ── ACP adapter (v6.6) ───────────────────────────────────────────────
// Bridges a ClawAgents agent to Zed's Agent Client Protocol over stdio.
// Only `AcpServer.serve()` requires the optional
// `@zed-industries/agent-client-protocol` package.
export {
    AcpError,
    MissingAcpDependencyError,
    StopReasonValues,
    agentMessageChunk,
    agentThoughtChunk,
    decodeUpdate,
    encodeUpdate,
    permissionDecisionFromDict,
    promptFromDict,
    promptToDict,
    toolCallStart,
    AgentSession,
    AcpServer,
    ACP_AVAILABLE,
    defaultRunner as acpDefaultRunner,
    serve as acpServe,
} from "./acp/index.js";
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
    PermissionRequester,
    SessionEventSink,
    AgentSessionOptions,
    AcpServerOptions,
    AgentLike as AcpAgentLike,
    PromptRunner,
} from "./acp/index.js";

// ── RL fine-tuning hooks (v6.6) ──────────────────────────────────────
// Capture agent runs as training-ready trajectories and export them to
// TRL / Atropos / SLIME / generic JSONL formats. No training framework
// is imported here — the adapters either produce JSONL (for downstream
// Python trainers) or stream rollouts over HTTP.
export {
    RLError,
    MissingRLDependencyError,
    Trajectory as RLTrajectory,
    trajectoryStep as rlTrajectoryStep,
    toolCall as rlToolCall,
    toolCallToJson as rlToolCallToJson,
    toolCallFromJson as rlToolCallFromJson,
    stepToJson as rlStepToJson,
    stepFromJson as rlStepFromJson,
    RLRecorder,
    containsScorer,
    exactMatchScorer,
    regexScorer,
    lengthPenaltyScorer,
    compositeScorer,
    scoreAll,
    exportJsonl as rlExportJsonl,
    loadJsonl as rlLoadJsonl,
    toChatML as rlToChatML,
    toTrlSft,
    toTrlDpo,
    toAtroposRollout,
    exportTrlSftJsonl,
    exportAtroposRolloutsJsonl,
    TrlAdapter,
    AtroposAdapter,
    toNextStateTransitions,
    TRL_AVAILABLE,
    ATROPOS_AVAILABLE,
    FETCH_AVAILABLE as RL_FETCH_AVAILABLE,
} from "./rl/index.js";
export type {
    TrajectoryRole as RLTrajectoryRole,
    TrajectoryStep as RLTrajectoryStep,
    ToolCall as RLToolCall,
    RecorderConfig as RLRecorderConfig,
    RewardScorer,
    ContainsScorerOptions,
    ExactMatchScorerOptions,
    RegexScorerOptions,
    LengthPenaltyScorerOptions,
    CompositeScorerOptions,
    NextStateTransition,
    AtroposSink,
    AtroposSubmitOptions,
} from "./rl/index.js";
