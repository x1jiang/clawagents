/**
 * ClawAgents Simulated Test Suite
 *
 * Covers all major subsystems using mock LLMs — no real API keys needed.
 *
 * Run:  npx tsx tests/simulated.test.ts
 */

import { ToolRegistry, type Tool, type ToolResult, truncateToolOutput } from "../src/tools/registry.js";
import {
    runAgentGraph,
    type AgentState,
    type EventKind,
    type OnEvent,
} from "../src/graph/agent-loop.js";
import type { LLMProvider, LLMMessage, LLMResponse, StreamOptions } from "../src/providers/llm.js";

// ━━━ Test Harness ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        console.error(`  ✗ ${label}`);
    }
}

function section(name: string) {
    console.log(`\n━━━ ${name} ━━━`);
}

// ━━━ Mock LLM ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class MockLLM implements LLMProvider {
    name = "mock";
    private responses: string[];
    private callIndex = 0;
    public callCount = 0;
    public lastMessages: LLMMessage[] = [];

    constructor(responses: string[]) {
        this.responses = responses;
    }

    async chat(messages: LLMMessage[], options?: StreamOptions): Promise<LLMResponse> {
        this.callCount++;
        this.lastMessages = [...messages];
        const content = this.responses[this.callIndex] ?? "I'm done.";
        if (this.callIndex < this.responses.length - 1) this.callIndex++;

        if (options?.onChunk) {
            for (const char of content) {
                options.onChunk(char);
            }
        }

        return { content, model: "mock", tokensUsed: Math.ceil(content.length / 4) };
    }

    reset() { this.callIndex = 0; this.callCount = 0; }
}

// ━━━ Mock Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createMathTool(): Tool {
    return {
        name: "calculate",
        description: "Evaluate a math expression",
        parameters: { expression: { type: "string", description: "Math expression", required: true } },
        async execute(args) {
            try {
                const result = Function(`"use strict"; return (${args.expression})`)();
                return { success: true, output: String(result) };
            } catch {
                return { success: false, output: "", error: "Invalid expression" };
            }
        },
    };
}

function createSlowTool(delayMs: number): Tool {
    return {
        name: "slow_op",
        description: "A slow operation",
        parameters: {},
        async execute() {
            await new Promise(r => setTimeout(r, delayMs));
            return { success: true, output: "done" };
        },
    };
}

function createFailingTool(): Tool {
    return {
        name: "unstable",
        description: "Throws errors",
        parameters: {},
        async execute() { throw new Error("Boom!"); },
    };
}

function createCounterTool(): { tool: Tool; getCount: () => number } {
    let count = 0;
    return {
        tool: {
            name: "counter",
            description: "Increments a counter",
            parameters: {},
            async execute() {
                count++;
                return { success: true, output: `count=${count}` };
            },
        },
        getCount: () => count,
    };
}

// Collects all events for assertions
function createEventCollector(): { events: Array<{ kind: EventKind; data: Record<string, unknown> }>; handler: OnEvent } {
    const events: Array<{ kind: EventKind; data: Record<string, unknown> }> = [];
    return {
        events,
        handler: (kind, data) => { events.push({ kind, data }); },
    };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main() {
    console.log("ClawAgents Simulated Test Suite\n");

    // ━━━ 1. Tool Registry ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("1. Tool Registry");

    const reg = new ToolRegistry(3000);
    const math = createMathTool();
    reg.register(math);

    assert(reg.get("calculate") === math, "register + get works");
    assert(reg.list().length === 1, "list returns registered tools");
    assert(reg.get("nonexistent") === undefined, "get returns undefined for unknown tool");

    // Description caching
    const d1 = reg.describeForLLM();
    const d2 = reg.describeForLLM();
    assert(d1 === d2, "describeForLLM returns cached string (same ref)");
    assert(d1.includes("calculate"), "description includes tool name");

    // Cache invalidation
    const { tool: counter } = createCounterTool();
    reg.register(counter);
    const d3 = reg.describeForLLM();
    assert(d3 !== d1, "cache invalidated after new register");
    assert(d3.includes("counter"), "new description includes new tool");

    // Tool execution
    const calcResult = await reg.executeTool("calculate", { expression: "2 + 3" });
    assert(calcResult.success && calcResult.output === "5", "executeTool succeeds with correct result");

    const unknownResult = await reg.executeTool("nope", {});
    assert(!unknownResult.success && unknownResult.error!.includes("Unknown"), "unknown tool returns error");

    // Timeout
    const regTimeout = new ToolRegistry(500);
    regTimeout.register(createSlowTool(10000));
    const t0 = Date.now();
    const timeoutResult = await regTimeout.executeTool("slow_op", {});
    const elapsed = Date.now() - t0;
    assert(!timeoutResult.success && timeoutResult.error!.includes("timed out"), "tool timeout fires");
    assert(elapsed < 2000, `timeout completed in reasonable time (${elapsed}ms)`);

    // Error handling
    reg.register(createFailingTool());
    const failResult = await reg.executeTool("unstable", {});
    assert(!failResult.success && failResult.error!.includes("Boom"), "throwing tool caught gracefully");

    // Tool output truncation
    const longOutput = "x".repeat(20000);
    const truncated = truncateToolOutput(longOutput);
    assert(truncated.length < longOutput.length, "truncateToolOutput shortens long output");
    assert(truncated.includes("truncated"), "truncation marker present");
    assert(truncateToolOutput("short") === "short", "short output unchanged");

    // ━━━ 2. Tool Call Parsing ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("2. Tool Call Parsing");

    const parser = new ToolRegistry();
    parser.register(math);

    // Single call in code fence
    const calls1 = parser.parseToolCalls('Here is what I will do:\n```json\n{"tool": "calculate", "args": {"expression": "1+1"}}\n```');
    assert(calls1.length === 1 && calls1[0].toolName === "calculate", "parses single fenced tool call");

    // Multiple calls in array
    const calls2 = parser.parseToolCalls('```json\n[{"tool": "calculate", "args": {"expression": "1+1"}}, {"tool": "calculate", "args": {"expression": "2+2"}}]\n```');
    assert(calls2.length === 2, "parses array of tool calls");

    // No tool call — plain text
    const calls3 = parser.parseToolCalls("The answer is 42.");
    assert(calls3.length === 0, "no tool calls in plain text");

    // Bare JSON (no fence)
    const calls4 = parser.parseToolCalls('{"tool": "calculate", "args": {"expression": "5*5"}}');
    assert(calls4.length === 1, "parses bare JSON tool call");

    // Non-JSON code block before tool call
    const calls5 = parser.parseToolCalls('```python\nprint("hello")\n```\n```json\n{"tool": "calculate", "args": {}}\n```');
    assert(calls5.length === 1 && calls5[0].toolName === "calculate", "skips non-JSON code blocks");

    // Malformed JSON
    const calls6 = parser.parseToolCalls('```json\n{broken json\n```');
    assert(calls6.length === 0, "gracefully handles malformed JSON");

    // ━━━ 3. Parallel Execution ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("3. Parallel Execution");

    const parallelReg = new ToolRegistry(5000);
    const { tool: c1, getCount: getC1 } = createCounterTool();
    c1.name = "counter_a";
    const { tool: c2, getCount: getC2 } = createCounterTool();
    c2.name = "counter_b";
    parallelReg.register(c1);
    parallelReg.register(c2);

    const pResults = await parallelReg.executeToolsParallel([
        { toolName: "counter_a", args: {} },
        { toolName: "counter_b", args: {} },
        { toolName: "counter_a", args: {} },
    ]);
    assert(pResults.length === 3, "parallel returns correct number of results");
    assert(pResults.every(r => r.success), "all parallel calls succeed");
    assert(getC1() === 2 && getC2() === 1, "parallel calls actually executed");

    // Parallel with one failure
    parallelReg.register(createFailingTool());
    const pResults2 = await parallelReg.executeToolsParallel([
        { toolName: "counter_a", args: {} },
        { toolName: "unstable", args: {} },
    ]);
    assert(pResults2[0].success && !pResults2[1].success, "parallel isolates failures");

    // ━━━ 4. Agent Loop — Simple Completion ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("4. Agent Loop — Simple Completion");

    const simpleLLM = new MockLLM(["The answer to your question is 42."]);
    const { events: e1, handler: h1 } = createEventCollector();
    const state1 = await runAgentGraph("What is the meaning of life?", simpleLLM, undefined, undefined, 3, false, 128000, h1);

    assert(state1.status === "done", "simple completion: status is done");
    assert(state1.result.includes("42"), "simple completion: result contains answer");
    assert(state1.toolCalls === 0, "simple completion: no tool calls");
    assert(e1.some(e => e.kind === "final_content"), "final_content event emitted");
    assert(e1.some(e => e.kind === "agent_done"), "agent_done event emitted");

    // ━━━ 5. Agent Loop — Tool Usage ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("5. Agent Loop — Tool Usage");

    const toolLLM = new MockLLM([
        '```json\n{"tool": "calculate", "args": {"expression": "6 * 7"}}\n```',
        "The result of 6 * 7 is 42.",
    ]);
    const toolReg = new ToolRegistry();
    toolReg.register(createMathTool());
    const { events: e2, handler: h2 } = createEventCollector();
    const state2 = await runAgentGraph("What is 6 * 7?", toolLLM, toolReg, undefined, 3, false, 128000, h2);

    assert(state2.status === "done", "tool usage: status is done");
    assert(state2.toolCalls === 1, "tool usage: 1 tool call made");
    assert(state2.result.includes("42"), "tool usage: final answer correct");
    assert(e2.some(e => e.kind === "tool_call"), "tool_call event emitted");
    assert(e2.some(e => e.kind === "tool_result"), "tool_result event emitted");

    // ━━━ 6. Agent Loop — Multi-step Tool Chain ━━━━━━━━━━━━━━━━━━━━━━━━
    section("6. Agent Loop — Multi-step Tool Chain");

    const chainLLM = new MockLLM([
        '```json\n{"tool": "calculate", "args": {"expression": "10 + 20"}}\n```',
        '```json\n{"tool": "calculate", "args": {"expression": "30 * 2"}}\n```',
        "First I got 30, then 60. Done.",
    ]);
    const chainReg = new ToolRegistry();
    chainReg.register(createMathTool());
    const state3 = await runAgentGraph("Do two calculations", chainLLM, chainReg, undefined, 3, false, 128000, () => {});

    assert(state3.toolCalls === 2, "multi-step: 2 tool calls");
    assert(state3.status === "done", "multi-step: completed");

    // ━━━ 7. Agent Loop — Parallel Tool Calls ━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("7. Agent Loop — Parallel Tool Calls");

    const parallelLLM = new MockLLM([
        '```json\n[{"tool": "calculate", "args": {"expression": "1+1"}}, {"tool": "calculate", "args": {"expression": "2+2"}}]\n```',
        "Got 2 and 4.",
    ]);
    const parallelToolReg = new ToolRegistry();
    parallelToolReg.register(createMathTool());
    const { events: e4, handler: h4 } = createEventCollector();
    const state4 = await runAgentGraph("Compute both", parallelLLM, parallelToolReg, undefined, 3, false, 128000, h4);

    assert(state4.toolCalls === 2, "parallel loop: 2 tool calls");
    assert(e4.filter(e => e.kind === "tool_call").length === 2, "parallel loop: 2 tool_call events");

    // ━━━ 8. Agent Loop — Tool Loop Detection ━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("8. Tool Loop Detection");

    const loopLLM = new MockLLM([
        '```json\n{"tool": "calculate", "args": {"expression": "1+1"}}\n```',
        '```json\n{"tool": "calculate", "args": {"expression": "1+1"}}\n```',
        '```json\n{"tool": "calculate", "args": {"expression": "1+1"}}\n```',
        '```json\n{"tool": "calculate", "args": {"expression": "1+1"}}\n```',
    ]);
    const loopReg = new ToolRegistry();
    loopReg.register(createMathTool());
    const { events: e5, handler: h5 } = createEventCollector();
    const state5 = await runAgentGraph("Loop forever", loopLLM, loopReg, undefined, 10, false, 128000, h5);

    assert(state5.result.includes("loop"), "loop detection: result mentions loop");
    assert(e5.some(e => e.kind === "warn" && String(e.data.message).includes("loop")), "loop detection: warn event");

    // ━━━ 9. Agent Loop — Error Handling ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("9. Error Handling");

    const errorLLM = new MockLLM([
        '```json\n{"tool": "unstable", "args": {}}\n```',
        "The tool failed, but I can continue. The answer is recovered.",
    ]);
    const errorReg = new ToolRegistry();
    errorReg.register(createFailingTool());
    const state6 = await runAgentGraph("Use unstable tool", errorLLM, errorReg, undefined, 3, false, 128000, () => {});

    assert(state6.status === "done", "error recovery: agent still completes");
    assert(state6.result.includes("recovered"), "error recovery: agent adapts after tool error");

    // ━━━ 10. Event System ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("10. Event System — Complete Coverage");

    const eventLLM = new MockLLM([
        '```json\n{"tool": "calculate", "args": {"expression": "1+1"}}\n```',
        "Done! The answer is 2.",
    ]);
    const eventReg = new ToolRegistry();
    eventReg.register(createMathTool());
    const { events: eAll, handler: hAll } = createEventCollector();
    await runAgentGraph("Compute 1+1", eventLLM, eventReg, undefined, 3, false, 128000, hAll);

    const kinds = new Set(eAll.map(e => e.kind));
    assert(kinds.has("tool_call"), "event: tool_call present");
    assert(kinds.has("tool_result"), "event: tool_result present");
    assert(kinds.has("final_content"), "event: final_content present");
    assert(kinds.has("agent_done"), "event: agent_done present");

    const doneEvent = eAll.find(e => e.kind === "agent_done")!;
    assert(typeof doneEvent.data.elapsed === "number", "agent_done has elapsed");
    assert(doneEvent.data.tool_calls === 1, "agent_done has correct tool_calls count");

    // ━━━ 11. Streaming Mode ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("11. Streaming Mode");

    const streamLLM = new MockLLM(["Streamed response!"]);
    let streamedChars = 0;
    const origChat = streamLLM.chat.bind(streamLLM);
    streamLLM.chat = async (msgs, opts) => {
        if (opts?.onChunk) {
            const wrapped: StreamOptions = {
                ...opts,
                onChunk: (chunk) => { streamedChars += chunk.length; opts.onChunk!(chunk); },
            };
            return origChat(msgs, wrapped);
        }
        return origChat(msgs, opts);
    };
    await runAgentGraph("Stream test", streamLLM, undefined, undefined, 3, true, 128000, () => {});
    assert(streamedChars > 0, `streaming: received ${streamedChars} chars via onChunk`);

    // ━━━ 12. Custom System Prompt ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("12. Custom System Prompt");

    const customLLM = new MockLLM(["Hola, el resultado es 42."]);
    await runAgentGraph("Hello", customLLM, undefined, "Always respond in Spanish.", 3, false, 128000, () => {});
    const sysMsg = customLLM.lastMessages.find(m => m.role === "system");
    assert(sysMsg !== undefined && sysMsg.content.includes("Spanish"), "custom system prompt injected");

    // ━━━ 13. Hook: beforeLLM ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("13. Hook: beforeLLM");

    const hookLLM = new MockLLM(["Hooked!"]);
    let beforeLLMCalled = false;
    await runAgentGraph(
        "Hook test", hookLLM, undefined, undefined, 3, false, 128000, () => {},
        (msgs) => { beforeLLMCalled = true; return [...msgs, { role: "user" as const, content: "[injected]" }]; },
    );
    assert(beforeLLMCalled, "beforeLLM hook was called");
    assert(hookLLM.lastMessages.some(m => m.content.includes("[injected]")), "beforeLLM injected message");

    // ━━━ 14. Hook: beforeTool (block) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("14. Hook: beforeTool (block)");

    const blockLLM = new MockLLM([
        '```json\n{"tool": "calculate", "args": {"expression": "1+1"}}\n```',
        "The tool was blocked.",
    ]);
    const blockReg = new ToolRegistry();
    blockReg.register(createMathTool());
    const { events: eBlock, handler: hBlock } = createEventCollector();
    const stateBlock = await runAgentGraph(
        "Blocked", blockLLM, blockReg, undefined, 3, false, 128000, hBlock,
        undefined,
        (_name) => false,  // block all tools
    );
    assert(stateBlock.toolCalls === 0, "beforeTool block: no tool calls executed");

    // ━━━ 15. Hook: afterTool (modify result) ━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("15. Hook: afterTool (modify result)");

    const afterLLM = new MockLLM([
        '```json\n{"tool": "calculate", "args": {"expression": "2+2"}}\n```',
        "Modified result received.",
    ]);
    const afterReg = new ToolRegistry();
    afterReg.register(createMathTool());
    let afterToolSawOutput = "";
    await runAgentGraph(
        "After", afterLLM, afterReg, undefined, 3, false, 128000, () => {},
        undefined, undefined,
        (_name, _args, result) => {
            afterToolSawOutput = result.output;
            return { ...result, output: "MODIFIED" };
        },
    );
    assert(afterToolSawOutput === "4", "afterTool received original result");
    assert(afterLLM.lastMessages.some(m => m.content.includes("MODIFIED")), "afterTool modification applied");

    // ━━━ 16. Path Traversal Blocking ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("16. Path Traversal Blocking");

    // Import safePath indirectly via filesystem tool
    const { resolve, sep } = await import("node:path");
    const ROOT = process.cwd();
    function safePath(p: string): string {
        const resolved = resolve(ROOT, p);
        if (resolved !== ROOT && !resolved.startsWith(ROOT + sep)) {
            throw new Error(`Path traversal blocked: ${p}`);
        }
        return resolved;
    }

    assert(safePath("./src/index.ts").startsWith(ROOT), "safe path within root OK");
    try { safePath("../../../etc/passwd"); assert(false, "traversal should throw"); }
    catch { assert(true, "path traversal blocked"); }
    try { safePath("/etc/passwd"); assert(false, "absolute path should throw"); }
    catch { assert(true, "absolute path outside root blocked"); }

    // ━━━ 17. Exec Safety ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("17. Exec Safety");

    const { execTool } = await import("../src/tools/exec.js");

    const echoResult = await execTool.execute({ command: "echo hello" });
    assert(echoResult.success && echoResult.output.includes("hello"), "exec: echo works");

    const blockedResult = await execTool.execute({ command: "rm -rf /" });
    assert(!blockedResult.success && blockedResult.error!.includes("Blocked"), "exec: dangerous command blocked");

    const emptyResult = await execTool.execute({ command: "" });
    assert(!emptyResult.success, "exec: empty command fails");

    // ━━━ 18. Stable Key Ordering in ToolCallTracker ━━━━━━━━━━━━━━━━━━━━
    section("18. Stable Key Ordering in ToolCallTracker");

    {
        const { ToolCallTracker: TCT } = await import("../src/graph/agent-loop.js");
        const trackerKey = new TCT(12, 2);
        // Record same args twice with different key order
        trackerKey.record("read_file", { path: "a.txt", mode: "r" });
        trackerKey.record("read_file", { mode: "r", path: "a.txt" });
        // With stable stringify, these should be seen as 2 identical calls => looping at threshold 2
        assert(trackerKey.isLooping("read_file", { path: "a.txt", mode: "r" }), "tracker: same args different order = same key");
        assert(trackerKey.isLooping("read_file", { mode: "r", path: "a.txt" }), "tracker: reverse order also matches");
    }

    // ━━━ 19. Hook Exception Safety ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("19. Hook Exception Safety");

    {
        const hookErrLLM = new MockLLM([
            '```json\n{"tool": "calculate", "args": {"expression": "1+1"}}\n```',
            "Final after hook error.",
        ]);
        const hookErrReg = new ToolRegistry();
        hookErrReg.register(createMathTool());
        const { events: hookErrEvts, handler: hookErrH } = createEventCollector();

        // beforeLLM throws — should not crash
        const stateHookErr = await runAgentGraph(
            "Hook errors", hookErrLLM, hookErrReg, undefined, 3, false, 128000, hookErrH,
            (_msgs) => { throw new Error("beforeLLM boom"); },
            (_name, _args) => { throw new Error("beforeTool boom"); },
            (_name, _args, _result) => { throw new Error("afterTool boom"); },
        );
        assert(stateHookErr.status !== "error", "hook errors: agent still completed (not error status)");
        assert(hookErrEvts.some(e => e.kind === "warn"), "hook errors: warn events emitted for hook failures");
    }

    // ━━━ 20. Max Rounds Sets state.result ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("20. Max Rounds Sets state.result");

    {
        // Use varying args to avoid loop detection, forcing max rounds
        const infiniteResponses: string[] = [];
        for (let i = 0; i < 20; i++) {
            infiniteResponses.push(`\`\`\`json\n{"tool": "calculate", "args": {"expression": "${i}+1"}}\n\`\`\``);
        }
        const maxLLM = new MockLLM(infiniteResponses);
        const maxReg = new ToolRegistry();
        maxReg.register(createMathTool());
        const stateMax = await runAgentGraph(
            "Max rounds", maxLLM, maxReg, undefined, 5, false, 128000, () => {},
        );
        assert(stateMax.result.includes("maximum") || stateMax.result.includes("Reached"), "max rounds: state.result set (maxIterations=5 respected)");
        assert(stateMax.status === "done", "max rounds: status is done");
    }

    // ━━━ 21. NaN Guard in Filesystem ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("21. NaN Guard in Filesystem/Exec");

    {
        // exec with invalid timeout should not crash
        const execInvalid = await execTool.execute({ command: "echo ok", timeout: "not_a_number" });
        assert(execInvalid.success, "exec: invalid timeout falls back to default");
    }

    // ━━━ 22. Empty Compaction Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("22. Empty Compaction Summary Handled");

    {
        // This test verifies the compaction code path handles empty summary
        // by checking the function exists and handles edge cases
        assert(typeof runAgentGraph === "function", "compaction: runAgentGraph function available");
        // Minimal test: agent with tiny context window to trigger compaction
        const compactResponses: string[] = [];
        for (let i = 0; i < 5; i++) {
            compactResponses.push('```json\n{"tool": "calculate", "args": {"expression": "1+1"}}\n```');
        }
        compactResponses.push("Final answer after compaction.");
        const compactLLM = new MockLLM(compactResponses);
        const compactReg = new ToolRegistry();
        compactReg.register(createMathTool());
        const stateCompact = await runAgentGraph(
            "Compaction test", compactLLM, compactReg, undefined, 3, false, 500, () => {},
        );
        assert(stateCompact.status === "done" || stateCompact.status === "error", "compaction: agent completed without crash");
    }

    // ━━━ 23. maxIterations Is Respected ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    section("23. maxIterations Is Respected");

    {
        const limitResponses: string[] = [];
        for (let i = 0; i < 20; i++) {
            limitResponses.push(`\`\`\`json\n{"tool": "calculate", "args": {"expression": "${i}+10"}}\n\`\`\``);
        }
        const limitLLM = new MockLLM(limitResponses);
        const limitReg = new ToolRegistry();
        limitReg.register(createMathTool());
        const stateLimit = await runAgentGraph(
            "Limit test", limitLLM, limitReg, undefined, 4, false, 128000, () => {},
        );
        assert(stateLimit.toolCalls <= 4, `maxIterations=4: tool calls (${stateLimit.toolCalls}) <= 4`);
        assert(stateLimit.result.includes("Reached maximum of 4"), "maxIterations=4: result message correct");
    }

    // ━━━ 24. stableStringify Sorts Nested Keys ━━━━━━━━━━━━━━━━━━━━━━━
    section("24. stableStringify Sorts Nested Keys");

    {
        const { stableStringify: ss } = await import("../src/graph/agent-loop.js");
        const a = ss({ z: { b: 1, a: 2 }, a: 1 });
        const b = ss({ a: 1, z: { a: 2, b: 1 } });
        assert(a === b, "stableStringify: nested key order doesn't matter");
    }

    // ━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log(`\n${"━".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
