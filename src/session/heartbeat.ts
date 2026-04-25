/**
 * Session heartbeat and auto-cleanup, plus per-tool activity heartbeat.
 *
 * Sessions without a heartbeat auto-release resources after timeout.
 *
 * The {@link runWithHeartbeat} helper additionally emits periodic activity
 * events during long-running awaitables (such as a slow tool execution) so
 * upstream gateways do not flag the connection as idle. Mirrors Hermes'
 * "activity heartbeats prevent false gateway inactivity timeouts" pattern.
 */

export type CleanupFn = (sessionId: string) => void;

/**
 * Tracks per-session heartbeat timestamps and evicts stale sessions.
 *
 * Usage:
 *   const hb = new SessionHeartbeat(300_000, (id) => cleanupSession(id));
 *   await hb.start();
 *   hb.heartbeat(sessionId);   // call periodically from active session
 *   hb.remove(sessionId);      // call on clean session end
 *   await hb.stop();
 */
export class SessionHeartbeat {
    private sessions = new Map<string, number>(); // sessionId → last heartbeat (ms)
    private _task: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly timeoutMs: number = 300_000,
        private readonly cleanupFn?: CleanupFn,
    ) {}

    /** Record a heartbeat for `sessionId`, resetting its expiry timer. */
    heartbeat(sessionId: string): void {
        this.sessions.set(sessionId, Date.now());
    }

    /** Explicitly remove a session (e.g., on clean shutdown). */
    remove(sessionId: string): void {
        this.sessions.delete(sessionId);
    }

    /** Start the background monitor. Safe to call multiple times. */
    async start(): Promise<void> {
        if (this._task !== null) return;
        const intervalMs = Math.max(1_000, this.timeoutMs / 2);
        this._task = setInterval(() => this._monitor(), intervalMs);
        // Allow the interval to be garbage-collected without keeping the process alive
        if (typeof this._task === "object" && "unref" in this._task) {
            (this._task as NodeJS.Timeout).unref();
        }
    }

    /** Stop the background monitor. */
    async stop(): Promise<void> {
        if (this._task !== null) {
            clearInterval(this._task);
            this._task = null;
        }
    }

    /** Check for stale sessions and invoke the cleanup function for each. */
    _monitor(): void {
        const now = Date.now();
        const stale: string[] = [];
        for (const [sid, ts] of this.sessions) {
            if (now - ts > this.timeoutMs) {
                stale.push(sid);
            }
        }
        for (const sid of stale) {
            this.sessions.delete(sid);
            if (this.cleanupFn) {
                try { this.cleanupFn(sid); } catch { /* ignore cleanup errors */ }
            }
        }
    }
}

/**
 * Default cadence for per-tool activity heartbeats. ~20s comfortably stays
 * under the conservative 30s "idle" thresholds typical of HTTP/WS proxies
 * (nginx default proxy_read_timeout, common chat-platform gateways) while
 * still keeping noise low for fast tools.
 */
export const DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS = 20_000;

export type HeartbeatEventEmitter = (
    kind: string,
    payload: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface RunWithHeartbeatOptions {
    /** Sink that receives ``(kind, payload)``. May be sync or async. */
    onEvent?: HeartbeatEventEmitter | null;
    /** Event kind; defaults to ``"heartbeat"``. */
    kind?: string;
    /** Static fields included in every beat. ``elapsed_s`` is overwritten. */
    payload?: Record<string, unknown>;
    /** Milliseconds between successive beats. */
    intervalMs?: number;
    /** Milliseconds before the first beat (defaults to ``intervalMs``). */
    firstAfterMs?: number;
}

/**
 * Await ``work`` while emitting periodic activity events.
 *
 * The work promise is awaited normally; in parallel, a heartbeat timer fires
 * after ``firstAfterMs`` (defaults to ``intervalMs``) and then every
 * ``intervalMs`` until the work resolves or rejects. The timer is cleared in
 * either case.
 *
 * Behaviour mirrors the Python ``run_with_heartbeat`` helper:
 *   * If ``onEvent`` is missing or ``intervalMs <= 0`` this degenerates to
 *     ``await work`` with zero extra scheduling — free for callers that
 *     haven't wired up a gateway listener.
 *   * Each beat includes ``elapsed_s`` (seconds, rounded to ms) so listeners
 *     can render progress without their own bookkeeping.
 *   * Exceptions thrown by ``onEvent`` are swallowed (best effort) so they
 *     never mask the real result of ``work``.
 */
export async function runWithHeartbeat<T>(
    work: Promise<T> | (() => Promise<T>),
    {
        onEvent = null,
        kind = "heartbeat",
        payload = {},
        intervalMs = DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS,
        firstAfterMs,
    }: RunWithHeartbeatOptions = {},
): Promise<T> {
    const promise = typeof work === "function" ? work() : work;

    if (!onEvent || intervalMs <= 0) {
        return promise;
    }

    const start = Date.now();
    const delayFirst = firstAfterMs ?? intervalMs;

    const emitOne = async (): Promise<void> => {
        const beat: Record<string, unknown> = { ...payload };
        beat.elapsed_s = Math.round(Date.now() - start) / 1000;
        try {
            const res = onEvent(kind, beat);
            if (res && typeof (res as Promise<unknown>).then === "function") {
                await (res as Promise<unknown>);
            }
        } catch {
            // best effort
        }
    };

    let firstTimer: ReturnType<typeof setTimeout> | null = null;
    let intervalTimer: ReturnType<typeof setInterval> | null = null;
    const clearTimers = () => {
        if (firstTimer !== null) {
            clearTimeout(firstTimer);
            firstTimer = null;
        }
        if (intervalTimer !== null) {
            clearInterval(intervalTimer);
            intervalTimer = null;
        }
    };

    firstTimer = setTimeout(() => {
        firstTimer = null;
        // fire-and-forget: emitOne errors are already swallowed
        void emitOne();
        intervalTimer = setInterval(() => {
            void emitOne();
        }, Math.max(1, intervalMs));
        if (typeof intervalTimer === "object" && intervalTimer && "unref" in intervalTimer) {
            (intervalTimer as NodeJS.Timeout).unref();
        }
    }, Math.max(0, delayFirst));
    if (typeof firstTimer === "object" && firstTimer && "unref" in firstTimer) {
        (firstTimer as NodeJS.Timeout).unref();
    }

    try {
        return await promise;
    } finally {
        clearTimers();
    }
}
