/**
 * Web Fetch Tool — retrieve content from a URL.
 *
 * Useful for reading documentation, API responses, or any web resource.
 * Returns plain text with HTML tags stripped for readability.
 *
 * Security
 * --------
 * `web_fetch` is callable by the LLM with arbitrary URLs, so it can be
 * weaponized for SSRF (e.g. asking the agent to read cloud metadata at
 * `http://169.254.169.254/` or internal services on `localhost`).
 *
 * Defenses:
 *   - only `http`/`https` schemes accepted
 *   - host is resolved and refused if it maps to a loopback, link-local,
 *     private, multicast, or unspecified address
 *   - **automatic redirect following is disabled**; we manually walk each
 *     hop with a small cap and re-run the SSRF check on every redirect
 *     target. A naive implementation that only validates the original URL
 *     can be bypassed by a public attacker host returning
 *     `302 Location: http://127.0.0.1/...` or `http://169.254.169.254/...`.
 *   - set `CLAWAGENTS_WEB_ALLOW_PRIVATE=1` to opt back into private hosts
 *     (dev environments, internal docs servers).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { Tool, ToolResult } from "./registry.js";

const MAX_RESPONSE_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** EC2/IMDSv1 metadata IPs we always block. */
const BLOCKED_METADATA_IPS = new Set(["169.254.169.254", "fd00:ec2::254"]);

/** Return true if *ip* is loopback/link-local/private/etc. */
function isPrivateIp(ip: string): boolean {
    if (BLOCKED_METADATA_IPS.has(ip)) return true;
    const family = isIP(ip);
    if (family === 4) {
        const parts = ip.split(".").map(n => parseInt(n, 10));
        if (parts.some(n => Number.isNaN(n))) return true;
        const [a, b] = parts as [number, number, number, number];
        if (a === 10) return true;                       // 10.0.0.0/8
        if (a === 127) return true;                      // loopback
        if (a === 0) return true;                        // unspecified
        if (a === 169 && b === 254) return true;         // link-local
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
        if (a === 192 && b === 168) return true;         // 192.168.0.0/16
        if (a >= 224) return true;                       // multicast/reserved
        return false;
    }
    if (family === 6) {
        const lower = ip.toLowerCase();
        if (lower === "::" || lower === "::1") return true;
        // fe80::/10 — link-local. First 10 bits fixed → hex prefixes fe80..febf.
        if (/^fe[89ab]/.test(lower)) return true;
        if (lower.startsWith("fc") || lower.startsWith("fd")) return true;     // ULA fc00::/7
        if (lower.startsWith("ff")) return true;                                // multicast
        if (lower.startsWith("::ffff:")) {
            // IPv4-mapped — re-check as v4
            return isPrivateIp(lower.slice("::ffff:".length));
        }
        return false;
    }
    return true; // unparseable — fail closed
}

async function isPrivateHost(host: string): Promise<boolean> {
    if (!host) return true;
    if (isIP(host)) return isPrivateIp(host);
    try {
        const records = await lookup(host, { all: true });
        return records.some(r => isPrivateIp(r.address));
    } catch {
        return true;
    }
}

/**
 * Internal SSRF dependencies. Exposed as an object so tests can inject a
 * stub via `t.mock.method(ssrfDeps, "isPrivateHost", ...)`. Production code
 * goes through this indirection at call time.
 */
export const ssrfDeps = {
    isPrivateHost,
    isPrivateIp,
};

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
    cacheable: true,
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

        const allowPrivate = ["1", "true", "yes"].includes(
            (process.env["CLAWAGENTS_WEB_ALLOW_PRIVATE"] ?? "").trim().toLowerCase(),
        );

        const validateHop = async (target: string): Promise<string | null> => {
            let parsedHop: URL;
            try {
                parsedHop = new URL(target);
            } catch {
                return `Invalid URL: ${target}`;
            }
            if (!ALLOWED_SCHEMES.has(parsedHop.protocol)) {
                return `Refusing scheme '${parsedHop.protocol}'. web_fetch only allows http/https.`;
            }
            if (!allowPrivate && (await ssrfDeps.isPrivateHost(parsedHop.hostname))) {
                return (
                    `Refusing to fetch '${parsedHop.hostname}': resolves to a private/loopback/` +
                    "link-local/reserved address. Set CLAWAGENTS_WEB_ALLOW_PRIVATE=1 to override."
                );
            }
            return null;
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
            let current = url;
            for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
                const err = await validateHop(current);
                if (err) {
                    return { success: false, output: "", error: err };
                }

                const resp = await fetch(current, {
                    signal: controller.signal,
                    headers: { "User-Agent": "ClawAgents/1.0" },
                    redirect: "manual",
                });

                if (resp.status >= 300 && resp.status < 400) {
                    if (hop >= MAX_REDIRECTS) {
                        return {
                            success: false,
                            output: "",
                            error: `Too many redirects (>${MAX_REDIRECTS}) starting at ${url}`,
                        };
                    }
                    const location = resp.headers.get("location");
                    if (!location) {
                        return {
                            success: false,
                            output: "",
                            error: `HTTP ${resp.status} without Location header at ${current}`,
                        };
                    }
                    current = new URL(location, current).toString();
                    continue;
                }

                if (!resp.ok) {
                    return { success: false, output: "", error: `HTTP ${resp.status}: ${resp.statusText}` };
                }

                const contentType = resp.headers.get("content-type") ?? "";
                let body = await resp.text();

                if (body.length > MAX_RESPONSE_CHARS) {
                    body =
                        body.slice(0, MAX_RESPONSE_CHARS) +
                        `\n...(truncated at ${MAX_RESPONSE_CHARS} chars)`;
                }

                if (contentType.includes("html")) {
                    body = stripHtml(body);
                }

                return { success: true, output: `[${resp.status}] ${current}\n\n${body}` };
            }

            return {
                success: false,
                output: "",
                error: `Too many redirects (>${MAX_REDIRECTS}) starting at ${url}`,
            };
        } catch (err) {
            const msg = String(err);
            if (msg.includes("abort")) {
                return { success: false, output: "", error: `Request timed out after ${timeout}ms` };
            }
            return { success: false, output: "", error: `web_fetch failed: ${msg}` };
        } finally {
            clearTimeout(timer);
        }
    },
};

export const webTools: Tool[] = [webFetchTool];
