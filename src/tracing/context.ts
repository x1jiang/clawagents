/**
 * Span context — uses Node's AsyncLocalStorage for the contextvars equivalent.
 *
 * Mirrors `clawagents_py/src/clawagents/tracing/context.py`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getDefaultProcessor } from "./processor.js";
import { Span, SpanKind, SpanStatus, newTraceId } from "./span.js";

interface TracingContext {
    span: Span | null;
    traceId: string | null;
}

const storage = new AsyncLocalStorage<TracingContext>();

export function currentSpan(): Span | null {
    return storage.getStore()?.span ?? null;
}

export function currentTraceId(): string | null {
    return storage.getStore()?.traceId ?? null;
}

/**
 * Run `fn` inside a span. The span is closed (status set, processor notified)
 * when `fn` returns or throws.
 *
 * Returns whatever `fn` returns. Sync and async closures both work — async
 * closures should be awaited so the span is closed at the right time.
 */
export function withSpan<T>(
    name: string,
    kind: SpanKind,
    fn: (span: Span) => Promise<T>,
    opts?: { attributes?: Record<string, unknown>; traceId?: string },
): Promise<T>;
export function withSpan<T>(
    name: string,
    kind: SpanKind,
    fn: (span: Span) => T,
    opts?: { attributes?: Record<string, unknown>; traceId?: string },
): T;
export function withSpan<T>(
    name: string,
    kind: SpanKind,
    fn: (span: Span) => T | Promise<T>,
    opts: { attributes?: Record<string, unknown>; traceId?: string } = {},
): T | Promise<T> {
    const parentCtx = storage.getStore() ?? null;
    const parentSpan = parentCtx?.span ?? null;
    const resolvedTrace =
        opts.traceId ?? parentCtx?.traceId ?? (parentSpan?.traceId ?? newTraceId());

    const span = new Span({
        name, kind,
        traceId: resolvedTrace,
        parentId: parentSpan?.spanId ?? null,
        attributes: opts.attributes,
    });

    const finishSpan = (status: SpanStatus, error?: string | null) => {
        if (span.endedAt === null) span.end(status, error);
        try { getDefaultProcessor().onSpanEnd(span); } catch { /* swallow */ }
    };

    return storage.run({ span, traceId: resolvedTrace }, (): T | Promise<T> => {
        let result: T | Promise<T>;
        try {
            result = fn(span);
        } catch (e) {
            finishSpan(SpanStatus.ERROR, (e as Error)?.message ?? String(e));
            throw e;
        }
        // Async tail: if fn returned a Promise, hook completion.
        if (result instanceof Promise) {
            return result.then(
                v => { finishSpan(SpanStatus.OK); return v; },
                e => { finishSpan(SpanStatus.ERROR, (e as Error)?.message ?? String(e)); throw e; },
            );
        }
        finishSpan(SpanStatus.OK);
        return result;
    });
}

// Convenience kind-specific helpers. They accept either sync or async closures
// and return whatever the closure returns (sync → T, async → Promise<T>).

// Overload pairs let callers stay typed: sync fn → T, async fn → Promise<T>.

export function agentSpan<T>(name: string, fn: (span: Span) => Promise<T>, attrs?: Record<string, unknown>): Promise<T>;
export function agentSpan<T>(name: string, fn: (span: Span) => T, attrs?: Record<string, unknown>): T;
export function agentSpan<T>(name: string, fn: (span: Span) => T | Promise<T>, attrs?: Record<string, unknown>): T | Promise<T> {
    return withSpan(name, SpanKind.AGENT, fn as (s: Span) => T, { attributes: attrs });
}

export function turnSpan<T>(fn: (span: Span) => Promise<T>, attrs?: Record<string, unknown>): Promise<T>;
export function turnSpan<T>(fn: (span: Span) => T, attrs?: Record<string, unknown>): T;
export function turnSpan<T>(fn: (span: Span) => T | Promise<T>, attrs?: Record<string, unknown>): T | Promise<T> {
    return withSpan("turn", SpanKind.TURN, fn as (s: Span) => T, { attributes: attrs });
}

export function generationSpan<T>(fn: (span: Span) => Promise<T>, attrs?: Record<string, unknown>): Promise<T>;
export function generationSpan<T>(fn: (span: Span) => T, attrs?: Record<string, unknown>): T;
export function generationSpan<T>(fn: (span: Span) => T | Promise<T>, attrs?: Record<string, unknown>): T | Promise<T> {
    return withSpan("llm.chat", SpanKind.GENERATION, fn as (s: Span) => T, { attributes: attrs });
}

export function toolSpan<T>(name: string, fn: (span: Span) => Promise<T>, attrs?: Record<string, unknown>): Promise<T>;
export function toolSpan<T>(name: string, fn: (span: Span) => T, attrs?: Record<string, unknown>): T;
export function toolSpan<T>(name: string, fn: (span: Span) => T | Promise<T>, attrs?: Record<string, unknown>): T | Promise<T> {
    return withSpan(`tool.${name}`, SpanKind.TOOL, fn as (s: Span) => T, { attributes: attrs });
}

export function handoffSpan<T>(name: string, fn: (span: Span) => Promise<T>, attrs?: Record<string, unknown>): Promise<T>;
export function handoffSpan<T>(name: string, fn: (span: Span) => T, attrs?: Record<string, unknown>): T;
export function handoffSpan<T>(name: string, fn: (span: Span) => T | Promise<T>, attrs?: Record<string, unknown>): T | Promise<T> {
    return withSpan(`handoff.${name}`, SpanKind.HANDOFF, fn as (s: Span) => T, { attributes: attrs });
}

export function guardrailSpan<T>(name: string, fn: (span: Span) => Promise<T>, attrs?: Record<string, unknown>): Promise<T>;
export function guardrailSpan<T>(name: string, fn: (span: Span) => T, attrs?: Record<string, unknown>): T;
export function guardrailSpan<T>(name: string, fn: (span: Span) => T | Promise<T>, attrs?: Record<string, unknown>): T | Promise<T> {
    return withSpan(`guardrail.${name}`, SpanKind.GUARDRAIL, fn as (s: Span) => T, { attributes: attrs });
}

export function customSpan<T>(name: string, fn: (span: Span) => Promise<T>, attrs?: Record<string, unknown>): Promise<T>;
export function customSpan<T>(name: string, fn: (span: Span) => T, attrs?: Record<string, unknown>): T;
export function customSpan<T>(name: string, fn: (span: Span) => T | Promise<T>, attrs?: Record<string, unknown>): T | Promise<T> {
    return withSpan(name, SpanKind.CUSTOM, fn as (s: Span) => T, { attributes: attrs });
}
