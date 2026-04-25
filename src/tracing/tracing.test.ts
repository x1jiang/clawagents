/**
 * Tests for the tracing module (mirrors tests/test_tracing.py).
 *
 * Run with: npx tsx --test src/tracing/tracing.test.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    Span, SpanKind, SpanStatus, TracingExporter,
    BatchTraceProcessor, JsonlSpanExporter,
    setDefaultProcessor, addTraceProcessor, flushTraces,
    agentSpan, turnSpan, generationSpan, toolSpan, customSpan,
    currentSpan, currentTraceId,
} from "./index.js";

class CollectExporter extends TracingExporter {
    spans: Span[] = [];
    export(spans: Span[]): void {
        this.spans.push(...spans);
    }
}

const cleanupDirs: string[] = [];
after(() => {
    for (const d of cleanupDirs) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* swallow */ }
    }
});

beforeEach(() => {
    // Reset to a clean default before each test so failed tests don't leak processors
    setDefaultProcessor(new BatchTraceProcessor());
});

describe("Span basics", () => {
    it("constructs with sane defaults", () => {
        const s = new Span({ name: "foo", kind: SpanKind.TOOL, traceId: "trace_x" });
        assert.equal(s.name, "foo");
        assert.equal(s.kind, SpanKind.TOOL);
        assert.equal(s.traceId, "trace_x");
        assert.match(s.spanId, /^span_/);
        assert.equal(s.parentId, null);
        assert.equal(s.durationS, null);
    });

    it("end() sets endedAt and status", () => {
        const s = new Span({ name: "t", kind: SpanKind.TURN, traceId: "x" });
        s.end();
        assert.notEqual(s.durationS, null);
        assert.equal(s.status, SpanStatus.OK);
    });

    it("toDict round-trips through JSON", () => {
        const s = new Span({
            name: "t", kind: SpanKind.TURN, traceId: "x",
            attributes: { round: 1 },
        });
        s.end();
        const d = s.toDict();
        const json = JSON.stringify(d);
        const parsed = JSON.parse(json);
        assert.equal(parsed.kind, "turn");
        assert.deepEqual(parsed.attributes, { round: 1 });
    });
});

describe("Span context manager", () => {
    it("nests spans and propagates trace_id + parent_id", async () => {
        const exporter = new CollectExporter();
        setDefaultProcessor(new BatchTraceProcessor(exporter, { flushIntervalMs: 50 }));

        await agentSpan("root", async (a) => {
            assert.equal(currentTraceId(), a.traceId);
            await turnSpan(async (t) => {
                assert.equal(t.parentId, a.spanId);
                assert.equal(t.traceId, a.traceId);
                await generationSpan(g => {
                    assert.equal(g.parentId, t.spanId);
                    assert.equal(g.traceId, a.traceId);
                });
            });
        });
        await flushTraces(2000);

        const kinds = new Set(exporter.spans.map(s => s.kind));
        assert.ok(kinds.has(SpanKind.AGENT));
        assert.ok(kinds.has(SpanKind.TURN));
        assert.ok(kinds.has(SpanKind.GENERATION));
    });

    it("marks span as ERROR when fn throws", async () => {
        const exporter = new CollectExporter();
        setDefaultProcessor(new BatchTraceProcessor(exporter, { flushIntervalMs: 50 }));

        await assert.rejects(async () => {
            await toolSpan("boom", () => {
                throw new Error("kaboom");
            });
        }, /kaboom/);
        await flushTraces(2000);

        assert.equal(exporter.spans.length, 1);
        const s = exporter.spans[0]!;
        assert.equal(s.status, SpanStatus.ERROR);
        assert.equal(s.errorMessage, "kaboom");
    });

    it("marks span as ERROR when async fn rejects", async () => {
        const exporter = new CollectExporter();
        setDefaultProcessor(new BatchTraceProcessor(exporter, { flushIntervalMs: 50 }));

        await assert.rejects(async () => {
            await toolSpan("async-boom", async () => {
                throw new Error("kaboom-async");
            });
        }, /kaboom-async/);
        await flushTraces(2000);

        assert.equal(exporter.spans.length, 1);
        assert.equal(exporter.spans[0]!.status, SpanStatus.ERROR);
        assert.equal(exporter.spans[0]!.errorMessage, "kaboom-async");
    });

    it("currentSpan / currentTraceId are null outside any span", () => {
        assert.equal(currentSpan(), null);
        assert.equal(currentTraceId(), null);
    });
});

describe("JsonlSpanExporter", () => {
    it("writes one JSON object per line", async () => {
        const dir = mkdtempSync(join(tmpdir(), "claw-tracing-"));
        cleanupDirs.push(dir);
        const out = join(dir, "spans.jsonl");

        setDefaultProcessor(new BatchTraceProcessor(
            new JsonlSpanExporter(out),
            { flushIntervalMs: 50 },
        ));

        await agentSpan("root", async () => {
            await turnSpan(() => {});
            await turnSpan(() => {});
        });
        await flushTraces(2000);

        const lines = readFileSync(out, "utf8").split("\n").filter(l => l.trim());
        assert.equal(lines.length, 3);
        const parsed = lines.map(l => JSON.parse(l));
        assert.ok(parsed.every(p => "trace_id" in p));
        // All three share a trace_id
        const ids = new Set(parsed.map(p => p.trace_id));
        assert.equal(ids.size, 1);
    });
});

describe("FanOut via addTraceProcessor", () => {
    it("delivers each span to both processors", async () => {
        const a = new CollectExporter();
        const b = new CollectExporter();
        setDefaultProcessor(new BatchTraceProcessor(a, { flushIntervalMs: 50 }));
        addTraceProcessor(new BatchTraceProcessor(b, { flushIntervalMs: 50 }));

        await customSpan("x", () => {});
        await flushTraces(2000);

        assert.equal(a.spans.length, 1);
        assert.equal(b.spans.length, 1);
        assert.equal(a.spans[0]!.name, "x");
        assert.equal(b.spans[0]!.name, "x");
    });
});
