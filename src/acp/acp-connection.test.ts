/**
 * End-to-end ACP wire test against the REAL
 * `@zed-industries/agent-client-protocol` (≥0.4) package, driven over
 * in-memory pipes — no stdio, no editor.
 *
 * The client side uses the package's own `ClientSideConnection`, which
 * zod-validates every `session/update` notification. That makes this test
 * the contract check that our updates (required `title` on tool_call, the
 * `SessionNotification` envelope, spec stop reasons) are actually valid —
 * the previous server targeted an API surface that never existed and could
 * not start at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { AcpServer } from "./server.js";

const _require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadAcp(): any {
    return _require("@zed-industries/agent-client-protocol");
}

/** Two in-memory ndjson pipes: one per direction. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStreamPair(acp: any): { agentStream: unknown; clientStream: unknown } {
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    return {
        agentStream: acp.ndJsonStream(agentToClient.writable, clientToAgent.readable),
        clientStream: acp.ndJsonStream(clientToAgent.writable, agentToClient.readable),
    };
}

type Update = Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeClient(acp: any, clientStream: unknown, updates: Update[]) {
    return new acp.ClientSideConnection(
        () => ({
            async sessionUpdate(params: { sessionId: string; update: Update }) {
                updates.push(params.update);
            },
            async requestPermission() {
                return { outcome: { outcome: "selected", optionId: "allow" } };
            },
        }),
        clientStream
    );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handshake(client: any): Promise<string> {
    const init = await client.initialize({ protocolVersion: 1 });
    assert.equal(init.protocolVersion, 1);
    const session = await client.newSession({ cwd: "/", mcpServers: [] });
    assert.ok(String(session.sessionId).startsWith("sess_"));
    return String(session.sessionId);
}

test("ACP 0.4: initialize → newSession → prompt streams valid updates", async () => {
    const acp = loadAcp();
    const { agentStream, clientStream } = makeStreamPair(acp);

    const fakeAgent = {
        onEvent: undefined as unknown,
        async run(text: string): Promise<string> {
            const emit = this.onEvent as (
                event: string,
                payload?: Record<string, unknown>
            ) => void;
            emit("tool.started", {
                name: "read_file",
                call_id: "c1",
                args: { path: "a.txt" },
            });
            emit("tool.completed", {
                name: "read_file",
                call_id: "c1",
                output: "file body",
            });
            emit("message_text", { text: `echo: ${text}` });
            return "final";
        },
    };

    const server = new AcpServer({ agent: fakeAgent });
    server.serveConnection(acp, agentStream);

    const updates: Update[] = [];
    const client = makeClient(acp, clientStream, updates);
    const sessionId = await handshake(client);

    const res = await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
    });
    assert.equal(res.stopReason, "end_turn");

    // Client-side zod validation already passed for each update; now check
    // content and ordering.
    assert.equal(updates.length, 3);
    const [start, done, msg] = updates as [Update, Update, Update];

    assert.equal(start.sessionUpdate, "tool_call");
    assert.equal(start.title, "read_file"); // required by spec schema
    assert.equal(start.kind, "read");
    assert.equal(start.status, "in_progress");
    assert.deepEqual(start.rawInput, { path: "a.txt" });

    assert.equal(done.sessionUpdate, "tool_call_update");
    assert.equal(done.status, "completed");
    assert.equal(done.toolCallId, start.toolCallId);

    assert.equal(msg.sessionUpdate, "agent_message_chunk");
    assert.deepEqual(msg.content, { type: "text", text: "echo: hello" });
});

test("ACP 0.4: out-of-order parallel completions keep call-id pairing", async () => {
    const acp = loadAcp();
    const { agentStream, clientStream } = makeStreamPair(acp);

    const fakeAgent = {
        onEvent: undefined as unknown,
        async run(): Promise<string> {
            const emit = this.onEvent as (
                event: string,
                payload?: Record<string, unknown>
            ) => void;
            emit("tool.started", { name: "grep", call_id: "c1", args: { q: "one" } });
            emit("tool.started", { name: "grep", call_id: "c2", args: { q: "two" } });
            // Complete in REVERSE order — FIFO-by-name would mis-pair these.
            emit("tool.completed", { name: "grep", call_id: "c2", output: "two-out" });
            emit("tool.completed", { name: "grep", call_id: "c1", output: "one-out" });
            return "done";
        },
    };

    const server = new AcpServer({ agent: fakeAgent });
    server.serveConnection(acp, agentStream);

    const updates: Update[] = [];
    const client = makeClient(acp, clientStream, updates);
    const sessionId = await handshake(client);
    await client.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });

    const starts = updates.filter((u) => u.sessionUpdate === "tool_call");
    const dones = updates.filter((u) => u.sessionUpdate === "tool_call_update");
    assert.equal(starts.length, 2);
    assert.equal(dones.length, 2);
    const [startC1, startC2] = starts as [Update, Update];
    const [doneFirst, doneSecond] = dones as [Update, Update];
    // c2 completed first → its update must carry the SECOND start's id.
    assert.equal(doneFirst.toolCallId, startC2.toolCallId);
    assert.equal(doneSecond.toolCallId, startC1.toolCallId);
});

test("ACP 0.4: agent failure surfaces as JSON-RPC error, not invalid stopReason", async () => {
    const acp = loadAcp();
    const { agentStream, clientStream } = makeStreamPair(acp);

    const fakeAgent = {
        async run(): Promise<string> {
            throw new Error("boom");
        },
    };
    const server = new AcpServer({ agent: fakeAgent });
    server.serveConnection(acp, agentStream);

    const updates: Update[] = [];
    const client = makeClient(acp, clientStream, updates);
    const sessionId = await handshake(client);

    await assert.rejects(
        client.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] })
    );
});

test("ACP 0.4: session/cancel notification is accepted", async () => {
    const acp = loadAcp();
    const { agentStream, clientStream } = makeStreamPair(acp);

    const server = new AcpServer({
        agent: { async run(): Promise<string> { return "ok"; } },
    });
    server.serveConnection(acp, agentStream);

    const updates: Update[] = [];
    const client = makeClient(acp, clientStream, updates);
    const sessionId = await handshake(client);

    // Fire-and-forget notification must not error or kill the connection.
    await client.cancel({ sessionId });
    const res = await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: "still alive?" }],
    });
    assert.equal(res.stopReason, "end_turn");
});
