/**
 * Unit tests for ToolRegistry — parallel tool parsing & execution.
 * Run with: npx tsx --test src/tools/registry.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, type Tool, type ToolResult } from "./registry.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTool(name: string, delayMs = 0, fail = false): Tool {
    return {
        name,
        description: `Test tool: ${name}`,
        parameters: {},
        async execute(args: Record<string, unknown>): Promise<ToolResult> {
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            if (fail) return { success: false, output: "", error: `${name} failed` };
            return { success: true, output: `${name}:${JSON.stringify(args)}` };
        },
    };
}

// ─── parseToolCalls ──────────────────────────────────────────────────────

describe("parseToolCalls", () => {
    let registry: ToolRegistry;

    beforeEach(() => {
        registry = new ToolRegistry();
    });

    it("parses a single tool call in fenced JSON", () => {
        const response = '```json\n{"tool": "read_file", "args": {"path": "a.txt"}}\n```';
        const calls = registry.parseToolCalls(response);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].toolName, "read_file");
        assert.deepEqual(calls[0].args, { path: "a.txt" });
    });

    it("parses a single tool call as bare JSON", () => {
        const response = '{"tool": "ls", "args": {"dir": "."}}';
        const calls = registry.parseToolCalls(response);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].toolName, "ls");
    });

    it("parses an array of tool calls in fenced JSON", () => {
        const response = `\`\`\`json
[
  {"tool": "read_file", "args": {"path": "a.txt"}},
  {"tool": "read_file", "args": {"path": "b.txt"}},
  {"tool": "ls", "args": {"dir": "src"}}
]
\`\`\``;
        const calls = registry.parseToolCalls(response);
        assert.equal(calls.length, 3);
        assert.equal(calls[0].toolName, "read_file");
        assert.equal(calls[1].toolName, "read_file");
        assert.equal(calls[2].toolName, "ls");
        assert.deepEqual(calls[2].args, { dir: "src" });
    });

    it("parses an array of tool calls as bare JSON", () => {
        const response =
            '[{"tool": "write_file", "args": {"path": "x.txt", "content": "hello"}}, {"tool": "ls"}]';
        const calls = registry.parseToolCalls(response);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].toolName, "write_file");
        assert.equal(calls[1].toolName, "ls");
        assert.deepEqual(calls[1].args, {});
    });

    it("returns empty array for non-JSON response", () => {
        const calls = registry.parseToolCalls("I think we should read the file first.");
        assert.equal(calls.length, 0);
    });

    it("returns empty array for JSON without tool key", () => {
        const calls = registry.parseToolCalls('{"action": "read", "file": "a.txt"}');
        assert.equal(calls.length, 0);
    });

    it("filters invalid entries in an array", () => {
        const response =
            '[{"tool": "ls", "args": {}}, {"not_a_tool": true}, {"tool": "read_file", "args": {"path": "x"}}]';
        const calls = registry.parseToolCalls(response);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].toolName, "ls");
        assert.equal(calls[1].toolName, "read_file");
    });

    it("parseToolCall (legacy) returns first call", () => {
        const response =
            '[{"tool": "ls", "args": {}}, {"tool": "read_file", "args": {"path": "x"}}]';
        const call = registry.parseToolCall(response);
        assert.ok(call);
        assert.equal(call.toolName, "ls");
    });

    it("parseToolCall returns null for no-tool response", () => {
        const call = registry.parseToolCall("Just text, no tool calls");
        assert.equal(call, null);
    });
});

// ─── executeToolsParallel ────────────────────────────────────────────────

describe("executeToolsParallel", () => {
    let registry: ToolRegistry;

    beforeEach(() => {
        registry = new ToolRegistry();
        registry.register(makeTool("fast_tool", 10));
        registry.register(makeTool("slow_tool", 50));
        registry.register(makeTool("fail_tool", 0, true));
    });

    it("executes a single call (no concurrency overhead)", async () => {
        const results = await registry.executeToolsParallel([
            { toolName: "fast_tool", args: { x: 1 } },
        ]);
        assert.equal(results.length, 1);
        assert.equal(results[0].success, true);
        assert.ok(results[0].output.includes("fast_tool"));
    });

    it("returns empty array for empty input", async () => {
        const results = await registry.executeToolsParallel([]);
        assert.equal(results.length, 0);
    });

    it("executes multiple calls in parallel", async () => {
        const start = Date.now();
        const results = await registry.executeToolsParallel([
            { toolName: "fast_tool", args: { a: 1 } },
            { toolName: "slow_tool", args: { b: 2 } },
            { toolName: "fast_tool", args: { c: 3 } },
        ]);
        const elapsed = Date.now() - start;

        assert.equal(results.length, 3);
        assert.equal(results[0].success, true);
        assert.equal(results[1].success, true);
        assert.equal(results[2].success, true);

        // If truly parallel, total time should be closer to max(50) than sum(10+50+10=70)
        assert.ok(elapsed < 120, `Expected parallel execution, but took ${elapsed}ms`);
    });

    it("preserves order even when tools finish at different times", async () => {
        const results = await registry.executeToolsParallel([
            { toolName: "slow_tool", args: { order: "first" } },
            { toolName: "fast_tool", args: { order: "second" } },
        ]);
        assert.equal(results.length, 2);
        assert.ok(results[0].output.includes("slow_tool"));
        assert.ok(results[1].output.includes("fast_tool"));
    });

    it("handles failures without crashing other calls", async () => {
        const results = await registry.executeToolsParallel([
            { toolName: "fast_tool", args: {} },
            { toolName: "fail_tool", args: {} },
            { toolName: "fast_tool", args: {} },
        ]);
        assert.equal(results.length, 3);
        assert.equal(results[0].success, true);
        assert.equal(results[1].success, false);
        assert.ok(results[1].error?.includes("fail_tool failed"));
        assert.equal(results[2].success, true);
    });

    it("handles unknown tool names gracefully", async () => {
        const results = await registry.executeToolsParallel([
            { toolName: "nonexistent_tool", args: {} },
            { toolName: "fast_tool", args: {} },
        ]);
        assert.equal(results.length, 2);
        assert.equal(results[0].success, false);
        assert.ok(results[0].error?.includes("Unknown tool"));
        assert.equal(results[1].success, true);
    });
});

// ─── describeForLLM ──────────────────────────────────────────────────────

describe("describeForLLM", () => {
    it("includes parallel array syntax in the description", () => {
        const registry = new ToolRegistry();
        registry.register(makeTool("ls"));
        const desc = registry.describeForLLM();
        assert.ok(desc.includes("multiple independent"));
        assert.ok(desc.includes("array"));
        assert.ok(desc.includes("parallel"));
    });

    it("returns empty string for empty registry", () => {
        const registry = new ToolRegistry();
        assert.equal(registry.describeForLLM(), "");
    });
});

// ─── executeTool (single) ────────────────────────────────────────────────

describe("executeTool", () => {
    it("executes a registered tool", async () => {
        const registry = new ToolRegistry();
        registry.register(makeTool("echo"));
        const result = await registry.executeTool("echo", { msg: "hi" });
        assert.equal(result.success, true);
        assert.ok(result.output.includes("echo"));
    });

    it("returns error for unknown tool", async () => {
        const registry = new ToolRegistry();
        const result = await registry.executeTool("ghost", {});
        assert.equal(result.success, false);
        assert.ok(result.error?.includes("Unknown tool"));
    });

    it("catches thrown errors in tool execute", async () => {
        const registry = new ToolRegistry();
        registry.register({
            name: "thrower",
            description: "throws",
            parameters: {},
            async execute() {
                throw new Error("boom");
            },
        });
        const result = await registry.executeTool("thrower", {});
        assert.equal(result.success, false);
        assert.ok(result.error?.includes("boom"));
    });
});
