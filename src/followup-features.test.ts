/**
 * Tests for search_history, output_format, and PTRL lesson promotion.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SqliteSession } from "./session/backends.js";
import type { LLMMessage } from "./providers/llm.js";
import { searchHistory } from "./session/history-search.js";
import { createSearchHistoryTool } from "./tools/search-history.js";
import { serializeAgentState } from "./output-format.js";
import type { AgentState } from "./graph/agent-loop.js";
import { maybePromoteRecurringLessons } from "./trajectory/lesson-promotion.js";

test("cross-session history search spans sqlite sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-history-"));
    const dbPath = join(dir, ".clawagents", "sessions.db");
    mkdirSync(join(dir, ".clawagents"), { recursive: true });
    const s1 = new SqliteSession("alpha", { dbPath });
    await s1.addItems([{ role: "user", content: "fix pytest timeout in api tests" } as LLMMessage]);
    await s1.close();
    const s2 = new SqliteSession("beta", { dbPath });
    await s2.addItems([{ role: "assistant", content: "grep logs for pytest failure" } as LLMMessage]);
    await s2.close();

    const hits = searchHistory("pytest", { workspace: dir, limit: 10, includeJsonl: false });
    assert.ok(hits.length >= 2);
    const sessionIds = new Set(hits.map((h) => h.sessionId));
    assert.ok(sessionIds.has("alpha"));
    assert.ok(sessionIds.has("beta"));
});

test("search_history tool returns matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-history-tool-"));
    mkdirSync(join(dir, ".clawagents"), { recursive: true });
    const dbPath = join(dir, ".clawagents", "sessions.db");
    const session = new SqliteSession("s1", { dbPath });
    await session.addItems([{ role: "user", content: "deploy canary to staging" } as LLMMessage]);

    const tool = createSearchHistoryTool(dir);
    const hits = searchHistory("canary", { workspace: dir, limit: 10, includeJsonl: false });
    assert.ok(hits.length > 0);
    const result = await tool.execute({ query: "canary", include_jsonl: false });
    const out = typeof result.output === "string" ? result.output : String(result.output);
    assert.ok(out.includes("staging"));
});

test("serializeAgentState captures core fields", () => {
    const state = {
        messages: [],
        currentTask: "hi",
        status: "done",
        result: "hello world",
        iterations: 2,
        maxIterations: 10,
        toolCalls: 1,
    } as AgentState;
    const payload = serializeAgentState(state);
    assert.equal(payload.status, "done");
    assert.equal(payload.result, "hello world");
    assert.equal(payload.iterations, 2);
});

test("lesson promotion creates workshop proposal after threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-promote-"));
    const lesson = "- Prefer grep before reading large log files";
    const md = `${lesson}\n`;
    let created: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 3; i++) {
        created = maybePromoteRecurringLessons(md, { task: "debug logs", workspace: dir, minOccurrences: 3 });
    }
    assert.ok(created.length > 0);
    assert.equal(created[0]?.status, "pending");
    const index = JSON.parse(
        readFileSync(join(dir, ".clawagents", "lesson-index.json"), "utf-8"),
    ) as { lessons: Record<string, { promoted_proposal_id?: string | null }> };
    assert.ok(Object.values(index.lessons).some((e) => e.promoted_proposal_id));
});
