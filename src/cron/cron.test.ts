/**
 * Hermetic tests for `clawagents/cron`.
 *
 * Mirrors `clawagents_py/tests/test_cron.py`:
 * - Frozen clock via `setClock`.
 * - `CLAWAGENTS_HOME` redirected to a tmpdir per test.
 * - No real-time sleeps; the scheduler is exercised through `tick()`.
 * - `cron-parser` is optional — cron-expression tests skip if absent.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
    CRONITER_AVAILABLE,
    Scheduler,
    SchedulerError,
    advanceNextRun,
    computeNextRun,
    createJob,
    getDueJobs,
    getJob,
    listJobs,
    loadJobs,
    markJobRun,
    parseDuration,
    parseSchedule,
    pauseJob,
    removeJob,
    resetClock,
    resumeJob,
    saveJobOutput,
    saveJobs,
    setClock,
    triggerJob,
    updateJob,
    _setCronParserForTest,
} from "./index.js";

const FROZEN = new Date("2026-04-25T12:00:00Z");

let tmpHome: string;
let savedEnv: Record<string, string | undefined>;
const clockState = { now: FROZEN };

function advance({
    seconds = 0,
    minutes = 0,
    hours = 0,
}: { seconds?: number; minutes?: number; hours?: number }): void {
    clockState.now = new Date(
        clockState.now.getTime() +
            seconds * 1000 +
            minutes * 60_000 +
            hours * 3_600_000,
    );
}

beforeEach(() => {
    savedEnv = {
        CLAWAGENTS_HOME: process.env.CLAWAGENTS_HOME,
        CLAWAGENTS_PROFILE: process.env.CLAWAGENTS_PROFILE,
    };
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawagents-cron-"));
    process.env.CLAWAGENTS_HOME = tmpHome;
    process.env.CLAWAGENTS_PROFILE = "test";
    clockState.now = FROZEN;
    setClock(() => clockState.now);
});

afterEach(() => {
    resetClock();
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
        // ignore
    }
});

// ── parseSchedule / parseDuration ────────────────────────────────────

describe("parseDuration", () => {
    it("parses minutes/hours/days", () => {
        assert.equal(parseDuration("30m"), 30);
        assert.equal(parseDuration("2h"), 120);
        assert.equal(parseDuration("1d"), 1440);
    });

    it("rejects garbage", () => {
        assert.throws(() => parseDuration("forever"));
    });
});

describe("parseSchedule", () => {
    it("treats bare durations as one-shot", () => {
        const parsed = parseSchedule("30m");
        assert.equal(parsed.kind, "once");
        assert.equal(parsed.run_at, new Date(FROZEN.getTime() + 30 * 60_000).toISOString());
    });

    it("treats `every <duration>` as interval", () => {
        const parsed = parseSchedule("every 15m");
        assert.equal(parsed.kind, "interval");
        assert.equal(parsed.minutes, 15);
    });

    it("accepts ISO timestamps", () => {
        const parsed = parseSchedule("2026-12-31T09:00:00Z");
        assert.equal(parsed.kind, "once");
        assert.ok(parsed.run_at?.startsWith("2026-12-31T09:00:00"));
    });

    it("rejects gibberish", () => {
        assert.throws(() => parseSchedule("nonsense"));
    });

    it("requires cron-parser for cron expressions", () => {
        _setCronParserForTest(null);
        try {
            assert.throws(() => parseSchedule("0 9 * * *"), /cron-parser/);
        } finally {
            _setCronParserForTest(undefined);
        }
    });
});

if (CRONITER_AVAILABLE) {
    describe("parseSchedule (cron-parser available)", () => {
        it("parses standard cron expressions", () => {
            const parsed = parseSchedule("0 9 * * *");
            assert.equal(parsed.kind, "cron");
            assert.equal(parsed.expr, "0 9 * * *");
            const next = computeNextRun(parsed);
            assert.ok(next);
            assert.ok(new Date(next!).getTime() > FROZEN.getTime());
        });
    });
}

// ── computeNextRun ───────────────────────────────────────────────────

describe("computeNextRun", () => {
    it("returns run_at for fresh one-shot", () => {
        const sched = parseSchedule("30m");
        assert.equal(computeNextRun(sched), sched.run_at);
    });

    it("returns null for completed one-shot", () => {
        const sched = parseSchedule("30m");
        const last = new Date(FROZEN.getTime() + 30 * 60_000).toISOString();
        assert.equal(computeNextRun(sched, last), null);
    });

    it("advances interval from last_run_at", () => {
        const sched = parseSchedule("every 15m");
        const next = computeNextRun(sched, FROZEN.toISOString());
        assert.equal(next, new Date(FROZEN.getTime() + 15 * 60_000).toISOString());
    });

    it("returns first interval run in the future when no last run", () => {
        const sched = parseSchedule("every 15m");
        assert.equal(
            computeNextRun(sched),
            new Date(FROZEN.getTime() + 15 * 60_000).toISOString(),
        );
    });
});

// ── CRUD ─────────────────────────────────────────────────────────────

describe("CRUD", () => {
    it("creates and reads a job", () => {
        const job = createJob("hello", "30m", { name: "greeting" });
        assert.ok(job.id);
        assert.equal(job.name, "greeting");
        assert.equal(job.enabled, true);
        assert.equal(job.state, "scheduled");
        assert.equal(job.next_run_at, job.schedule.run_at);
        assert.equal(job.repeat.times, 1);

        const fetched = getJob(job.id);
        assert.ok(fetched);
        assert.equal(fetched!.name, "greeting");
    });

    it("filters disabled jobs by default", () => {
        const a = createJob("active", "30m");
        const b = createJob("paused", "30m");
        pauseJob(b.id, "quiet hours");

        const visible = listJobs().map(j => j.id);
        assert.ok(visible.includes(a.id));
        assert.ok(!visible.includes(b.id));

        const all = listJobs(true).map(j => j.id);
        assert.deepEqual(new Set(all), new Set([a.id, b.id]));
    });

    it("pause/resume round-trips", () => {
        const job = createJob("ping", "every 1h");
        pauseJob(job.id, "testing");
        const paused = getJob(job.id)!;
        assert.equal(paused.enabled, false);
        assert.equal(paused.state, "paused");
        assert.equal(paused.paused_reason, "testing");

        resumeJob(job.id);
        const resumed = getJob(job.id)!;
        assert.equal(resumed.enabled, true);
        assert.equal(resumed.state, "scheduled");
        assert.equal(resumed.paused_at, null);
    });

    it("trigger sets next_run_at to now", () => {
        const job = createJob("ping", "every 1h");
        triggerJob(job.id);
        const triggered = getJob(job.id)!;
        assert.equal(triggered.next_run_at, FROZEN.toISOString());
    });

    it("removes jobs by id", () => {
        const job = createJob("delete-me", "30m");
        assert.equal(removeJob(job.id), true);
        assert.equal(getJob(job.id), null);
        assert.equal(removeJob(job.id), false);
    });

    it("update changes schedule", () => {
        const job = createJob("hello", "every 1h");
        const updated = updateJob(job.id, { schedule: "every 30m" });
        assert.equal(updated!.schedule.minutes, 30);
        assert.equal(updated!.schedule_display, "every 30m");
    });

    it("update of unknown id returns null", () => {
        assert.equal(updateJob("nope", { name: "x" }), null);
    });
});

// ── Persistence ──────────────────────────────────────────────────────

describe("persistence", () => {
    it("save/load is a round trip", () => {
        createJob("a", "30m");
        createJob("b", "every 2h");
        const raw = loadJobs();
        assert.equal(raw.length, 2);
        saveJobs(raw);
        const again = loadJobs();
        assert.deepEqual(again, raw);
    });
});

// ── Due jobs / mark / advance ────────────────────────────────────────

describe("getDueJobs / markJobRun / advanceNextRun", () => {
    it("returns only overdue jobs", () => {
        const overdue = createJob("overdue", "30m");
        createJob("future", "2h");
        advance({ hours: 1 });
        const due = getDueJobs().map(j => j.id);
        assert.deepEqual(due, [overdue.id]);
    });

    it("markJobRun advances interval jobs", () => {
        const job = createJob("ping", "every 30m");
        advance({ minutes: 31 });
        assert.ok(getDueJobs().some(j => j.id === job.id));
        markJobRun(job.id, true);
        const after = getJob(job.id)!;
        assert.equal(after.last_status, "ok");
        assert.equal(
            after.next_run_at,
            new Date(clockState.now.getTime() + 30 * 60_000).toISOString(),
        );
    });

    it("markJobRun deletes one-shot after completion", () => {
        const job = createJob("oneshot", "30m");
        advance({ hours: 1 });
        markJobRun(job.id, true);
        assert.equal(getJob(job.id), null);
    });

    it("markJobRun records error", () => {
        const job = createJob("failing", "every 30m");
        advance({ minutes: 31 });
        markJobRun(job.id, false, "boom");
        const after = getJob(job.id)!;
        assert.equal(after.last_status, "error");
        assert.equal(after.last_error, "boom");
    });

    it("advanceNextRun only advances recurring jobs", () => {
        const interval = createJob("interval", "every 30m");
        const oneshot = createJob("oneshot", "30m");
        advance({ minutes: 31 });
        assert.equal(advanceNextRun(interval.id), true);
        assert.equal(advanceNextRun(oneshot.id), false);
    });

    it("getDueJobs fast-forwards stale recurring jobs", () => {
        const job = createJob("stale", "every 30m");
        advance({ hours: 4 });
        const due = getDueJobs().map(j => j.id);
        assert.ok(!due.includes(job.id));
        const after = getJob(job.id)!;
        assert.ok(after.next_run_at);
        assert.ok(new Date(after.next_run_at!).getTime() > clockState.now.getTime());
    });
});

// ── Output persistence ───────────────────────────────────────────────

describe("saveJobOutput", () => {
    it("writes an atomic markdown file", () => {
        const job = createJob("ping", "30m");
        const target = saveJobOutput(job.id, "hello world");
        assert.ok(fs.existsSync(target));
        assert.equal(fs.readFileSync(target, "utf8"), "hello world");
        assert.ok(target.endsWith(".md"));
    });
});

// ── Scheduler ────────────────────────────────────────────────────────

describe("Scheduler", () => {
    it("rejects invalid intervals", () => {
        assert.throws(
            () => new Scheduler(async () => "", { intervalSeconds: 0 }),
            SchedulerError,
        );
    });

    it("tick fires due jobs and persists output", async () => {
        const a = createJob("a", "30m");
        const b = createJob("b", "every 30m");
        advance({ minutes: 31 });

        const ran: string[] = [];
        const scheduler = new Scheduler(
            async (job) => {
                ran.push(job.id);
                return `output for ${job.id}`;
            },
            { intervalSeconds: 1 },
        );
        const fired = await scheduler.tick();
        assert.equal(fired, 2);
        assert.deepEqual(new Set(ran), new Set([a.id, b.id]));

        assert.equal(getJob(a.id), null); // one-shot deleted
        const after = getJob(b.id)!;
        assert.equal(after.last_status, "ok");
    });

    it("records runner failure as error", async () => {
        const job = createJob("fail", "every 30m");
        advance({ minutes: 31 });
        const scheduler = new Scheduler(
            async () => {
                throw new Error("boom");
            },
            { intervalSeconds: 1 },
        );
        const fired = await scheduler.tick();
        assert.equal(fired, 1);
        const after = getJob(job.id)!;
        assert.equal(after.last_status, "error");
        assert.match(after.last_error ?? "", /boom/);
        assert.equal(scheduler.stats.errorCount, 1);
    });
});
