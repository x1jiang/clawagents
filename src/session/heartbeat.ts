/**
 * Session heartbeat and auto-cleanup.
 *
 * Sessions without a heartbeat auto-release resources after timeout.
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
