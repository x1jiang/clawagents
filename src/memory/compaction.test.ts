/**
 * Tests for the hardened compression helpers in memory/compaction.ts.
 *
 * Mirrors `clawagents_py/tests/test_compaction_hardened.py`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    compressMessagesSafe,
    isCompressionThrashing,
    DEFAULT_PROTECT_FIRST,
    DEFAULT_PROTECT_LAST,
    INEFFECTIVE_SAVINGS_PCT,
    THRASH_THRESHOLD,
    type AgentMessage,
} from "./compaction.js";

class StubLLM {
    calls = 0;

    constructor(
        private readonly summary: string = "SUMMARY",
        private readonly fail = false,
    ) {}

    async chat(): Promise<{ content: string }> {
        this.calls += 1;
        if (this.fail) throw new Error("boom");
        return { content: this.summary };
    }
}

const m = (role: AgentMessage["role"], content: string): AgentMessage => ({ role, content });

describe("compressMessagesSafe", () => {
    it("protects head and tail and emits a summary in the middle", async () => {
        const messages = [
            m("system", "you are helpful"),
            m("user", "hello"),
            m("assistant", "hi"),
            m("user", "do task"),
            m("assistant", "ok"),
            m("user", "next?"),
        ];
        const res = await compressMessagesSafe({
            llm: new StubLLM("compressed-middle") as never,
            messages,
            contextWindow: 2048,
            protectFirstN: 1,
            protectLastN: 2,
        });
        assert.equal(res.messages[0]!.role, "system");
        assert.equal(res.messages[res.messages.length - 1]!.content, "next?");
        assert.ok(res.messages.some((mm) => mm.content === "compressed-middle"));
    });

    it("always keeps the last user message in the tail", async () => {
        const messages = [
            m("system", "sys"),
            m("assistant", "a1"),
            m("assistant", "a2"),
            m("assistant", "a3"),
            m("user", "active task"),
            m("assistant", "ack"),
        ];
        const res = await compressMessagesSafe({
            llm: new StubLLM("S") as never,
            messages,
            contextWindow: 2048,
            protectFirstN: 1,
            protectLastN: 1,
        });
        assert.ok(res.messages.some((mm) => mm.content === "active task"));
    });

    it("inserts a compression note into the system prompt", async () => {
        const messages = [
            m("system", "base"),
            m("user", "u1"),
            m("assistant", "a1"),
            m("user", "u2"),
            m("assistant", "a2"),
            m("user", "u3"),
        ];
        const res = await compressMessagesSafe({
            llm: new StubLLM("S") as never,
            messages,
            contextWindow: 2048,
            protectFirstN: 1,
            protectLastN: 2,
        });
        const sys = res.messages[0]!;
        assert.equal(sys.role, "system");
        assert.ok(/compacted/i.test(sys.content));
    });

    it("returns the original transcript when there is no middle", async () => {
        const messages = [m("system", "sys"), m("user", "go")];
        const res = await compressMessagesSafe({
            llm: new StubLLM("S") as never,
            messages,
            contextWindow: 2048,
            protectFirstN: 1,
            protectLastN: 2,
        });
        assert.equal(res.effective, false);
        assert.deepEqual(
            res.messages.map((mm) => mm.content),
            ["sys", "go"],
        );
    });

    it("handles empty input", async () => {
        const res = await compressMessagesSafe({
            llm: new StubLLM("S") as never,
            messages: [],
            contextWindow: 2048,
        });
        assert.deepEqual(res.messages, []);
        assert.equal(res.effective, false);
    });

    it("falls back gracefully when LLM throws", async () => {
        const messages = [
            m("system", "sys"),
            m("user", "u1"),
            m("assistant", "a1"),
            m("user", "u2"),
            m("assistant", "a2"),
            m("user", "active"),
        ];
        const res = await compressMessagesSafe({
            llm: new StubLLM("ignored", true) as never,
            messages,
            contextWindow: 2048,
            protectFirstN: 1,
            protectLastN: 2,
        });
        assert.equal(typeof res.summary, "string");
        assert.ok(res.summary.length > 0);
    });

    it("reports a positive savings percentage when middle is dropped", async () => {
        const big = "x".repeat(200);
        const middle: AgentMessage[] = [];
        for (let i = 0; i < 10; i += 1) {
            middle.push(m(i % 2 === 0 ? "user" : "assistant", big));
        }
        const messages = [m("system", "sys"), ...middle, m("user", "active")];
        const res = await compressMessagesSafe({
            llm: new StubLLM("tiny") as never,
            messages,
            contextWindow: 2048,
            protectFirstN: 1,
            protectLastN: 2,
        });
        assert.ok(res.compressionSavingsPct > 0);
    });
});

describe("isCompressionThrashing", () => {
    it("returns false when history is shorter than the threshold", () => {
        assert.equal(isCompressionThrashing([]), false);
        assert.equal(isCompressionThrashing([5]), false);
    });

    it("flags repeated low-savings runs", () => {
        assert.equal(isCompressionThrashing([5, 6]), true);
    });

    it("clears once a recent compression is effective", () => {
        assert.equal(isCompressionThrashing([5, 5, 50]), false);
    });
});

describe("constants", () => {
    it("are sane defaults", () => {
        assert.ok(DEFAULT_PROTECT_FIRST >= 1);
        assert.ok(DEFAULT_PROTECT_LAST >= 1);
        assert.ok(INEFFECTIVE_SAVINGS_PCT > 0);
        assert.ok(THRASH_THRESHOLD >= 1);
    });
});
