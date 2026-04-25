/**
 * URL safety checks for browser navigation.
 *
 * Reuses {@link ssrfDeps.isPrivateHost} from `tools/web.ts` so the
 * same hosts blocked by `web_fetch` are blocked here.
 *
 * We also enforce a scheme allow-list (`http`, `https`, plus `file`
 * and `data` for tests when `allowPrivateNetwork=true`).
 */

import { ssrfDeps } from "../tools/web.js";

const SAFE_SCHEMES = new Set(["http:", "https:"]);
const TEST_SCHEMES = new Set(["file:", "data:", "about:"]);

/**
 * Validate `url` before navigating to it. Returns an error message if
 * the URL is rejected, or `null` if it is safe.
 */
export async function checkUrl(
    url: string,
    opts: { allowPrivate: boolean },
): Promise<string | null> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return `Invalid URL: ${url}`;
    }

    const scheme = parsed.protocol;

    if (TEST_SCHEMES.has(scheme)) {
        if (!opts.allowPrivate) {
            return (
                `Refusing scheme '${scheme}': only allowed when ` +
                "BrowserConfig.allowPrivateNetwork is true."
            );
        }
        return null;
    }

    if (!SAFE_SCHEMES.has(scheme)) {
        return (
            `Refusing scheme '${scheme}': browser_navigate only allows ` +
            "http and https (or file/data when allowPrivateNetwork=true)."
        );
    }

    if (!opts.allowPrivate) {
        const host = parsed.hostname;
        if (!host || (await ssrfDeps.isPrivateHost(host))) {
            return (
                `Refusing to navigate to '${host || url}': resolves to a ` +
                "private/loopback/link-local/reserved address. Set " +
                "BrowserConfig.allowPrivateNetwork=true to override."
            );
        }
    }

    return null;
}
