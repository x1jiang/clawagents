/**
 * Hermetic tests for the RL fine-tuning adapter.
 *
 * Mirrors `clawagents_py/tests/test_rl.py`. None of these tests require
 * `trl` or any HTTP server — only the standard Node runtime.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
    AtroposAdapter,
    compositeScorer,
    containsScorer,
    exactMatchScorer,
    exportAtroposRolloutsJsonl,
    exportJsonl,
    exportTrlSftJsonl,
    lengthPenaltyScorer,
    loadJsonl,
    MissingRLDependencyError,
    regexScorer,
    RLError,
    RLRecorder,
    Trajectory,
    toolCall,
    trajectoryStep,
    scoreAll,
    toAtroposRollout,
    toChatML,
    toTrlDpo,
    toTrlSft,
    TrlAdapter,
} from "./index.js";

function tmpFile(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `clawagents-rl-${prefix}-`));
    return path.join(dir, `${prefix}.jsonl`);
}

// ──────────────────────────────────────────────────────────────────────
// Trajectory data model
// ──────────────────────────────────────────────────────────────────────

test("trajectory adds messages with the right roles", () => {
    const t = new Trajectory({ task: "demo", model: "gpt-mock" });
    t.addSystem("you are helpful");
    t.addUser("hello");
    t.addAssistant("hi");
    assert.deepEqual(
        t.steps.map((s) => s.role),
        ["system", "user", "assistant"]
    );
    assert.equal(t.length, 3);
    assert.equal(t.assistantText, "hi");
    assert.equal(t.finalAssistant?.content, "hi");
});

test("trajectory round-trips through JSON", () => {
    const t = new Trajectory({ task: "demo", model: "gpt-mock" });
    t.addUser("solve it");
    const tc = toolCall({
        id: "c1",
        name: "calculator",
        arguments: { x: 1 },
        result: "ok",
    });
    t.addAssistant("here", [tc]);
    t.addTool("ok", { toolCallId: "c1", name: "calculator" });
    t.reward = 0.5;
    t.rewards.match = 1.0;

    const back = Trajectory.fromJson(t.toJson());
    assert.equal(back.runId, t.runId);
    assert.equal(back.task, t.task);
    assert.equal(back.steps.length, t.steps.length);
    assert.equal(back.reward, 0.5);
    assert.equal(back.rewards.match, 1.0);
    const assistantStep = back.steps[1];
    assert.equal(assistantStep.toolCalls.length, 1);
    assert.equal(assistantStep.toolCalls[0].name, "calculator");
});

test("toolCall and trajectoryStep helpers fill defaults", () => {
    const tc = toolCall({ id: "x", name: "y" });
    assert.equal(tc.success, true);
    assert.equal(tc.result, "");
    assert.deepEqual(tc.arguments, {});

    const step = trajectoryStep({ role: "assistant" });
    assert.equal(step.content, "");
    assert.equal(step.toolCalls.length, 0);
    assert.deepEqual(step.metadata, {});
});

// ──────────────────────────────────────────────────────────────────────
// Recorder
// ──────────────────────────────────────────────────────────────────────

test("recorder captures a simple user → assistant turn", () => {
    const rec = new RLRecorder({ task: "demo" });
    rec.addUser("hi");
    rec.observe("assistant_message", { content: "hello back" });
    const t = rec.finalise({});
    assert.deepEqual(
        t.steps.map((s) => s.role),
        ["user", "assistant"]
    );
    assert.equal(t.steps[1].content, "hello back");
});

test("recorder assembles assistant → tool_call → tool_result → assistant", () => {
    const rec = new RLRecorder({ task: "demo" });
    rec.addUser("compute");
    rec.observe("tool_call", {
        id: "c1",
        name: "calc",
        arguments: { x: 1 },
    });
    rec.observe("tool_result", { id: "c1", result: "2" });
    rec.observe("assistant_message", { content: "answer is 2" });
    const t = rec.finalise({});

    assert.deepEqual(
        t.steps.map((s) => s.role),
        ["user", "assistant", "tool", "assistant"]
    );
    const firstAsst = t.steps[1];
    assert.equal(firstAsst.toolCalls.length, 1);
    assert.equal(firstAsst.toolCalls[0].name, "calc");
    assert.equal(firstAsst.toolCalls[0].result, "2");

    const toolStep = t.steps[2];
    assert.equal(toolStep.toolCallId, "c1");
    assert.equal(toolStep.content, "2");

    const finalAsst = t.steps[3];
    assert.equal(finalAsst.content, "answer is 2");
});

test("recorder pairs tool_result by name when call_id is missing", () => {
    const rec = new RLRecorder();
    rec.observe("tool_call", { name: "search", arguments: { q: "cats" } });
    rec.observe("tool_result", { name: "search", result: "many" });
    rec.observe("assistant_message", { content: "done" });
    const t = rec.finalise({});

    const asst = t.steps.find((s) => s.role === "assistant" && s.toolCalls.length > 0);
    assert.ok(asst, "expected an assistant step with tool calls");
    assert.equal(asst!.toolCalls[0].name, "search");
});

test("recorder truncates oversized tool results", () => {
    const rec = new RLRecorder({ config: { maxToolResultChars: 10 } });
    rec.observe("tool_call", { id: "c1", name: "echo" });
    rec.observe("tool_result", { id: "c1", result: "x".repeat(50) });
    rec.observe("assistant_message", { content: "ok" });
    const t = rec.finalise({});
    const asst = t.steps[0];
    assert.equal(asst.toolCalls[0].result.length, 11); // 10 chars + "…"
    assert.ok(asst.toolCalls[0].result.endsWith("…"));
});

test("recorder redacts tool args when configured", () => {
    const rec = new RLRecorder({ config: { redactToolArgs: true } });
    rec.observe("tool_call", { id: "c1", name: "secret", arguments: { token: "x" } });
    rec.observe("tool_result", { id: "c1", result: "ok" });
    rec.observe("assistant_message", { content: "done" });
    const t = rec.finalise({});
    const asst = t.steps[0];
    assert.deepEqual(asst.toolCalls[0].arguments, { _redacted: true });
});

test("recorder ignores events after finalise", () => {
    const rec = new RLRecorder();
    rec.observe("assistant_message", { content: "hello" });
    rec.finalise({});
    rec.observe("assistant_message", { content: "ignored" });
    assert.equal(rec.trajectory.assistantText, "hello");
});

test("recorder.finalise prepends prompt only if no user/system step exists", () => {
    const rec = new RLRecorder();
    rec.observe("assistant_message", { content: "hi" });
    const t = rec.finalise({ prompt: "say hi", final: "hi!" });
    assert.equal(t.steps[0].role, "user");
    assert.equal(t.steps[0].content, "say hi");
});

test("recorder.finalise appends final assistant only when different", () => {
    const rec = new RLRecorder();
    rec.addUser("hi");
    rec.observe("assistant_message", { content: "hello" });
    const t = rec.finalise({ final: "hello" });
    const assistantSteps = t.steps.filter((s) => s.role === "assistant");
    assert.equal(assistantSteps.length, 1);
});

test("recorder swallows handler errors", () => {
    const rec = new RLRecorder();
    rec.observe("tool_result", { id: 12345 as unknown as string });
    rec.observe("assistant_message", { content: "still alive" });
    const t = rec.finalise({});
    assert.ok(t.assistantText.includes("still alive"));
});

// ──────────────────────────────────────────────────────────────────────
// Scorers
// ──────────────────────────────────────────────────────────────────────

function makeReplyTraj(content: string): Trajectory {
    const t = new Trajectory({ task: "test" });
    t.addUser("q?");
    t.addAssistant(content);
    return t;
}

test("containsScorer requires every needle by default", () => {
    const t = makeReplyTraj("the answer is 42");
    assert.equal(containsScorer({ needles: ["42"] })(t), 1.0);
    assert.equal(containsScorer({ needles: ["42", "missing"] })(t), -1.0);
});

test("containsScorer supports partial credit", () => {
    const t = makeReplyTraj("the answer is 42");
    const s = containsScorer({
        needles: ["42", "cat"],
        partialCredit: true,
    })(t);
    assert.ok(s > -1 && s < 1, `expected partial credit, got ${s}`);
});

test("exactMatchScorer respects strip and case", () => {
    const t = makeReplyTraj("  Hello  ");
    assert.equal(exactMatchScorer({ expected: "Hello" })(t), 1.0);
    assert.equal(exactMatchScorer({ expected: "hello" })(t), -1.0);
    assert.equal(
        exactMatchScorer({ expected: "hello", caseSensitive: false })(t),
        1.0
    );
});

test("regexScorer handles invalid patterns gracefully", () => {
    const t = makeReplyTraj("answer: 42");
    assert.equal(regexScorer({ pattern: "answer: \\d+" })(t), 1.0);
    assert.equal(regexScorer({ pattern: "[invalid(" })(t), 0.0);
});

test("lengthPenaltyScorer rewards target length", () => {
    const t = makeReplyTraj("x".repeat(100));
    assert.equal(lengthPenaltyScorer({ targetChars: 100 })(t), 1.0);
    const s = lengthPenaltyScorer({ targetChars: 200, maxChars: 1000 })(t);
    assert.ok(s < 1.0);
    assert.equal(lengthPenaltyScorer({ maxChars: 50 })(t), -1.0);
});

test("compositeScorer blends weighted components", () => {
    const t = makeReplyTraj("the answer is 42");
    const blend = compositeScorer({
        scorers: [
            containsScorer({ needles: ["42"] }),
            lengthPenaltyScorer({ targetChars: 16 }),
        ],
        weights: [2, 1],
    });
    const s = blend(t);
    assert.ok(s >= -1 && s <= 1);
});

test("compositeScorer rejects mismatched weights", () => {
    assert.throws(() =>
        compositeScorer({
            scorers: [containsScorer({ needles: ["x"] })],
            weights: [1, 2],
        })
    );
});

test("scoreAll stashes results and computes mean reward", () => {
    const t = makeReplyTraj("the answer is 42");
    const out = scoreAll(t, {
        match: containsScorer({ needles: ["42"] }),
        len: lengthPenaltyScorer({ targetChars: 16 }),
    });
    assert.deepEqual(Object.keys(out).sort(), ["len", "match"]);
    assert.equal(t.rewards.match, out.match);
    assert.ok(t.reward !== null);
});

// ──────────────────────────────────────────────────────────────────────
// Export / ChatML / TRL / Atropos
// ──────────────────────────────────────────────────────────────────────

test("exportJsonl + loadJsonl round-trip", () => {
    const t1 = new Trajectory({ task: "a" });
    t1.addUser("hi");
    t1.addAssistant("yo");
    const t2 = new Trajectory({ task: "b" });
    t2.addUser("again");
    t2.addAssistant("sup");

    const file = tmpFile("rt");
    const n = exportJsonl([t1, t2], file);
    assert.equal(n, 2);

    const loaded = loadJsonl(file);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].task, "a");
    assert.equal(loaded[1].steps.length, 2);
});

test("toChatML inlines tool_calls on assistant turns", () => {
    const t = new Trajectory();
    t.addUser("compute");
    t.addAssistant("sure", [
        toolCall({
            id: "c1",
            name: "calc",
            arguments: { x: 1 },
            result: "2",
        }),
    ]);
    t.addTool("2", { toolCallId: "c1", name: "calc" });

    const msgs = toChatML(t);
    assert.equal(msgs.length, 3);
    const asst = msgs[1] as Record<string, unknown>;
    assert.ok(Array.isArray(asst.tool_calls));
    const tcMsg = (asst.tool_calls as Array<Record<string, unknown>>)[0];
    assert.equal(tcMsg.id, "c1");
    assert.equal((tcMsg.function as Record<string, string>).name, "calc");
    const toolMsg = msgs[2] as Record<string, unknown>;
    assert.equal(toolMsg.tool_call_id, "c1");
});

test("toTrlSft splits prompt and completion", () => {
    const t = new Trajectory({ task: "x" });
    t.addUser("hi");
    t.addAssistant("hello");
    const row = toTrlSft(t);
    const messages = row.messages as Array<Record<string, unknown>>;
    const prompt = row.prompt as Array<Record<string, unknown>>;
    const completion = row.completion as Array<Record<string, unknown>>;
    assert.equal(messages.length, 2);
    assert.ok(prompt.every((m) => m.role !== "assistant"));
    assert.equal(completion[0].role, "assistant");
    assert.equal(completion[0].content, "hello");
});

test("toTrlDpo creates a chosen/rejected pair", () => {
    const a = new Trajectory();
    a.addUser("hi");
    a.addAssistant("good");
    const b = new Trajectory();
    b.addUser("hi");
    b.addAssistant("bad");
    const row = toTrlDpo(a, b);
    const chosen = row.chosen as Array<Record<string, unknown>>;
    const rejected = row.rejected as Array<Record<string, unknown>>;
    assert.equal(chosen[0].content, "good");
    assert.equal(rejected[0].content, "bad");
});

test("toAtroposRollout shapes data for the harness", () => {
    const t = new Trajectory({ task: "x" });
    t.addUser("hi");
    t.addAssistant("done");
    t.reward = 0.7;
    t.rewards.match = 1.0;
    const r = toAtroposRollout(t);
    assert.equal(r.score, 0.7);
    assert.deepEqual(r.rewards, { match: 1.0 });
    assert.equal(((r.metadata as Record<string, unknown>).task as string), "x");
});


test("exportTrlSftJsonl + exportAtroposRolloutsJsonl write valid JSONL", () => {
    const t = new Trajectory({ task: "x" });
    t.addUser("hi");
    t.addAssistant("hello");
    t.reward = 1.0;

    const sftFile = tmpFile("sft");
    assert.equal(exportTrlSftJsonl([t], sftFile), 1);
    const sftText = fs.readFileSync(sftFile, "utf-8");
    const sftRow = JSON.parse(sftText.trim());
    assert.ok(sftRow.messages);

    const atroposFile = tmpFile("atropos");
    assert.equal(exportAtroposRolloutsJsonl([t], atroposFile), 1);
    const atrText = fs.readFileSync(atroposFile, "utf-8");
    const atrRow = JSON.parse(atrText.trim());
    assert.equal(atrRow.score, 1.0);
});

// ──────────────────────────────────────────────────────────────────────
// Adapters
// ──────────────────────────────────────────────────────────────────────

test("TrlAdapter buildSftRows yields one row per trajectory", () => {
    const t = new Trajectory();
    t.addUser("hi");
    t.addAssistant("yo");
    const rows = new TrlAdapter().buildSftRows([t]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].messages);
});

test("TrlAdapter buildDpoRows handles multiple pairs", () => {
    const a = new Trajectory();
    a.addUser("hi");
    a.addAssistant("good");
    const b = new Trajectory();
    b.addUser("hi");
    b.addAssistant("bad");
    const rows = new TrlAdapter().buildDpoRows([
        [a, b],
        [a, b],
    ]);
    assert.equal(rows.length, 2);
});

test("AtroposAdapter.submit pushes to a custom sink", async () => {
    const a = new Trajectory();
    a.addUser("hi");
    a.addAssistant("yo");
    const received: Array<Record<string, unknown>> = [];
    const adapter = new AtroposAdapter();
    const n = await adapter.submit([a], {
        sink: (r) => {
            received.push(r);
        },
    });
    assert.equal(n, 1);
    assert.equal(received.length, 1);
    assert.ok(received[0].messages);
});

test("AtroposAdapter.submit raises when no transport configured", async () => {
    const a = new Trajectory();
    a.addUser("hi");
    a.addAssistant("yo");
    await assert.rejects(() => new AtroposAdapter().submit([a]));
});

test("AtroposAdapter stopOnError=false swallows sink failures", async () => {
    const a = new Trajectory();
    a.addUser("hi");
    a.addAssistant("yo");
    const adapter = new AtroposAdapter();
    const n = await adapter.submit([a, a], {
        stopOnError: false,
        sink: () => {
            throw new Error("nope");
        },
    });
    assert.equal(n, 0);
});

test("AtroposAdapter.toRollouts produces dicts without transport", () => {
    const t = new Trajectory();
    t.addUser("hi");
    t.addAssistant("yo");
    t.reward = 0.3;
    const rollouts = new AtroposAdapter().toRollouts([t]);
    assert.equal(rollouts.length, 1);
    assert.equal(rollouts[0].score, 0.3);
});

// ──────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────

test("MissingRLDependencyError surfaces framework + hint", () => {
    const err = new MissingRLDependencyError("trl", "pip install trl");
    assert.ok(err instanceof RLError);
    assert.equal(err.framework, "trl");
    assert.equal(err.installHint, "pip install trl");
});
