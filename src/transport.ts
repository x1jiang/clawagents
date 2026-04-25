/**
 * Provider-agnostic transport interface.
 *
 * Today, `clawagents/providers/llm.ts` ships a single fat module that
 * knows about every concrete provider (OpenAI Responses, OpenAI Chat
 * Completions, Anthropic Messages, Google GenAI, Ollama, …). That
 * works, but it's hard to extend cleanly: every new provider has to
 * be added inside the same file with provider-specific branching.
 *
 * This module introduces a thin {@link Transport} abstraction so new
 * backends can be plugged in *without touching* `llm.ts`. The existing
 * provider code keeps working as-is — {@link Transport} is purely
 * additive and lives alongside the legacy entrypoints.
 *
 * ## Architecture
 *
 * - {@link TransportRequest} — provider-agnostic chat request payload.
 * - {@link TransportResponse} — provider-agnostic chat response payload.
 * - {@link Transport} — abstract base class. Concrete subclasses
 *   (one per provider) implement `chat` and optionally `stream` /
 *   `aclose`.
 * - {@link TransportRegistry} — process-wide registry mapping a
 *   provider name to a {@link Transport} instance.
 *
 * ## Adapter for legacy providers
 *
 * Use {@link LegacyChatTransport} when you want to expose
 * `providers/llm.chatWithProvider` as a {@link Transport} without
 * rewriting it.
 *
 * Mirrors `clawagents_py/src/clawagents/transport.py`.
 */

/** A provider-agnostic chat request. */
export interface TransportRequest {
    /** Model id (e.g. `"gpt-5.4"`, `"claude-4.5-sonnet"`). */
    model: string;
    /** Chat history as plain message dicts. */
    messages: { role: string; content: unknown; [k: string]: unknown }[];
    /** Optional list of native tool schemas, as plain dicts. */
    tools?: Record<string, unknown>[];
    /** `"auto"`, `"required"`, `"none"`, or a specific tool name. */
    toolChoice?: string;
    /** Optional sampling temperature. */
    temperature?: number;
    /** Optional response length cap. */
    maxTokens?: number;
    /** When true, callers should use `stream()`. */
    stream?: boolean;
    /** Provider-specific knobs (cache control, thinking budgets, …). */
    extra?: Record<string, unknown>;
}

/** A provider-agnostic chat response. */
export interface TransportResponse {
    /** Final assistant text. `null` if the model only emitted tool calls. */
    text: string | null;
    /** `{ id, name, args }` records for any tool calls the model made. */
    toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
    /** Optional usage payload (token counts, cost, …). */
    usage?: Record<string, unknown>;
    /** OpenAI-style finish reason. */
    finishReason?: string;
    /** Optional raw provider response, for debugging only. */
    raw?: unknown;
}

/**
 * Abstract base class for a provider transport.
 *
 * A transport is a thin wrapper around one provider's chat API. It
 * knows how to translate {@link TransportRequest} into the provider's
 * wire format and back into {@link TransportResponse}. Authentication,
 * base-url handling, retries, and rate-limiting are all internal
 * concerns of the transport.
 */
export abstract class Transport {
    /**
     * Stable identifier (`"openai"`, `"anthropic"`, `"gemini"`,
     * `"ollama"`, `"openrouter"`, …). Used by {@link TransportRegistry}.
     */
    abstract readonly name: string;

    /**
     * Issue a single chat call and return the final response.
     *
     * The default for non-streaming providers; streaming providers
     * should still implement this (consume their stream and return
     * the accumulated result) so callers don't have to special-case.
     */
    abstract chat(request: TransportRequest): Promise<TransportResponse>;

    /**
     * Yield incremental {@link TransportResponse} chunks.
     *
     * The default implementation calls {@link chat} once and yields
     * the final result, so transports that don't support streaming
     * still satisfy the interface.
     */
    async *stream(request: TransportRequest): AsyncIterable<TransportResponse> {
        yield await this.chat(request);
    }

    /** Release any underlying client resources. Called at shutdown. */
    async aclose(): Promise<void> {
        /* default: no-op */
    }
}

/**
 * Process-wide transport map. Single-threaded JS doesn't need a lock;
 * the explicit register/get pattern still keeps wiring legible.
 */
export class TransportRegistry {
    private static transports = new Map<string, Transport>();

    /** Register `transport` under `name` (defaults to `transport.name`). */
    static register(transport: Transport, opts: { name?: string } = {}): void {
        const key = opts.name ?? transport.name;
        if (!key) throw new Error("TransportRegistry.register: missing name");
        TransportRegistry.transports.set(key, transport);
    }

    /** Return the registered transport. Throws if missing. */
    static get(name: string): Transport {
        const t = TransportRegistry.transports.get(name);
        if (!t) {
            const known = Array.from(TransportRegistry.transports.keys()).sort();
            throw new Error(
                `No transport registered under ${JSON.stringify(name)}. Known: ${JSON.stringify(known)}`,
            );
        }
        return t;
    }

    static has(name: string): boolean {
        return TransportRegistry.transports.has(name);
    }

    static list(): string[] {
        return Array.from(TransportRegistry.transports.keys()).sort();
    }

    static unregister(name: string): void {
        TransportRegistry.transports.delete(name);
    }

    /** Drop all registered transports (test helper). */
    static clear(): void {
        TransportRegistry.transports.clear();
    }
}

/**
 * Adapter that exposes a callable as a {@link Transport}.
 *
 * Useful for wrapping the existing `providers/llm.chatWithProvider`
 * (or any compatible async function) without rewriting it.
 */
export class LegacyChatTransport extends Transport {
    readonly name: string;

    constructor(
        name: string,
        private readonly chatFn: (req: TransportRequest) => Promise<TransportResponse>,
    ) {
        super();
        this.name = name;
    }

    override async chat(request: TransportRequest): Promise<TransportResponse> {
        const result = await this.chatFn(request);
        if (
            result === null ||
            typeof result !== "object" ||
            !("text" in (result as unknown as Record<string, unknown>))
        ) {
            throw new TypeError(
                `LegacyChatTransport(${JSON.stringify(this.name)}): chatFn returned ` +
                    `${typeof result}, expected TransportResponse`,
            );
        }
        return result;
    }
}
