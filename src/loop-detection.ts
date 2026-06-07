/** Configurable tool loop detection (OpenClaw 2026.6.1 pattern). */

export type LoopLevel = "warning" | "critical";
export type LoopDetector =
    | "generic_repeat"
    | "known_poll_no_progress"
    | "ping_pong"
    | "global_circuit_breaker";

export const DEFAULT_KNOWN_POLL_TOOLS: ReadonlySet<string> = new Set([
    "execute",
    "task_status",
    "task_output",
    "read_file",
    "glob",
    "grep",
    "web_fetch",
    "browser_snapshot",
]);

export interface LoopDetectionDetectors {
    genericRepeat?: boolean;
    knownPollNoProgress?: boolean;
    pingPong?: boolean;
    globalCircuitBreaker?: boolean;
}

export interface LoopDetectionConfig {
    enabled?: boolean;
    warningThreshold?: number;
    criticalThreshold?: number;
    globalCircuitBreakerThreshold?: number;
    knownPollTools?: ReadonlySet<string>;
    detectors?: LoopDetectionDetectors;
}

export interface LoopDetectionResult {
    stuck: boolean;
    level?: LoopLevel;
    detector?: LoopDetector;
    count?: number;
    message?: string;
    warningKey?: string;
}

export type PollHistoryEntry = [toolName: string, callHash: string, resultHash: string | null];

const DEFAULT_DETECTORS: Required<LoopDetectionDetectors> = {
    genericRepeat: true,
    knownPollNoProgress: true,
    pingPong: true,
    globalCircuitBreaker: true,
};

export function resolveLoopDetectionConfig(config?: LoopDetectionConfig): Required<LoopDetectionConfig> & {
    detectors: Required<LoopDetectionDetectors>;
} {
    return {
        enabled: config?.enabled ?? true,
        warningThreshold: config?.warningThreshold ?? 3,
        criticalThreshold: config?.criticalThreshold ?? 6,
        globalCircuitBreakerThreshold: config?.globalCircuitBreakerThreshold ?? 30,
        knownPollTools: config?.knownPollTools ?? DEFAULT_KNOWN_POLL_TOOLS,
        detectors: { ...DEFAULT_DETECTORS, ...config?.detectors },
    };
}

export function hashToolCall(toolName: string, params: Record<string, unknown>): string {
    try {
        return `${toolName}:${JSON.stringify(params, Object.keys(params).sort())}`;
    } catch {
        return `${toolName}:${String(params)}`;
    }
}

export function isKnownPollToolCall(
    toolName: string,
    params: Record<string, unknown>,
    config: ReturnType<typeof resolveLoopDetectionConfig>,
): boolean {
    if (!config.knownPollTools.has(toolName)) return false;
    if (toolName === "execute") {
        const cmd = params.command ?? params.cmd ?? "";
        return Boolean(String(cmd).trim());
    }
    if (toolName === "read_file" || toolName === "glob" || toolName === "grep") {
        return Boolean(params.path ?? params.pattern ?? params.glob_pattern);
    }
    return true;
}

export function getNoProgressStreak(
    history: PollHistoryEntry[],
    toolName: string,
    callHash: string,
): [streak: number, latestResult: string | null] {
    let streak = 0;
    let latestResult: string | null = null;
    for (let i = history.length - 1; i >= 0; i--) {
        const [name, ch, rh] = history[i]!;
        if (name === toolName && ch === callHash) {
            streak += 1;
            if (latestResult === null) {
                latestResult = rh;
            } else if (rh !== latestResult) {
                break;
            }
        } else if (streak > 0) {
            break;
        }
    }
    return [streak, latestResult];
}

export function detectKnownPollNoProgress(opts: {
    toolName: string;
    params: Record<string, unknown>;
    history: PollHistoryEntry[];
    config?: LoopDetectionConfig;
}): LoopDetectionResult | null {
    const resolved = resolveLoopDetectionConfig(opts.config);
    if (!resolved.enabled || !resolved.detectors.knownPollNoProgress) return null;
    if (!isKnownPollToolCall(opts.toolName, opts.params, resolved)) return null;

    const callHash = hashToolCall(opts.toolName, opts.params);
    const [streak, resultHash] = getNoProgressStreak(opts.history, opts.toolName, callHash);

    if (streak >= resolved.criticalThreshold) {
        return {
            stuck: true,
            level: "critical",
            detector: "known_poll_no_progress",
            count: streak,
            message:
                `CRITICAL: Called ${opts.toolName} with identical arguments and no progress ` +
                `${streak} times. This appears to be a stuck polling loop.`,
            warningKey: `poll:${opts.toolName}:${callHash}:${resultHash ?? "none"}`,
        };
    }
    if (streak >= resolved.warningThreshold) {
        return {
            stuck: true,
            level: "warning",
            detector: "known_poll_no_progress",
            count: streak,
            message:
                `WARNING: You have called ${opts.toolName} ${streak} times with identical ` +
                "arguments and no progress. Stop polling or report failure.",
            warningKey: `poll:${opts.toolName}:${callHash}:${resultHash ?? "none"}`,
        };
    }
    return null;
}
