/**
 * Scheduler that drives a {@link JobRunner} from due jobs.
 *
 * Mirrors `clawagents_py/src/clawagents/cron/scheduler.py` — same
 * polling/tick semantics, same `advanceNextRun` crash-recovery
 * sequence, same `markJobRun` contract.
 */

import { advanceNextRun, getDueJobs, markJobRun, saveJobOutput, type Job } from "./jobs.js";
import { SchedulerError } from "./errors.js";

export type JobRunner = (job: Job) => Promise<string>;

export interface SchedulerOptions {
    /** Polling interval in seconds. Defaults to 30. */
    intervalSeconds?: number;
    /** When true (default), runner output is persisted via {@link saveJobOutput}. */
    saveOutput?: boolean;
}

export interface SchedulerStats {
    running: boolean;
    intervalSeconds: number;
    tickCount: number;
    errorCount: number;
    lastTickAt: number | null;
}

export class Scheduler {
    private readonly intervalSeconds: number;
    private readonly saveOutput: boolean;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private stopping = false;
    private tickCount = 0;
    private errorCount = 0;
    private lastTickAt: number | null = null;

    constructor(private readonly runner: JobRunner, opts: SchedulerOptions = {}) {
        const interval = opts.intervalSeconds ?? 30;
        if (interval <= 0) {
            throw new SchedulerError("intervalSeconds must be > 0");
        }
        this.intervalSeconds = interval;
        this.saveOutput = opts.saveOutput ?? true;
    }

    get isRunning(): boolean {
        return this.timer !== null;
    }

    get stats(): SchedulerStats {
        return {
            running: this.isRunning,
            intervalSeconds: this.intervalSeconds,
            tickCount: this.tickCount,
            errorCount: this.errorCount,
            lastTickAt: this.lastTickAt,
        };
    }

    start(): void {
        if (this.isRunning) return;
        this.stopping = false;
        const loop = async () => {
            if (this.stopping) return;
            try {
                await this.tick();
            } catch (e) {
                this.errorCount += 1;
                console.error("[clawagents.cron] scheduler tick failed:", e);
            }
            if (this.stopping) return;
            this.timer = setTimeout(loop, this.intervalSeconds * 1000);
            // Don't keep the event loop alive if the host process wants to exit.
            this.timer.unref?.();
        };
        // Kick the first tick onto the next macrotask so callers can
        // `start()` and immediately `stop()` without a leaked tick.
        this.timer = setTimeout(loop, 0);
        this.timer.unref?.();
    }

    async stop(): Promise<void> {
        this.stopping = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** Run every currently-due job once. Returns count of jobs fired. */
    async tick(): Promise<number> {
        const due = getDueJobs();
        for (const job of due) {
            await this.dispatch(job);
        }
        this.tickCount += 1;
        this.lastTickAt = Date.now();
        return due.length;
    }

    private async dispatch(job: Job): Promise<void> {
        const kind = job.schedule?.kind;
        if (kind === "cron" || kind === "interval") {
            advanceNextRun(job.id);
        }
        let output: string;
        try {
            output = await this.runner(job);
        } catch (e) {
            this.errorCount += 1;
            const msg = (e as Error).message;
            console.error(`[clawagents.cron] job ${job.id} failed:`, e);
            markJobRun(job.id, false, msg);
            return;
        }
        if (this.saveOutput && output) {
            try {
                saveJobOutput(job.id, output);
            } catch (e) {
                console.warn(`[clawagents.cron] failed to save output for ${job.id}:`, e);
            }
        }
        markJobRun(job.id, true);
    }
}
