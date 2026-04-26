import test from "node:test";
import assert from "node:assert/strict";

import { runAgentGraph } from "./graph/agent-loop.js";
import type { LLMMessage, LLMProvider } from "./providers/llm.js";
import type { Session } from "./session/backends.js";
import { ToolRegistry } from "./tools/registry.js";

class RecordingSession implements Session {
    readonly sessionId = "test";
    seenLimit: number | undefined;

    async getItems(limit?: number): Promise<LLMMessage[]> {
        this.seenLimit = limit;
        return [{ role: "user", content: "prior" }];
    }

    async addItems(): Promise<void> {}
    async popItem(): Promise<LLMMessage | null> { return null; }
    async clearSession(): Promise<void> {}
}

const llm: LLMProvider = {
    name: "mock",
    async chat() {
        return { content: "done", model: "mock", tokensUsed: 1 };
    },
};

test("agent loop preloads sessions with a bounded default limit", async () => {
    const session = new RecordingSession();

    await runAgentGraph(
        "task",
        llm,
        new ToolRegistry(),
        undefined,
        1,
        false,
        10_000,
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
        { session },
    );

    assert.equal(session.seenLimit, 200);
});
