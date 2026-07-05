/**
 * Regression tests for session persistence correctness (P1 backlog).
 *
 * The old implementation captured a numeric index (`sessionStartCursor`)
 * into `messages` at preload time and persisted `messages.slice(cursor)` at
 * the end of the run. Compaction rebuilds the list (shrinking it) and
 * dangling tool-call patching inserts items, so the slice persisted the
 * wrong range: after compaction the run's new turns were silently lost, and
 * patch inserts re-persisted duplicated preloaded messages.
 *
 * The fix tracks message *objects* by identity instead of by index.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runAgentGraph } from "./agent-loop.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../providers/llm.js";
import type { Session } from "../session/backends.js";
import { ToolRegistry, type ToolResult } from "../tools/registry.js";

class RecordingSession implements Session {
    readonly sessionId = "test";
    persisted: LLMMessage[] = [];

    constructor(private readonly preloaded: LLMMessage[]) {}

    async getItems(): Promise<LLMMessage[]> {
        return [...this.preloaded];
    }

    async addItems(items: LLMMessage[]): Promise<void> {
        this.persisted.push(...items);
    }

    async popItem(): Promise<LLMMessage | null> { return null; }
    async clearSession(): Promise<void> {}
}

/**
 * Returns a tool call, then a final answer; answers compaction summarize
 * prompts (single user message starting with "You are summarizing a chunk")
 * with a short deterministic summary.
 */
class CompactingMockLLM implements LLMProvider {
    readonly name = "mock";
    mainCalls = 0;
    summarizeCalls = 0;

    async chat(messages: LLMMessage[]): Promise<LLMResponse> {
        const isSummarize = messages.some(
            (m) => typeof m.content === "string"
                && m.content.startsWith("You are summarizing a chunk"),
        );
        if (isSummarize) {
            this.summarizeCalls++;
            return { content: "COMPACTION_SUMMARY", model: "mock", tokensUsed: 5 };
        }
        this.mainCalls++;
        if (this.mainCalls === 1) {
            return {
                content: "",
                model: "mock",
                tokensUsed: 10,
                toolCalls: [{ toolName: "echo", args: { x: "hello" }, toolCallId: "tc-1" }],
            };
        }
        return { content: "FINAL_ANSWER", model: "mock", tokensUsed: 10 };
    }
}

function preloadedHistory(nPairs: number): LLMMessage[] {
    const msgs: LLMMessage[] = [];
    for (let i = 0; i < nPairs; i++) {
        msgs.push({ role: "user", content: `prior-user-${i} ` + "x".repeat(600) });
        msgs.push({ role: "assistant", content: `prior-assistant-${i} ` + "y".repeat(600) });
    }
    return msgs;
}

function buildRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
        name: "echo",
        description: "Echo back the input",
        parameters: { x: { type: "string", description: "value", required: true } },
        async execute(args): Promise<ToolResult> {
            return { success: true, output: `echo:${JSON.stringify(args)}` };
        },
    });
    return registry;
}

async function runWithWindow(
    session: RecordingSession,
    llm: CompactingMockLLM,
    contextWindow: number,
) {
    return runAgentGraph(
        "TASK_MARKER do the thing",
        llm,
        buildRegistry(),
        undefined,
        6,          // maxIterations
        false,      // streaming
        contextWindow,
        undefined, undefined, undefined, undefined,
        true,       // useNativeTools
        false, false, false,
        120, 500, 0,
        undefined, undefined, 3,
        { session },
    );
}

test("compaction does not lose or duplicate persisted turns", async () => {
    const session = new RecordingSession(preloadedHistory(15)); // 30 messages
    const llm = new CompactingMockLLM();

    const state = await runWithWindow(session, llm, 2000);

    assert.equal(state.status, "done");
    assert.ok(
        llm.summarizeCalls > 0,
        "test setup problem: compaction never fired, so this test no longer "
        + "exercises the cursor-vs-compaction interaction",
    );

    const contents = session.persisted.map((m) => m.content);

    // No preloaded message may be re-persisted.
    const dupes = contents.filter((c) => c.startsWith("prior-"));
    assert.deepEqual(dupes, [], `preloaded messages re-persisted: ${dupes.slice(0, 3)}`);

    // No compaction artifact may be persisted.
    assert.ok(
        !contents.some((c) => c.includes("COMPACTION_SUMMARY")),
        "compaction summary leaked into the session store",
    );

    // The run's new turns must be present: tool call, tool result, final.
    assert.ok(
        session.persisted.some(
            (m) => m.role === "assistant"
                && m.toolCallsMeta?.some((tc) => tc.name === "echo"),
        ),
        "assistant tool-call turn was lost from the session store",
    );
    assert.ok(
        session.persisted.some(
            (m) => m.role === "tool" && m.content.startsWith("echo:"),
        ),
        "tool result turn was lost from the session store",
    );
    assert.ok(
        contents.includes("FINAL_ANSWER"),
        "final assistant answer was lost from the session store",
    );

    // And nothing is persisted twice.
    assert.equal(
        contents.length,
        new Set(contents).size,
        `duplicate persisted items: ${JSON.stringify(contents)}`,
    );
});

test("no-compaction baseline still persists new turns", async () => {
    const session = new RecordingSession(preloadedHistory(2));
    const llm = new CompactingMockLLM();

    const state = await runWithWindow(session, llm, 1_000_000);

    assert.equal(state.status, "done");
    assert.equal(llm.summarizeCalls, 0);
    const contents = session.persisted.map((m) => m.content);
    assert.ok(!contents.some((c) => c.startsWith("prior-")));
    assert.ok(contents.includes("FINAL_ANSWER"));
    assert.ok(
        session.persisted.some(
            (m) => m.role === "tool" && m.content.startsWith("echo:"),
        ),
    );
});
