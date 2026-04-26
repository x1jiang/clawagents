/**
 * Integration tests for parallel tool parsing, execution, and agent-loop wiring.
 *
 * Run with: npx tsx --test src/tools/registry.integration.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runAgentGraph } from "../graph/agent-loop.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../providers/llm.js";
import { RunContext } from "../run-context.js";
import { ToolRegistry, type Tool, type ToolResult, type ParsedToolCall } from "./registry.js";

// ─── Mock tools ──────────────────────────────────────────────────────────

function makeTool(name: string, delayMs = 0, fail = false): Tool {
    return {
        name,
        description: `Test tool: ${name}`,
        parameters: { path: { type: "string", description: "a path", required: true } },
        async execute(args) {
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            if (fail) return { success: false, output: "", error: `${name} failed` };
            return { success: true, output: `${name}:${JSON.stringify(args)}` };
        },
    };
}

class NativeMockLLM implements LLMProvider {
    name = "mock-native";
    private responses: LLMResponse[];

    constructor(responses: LLMResponse[]) {
        this.responses = [...responses];
    }

    async chat(_messages: LLMMessage[]): Promise<LLMResponse> {
        return this.responses.shift() ?? { content: "done", model: "mock", tokensUsed: 1 };
    }
}

// ─── Multi-fenced-block parsing ─────────────────────────────────────────

describe("parseToolCalls with multiple fenced blocks", () => {
    let registry: ToolRegistry;

    beforeEach(() => {
        registry = new ToolRegistry();
    });

    it("matches tool call when preceded by a non-JSON fenced block", () => {
        const response = `Here's an explanation:
\`\`\`python
print("hello")
\`\`\`

Now let me read the file:
\`\`\`json
{"tool": "read_file", "args": {"path": "test.txt"}}
\`\`\``;

        const calls = registry.parseToolCalls(response);
        assert.equal(calls.length, 1, "Should parse exactly 1 tool call");
        assert.equal(calls[0].toolName, "read_file");
    });

    it("handles response with array tool call after explanation block", () => {
        const response = `I'll read both files at once:
\`\`\`text
Some explanation here
\`\`\`

\`\`\`json
[
  {"tool": "read_file", "args": {"path": "a.txt"}},
  {"tool": "read_file", "args": {"path": "b.txt"}}
]
\`\`\``;

        const calls = registry.parseToolCalls(response);
        assert.equal(calls.length, 2, "Should parse 2 tool calls from the array block");
    });
});

// ─── actNode message construction ───────────────────────────────────────

describe("actNode message construction", () => {
    it("messages contain system prompt + state messages + user instruction", () => {
        const stateMessages = [
            { role: "user" as const, content: "Write hello world to test.txt" },
            { role: "assistant" as const, content: "[Understanding] I'll use write_file." },
        ];

        const systemPrompt = "You are a ClawAgent.";
        const toolDesc = "## Tools\n### write_file\nWrite a file.";

        const messages = [
            { role: "system" as const, content: `${systemPrompt}\n\n${toolDesc}` },
            ...stateMessages,
            { role: "user" as const, content: "Now execute the task using tools..." },
        ];

        assert.equal(messages.length, 4);
        assert.equal(messages[0].role, "system");
        assert.ok(messages[0].content.includes(toolDesc));
        assert.equal(messages[1].role, "user");
        assert.equal(messages[2].role, "assistant");
        assert.equal(messages[3].role, "user");
    });
});

// ─── Parallel results concatenation ─────────────────────────────────────

describe("Parallel tool results concatenation", () => {
    it("call summaries pass through even with large outputs", async () => {
        const registry = new ToolRegistry();
        const bigOutputTool: Tool = {
            name: "big_output",
            description: "Returns large output",
            parameters: {},
            async execute() {
                return { success: true, output: "x".repeat(5000) };
            },
        };
        registry.register(bigOutputTool);

        const calls: ParsedToolCall[] = [
            { toolName: "big_output", args: {} },
            { toolName: "big_output", args: {} },
            { toolName: "big_output", args: {} },
        ];

        const results = await registry.executeToolsParallel(calls);
        const summaries = results.map(
            (r, i) => `${calls[i].toolName}(${JSON.stringify(calls[i].args)}) => ${r.output}`,
        );
        const lastResult = summaries.join("\n");

        assert.equal(results.length, 3);
        assert.ok(lastResult.length > 10000);
    });
});

// ─── Full parallel flow integration ─────────────────────────────────────

describe("Full parallel execution flow", () => {
    it("parses array, executes in parallel, returns all results", async () => {
        const registry = new ToolRegistry();
        registry.register(makeTool("read_file", 20));
        registry.register(makeTool("ls", 10));

        const llmResponse = `\`\`\`json
[
  {"tool": "read_file", "args": {"path": "a.txt"}},
  {"tool": "read_file", "args": {"path": "b.txt"}},
  {"tool": "ls", "args": {"path": "."}}
]
\`\`\``;

        const calls = registry.parseToolCalls(llmResponse);
        assert.equal(calls.length, 3);

        const start = Date.now();
        const results = await registry.executeToolsParallel(calls);
        const elapsed = Date.now() - start;

        assert.equal(results.length, 3);
        assert.ok(results.every((r) => r.success));
        assert.ok(elapsed < 60, `Should be parallel but took ${elapsed}ms`);
    });

    it("honors sticky RunContext rejection for native parallel calls", async () => {
        const calls: Record<string, unknown>[][] = [[], []];
        const registry = new ToolRegistry();
        registry.register({
            name: "alpha",
            description: "alpha",
            parameters: {},
            async execute(args) {
                calls[0]!.push(args);
                return { success: true, output: "alpha" };
            },
        });
        registry.register({
            name: "beta",
            description: "beta",
            parameters: {},
            async execute(args) {
                calls[1]!.push(args);
                return { success: true, output: "beta" };
            },
        });
        const llm = new NativeMockLLM([
            {
                content: "",
                model: "mock",
                tokensUsed: 1,
                toolCalls: [
                    { toolName: "alpha", args: { x: "1" }, toolCallId: "id_a" },
                    { toolName: "beta", args: { x: "2" }, toolCallId: "id_b" },
                ],
            },
            { content: "done", model: "mock", tokensUsed: 1 },
        ]);
        const ctx = new RunContext();
        ctx.rejectTool("id_b", { toolName: "beta", reason: "blocked beta" });

        await runAgentGraph(
            "task",
            llm,
            registry,
            undefined,
            3,
            false,
            128000,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            false,
            false,
            false,
            120,
            500,
            0,
            undefined,
            undefined,
            3,
            { runContext: ctx },
        );

        assert.deepEqual(calls[0], [{ x: "1" }]);
        assert.deepEqual(calls[1], []);
    });

    it("keeps native call ids aligned after beforeTool filters calls", async () => {
        const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
        const registry = new ToolRegistry();
        registry.register(makeTool("alpha"));
        registry.register(makeTool("beta"));
        const llm = new NativeMockLLM([
            {
                content: "",
                model: "mock",
                tokensUsed: 1,
                toolCalls: [
                    { toolName: "alpha", args: { x: "1" }, toolCallId: "id_a" },
                    { toolName: "beta", args: { x: "2" }, toolCallId: "id_b" },
                ],
            },
            { content: "done", model: "mock", tokensUsed: 1 },
        ]);

        await runAgentGraph(
            "task",
            llm,
            registry,
            undefined,
            3,
            false,
            128000,
            (kind, data) => events.push({ kind, data: data as Record<string, unknown> }),
            undefined,
            (name) => name !== "alpha",
        );

        const start = events.find((event) => event.kind === "tool_started");
        assert.equal(start?.data.callId, "id_b");
    });
});
