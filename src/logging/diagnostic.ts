import { redact } from "../redact.js";

/**
 * Diagnostic logger. All emitted messages are routed through ``redact()`` so
 * accidental key prints (e.g. logging an LLM request body that contained
 * ``Authorization: Bearer ...``) never make it to the terminal or log files.
 */
export const diagnosticLogger = {
    warn: (msg: string) => console.warn(`[DIAG_WARN] ${redact(msg)}`),
    debug: (msg: string) => console.debug(`[DIAG_DEBUG] ${redact(msg)}`),
    error: (msg: string) => console.error(`[DIAG_ERROR] ${redact(msg)}`),
    info: (msg: string) => console.info(`[DIAG_INFO] ${redact(msg)}`),
};

export function logLaneDequeue(lane: string, waitedMs: number, queueAhead: number) {
    diagnosticLogger.debug(`Lane ${lane} dequeue. Waited ${waitedMs}ms. Ahead: ${queueAhead}`);
}

export function logLaneEnqueue(lane: string, totalSize: number) {
    diagnosticLogger.debug(`Lane ${lane} enqueue. Total Size: ${totalSize}`);
}
