/**
 * Tests for v6.4 Handoffs + ClawAgent.asTool.
 *
 * Uses a hand-rolled mock LLM (similar to the parallel-native-indexing
 * regression in the Python port) so the agent loop can be driven
 * deterministically without real provider calls.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { ClawAgent } from "./agent.js";
import { runAgentGraph } from "./graph/agent-loop.js";
import type { AgentState } from "./graph/agent-loop.js";
import { handoff, type HandoffInputData } from "./handoffs.js";
import { removeAllTools } from "./handoff-filters.js";
import { RunHooks } from "./lifecycle.js";
import type {
    LLMMessage,
    LLMProvider,
    LLMResponse,
    NativeToolCall,
    NativeToolSchema,
    StreamOptions,
} from "./providers/llm.js";
import type { RunContext } from "./run-context.js";
import { ToolRegistry } from "./tools/registry.js";
import type { StreamEvent, HandoffOccurredEvent } from "./stream-events.js";

class NativeMockLLM implements LLMProvider {
    name = "mock-native";
    public received: LLMMessage[][] = [];
    public receivedTools: (NativeToolSchema[] | undefined)[] = [];
    private idx = 0;
    constructor(private rounds: LLMResponse[]) {}
    async chat(messages: LLMMessage[], options?: StreamOptions): Promise<LLMResponse> {
        this.received.push([...messages]);
        this.receivedTools.push(options?.tools);
        const i = Math.min(this.idx, this.rounds.length - 1);
        this.idx++;
        return this.rounds[i]!;
    }
}

function buildTarget(text = "child final answer"): { agent: ClawAgent; llm: NativeMockLLM } {
    const llm = new NativeMockLLM([
        { content: text, model: "mock", tokensUsed: 1 },
    ]);
    const agent = new ClawAgent(
        llm,
        new ToolRegistry(),
        "You are the billing specialist.",
        false, // streaming
        true,  // useNativeTools
        1_000_000,
        undefined, undefined, undefined, undefined,
        false, false, false,
        2, // maxIterations
        120, 500, 0,
        undefined, undefined, 3,
        undefined,
        "billing_specialist",
    );
    return { agent, llm };
}

// ─── Schema surfacing ────────────────────────────────────────────────────

test("handoff tool appears in native schemas", async () => {
    const { agent: target } = buildTarget();
    const h = handoff(target);

    const parentLLM = new NativeMockLLM([
        { content: "done", model: "mock", tokensUsed: 1 },
    ]);
    await runAgentGraph(
        "task", parentLLM, new ToolRegistry(),
        undefined, 2, false, 1_000_000,
        () => undefined, undefined, undefined, undefined,
        true, false, false, false, 120, 500, 0,
        undefined, undefined, 3,
        { handoffs: [h] },
    );

    assert.ok(parentLLM.receivedTools[0]);
    const names = (parentLLM.receivedTools[0] ?? []).map((s) => s.name);
    assert.ok(names.includes(h.name));
    assert.ok(h.name.startsWith("transfer_to_"));
    const matched = parentLLM.receivedTools[0]!.find((s) => s.name === h.name)!;
    assert.match(matched.description, /billing_specialist/);
});

// ─── Dispatch transfers control ────────────────────────────────────────

test("handoff call runs the target agent", async () => {
    const { agent: target, llm: targetLLM } = buildTarget("billing answer");
    const h = handoff(target);

    const parentLLM = new NativeMockLLM([
        {
            content: "",
            model: "mock",
            tokensUsed: 1,
            toolCalls: [
                { toolName: h.name, args: { reason: "user asked about invoice" }, toolCallId: "call_1" } as NativeToolCall,
            ],
        },
        { content: "parent fallback (should not appear)", model: "mock", tokensUsed: 1 },
    ]);

    const state = await runAgentGraph(
        "Help me with my bill",
        parentLLM, new ToolRegistry(),
        undefined, 4, false, 1_000_000,
        () => undefined, undefined, undefined, undefined,
        true, false, false, false, 120, 500, 0,
        undefined, undefined, 3,
        { handoffs: [h] },
    );

    assert.equal(state.result, "billing answer");
    assert.equal(state.status, "done");
    assert.equal(targetLLM.received.length, 1);
    assert.equal(parentLLM.received.length, 1);
});

// ─── Input filter is invoked ────────────────────────────────────────

test("input filter receives a HandoffInputData payload and filters messages", async () => {
    const { agent: target } = buildTarget("filtered child");
    let captured: HandoffInputData | undefined;

    const customFilter = (data: HandoffInputData): HandoffInputData => {
        captured = data;
        return {
            inputHistory: data.inputHistory.filter((m) => m.role === "system" || m.role === "user"),
            preHandoffItems: data.preHandoffItems,
            newItems: data.newItems,
            runContext: data.runContext,
        };
    };

    const h = handoff(target, { inputFilter: customFilter });

    const parentLLM = new NativeMockLLM([
        {
            content: "",
            model: "mock",
            tokensUsed: 1,
            toolCalls: [
                { toolName: h.name, args: { reason: "transfer" }, toolCallId: "call_1" },
            ],
        },
    ]);

    await runAgentGraph(
        "Original user task",
        parentLLM, new ToolRegistry(),
        undefined, 4, false, 1_000_000,
        () => undefined, undefined, undefined, undefined,
        true, false, false, false, 120, 500, 0,
        undefined, undefined, 3,
        { handoffs: [h] },
    );

    assert.ok(captured, "filter should have been called");
    assert.ok(captured!.runContext, "payload should carry runContext");
    const roles = captured!.inputHistory.map((m) => m.role);
    assert.ok(roles.includes("assistant"));
    assert.ok(roles.includes("tool"));
});

// ─── removeAllTools strips tool exchanges ──────────────────────────────

test("removeAllTools strips tool messages", () => {
    const history: LLMMessage[] = [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCallsMeta: [{ id: "x", name: "ls", args: {} }] },
        { role: "tool", content: "result", toolCallId: "x" },
        { role: "user", content: "[Tool Result] foo" },
        { role: "assistant", content: "great" },
    ];
    const out = removeAllTools({ inputHistory: history });
    const pairs = out.inputHistory.map((m) => [m.role, typeof m.content === "string" ? m.content : ""] as const);
    assert.ok(!pairs.some(([r, c]) => r === "tool" && c === "result"));
    assert.ok(!pairs.some(([r, c]) => r === "user" && c.startsWith("[Tool Result]")));
    assert.ok(pairs.some(([r, c]) => r === "system" && c === "you are helpful"));
    assert.ok(pairs.some(([r, c]) => r === "user" && c === "hi"));
    assert.ok(pairs.some(([r, c]) => r === "assistant" && c === "great"));
    // Native-tool-call assistant message is stripped.
    assert.ok(out.inputHistory.every((m) => !(m.role === "assistant" && m.toolCallsMeta && m.toolCallsMeta.length > 0)));
});

// ─── RunHooks.onHandoff fires ────────────────────────────────

test("RunHooks.onHandoff fires", async () => {
    const { agent: target } = buildTarget();
    const h = handoff(target);

    const seen: Array<[string, string]> = [];
    class Capture extends RunHooks {
        async onHandoff(payload: { fromAgent: string; toAgent: string }): Promise<void> {
            seen.push([payload.fromAgent, payload.toAgent]);
        }
    }

    const parentLLM = new NativeMockLLM([
        {
            content: "",
            model: "mock",
            tokensUsed: 1,
            toolCalls: [{ toolName: h.name, args: { reason: "transfer" }, toolCallId: "call_1" }],
        },
    ]);

    await runAgentGraph(
        "task",
        parentLLM, new ToolRegistry(),
        undefined, 4, false, 1_000_000,
        () => undefined, undefined, undefined, undefined,
        true, false, false, false, 120, 500, 0,
        undefined, undefined, 3,
        { handoffs: [h], hooks: new Capture(), agentName: "parent_agent" },
    );

    assert.deepEqual(seen, [["parent_agent", "billing_specialist"]]);
});

// ─── HandoffOccurredEvent emitted ────────────────────────────

test("HandoffOccurredEvent is emitted on the typed stream", async () => {
    const { agent: target } = buildTarget();
    const h = handoff(target);

    const events: StreamEvent[] = [];
    const parentLLM = new NativeMockLLM([
        {
            content: "",
            model: "mock",
            tokensUsed: 1,
            toolCalls: [{ toolName: h.name, args: { reason: "test reason" }, toolCallId: "call_1" }],
        },
    ]);

    await runAgentGraph(
        "task",
        parentLLM, new ToolRegistry(),
        undefined, 4, false, 1_000_000,
        () => undefined, undefined, undefined, undefined,
        true, false, false, false, 120, 500, 0,
        undefined, undefined, 3,
        {
            handoffs: [h],
            agentName: "parent_agent",
            onStreamEvent: (e) => { events.push(e); },
        },
    );

    const handoffEvts = events.filter((e): e is HandoffOccurredEvent => e.kind === "handoff_occurred");
    assert.equal(handoffEvts.length, 1);
    const e = handoffEvts[0]!;
    assert.equal(e.fromAgent, "parent_agent");
    assert.equal(e.toAgent, "billing_specialist");
    assert.equal(e.toolName, h.name);
    assert.equal(e.reason, "test reason");
});

// ─── ClawAgent.asTool ────────────────────────────────────

test("Agent.asTool: runs the wrapped agent and returns state.result", async () => {
    const { agent: target, llm: targetLLM } = buildTarget("wrapped child output");

    const tool = target.asTool({
        toolName: "ask_billing",
        toolDescription: "Ask the billing agent",
    });

    assert.equal(tool.name, "ask_billing");
    assert.equal(tool.description, "Ask the billing agent");
    assert.ok(tool.parameters.task);
    assert.equal(tool.parameters.task!.required, true);

    const result = await tool.execute({ task: "Where is my refund?" });
    assert.equal(result.success, true);
    assert.equal(result.output, "wrapped child output");
    assert.equal(targetLLM.received.length, 1);
});

test("Agent.asTool: customOutputExtractor pulls a different field", async () => {
    const { agent: target } = buildTarget("default would be this");

    const tool = target.asTool({
        toolName: "ask_billing",
        toolDescription: "Ask the billing agent",
        customOutputExtractor: (state: AgentState) => `custom:${state.toolCalls}:${state.result}`,
    });

    const result = await tool.execute({ task: "anything" });
    assert.equal(result.success, true);
    assert.equal(result.output, "custom:0:default would be this");
});

test("Agent.asTool: missing task arg is reported as a tool error", async () => {
    const { agent: target } = buildTarget();
    const tool = target.asTool({ toolName: "ask", toolDescription: "Ask" });
    const result = await tool.execute({ task: "" });
    assert.equal(result.success, false);
    assert.match(result.error || "", /missing/i);
});
