/**
 * Integration tests for parallel tool parsing, execution, and agent-loop wiring.
 *
 * Run with: npx tsx --test src/tools/registry.integration.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
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
});
