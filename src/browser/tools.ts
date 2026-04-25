/**
 * Browser function-tool wrappers.
 *
 * `createBrowserTools()` returns a list of {@link Tool}s that the
 * agent can register with `ClawAgent` to drive a {@link BrowserSession}.
 * Each tool is a thin shim that:
 *
 * 1. Performs cheap pre-flight checks (URL safety, `allowEval`, etc.)
 *    *before* lazy-launching Chromium, so disallowed actions reject
 *    quickly without paying the browser-startup cost.
 * 2. Calls the matching `BrowserSession` method.
 * 3. Returns a structured `ToolResult` so the agent can reason about
 *    success vs. typed failure.
 *
 * The tools share one session by default — pass an explicit
 * `BrowserSession` if you want each agent / subagent to own its own
 * tab.
 */

import type { Tool, ToolResult } from "../tools/registry.js";
import { functionTool } from "../function-tool.js";
import { checkUrl } from "./safety.js";
import type { BrowserConfig } from "./config.js";
import {
    BrowserError,
    ElementNotFoundError,
    MissingPlaywrightError,
    NavigationBlockedError,
    SnapshotError,
} from "./errors.js";
import { BrowserSession } from "./session.js";
import type { BrowserSnapshot, SnapshotElement } from "./snapshot.js";

export interface CreateBrowserToolsOptions {
    /** Reuse an existing session. If omitted, one is created lazily. */
    session?: BrowserSession;
    /** Used only when `session` is omitted. */
    config?: BrowserConfig;
}

/**
 * Build the standard set of browser tools wired to a single
 * {@link BrowserSession}. Returns the session alongside the tools so
 * callers can dispose it with `.close()`.
 */
export function createBrowserTools(
    opts: CreateBrowserToolsOptions = {},
): { tools: Tool[]; session: BrowserSession } {
    const session = opts.session ?? new BrowserSession(opts.config);

    const ensureStarted = async (): Promise<void> => {
        if (!session.isStarted) {
            await session.start();
        }
    };

    const navigateTool = functionTool({
        name: "browser_navigate",
        description:
            "Navigate the browser to a URL. Blocks SSRF / loopback / private " +
            "addresses unless allowPrivateNetwork is enabled. Returns the " +
            "final URL after redirects.",
        parameters: {
            url: {
                type: "string",
                description: "Absolute http(s) URL to navigate to.",
                required: true,
            },
        },
        async execute({ url }): Promise<ToolResult> {
            // Validate *before* spawning Chromium so SSRF rejection
            // never has to launch a browser.
            const err = await checkUrl(String(url), {
                allowPrivate: session.config.allowPrivateNetwork,
            });
            if (err !== null) {
                throw new NavigationBlockedError(err);
            }
            await ensureStarted();
            const finalUrl = await session.navigate(String(url));
            return { success: true, output: finalUrl };
        },
    });

    const backTool = functionTool({
        name: "browser_back",
        description: "Navigate one entry back in browser history.",
        async execute(): Promise<ToolResult> {
            await ensureStarted();
            return { success: true, output: await session.back() };
        },
    });

    const forwardTool = functionTool({
        name: "browser_forward",
        description: "Navigate one entry forward in browser history.",
        async execute(): Promise<ToolResult> {
            await ensureStarted();
            return { success: true, output: await session.forward() };
        },
    });

    const snapshotTool = functionTool({
        name: "browser_snapshot",
        description:
            "Capture an accessibility-tree snapshot of the current page. " +
            "Returns a text representation where every interactive element " +
            "has a stable @eN ref (e.g. @e1, @e2). Use those refs with " +
            "browser_click, browser_type, etc.",
        async execute(): Promise<ToolResult> {
            await ensureStarted();
            const snap = await session.snapshot();
            return {
                success: true,
                output: formatSnapshot(snap),
            };
        },
    });

    const clickTool = functionTool({
        name: "browser_click",
        description:
            "Click an element previously surfaced by browser_snapshot. " +
            "Pass the @eN ref (e.g. '@e3').",
        parameters: {
            ref: {
                type: "string",
                description: "Ref from the most recent browser_snapshot.",
                required: true,
            },
        },
        async execute({ ref }): Promise<ToolResult> {
            await ensureStarted();
            await session.click(String(ref));
            return { success: true, output: `clicked ${ref}` };
        },
    });

    const typeTool = functionTool({
        name: "browser_type",
        description:
            "Type text into an input element previously surfaced by " +
            "browser_snapshot. Set submit=true to press Enter after typing.",
        parameters: {
            ref: { type: "string", description: "Ref to type into.", required: true },
            text: { type: "string", description: "Text to type.", required: true },
            submit: { type: "boolean", description: "Press Enter after typing.", default: false },
            clear: { type: "boolean", description: "Clear the field first.", default: true },
        },
        async execute({ ref, text, submit, clear }): Promise<ToolResult> {
            await ensureStarted();
            await session.type(String(ref), String(text), {
                submit: Boolean(submit),
                clear: Boolean(clear),
            });
            return { success: true, output: `typed into ${ref}` };
        },
    });

    const hoverTool = functionTool({
        name: "browser_hover",
        description: "Hover the mouse over an element by @eN ref.",
        parameters: {
            ref: { type: "string", description: "Ref to hover.", required: true },
        },
        async execute({ ref }): Promise<ToolResult> {
            await ensureStarted();
            await session.hover(String(ref));
            return { success: true, output: `hovered ${ref}` };
        },
    });

    const selectOptionTool = functionTool({
        name: "browser_select_option",
        description: "Select an <option> inside a <select> referenced by @eN.",
        parameters: {
            ref: { type: "string", description: "Ref of the <select>.", required: true },
            value: { type: "string", description: "Option value to select.", required: true },
        },
        async execute({ ref, value }): Promise<ToolResult> {
            await ensureStarted();
            await session.selectOption(String(ref), String(value));
            return { success: true, output: `selected ${value} on ${ref}` };
        },
    });

    const waitForTool = functionTool({
        name: "browser_wait_for",
        description:
            "Wait until the given text appears anywhere on the page, " +
            "or fail after timeout.",
        parameters: {
            text: { type: "string", description: "Text to wait for.", required: true },
            timeout: { type: "number", description: "Timeout in seconds.", default: 30 },
        },
        async execute({ text, timeout }): Promise<ToolResult> {
            await ensureStarted();
            await session.waitFor(String(text), Number(timeout) || 30);
            return { success: true, output: `found '${text}'` };
        },
    });

    const screenshotTool = functionTool({
        name: "browser_screenshot",
        description:
            "Capture a PNG screenshot of the page (or full page) and " +
            "return base64-encoded bytes.",
        parameters: {
            full_page: { type: "boolean", description: "Capture entire scroll height.", default: false },
        },
        async execute({ full_page }): Promise<ToolResult> {
            await ensureStarted();
            const b64 = await session.screenshot({ fullPage: Boolean(full_page) });
            return { success: true, output: b64 };
        },
    });

    const evaluateTool = functionTool({
        name: "browser_evaluate",
        description:
            "Run JavaScript in the page (DISABLED unless allowEval=true in " +
            "BrowserConfig). Returns the JSON-serialised result.",
        parameters: {
            expression: { type: "string", description: "JavaScript expression.", required: true },
        },
        async execute({ expression }): Promise<ToolResult> {
            // Gate first — don't spend time launching Chromium just to refuse.
            if (!session.config.allowEval) {
                throw new BrowserError(
                    "browser_evaluate is disabled. Set BrowserConfig.allowEval=true to enable.",
                );
            }
            await ensureStarted();
            const result = await session.evaluate(String(expression));
            try {
                return { success: true, output: JSON.stringify(result) };
            } catch {
                return { success: true, output: String(result) };
            }
        },
    });

    const closeTool = functionTool({
        name: "browser_close",
        description: "Close the browser and free its resources.",
        async execute(): Promise<ToolResult> {
            await session.close();
            return { success: true, output: "closed" };
        },
    });

    const tools = [
        navigateTool,
        backTool,
        forwardTool,
        snapshotTool,
        clickTool,
        typeTool,
        hoverTool,
        selectOptionTool,
        waitForTool,
        screenshotTool,
        evaluateTool,
        closeTool,
    ];

    return { tools, session };
}

function formatSnapshot(snap: BrowserSnapshot): string {
    const lines = [
        `URL: ${snap.url}`,
        `Title: ${snap.title}`,
        snap.truncated ? "(truncated — page exceeds MAX_NODES)" : "",
        "",
        snap.text,
    ].filter(Boolean);
    return lines.join("\n");
}

export {
    BrowserError,
    ElementNotFoundError,
    MissingPlaywrightError,
    NavigationBlockedError,
    SnapshotError,
};
export type { SnapshotElement };
