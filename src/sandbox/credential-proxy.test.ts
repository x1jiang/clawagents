import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { CredentialProxy } from "./credential-proxy.js";

async function listen(server: http.Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    return `http://127.0.0.1:${addr.port}`;
}

test("CredentialProxy forwards SDK path-only requests to configured upstream", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const upstream = http.createServer((req, res) => {
        seenUrl = req.url ?? "";
        seenAuth = req.headers.authorization ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    const upstreamUrl = await listen(upstream);
    const proxy = new CredentialProxy(
        { Authorization: "Bearer real-key" },
        "127.0.0.1",
        0,
        { openai: `${upstreamUrl}/v1`, anthropic: "http://127.0.0.1:9" },
    );

    try {
        const proxyUrl = await proxy.start();
        assert.doesNotMatch(proxyUrl, /:0$/);
        const response = await fetch(`${proxyUrl}/v1/models`, {
            headers: { Authorization: "Bearer proxy" },
        });
        assert.equal(response.status, 200);
        assert.equal(seenUrl, "/v1/models");
        assert.equal(seenAuth, "Bearer real-key");
    } finally {
        proxy.stop();
        upstream.close();
    }
});

test("CredentialProxy refuses untrusted absolute upstream URLs", async () => {
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
    });
    const upstreamUrl = await listen(upstream);
    const proxy = new CredentialProxy(
        { Authorization: "Bearer real-key" },
        "127.0.0.1",
        0,
        { openai: `${upstreamUrl}/v1`, anthropic: "http://127.0.0.1:9" },
    );

    try {
        const proxyUrl = await proxy.start();
        const url = new URL(proxyUrl);
        const status = await new Promise<number>((resolve, reject) => {
            const req = http.request({
                host: url.hostname,
                port: Number(url.port),
                path: "http://example.com/v1/models",
                method: "GET",
            }, (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode ?? 0));
            });
            req.on("error", reject);
            req.end();
        });
        assert.equal(status, 403);
    } finally {
        proxy.stop();
        upstream.close();
    }
});

test("CredentialProxy refuses protocol downgrade for allowlisted hosts", async () => {
    const proxy = new CredentialProxy(
        { Authorization: "Bearer real-key" },
        "127.0.0.1",
        0,
        { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com" },
    );

    try {
        const proxyUrl = await proxy.start();
        const url = new URL(proxyUrl);
        const status = await new Promise<number>((resolve, reject) => {
            const req = http.request({
                host: url.hostname,
                port: Number(url.port),
                path: "http://api.openai.com/v1/models",
                method: "GET",
            }, (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode ?? 0));
            });
            req.on("error", reject);
            req.end();
        });
        assert.equal(status, 403);
    } finally {
        proxy.stop();
    }
});
