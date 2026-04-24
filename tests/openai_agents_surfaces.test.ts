/**
 * Tests for the openai-agents-python parity surfaces added to clawagents:
 *
 *  1.  Typed RunContext threaded through tools + hooks
 *  2.  functionTool() helper with auto-derived JSON schema
 *  3.  Typed StreamEvent discriminated union (via streamEventFromKind + extras.onStreamEvent)
 *  4.  Composable RetryPolicy on top of ErrorClass
 *  5.  Per-run Usage accumulator exposed in AgentState
 *  6.  RunHooks / AgentHooks with lifecycle methods
 *  7.  Input / output guardrails with allow / reject_content / raise_exception
 *  8.  outputType for structured outputs
 *  9.  Per-call tool approval with sticky records
 * 10.  Session protocol with InMemory / Jsonl / SQLite-ish backends
 *
 * Run:  npx tsx tests/openai_agents_surfaces.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolRegistry, type Tool } from "../src/tools/registry.js";
import {
    runAgentGraph,
    type AgentState,
    type AgentLoopExtras,
    type OnStreamEvent,
} from "../src/graph/agent-loop.js";
import type {
    LLMProvider,
    LLMMessage,
    LLMResponse,
    StreamOptions,
} from "../src/providers/llm.js";

import { RunContext } from "../src/run-context.js";
import { Usage } from "../src/usage.js";
import { functionTool } from "../src/function-tool.js";
import {
    RunHooks,
    compositeHooks,
    type RunStartPayload,
    type RunEndPayload,
    type LLMEndPayload,
    type ToolStartPayload,
    type ToolEndPayload,
} from "../src/lifecycle.js";
import {
    inputGuardrail,
    outputGuardrail,
    GuardrailBehavior,
    GuardrailResult,
    GuardrailTripwireTriggered,
} from "../src/guardrails.js";
import { RetryPolicy } from "../src/retry.js";
import { ErrorClass } from "../src/errors/taxonomy.js";
import {
    streamEventFromKind,
    type StreamEvent,
    type UsageEvent,
    type GuardrailTrippedEvent,
} from "../src/stream-events.js";
import { InMemorySession, JsonlFileSession } from "../src/session/backends.js";

// ── Mini harness ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: unknown, label: string): void {
    if (cond) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        failures.push(label);
        console.error(`  ✗ ${label}`);
    }
}

function section(name: string): void {
    console.log(`\n━━━ ${name} ━━━`);
}

// ── Mock LLM ─────────────────────────────────────────────────────────

class MockLLM implements LLMProvider {
    name = "mock";
    private idx = 0;
    public callCount = 0;
    constructor(private responses: Array<Partial<LLMResponse> | string>) {}

    async chat(_messages: LLMMessage[], _options?: StreamOptions): Promise<LLMResponse> {
        this.callCount++;
        const raw = this.responses[this.idx] ?? "Done.";
        if (this.idx < this.responses.length - 1) this.idx++;
        const base: LLMResponse = {
            content: "",
            model: "mock-model",
            tokensUsed: 20,
            promptTokens: 14,
        };
        if (typeof raw === "string") return { ...base, content: raw };
        return { ...base, ...raw };
    }
}

function mathTool(): Tool {
    return {
        name: "calculate",
        description: "Evaluate a math expression",
        parameters: { expression: { type: "string", description: "Expr", required: true } },
        async execute(args) {
            try {
                const out = Function(`"use strict"; return (${args.expression})`)();
                return { success: true, output: String(out) };
            } catch {
                return { success: false, output: "", error: "Invalid" };
            }
        },
    };
}

async function main(): Promise<void> {
    console.log("ClawAgents openai-agents parity surfaces — test suite\n");

    // ── 1. RunContext + Usage threading ─────────────────────────────
    section("1. RunContext + Usage threading");
    {
        const ctx = new RunContext<{ userId: string }>({ context: { userId: "u-42" } });
        assert(ctx.context?.userId === "u-42", "RunContext carries typed user context");
        assert(ctx.usage instanceof Usage, "RunContext auto-creates a Usage accumulator");

        ctx.usage.addResponse({ model: "gpt", inputTokens: 10, outputTokens: 3, totalTokens: 13 });
        ctx.usage.addResponse({ model: "gpt", inputTokens: 7, outputTokens: 2, totalTokens: 9 });
        assert(ctx.usage.requests === 2, "Usage counts two requests");
        assert(ctx.usage.totalTokens === 22, "Usage sums totalTokens across requests");
        assert(ctx.usage.perRequest.length === 2, "Usage stores perRequest records");
    }

    // ── 2. functionTool() auto-wires schema + RunContext ────────────
    section("2. functionTool() auto-derived schema + runContext arg");
    {
        const seen: { uid?: string } = {};
        const tool = functionTool<{ a: number; b: number }, { userId: string }>({
            name: "add",
            description: "Add two numbers",
            parameters: {
                a: { type: "integer", description: "a", required: true },
                b: { type: "integer", description: "b", default: 1 },
            },
            async execute({ a, b }, runContext) {
                seen.uid = runContext?.context?.userId;
                return { success: true, output: String(a + b) };
            },
        });
        assert(tool.name === "add", "functionTool sets tool.name");
        assert((tool.parameters.a as any).type === "integer", "param a is typed integer");
        assert((tool.parameters.b as any).required === undefined, "param b is optional (no required=true)");

        const ctx = new RunContext<{ userId: string }>({ context: { userId: "u-7" } });
        const r = await tool.execute({ a: 2 } as any, ctx as any);
        assert(r.success && r.output === "3", "default value for b applied -> 2+1=3");
        assert(seen.uid === "u-7", "runContext.context surfaced to function tool");
    }

    // ── 3. Typed StreamEvent discriminated union ────────────────────
    section("3. Typed StreamEvent discriminated union");
    {
        const ev = streamEventFromKind("usage", {
            model: "gpt-x",
            inputTokens: 11,
            outputTokens: 2,
            totalTokens: 13,
        }) as UsageEvent;
        assert(ev.kind === "usage" && ev.totalTokens === 13, "usage event narrows + preserves totalTokens");

        const gr = streamEventFromKind("guardrail_tripped", {
            guardrailName: "no-pii", where: "input",
            behavior: GuardrailBehavior.REJECT_CONTENT, message: "blocked",
        }) as GuardrailTrippedEvent;
        assert(gr.guardrailName === "no-pii" && gr.where === "input", "guardrail_tripped event typed");

        const unknown = streamEventFromKind("does-not-exist", { foo: 1 });
        assert(unknown.kind === "does-not-exist", "unknown kinds fall through to GenericStreamEvent");
    }

    // ── 4. Composable RetryPolicy ───────────────────────────────────
    section("4. Composable RetryPolicy");
    {
        const policy = new RetryPolicy({
            maxRetries: 3,
            retryOn: [ErrorClass.PROVIDER_RATE_LIMIT],
            baseDelayMs: 10,
            maxDelayMs: 100,
            jitter: 0,
            perClassMax: { [ErrorClass.PROVIDER_RATE_LIMIT]: 2 },
        });
        const errRL = new Error("429: rate limited");
        const descriptor = { errorClass: ErrorClass.PROVIDER_RATE_LIMIT, message: "rl", retryAfterMs: null } as any;
        assert(policy.shouldRetry(errRL, 1, { descriptor }), "rate-limit retryable on attempt 1");
        assert(policy.shouldRetry(errRL, 2, { descriptor }) === false, "perClassMax=2 caps retries");

        const authDesc = { errorClass: ErrorClass.PROVIDER_AUTH, message: "auth", retryAfterMs: null } as any;
        assert(policy.shouldRetry(new Error("401"), 1, { descriptor: authDesc }) === false, "auth errors not retried");

        const retryAfter = policy.computeDelayMs(1, { retryAfterMs: 55 });
        assert(retryAfter === 55, "computeDelayMs honours retryAfterMs");
        const capped = policy.computeDelayMs(10, { retryAfterMs: 99999 });
        assert(capped === 100, "computeDelayMs caps retryAfterMs at maxDelayMs");
    }

    // ── 5+6+9. Run end-to-end with hooks + Usage + approval ─────────
    section("5/6/9. End-to-end run: usage + hooks + sticky approval");
    {
        // Mock LLM: two identical tool-call plans + final.
        const llm = new MockLLM([
            '```json\n{"tool": "calculate", "args": {"expression": "1+1"}}\n```',
            '```json\n{"tool": "calculate", "args": {"expression": "2+2"}}\n```',
            "All computed.",
        ]);
        const reg = new ToolRegistry();
        reg.register(mathTool());

        const evts: Array<{ kind: string; data: Record<string, unknown> }> = [];
        const typedEvts: StreamEvent[] = [];

        // Hook counts
        const counts = {
            runStart: 0, runEnd: 0, llmStart: 0, llmEnd: 0,
            toolStart: 0, toolEnd: 0, agentStart: 0, agentEnd: 0,
        };
        class MyHooks extends RunHooks<{ userId: string }> {
            async onRunStart(_p: RunStartPayload<{ userId: string }>) { counts.runStart++; }
            async onRunEnd(_p: RunEndPayload<{ userId: string }>) { counts.runEnd++; }
            async onLLMStart() { counts.llmStart++; }
            async onLLMEnd(_p: LLMEndPayload<{ userId: string }>) { counts.llmEnd++; }
            async onToolStart(_p: ToolStartPayload<{ userId: string }>) { counts.toolStart++; }
            async onToolEnd(_p: ToolEndPayload<{ userId: string }>) { counts.toolEnd++; }
            async onAgentStart() { counts.agentStart++; }
            async onAgentEnd() { counts.agentEnd++; }
        }
        const hooks = compositeHooks<{ userId: string }>(new MyHooks(), new MyHooks()); // prove composite fires both

        // Approval handler: approve the first call always — sticky by tool name.
        let approvalSeen = 0;
        const extras: AgentLoopExtras<{ userId: string }> = {
            context: { userId: "alice" },
            hooks,
            onStreamEvent: ((e) => { typedEvts.push(e); }) as OnStreamEvent,
            approvalHandler: async ({ toolName }) => {
                approvalSeen++;
                return { approved: true, always: true, toolName };
            },
            agentName: "parity-agent",
        };

        const state: AgentState = await runAgentGraph<{ userId: string }>(
            "calc 1+1 and 2+2",
            llm, reg, undefined,
            5, false, 128000,
            (kind, data) => evts.push({ kind, data }),
            undefined, undefined, undefined,
            false, false, false, false, 120, 500, 0, undefined, undefined, 3,
            extras,
        );

        assert(state.status === "done", "agent completes end-to-end");
        // Usage
        assert(!!state.usage && state.usage.requests >= 3, `usage.requests accumulated (=${state.usage?.requests ?? 0})`);
        assert((state.usage?.totalTokens ?? 0) > 0, "usage.totalTokens > 0");
        const runCtxTyped = state.runContext as RunContext<{ userId: string }> | undefined;
        assert(runCtxTyped?.context?.userId === "alice", "runContext.context threaded through to AgentState");

        // Hooks fired — composite hooks count each hook twice (2 MyHooks instances).
        assert(counts.runStart === 2 && counts.runEnd === 2, "composite onRunStart/onRunEnd fired per layer");
        assert(counts.llmStart >= 2 && counts.llmEnd >= 2, "onLLMStart/onLLMEnd fired");
        assert(counts.toolStart >= 2 && counts.toolEnd >= 2, "onToolStart/onToolEnd fired");
        assert(counts.agentStart >= 2 && counts.agentEnd >= 2, "onAgentStart/onAgentEnd fired");

        // Approval — only asked once due to sticky "always"
        assert(approvalSeen === 1, `approvalHandler consulted once, then sticky (saw=${approvalSeen})`);

        // Typed events
        assert(typedEvts.some((e) => e.kind === "usage"), "typed usage event emitted");
        assert(typedEvts.some((e) => e.kind === "tool_started"), "typed tool_started event emitted");
    }

    // ── 7. Input guardrail — REJECT_CONTENT short-circuits ──────────
    section("7a. Input guardrail REJECT_CONTENT");
    {
        const llm = new MockLLM(["Hello!"]);
        const guard = inputGuardrail<unknown>("block-foo", (_ctx, task) =>
            task.includes("foo")
                ? GuardrailResult.reject("blocked by policy", { message: "contains foo" })
                : GuardrailResult.allow(),
        );
        const state = await runAgentGraph(
            "please foo the bar",
            llm, undefined, undefined,
            3, false, 128000, undefined,
            undefined, undefined, undefined,
            false, false, false, false, 120, 500, 0, undefined, undefined, 3,
            { inputGuardrails: [guard] },
        );
        assert(state.guardrailTripped?.source === "input", "state.guardrailTripped.source === 'input'");
        assert(state.guardrailTripped?.behavior === GuardrailBehavior.REJECT_CONTENT, "input guardrail recorded REJECT_CONTENT");
        assert(state.result === "blocked by policy", "result swapped with replacementOutput");
        assert(llm.callCount === 0, "LLM never called when input guardrail rejects");
    }

    // ── 7b. Output guardrail — REJECT_CONTENT after the run ─────────
    section("7b. Output guardrail REJECT_CONTENT");
    {
        const llm = new MockLLM(["the secret word is banana"]);
        const guard = outputGuardrail<unknown>("no-banana", (_ctx, output) =>
            output.includes("banana")
                ? GuardrailResult.reject("[redacted]", { message: "banana is verboten" })
                : GuardrailResult.allow(),
        );
        const state = await runAgentGraph(
            "say something",
            llm, undefined, undefined,
            3, false, 128000, undefined,
            undefined, undefined, undefined,
            false, false, false, false, 120, 500, 0, undefined, undefined, 3,
            { outputGuardrails: [guard] },
        );
        assert(state.guardrailTripped?.source === "output", "state.guardrailTripped.source === 'output'");
        assert(state.guardrailTripped?.behavior === GuardrailBehavior.REJECT_CONTENT, "output guardrail recorded REJECT_CONTENT");
        assert(state.result === "[redacted]", "output guardrail replacement applied");
    }

    // ── 7c. Guardrail RAISE_EXCEPTION throws GuardrailTripwireTriggered
    section("7c. Input guardrail RAISE_EXCEPTION");
    {
        const llm = new MockLLM(["nope"]);
        const guard = inputGuardrail<unknown>("panic", () =>
            GuardrailResult.raiseExc("nuke"),
        );
        let threw: unknown = null;
        try {
            await runAgentGraph(
                "boom", llm, undefined, undefined,
                3, false, 128000, undefined,
                undefined, undefined, undefined,
                false, false, false, false, 120, 500, 0, undefined, undefined, 3,
                { inputGuardrails: [guard] },
            );
        } catch (err) { threw = err; }
        assert(threw instanceof GuardrailTripwireTriggered, "raiseExc throws GuardrailTripwireTriggered");
        assert(
            threw instanceof GuardrailTripwireTriggered && threw.where === "input",
            "tripwire exception records where=input",
        );
    }

    // ── 8. outputType structured parsing ───────────────────────────
    section("8. outputType structured output");
    {
        const llm = new MockLLM(['{"ok":true,"value":42}']);
        let seen: unknown = null;
        const state = await runAgentGraph(
            "emit json", llm, undefined, undefined,
            2, false, 128000,
            (kind, data) => { if (kind === "final_output") seen = data.finalOutput; },
            undefined, undefined, undefined,
            false, false, false, false, 120, 500, 0, undefined, undefined, 3,
            {
                outputType: (raw: string) => {
                    const m = raw.match(/\{[\s\S]*\}/);
                    return m ? JSON.parse(m[0]) : null;
                },
            },
        );
        assert((state.finalOutput as any)?.value === 42, "state.finalOutput populated from outputType function");
        assert((seen as any)?.ok === true, "final_output event fired with parsed object");
    }

    // ── 9b. Approval: rejection path ──────────────────────────────
    section("9b. Approval rejection path");
    {
        const llm = new MockLLM([
            '```json\n{"tool": "calculate", "args": {"expression": "1+1"}}\n```',
            "Giving up.",
        ]);
        const reg = new ToolRegistry();
        reg.register(mathTool());

        const rejLog: string[] = [];
        const state = await runAgentGraph(
            "compute",
            llm, reg, undefined,
            3, false, 128000,
            (kind, data) => { if (kind === "tool_skipped") rejLog.push(String(data.name)); },
            undefined, undefined, undefined,
            false, false, false, false, 120, 500, 0, undefined, undefined, 3,
            {
                approvalHandler: async () => ({ approved: false, reason: "nope" }),
            },
        );
        assert(state.status !== "error", "run continues despite rejection");
        assert(state.toolCalls === 0, "rejected tool call does not increment toolCalls");
        assert(rejLog.includes("calculate"), "tool_skipped event emitted for rejected call");
    }

    // ── 10. Session backends ───────────────────────────────────────
    section("10. Session backends (InMemory + Jsonl)");
    {
        const mem = new InMemorySession("unit-test");
        const msgs: LLMMessage[] = [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
        ];
        await mem.addItems(msgs);
        const items = await mem.getItems();
        assert(items.length === 2 && items[0].role === "user", "InMemorySession round-trips messages");
        const last = await mem.getItems(1);
        assert(last.length === 1 && last[0].content === "hello", "InMemorySession supports limit=N tail");
        const popped = await mem.popItem();
        assert(popped?.content === "hello", "InMemorySession popItem returns last message");

        const tmp = mkdtempSync(join(tmpdir(), "clawagents-sess-"));
        try {
            const s = new JsonlFileSession("unit", { dir: tmp });
            const persistMsgs: LLMMessage[] = [
                { role: "user", content: "saved" },
                { role: "assistant", content: "persisted" },
            ];
            await s.addItems(persistMsgs);
            const s2 = new JsonlFileSession("unit", { dir: tmp });
            const back = await s2.getItems();
            assert(back.length === 2 && back[1].content === "persisted", "JsonlFileSession round-trips across instances");
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    }

    // ── 10b. Session preload into a run ───────────────────────────
    section("10b. Session preload into a run");
    {
        const sess = new InMemorySession("preload-test");
        const preload: LLMMessage[] = [{ role: "user", content: "remember: sky is blue" }];
        await sess.addItems(preload);
        const llm = new MockLLM(["Got it."]);
        const state = await runAgentGraph(
            "what color is the sky?",
            llm, undefined, undefined,
            2, false, 128000, undefined,
            undefined, undefined, undefined,
            false, false, false, false, 120, 500, 0, undefined, undefined, 3,
            { session: sess },
        );
        assert(state.status === "done", "run with preloaded session completes");
        const items = await sess.getItems();
        assert(items.length > 1, "session grew during the run (new messages persisted)");
    }

    // ── Summary ────────────────────────────────────────────────────
    console.log(`\n${"━".repeat(60)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    if (failed > 0) {
        console.error(`\nFailures:`);
        for (const f of failures) console.error(`  - ${f}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
