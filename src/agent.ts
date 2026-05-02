import { LLMProvider } from "./providers/llm.js";
import { Tool, ToolResult, ToolRegistry } from "./tools/registry.js";
import {
    runAgentGraph, AgentState, OnEvent,
    BeforeLLMHook, BeforeToolHook, AfterToolHook,
    AgentLoopExtras,
} from "./graph/agent-loop.js";
import type { LLMMessage } from "./providers/llm.js";
import { existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, getDefaultModel } from "./config/config.js";
import { createProvider } from "./providers/llm.js";
import { loadMemoryFiles } from "./memory/loader.js";
import type { SandboxBackend } from "./sandbox/backend.js";
import { LocalBackend } from "./sandbox/local.js";
import type { Handoff } from "./handoffs.js";
import type { RunContext } from "./run-context.js";
import { appendPromptInjection, buildPromptInjection } from "./prompts/index.js";

// ─── LangChain Tool Adapter ──────────────────────────────────────────────────

export class LangChainToolAdapter implements Tool {
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    private lcTool: any;

    constructor(lcTool: any) {
        this.name = lcTool.name ?? lcTool.constructor?.name ?? "unknown";
        this.description = lcTool.description ?? "";
        this.parameters = this.extractParams(lcTool);
        this.lcTool = lcTool;
    }

    private extractParams(lcTool: any): Record<string, { type: string; description: string; required?: boolean }> {
        try {
            const schema = lcTool.schema?.();
            if (schema?.properties) {
                const required = schema.required ?? [];
                const params: Record<string, { type: string; description: string; required?: boolean }> = {};
                for (const [k, v] of Object.entries(schema.properties as Record<string, any>)) {
                    params[k] = {
                        type: v.type ?? "string",
                        description: v.description ?? "",
                        required: required.includes(k),
                    };
                }
                return params;
            }
        } catch {
            // Schema extraction failed
        }
        return {};
    }

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            let result: unknown;
            if (typeof this.lcTool.ainvoke === "function") {
                result = await this.lcTool.ainvoke(args);
            } else if (typeof this.lcTool.invoke === "function") {
                result = await Promise.resolve(this.lcTool.invoke(args));
            } else {
                result = await Promise.resolve(this.lcTool.run(args));
            }
            return { success: true, output: String(result) };
        } catch (err) {
            return { success: false, output: "", error: String(err) };
        }
    }
}

// ─── ClawAgent ───────────────────────────────────────────────────────────────

export class ClawAgent {
    public llm: LLMProvider;
    public tools: ToolRegistry;
    public systemPrompt?: string;
    public streaming: boolean;
    public useNativeTools: boolean;
    public contextWindow: number;
    public onEvent?: OnEvent;
    public beforeLLM?: BeforeLLMHook;
    public beforeTool?: BeforeToolHook;
    public afterTool?: AfterToolHook;
    public trajectory: boolean;
    public rethink: boolean;
    public learn: boolean;
    public maxIterations: number;
    public previewChars: number;
    public responseChars: number;
    public timeoutS: number;
    public features?: Record<string, boolean>;
    public advisorLLM?: LLMProvider;
    public advisorMaxCalls: number;
    /** Optional list of handoffs surfaced to the LLM as transfer tools. */
    public handoffs: Handoff[];
    /** Optional display name (used as defaults for handoffs and traces). */
    public name?: string;

    /**
     * @param llm - The instantiated LLM provider structure
     * @param tools - The registry containing tool execution interfaces
     * @param systemPrompt - Base instructions controlling agent behavior
     * @param streaming - Send intermediate tokens from the LLM via events
     * @param useNativeTools - Pass tool specifications natively in API payload
     * @param contextWindow - Maximum LLM tokens permitted within history before garbage collection
     * @param features - Dictionary overrides for advanced architectural configurations (e.g. `{ wal: true }`)
     */
    constructor(
        llm: LLMProvider,
        tools: ToolRegistry,
        systemPrompt?: string,
        streaming = true,
        useNativeTools = true,
        contextWindow = 1_000_000,
        onEvent?: OnEvent,
        beforeLLM?: BeforeLLMHook,
        beforeTool?: BeforeToolHook,
        afterTool?: AfterToolHook,
        trajectory = false,
        rethink = false,
        learn = false,
        maxIterations = 200,
        previewChars = 120,
        responseChars = 500,
        timeoutS = 0,
        features?: Record<string, boolean>,
        advisorLLM?: LLMProvider,
        advisorMaxCalls = 3,
        handoffs?: Handoff[],
        name?: string,
    ) {
        this.llm = llm;
        this.tools = tools;
        this.systemPrompt = systemPrompt;
        this.streaming = streaming;
        this.useNativeTools = useNativeTools;
        this.contextWindow = contextWindow;
        this.onEvent = onEvent;
        this.beforeLLM = beforeLLM;
        this.beforeTool = beforeTool;
        this.afterTool = afterTool;
        this.trajectory = trajectory;
        this.rethink = rethink;
        this.learn = learn;
        this.maxIterations = maxIterations;
        this.previewChars = previewChars;
        this.responseChars = responseChars;
        this.timeoutS = timeoutS;
        this.features = features;
        this.advisorLLM = advisorLLM;
        this.advisorMaxCalls = advisorMaxCalls;
        this.handoffs = handoffs ? [...handoffs] : [];
        this.name = name;
    }

    /**
     * Executes the ReAct sequence against the LLM
     * @param task - The query or task formulation provided by the user
     * @param maxIterations - (Optional) override max bounds loops
     * @param onEvent - (Optional) runtime stream callback to track the status changes
     * @param features - (Optional) dictionary matching process.env CLAW_FEATURE flags to override
     */
    async invoke<TContext = unknown>(
        task: string,
        maxIterations?: number,
        onEvent?: OnEvent,
        timeoutS?: number,
        features?: Record<string, boolean>,
        extras?: AgentLoopExtras<TContext>,
    ): Promise<AgentState> {
        // Default handoffs/agentName from the agent unless callers override
        // them in `extras`. Cast handoffs across TContext boundaries —
        // input filters only consume the generic param via `runContext`,
        // which is variant-safe in practice.
        const mergedExtras: AgentLoopExtras<TContext> = {
            ...(extras ?? {}),
            handoffs: (extras?.handoffs ?? this.handoffs) as AgentLoopExtras<TContext>["handoffs"],
            agentName: extras?.agentName ?? this.name,
        };
        return await runAgentGraph<TContext>(
            task,
            this.llm,
            this.tools,
            this.systemPrompt,
            maxIterations ?? this.maxIterations,
            this.streaming,
            this.contextWindow,
            onEvent ?? this.onEvent,
            this.beforeLLM,
            this.beforeTool,
            this.afterTool,
            this.useNativeTools,
            this.trajectory,
            this.rethink,
            this.learn,
            this.previewChars,
            this.responseChars,
            timeoutS ?? this.timeoutS,
            features ?? this.features,
            this.advisorLLM,
            this.advisorMaxCalls,
            mergedExtras,
        );
    }

    /**
     * Expose this agent as a tool callable by another agent.
     *
     * Unlike a {@link Handoff}, the wrapped agent is invoked synchronously
     * inside the parent's tool dispatch: parent calls, child runs, parent
     * resumes. The default output is `state.result` from the child's
     * terminal turn; provide `customOutputExtractor` to project anything
     * from the final {@link AgentState}.
     *
     * When `needsApproval=true` the tool emits an `approval_required`
     * event and waits for the parent's RunContext approval store before
     * running the child.
     */
    asTool(opts: {
        toolName: string;
        toolDescription: string;
        customOutputExtractor?: (state: AgentState) => string;
        needsApproval?: boolean;
    }): Tool {
        const wrapped = this;
        const toolName = opts.toolName;
        const description = opts.toolDescription;
        const extractor = opts.customOutputExtractor;
        const needsApproval = opts.needsApproval ?? false;

        return {
            name: toolName,
            description,
            parameters: {
                task: {
                    type: "string",
                    description: (
                        "The task or question to send to the wrapped agent. " +
                        "The agent receives this as its initial user input."
                    ),
                    required: true,
                },
            },
            async execute(args: Record<string, unknown>, runContext?: RunContext<unknown>): Promise<ToolResult> {
                const task = String(args.task ?? "").trim();
                if (!task) {
                    return {
                        success: false,
                        output: "",
                        error: `${toolName}: missing required 'task' argument`,
                    };
                }
                if (needsApproval && runContext) {
                    const decision = runContext.isToolApproved(toolName, { toolName });
                    if (decision === false) {
                        const rec = runContext.getApproval(toolName, { toolName });
                        const reason = rec?.reason ?? "approval rejected";
                        return { success: false, output: "", error: `${toolName}: ${reason}` };
                    }
                    if (decision === undefined) {
                        return {
                            success: false,
                            output: "",
                            error: (
                                `${toolName}: approval required (use ` +
                                "runContext.approveTool() to allow)"
                            ),
                        };
                    }
                }

                let childState: AgentState;
                try {
                    childState = await wrapped.invoke(task);
                } catch (e) {
                    return { success: false, output: "", error: `${toolName} raised: ${e}` };
                }

                if (extractor) {
                    try {
                        const out = extractor(childState);
                        return { success: true, output: String(out) };
                    } catch (e) {
                        return { success: false, output: "", error: `${toolName}: output extractor raised: ${e}` };
                    }
                }
                return { success: true, output: String(childState.result) };
            },
        };
    }

    // ── Convenience hook methods ──────────────────────────────────────

    /** Block specific tools. Example: agent.blockTools("execute", "write_file") */
    blockTools(...toolNames: string[]): void {
        const blocked = new Set(toolNames);
        this.beforeTool = (name) => !blocked.has(name);
    }

    /** Only allow specific tools. Example: agent.allowOnlyTools("read_file", "ls", "grep") */
    allowOnlyTools(...toolNames: string[]): void {
        const allowed = new Set(toolNames);
        this.beforeTool = (name) => allowed.has(name);
    }

    /** Inject context into every LLM call. Example: agent.injectContext("Respond in Spanish") */
    injectContext(text: string): void {
        const existing = this.beforeLLM;
        this.beforeLLM = (messages) => {
            if (existing) messages = existing(messages);
            return [...messages, { role: "user" as const, content: `[Context] ${text}` }];
        };
    }

    /**
     * Run the task N times and return the best result (GRPO-inspired).
     * Example: const result = await agent.compare("Fix the bug in app.py", 3);
     */
    async compare(
        task: string,
        nSamples = 3,
        maxIterations?: number,
        onEvent?: OnEvent,
    ): Promise<{ bestResult: string; bestScore: number; bestIndex: number; nSamples: number }> {
        const { compareSamples } = await import("./trajectory/compare.js");
        return await compareSamples({
            task,
            llm: this.llm,
            tools: this.tools,
            systemPrompt: this.systemPrompt,
            nSamples,
            maxIterations: maxIterations ?? this.maxIterations,
            streaming: false,
            contextWindow: this.contextWindow,
            onEvent: (onEvent ?? this.onEvent) as any,
            useNativeTools: this.useNativeTools,
            rethink: this.rethink,
            learn: this.learn,
            previewChars: this.previewChars,
            responseChars: this.responseChars,
        });
    }

    /** Truncate tool outputs. Example: agent.truncateOutput(3000) */
    truncateOutput(maxChars = 5000): void {
        this.afterTool = (name, args, result) => {
            if (result.output.length > maxChars) {
                return {
                    success: result.success,
                    output: result.output.slice(0, maxChars) + `\n...(truncated ${result.output.length - maxChars} chars)`,
                    error: result.error,
                };
            }
            return result;
        };
    }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a ClawAgent with full-stack capabilities.
 *
 * @param model       - Model name ("gpt-5", "gemini-3-flash") or LLMProvider. Auto-detects from env if omitted.
 * @param instruction - What the agent should do / how it should behave.
 * @param tools       - Additional tools. Built-in tools always included.
 * @param skills      - Skill directories (default: auto-discovers ./skills). Bundled skills (ByteRover, OpenViking) are always included when eligible.
 * @param memory      - AGENTS.md paths (default: auto-discovers ./AGENTS.md, ./CLAWAGENTS.md).
 * @param features    - Architectural flag overrides (e.g. { micro_compact: false, wal: true })
 *
 * @example
 * ```ts
 * // Zero-config
 * const agent = await createClawAgent({});
 *
 * // Model + instruction
 * const agent = await createClawAgent({ model: "gemini-3-flash", instruction: "Code reviewer" });
 *
 * // Advanced hooks (set after creation):
 * agent.beforeTool = (name, args) => name !== "execute";
 * ```
 */
export async function createClawAgent({
    model,
    profile,
    apiKey,
    baseUrl,
    apiVersion,
    instruction,
    tools,
    skills,
    memory,
    sandbox,
    streaming = true,
    contextWindow,
    maxTokens,
    temperature,
    useNativeTools = true,
    onEvent,
    trajectory,
    rethink,
    learn,
    maxIterations,
    previewChars,
    responseChars,
    timeoutS,
    features,
    fallbackModels,
    advisorModel,
    advisorApiKey,
    advisorMaxCalls,
    mcpServers,
    handoffs,
    name,
    toolDiscovery = true,
    toolDiscoveryMaxResults,
    toolDiscoveryMaxProfile,
}: {
    model?: string | LLMProvider;
    apiKey?: string;
    baseUrl?: string;
    apiVersion?: string;
    instruction?: string;
    tools?: Tool[];
    skills?: string | string[];
    memory?: string | string[];
    sandbox?: SandboxBackend;
    streaming?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    temperature?: number;
    useNativeTools?: boolean;
    onEvent?: OnEvent;
    trajectory?: boolean;
    rethink?: boolean;
    learn?: boolean;
    maxIterations?: number;
    previewChars?: number;
    responseChars?: number;
    timeoutS?: number;
    features?: Record<string, boolean>;
    /** Optional fallback LLM providers. When the primary provider fails, these are tried in order. */
    fallbackModels?: LLMProvider[];
    /** A stronger model to consult for strategic guidance (2-3 times per task). Cross-provider supported. */
    advisorModel?: string | LLMProvider;
    /** API key for the advisor model (only needed if it's a different provider). */
    advisorApiKey?: string;
    /** Max advisor consultations per task (default: 3). */
    advisorMaxCalls?: number;
    /** Optional named provider profile. Explicit model/apiKey/baseUrl args override profile values. */
    profile?: string;
    /**
     * Optional list of MCP (Model Context Protocol) servers. Each server is
     * connected, its tools are discovered and bridged into the ToolRegistry,
     * and the agent gets a ``mcpManager`` reference for explicit shutdown.
     * Requires the optional ``@modelcontextprotocol/sdk`` peer dep.
     */
    mcpServers?: import("./mcp/server.js").MCPServer[];
    /** Handoff descriptors surfaced to the LLM as ``transfer_to_<name>`` tools. */
    handoffs?: Handoff[];
    /** Agent display name (used for handoff defaults and tracing). */
    name?: string;
    /** Register compact tool discovery helpers by default. */
    toolDiscovery?: boolean;
    /** Default result cap for tool_discover. */
    toolDiscoveryMaxResults?: number;
    /** Maximum profile exposed through discovery helpers. */
    toolDiscoveryMaxProfile?: "minimal" | "read-only" | "write" | "full";
} = {}): Promise<ClawAgent> {
    // ── Resolve opt-in flags ─────────────────────────────────────────
    const envTrue = (key: string) => ["1", "true", "yes"].includes(
        (process.env[key] ?? "").toLowerCase(),
    );
    const envInt = (key: string, fallback: number) => {
        const raw = process.env[key];
        if (raw && /^\d+$/.test(raw)) return parseInt(raw, 10);
        return fallback;
    };
    const enableLearn = learn ?? envTrue("CLAW_LEARN");
    let enableTrajectory = trajectory ?? envTrue("CLAW_TRAJECTORY");
    if (enableLearn) enableTrajectory = true;
    const enableRethink = rethink ?? envTrue("CLAW_RETHINK");
    const resolvedMaxIterations = maxIterations ?? envInt("MAX_ITERATIONS", 200);
    const resolvedPreviewChars = previewChars ?? envInt("CLAW_PREVIEW_CHARS", 120);
    const resolvedResponseChars = responseChars ?? envInt("CLAW_RESPONSE_CHARS", 500);
    const resolvedTimeoutS = timeoutS ?? envInt("CLAW_TIMEOUT", 0);

    // ── Resolve optional provider profile before model construction ──
    if (profile) {
        const { resolveProviderProfile } = await import("./provider-profiles.js");
        const resolvedProfile = resolveProviderProfile(profile, {
            model: typeof model === "string" ? model : undefined,
            apiKey,
            baseUrl,
            apiVersion,
        });
        if (typeof model === "string" || model === undefined) model = resolvedProfile.model;
        apiKey = resolvedProfile.apiKey;
        baseUrl = resolvedProfile.baseUrl;
        apiVersion = resolvedProfile.apiVersion;
    }

    // ── Resolve model → LLMProvider ──────────────────────────────────
    let llm: LLMProvider = await resolveModel(model, streaming, apiKey, contextWindow, maxTokens, temperature, baseUrl, apiVersion);
    if (fallbackModels && fallbackModels.length > 0) {
        const { FallbackProvider } = await import("./providers/fallback.js");
        llm = new FallbackProvider(llm, fallbackModels);
    }

    // ── Resolve advisor model ────────────────────────────────────────
    let resolvedAdvisorLLM: LLMProvider | undefined;
    const resolvedAdvisorMaxCalls = advisorMaxCalls ?? envInt("ADVISOR_MAX_CALLS", 3);
    {
        const advisorSpec = advisorModel ?? (process.env["ADVISOR_MODEL"] || undefined);
        if (advisorSpec) {
            const advKey = advisorApiKey ?? (process.env["ADVISOR_API_KEY"] || undefined);
            resolvedAdvisorLLM = await resolveModel(advisorSpec, streaming, advKey, contextWindow);
        }
    }

    // ── Resolve sandbox backend ──────────────────────────────────────
    const sb = sandbox ?? new LocalBackend();

    const registry = new ToolRegistry();

    // ── Built-in tools (lazy where possible) ──────────────────────
    // Sandbox-backed tools use LazyTool: schema is available immediately
    // for the LLM, but the module + sandbox init happens on first execute().
    const { LazyFactoryTool } = await import("./tools/registry.js");

    // Eager: cheap, no dependencies
    const { todolistTools } = await import("./tools/todolist.js");
    const { thinkTools } = await import("./tools/think.js");
    const { interactiveTools } = await import("./tools/interactive.js");
    for (const tool of [...todolistTools, ...thinkTools, ...interactiveTools]) {
        registry.register(tool);
    }

    // Lazy: sandbox-backed tools (filesystem, exec, advanced-fs, web).
    // Schema is copied from the concrete tool implementation so lazy/native
    // schemas cannot drift from the backing tools.
    const { createFilesystemTools } = await import("./tools/filesystem.js");
    for (const spec of createFilesystemTools(sb)) {
        registry.register(new LazyFactoryTool(spec.name, spec.description, spec.parameters, async () => {
            const tools = createFilesystemTools(sb);
            return tools.find((t) => t.name === spec.name)!;
        }, spec.keywords));
    }

    const { createExecTools } = await import("./tools/exec.js");
    for (const spec of createExecTools(sb)) {
        registry.register(new LazyFactoryTool(spec.name, spec.description, spec.parameters, async () => {
            const tools = createExecTools(sb);
            return tools.find((t) => t.name === spec.name)!;
        }, spec.keywords));
    }

    const { createAdvancedFsTools } = await import("./tools/advanced-fs.js");
    for (const spec of createAdvancedFsTools(sb)) {
        registry.register(new LazyFactoryTool(spec.name, spec.description, spec.parameters, async () => {
            const tools = createAdvancedFsTools(sb);
            return tools.find((t) => t.name === spec.name)!;
        }, spec.keywords));
    }

    const { webTools } = await import("./tools/web.js");
    const webFetchSpec = webTools.find((t) => t.name === "web_fetch")!;
    registry.register(new LazyFactoryTool(webFetchSpec.name, webFetchSpec.description, webFetchSpec.parameters, async () => {
        const { webTools: resolvedWebTools } = await import("./tools/web.js");
        return resolvedWebTools.find((t) => t.name === "web_fetch")!;
    }, webFetchSpec.keywords));

    // ── Adapt and register user-provided tools ───────────────────────
    if (tools) {
        for (const tool of tools) {
            if (typeof (tool as any).ainvoke === "function" && typeof tool.execute !== "function") {
                registry.register(new LangChainToolAdapter(tool));
            } else {
                registry.register(tool);
            }
        }
    }

    // ── Auto-discover skills from default locations ────────────────────
    const baseSkillDirs = skills !== undefined ? toList(skills) : autoDiscoverSkills();
    const bundledSkillsDir = getBundledSkillsDir();
    const skillDirs =
        bundledSkillsDir && existsSync(bundledSkillsDir)
            ? [...baseSkillDirs, bundledSkillsDir]
            : baseSkillDirs;
    let skillSummaries: string | null = null;

    if (skillDirs.length > 0) {
        const { SkillStore, createSkillTools } = await import("./tools/skills.js");
        const skillStore = new SkillStore();

        for (const dir of skillDirs) {
            if (existsSync(dir)) {
                skillStore.addDirectory(dir);
            }
        }

        await skillStore.loadAll();

        const loaded = skillStore.list();
        if (loaded.length > 0) {
            const lines = loaded.map((s: any) => `- **${s.name}**: ${s.description || "(no description)"}`);
            skillSummaries = "## Available Skills\nUse the `use_skill` tool to load full instructions.\n" + lines.join("\n");
        }

        // Skill prompt budget limits
        const MAX_SKILLS_PROMPT_CHARS = 4000;
        const MAX_SKILLS_IN_PROMPT = 20;

        if (skillSummaries) {
            const skillLines = skillSummaries.split("\n").filter(l => l.startsWith("- **"));
            if (skillLines.length > MAX_SKILLS_IN_PROMPT) {
                const truncated = skillLines.slice(0, MAX_SKILLS_IN_PROMPT);
                skillSummaries = "## Available Skills\nUse the `use_skill` tool to load full instructions.\n" +
                    truncated.join("\n") + `\n\n(${skillLines.length - MAX_SKILLS_IN_PROMPT} more skills available — use list_skills to see all)`;
            }
            if (skillSummaries.length > MAX_SKILLS_PROMPT_CHARS) {
                skillSummaries = skillSummaries.slice(0, MAX_SKILLS_PROMPT_CHARS) +
                    "\n\n...(skill list truncated — use list_skills to see all)";
            }
        }

        for (const skillTool of createSkillTools(skillStore)) {
            if (skillTool.name === "use_skill") {
                registry.register(skillTool);
            }
        }
    }

    // ── Auto-discover memory from default locations ──────────────────
    const memoryPaths = memory !== undefined ? toList(memory) : autoDiscoverMemory();
    const composedBeforeLLM = composeBeforeLLM(memoryPaths, skillSummaries);

    // Resolve context_window from config if not provided
    const resolvedContextWindow = contextWindow ?? loadConfig().contextWindow;

    const agent = new ClawAgent(
        llm, registry, instruction, streaming, useNativeTools, resolvedContextWindow, onEvent,
        composedBeforeLLM ?? undefined, undefined, undefined, enableTrajectory, enableRethink,
        enableLearn, resolvedMaxIterations, resolvedPreviewChars, resolvedResponseChars,
        resolvedTimeoutS, features, resolvedAdvisorLLM, resolvedAdvisorMaxCalls,
        handoffs, name,
    );

    const { createBackgroundTaskTools } = await import("./tools/background-task.js");
    for (const taskTool of createBackgroundTaskTools()) {
        registry.register(taskTool);
    }

    const { createToolProgramTool } = await import("./tools/tool-program.js");
    registry.register(createToolProgramTool(registry));

    // ── Sub-agent tool (always available) ────────────────────────────
    const { createTaskTool } = await import("./tools/subagent.js");
    registry.register(createTaskTool(llm, registry));

    // ── MCP server integration (v6.4, optional) ──────────────────────
    if (mcpServers && mcpServers.length > 0) {
        const { isMCPSdkAvailable, MCPServerManager } = await import("./mcp/index.js");
        if (!(await isMCPSdkAvailable())) {
            throw new Error(
                "createClawAgent received mcpServers= but the optional " +
                "@modelcontextprotocol/sdk package is not installed. " +
                "Install it with: npm install @modelcontextprotocol/sdk",
            );
        }
        const manager = new MCPServerManager(mcpServers);
        await manager.start(registry);
        // Expose the manager so callers can shutdown explicitly.
        (agent as unknown as { mcpManager?: unknown }).mcpManager = manager;
        const { createMcpAuthTool } = await import("./tools/mcp-auth.js");
        registry.register(createMcpAuthTool(manager));
    }

    // Compact discovery is registered last so it can see user, subagent, and MCP tools.
    if (toolDiscovery) {
        const { createToolDiscoveryTools } = await import("./tools/catalog.js");
        for (const discoveryTool of createToolDiscoveryTools(registry, {
            maxResults: toolDiscoveryMaxResults,
            maxProfile: toolDiscoveryMaxProfile,
        })) {
            if (!registry.get(discoveryTool.name)) registry.register(discoveryTool);
        }
    }

    return agent;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

async function resolveModel(
    model: string | LLMProvider | undefined,
    streaming: boolean,
    apiKey?: string,
    contextWindow?: number,
    maxTokens?: number,
    temperature?: number,
    baseUrl?: string,
    apiVersion?: string,
): Promise<LLMProvider> {
    if (model && typeof model !== "string") {
        return model;
    }

    const config = loadConfig();
    config.streaming = streaming;
    if (contextWindow !== undefined) config.contextWindow = contextWindow;
    if (maxTokens !== undefined) config.maxTokens = maxTokens;
    if (temperature !== undefined) config.temperature = temperature;
    if (baseUrl !== undefined) config.openaiBaseUrl = baseUrl;
    if (apiVersion !== undefined) config.openaiApiVersion = apiVersion;

    const activeModel = (typeof model === "string" && model) ? model : getDefaultModel(config);

    // Override the appropriate API key if provided.
    // Route by model family so a single `apiKey` parameter targets the
    // correct provider config field. Without this, e.g. a Claude key
    // silently lands in `openaiApiKey` and the Anthropic provider falls
    // back to the env var.
    if (apiKey) {
        const lower = activeModel.toLowerCase();
        if (lower.startsWith("gemini")) {
            config.geminiApiKey = apiKey;
        } else if (lower.startsWith("claude") || lower.startsWith("anthropic")) {
            config.anthropicApiKey = apiKey;
        } else {
            config.openaiApiKey = apiKey;
        }
    }

    return await createProvider(activeModel, config);
}

function toList(value: string | string[] | undefined): string[] {
    if (!value) return [];
    if (typeof value === "string") return [value];
    return value;
}

// Default locations for auto-discovery
const DEFAULT_MEMORY_FILES = ["AGENTS.md", "CLAWAGENTS.md"];
const DEFAULT_SKILL_DIRS = ["skills", ".skills", "skill", ".skill", "Skills"];

/** Path to all bundled skills (byterover, openviking, etc.). */
function getBundledSkillsDir(): string {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const bundledInDist = resolve(__dirname, "skills");
    if (existsSync(bundledInDist)) return bundledInDist;
    return resolve(__dirname, "..", "skills");
}

function autoDiscoverMemory(): string[] {
    const cwd = process.cwd();
    const found: string[] = [];
    for (const name of DEFAULT_MEMORY_FILES) {
        const p = resolve(cwd, name);
        if (existsSync(p)) {
            try {
                if (statSync(p).isFile()) found.push(p);
            } catch { /* ignore */ }
        }
    }
    return found;
}

function autoDiscoverSkills(): string[] {
    const cwd = process.cwd();
    const found: string[] = [];
    for (const name of DEFAULT_SKILL_DIRS) {
        const p = resolve(cwd, name);
        if (existsSync(p)) {
            try {
                if (statSync(p).isDirectory()) found.push(p);
            } catch { /* ignore */ }
        }
    }
    return found;
}

function composeBeforeLLM(
    memoryPaths: string[],
    skillSummaries: string | null,
): BeforeLLMHook | null {
    let memoryContent: string | null = null;
    if (memoryPaths.length > 0) {
        memoryContent = loadMemoryFiles(memoryPaths);
    }

    if (!memoryContent && !skillSummaries) return null;
    const injection = buildPromptInjection({ memoryContent, skillSummaries });

    return (messages: LLMMessage[]): LLMMessage[] => {
        return appendPromptInjection(messages, injection);
    };
}
