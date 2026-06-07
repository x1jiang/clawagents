/**
 * Integration tests for consolidated search, tools, lessons, and output paths.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SqliteSession } from "./session/backends.js";
import type { LLMMessage } from "./providers/llm.js";
import {
    formatSearchHistoryResponse,
    searchHistory,
} from "./session/history-search.js";
import { createSearchHistoryTool } from "./tools/search-history.js";
import { createSkillWorkshopTool } from "./tools/skill-workshop.js";
import {
    lessonKey,
    normalizeLesson,
    parseLessonBullets,
    slugifyLessonName,
} from "./trajectory/lessons.js";
import { maybePromoteRecurringLessons } from "./trajectory/lesson-promotion.js";
import { createClawAgent } from "./agent.js";
import type { LLMProvider } from "./providers/llm.js";

const fakeLLM: LLMProvider = {
    name: "fake",
    async chat() {
        return { content: "ok", role: "assistant", model: "fake", tokensUsed: 0 };
    },
};

test("lesson utilities are canonical in lessons module", () => {
    const bullet = "- Always grep before reading large files";
    assert.equal(normalizeLesson(bullet), normalizeLesson("  - Always grep before reading large files  "));
    assert.equal(lessonKey(bullet), lessonKey("- always grep before reading large files"));
    assert.ok(parseLessonBullets(`intro\n${bullet}\n`).includes(bullet.replace(/^-\s*/, "")));
    const slug = slugifyLessonName(bullet);
    assert.ok(slug.includes("-"));
});

test("search_history session filter and json format", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-consolidate-"));
    const dbPath = join(dir, ".clawagents", "sessions.db");
    mkdirSync(join(dir, ".clawagents"), { recursive: true });

    const s1 = new SqliteSession("only-alpha", { dbPath });
    await s1.addItems([{ role: "user", content: "alpha canary token" } as LLMMessage]);
    await s1.close();
    const s2 = new SqliteSession("only-beta", { dbPath });
    await s2.addItems([{ role: "user", content: "beta canary token" } as LLMMessage]);
    await s2.close();

    const filtered = searchHistory("canary", { workspace: dir, sessionId: "only-alpha", includeJsonl: false });
    assert.ok(filtered.length > 0);
    assert.ok(filtered.every((h) => h.sessionId === "only-alpha"));

    const tool = createSearchHistoryTool(dir);
    const result = await tool.execute({
        query: "canary",
        session_id: "only-beta",
        format: "json",
        include_jsonl: false,
    });
    assert.equal(result.success, true);
    const payload = JSON.parse(String(result.output)) as { query: string; hits: Array<{ session_id: string }> };
    assert.equal(payload.query, "canary");
    assert.ok(payload.hits.length > 0);
    assert.ok(payload.hits.every((h) => h.session_id === "only-beta"));

    const text = formatSearchHistoryResponse("canary", filtered);
    assert.match(text, /Found \d+ match/);
    assert.match(text, /only-alpha/);
});

test("search_history jsonl archive", () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-jsonl-"));
    const sessionsDir = join(dir, ".clawagents", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
        join(sessionsDir, "jsonl-session.jsonl"),
        `${JSON.stringify({ type: "assistant_message", content: "jsonl unique marker xyzzy", ts: 1 })}\n`,
        "utf-8",
    );
    const hits = searchHistory("xyzzy", { workspace: dir, includeJsonl: true, limit: 5 });
    assert.ok(hits.some((h) => h.source === "jsonl" && h.sessionId === "jsonl-session"));
});

test("skill_workshop tool end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-workshop-"));
    const skills = join(dir, "skills");
    mkdirSync(skills);
    const tool = createSkillWorkshopTool(dir, skills);

    const created = await tool.execute({
        action: "create",
        name: "consolidated-skill",
        description: "From tool",
        body: "# Consolidated\nDo things.",
        goal: "test",
    });
    assert.equal(created.success, true, created.error);
    const data = JSON.parse(String(created.output)) as { id: string; status: string };
    assert.equal(data.status, "pending");

    const applied = await tool.execute({ action: "apply", proposal_id: data.id });
    assert.equal(applied.success, true, applied.error);
    assert.ok(readFileSync(join(skills, "consolidated-skill", "SKILL.md"), "utf-8").includes("Consolidated"));
});

test("lesson promotion uses lessons module and creates proposal", () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-promote2-"));
    const lesson = "- Prefer grep before reading large log files";
    let created: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 3; i++) {
        created = maybePromoteRecurringLessons(lesson, { task: "debug", workspace: dir, minOccurrences: 3 });
    }
    assert.ok(created.length > 0);
    assert.equal(created[0]?.status, "pending");
});

test("snippet shared between session and history search", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-snip-"));
    const dbPath = join(dir, ".clawagents", "sessions.db");
    mkdirSync(join(dir, ".clawagents"), { recursive: true });
    const needle = "UNIQUE_SNIPPET_NEEDLE_42";
    const session = new SqliteSession("snip", { dbPath });
    await session.addItems([{ role: "user", content: `prefix ${needle} suffix` } as LLMMessage]);

    const inSession = await session.search(needle, { limit: 5 });
    await session.close();

    const cross = searchHistory(needle, { workspace: dir, includeJsonl: false });
    assert.ok(inSession.length > 0 && cross.length > 0);
    const hasNeedle = (s: string) => s.includes(needle) || s.includes(`[${needle}]`);
    assert.ok(hasNeedle(inSession[0]!.snippet));
    assert.ok(hasNeedle(cross[0]!.snippet));
});

test("createClawAgent registers consolidated tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-agent-tools-"));
    const prev = process.cwd();
    process.chdir(dir);
    try {
        const agent = await createClawAgent({
            model: fakeLLM,
            memory: [],
            skills: [],
        });
        const names = new Set(agent.tools.inspectTools().map((t) => t.name));
        assert.ok(names.has("search_history"));
        assert.ok(names.has("skill_workshop"));
    } finally {
        process.chdir(prev);
    }
});
