import { test } from "node:test";
import assert from "node:assert/strict";
import { startGateway } from "./server.js";

test("gateway refuses non-loopback startup without API key", async () => {
    const oldKey = process.env["GATEWAY_API_KEY"];
    const oldHost = process.env["GATEWAY_HOST"];
    delete process.env["GATEWAY_API_KEY"];
    delete process.env["GATEWAY_HOST"];
    try {
        await assert.rejects(
            startGateway(0, "0.0.0.0"),
            /Refusing to start unauthenticated gateway/,
        );
    } finally {
        if (oldKey === undefined) delete process.env["GATEWAY_API_KEY"];
        else process.env["GATEWAY_API_KEY"] = oldKey;
        if (oldHost === undefined) delete process.env["GATEWAY_HOST"];
        else process.env["GATEWAY_HOST"] = oldHost;
    }
});
