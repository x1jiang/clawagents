/**
 * Span — the unit of tracing data.
 *
 * Mirrors `clawagents_py/src/clawagents/tracing/span.py`.
 */

import { randomUUID } from "node:crypto";

export enum SpanKind {
    AGENT = "agent",
    TURN = "turn",
    GENERATION = "generation",
    TOOL = "tool",
    HANDOFF = "handoff",
    GUARDRAIL = "guardrail",
    SUBAGENT = "subagent",
    CUSTOM = "custom",
}

export enum SpanStatus {
    OK = "ok",
    ERROR = "error",
    CANCELLED = "cancelled",
}

function newId(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function newTraceId(): string {
    return newId("trace");
}

export interface SpanInit {
    name: string;
    kind: SpanKind;
    traceId: string;
    spanId?: string;
    parentId?: string | null;
    attributes?: Record<string, unknown>;
}

export class Span {
    readonly name: string;
    readonly kind: SpanKind;
    readonly traceId: string;
    readonly spanId: string;
    readonly parentId: string | null;
    readonly startedAt: number;
    endedAt: number | null = null;
    status: SpanStatus = SpanStatus.OK;
    attributes: Record<string, unknown>;
    errorMessage: string | null = null;

    constructor(init: SpanInit) {
        this.name = init.name;
        this.kind = init.kind;
        this.traceId = init.traceId;
        this.spanId = init.spanId ?? newId("span");
        this.parentId = init.parentId ?? null;
        this.startedAt = Date.now() / 1000;
        this.attributes = { ...(init.attributes ?? {}) };
    }

    get durationS(): number | null {
        return this.endedAt === null ? null : this.endedAt - this.startedAt;
    }

    end(status: SpanStatus = SpanStatus.OK, error?: string | null): void {
        if (this.endedAt === null) this.endedAt = Date.now() / 1000;
        this.status = status;
        if (error != null) this.errorMessage = error;
    }

    setAttribute(key: string, value: unknown): void {
        this.attributes[key] = value;
    }

    setAttributes(attrs: Record<string, unknown>): void {
        Object.assign(this.attributes, attrs);
    }

    toDict(): Record<string, unknown> {
        return {
            name: this.name,
            kind: this.kind,
            trace_id: this.traceId,
            span_id: this.spanId,
            parent_id: this.parentId,
            started_at: this.startedAt,
            ended_at: this.endedAt,
            duration_s: this.durationS,
            status: this.status,
            attributes: { ...this.attributes },
            error_message: this.errorMessage,
        };
    }
}
