/**
 * Error taxonomy and recovery recipes for ClawAgents.
 *
 * Classifies errors from LLM providers and tool execution into discrete
 * failure classes, each with a retryable flag, recovery hint, and optional
 * failover model suggestion.
 *
 * Inspired by claw-code-main's error.rs taxonomy.
 */

export enum ErrorClass {
    CONTEXT_WINDOW = "context_window",
    PROVIDER_AUTH = "provider_auth",
    PROVIDER_RATE_LIMIT = "provider_rate_limit",
    PROVIDER_RETRY_EXHAUSTED = "provider_retry_exhausted",
    PROVIDER_INTERNAL = "provider_internal",
    PROVIDER_TRANSPORT = "provider_transport",
    RUNTIME_IO = "runtime_io",
    UNKNOWN = "unknown",
}

export interface ErrorDescriptor {
    errorClass: ErrorClass;
    retryable: boolean;
    recoveryHint: string;
    maxRetries: number;
    failoverModel?: string;
    original?: Error;
}

export interface RecoveryRecipe {
    retryable: boolean;
    maxRetries: number;
    recoveryHint: string;
    failoverModel?: string;
    backoffBaseMs: number;
    compactOnRetry: boolean;
}

// ─── Recovery Recipes ────────────────────────────────────────────────────

export const RECOVERY_RECIPES: Record<ErrorClass, RecoveryRecipe> = {
    [ErrorClass.CONTEXT_WINDOW]: {
        retryable: true,
        maxRetries: 2,
        recoveryHint: "Context window exceeded. Compacting messages and retrying with shorter context.",
        backoffBaseMs: 0,
        compactOnRetry: true,
    },
    [ErrorClass.PROVIDER_AUTH]: {
        retryable: false,
        maxRetries: 0,
        recoveryHint: "Authentication failed. Check your API key is set correctly in .env (OPENAI_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY).",
        backoffBaseMs: 0,
        compactOnRetry: false,
    },
    [ErrorClass.PROVIDER_RATE_LIMIT]: {
        retryable: true,
        maxRetries: 5,
        recoveryHint: "Rate limited by provider. Backing off and retrying.",
        backoffBaseMs: 2_000,
        compactOnRetry: false,
    },
    [ErrorClass.PROVIDER_RETRY_EXHAUSTED]: {
        retryable: false,
        maxRetries: 0,
        recoveryHint: "Max retries exhausted. The provider may be experiencing an outage. Try again later or switch models.",
        failoverModel: "gpt-5-nano",
        backoffBaseMs: 0,
        compactOnRetry: false,
    },
    [ErrorClass.PROVIDER_INTERNAL]: {
        retryable: true,
        maxRetries: 3,
        recoveryHint: "Provider internal error (5xx). Retrying with backoff.",
        backoffBaseMs: 2_000,
        compactOnRetry: false,
    },
    [ErrorClass.PROVIDER_TRANSPORT]: {
        retryable: true,
        maxRetries: 3,
        recoveryHint: "Network/transport error. Check your internet connection. Retrying.",
        backoffBaseMs: 1_000,
        compactOnRetry: false,
    },
    [ErrorClass.RUNTIME_IO]: {
        retryable: false,
        maxRetries: 0,
        recoveryHint: "Local I/O error (file not found, permission denied, JSON decode failure).",
        backoffBaseMs: 0,
        compactOnRetry: false,
    },
    [ErrorClass.UNKNOWN]: {
        retryable: false,
        maxRetries: 0,
        recoveryHint: "An unexpected error occurred.",
        backoffBaseMs: 0,
        compactOnRetry: false,
    },
};

// ─── Classification ──────────────────────────────────────────────────────

export function classifyError(err: unknown, provider = ""): ErrorDescriptor {
    const msg = String(err instanceof Error ? err.message : err).toLowerCase();
    const errType = (err instanceof Error ? err.constructor.name : "").toLowerCase();
    const status = extractStatus(err);

    // 1. Context window / token overflow
    const contextTokens = [
        "context_length_exceeded", "context window", "token limit",
        "maximum context length", "too many tokens",
        "prompt is too long", "request too large",
        "max_tokens", "context_window_exceeded",
    ];
    if (contextTokens.some((t) => msg.includes(t))) {
        const recipe = RECOVERY_RECIPES[ErrorClass.CONTEXT_WINDOW];
        return {
            errorClass: ErrorClass.CONTEXT_WINDOW,
            retryable: recipe.retryable,
            recoveryHint: recipe.recoveryHint,
            maxRetries: recipe.maxRetries,
            original: err instanceof Error ? err : new Error(String(err)),
        };
    }

    // 2. Auth errors
    const authTokens = [
        "unauthorized", "forbidden", "invalid api key", "invalid_api_key",
        "authentication", "invalid x-api-key", "permission denied",
        "incorrect api key", "invalid auth",
    ];
    if (status === 401 || status === 403 || authTokens.some((t) => msg.includes(t))) {
        const recipe = RECOVERY_RECIPES[ErrorClass.PROVIDER_AUTH];
        return {
            errorClass: ErrorClass.PROVIDER_AUTH,
            retryable: recipe.retryable,
            recoveryHint: recipe.recoveryHint,
            maxRetries: recipe.maxRetries,
            original: err instanceof Error ? err : new Error(String(err)),
        };
    }

    // 3. Rate limit
    const rlTokens = [
        "rate limit", "too many requests", "rate_limit_exceeded",
        "quota exceeded", "resource_exhausted",
    ];
    if (status === 429 || rlTokens.some((t) => msg.includes(t))) {
        const recipe = RECOVERY_RECIPES[ErrorClass.PROVIDER_RATE_LIMIT];
        return {
            errorClass: ErrorClass.PROVIDER_RATE_LIMIT,
            retryable: recipe.retryable,
            recoveryHint: recipe.recoveryHint,
            maxRetries: recipe.maxRetries,
            original: err instanceof Error ? err : new Error(String(err)),
        };
    }

    // 4. Provider internal (5xx)
    if (status !== null && status >= 500 && status <= 504) {
        const recipe = RECOVERY_RECIPES[ErrorClass.PROVIDER_INTERNAL];
        return {
            errorClass: ErrorClass.PROVIDER_INTERNAL,
            retryable: recipe.retryable,
            recoveryHint: recipe.recoveryHint,
            maxRetries: recipe.maxRetries,
            original: err instanceof Error ? err : new Error(String(err)),
        };
    }

    // 5. Transport / network
    const transportTokens = [
        "econnreset", "connection", "timeout", "network",
        "socket hang up", "fetch failed", "stream stalled",
        "dns", "ssl", "tls",
    ];
    if (
        transportTokens.some((t) => msg.includes(t)) ||
        ["connection", "timeout"].some((t) => errType.includes(t))
    ) {
        const recipe = RECOVERY_RECIPES[ErrorClass.PROVIDER_TRANSPORT];
        return {
            errorClass: ErrorClass.PROVIDER_TRANSPORT,
            retryable: recipe.retryable,
            recoveryHint: recipe.recoveryHint,
            maxRetries: recipe.maxRetries,
            original: err instanceof Error ? err : new Error(String(err)),
        };
    }

    // 6. Runtime I/O
    if (
        errType.includes("enoent") || errType.includes("eacces") ||
        msg.includes("enoent") || msg.includes("eacces") || msg.includes("eperm") ||
        ["json", "decode", "parse", "syntax"].some((t) => errType.includes(t))
    ) {
        const recipe = RECOVERY_RECIPES[ErrorClass.RUNTIME_IO];
        return {
            errorClass: ErrorClass.RUNTIME_IO,
            retryable: recipe.retryable,
            recoveryHint: `I/O error: ${String(err).slice(0, 200)}`,
            maxRetries: recipe.maxRetries,
            original: err instanceof Error ? err : new Error(String(err)),
        };
    }

    // 7. Unknown
    return {
        errorClass: ErrorClass.UNKNOWN,
        retryable: false,
        recoveryHint: `Unexpected error: ${String(err).slice(0, 200)}`,
        maxRetries: 0,
        original: err instanceof Error ? err : new Error(String(err)),
    };
}

export function getRecoveryRecipe(errorClass: ErrorClass): RecoveryRecipe {
    return RECOVERY_RECIPES[errorClass] ?? RECOVERY_RECIPES[ErrorClass.UNKNOWN];
}

function extractStatus(err: unknown): number | null {
    if (err && typeof err === "object") {
        // OpenAI SDK: err.status
        if ("status" in err && typeof (err as any).status === "number") return (err as any).status;
        // status_code fallback
        if ("status_code" in err && typeof (err as any).status_code === "number") return (err as any).status_code;
        // response.status
        if ("response" in err && (err as any).response?.status) return (err as any).response.status;
    }
    // String-based fallback
    const msg = String(err);
    for (const code of [401, 403, 429, 500, 502, 503, 504]) {
        if (msg.includes(String(code))) return code;
    }
    return null;
}
