/**
 * Composable retry policy built on top of the existing {@link ErrorClass}
 * taxonomy.
 *
 * The existing `withRetry` helper in `providers/llm.ts` uses a small
 * hard-coded set of rules. {@link RetryPolicy} promotes that to a
 * first-class, user-configurable object:
 *
 * - Decide *which* {@link ErrorClass} values to retry.
 * - Configure `maxRetries`, `baseDelayMs`, `maxDelayMs`, and `jitter`.
 * - Optionally cap retries per-error-class (e.g. one retry for auth
 *   errors, six for rate limits).
 *
 * Pass a `RetryPolicy` to {@link LLMProvider.setRetryPolicy} / the
 * provider constructor and the internal retry loop asks the policy
 * whether to retry and how long to wait.
 */

import {
    classifyError,
    ErrorClass,
    ErrorDescriptor,
} from "./errors/taxonomy.js";

export interface RetryPolicyOptions {
    maxRetries?: number;
    retryOn?: Iterable<ErrorClass>;
    baseDelayMs?: number;
    maxDelayMs?: number;
    /** Multiplicative uniform jitter factor; `0` disables. */
    jitter?: number;
    perClassMax?: Partial<Record<ErrorClass, number>>;
}

export class RetryPolicy {
    maxRetries: number;
    retryOn: Set<ErrorClass>;
    baseDelayMs: number;
    maxDelayMs: number;
    jitter: number;
    perClassMax: Partial<Record<ErrorClass, number>>;

    constructor(options: RetryPolicyOptions = {}) {
        this.maxRetries = options.maxRetries ?? 6;
        this.retryOn = new Set(
            options.retryOn ?? [
                ErrorClass.PROVIDER_RATE_LIMIT,
                ErrorClass.PROVIDER_INTERNAL,
                ErrorClass.PROVIDER_TRANSPORT,
            ],
        );
        this.baseDelayMs = options.baseDelayMs ?? 1_000;
        this.maxDelayMs = options.maxDelayMs ?? 30_000;
        // Clamp jitter to [0, 1]: a caller passing 1.5 would otherwise
        // let ``factor`` go negative and ``Math.max(0, factor)`` would
        // produce zero-delay retry storms.
        this.jitter = Math.min(1, Math.max(0, options.jitter ?? 0.25));
        this.perClassMax = options.perClassMax ?? {};
    }

    classify(err: unknown, provider = ""): ErrorDescriptor {
        return classifyError(err, provider);
    }

    /** Return true if `attempt` (1-indexed) may be retried.
     *
     * `maxRetries=N` means "perform up to N retries", so attempts 1..N
     * are eligible (attempt N+1 is past the cap).
     */
    shouldRetry(
        err: unknown,
        attempt: number,
        options: { descriptor?: ErrorDescriptor } = {},
    ): boolean {
        const descriptor = options.descriptor ?? this.classify(err);
        if (!this.retryOn.has(descriptor.errorClass)) return false;
        const cap = this.perClassMax[descriptor.errorClass] ?? this.maxRetries;
        return attempt <= cap;
    }

    /** Return the milliseconds to sleep before retrying `attempt + 1`. */
    computeDelayMs(
        attempt: number,
        options: { retryAfterMs?: number } = {},
    ): number {
        const { retryAfterMs } = options;
        if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
            return Math.min(retryAfterMs, this.maxDelayMs);
        }
        let delay = Math.min(
            this.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)),
            this.maxDelayMs,
        );
        if (this.jitter > 0) {
            const factor = 1 + (Math.random() * 2 - 1) * this.jitter;
            delay *= Math.max(0, factor);
        }
        return delay;
    }
}

export const DEFAULT_RETRY_POLICY = new RetryPolicy();
