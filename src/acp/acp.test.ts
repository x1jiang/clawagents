/**
 * Hermetic tests for the ACP adapter.
 *
 * These tests run without the optional `@zed-industries/agent-client-protocol`
 * package — they cover the message types, the agent → ACP translation
 * pipeline, and the in-memory prompt runner. Mirrors the Python
 * `tests/test_acp.py` suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    AcpServer,
    AgentSession,
    StopReason,
    StopReasonValues,
    PermissionDecision,
    PermissionRequest,
    PromptRequest,
    decodeUpdate,
    encodeUpdate,
    permissionDecisionFromDict,
    promptFromDict,
    promptToDict,
    agentMessageChunk,
    agentThoughtChunk,
    toolCallStart,
    AcpError,
    MissingAcpDependencyError,
} from "./index.js";

// ──────────────────────────────────────────────────────────────────────
// Message round-trips
// ──────────────────────────────────────────────────────────────────────

test("PromptRequest from text blocks", () => {
    const payload = {
        sessionId: "s1",
        prompt: [
            { type: "text", text: "hello" },
            { type: "text", text: "world" },
            { type: "image", data: "..." },
        ],
    };
    const req = promptFromDict(payload);
    assert.equal(req.sessionId, "s1");
    assert.equal(req.text, "hello\nworld");
    assert.equal(req.blocks.length, 3);
});

test("PromptRequest round-trips text", () => {
    const req: PromptRequest = {
        sessionId: "s2",
        text: "hi",
        blocks: [{ type: "text", text: "hi" }],
    };
    const back = promptFromDict(promptToDict(req));
    assert.equal(back.text, "hi");
});

test("agent_message_chunk round-trip", () => {
    const chunk = agentMessageChunk("streaming");
    const encoded = encodeUpdate(chunk);
    assert.equal(encoded.sessionUpdate, "agent_message_chunk");
    assert.deepEqual(encoded.content, { type: "text", text: "streaming" });
    const decoded = decodeUpdate(encoded);
    assert.equal(decoded.kind, "message");
    if (decoded.kind === "message") {
        assert.equal(decoded.text, "streaming");
    }
});

test("agent_thought_chunk round-trip", () => {
    const thought = agentThoughtChunk("thinking");
    const encoded = encodeUpdate(thought);
    const decoded = decodeUpdate(encoded);
    assert.equal(decoded.kind, "thought");
    if (decoded.kind === "thought") {
        assert.equal(decoded.text, "thinking");
    }
});

test("tool_call round-trip with args", () => {
    const start = toolCallStart(
        "write_file",
        { path: "/tmp/a.txt" },
        "Write a.txt"
    );
    const encoded = encodeUpdate(start);
    assert.equal(encoded.sessionUpdate, "tool_call");
    assert.equal(encoded.status, "in_progress");
    assert.deepEqual(encoded.rawInput, { path: "/tmp/a.txt" });
    const decoded = decodeUpdate(encoded);
    assert.equal(decoded.kind, "tool_call_start");
    if (decoded.kind === "tool_call_start") {
        assert.equal(decoded.name, "write_file");
        assert.deepEqual(decoded.arguments, { path: "/tmp/a.txt" });
    }
});

test("tool_call_complete encodes text output", () => {
    const encoded = encodeUpdate({
        kind: "tool_call_complete",
        toolCallId: "tc_x",
        name: "read_file",
        output: "contents",
    });
    assert.equal(encoded.status, "completed");
    const blocks = encoded.content as Array<Record<string, unknown>>;
    assert.deepEqual(blocks[0], { type: "text", text: "contents" });
});

test("tool_call_complete encodes JSON output", () => {
    const encoded = encodeUpdate({
        kind: "tool_call_complete",
        toolCallId: "tc_x",
        name: "search",
        output: { hits: [1, 2, 3] },
    });
    const blocks = encoded.content as Array<Record<string, unknown>>;
    assert.deepEqual(JSON.parse(String(blocks[0].text)), { hits: [1, 2, 3] });
});

test("tool_call_complete error round-trip", () => {
    const encoded = encodeUpdate({
        kind: "tool_call_complete",
        toolCallId: "tc_x",
        name: "exec",
        error: "boom",
    });
    assert.equal(encoded.status, "failed");
    const decoded = decodeUpdate(encoded);
    assert.equal(decoded.kind, "tool_call_complete");
    if (decoded.kind === "tool_call_complete") {
        assert.equal(decoded.error, "boom");
    }
});

test("decode unknown variant throws", () => {
    assert.throws(() => decodeUpdate({ sessionUpdate: "bogus" }));
});

test("PermissionDecision allow with remember=true", () => {
    const decision = permissionDecisionFromDict({
        outcome: { kind: "allow" },
        remember: true,
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.oneTime, false);
});

test("PermissionDecision deny", () => {
    const decision = permissionDecisionFromDict({
        outcome: { kind: "denied" },
    });
    assert.equal(decision.allowed, false);
});

// ──────────────────────────────────────────────────────────────────────
// AgentSession translation
// ──────────────────────────────────────────────────────────────────────

test("Session dispatches message chunks", () => {
    const sink: Record<string, unknown>[] = [];
    const sess = new AgentSession({
        sessionId: "s1",
        sink: (raw) => {
            sink.push(raw);
        },
    });
    sess.dispatch("llm.delta", { text: "hello " });
    sess.dispatch("message_text", { text: "world" });
    assert.deepEqual(
        sink.map((u) => u.sessionUpdate),
        ["agent_message_chunk", "agent_message_chunk"]
    );
    assert.equal(
        (sink[0].content as Record<string, unknown>).text,
        "hello "
    );
});

test("Session dispatches thought chunks", () => {
    const sink: Record<string, unknown>[] = [];
    const sess = new AgentSession({
        sessionId: "s1",
        sink: (raw) => {
            sink.push(raw);
        },
    });
    sess.dispatch("reasoning", { text: "hmm" });
    assert.equal(sink[0].sessionUpdate, "agent_thought_chunk");
});

test("Session pairs tool start with completion", () => {
    const sink: Record<string, unknown>[] = [];
    const sess = new AgentSession({
        sessionId: "s1",
        sink: (raw) => {
            sink.push(raw);
        },
    });
    sess.dispatch("tool.started", {
        name: "read_file",
        arguments: { path: "/x" },
    });
    sess.dispatch("tool.completed", { name: "read_file", output: "ok" });
    assert.equal(sink[0].sessionUpdate, "tool_call");
    assert.equal(sink[1].sessionUpdate, "tool_call_update");
    assert.equal(sink[0].toolCallId, sink[1].toolCallId);
    assert.deepEqual(sink[1].rawInput, { path: "/x" });
});

test("Session pairs concurrent tool calls in order", () => {
    const sink: Record<string, unknown>[] = [];
    const sess = new AgentSession({
        sessionId: "s1",
        sink: (raw) => {
            sink.push(raw);
        },
    });
    sess.dispatch("tool.started", { name: "fetch", arguments: { url: "a" } });
    sess.dispatch("tool.started", { name: "fetch", arguments: { url: "b" } });
    sess.dispatch("tool.completed", { name: "fetch", output: "first" });
    sess.dispatch("tool.completed", { name: "fetch", output: "second" });
    const starts = sink.filter((u) => u.sessionUpdate === "tool_call");
    const ends = sink.filter((u) => u.sessionUpdate === "tool_call_update");
    assert.equal(starts[0].toolCallId, ends[0].toolCallId);
    assert.equal(starts[1].toolCallId, ends[1].toolCallId);
    const firstText = (
        (ends[0].content as Array<Record<string, unknown>>)[0] as Record<
            string,
            unknown
        >
    ).text;
    const secondText = (
        (ends[1].content as Array<Record<string, unknown>>)[0] as Record<
            string,
            unknown
        >
    ).text;
    assert.equal(firstText, "first");
    assert.equal(secondText, "second");
});

test("Session records stop reason", () => {
    const sess = new AgentSession({ sessionId: "s1" });
    sess.dispatch("run_finished", { reason: "max_tokens" });
    assert.equal(sess.stopReason, StopReasonValues.MAX_TOKENS);
});

test("Session records error stop", () => {
    const sess = new AgentSession({ sessionId: "s1" });
    sess.dispatch("run_error", { error: "oops" });
    assert.equal(sess.stopReason, StopReasonValues.ERROR);
});

test("Session.dispatch rejects async sink", () => {
    const sess = new AgentSession({
        sessionId: "s1",
        sink: async () => {
            return;
        },
    });
    assert.throws(
        () => sess.dispatch("message_text", { text: "x" }),
        TypeError
    );
});

test("Session.adispatch supports async sink", async () => {
    const sink: Record<string, unknown>[] = [];
    const sess = new AgentSession({
        sessionId: "s1",
        sink: async (raw) => {
            sink.push(raw);
        },
    });
    await sess.adispatch("message_text", { text: "ok" });
    assert.equal(sink.length, 1);
    assert.equal((sink[0].content as Record<string, unknown>).text, "ok");
});

// ──────────────────────────────────────────────────────────────────────
// Permission gate
// ──────────────────────────────────────────────────────────────────────

test("Permission default allows", async () => {
    const sess = new AgentSession({ sessionId: "s1" });
    const decision = await sess.requestPermission("write_file");
    assert.equal(decision.allowed, true);
});

test("Permission calls requester", async () => {
    const seen: PermissionRequest[] = [];
    const sess = new AgentSession({
        sessionId: "s1",
        permissionRequester: async (req): Promise<PermissionDecision> => {
            seen.push(req);
            return { allowed: false, rationale: "nope", oneTime: true };
        },
    });
    const decision = await sess.requestPermission("write_file", {
        path: "/etc/hosts",
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.rationale, "nope");
    assert.equal(seen[0].name, "write_file");
    assert.deepEqual(seen[0].arguments, { path: "/etc/hosts" });
});

// ──────────────────────────────────────────────────────────────────────
// AcpServer.runPrompt() — integration without the optional package
// ──────────────────────────────────────────────────────────────────────

class FakeAgent {
    onEvent?: (kind: string, payload?: Record<string, unknown>) => void;
    received: string[] = [];
    async arun(prompt: string): Promise<string> {
        this.received.push(prompt);
        if (this.onEvent) {
            this.onEvent("llm.delta", { text: "hi" });
            this.onEvent("tool.started", {
                name: "read_file",
                arguments: { p: "/x" },
            });
            this.onEvent("tool.completed", { name: "read_file", output: "ok" });
            this.onEvent("run_finished", { reason: "end_turn" });
        }
        return "done";
    }
}

test("Server runPrompt relays events", async () => {
    const agent = new FakeAgent();
    const server = new AcpServer({ agent });
    const sink: Record<string, unknown>[] = [];
    const stop = await server.runPrompt(
        { sessionId: "s1", text: "hello", blocks: [] },
        async (raw) => {
            sink.push(raw);
        }
    );
    assert.equal(stop, StopReasonValues.END_TURN);
    assert.deepEqual(agent.received, ["hello"]);
    assert.deepEqual(
        sink.map((u) => u.sessionUpdate),
        ["agent_message_chunk", "tool_call", "tool_call_update"]
    );
});

test("Server runPrompt falls back to final message", async () => {
    class SilentAgent {
        onEvent?: (kind: string, payload?: Record<string, unknown>) => void;
        async arun(prompt: string): Promise<string> {
            return `echo: ${prompt}`;
        }
    }
    const server = new AcpServer({ agent: new SilentAgent() });
    const sink: Record<string, unknown>[] = [];
    const stop = await server.runPrompt(
        { sessionId: "s2", text: "say hi", blocks: [] },
        async (raw) => {
            sink.push(raw);
        }
    );
    assert.equal(stop, StopReasonValues.END_TURN);
    assert.equal(sink.length, 1);
    assert.equal((sink[0].content as Record<string, unknown>).text, "echo: say hi");
});

test("Server runPrompt reports runner error", async () => {
    class BoomAgent {
        onEvent?: (kind: string, payload?: Record<string, unknown>) => void;
        async arun(_prompt: string): Promise<string> {
            throw new Error("kaboom");
        }
    }
    const server = new AcpServer({ agent: new BoomAgent() });
    const sink: Record<string, unknown>[] = [];
    const stop: StopReason = await server.runPrompt(
        { sessionId: "s3", text: "boom", blocks: [] },
        async (raw) => {
            sink.push(raw);
        }
    );
    assert.equal(stop, StopReasonValues.ERROR);
});

test("Server.serve throws MissingAcpDependencyError when package absent", async () => {
    // The optional package is not installed in our dev tree; .serve() must
    // produce a typed error rather than an opaque module-resolution failure.
    const server = new AcpServer({ agent: new FakeAgent() });
    await assert.rejects(server.serve(), MissingAcpDependencyError);
});

test("AcpError hierarchy is well-formed", () => {
    const exc = new MissingAcpDependencyError("nope");
    assert.ok(exc instanceof AcpError);
    assert.ok(exc instanceof Error);
    assert.equal(exc.name, "MissingAcpDependencyError");
});
