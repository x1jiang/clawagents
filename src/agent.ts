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
    public onEvent?: OnEvent;
    public beforeLLM?: BeforeLLMHook;
    public beforeTool?: BeforeToolHook;
    public afterTool?: AfterToolHook;

    constructor(
        llm: LLMProvider,
        tools: ToolRegistry,
        systemPrompt?: string,
        streaming = true,
        useNativeTools = false,
        onEvent?: OnEvent,
        beforeLLM?: BeforeLLMHook,
        beforeTool?: BeforeToolHook,
        afterTool?: AfterToolHook,
    ) {
        this.llm = llm;
        this.tools = tools;
        this.systemPrompt = systemPrompt;
        this.streaming = streaming;
        this.useNativeTools = useNativeTools;
        this.onEvent = onEvent;
        this.beforeLLM = beforeLLM;
        this.beforeTool = beforeTool;
        this.afterTool = afterTool;
    }

    async invoke(task: string, maxIterations = 15, onEvent?: OnEvent): Promise<AgentState> {
        return await runAgentGraph(
            task,
            this.llm,
            this.tools,
            this.systemPrompt,
            maxIterations,
            this.streaming,
            128_000,
            onEvent ?? this.onEvent,
            this.beforeLLM,
            this.beforeTool,
            this.afterTool,
            this.useNativeTools,
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
    streaming = true,
    contextWindow = 128_000,
    maxTokens = 8192,
    useNativeTools = false,
    onEvent,
}: {
    model?: string | LLMProvider;
    apiKey?: string;
    instruction?: string;
    tools?: Tool[];
    skills?: string | string[];
    memory?: string | string[];
    streaming?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    useNativeTools?: boolean;
    onEvent?: OnEvent;
} = {}): Promise<ClawAgent> {
    // ── Resolve model → LLMProvider ──────────────────────────────────
    const llm = resolveModel(model, streaming, apiKey, contextWindow, maxTokens);

    const registry = new ToolRegistry();

    // ── Built-in tools (always available) ────────────────────────────
    const { filesystemTools } = await import("./tools/filesystem.js");
    const { execTools } = await import("./tools/exec.js");
    const { todolistTools } = await import("./tools/todolist.js");

    for (const tool of [...filesystemTools, ...execTools, ...todolistTools]) {
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

    const agent = new ClawAgent(
        llm, registry, instruction, streaming, useNativeTools, onEvent,
        composedBeforeLLM ?? undefined,
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
): LLMProvider {
    if (model && typeof model !== "string") {
        return model;
    }

    const config = loadConfig();
    config.streaming = streaming;
    if (contextWindow !== undefined) config.contextWindow = contextWindow;
    if (maxTokens !== undefined) config.maxTokens = maxTokens;

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
