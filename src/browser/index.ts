/**
 * `clawagents/browser` — agent-callable browser automation.
 *
 * Powered by Playwright (lazy-imported). Install the runtime with:
 *
 * ```bash
 * npm install playwright
 * npx playwright install chromium
 * ```
 *
 * Without those, `import` continues to work — only `start()` raises
 * {@link MissingPlaywrightError}.
 *
 * Mirrors `clawagents_py/src/clawagents/browser/__init__.py`.
 */

export type {
    BrowserConfig,
    ResolvedBrowserConfig,
} from "./config.js";
export { resolveBrowserConfig } from "./config.js";

export {
    BrowserError,
    ElementNotFoundError,
    MissingPlaywrightError,
    NavigationBlockedError,
    SnapshotError,
} from "./errors.js";

export type {
    BrowserSnapshot,
    SnapshotElement,
    AxNode,
} from "./snapshot.js";
export { renderSnapshot, MAX_NODES } from "./snapshot.js";

export type { BrowserHandle } from "./session.js";
export { BrowserSession } from "./session.js";

export type {
    CloudBrowserProvider,
} from "./providers.js";
export {
    LocalProvider,
    BrowserbaseProviderStub,
    BrowserUseProviderStub,
    getProvider,
} from "./providers.js";

export type {
    CreateBrowserToolsOptions,
} from "./tools.js";
export { createBrowserTools } from "./tools.js";

export { checkUrl } from "./safety.js";
