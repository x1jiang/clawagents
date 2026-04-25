/**
 * Tracing — hierarchical span model for clawagents.
 *
 * Mirrors `clawagents_py/src/clawagents/tracing/__init__.py`.
 */

export { Span, SpanKind, SpanStatus, newTraceId } from "./span.js";
export type { SpanInit } from "./span.js";

export {
    TracingProcessor, TracingExporter,
    BatchTraceProcessor, NoopSpanExporter, ConsoleSpanExporter, JsonlSpanExporter,
    setDefaultProcessor, getDefaultProcessor, addTraceProcessor,
    flushTraces, shutdownTracing,
} from "./processor.js";

export {
    withSpan,
    agentSpan, turnSpan, generationSpan, toolSpan,
    handoffSpan, guardrailSpan, customSpan,
    currentSpan, currentTraceId,
} from "./context.js";
