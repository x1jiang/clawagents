/**
 * MCP server abstractions: ``MCPServer`` ABC and stdio/SSE/Streamable-HTTP impls.
 *
 * These wrap the official ``@modelcontextprotocol/sdk`` ``Client`` plus the
 * transport classes (``StdioClientTransport`` / ``SSEClientTransport`` /
 * ``StreamableHTTPClientTransport``). We do **not** implement JSON-RPC framing
 * ourselves.
 *
 * Each server tracks an :class:`MCPLifecyclePhase` (Idle → Connecting →
 * Initializing → DiscoveringTools → Ready → Invoking → Errored / Shutdown),
 * emitting tracing spans on every transition.
 *
 * The optional SDK is loaded lazily. ``import "clawagents"`` always works;
 * only ``connect()`` requires the SDK.
 */

import { customSpan, toolSpan } from "../tracing/index.js";

// ─── Lifecycle phase ──────────────────────────────────────────────────────

export enum MCPLifecyclePhase {
    Idle = "idle",
    Connecting = "connecting",
    Initializing = "initializing",
    DiscoveringTools = "discovering_tools",
    Ready = "ready",
    Invoking = "invoking",
    Errored = "errored",
    Shutdown = "shutdown",
}

// ─── Param types ──────────────────────────────────────────────────────────

export interface MCPServerStdioParams {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    /**
     * How to handle stderr of the child process. Forwarded to the SDK transport;
     * defaults to "inherit".
     */
    stderr?: "inherit" | "ignore" | "pipe";
}

export interface MCPServerSseParams {
    url: string;
    headers?: Record<string, string>;
}

export interface MCPServerStreamableHttpParams {
    url: string;
    headers?: Record<string, string>;
}

// ─── Tool descriptor ──────────────────────────────────────────────────────

export interface MCPToolDescriptor {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    serverName: string;
}

export type ToolFilter = (
    descriptor: MCPToolDescriptor,
) => boolean | Promise<boolean>;

// ─── SDK probe ────────────────────────────────────────────────────────────

const MCP_INSTALL_HINT =
    "The @modelcontextprotocol/sdk package is required to use MCPServerStdio / " +
    "MCPServerSse / MCPServerStreamableHttp. Install it with: " +
    "npm install @modelcontextprotocol/sdk";

let _sdkProbeCache: boolean | null = null;

/** Returns ``true`` if ``@modelcontextprotocol/sdk`` resolves at runtime. */
export async function isMCPSdkAvailable(): Promise<boolean> {
    if (_sdkProbeCache !== null) return _sdkProbeCache;
    try {
        await import("@modelcontextprotocol/sdk/client/index.js");
        _sdkProbeCache = true;
    } catch {
        _sdkProbeCache = false;
    }
    return _sdkProbeCache;
}

/** Throws a clear Error when the optional SDK is missing. */
export async function requireMCPSdk(): Promise<void> {
    if (!(await isMCPSdkAvailable())) {
        throw new Error(MCP_INSTALL_HINT);
    }
}

// ─── MCPServer base class ─────────────────────────────────────────────────

export interface MCPServerOptions {
    name?: string;
    toolFilter?: ToolFilter;
    cacheToolsList?: boolean;
}

/**
 * Base class for Model Context Protocol servers. Subclasses provide the
 * transport-specific Client + Transport pair via ``createClient``.
 */
export abstract class MCPServer {
    public readonly cacheToolsList: boolean;
    public readonly toolFilter?: ToolFilter;

    private _phase: MCPLifecyclePhase = MCPLifecyclePhase.Idle;
    private _client: any = null; // SDK Client (loaded lazily)
    private _transport: any = null;
    private _toolsCache: MCPToolDescriptor[] | null = null;
    private _lastError: string | null = null;
    private readonly _nameOverride?: string;

    protected constructor(opts: MCPServerOptions = {}) {
        this._nameOverride = opts.name;
        this.toolFilter = opts.toolFilter;
        this.cacheToolsList = opts.cacheToolsList ?? false;
    }

    /** Subclass hook — produce a default human-readable name. */
    protected abstract defaultName(): string;

    /** Subclass hook — return the SDK transport instance for connect(). */
    protected abstract createTransport(): Promise<any>;

    public get name(): string {
        return this._nameOverride ?? this.defaultName();
    }

    public get phase(): MCPLifecyclePhase {
        return this._phase;
    }

    public get lastError(): string | null {
        return this._lastError;
    }

    private transition(phase: MCPLifecyclePhase, error?: string | null): void {
        const prev = this._phase;
        this._phase = phase;
        if (error !== undefined) this._lastError = error;
        // Emit a span recording the transition. Span is opened+closed instantly.
        customSpan(`mcp.lifecycle.${phase}`, () => undefined, {
            server: this.name,
            from_phase: prev,
            to_phase: phase,
            error: error ?? null,
        });
    }

    /** Spawn the transport, open a Client, run the MCP handshake. */
    public async connect(): Promise<void> {
        await requireMCPSdk();
        if (
            this._phase !== MCPLifecyclePhase.Idle &&
            this._phase !== MCPLifecyclePhase.Shutdown &&
            this._phase !== MCPLifecyclePhase.Errored
        ) {
            return;
        }

        this.transition(MCPLifecyclePhase.Connecting);
        try {
            const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
            const transport = await this.createTransport();
            const client = new Client(
                { name: "clawagents", version: "6.4" },
                { capabilities: {} },
            );
            this.transition(MCPLifecyclePhase.Initializing);
            await client.connect(transport);
            this._client = client;
            this._transport = transport;
            this.transition(MCPLifecyclePhase.Ready);
        } catch (err) {
            this.transition(MCPLifecyclePhase.Errored, String(err));
            try {
                if (this._transport && typeof this._transport.close === "function") {
                    await this._transport.close();
                }
            } catch { /* swallow */ }
            this._client = null;
            this._transport = null;
            throw err;
        }
    }

    /** Return the tools advertised by the server (filtered + optionally cached). */
    public async listTools(opts: { forceRefresh?: boolean } = {}): Promise<MCPToolDescriptor[]> {
        if (!this._client) {
            throw new Error(`MCP server '${this.name}' is not connected. Call connect() first.`);
        }
        if (this.cacheToolsList && !opts.forceRefresh && this._toolsCache !== null) {
            return this._toolsCache;
        }

        this.transition(MCPLifecyclePhase.DiscoveringTools);
        let listed: { tools?: any[] };
        try {
            listed = await this._client.listTools();
        } catch (err) {
            this.transition(MCPLifecyclePhase.Errored, String(err));
            throw err;
        }
        this.transition(MCPLifecyclePhase.Ready);

        const descriptors: MCPToolDescriptor[] = (listed.tools ?? []).map((t: any) => ({
            name: String(t?.name ?? ""),
            description: String(t?.description ?? ""),
            inputSchema:
                t?.inputSchema && typeof t.inputSchema === "object"
                    ? (t.inputSchema as Record<string, unknown>)
                    : {},
            serverName: this.name,
        }));

        let filtered = descriptors;
        if (this.toolFilter) {
            filtered = [];
            for (const d of descriptors) {
                let verdict = this.toolFilter(d);
                if (verdict instanceof Promise) verdict = await verdict;
                if (verdict) filtered.push(d);
            }
        }

        if (this.cacheToolsList) this._toolsCache = filtered;
        return filtered;
    }

    /** Call ``toolName`` on the server. Returns the raw ``CallToolResult``. */
    public async invokeTool(
        toolName: string,
        args: Record<string, unknown> = {},
    ): Promise<any> {
        if (!this._client) {
            throw new Error(`MCP server '${this.name}' is not connected. Call connect() first.`);
        }
        return await toolSpan(
            `mcp.${this.name}.${toolName}`,
            async () => {
                this.transition(MCPLifecyclePhase.Invoking);
                try {
                    const result = await this._client.callTool({
                        name: toolName,
                        arguments: args,
                    });
                    this.transition(MCPLifecyclePhase.Ready);
                    return result;
                } catch (err) {
                    this.transition(MCPLifecyclePhase.Errored, String(err));
                    throw err;
                }
            },
            { server: this.name, tool: toolName },
        );
    }

    /** Close the underlying transport. */
    public async shutdown(): Promise<void> {
        if (!this._client && !this._transport) return;
        try {
            if (this._client && typeof this._client.close === "function") {
                await this._client.close();
            } else if (this._transport && typeof this._transport.close === "function") {
                await this._transport.close();
            }
        } catch (err) {
            this._lastError = String(err);
        } finally {
            this._client = null;
            this._transport = null;
            this._toolsCache = null;
            this.transition(MCPLifecyclePhase.Shutdown);
        }
    }
}

// ─── MCPServerStdio ───────────────────────────────────────────────────────

export class MCPServerStdio extends MCPServer {
    public readonly params: MCPServerStdioParams;

    constructor(args: { params: MCPServerStdioParams } & MCPServerOptions) {
        super(args);
        this.params = args.params;
    }

    protected defaultName(): string {
        return `stdio: ${this.params.command}`;
    }

    protected async createTransport(): Promise<any> {
        const { StdioClientTransport } = await import(
            "@modelcontextprotocol/sdk/client/stdio.js"
        );
        return new StdioClientTransport({
            command: this.params.command,
            args: this.params.args ?? [],
            env: this.params.env,
            cwd: this.params.cwd,
            stderr: this.params.stderr,
        });
    }
}

// ─── MCPServerSse ─────────────────────────────────────────────────────────

export class MCPServerSse extends MCPServer {
    public readonly params: MCPServerSseParams;

    constructor(args: { params: MCPServerSseParams } & MCPServerOptions) {
        super(args);
        this.params = args.params;
    }

    protected defaultName(): string {
        return `sse: ${this.params.url}`;
    }

    protected async createTransport(): Promise<any> {
        const { SSEClientTransport } = await import(
            "@modelcontextprotocol/sdk/client/sse.js"
        );
        const init: Record<string, unknown> = {};
        if (this.params.headers) init["requestInit"] = { headers: this.params.headers };
        return new SSEClientTransport(new URL(this.params.url), init);
    }
}

// ─── MCPServerStreamableHttp ──────────────────────────────────────────────

export class MCPServerStreamableHttp extends MCPServer {
    public readonly params: MCPServerStreamableHttpParams;

    constructor(args: { params: MCPServerStreamableHttpParams } & MCPServerOptions) {
        super(args);
        this.params = args.params;
    }

    protected defaultName(): string {
        return `streamable_http: ${this.params.url}`;
    }

    protected async createTransport(): Promise<any> {
        const { StreamableHTTPClientTransport } = await import(
            "@modelcontextprotocol/sdk/client/streamableHttp.js"
        );
        const init: Record<string, unknown> = {};
        if (this.params.headers) init["requestInit"] = { headers: this.params.headers };
        return new StreamableHTTPClientTransport(new URL(this.params.url), init);
    }
}
