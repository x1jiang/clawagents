/**
 * `BrowserConfig` — configuration for a {@link BrowserSession}.
 *
 * Defaults are conservative: headless, no JS eval, no private-IP nav,
 * no extra Chromium args. Agents that need wider permission must opt in.
 */

export interface BrowserConfig {
    /** Run Chromium without a visible window. Default `true`. */
    headless?: boolean;
    /** Initial viewport width. Default `1280`. */
    viewportWidth?: number;
    /** Initial viewport height. Default `720`. */
    viewportHeight?: number;
    /** Override Chromium's UA string. `undefined` keeps the default. */
    userAgent?: string;
    /** Optional `http://user:pass@host:port` proxy string. */
    proxy?: string;
    /** Whether the page may trigger file downloads. Default `false`. */
    acceptDownloads?: boolean;
    /** Default action timeout, in milliseconds. Default `30_000`. */
    timeoutMs?: number;
    /**
     * When `false` (default), navigation to loopback / RFC1918 /
     * link-local / metadata IPs is rejected with
     * {@link NavigationBlockedError}. Set to `true` for trusted
     * dev environments only.
     */
    allowPrivateNetwork?: boolean;
    /**
     * When `false` (default), `browser_evaluate(js)` is disabled.
     * Set to `true` to expose arbitrary JS execution to the agent.
     * **Security-sensitive — leave off unless you have audited the
     * prompt boundary.**
     */
    allowEval?: boolean;
    /**
     * One of `"local"` (Playwright Chromium), `"browserbase"`,
     * `"browser-use"`. Cloud providers are stubs in v6.6 and raise
     * on use.
     */
    provider?: "local" | "browserbase" | "browser-use";
    /** Extra command-line flags forwarded to Chromium. */
    chromiumArgs?: string[];
    /** Override the default downloads location. */
    downloadsDir?: string;
}

/** Resolved {@link BrowserConfig} with defaults filled in. */
export interface ResolvedBrowserConfig {
    headless: boolean;
    viewportWidth: number;
    viewportHeight: number;
    userAgent?: string;
    proxy?: string;
    acceptDownloads: boolean;
    timeoutMs: number;
    allowPrivateNetwork: boolean;
    allowEval: boolean;
    provider: "local" | "browserbase" | "browser-use";
    chromiumArgs: string[];
    downloadsDir?: string;
}

export function resolveBrowserConfig(cfg?: BrowserConfig): ResolvedBrowserConfig {
    return {
        headless: cfg?.headless ?? true,
        viewportWidth: cfg?.viewportWidth ?? 1280,
        viewportHeight: cfg?.viewportHeight ?? 720,
        userAgent: cfg?.userAgent,
        proxy: cfg?.proxy,
        acceptDownloads: cfg?.acceptDownloads ?? false,
        timeoutMs: cfg?.timeoutMs ?? 30_000,
        allowPrivateNetwork: cfg?.allowPrivateNetwork ?? false,
        allowEval: cfg?.allowEval ?? false,
        provider: cfg?.provider ?? "local",
        chromiumArgs: cfg?.chromiumArgs ?? [],
        downloadsDir: cfg?.downloadsDir,
    };
}
