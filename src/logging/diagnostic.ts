export const diagnosticLogger = {
    warn: (msg: string) => console.warn(`[DIAG_WARN] ${msg}`),
    debug: (msg: string) => console.debug(`[DIAG_DEBUG] ${msg}`),
    error: (msg: string) => console.error(`[DIAG_ERROR] ${msg}`),
    info: (msg: string) => console.info(`[DIAG_INFO] ${msg}`),
};

export function logLaneDequeue(lane: string, waitedMs: number, queueAhead: number) {
    diagnosticLogger.debug(`Lane ${lane} dequeue. Waited ${waitedMs}ms. Ahead: ${queueAhead}`);
}

export function logLaneEnqueue(lane: string, totalSize: number) {
    diagnosticLogger.debug(`Lane ${lane} enqueue. Total Size: ${totalSize}`);
}
