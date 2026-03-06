import { LLMProvider } from "./providers/llm.js";
import { Tool, ToolResult, ToolRegistry } from "./tools/registry.js";
import {
    runAgentGraph, AgentState, OnEvent,
    BeforeLLMHook, BeforeToolHook, AfterToolHook,
} from "./graph/agent-loop.js";
import type { LLMMessage } from "./providers/llm.js";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, getDefaultModel } from "./config/config.js";
import { createProvider } from "./providers/llm.js";
import { loadMemoryFiles } from "./memory/loader.js";
import type { SandboxBackend } from "./sandbox/backend.js";
import { LocalBackend } from "./sandbox/local.js";

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
    }

    async invoke(task: string, maxIterations?: number, onEvent?: OnEvent): Promise<AgentState> {
        return await runAgentGraph(
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
        );
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
 * @param skills      - Skill directories (default: auto-discovers ./skills).
 * @param memory      - AGENTS.md paths (default: auto-discovers ./AGENTS.md, ./CLAWAGENTS.md).
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
    apiKey,
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
}: {
    model?: string | LLMProvider;
    apiKey?: string;
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

    // ── Resolve model → LLMProvider ──────────────────────────────────
    const llm = resolveModel(model, streaming, apiKey, contextWindow, maxTokens, temperature);

    // ── Resolve sandbox backend ──────────────────────────────────────
    const sb = sandbox ?? new LocalBackend();

    const registry = new ToolRegistry();

    // ── Built-in tools (backed by sandbox) ───────────────────────────
    const { createFilesystemTools } = await import("./tools/filesystem.js");
    const { createExecTools } = await import("./tools/exec.js");
    const { createAdvancedFsTools } = await import("./tools/advanced-fs.js");
    const { todolistTools } = await import("./tools/todolist.js");
    const { thinkTools } = await import("./tools/think.js");
    const { webTools } = await import("./tools/web.js");
    const { interactiveTools } = await import("./tools/interactive.js");

    for (const tool of [
        ...createFilesystemTools(sb), ...createExecTools(sb), ...todolistTools,
        ...thinkTools, ...webTools, ...createAdvancedFsTools(sb), ...interactiveTools,
    ]) {
        registry.register(tool);
    }

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
    const skillDirs = skills !== undefined ? toList(skills) : autoDiscoverSkills();
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
    );

    // ── Sub-agent tool (always available) ────────────────────────────
    const { createTaskTool } = await import("./tools/subagent.js");
    registry.register(createTaskTool(llm, registry));

    return agent;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function resolveModel(
    model: string | LLMProvider | undefined,
    streaming: boolean,
    apiKey?: string,
    contextWindow?: number,
    maxTokens?: number,
    temperature?: number,
): LLMProvider {
    if (model && typeof model !== "string") {
        return model;
    }

    const config = loadConfig();
    config.streaming = streaming;
    if (contextWindow !== undefined) config.contextWindow = contextWindow;
    if (maxTokens !== undefined) config.maxTokens = maxTokens;
    if (temperature !== undefined) config.temperature = temperature;

    const activeModel = (typeof model === "string" && model) ? model : getDefaultModel(config);

    // Override the appropriate API key if provided
    if (apiKey) {
        if (activeModel.toLowerCase().startsWith("gemini")) {
            config.geminiApiKey = apiKey;
        } else {
            config.openaiApiKey = apiKey;
        }
    }

    return createProvider(activeModel, config);
}

function toList(value: string | string[] | undefined): string[] {
    if (!value) return [];
    if (typeof value === "string") return [value];
    return value;
}

// Default locations for auto-discovery
const DEFAULT_MEMORY_FILES = ["AGENTS.md", "CLAWAGENTS.md"];
const DEFAULT_SKILL_DIRS = ["skills", ".skills", "skill", ".skill", "Skills"];

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

    return (messages: LLMMessage[]): LLMMessage[] => {
        const injectParts: string[] = [];
        if (memoryContent) injectParts.push(memoryContent);
        if (skillSummaries) injectParts.push(skillSummaries);

        if (injectParts.length > 0) {
            const result = [...messages];
            for (let i = 0; i < result.length; i++) {
                if (result[i]!.role === "system") {
                    result[i] = {
                        role: "system",
                        content: result[i]!.content + "\n\n" + injectParts.join("\n\n"),
                    };
                    break;
                }
            }
            return result;
        }

        return messages;
    };
}
