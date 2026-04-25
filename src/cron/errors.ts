/** Cron error types. Mirrors `clawagents_py/src/clawagents/cron/errors.py`. */

export class SchedulerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SchedulerError";
    }
}
