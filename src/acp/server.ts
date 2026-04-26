/**
 * Stdio JSON-RPC ACP server wrapper around a ClawAgents agent.
 *
 * The heavy lifting of the JSON-RPC framing is delegated to the official
 * `@zed-industries/agent-client-protocol` package — we only contribute
 * the bridge between *our* agent loop and *its* `Agent` interface.
 *
 * Importing this module never fails: the optional `agent-client-protocol`
 * package is loaded lazily inside `AcpServer.serve()`. If it is missing
 * we throw `MissingAcpDependencyError` with a clear install hint.
 *
 * Mirrors `clawagents.acp.server` on the Python side. For tests,
 * `runPrompt()` exposes the inner translation pipeline without
 * requiring the optional package or stdio plumbing.
 */

import { createRequire } from "node:module";
import { MissingAcpDependencyError } from "./errors.js";
import {
    PromptRequest,
    StopReason,
    StopReasonValues,
    promptFromDict,
} from "./messages.js";
import {
    AgentSession,
    PermissionRequester,
    SessionEventSink,
} from "./session.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentLike = any;

export type PromptRunner = (
    agent: AgentLike,
    prompt: PromptRequest,
    session: AgentSession
) => Promise<StopReason>;

const _localRequire = createRequire(import.meta.url);

function probeAcp(): boolean {
    try {
        _localRequire.resolve("@zed-industries/agent-client-protocol");
        return true;
    } catch {
        return false;
    }
}

/** Whether the optional `agent-client-protocol` package is importable. */
export const ACP_AVAILABLE: boolean = probeAcp();

// ──────────────────────────────────────────────────────────────────────
// Default agent runner — wires PromptRequest into agent.run()
// ──────────────────────────────────────────────────────────────────────

type QueueItem =
    | { kind: "event"; event: string; payload: Record<string, unknown> }
    | { kind: "done" };

/**
 * Drive a single ACP prompt → ClawAgent run cycle.
 *
 * Replaces the agent's event sink with a forwarder that pushes onto an
 * in-process queue, while a drain coroutine consumes it and awaits the
 * (async) ACP sink. This keeps event ordering deterministic even when
 * the agent's `run` resolves before all its streamed events have made
 * it through the microtask queue.
 */
export const defaultRunner: PromptRunner = async (
    agent: AgentLike,
    prompt: PromptRequest,
    session: AgentSession
): Promise<StopReason> => {
    const savedOnEvent: unknown =
        agent && typeof agent === "object" ? agent.onEvent : undefined;

    const queue: QueueItem[] = [];
    let resolveWaiter: (() => void) | null = null;
    let pending: Promise<void> = new Promise((res) => {
        resolveWaiter = res;
    });

    function push(event: string, payload?: Record<string, unknown>): void {
        queue.push({
            kind: "event",
            event,
            payload: payload ? { ...payload } : {},
        });
        if (resolveWaiter) {
            const r = resolveWaiter;
            resolveWaiter = null;
            r();
        }
    }

    function close(): void {
        queue.push({ kind: "done" });
        if (resolveWaiter) {
            const r = resolveWaiter;
            resolveWaiter = null;
            r();
        }
    }

    if (agent && typeof agent === "object") {
        try {
            agent.onEvent = push;
        } catch {
            // defensive: some agents may have a read-only on_event property
        }
    }

    const drainPromise = (async (): Promise<void> => {
        while (true) {
            while (queue.length === 0) {
                pending = new Promise((res) => {
                    resolveWaiter = res;
                });
                await pending;
            }
            const item = queue.shift()!;
            if (item.kind === "done") return;
            await session.adispatch(item.event, item.payload);
        }
    })();

    try {
        const runFn =
            agent && typeof agent === "object"
                ? (agent.arun as
                      | ((text: string) => unknown)
                      | undefined) ??
                  (agent.run as ((text: string) => unknown) | undefined) ??
                  (agent.invoke as ((text: string) => unknown) | undefined)
                : undefined;
        if (!runFn) {
            throw new Error("agent has no run() / arun() / invoke() method");
        }

        const result = runFn.call(agent, prompt.text);
        const output: unknown =
            result && typeof (result as Promise<unknown>).then === "function"
                ? await (result as Promise<unknown>)
                : result;

        close();
        await drainPromise;

        const outputText =
            typeof output === "string"
                ? output
                : output && typeof output === "object" && "result" in output
                    ? String((output as { result?: unknown }).result ?? "")
                    : "";
        if (
            session.emitted.length === 0 &&
            outputText.length > 0
        ) {
            await session.adispatch("message_text", { text: outputText });
        }
        return session.stopReason ?? StopReasonValues.END_TURN;
    } catch (exc) {
        close();
        try {
            await drainPromise;
        } catch {
            // swallow drainer errors after a top-level failure
        }
        await session.adispatch("error", { error: String(exc) });
        return StopReasonValues.ERROR;
    } finally {
        if (agent && typeof agent === "object") {
            try {
                agent.onEvent = savedOnEvent;
            } catch {
                // ignore
            }
        }
    }
};

// ──────────────────────────────────────────────────────────────────────
// Server
// ──────────────────────────────────────────────────────────────────────

export interface AcpServerOptions {
    agent: AgentLike;
    promptRunner?: PromptRunner;
    permissionRequester?: PermissionRequester;
}

/**
 * ACP server fronting a ClawAgents agent.
 *
 * Mirrors `clawagents.acp.AcpServer`. The actual JSON-RPC stdio handling
 * uses the optional `@zed-industries/agent-client-protocol` package; the
 * import is deferred to `serve()`, so unit tests can drive
 * `runPrompt()` without it.
 */
export class AcpServer {
    readonly agent: AgentLike;
    readonly promptRunner: PromptRunner;
    readonly permissionRequester?: PermissionRequester;

    constructor(opts: AcpServerOptions) {
        this.agent = opts.agent;
        this.promptRunner = opts.promptRunner ?? defaultRunner;
        this.permissionRequester = opts.permissionRequester;
    }

    /**
     * Run the server, blocking on stdin/stdout until EOF.
     *
     * Throws `MissingAcpDependencyError` if the optional package isn't
     * installed.
     */
    async serve(): Promise<void> {
        let acp: unknown;
        try {
            acp = _localRequire("@zed-industries/agent-client-protocol");
        } catch (exc) {
            throw new MissingAcpDependencyError(exc);
        }
        await this.serveAsync(acp);
    }

    /** Drive one prompt cycle with a custom sink (test entry point). */
    async runPrompt(
        prompt: PromptRequest,
        sink: SessionEventSink
    ): Promise<StopReason> {
        const session = new AgentSession({
            sessionId: prompt.sessionId,
            sink,
            permissionRequester: this.permissionRequester,
        });
        return await this.promptRunner(this.agent, prompt, session);
    }

    private async serveAsync(acp: unknown): Promise<void> {
        // The official package surface evolves quickly; we only rely
        // on the small subset documented as stable. Any divergence
        // surfaces here as MissingAcpDependencyError so users get a
        // clear install/upgrade hint rather than a TypeError.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = acp as any;
        if (
            !a ||
            typeof a.stdioStreams !== "function" ||
            typeof a.AgentSideConnection !== "function"
        ) {
            throw new MissingAcpDependencyError(
                "agent-client-protocol package is missing expected exports"
            );
        }

        const { input, output } = await a.stdioStreams();
        const ClawAcpAgent = this.makeAgentClass(a);
        const conn = new a.AgentSideConnection(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (c: any) => new ClawAcpAgent(c, this),
            input,
            output
        );

        if (typeof conn.waitClosed === "function") {
            await conn.waitClosed();
        } else {
            await new Promise<void>(() => {
                // No clean shutdown signal — block forever; the user
                // will SIGINT to stop the server.
            });
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private makeAgentClass(acp: any): any {
        const serverSelf = this;

        class ClawAcpAgent {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            private conn: any;
            private srv: AcpServer;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            constructor(conn: any, srv: AcpServer) {
                this.conn = conn;
                this.srv = srv;
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            async initialize(params: any): Promise<unknown> {
                return {
                    agentCapabilities: { loadSession: false },
                    protocolVersion: params?.protocolVersion ?? 1,
                };
            }

            async newSession(): Promise<unknown> {
                const crypto = await import("node:crypto");
                return {
                    sessionId: `sess_${crypto.randomBytes(6).toString("hex")}`,
                };
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            async prompt(params: any): Promise<unknown> {
                const payload =
                    params && typeof params === "object" ? { ...params } : {};
                const req = promptFromDict(payload);

                const sink: SessionEventSink = async (
                    raw: Record<string, unknown>
                ) => {
                    await this.conn.sessionUpdate(req.sessionId, raw);
                };

                const stop = await serverSelf.runPrompt(req, sink);
                return { stopReason: stop };
            }

            async cancel(): Promise<unknown> {
                return null;
            }
        }

        return ClawAcpAgent;
    }
}

// ──────────────────────────────────────────────────────────────────────
// Convenience wrapper
// ──────────────────────────────────────────────────────────────────────

/** Shortcut: `serve(agent)` is sugar for `new AcpServer({agent}).serve()`. */
export function serve(
    agent: AgentLike,
    options: {
        promptRunner?: PromptRunner;
        permissionRequester?: PermissionRequester;
    } = {}
): Promise<void> {
    const srv = new AcpServer({
        agent,
        promptRunner: options.promptRunner,
        permissionRequester: options.permissionRequester,
    });
    return srv.serve();
}
