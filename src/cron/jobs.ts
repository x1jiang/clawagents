/**
 * Cron job storage and schedule arithmetic.
 *
 * Jobs live at `<clawagents_home>/cron/jobs.json`; outputs at
 * `<clawagents_home>/cron/output/<job_id>/<timestamp>.md`. Storage
 * uses atomic `fs.renameSync` writes plus a per-process queue so
 * concurrent `markJobRun` / `advanceNextRun` calls do not race.
 *
 * Three schedule kinds:
 *
 * - **once** — one-shot at an ISO timestamp or relative duration
 *   (`"30m"`, `"2h"`, `"1d"`).
 * - **interval** — recurring (`"every 30m"`).
 * - **cron** — full cron expressions (`"0 9 * * *"`); requires the
 *   optional `cron-parser` peer dependency.
 *
 * Mirrors `clawagents_py/src/clawagents/cron/jobs.py`. The TS port
 * keeps the same on-disk schema and field names so a future tool
 * can read either store.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { createRequire } from "node:module";
import { getClawagentsHome } from "../paths.js";

// ── cron-parser (lazy, optional) ────────────────────────────────────

type CronIterator = { next(): { toDate(): Date } };
type CronParser = { parseExpression(expr: string, opts?: { currentDate?: Date }): CronIterator };

const _localRequire = createRequire(import.meta.url);
let _cronParser: CronParser | null | undefined;

function loadCronParser(): CronParser | null {
    if (_cronParser !== undefined) return _cronParser;
    try {
        _cronParser = _localRequire("cron-parser") as CronParser;
    } catch {
        _cronParser = null;
    }
    return _cronParser;
}

export const CRONITER_AVAILABLE = (() => {
    try {
        return loadCronParser() !== null;
    } catch {
        return false;
    }
})();

/** Test hook: pretend `cron-parser` isn't installed (or is). */
export function _setCronParserForTest(value: CronParser | null | undefined): void {
    _cronParser = value;
}

// ── Configuration ───────────────────────────────────────────────────

export const ONESHOT_GRACE_SECONDS = 120;

let _now: () => Date = () => new Date();

/** Override the cron module's notion of *now* (for tests). */
export function setClock(fn: () => Date): void {
    _now = fn;
}

/** Restore the default wall-clock clock. */
export function resetClock(): void {
    _now = () => new Date();
}

function cronDir(create = true): string {
    const home = getClawagentsHome({ create });
    const dir = path.join(home, "cron");
    if (create) {
        fs.mkdirSync(dir, { recursive: true });
        try {
            fs.chmodSync(dir, 0o700);
        } catch {
            // Best-effort on platforms without POSIX perms.
        }
    }
    return dir;
}

function jobsFile(): string {
    return path.join(cronDir(), "jobs.json");
}

function outputDir(): string {
    const dir = path.join(cronDir(), "output");
    fs.mkdirSync(dir, { recursive: true });
    try {
        fs.chmodSync(dir, 0o700);
    } catch {
        // Best-effort on platforms without POSIX perms.
    }
    return dir;
}

// ── Schedule parsing ────────────────────────────────────────────────

export type ScheduleKind = "once" | "interval" | "cron";

export interface ParsedSchedule {
    kind: ScheduleKind;
    /** ISO timestamp for `once`. */
    run_at?: string;
    /** Minutes for `interval`. */
    minutes?: number;
    /** Cron expression for `cron`. */
    expr?: string;
    display: string;
}

const DURATION_RE = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/;

export function parseDuration(s: string): number {
    const match = DURATION_RE.exec(s.trim().toLowerCase());
    if (!match) {
        throw new Error(`Invalid duration: ${JSON.stringify(s)}. Use format like '30m', '2h', or '1d'.`);
    }
    const value = parseInt(match[1], 10);
    const unit = match[2][0];
    const factor = unit === "m" ? 1 : unit === "h" ? 60 : 1440;
    return value * factor;
}

export function parseSchedule(schedule: string): ParsedSchedule {
    const original = schedule.trim();
    const lower = original.toLowerCase();

    if (lower.startsWith("every ")) {
        const minutes = parseDuration(original.slice(6).trim());
        return { kind: "interval", minutes, display: `every ${minutes}m` };
    }

    const parts = original.split(/\s+/);
    if (parts.length >= 5 && parts.slice(0, 5).every(p => /^[\d*\-,/]+$/.test(p))) {
        const parser = loadCronParser();
        if (!parser) {
            throw new Error(
                "Cron expressions require the optional `cron-parser` peer dependency. " +
                "Install with `npm install cron-parser`.",
            );
        }
        try {
            parser.parseExpression(original);
        } catch (e) {
            throw new Error(`Invalid cron expression ${JSON.stringify(original)}: ${(e as Error).message}`);
        }
        return { kind: "cron", expr: original, display: original };
    }

    if (original.includes("T") || /^\d{4}-\d{2}-\d{2}/.test(original)) {
        const dt = new Date(original);
        if (isNaN(dt.getTime())) {
            throw new Error(`Invalid timestamp ${JSON.stringify(original)}`);
        }
        return {
            kind: "once",
            run_at: dt.toISOString(),
            display: `once at ${dt.toISOString().slice(0, 16).replace("T", " ")}`,
        };
    }

    try {
        const minutes = parseDuration(original);
        const runAt = new Date(_now().getTime() + minutes * 60_000);
        return {
            kind: "once",
            run_at: runAt.toISOString(),
            display: `once in ${original}`,
        };
    } catch {
        // fall through
    }

    throw new Error(
        `Invalid schedule ${JSON.stringify(original)}. Use:\n` +
            "  - Duration: '30m', '2h', '1d' (one-shot)\n" +
            "  - Interval: 'every 30m', 'every 2h' (recurring)\n" +
            "  - Cron: '0 9 * * *' (requires `cron-parser`)\n" +
            "  - Timestamp: '2026-02-03T14:00:00' (one-shot at time)",
    );
}

function recoverableOneshotRunAt(
    schedule: ParsedSchedule,
    now: Date,
    lastRunAt: string | null,
): string | null {
    if (schedule.kind !== "once") return null;
    if (lastRunAt) return null;
    if (!schedule.run_at) return null;
    const runAtDt = new Date(schedule.run_at);
    if (runAtDt.getTime() >= now.getTime() - ONESHOT_GRACE_SECONDS * 1000) {
        return schedule.run_at;
    }
    return null;
}

function graceSeconds(schedule: ParsedSchedule): number {
    const MIN = 120;
    const MAX = 7200;
    if (schedule.kind === "interval" && schedule.minutes !== undefined) {
        const period = schedule.minutes * 60;
        return Math.max(MIN, Math.min(Math.floor(period / 2), MAX));
    }
    if (schedule.kind === "cron") {
        const parser = loadCronParser();
        if (!parser || !schedule.expr) return MIN;
        try {
            const it = parser.parseExpression(schedule.expr, { currentDate: _now() });
            const a = it.next().toDate().getTime();
            const b = it.next().toDate().getTime();
            const period = Math.floor((b - a) / 1000);
            return Math.max(MIN, Math.min(Math.floor(period / 2), MAX));
        } catch {
            return MIN;
        }
    }
    return MIN;
}

export function computeNextRun(
    schedule: ParsedSchedule,
    lastRunAt: string | null = null,
): string | null {
    const now = _now();
    if (schedule.kind === "once") {
        return recoverableOneshotRunAt(schedule, now, lastRunAt);
    }
    if (schedule.kind === "interval" && schedule.minutes !== undefined) {
        const base = lastRunAt ? new Date(lastRunAt) : now;
        return new Date(base.getTime() + schedule.minutes * 60_000).toISOString();
    }
    if (schedule.kind === "cron" && schedule.expr) {
        const parser = loadCronParser();
        if (!parser) return null;
        try {
            const it = parser.parseExpression(schedule.expr, { currentDate: now });
            return it.next().toDate().toISOString();
        } catch {
            return null;
        }
    }
    return null;
}

// ── Persistence ─────────────────────────────────────────────────────

export interface JobRepeat {
    times: number | null;
    completed: number;
}

export interface Job {
    id: string;
    name: string;
    prompt: string;
    schedule: ParsedSchedule;
    schedule_display: string;
    repeat: JobRepeat;
    enabled: boolean;
    state: string;
    created_at: string;
    next_run_at: string | null;
    last_run_at?: string | null;
    last_status?: string | null;
    last_error?: string | null;
    paused_at?: string | null;
    paused_reason?: string | null;
    workdir?: string | null;
    metadata: Record<string, unknown>;
}

/**
 * Synchronous critical section.
 *
 * Node is single-threaded, so any sync `fn()` runs to completion before
 * another caller can start one. This wrapper just documents the
 * load→modify→save invariant — it's a no-op around `fn`. The matching
 * Python module uses `threading.Lock` for the same reason: protect
 * concurrent runners in the same process from interleaving file I/O.
 */
function withLock<T>(fn: () => T): T {
    return fn();
}

export function loadJobs(): Job[] {
    const file = jobsFile();
    if (!fs.existsSync(file)) return [];
    try {
        const raw = fs.readFileSync(file, "utf8");
        const data = JSON.parse(raw) as { jobs?: Job[] };
        return data.jobs ?? [];
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") return [];
        throw e;
    }
}

export function saveJobs(jobs: Job[]): void {
    const dir = cronDir();
    const target = jobsFile();
    const tmp = path.join(dir, `.jobs_${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
        fs.writeFileSync(
            tmp,
            JSON.stringify({ jobs, updated_at: _now().toISOString() }, null, 2),
            { encoding: "utf8", mode: 0o600 },
        );
        fs.renameSync(tmp, target);
    } catch (e) {
        try {
            fs.unlinkSync(tmp);
        } catch {
            // ignore
        }
        throw e;
    }
}

// ── CRUD ────────────────────────────────────────────────────────────

function normalizeWorkdir(workdir?: string | null): string | null {
    if (workdir === null || workdir === undefined) return null;
    const raw = String(workdir).trim();
    if (!raw) return null;
    let expanded = raw;
    if (expanded.startsWith("~")) {
        expanded = path.join(os.homedir(), expanded.slice(1));
    }
    if (!path.isAbsolute(expanded)) {
        throw new Error(
            `Cron workdir must be an absolute path (got ${JSON.stringify(raw)}). ` +
                "Cron jobs run detached from any shell cwd, so relative paths are ambiguous.",
        );
    }
    const resolved = path.resolve(expanded);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`Cron workdir does not exist or is not a directory: ${resolved}`);
    }
    return resolved;
}

export interface CreateJobOptions {
    name?: string;
    repeat?: number | null;
    workdir?: string | null;
    metadata?: Record<string, unknown>;
}

export function createJob(prompt: string, schedule: string, options: CreateJobOptions = {}): Job {
    const parsed = parseSchedule(schedule);

    let repeat: number | null = options.repeat ?? null;
    if (repeat !== null && repeat <= 0) repeat = null;
    if (parsed.kind === "once" && repeat === null) repeat = 1;

    const id = crypto.randomBytes(6).toString("hex");
    const labelSource = (prompt || id).trim();
    const job: Job = {
        id,
        name: (options.name ?? labelSource.slice(0, 50)).trim(),
        prompt,
        schedule: { ...parsed },
        schedule_display: parsed.display ?? schedule,
        repeat: { times: repeat, completed: 0 },
        enabled: true,
        state: "scheduled",
        paused_at: null,
        paused_reason: null,
        created_at: _now().toISOString(),
        next_run_at: computeNextRun(parsed),
        last_run_at: null,
        last_status: null,
        last_error: null,
        workdir: normalizeWorkdir(options.workdir),
        metadata: { ...(options.metadata ?? {}) },
    };

    return withLock(() => {
        const jobs = loadJobs();
        jobs.push(job);
        saveJobs(jobs);
        return job;
    });
}

export function getJob(jobId: string): Job | null {
    return loadJobs().find(j => j.id === jobId) ?? null;
}

export function listJobs(includeDisabled = false): Job[] {
    const jobs = loadJobs();
    if (includeDisabled) return jobs;
    return jobs.filter(j => j.enabled !== false);
}

export interface UpdateJobInput {
    name?: string;
    prompt?: string;
    schedule?: string | ParsedSchedule;
    schedule_display?: string;
    enabled?: boolean;
    state?: string;
    next_run_at?: string | null;
    last_run_at?: string | null;
    last_status?: string | null;
    last_error?: string | null;
    paused_at?: string | null;
    paused_reason?: string | null;
    workdir?: string | null;
    repeat?: JobRepeat;
    metadata?: Record<string, unknown>;
}

export function updateJob(jobId: string, updates: UpdateJobInput): Job | null {
    return withLock(() => {
        const jobs = loadJobs();
        const idx = jobs.findIndex(j => j.id === jobId);
        if (idx === -1) return null;
        const current = jobs[idx];

        const patch: Partial<Job> = { ...updates } as Partial<Job>;

        if (updates.workdir !== undefined) {
            patch.workdir = normalizeWorkdir(updates.workdir);
        }

        if (updates.schedule !== undefined) {
            const sched: ParsedSchedule =
                typeof updates.schedule === "string" ? parseSchedule(updates.schedule) : updates.schedule;
            patch.schedule = sched;
            patch.schedule_display = updates.schedule_display ?? sched.display ?? current.schedule_display;
            const nextState = (patch.state ?? current.state);
            if (nextState !== "paused") {
                patch.next_run_at = computeNextRun(sched);
            }
        }

        const merged: Job = { ...current, ...patch } as Job;

        if (
            merged.enabled !== false &&
            merged.state !== "paused" &&
            !merged.next_run_at
        ) {
            merged.next_run_at = computeNextRun(merged.schedule);
        }

        jobs[idx] = merged;
        saveJobs(jobs);
        return merged;
    });
}

export function pauseJob(jobId: string, reason: string | null = null): Job | null {
    return updateJob(jobId, {
        enabled: false,
        state: "paused",
        paused_at: _now().toISOString(),
        paused_reason: reason,
    });
}

export function resumeJob(jobId: string): Job | null {
    const job = getJob(jobId);
    if (!job) return null;
    return updateJob(jobId, {
        enabled: true,
        state: "scheduled",
        paused_at: null,
        paused_reason: null,
        next_run_at: computeNextRun(job.schedule),
    });
}

export function triggerJob(jobId: string): Job | null {
    const job = getJob(jobId);
    if (!job) return null;
    return updateJob(jobId, {
        enabled: true,
        state: "scheduled",
        paused_at: null,
        paused_reason: null,
        next_run_at: _now().toISOString(),
    });
}

export function removeJob(jobId: string): boolean {
    return withLock(() => {
        const jobs = loadJobs();
        const before = jobs.length;
        const filtered = jobs.filter(j => j.id !== jobId);
        if (filtered.length < before) {
            saveJobs(filtered);
            return true;
        }
        return false;
    });
}

export function markJobRun(
    jobId: string,
    success: boolean,
    error: string | null = null,
): void {
    withLock(() => {
        const jobs = loadJobs();
        const idx = jobs.findIndex(j => j.id === jobId);
        if (idx === -1) return;
        const job = jobs[idx];
        const now = _now().toISOString();
        job.last_run_at = now;
        job.last_status = success ? "ok" : "error";
        job.last_error = success ? null : error;

        const repeat: JobRepeat = job.repeat ?? { times: null, completed: 0 };
        repeat.completed = (repeat.completed ?? 0) + 1;
        if (repeat.times !== null && repeat.times > 0 && repeat.completed >= repeat.times) {
            jobs.splice(idx, 1);
            saveJobs(jobs);
            return;
        }
        job.repeat = repeat;
        job.next_run_at = computeNextRun(job.schedule, now);
        if (job.next_run_at === null) {
            job.enabled = false;
            job.state = "completed";
        } else if (job.state !== "paused") {
            job.state = "scheduled";
        }
        saveJobs(jobs);
    });
}

export function advanceNextRun(jobId: string): boolean {
    return withLock(() => {
        const jobs = loadJobs();
        const job = jobs.find(j => j.id === jobId);
        if (!job) return false;
        const kind = job.schedule?.kind;
        if (kind !== "cron" && kind !== "interval") return false;
        const newNext = computeNextRun(job.schedule, _now().toISOString());
        if (newNext && newNext !== job.next_run_at) {
            job.next_run_at = newNext;
            saveJobs(jobs);
            return true;
        }
        return false;
    });
}

export function getDueJobs(): Job[] {
    const now = _now();
    const raw = loadJobs();
    const jobs = JSON.parse(JSON.stringify(raw)) as Job[];
    const due: Job[] = [];
    let needsSave = false;

    for (const job of jobs) {
        if (job.enabled === false) continue;
        let nextRun = job.next_run_at;
        if (!nextRun) {
            const recovered = recoverableOneshotRunAt(
                job.schedule ?? ({} as ParsedSchedule),
                now,
                job.last_run_at ?? null,
            );
            if (!recovered) continue;
            job.next_run_at = recovered;
            nextRun = recovered;
            const target = raw.find(r => r.id === job.id);
            if (target) {
                target.next_run_at = recovered;
                needsSave = true;
            }
        }

        const nextRunDt = new Date(nextRun);
        if (nextRunDt.getTime() > now.getTime()) continue;

        const sched = job.schedule ?? ({} as ParsedSchedule);
        const grace = graceSeconds(sched);
        if (
            (sched.kind === "cron" || sched.kind === "interval") &&
            (now.getTime() - nextRunDt.getTime()) / 1000 > grace
        ) {
            const newNext = computeNextRun(sched, now.toISOString());
            if (newNext) {
                const target = raw.find(r => r.id === job.id);
                if (target) {
                    target.next_run_at = newNext;
                    needsSave = true;
                }
                continue;
            }
        }

        due.push(job);
    }

    if (needsSave) {
        withLock(() => saveJobs(raw));
    }
    return due;
}

export function saveJobOutput(jobId: string, output: string): string {
    const base = path.join(outputDir(), jobId);
    fs.mkdirSync(base, { recursive: true });
    try {
        fs.chmodSync(base, 0o700);
    } catch {
        // ignore
    }
    const ts = _now().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const target = path.join(base, `${ts}.md`);
    const tmp = path.join(base, `.output_${crypto.randomBytes(6).toString("hex")}.tmp`);
    try {
        fs.writeFileSync(tmp, output, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, target);
    } catch (e) {
        try {
            fs.unlinkSync(tmp);
        } catch {
            // ignore
        }
        throw e;
    }
    return target;
}
