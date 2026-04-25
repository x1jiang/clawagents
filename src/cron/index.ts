/**
 * `clawagents/cron` — scheduled jobs for agent runs.
 *
 * A small persistent job store on top of `<clawagents_home>/cron`.
 * Three schedule kinds are supported:
 *
 * - **once** — one-shot at an ISO timestamp or relative duration
 *   (`"30m"`, `"2h"`, `"1d"`).
 * - **interval** — recurring (`"every 30m"`, `"every 2h"`).
 * - **cron** — full cron expressions (`"0 9 * * *"`); requires the
 *   optional `cron-parser` peer dependency.
 *
 * The store is profile-aware (`~/.clawagents/<profile>/cron/jobs.json`)
 * so each profile sees its own schedule.
 *
 * Mirrors `clawagents_py/src/clawagents/cron/__init__.py`.
 */

export { SchedulerError } from "./errors.js";
export type {
    Job,
    JobRepeat,
    ParsedSchedule,
    ScheduleKind,
    CreateJobOptions,
    UpdateJobInput,
} from "./jobs.js";
export {
    CRONITER_AVAILABLE,
    ONESHOT_GRACE_SECONDS,
    parseDuration,
    parseSchedule,
    computeNextRun,
    loadJobs,
    saveJobs,
    createJob,
    getJob,
    listJobs,
    updateJob,
    pauseJob,
    resumeJob,
    triggerJob,
    removeJob,
    markJobRun,
    advanceNextRun,
    getDueJobs,
    saveJobOutput,
    setClock,
    resetClock,
    _setCronParserForTest,
} from "./jobs.js";
export type { JobRunner, SchedulerOptions, SchedulerStats } from "./scheduler.js";
export { Scheduler } from "./scheduler.js";
