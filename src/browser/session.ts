/**
 * `BrowserSession` — lazy-loaded Playwright wrapper.
 *
 * This module imports `playwright` **only inside `start()`** so that
 * simply importing `clawagents/browser` works without the optional
 * dependency installed. The first call to `start()` triggers the
 * dynamic import; if it fails we throw {@link MissingPlaywrightError}
 * with the install command.
 *
 * Concurrency: each session owns one Chromium browser, one context,
 * and one page (single-tab). Multiple sessions can run in parallel;
 * Playwright's per-context state keeps them isolated.
 *
 * Element targeting: `ref` strings (`@e1`, `@e2`) come from the most
 * recent {@link BrowserSnapshot}. The session resolves a ref by
 * Playwright's `getByRole` locator using the role + accessible name —
 * we never inject arbitrary JS or build CSS selectors.
 *
 * Mirrors `clawagents_py/src/clawagents/browser/session.py`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { getClawagentsHome } from "../paths.js";
import { checkUrl } from "./safety.js";
import type { BrowserConfig, ResolvedBrowserConfig } from "./config.js";
import { resolveBrowserConfig } from "./config.js";
import {
    BrowserError,
    ElementNotFoundError,
    MissingPlaywrightError,
    NavigationBlockedError,
    SnapshotError,
} from "./errors.js";
import type { CloudBrowserProvider } from "./providers.js";
import { getProvider } from "./providers.js";
import type { BrowserSnapshot, SnapshotElement } from "./snapshot.js";
import { renderSnapshot } from "./snapshot.js";

/** Lightweight serializable reference to a session. */
export interface BrowserHandle {
    sessionId: string;
    provider: string;
    startedAt: number;
}

interface PlaywrightModule {
    chromium: {
        launch: (opts: Record<string, unknown>) => Promise<unknown>;
    };
}

async function importPlaywright(): Promise<PlaywrightModule> {
    try {
        const mod = (await import("playwright")) as unknown as PlaywrightModule;
        return mod;
    } catch (err) {
        throw new MissingPlaywrightError();
    }
}

/**
 * A single browser session.
 *
 * Typical usage:
 *
 * ```ts
 * const bs = new BrowserSession({ headless: true });
 * try {
 *     await bs.start();
 *     await bs.navigate("https://example.com");
 *     const snap = await bs.snapshot();
 *     await bs.click(snap.elements.get("@e1")!);
 * } finally {
 *     await bs.close();
 * }
 * ```
 */
export class BrowserSession {
    readonly config: ResolvedBrowserConfig;
    readonly sessionId: string;

    private _provider?: CloudBrowserProvider;
    private _browser: any = null;
    private _context: any = null;
    private _page: any = null;
    private _lastSnapshot: BrowserSnapshot | null = null;
    private readonly _startedAt = Date.now();

    constructor(
        config?: BrowserConfig,
        opts?: { sessionId?: string; provider?: CloudBrowserProvider },
    ) {
        this.config = resolveBrowserConfig(config);
        this.sessionId = opts?.sessionId ?? randomUUID().replace(/-/g, "").slice(0, 12);
        this._provider = opts?.provider;
    }

    /** True after a successful {@link start} call. */
    get isStarted(): boolean {
        return this._page !== null;
    }

    get handle(): BrowserHandle {
        return {
            sessionId: this.sessionId,
            provider: this._provider?.name ?? this.config.provider,
            startedAt: this._startedAt,
        };
    }

    /** Per-session directory under `~/.clawagents/<profile>/browser/`. */
    get stateDir(): string {
        const dir = path.join(
            getClawagentsHome({ create: true }),
            "browser",
            "sessions",
            this.sessionId,
        );
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    /**
     * Launch the browser if it isn't already running. Idempotent.
     */
    async start(): Promise<void> {
        if (this._page !== null) return;

        if (this.config.provider !== "local") {
            const provider = this._provider ?? getProvider(this.config.provider);
            this._provider = provider;
            await provider.open(this.config);
            return;
        }

        const playwright = await importPlaywright();
        try {
            this._browser = await playwright.chromium.launch({
                headless: this.config.headless,
                args: this.config.chromiumArgs.length > 0 ? this.config.chromiumArgs : undefined,
                proxy: this.config.proxy ? { server: this.config.proxy } : undefined,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/Executable doesn'?t exist/i.test(msg) || /browserType\.launch/i.test(msg)) {
                throw new MissingPlaywrightError(
                    "Chromium binary not found. Run `npx playwright install chromium` " +
                    "after installing the optional `playwright` dependency.",
                );
            }
            throw err;
        }

        this._context = await this._browser.newContext({
            viewport: {
                width: this.config.viewportWidth,
                height: this.config.viewportHeight,
            },
            userAgent: this.config.userAgent,
            acceptDownloads: this.config.acceptDownloads,
        });
        this._context.setDefaultTimeout(this.config.timeoutMs);
        this._page = await this._context.newPage();
    }

    /**
     * Tear down browser, context, and runtime. Idempotent.
     * Safe to call from a `finally` block even when {@link start}
     * failed mid-way.
     */
    async close(): Promise<void> {
        try {
            if (this._page) {
                try { await this._page.close(); } catch { /* swallow */ }
            }
            if (this._context) {
                try { await this._context.close(); } catch { /* swallow */ }
            }
            if (this._browser) {
                try { await this._browser.close(); } catch { /* swallow */ }
            }
        } finally {
            this._page = null;
            this._context = null;
            this._browser = null;
            this._lastSnapshot = null;
        }
    }

    private requirePage(): any {
        if (this._page === null) {
            throw new BrowserError("Session not started; call start() first.");
        }
        return this._page;
    }

    // ── Navigation ──────────────────────────────────────────────

    /** Navigate to `url` after SSRF / scheme validation. */
    async navigate(url: string, opts?: { waitUntil?: string }): Promise<string> {
        const err = await checkUrl(url, { allowPrivate: this.config.allowPrivateNetwork });
        if (err !== null) {
            throw new NavigationBlockedError(err);
        }
        const page = this.requirePage();
        await page.goto(url, {
            waitUntil: opts?.waitUntil ?? "load",
            timeout: this.config.timeoutMs,
        });
        return page.url();
    }

    async back(): Promise<string> {
        const page = this.requirePage();
        await page.goBack({ timeout: this.config.timeoutMs });
        return page.url();
    }

    async forward(): Promise<string> {
        const page = this.requirePage();
        await page.goForward({ timeout: this.config.timeoutMs });
        return page.url();
    }

    // ── Snapshot ────────────────────────────────────────────────

    async snapshot(): Promise<BrowserSnapshot> {
        const page = this.requirePage();
        let tree;
        try {
            tree = await page.accessibility.snapshot({ interestingOnly: true });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new SnapshotError(`Accessibility snapshot failed: ${msg}`);
        }
        let title = "";
        try {
            title = await page.title();
        } catch { /* ignore */ }
        const snap = renderSnapshot(tree, { url: page.url(), title });
        this._lastSnapshot = snap;
        return snap;
    }

    // ── Element resolution ──────────────────────────────────────

    private async resolve(target: SnapshotElement | string): Promise<any> {
        const page = this.requirePage();
        let element: SnapshotElement;
        if (typeof target === "string") {
            if (this._lastSnapshot === null) {
                throw new ElementNotFoundError(
                    "No snapshot taken yet — call snapshot() first.",
                );
            }
            element = this._lastSnapshot.lookup(target);
        } else {
            element = target;
        }

        const locator = element.name
            ? page.getByRole(element.role, { name: element.name, exact: true })
            : page.getByRole(element.role);
        return locator.first();
    }

    // ── Interactions ────────────────────────────────────────────

    async click(target: SnapshotElement | string): Promise<void> {
        const loc = await this.resolve(target);
        await loc.click({ timeout: this.config.timeoutMs });
    }

    async type(
        target: SnapshotElement | string,
        text: string,
        opts?: { submit?: boolean; clear?: boolean },
    ): Promise<void> {
        const loc = await this.resolve(target);
        if (opts?.clear ?? true) {
            await loc.fill("", { timeout: this.config.timeoutMs });
        }
        await loc.type(text, { timeout: this.config.timeoutMs });
        if (opts?.submit) {
            await loc.press("Enter", { timeout: this.config.timeoutMs });
        }
    }

    async hover(target: SnapshotElement | string): Promise<void> {
        const loc = await this.resolve(target);
        await loc.hover({ timeout: this.config.timeoutMs });
    }

    async selectOption(
        target: SnapshotElement | string,
        value: string,
    ): Promise<void> {
        const loc = await this.resolve(target);
        await loc.selectOption(value, { timeout: this.config.timeoutMs });
    }

    async waitFor(text: string, timeoutS: number = 30): Promise<void> {
        const page = this.requirePage();
        try {
            await page.getByText(text).first().waitFor({
                timeout: Math.max(1, Math.floor(timeoutS * 1000)),
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new BrowserError(
                `Timed out after ${timeoutS}s waiting for text '${text}': ${msg}`,
            );
        }
    }

    /** Capture a PNG and return base64-encoded bytes. */
    async screenshot(opts?: { fullPage?: boolean }): Promise<string> {
        const page = this.requirePage();
        const png = await page.screenshot({ fullPage: opts?.fullPage ?? false, type: "png" });
        const buf = Buffer.from(png as Uint8Array);
        return buf.toString("base64");
    }

    /** Run JavaScript in the page (gated by `allowEval`). */
    async evaluate(expression: string): Promise<unknown> {
        if (!this.config.allowEval) {
            throw new BrowserError(
                "browser_evaluate is disabled. Set BrowserConfig.allowEval=true " +
                "to enable. Be aware this exposes arbitrary JS execution to the " +
                "agent — make sure you've audited your prompt boundary.",
            );
        }
        const page = this.requirePage();
        return await page.evaluate(expression);
    }

    /** Auto-handle the next `alert`/`confirm`/`prompt` dialog. */
    async installDialogHandler(opts?: {
        accept?: boolean;
        promptText?: string;
    }): Promise<void> {
        const page = this.requirePage();
        const accept = opts?.accept ?? true;
        const promptText = opts?.promptText ?? "";
        page.once("dialog", async (dialog: any) => {
            try {
                if (accept) {
                    await dialog.accept(promptText);
                } else {
                    await dialog.dismiss();
                }
            } catch { /* swallow */ }
        });
    }
}
