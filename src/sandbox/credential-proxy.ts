/**
 * Credential proxy for sandboxed agent environments.
 *
 * Real API keys never enter subprocess/container environments.
 * The proxy intercepts requests and injects credentials transparently.
 *
 * Usage:
 *   const proxy = new CredentialProxy({ "Authorization": "Bearer sk-..." });
 *   const url = await proxy.start();   // e.g. "http://127.0.0.1:54321"
 *   // point sub-agent at url, strip real keys from its env
 *   proxy.stop();
 *
 * Uses only Node.js stdlib (http/https) — no extra dependencies.
 */

import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

const HOP_BY_HOP = new Set([
    "host", "content-length", "transfer-encoding", "connection",
]);

const DEFAULT_UPSTREAM_BASE_URLS: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com",
};

function providerForRequest(req: IncomingMessage): string {
    if (req.headers["anthropic-version"] || req.headers["x-api-key"]) {
        return "anthropic";
    }
    return "openai";
}

function resolveTargetUrl(req: IncomingMessage, upstreamBaseUrls: Record<string, string>): URL {
    const rawUrl = req.url ?? "/";
    const parsed = new URL(rawUrl, "http://proxy.local");
    if (parsed.protocol !== "http:" || parsed.hostname !== "proxy.local") {
        return new URL(rawUrl);
    }

    const provider = providerForRequest(req);
    const base = new URL(upstreamBaseUrls[provider] ?? DEFAULT_UPSTREAM_BASE_URLS[provider]!);
    const requestedPath = parsed.pathname.startsWith("/") ? parsed.pathname : `/${parsed.pathname}`;
    const basePath = base.pathname.replace(/\/$/, "");
    const path = basePath && requestedPath.startsWith(`${basePath}/`)
        ? requestedPath
        : `${basePath}/${requestedPath.replace(/^\//, "")}`.replace(/\/{2,}/g, "/");
    return new URL(`${path}${parsed.search}`, base);
}

function allowedOrigins(upstreamBaseUrls: Record<string, string>): Set<string> {
    return new Set(Object.values(upstreamBaseUrls).map((url) => {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}`;
    }));
}

function credentialAppliesToTarget(headerName: string, target: URL): boolean {
    const lower = headerName.toLowerCase();
    if (target.hostname.includes("anthropic")) return lower === "x-api-key";
    if (target.hostname.includes("openai")) return lower === "authorization";
    return true;
}

function forwardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    credentials: Record<string, string>,
    upstreamBaseUrls: Record<string, string>,
    body?: Buffer,
): void {
    let parsed: URL;
    try {
        parsed = resolveTargetUrl(req, upstreamBaseUrls);
    } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: invalid URL");
        return;
    }
    if (!allowedOrigins(upstreamBaseUrls).has(`${parsed.protocol}//${parsed.host}`)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: refusing to proxy untrusted upstream");
        return;
    }

    const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: {},
    };

    // Copy client headers, skip hop-by-hop
    for (const [key, value] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) {
            (options.headers as Record<string, string | string[]>)[key] = value as string | string[];
        }
    }

    // Inject credentials
    for (const [name, value] of Object.entries(credentials)) {
        if (credentialAppliesToTarget(name, parsed)) {
            (options.headers as Record<string, string>)[name] = value;
        }
    }

    if (body && body.length > 0) {
        (options.headers as Record<string, string>)["content-length"] = String(body.length);
    }

    const transport = parsed.protocol === "https:" ? https : http;
    const proxyReq = transport.request(options, (proxyRes) => {
        const statusCode = proxyRes.statusCode ?? 502;
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) {
                responseHeaders[key] = value as string | string[];
            }
        }
        res.writeHead(statusCode, responseHeaders);
        proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
        const msg = Buffer.from(String(err));
        res.writeHead(502, {
            "Content-Type": "text/plain",
            "Content-Length": String(msg.length),
        });
        res.end(msg);
    });

    if (body && body.length > 0) {
        proxyReq.write(body);
    }
    proxyReq.end();
}

/**
 * Lightweight HTTP proxy that injects API credentials into forwarded requests.
 *
 * @param credentials - Mapping of header name → header value to inject.
 *   Example: `{ "Authorization": "Bearer sk-...", "x-api-key": "..." }`
 * @param host - Bind address (default `"127.0.0.1"`).
 * @param port - Port to listen on. `0` means OS auto-assigns a free port.
 */
export class CredentialProxy {
    private _credentials: Record<string, string>;
    private _host: string;
    private _port: number;
    private _upstreamBaseUrls: Record<string, string>;
    private _server: http.Server | null = null;
    private _url: string | null = null;

    constructor(
        credentials: Record<string, string>,
        host = "127.0.0.1",
        port = 0,
        upstreamBaseUrls: Record<string, string> = DEFAULT_UPSTREAM_BASE_URLS,
    ) {
        this._credentials = { ...credentials };
        this._host = host;
        this._port = port;
        this._upstreamBaseUrls = { ...upstreamBaseUrls };
    }

    /**
     * Start the proxy and return its base URL (e.g. `"http://127.0.0.1:54321"`).
     * The proxy runs in the background. Call `stop()` for clean shutdown.
     */
    async start(): Promise<string> {
        if (this._server !== null) {
            return this._url!;
        }

        const credentials = this._credentials;
        const upstreamBaseUrls = this._upstreamBaseUrls;

        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
                const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
                forwardRequest(req, res, credentials, upstreamBaseUrls, body);
            });
            req.on("error", () => {
                res.writeHead(400);
                res.end();
            });
        });

        this._server = server;
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(this._port, this._host, () => {
                server.off("error", reject);
                const addr = server.address();
                const actualPort = addr && typeof addr === "object" ? addr.port : this._port;
                this._url = `http://${this._host}:${actualPort}`;
                resolve();
            });
        });

        return this._url!;
    }

    /** Shut down the proxy server. */
    stop(): void {
        if (this._server) {
            this._server.close();
            this._server = null;
        }
        this._url = null;
    }

    /** The proxy URL after `start()` is called, else `null`. */
    get url(): string | null {
        return this._url;
    }

    [Symbol.asyncDispose](): Promise<void> {
        this.stop();
        return Promise.resolve();
    }
}
