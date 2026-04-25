/**
 * Browser error types.
 *
 * Kept dependency-free so callers can `instanceof BrowserError` without
 * forcing the optional `playwright` peer dependency to be installed.
 */

export class BrowserError extends Error {
    override name = "BrowserError";
    constructor(message: string) {
        super(message);
    }
}

export class MissingPlaywrightError extends BrowserError {
    override name = "MissingPlaywrightError";
    constructor(
        message =
            "Playwright is not installed. Install browser support with " +
            "`npm install playwright` and then run `npx playwright install chromium`.",
    ) {
        super(message);
    }
}

export class NavigationBlockedError extends BrowserError {
    override name = "NavigationBlockedError";
}

export class SnapshotError extends BrowserError {
    override name = "SnapshotError";
}

export class ElementNotFoundError extends BrowserError {
    override name = "ElementNotFoundError";
}
