/**
 * Tests for clawagents/transport.ts.
 *
 * Mirrors `clawagents_py/tests/test_transport.py`.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
    LegacyChatTransport,
    Transport,
    TransportRegistry,
    type TransportRequest,
    type TransportResponse,
} from "./transport.js";

class Stub extends Transport {
    readonly name = "stub";
    callCount = 0;

    override async chat(req: TransportRequest): Promise<TransportResponse> {
        this.callCount += 1;
        return { text: `echo:${req.model}`, finishReason: "stop" };
    }
}

beforeEach(() => TransportRegistry.clear());
afterEach(() => TransportRegistry.clear());

describe("TransportRequest / TransportResponse", () => {
    it("request defaults are undefined / unset", () => {
        const req: TransportRequest = { model: "x", messages: [] };
        assert.equal(req.tools, undefined);
        assert.equal(req.stream, undefined);
        assert.equal(req.toolChoice, undefined);
    });

    it("response only requires text", () => {
        const res: TransportResponse = { text: "hi" };
        assert.equal(res.toolCalls, undefined);
        assert.equal(res.finishReason, undefined);
    });
});

describe("Transport.chat / stream", () => {
    it("chat returns the response and increments call count", async () => {
        const s = new Stub();
        const res = await s.chat({ model: "m", messages: [] });
        assert.equal(res.text, "echo:m");
        assert.equal(s.callCount, 1);
    });

    it("default stream yields exactly one chunk equal to chat()", async () => {
        const s = new Stub();
        const out: TransportResponse[] = [];
        for await (const c of s.stream({ model: "m", messages: [] })) out.push(c);
        assert.equal(out.length, 1);
        assert.equal(out[0]!.text, "echo:m");
    });

    it("aclose default is a no-op", async () => {
        const s = new Stub();
        await s.aclose();
    });
});

describe("TransportRegistry", () => {
    it("register/get round-trip and has() report", () => {
        const s = new Stub();
        TransportRegistry.register(s);
        assert.equal(TransportRegistry.has("stub"), true);
        assert.equal(TransportRegistry.get("stub"), s);
    });

    it("explicit name overrides transport.name", () => {
        const s = new Stub();
        TransportRegistry.register(s, { name: "my-stub" });
        assert.equal(TransportRegistry.has("my-stub"), true);
        assert.equal(TransportRegistry.has("stub"), false);
    });

    it("register throws on missing name", () => {
        class Anon extends Transport {
            readonly name = "";
            async chat(): Promise<TransportResponse> {
                return { text: "" };
            }
        }
        assert.throws(() => TransportRegistry.register(new Anon()));
    });

    it("get throws on unknown name", () => {
        assert.throws(() => TransportRegistry.get("bogus"), /bogus/);
    });

    it("list() returns sorted names", () => {
        TransportRegistry.register(new Stub(), { name: "b" });
        TransportRegistry.register(new Stub(), { name: "a" });
        assert.deepEqual(TransportRegistry.list(), ["a", "b"]);
    });

    it("unregister + clear", () => {
        TransportRegistry.register(new Stub(), { name: "a" });
        TransportRegistry.unregister("a");
        assert.equal(TransportRegistry.has("a"), false);
        TransportRegistry.register(new Stub(), { name: "x" });
        TransportRegistry.register(new Stub(), { name: "y" });
        TransportRegistry.clear();
        assert.deepEqual(TransportRegistry.list(), []);
    });
});

describe("LegacyChatTransport", () => {
    it("forwards a TransportResponse-returning fn unchanged", async () => {
        const t = new LegacyChatTransport("legacy", async req => ({
            text: `hi:${req.model}`,
        }));
        const res = await t.chat({ model: "g", messages: [] });
        assert.equal(res.text, "hi:g");
        assert.equal(t.name, "legacy");
    });

    it("rejects a non-object return", async () => {
        // @ts-expect-error -- intentionally bad return type
        const t = new LegacyChatTransport("legacy", async () => "just a string");
        await assert.rejects(t.chat({ model: "g", messages: [] }), /TransportResponse/);
    });
});
