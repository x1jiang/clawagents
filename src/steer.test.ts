/**
 * Tests for clawagents/steer.ts.
 *
 * Mirrors `clawagents_py/tests/test_steer.py` to keep parity with the
 * Python sibling.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RunContext } from "./run-context.js";
import {
    NextTurnQueue,
    SteerHook,
    SteerQueue,
    drainNextTurn,
    drainSteer,
    peekNextTurn,
    peekSteer,
    queueMessage,
    steer,
    type SteerMessage,
} from "./steer.js";

describe("SteerQueue / NextTurnQueue", () => {
    it("push and drain roundtrip preserves order and roles", () => {
        const q = new SteerQueue();
        assert.equal(q.length, 0);
        q.push("first");
        q.push({ text: "second", role: "system" });
        assert.equal(q.length, 2);
        const out = q.drain();
        assert.deepEqual(out.map(m => m.text), ["first", "second"]);
        assert.equal(out[1]!.role, "system");
        assert.equal(q.length, 0);
    });

    it("extend() accepts a mixed iterable of strings and SteerMessages", () => {
        const q = new SteerQueue();
        q.extend(["a", "b", { text: "c", role: "developer" }]);
        const drained = q.drain();
        assert.deepEqual(drained.map(m => m.text), ["a", "b", "c"]);
    });

    it("peek() returns a copy that can be mutated without affecting the queue", () => {
        const q = new SteerQueue();
        q.push("hi");
        const snap = q.peek();
        assert.deepEqual(snap.map(m => m.text), ["hi"]);
        snap.length = 0;  // clear the snapshot
        assert.equal(q.length, 1);
        assert.deepEqual(q.peek().map(m => m.text), ["hi"]);
    });
});

describe("RunContext attachment", () => {
    it("steer() lazily attaches a SteerQueue and survives draining", () => {
        const rc = new RunContext();
        steer(rc, "please switch to Python", { role: "user" });
        const pending = peekSteer(rc);
        assert.equal(pending.length, 1);
        assert.equal(pending[0]!.text, "please switch to Python");
        assert.equal(pending[0]!.role, "user");
        const drained = drainSteer(rc);
        assert.equal(drained.length, 1);
        assert.deepEqual(peekSteer(rc), []);
    });

    it("queueMessage() is independent from the steer queue", () => {
        const rc = new RunContext();
        steer(rc, "mid-run nudge");
        queueMessage(rc, "after-run task");
        assert.deepEqual(peekSteer(rc).map(m => m.text), ["mid-run nudge"]);
        assert.deepEqual(peekNextTurn(rc).map(m => m.text), ["after-run task"]);
        drainSteer(rc);
        assert.deepEqual(peekSteer(rc), []);
        assert.deepEqual(peekNextTurn(rc).map(m => m.text), ["after-run task"]);
        drainNextTurn(rc);
        assert.deepEqual(peekNextTurn(rc), []);
    });

    it("draining an empty queue returns []", () => {
        const rc = new RunContext();
        assert.deepEqual(drainSteer(rc), []);
        assert.deepEqual(drainNextTurn(rc), []);
    });

    it("SteerQueue and NextTurnQueue do not collide via metadata", () => {
        const rc = new RunContext();
        queueMessage(rc, "later");
        // Even though both live on _metadata, peeking the steer queue
        // must NOT return the next-turn message.
        assert.deepEqual(peekSteer(rc), []);
        assert.deepEqual(peekNextTurn(rc).map(m => m.text), ["later"]);
    });
});

describe("SteerHook.onLLMStart", () => {
    it("appends [steer]-prefixed user messages to the live messages array", async () => {
        const rc = new RunContext();
        steer(rc, "be terse");
        steer(rc, "use bullets");

        const hook = new SteerHook();
        const messages: { role: "user" | "system" | "assistant" | "tool"; content: string }[] = [
            { role: "user", content: "hello" },
        ];
        await hook.onLLMStart({
            runContext: rc as RunContext<unknown>,
            agentName: "test",
            iteration: 0,
            messages,
        });

        assert.deepEqual(messages, [
            { role: "user", content: "hello" },
            { role: "user", content: "[steer] be terse" },
            { role: "user", content: "[steer] use bullets" },
        ]);
        assert.deepEqual(peekSteer(rc), []);
    });

    it("is a no-op when the queue is empty", async () => {
        const rc = new RunContext();
        const hook = new SteerHook();
        const messages: { role: "user"; content: string }[] = [{ role: "user", content: "hi" }];
        await hook.onLLMStart({
            runContext: rc as RunContext<unknown>,
            agentName: "test",
            iteration: 0,
            messages,
        });
        assert.deepEqual(messages, [{ role: "user", content: "hi" }]);
    });

    it("respects a null prefix and a custom prefix", async () => {
        const rc1 = new RunContext();
        steer(rc1, "compress now");
        const hook1 = new SteerHook({ prefix: null });
        const m1: { role: "user"; content: string }[] = [];
        await hook1.onLLMStart({
            runContext: rc1 as RunContext<unknown>,
            agentName: "t",
            iteration: 0,
            messages: m1,
        });
        assert.deepEqual(m1, [{ role: "user", content: "compress now" }]);

        const rc2 = new RunContext();
        steer(rc2, "switch language", { role: "system" });
        const hook2 = new SteerHook({ prefix: "[op]" });
        const m2: { role: "system" | "user"; content: string }[] = [];
        await hook2.onLLMStart({
            runContext: rc2 as RunContext<unknown>,
            agentName: "t",
            iteration: 0,
            messages: m2,
        });
        assert.deepEqual(m2, [{ role: "system", content: "[op] switch language" }]);
    });

    it("falls back to role=user when the requested role is not LLM-valid", async () => {
        const rc = new RunContext();
        steer(rc, "thought block", { role: "developer" }); // not allowed by LLMMessage.role
        const hook = new SteerHook({ prefix: null });
        const messages: { role: "user" | "system" | "assistant" | "tool"; content: string }[] = [];
        await hook.onLLMStart({
            runContext: rc as RunContext<unknown>,
            agentName: "t",
            iteration: 0,
            messages,
        });
        assert.equal(messages.length, 1);
        assert.equal(messages[0]!.role, "user");
        assert.equal(messages[0]!.content, "thought block");
    });

    it("is a no-op if onLLMStart is fired without messages (legacy callers)", async () => {
        const rc = new RunContext();
        steer(rc, "should remain queued");
        const hook = new SteerHook();
        await hook.onLLMStart({
            runContext: rc as RunContext<unknown>,
            agentName: "t",
            iteration: 0,
            // messages omitted
        });
        // Pending message is preserved because the hook had no live array
        // to mutate.
        assert.deepEqual(peekSteer(rc).map((m: SteerMessage) => m.text), ["should remain queued"]);
    });
});

describe("Class identity", () => {
    it("SteerQueue and NextTurnQueue are distinct classes", () => {
        const a = new SteerQueue();
        const b = new NextTurnQueue();
        assert.ok(a instanceof SteerQueue);
        assert.ok(!(a instanceof NextTurnQueue));
        assert.ok(b instanceof NextTurnQueue);
        assert.ok(!(b instanceof SteerQueue));
    });
});
