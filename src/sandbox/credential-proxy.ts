/**
 * Credential proxy for sandboxed agent environments.
 *
 * Real API keys never enter subprocess/container environments.
 * The proxy intercepts requests and injects credentials transparently.
 *
 * Usage:
 *   const proxy = new CredentialProxy({ "Authorization": "Bearer sk-..." });
 *   const url = proxy.start();   // e.g. "http://127.0.0.1:54321"
 *   // point sub-agent at url, strip real keys from its env
 *   proxy.stop();
 *
 * Uses only Node.js stdlib (http) — no extra dependencies.
 */

import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

const HOP_BY_HOP = new Set([
    "host", "content-length", "transfer-encoding", "connection",
]);

function forwardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    credentials: Record<string, string>,
    body?: Buffer,
): void {
    const targetUrl = req.url ?? "/";
    let parsed: URL;
    try {
        parsed = new URL(targetUrl);
    } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: invalid URL");
        return;
    }

    const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || 80,
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
        (options.headers as Record<string, string>)[name] = value;
    }

    if (body && body.length > 0) {
        (options.headers as Record<string, string>)["content-length"] = String(body.length);
    }

    const proxyReq = http.request(options, (proxyRes) => {
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
    private _server: http.Server | null = null;
    private _url: string | null = null;

    constructor(
        credentials: Record<string, string>,
        host = "127.0.0.1",
        port = 0,
    ) {
        this._credentials = { ...credentials };
        this._host = host;
        this._port = port;
    }

    /**
     * Start the proxy and return its base URL (e.g. `"http://127.0.0.1:54321"`).
     * The proxy runs in the background. Call `stop()` for clean shutdown.
     */
    start(): string {
        if (this._server !== null) {
            return this._url!;
        }

        const credentials = this._credentials;

        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
                const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
                forwardRequest(req, res, credentials, body);
            });
            req.on("error", () => {
                res.writeHead(400);
                res.end();
            });
        });

        server.listen(this._port, this._host, () => {
            const addr = server.address();
            const actualPort = addr && typeof addr === "object" ? addr.port : this._port;
            this._url = `http://${this._host}:${actualPort}`;
        });

        this._server = server;

        // Wait synchronously for the listen to complete (port assignment)
        // The server emits 'listening' before the callback — we already have _url set above.
        // For port 0 we need to wait; use a spin-wait on _url.
        const deadline = Date.now() + 5000;
        while (!this._url && Date.now() < deadline) {
            // Node.js is single-threaded; the listen callback fires asynchronously.
            // Force the event loop tick via a sync check — in practice _url is set
            // by the time we reach here because listen() calls the callback inline
            // when the port is already bound (for OS-assigned ports it's immediate).
        }

        if (!this._url) {
            const addr = server.address();
            const actualPort = addr && typeof addr === "object" ? addr.port : this._port;
            this._url = `http://${this._host}:${actualPort}`;
        }

        return this._url;
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
