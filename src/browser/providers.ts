/**
 * Cloud browser provider extension points.
 *
 * In v6.6 only the local Playwright-Chromium provider is implemented.
 * The cloud entries (`browserbase`, `browser-use`) ship as stubs so
 * the surface is stable; calling `.open()` on them raises a clear
 * error pointing at the missing integration.
 */

import { BrowserError } from "./errors.js";
import type { ResolvedBrowserConfig } from "./config.js";

export interface CloudBrowserProvider {
    /** Provider name, e.g. `"local"`, `"browserbase"`. */
    readonly name: string;
    /**
     * Boot a remote browser. Implementations are expected to populate
     * a session-scoped CDP endpoint or equivalent that the
     * {@link BrowserSession} can connect through.
     */
    open(config: ResolvedBrowserConfig): Promise<void>;
}

export class LocalProvider implements CloudBrowserProvider {
    readonly name = "local";

    async open(_config: ResolvedBrowserConfig): Promise<void> {
        // The local provider is driven directly inside BrowserSession;
        // this method exists for parity with the cloud providers and is
        // intentionally a no-op.
    }
}

export class BrowserbaseProviderStub implements CloudBrowserProvider {
    readonly name = "browserbase";

    async open(_config: ResolvedBrowserConfig): Promise<void> {
        throw new BrowserError(
            "browserbase provider is not implemented yet. " +
            "Use provider: 'local' for now, or follow the design doc " +
            ".plans/v6.6-v6.9-hermes-parity.md for the integration plan.",
        );
    }
}

export class BrowserUseProviderStub implements CloudBrowserProvider {
    readonly name = "browser-use";

    async open(_config: ResolvedBrowserConfig): Promise<void> {
        throw new BrowserError(
            "browser-use provider is not implemented yet. " +
            "Use provider: 'local' for now, or follow the design doc " +
            ".plans/v6.6-v6.9-hermes-parity.md for the integration plan.",
        );
    }
}

export function getProvider(name: string): CloudBrowserProvider {
    switch (name) {
        case "local":
            return new LocalProvider();
        case "browserbase":
            return new BrowserbaseProviderStub();
        case "browser-use":
            return new BrowserUseProviderStub();
        default:
            throw new BrowserError(`Unknown browser provider: ${name}`);
    }
}
