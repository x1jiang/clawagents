/**
 * Per-run token-usage accumulator.
 *
 * Tracks LLM token consumption across every model call in a single agent
 * run. Exposed via {@link RunContext.usage} and {@link AgentState.usage}
 * so callers and tools can read real-time stats.
 *
 * Mirrors `clawagents_py`'s ``Usage`` / ``RequestUsage`` API shape.
 */

/** Usage from a single model call. */
export class RequestUsage {
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    cacheCreationTokens: number;
    timeToFirstTokenMs: number | undefined;
    peakMemoryBytes: number;

    constructor(init: {
        model?: string;
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cachedInputTokens?: number;
        reasoningTokens?: number;
        cacheCreationTokens?: number;
        timeToFirstTokenMs?: number;
        peakMemoryBytes?: number;
    } = {}) {
        this.model = init.model ?? "";
        this.inputTokens = init.inputTokens ?? 0;
        this.outputTokens = init.outputTokens ?? 0;
        this.totalTokens = init.totalTokens ?? (this.inputTokens + this.outputTokens);
        this.cachedInputTokens = init.cachedInputTokens ?? 0;
        this.reasoningTokens = init.reasoningTokens ?? 0;
        this.cacheCreationTokens = init.cacheCreationTokens ?? 0;
        this.timeToFirstTokenMs = init.timeToFirstTokenMs;
        this.peakMemoryBytes = init.peakMemoryBytes ?? 0;
    }

    toJSON(): Record<string, unknown> {
        return {
            model: this.model,
            input_tokens: this.inputTokens,
            output_tokens: this.outputTokens,
            total_tokens: this.totalTokens,
            cached_input_tokens: this.cachedInputTokens,
            reasoning_tokens: this.reasoningTokens,
            cache_creation_tokens: this.cacheCreationTokens,
            time_to_first_token_ms: this.timeToFirstTokenMs,
            peak_memory_bytes: this.peakMemoryBytes,
        };
    }
}

/** Running total of LLM token consumption for one agent run. */
export class Usage {
    requests: number = 0;
    inputTokens: number = 0;
    outputTokens: number = 0;
    totalTokens: number = 0;
    cachedInputTokens: number = 0;
    reasoningTokens: number = 0;
    cacheCreationTokens: number = 0;
    /** TTFT for the first model request in this run. */
    timeToFirstTokenMs: number | undefined;
    /** Highest observed resident-set size sampled during this run. */
    peakMemoryBytes: number = 0;
    perRequest: RequestUsage[] = [];

    /** Record one LLM call into the running total. */
    addResponse(init: {
        model?: string;
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cachedInputTokens?: number;
        reasoningTokens?: number;
        cacheCreationTokens?: number;
        timeToFirstTokenMs?: number;
        peakMemoryBytes?: number;
    }): RequestUsage {
        const req = new RequestUsage(init);
        this.requests += 1;
        this.inputTokens += req.inputTokens;
        this.outputTokens += req.outputTokens;
        this.totalTokens += req.totalTokens;
        this.cachedInputTokens += req.cachedInputTokens;
        this.reasoningTokens += req.reasoningTokens;
        this.cacheCreationTokens += req.cacheCreationTokens;
        if (this.timeToFirstTokenMs === undefined && req.timeToFirstTokenMs !== undefined) {
            this.timeToFirstTokenMs = req.timeToFirstTokenMs;
        }
        this.peakMemoryBytes = Math.max(this.peakMemoryBytes, req.peakMemoryBytes);
        this.perRequest.push(req);
        return req;
    }

    /** Merge another {@link Usage} record into this one in-place. */
    merge(other: Usage): void {
        this.requests += other.requests;
        this.inputTokens += other.inputTokens;
        this.outputTokens += other.outputTokens;
        this.totalTokens += other.totalTokens;
        this.cachedInputTokens += other.cachedInputTokens;
        this.reasoningTokens += other.reasoningTokens;
        this.cacheCreationTokens += other.cacheCreationTokens;
        if (this.timeToFirstTokenMs === undefined) this.timeToFirstTokenMs = other.timeToFirstTokenMs;
        this.peakMemoryBytes = Math.max(this.peakMemoryBytes, other.peakMemoryBytes);
        for (const r of other.perRequest) this.perRequest.push(r);
    }

    /** Sample current RSS and update the observed run peak. */
    sampleMemory(memoryBytes = process.memoryUsage().rss): number {
        this.peakMemoryBytes = Math.max(this.peakMemoryBytes, memoryBytes);
        return this.peakMemoryBytes;
    }

    toJSON(): Record<string, unknown> {
        return {
            requests: this.requests,
            input_tokens: this.inputTokens,
            output_tokens: this.outputTokens,
            total_tokens: this.totalTokens,
            cached_input_tokens: this.cachedInputTokens,
            reasoning_tokens: this.reasoningTokens,
            cache_creation_tokens: this.cacheCreationTokens,
            time_to_first_token_ms: this.timeToFirstTokenMs,
            peak_memory_bytes: this.peakMemoryBytes,
            per_request: this.perRequest.map((r) => r.toJSON()),
        };
    }
}
