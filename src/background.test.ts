/**
 * Tests for src/background.ts.
 *
 * Mirrors `clawagents_py/tests/test_background.py`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BackgroundJobManager, type BackgroundJob } from "./background.js";

const NODE = process.execPath;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("BackgroundJobManager.start", () => {
    it("captures stdout and exit code for a short command", async () => {
        const mgr = new BackgroundJobManager();
        const job = await mgr.start([NODE, "-e", "process.stdout.write('hi'); process.exit(0)"]);
        const final = await mgr.awaitComplete(job.id, { timeoutMs: 10_000 });
        assert.equal(final.exitCode, 0);
        assert.match(final.stdout, /hi/);
        assert.equal(final.running, false);
        assert.ok((final.endedAt ?? 0) >= final.startedAt);
    });

    it("rejects empty command", async () => {
        const mgr = new BackgroundJobManager();
        await assert.rejects(() => mgr.start([]), /empty command/);
    });

    it("rejects duplicate job ids", async () => {
        const mgr = new BackgroundJobManager();
        await mgr.start([NODE, "-e", "process.exit(0)"], { jobId: "abc" });
        await assert.rejects(
            () => mgr.start([NODE, "-e", "process.exit(0)"], { jobId: "abc" }),
            /duplicate jobId/,
        );
    });

    it("records nonzero exit codes for failing commands", async () => {
        const mgr = new BackgroundJobManager();
        const job = await mgr.start([NODE, "-e", "process.exit(7)"]);
        const final = await mgr.awaitComplete(job.id, { timeoutMs: 10_000 });
        assert.equal(final.exitCode, 7);
    });
});

describe("BackgroundJobManager notify_on_complete", () => {
    it("fires the sync callback exactly once", async () => {
        const mgr = new BackgroundJobManager();
        const fired: BackgroundJob[] = [];
        const job = await mgr.start([NODE, "-e", "setTimeout(()=>{}, 50)"], {
            notifyOnComplete: (j) => {
                fired.push(j);
            },
        });
        await mgr.awaitComplete(job.id, { timeoutMs: 10_000 });
        await delay(0);
        assert.equal(fired.length, 1);
        assert.equal(fired[0]!.id, job.id);
        assert.equal(fired[0]!.exitCode, 0);
    });

    it("awaits an async callback", async () => {
        const mgr = new BackgroundJobManager();
        const fired: number[] = [];
        const job = await mgr.start([NODE, "-e", ""], {
            notifyOnComplete: async (j) => {
                await delay(5);
                fired.push(j.exitCode === null ? -1 : j.exitCode);
            },
        });
        await mgr.awaitComplete(job.id, { timeoutMs: 10_000 });
        // awaitComplete only resolves after the (awaited) callback has run.
        assert.deepEqual(fired, [0]);
    });

    it("swallows callback exceptions", async () => {
        const mgr = new BackgroundJobManager();
        const job = await mgr.start([NODE, "-e", ""], {
            notifyOnComplete: () => {
                throw new Error("boom");
            },
        });
        const final = await mgr.awaitComplete(job.id, { timeoutMs: 10_000 });
        assert.equal(final.exitCode, 0);
    });
});

describe("BackgroundJobManager.cancel", () => {
    it("terminates a long-running process", async () => {
        const mgr = new BackgroundJobManager({ killGraceMs: 500 });
        const job = await mgr.start([NODE, "-e", "setTimeout(()=>{}, 30000)"]);
        await mgr.cancel(job.id);
        const final = await mgr.awaitComplete(job.id, { timeoutMs: 5_000 });
        assert.equal(final.cancelled, true);
        assert.notEqual(final.exitCode, null);
    });

    it("is a no-op for already-finished jobs", async () => {
        const mgr = new BackgroundJobManager();
        const job = await mgr.start([NODE, "-e", ""]);
        await mgr.awaitComplete(job.id, { timeoutMs: 10_000 });
        const again = await mgr.cancel(job.id);
        assert.equal(again.exitCode, 0);
    });

    it("rejects unknown ids", async () => {
        const mgr = new BackgroundJobManager();
        await assert.rejects(() => mgr.cancel("nope"), /unknown background jobId/);
    });
});

describe("BackgroundJobManager registry surface", () => {
    it("status and list track jobs", async () => {
        const mgr = new BackgroundJobManager();
        const job = await mgr.start([NODE, "-e", ""]);
        await mgr.awaitComplete(job.id, { timeoutMs: 10_000 });
        assert.equal(mgr.status(job.id).id, job.id);
        assert.ok(mgr.list().some((j) => j.id === job.id));
        assert.equal(mgr.size, 1);
    });

    it("status throws for unknown ids", () => {
        const mgr = new BackgroundJobManager();
        assert.throws(() => mgr.status("nope"), /unknown background jobId/);
    });

    it("shutdown cancels outstanding jobs", async () => {
        const mgr = new BackgroundJobManager({ killGraceMs: 500 });
        await mgr.start([NODE, "-e", "setTimeout(()=>{}, 30000)"]);
        await mgr.shutdown();
        for (const j of mgr.list()) {
            assert.equal(j.running, false);
        }
    });

    it("awaitComplete honours timeoutMs", async () => {
        const mgr = new BackgroundJobManager({ killGraceMs: 500 });
        const job = await mgr.start([NODE, "-e", "setTimeout(()=>{}, 30000)"]);
        await assert.rejects(() => mgr.awaitComplete(job.id, { timeoutMs: 50 }), /timeout/);
        await mgr.cancel(job.id);
    });
});
