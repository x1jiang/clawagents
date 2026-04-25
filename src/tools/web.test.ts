/**
 * Hermetic SSRF tests for `web_fetch`.
 *
 * Mirrors clawagents_py/tests/test_web_fetch_ssrf.py. The "public"
 * classification is faked by mocking `ssrfDeps.isPrivateHost`; the test
 * server still binds to 127.0.0.1 because that is the only host we can
 * rely on in CI sandboxes.
 *
 * Run with: npx tsx --test src/tools/web.test.ts
 */

import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { webFetchTool, ssrfDeps } from "./web.js";

type Route = {
    status: number;
    headers?: Record<string, string>;
    body?: string;
};

let routes: Map<string, Route> = new Map();
let server: http.Server;
let port = 0;

before(async () => {
    server = http.createServer((req, res) => {
        const route = routes.get(req.url ?? "/");
        if (!route) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(route.status, route.headers ?? {});
        res.end(route.body ?? "");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
});

after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
    routes = new Map();
    mock.reset();
});

/** Treat 127.0.0.1 as 'public' so hop 1 is allowed; reject the listed hosts. */
function fakeValidator(...privateTargets: string[]): void {
    const blocked = new Set(privateTargets);
    mock.method(ssrfDeps, "isPrivateHost", async (host: string) => {
        if (blocked.has(host)) return true;
        if (host === "127.0.0.1") return false;
        return true;
    });
}

describe("web_fetch SSRF", () => {
    it("refuses redirect to a private IP (IMDS)", async () => {
        fakeValidator("169.254.169.254");
        routes.set("/r", {
            status: 302,
            headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        });

        const result = await webFetchTool.execute({ url: `http://127.0.0.1:${port}/r` });

        assert.equal(result.success, false);
        assert.match(result.error ?? "", /169\.254\.169\.254/);
        assert.match(result.error ?? "", /private/);
    });

    it("refuses redirect to RFC1918", async () => {
        fakeValidator("10.0.0.1");
        routes.set("/r", {
            status: 302,
            headers: { Location: "http://10.0.0.1/admin" },
        });

        const result = await webFetchTool.execute({ url: `http://127.0.0.1:${port}/r` });

        assert.equal(result.success, false);
        assert.match(result.error ?? "", /10\.0\.0\.1/);
    });

    it("rejects redirect chains over the cap", async () => {
        fakeValidator(); // every hop is 'public'
        routes.set("/r", { status: 302, headers: { Location: "/r" } });

        const result = await webFetchTool.execute({ url: `http://127.0.0.1:${port}/r` });

        assert.equal(result.success, false);
        assert.match(result.error ?? "", /Too many redirects/);
    });

    it("still refuses a direct fetch of a private IP", async () => {
        // No fake validator — real check applies.
        const result = await webFetchTool.execute({ url: "http://127.0.0.1/x" });

        assert.equal(result.success, false);
        assert.match(result.error ?? "", /127\.0\.0\.1/);
        assert.match(result.error ?? "", /private/);
    });

    it("follows a 'public→public' redirect to completion", async () => {
        fakeValidator(); // hop 1 + hop 2 both treated as public
        routes.set("/r", { status: 302, headers: { Location: "/dest" } });
        routes.set("/dest", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
            body: "final-body",
        });

        const result = await webFetchTool.execute({ url: `http://127.0.0.1:${port}/r` });

        assert.equal(result.success, true, result.error ?? "");
        const output = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
        assert.match(output, /final-body/);
        assert.match(output, /\/dest/);
    });
});

describe("isPrivateIp — IPv6 ranges", () => {
    // Full fe80::/10 link-local range covers hex prefixes fe80..febf.
    // The previous implementation only matched fe8X, missing fe9X / feaX / febX.
    it("blocks all of fe80::/10 link-local (fe80, fe90, fea0, feb0)", () => {
        for (const ip of ["fe80::1", "fe90::1", "fea0::1", "feb0::1", "febf::ffff"]) {
            assert.equal(ssrfDeps.isPrivateIp(ip), true, `expected ${ip} blocked as link-local`);
        }
    });

    it("does NOT block fec0:: (deprecated site-local, not in fe80::/10)", () => {
        // fec0::/10 was deprecated in RFC 3879 and is not assignable; treat as public unless
        // some other rule fires. Just confirm we no longer over-block fe[c-f].
        assert.equal(ssrfDeps.isPrivateIp("fec0::1"), false);
    });

    it("blocks ULA fc00::/7 (fc.., fd..)", () => {
        assert.equal(ssrfDeps.isPrivateIp("fc00::1"), true);
        assert.equal(ssrfDeps.isPrivateIp("fdab::1"), true);
    });

    it("blocks loopback and unspecified", () => {
        assert.equal(ssrfDeps.isPrivateIp("::1"), true);
        assert.equal(ssrfDeps.isPrivateIp("::"), true);
    });

    it("blocks IPv4-mapped private addresses", () => {
        assert.equal(ssrfDeps.isPrivateIp("::ffff:127.0.0.1"), true);
        assert.equal(ssrfDeps.isPrivateIp("::ffff:10.0.0.1"), true);
    });

    it("allows public IPv6 addresses", () => {
        assert.equal(ssrfDeps.isPrivateIp("2001:4860:4860::8888"), false); // Google DNS
        assert.equal(ssrfDeps.isPrivateIp("2606:4700:4700::1111"), false); // Cloudflare
    });
});
