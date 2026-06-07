/**
 * Tests for peer-inspired features (OpenClaw, OpenHarness, DeepAgents, Hermes).
 *
 * Mirrors clawagents_py/tests/test_peer_inspired_features.py.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("skill workshop create scan apply rollback", async () => {
    const root = mkdtempSync(join(tmpdir(), "claw-workshop-"));
    const skills = join(root, "skills");
    mkdirSync(skills);

    const { SkillWorkshopService } = await import("./skills/workshop/service.js");
    const svc = new SkillWorkshopService(root, skills);
    const created = svc.create({
        name: "demo-skill",
        description: "Demo",
        body: "# Demo\nDo the thing.",
        goal: "test",
    });
    assert.equal(created.status, "pending");
    const proposalId = String(created.id);
    const applied = svc.apply(proposalId);
    assert.equal(applied.ok, true);
    assert.ok(existsSync(join(skills, "demo-skill", "SKILL.md")));
    const rollbackId = String(applied.rollback_id);
    assert.ok(rollbackId);
    writeFileSync(join(skills, "demo-skill", "SKILL.md"), "# mutated", "utf-8");
    const rolled = svc.rollback(rollbackId);
    assert.equal(rolled.ok, true);
    // Create rollback removes a skill that did not exist before apply.
    assert.equal(existsSync(join(skills, "demo-skill", "SKILL.md")), false);
});

test("known poll no progress detects streak", async () => {
    const { detectKnownPollNoProgress, hashToolCall } = await import("./loop-detection.js");
    const cfg = { warningThreshold: 2, criticalThreshold: 3 };
    const args = { command: "sleep 1" };
    const h = hashToolCall("execute", args);
    const history: Array<[string, string, string | null]> = [
        ["execute", h, "same"],
        ["execute", h, "same"],
    ];
    const warn = detectKnownPollNoProgress({ toolName: "execute", params: args, history, config: cfg });
    assert.ok(warn);
    assert.equal(warn.level, "warning");
    history.push(["execute", h, "same"]);
    const crit = detectKnownPollNoProgress({ toolName: "execute", params: args, history, config: cfg });
    assert.ok(crit);
    assert.equal(crit.level, "critical");
});

test("tool output offload writes artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "claw-artifact-"));
    const prev = process.cwd();
    process.chdir(root);
    try {
        const { offloadToolOutputIfNeeded } = await import("./tool-output-artifacts.js");
        const big = "x".repeat(20_000);
        const [inline, path] = offloadToolOutputIfNeeded({
            toolName: "grep",
            toolUseId: "tc1",
            output: big,
            inlineLimit: 1000,
            workspace: root,
        });
        assert.ok(path);
        assert.ok(existsSync(path));
        assert.match(inline.toLowerCase(), /truncated|preview/);
    } finally {
        process.chdir(prev);
    }
});

test("compact tool results truncates tool messages", async () => {
    const { compactToolResults } = await import("./memory/compact-tool-results.js");
    const messages = [
        { role: "user" as const, content: "hi" },
        { role: "tool" as const, content: "a".repeat(50_000), toolCallId: "1" },
        { role: "tool" as const, content: "b".repeat(50_000), toolCallId: "2" },
    ];
    const [out, modified] = compactToolResults(messages, { maxInputTokens: 4000 });
    assert.equal(modified, true);
    for (const m of out) {
        if (m.role === "tool") assert.ok(m.content.length < 50_000);
    }
});

test("sqlite session search and undo", async () => {
    const root = mkdtempSync(join(tmpdir(), "claw-sqlite-"));
    const { SqliteSession } = await import("./session/backends.js");

    let session: InstanceType<typeof SqliteSession>;
    try {
        session = new SqliteSession("s1", { dbPath: join(root, "s.db") });
    } catch {
        test.skip("node:sqlite unavailable");
        return;
    }

    await session.addItems([
        { role: "user", content: "find the failing pytest case" },
        { role: "assistant", content: "I'll grep the logs" },
    ]);
    const hits = await session.search("pytest");
    assert.ok(hits.length > 0);
    const removed = await session.undoLast(1);
    assert.equal(removed.length, 1);
    const remaining = await session.getItems();
    assert.equal(remaining.length, 1);
    await session.close();
});

test("harness profile resolves for codex", async () => {
    const { resolveHarnessProfile } = await import("./harness-profiles.js");
    const profile = resolveHarnessProfile("gpt-5.3-codex-high");
    assert.ok(profile);
    assert.equal(profile.name, "openai-codex");
});

test("dry run includes skills hooks mcp preview", async () => {
    const root = mkdtempSync(join(tmpdir(), "claw-dryrun-"));
    const prev = process.cwd();
    const prevHome = process.env.HOME;
    process.chdir(root);
    process.env.HOME = root;
    try {
        const skills = join(root, "skills", "lint");
        mkdirSync(skills, { recursive: true });
        writeFileSync(join(skills, "SKILL.md"), "# lint", "utf-8");
        const hooks = join(root, ".clawagents", "hooks");
        mkdirSync(hooks, { recursive: true });
        writeFileSync(join(hooks, "pre_run.py"), "pass", "utf-8");
        const mcp = join(root, ".clawagents", "mcp.json");
        writeFileSync(mcp, JSON.stringify({ mcpServers: { demo: { command: "echo" } } }), "utf-8");

        const { buildDryRunPreview } = await import("./dry-run.js");
        const preview = await buildDryRunPreview({ task: "lint files", profile: "ollama" });
        assert.ok(preview.skillsPreview.includes("lint"));
        assert.ok(preview.hooksPreview.some((h) => h.includes("pre_run.py")));
        assert.ok(preview.mcpPreview.includes("demo"));
    } finally {
        process.chdir(prev);
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
    }
});

test("autopilot registry lists runners", async () => {
    const { AutopilotRegistry } = await import("./autopilot/index.js");
    const reg = new AutopilotRegistry();
    const runner = async () => ({ ok: true });
    reg.register("demo", runner);
    assert.ok(reg.listRunners().includes("demo"));
});
