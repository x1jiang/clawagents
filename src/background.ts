/**
 * Background jobs with optional notify-on-complete callbacks.
 *
 * Long-running shell commands (test suites, builds, deploys, model training,
 * data pipelines) shouldn't block the agent loop. This module provides a
 * small, framework-agnostic primitive for running subprocesses in the
 * background and getting notified exactly once when they exit.
 *
 * Mirrors `clawagents_py/src/clawagents/background.py`.
 */

import { spawn, type ChildProcessWithoutNullStreams, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export type JobNotifier = (job: BackgroundJob) => void | Promise<void>;

/**
 * Snapshot-style record describing a background job. Mutated in place by
 * the watcher inside {@link BackgroundJobManager}.
 */
export interface BackgroundJob {
    /** Stable, unique identifier. */
    id: string;
    /** The argv that was launched. */
    command: string[];
    /** Working directory passed to `spawn`. */
    cwd?: string;
    /** OS pid (`undefined` until the process has been spawned). */
    pid?: number;
    /** Wall-clock seconds when the job was started. */
    startedAt: number;
    /** Wall-clock seconds when the job exited, else `undefined`. */
    endedAt?: number;
    /** Process exit code (`null` while running). */
    exitCode: number | null;
    /** Captured stdout text. */
    stdout: string;
    /** Captured stderr text. */
    stderr: string;
    /** True if cancellation was requested. */
    cancelled: boolean;
    /** True while the process is alive. */
    running: boolean;
}

interface JobInternals {
    record: BackgroundJob;
    process?: ChildProcess;
    donePromise: Promise<BackgroundJob>;
    resolveDone?: (j: BackgroundJob) => void;
}

export interface StartOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    notifyOnComplete?: JobNotifier;
    captureOutput?: boolean;
    jobId?: string;
}

/**
 * Process-wide registry for {@link BackgroundJob} instances. Construct one
 * per agent run. {@link start} spawns a subprocess and returns the live
 * job immediately; the watcher updates the job record in place, fires the
 * optional `notifyOnComplete` callback once the process exits, and
 * resolves the awaiter created by {@link awaitComplete}.
 */
export class BackgroundJobManager {
    private readonly jobs = new Map<string, JobInternals>();
    private readonly killGraceMs: number;

    constructor(opts: { killGraceMs?: number } = {}) {
        this.killGraceMs = opts.killGraceMs ?? 2000;
    }

    /** Launch a subprocess and return the live job record. */
    async start(command: string[], opts: StartOptions = {}): Promise<BackgroundJob> {
        if (!Array.isArray(command) || command.length === 0) {
            throw new Error("BackgroundJobManager.start: empty command");
        }
        const id = opts.jobId ?? randomUUID();
        if (this.jobs.has(id)) {
            throw new Error(`BackgroundJobManager.start: duplicate jobId ${JSON.stringify(id)}`);
        }
        const captureOutput = opts.captureOutput !== false;

        const record: BackgroundJob = {
            id,
            command: [...command],
            cwd: opts.cwd,
            pid: undefined,
            startedAt: Date.now() / 1000,
            endedAt: undefined,
            exitCode: null,
            stdout: "",
            stderr: "",
            cancelled: false,
            running: true,
        };

        const [program, ...args] = command;
        const child = spawn(program!, args, {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
        }) as ChildProcessWithoutNullStreams | ChildProcess;
        record.pid = child.pid;

        let resolveDone!: (j: BackgroundJob) => void;
        const donePromise = new Promise<BackgroundJob>((resolve) => {
            resolveDone = resolve;
        });
        const internals: JobInternals = {
            record,
            process: child,
            donePromise,
            resolveDone,
        };
        this.jobs.set(id, internals);

        // Capture output if asked.
        if (captureOutput && "stdout" in child && child.stdout && child.stderr) {
            child.stdout.setEncoding("utf-8");
            child.stderr.setEncoding("utf-8");
            child.stdout.on("data", (chunk: string) => {
                record.stdout += chunk;
            });
            child.stderr.on("data", (chunk: string) => {
                record.stderr += chunk;
            });
        }

        const finalize = async (code: number | null, signalReason: NodeJS.Signals | null): Promise<void> => {
            if (!record.running) return; // already finalized
            if (code === null && signalReason !== null) {
                // Process killed by signal — surface a non-zero-ish exit.
                record.exitCode = 128 + (typeof signalReason === "string" ? 15 : 1);
            } else {
                record.exitCode = code;
            }
            record.endedAt = Date.now() / 1000;
            record.running = false;
            try {
                if (opts.notifyOnComplete) {
                    const r = opts.notifyOnComplete(record);
                    if (r && typeof (r as Promise<unknown>).then === "function") {
                        await r;
                    }
                }
            } catch {
                // never let a callback take down the watcher
            } finally {
                resolveDone(record);
            }
        };

        child.on("exit", (code, signalReason) => {
            void finalize(code, signalReason);
        });
        child.on("error", () => {
            // Spawn failed (ENOENT, etc.). Mark as exited.
            void finalize(127, null);
        });

        return record;
    }

    /** Return the {@link BackgroundJob} record for an id. */
    status(jobId: string): BackgroundJob {
        const j = this.jobs.get(jobId);
        if (!j) throw new Error(`unknown background jobId ${JSON.stringify(jobId)}`);
        return j.record;
    }

    /** Return all known jobs (running + completed). */
    list(): BackgroundJob[] {
        return Array.from(this.jobs.values(), (j) => j.record);
    }

    /** Wait until the job exits (or `timeoutMs` elapses). */
    async awaitComplete(jobId: string, opts: { timeoutMs?: number } = {}): Promise<BackgroundJob> {
        const j = this.jobs.get(jobId);
        if (!j) throw new Error(`unknown background jobId ${JSON.stringify(jobId)}`);
        if (!j.record.running) return j.record;
        if (opts.timeoutMs === undefined) return j.donePromise;
        return await Promise.race([
            j.donePromise,
            new Promise<BackgroundJob>((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                `BackgroundJobManager.awaitComplete: timeout after ${opts.timeoutMs}ms for ${jobId}`,
                            ),
                        ),
                    opts.timeoutMs,
                ),
            ),
        ]);
    }

    /** Request cancellation. SIGTERM, then SIGKILL after the grace period. */
    async cancel(jobId: string): Promise<BackgroundJob> {
        const j = this.jobs.get(jobId);
        if (!j) throw new Error(`unknown background jobId ${JSON.stringify(jobId)}`);
        const proc = j.process;
        if (!proc || !j.record.running) return j.record;
        j.record.cancelled = true;
        try {
            proc.kill("SIGTERM");
        } catch {
            return j.record;
        }
        const killed = await Promise.race([
            j.donePromise.then(() => true as const),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), this.killGraceMs)),
        ]);
        if (!killed) {
            try {
                proc.kill("SIGKILL");
            } catch {
                /* already gone */
            }
            await j.donePromise;
        }
        return j.record;
    }

    /** Cancel every still-running job and wait for the watchers. */
    async shutdown(): Promise<void> {
        const ids = Array.from(this.jobs.keys());
        for (const id of ids) {
            const j = this.jobs.get(id);
            if (j && j.record.running) await this.cancel(id);
        }
    }

    /** Number of jobs in the registry. */
    get size(): number {
        return this.jobs.size;
    }
}
