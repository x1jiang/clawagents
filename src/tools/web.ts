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
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";

import type { Tool, ToolResult } from "./registry.js";

const MAX_RESPONSE_CHARS = 50_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MiB hard cap on body bytes
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

async function isPrivateHost(host: string, resolved?: string[]): Promise<boolean> {
    if (!host) return true;
    if (resolved !== undefined) return resolved.some(isPrivateIp);
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

type PinnedTarget = {
    scheme: "http:" | "https:";
    hostname: string;
    port: number;
    ip: string;
    path: string;
};

/** Resolve once, validate, and return the IP we pinned to. The validity
 * decision uses ``ssrfDeps.isPrivateHost`` so tests can monkey-patch it.
 */
async function validateAndPin(
    target: string,
    allowPrivate: boolean,
): Promise<PinnedTarget | string> {
    let parsed: URL;
    try {
        parsed = new URL(target);
    } catch {
        return `Invalid URL: ${target}`;
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
        return `Refusing scheme '${parsed.protocol}'. web_fetch only allows http/https.`;
    }
    const hostname = parsed.hostname;
    if (!hostname) return `Invalid URL (no host): ${target}`;

    let ip: string;
    let resolved: string[] | undefined;
    if (isIP(hostname)) {
        ip = hostname;
    } else {
        try {
            const records = await lookup(hostname, { all: true });
            if (records.length === 0) {
                return `DNS lookup returned no records for '${hostname}'`;
            }
            resolved = records.map(r => r.address);
            ip = resolved[0];
        } catch (e) {
            return `DNS lookup failed for '${hostname}': ${String(e)}`;
        }
    }

    if (!allowPrivate && (await ssrfDeps.isPrivateHost(hostname, resolved))) {
        return (
            `Refusing to fetch '${hostname}': resolves to a private/loopback/` +
            "link-local/reserved address. Set CLAWAGENTS_WEB_ALLOW_PRIVATE=1 to override."
        );
    }

    const scheme = parsed.protocol as "http:" | "https:";
    const port = parsed.port
        ? Number(parsed.port)
        : (scheme === "https:" ? 443 : 80);
    const path = (parsed.pathname || "/") + (parsed.search || "");
    return { scheme, hostname, port, ip, path };
}

/** Issue one HTTP(S) request to a *specific* IP, sending the original
 * hostname as ``Host`` and SNI. Bounds body size at MAX_RESPONSE_BYTES.
 */
function fetchPinned(
    target: PinnedTarget,
    timeoutMs: number,
): Promise<
    | { status: number; headers: Record<string, string>; bodyBytes: Buffer }
    | { error: string }
> {
    return new Promise(resolve => {
        const isTls = target.scheme === "https:";
        const requestFn = isTls ? https.request : http.request;
        const req = requestFn(
            {
                host: target.ip,
                port: target.port,
                path: target.path,
                method: "GET",
                headers: {
                    Host:
                        target.port === (isTls ? 443 : 80)
                            ? target.hostname
                            : `${target.hostname}:${target.port}`,
                    "User-Agent": "ClawAgents/1.0",
                    "Accept-Encoding": "identity",
                    Connection: "close",
                },
                ...(isTls ? { servername: target.hostname } : {}),
            } as http.RequestOptions,
            res => {
                const status = res.statusCode ?? 0;
                const rawHeaders = res.headers as Record<string, string | string[] | undefined>;
                const headers: Record<string, string> = {};
                for (const k of Object.keys(rawHeaders)) {
                    const v = rawHeaders[k];
                    headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : (v ?? "");
                }
                const chunks: Buffer[] = [];
                let total = 0;
                let aborted = false;
                res.on("data", chunk => {
                    if (aborted) return;
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    if (total + buf.length > MAX_RESPONSE_BYTES) {
                        const remaining = MAX_RESPONSE_BYTES - total;
                        if (remaining > 0) chunks.push(buf.subarray(0, remaining));
                        aborted = true;
                        // Stop reading further data from the socket.
                        res.destroy();
                        return;
                    }
                    chunks.push(buf);
                    total += buf.length;
                });
                res.on("end", () => {
                    resolve({ status, headers, bodyBytes: Buffer.concat(chunks) });
                });
                res.on("error", err => {
                    // Treat aborted-mid-stream after we hit the cap as success.
                    if (aborted) {
                        resolve({ status, headers, bodyBytes: Buffer.concat(chunks) });
                    } else {
                        resolve({ error: `web_fetch failed: ${String(err)}` });
                    }
                });
            },
        );
        const timer = setTimeout(() => {
            req.destroy(new Error("timeout"));
        }, timeoutMs);
        req.on("error", err => {
            clearTimeout(timer);
            const msg = String(err);
            if (msg.includes("timeout")) {
                resolve({ error: `Request timed out after ${timeoutMs}ms` });
            } else {
                resolve({ error: `web_fetch failed: ${msg}` });
            }
        });
        req.on("close", () => clearTimeout(timer));
        req.end();
    });
}

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
    keywords: ["fetch url", "http request", "read webpage", "download text", "documentation"],
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

        try {
            let current = url;
            for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
                const validation = await validateAndPin(current, allowPrivate);
                if (typeof validation === "string") {
                    return { success: false, output: "", error: validation };
                }

                const fetched = await fetchPinned(validation, timeout);
                if ("error" in fetched) {
                    return { success: false, output: "", error: fetched.error };
                }

                const { status, headers, bodyBytes } = fetched;

                if (status >= 300 && status < 400) {
                    if (hop >= MAX_REDIRECTS) {
                        return {
                            success: false,
                            output: "",
                            error: `Too many redirects (>${MAX_REDIRECTS}) starting at ${url}`,
                        };
                    }
                    const location = headers["location"];
                    if (!location) {
                        return {
                            success: false,
                            output: "",
                            error: `HTTP ${status} without Location header at ${current}`,
                        };
                    }
                    const nextUrl = new URL(location, current).toString();
                    // Refuse a silent TLS downgrade across the redirect.
                    // An attacker who controls the next hop can otherwise
                    // strip TLS by pointing Location at http://.
                    if (
                        validation.scheme === "https:" &&
                        nextUrl.toLowerCase().startsWith("http://")
                    ) {
                        return {
                            success: false,
                            output: "",
                            error: "Refusing redirect: HTTPS endpoint sent a Location pointing to http:// (TLS downgrade)",
                        };
                    }
                    current = nextUrl;
                    continue;
                }

                if (status < 200 || status >= 300) {
                    return { success: false, output: "", error: `HTTP ${status}` };
                }

                const contentType = headers["content-type"] ?? "";
                let body = bodyBytes.toString("utf-8");

                if (body.length > MAX_RESPONSE_CHARS) {
                    body =
                        body.slice(0, MAX_RESPONSE_CHARS) +
                        `\n...(truncated at ${MAX_RESPONSE_CHARS} chars)`;
                }

                if (contentType.includes("html")) {
                    body = stripHtml(body);
                }

                return { success: true, output: `[${status}] ${current}\n\n${body}` };
            }

            return {
                success: false,
                output: "",
                error: `Too many redirects (>${MAX_REDIRECTS}) starting at ${url}`,
            };
        } catch (err) {
            return { success: false, output: "", error: `web_fetch failed: ${String(err)}` };
        }
    },
};

export const webTools: Tool[] = [webFetchTool];
