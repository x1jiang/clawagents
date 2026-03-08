/**
 * Web Fetch Tool — retrieve content from a URL.
 *
 * Useful for reading documentation, API responses, or any web resource.
 * Returns plain text with HTML tags stripped for readability.
 */

import type { Tool, ToolResult } from "./registry.js";

const MAX_RESPONSE_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 15_000;

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<nav[\s\S]*?<\/nav>/gi, "")
        .replace(/<footer[\s\S]*?<\/footer>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export const webFetchTool: Tool = {
    name: "web_fetch",
    description:
        "Fetch content from a URL. Returns the text content of the page. " +
        "Useful for reading documentation, API responses, or checking web resources. " +
        "HTML is stripped for readability. JSON responses are returned as-is.",
    parameters: {
        url: { type: "string", description: "The URL to fetch", required: true },
        timeout: { type: "number", description: `Timeout in ms. Default: ${DEFAULT_TIMEOUT_MS}` },
    },
    async execute(args): Promise<ToolResult> {
        const url = String(args["url"] ?? "");
        const timeout = Math.max(1000, Number(args["timeout"] ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);

        if (!url) {
            return { success: false, output: "", error: "No URL provided" };
        }

        try {
            new URL(url);
        } catch {
            return { success: false, output: "", error: `Invalid URL: ${url}` };
        }

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);

            const resp = await fetch(url, {
                signal: controller.signal,
                headers: { "User-Agent": "ClawAgents/1.0" },
                redirect: "follow",
            });
            clearTimeout(timer);

            if (!resp.ok) {
                return { success: false, output: "", error: `HTTP ${resp.status}: ${resp.statusText}` };
            }

            const contentType = resp.headers.get("content-type") ?? "";
            let body = await resp.text();

            if (body.length > MAX_RESPONSE_CHARS) {
                body = body.slice(0, MAX_RESPONSE_CHARS) + `\n...(truncated at ${MAX_RESPONSE_CHARS} chars)`;
            }

            if (contentType.includes("html")) {
                body = stripHtml(body);
            }

            return { success: true, output: `[${resp.status}] ${url}\n\n${body}` };
        } catch (err) {
            const msg = String(err);
            if (msg.includes("abort")) {
                return { success: false, output: "", error: `Request timed out after ${timeout}ms` };
            }
            return { success: false, output: "", error: `web_fetch failed: ${msg}` };
        }
    },
};

export const webTools: Tool[] = [webFetchTool];
