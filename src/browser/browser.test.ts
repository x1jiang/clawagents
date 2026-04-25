/**
 * Hermetic tests for the browser module.
 *
 * These tests intentionally do **not** require Playwright to be installed.
 * They cover:
 *
 * - Module imports cleanly without `playwright`.
 * - `BrowserConfig` defaults round-trip through `resolveBrowserConfig`.
 * - URL safety (`checkUrl`) blocks SSRF / unsupported schemes.
 * - `renderSnapshot` produces stable text + ref maps.
 * - `createBrowserTools` returns the expected tool surface.
 * - `browser_navigate` rejects SSRF before launching Chromium.
 * - `browser_evaluate` rejects without `allowEval` before launching Chromium.
 *
 * Mirrors `clawagents_py/tests/test_browser.py`.
 *
 * Run with: npx tsx --test src/browser/browser.test.ts
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import {
    BrowserError,
    BrowserSession,
    NavigationBlockedError,
    createBrowserTools,
    renderSnapshot,
    resolveBrowserConfig,
    checkBrowserUrl as checkUrl,
} from "../index.js";
import { ssrfDeps } from "../tools/web.js";

describe("browser/config", () => {
    it("fills in conservative defaults", () => {
        const cfg = resolveBrowserConfig();
        assert.equal(cfg.headless, true);
        assert.equal(cfg.viewportWidth, 1280);
        assert.equal(cfg.viewportHeight, 720);
        assert.equal(cfg.allowPrivateNetwork, false);
        assert.equal(cfg.allowEval, false);
        assert.equal(cfg.provider, "local");
        assert.deepEqual(cfg.chromiumArgs, []);
    });

    it("respects explicit overrides", () => {
        const cfg = resolveBrowserConfig({
            headless: false,
            viewportWidth: 800,
            allowEval: true,
            chromiumArgs: ["--disable-dev-shm-usage"],
        });
        assert.equal(cfg.headless, false);
        assert.equal(cfg.viewportWidth, 800);
        assert.equal(cfg.allowEval, true);
        assert.deepEqual(cfg.chromiumArgs, ["--disable-dev-shm-usage"]);
    });
});

describe("browser/safety.checkUrl", () => {
    it("rejects unsupported schemes", async () => {
        const err = await checkUrl("javascript:alert(1)", { allowPrivate: false });
        assert.ok(err);
        assert.match(err!, /Refusing scheme/);
    });

    it("rejects file:// when allowPrivate=false", async () => {
        const err = await checkUrl("file:///etc/passwd", { allowPrivate: false });
        assert.ok(err);
        assert.match(err!, /Refusing scheme/);
    });

    it("allows file:// when allowPrivate=true", async () => {
        const err = await checkUrl("file:///etc/passwd", { allowPrivate: true });
        assert.equal(err, null);
    });

    it("blocks loopback hosts", async () => {
        const err = await checkUrl("http://127.0.0.1/admin", { allowPrivate: false });
        assert.ok(err);
        assert.match(err!, /private|loopback|reserved/i);
    });

    it("blocks AWS metadata IP", async () => {
        const err = await checkUrl("http://169.254.169.254/latest/meta-data/", {
            allowPrivate: false,
        });
        assert.ok(err);
        assert.match(err!, /private|loopback|link-local|reserved/i);
    });

    it("rejects malformed URLs", async () => {
        const err = await checkUrl("not a url", { allowPrivate: false });
        assert.ok(err);
        assert.match(err!, /Invalid URL/);
    });

    it("allows public hosts when isPrivateHost says no", async () => {
        const restore = mock.method(ssrfDeps, "isPrivateHost", async () => false);
        try {
            const err = await checkUrl("https://example.com/", { allowPrivate: false });
            assert.equal(err, null);
        } finally {
            restore.mock.restore();
        }
    });
});

describe("browser/snapshot.renderSnapshot", () => {
    it("returns empty snapshot when tree is null", () => {
        const snap = renderSnapshot(null, { url: "about:blank", title: "" });
        assert.equal(snap.url, "about:blank");
        assert.equal(snap.elements.size, 0);
        assert.equal(snap.text, "(empty page)");
        assert.equal(snap.truncated, false);
    });

    it("assigns @eN refs to interactive nodes only", () => {
        const tree = {
            role: "main",
            name: "",
            children: [
                { role: "heading", name: "Welcome", children: [] },
                { role: "button", name: "Sign in", children: [] },
                { role: "link", name: "Forgot password?", children: [] },
                { role: "textbox", name: "Email", children: [] },
            ],
        };
        const snap = renderSnapshot(tree, { url: "https://example.com", title: "Login" });

        assert.equal(snap.elements.size, 3);
        assert.ok(snap.elements.has("@e1"));
        assert.ok(snap.elements.has("@e2"));
        assert.ok(snap.elements.has("@e3"));
        assert.equal(snap.elements.get("@e1")?.role, "button");
        assert.equal(snap.elements.get("@e1")?.name, "Sign in");
        assert.equal(snap.elements.get("@e2")?.role, "link");
        assert.equal(snap.elements.get("@e3")?.role, "textbox");
        // Heading text appears but does not get a ref.
        assert.match(snap.text, /Welcome/);
        assert.match(snap.text, /@e1 button "Sign in"/);
    });

    it("lookup() throws ElementNotFoundError for unknown ref", () => {
        const snap = renderSnapshot(
            { role: "button", name: "OK", children: [] },
            { url: "https://example.com", title: "" },
        );
        assert.throws(() => snap.lookup("@e99"), {
            name: "ElementNotFoundError",
        });
    });
});

describe("browser/tools.createBrowserTools", () => {
    it("returns the documented tool set", () => {
        const { tools, session } = createBrowserTools();
        try {
            const names = new Set(tools.map(t => t.name));
            for (const expected of [
                "browser_navigate",
                "browser_back",
                "browser_forward",
                "browser_snapshot",
                "browser_click",
                "browser_type",
                "browser_hover",
                "browser_select_option",
                "browser_wait_for",
                "browser_screenshot",
                "browser_evaluate",
                "browser_close",
            ]) {
                assert.ok(names.has(expected), `missing tool: ${expected}`);
            }
        } finally {
            // No browser was started, so close() is a no-op but exercise it.
            void session;
        }
    });

    it("browser_navigate blocks SSRF before starting browser", async () => {
        const { tools, session } = createBrowserTools();
        const tool = tools.find(t => t.name === "browser_navigate")!;
        const result = await tool.execute({ url: "http://127.0.0.1/admin" });
        assert.equal(result.success, false);
        assert.match(
            String(result.error),
            /private|loopback|link-local|reserved/i,
        );
        // Must not have launched a browser.
        assert.equal(session.isStarted, false);
    });

    it("browser_evaluate is disabled by default", async () => {
        const { tools, session } = createBrowserTools();
        const tool = tools.find(t => t.name === "browser_evaluate")!;
        const result = await tool.execute({ expression: "1+1" });
        assert.equal(result.success, false);
        assert.match(String(result.error), /disabled/);
        assert.equal(session.isStarted, false);
    });

    it("browser_navigate rejects unsupported schemes without launching browser", async () => {
        const { tools, session } = createBrowserTools();
        const tool = tools.find(t => t.name === "browser_navigate")!;
        const result = await tool.execute({ url: "ftp://example.com/file" });
        assert.equal(result.success, false);
        assert.match(String(result.error), /Refusing scheme/);
        assert.equal(session.isStarted, false);
    });
});

describe("browser/session basic guards", () => {
    it("requirePage throws before start()", async () => {
        const session = new BrowserSession();
        await assert.rejects(session.navigate("https://example.com"), BrowserError);
    });

    it("close() is idempotent before start()", async () => {
        const session = new BrowserSession();
        await session.close();
        await session.close();
        assert.equal(session.isStarted, false);
    });

    it("evaluate throws BrowserError when allowEval=false", async () => {
        const session = new BrowserSession({ allowEval: false });
        await assert.rejects(
            (async () => {
                await session.evaluate("1+1");
            })(),
            BrowserError,
        );
    });

    it("navigate raises NavigationBlockedError on SSRF", async () => {
        const session = new BrowserSession({ allowPrivateNetwork: false });
        await assert.rejects(
            (async () => {
                // Even before start(), the URL guard should already reject.
                await session.navigate("http://127.0.0.1/admin");
            })(),
            NavigationBlockedError,
        );
    });
});
