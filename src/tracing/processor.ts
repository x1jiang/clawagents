/**
 * TracingProcessor / TracingExporter — extension surface for tracing.
 *
 * Mirrors `clawagents_py/src/clawagents/tracing/processor.py`.
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Span } from "./span.js";

// ─── Exporter ABC ────────────────────────────────────────────────────────

export abstract class TracingExporter {
    abstract export(spans: Span[]): void | Promise<void>;
    shutdown(): void | Promise<void> {
        // default: noop
    }
}

export class NoopSpanExporter extends TracingExporter {
    export(_spans: Span[]): void {
        return;
    }
}

export class ConsoleSpanExporter extends TracingExporter {
    constructor(private readonly stream: NodeJS.WriteStream = process.stderr) {
        super();
    }

    export(spans: Span[]): void {
        for (const s of spans) {
            try {
                this.stream.write(this.format(s) + "\n");
            } catch {
                // swallow
            }
        }
    }

    private format(s: Span): string {
        const dur = s.durationS == null ? "open" : `${(s.durationS * 1000).toFixed(1)}ms`;
        const trace8 = s.traceId.slice(-8);
        let attrs = "";
        if (Object.keys(s.attributes).length) {
            const kv = Object.entries(s.attributes)
                .slice(0, 4)
                .map(([k, v]) => {
                    let r: string;
                    try { r = typeof v === "string" ? `'${v}'` : JSON.stringify(v); }
                    catch { r = String(v); }
                    return `${k}=${r}`;
                })
                .join(",");
            attrs = ` [${kv}]`;
        }
        const err = s.errorMessage ? ` error='${s.errorMessage}'` : "";
        return `[trace ${trace8}] ${s.kind}:${s.name} (${dur})${attrs}${err}`;
    }
}

export class JsonlSpanExporter extends TracingExporter {
    constructor(private readonly path: string) {
        super();
        const dir = dirname(this.path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    export(spans: Span[]): void {
        if (!spans.length) return;
        let payload: string;
        try {
            payload = spans.map(s => JSON.stringify(s.toDict())).join("\n") + "\n";
        } catch {
            return;
        }
        try {
            appendFileSync(this.path, payload, "utf8");
        } catch {
            // swallow — exporter must not crash the agent
        }
    }
}

// ─── Processor ABC ───────────────────────────────────────────────────────

export abstract class TracingProcessor {
    abstract onSpanEnd(span: Span): void;
    forceFlush(_timeoutMs: number = 5000): Promise<void> | void {
        return;
    }
    shutdown(): Promise<void> | void {
        return;
    }
}

export class BatchTraceProcessor extends TracingProcessor {
    private buffer: Span[] = [];
    private exporters: TracingExporter[];
    private stopped = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private inFlight = false;

    constructor(
        exporters: TracingExporter | TracingExporter[] | null = null,
        opts: { maxBatch?: number; flushIntervalMs?: number } = {},
    ) {
        super();
        if (exporters == null) this.exporters = [new NoopSpanExporter()];
        else if (Array.isArray(exporters)) this.exporters = [...exporters];
        else this.exporters = [exporters];

        const maxBatch = opts.maxBatch ?? 64;
        const flushMs = opts.flushIntervalMs ?? 1000;
        this.maxBatch = maxBatch;
        this.flushIntervalMs = flushMs;

        // Periodic background flush. unref() so it doesn't keep the process alive.
        this.timer = setInterval(() => this.flushNow(), this.flushIntervalMs);
        if (typeof this.timer.unref === "function") this.timer.unref();
    }

    private readonly maxBatch: number;
    private readonly flushIntervalMs: number;

    addExporter(exporter: TracingExporter): void {
        this.exporters.push(exporter);
    }

    onSpanEnd(span: Span): void {
        if (this.stopped) return;
        this.buffer.push(span);
        if (this.buffer.length >= this.maxBatch) this.flushNow();
    }

    private flushNow(): void {
        if (this.inFlight || !this.buffer.length) return;
        const batch = this.buffer;
        this.buffer = [];
        this.inFlight = true;
        try {
            for (const exporter of this.exporters) {
                try {
                    const r = exporter.export(batch);
                    if (r instanceof Promise) {
                        // best-effort: don't await, but swallow rejections
                        r.catch(() => {});
                    }
                } catch {
                    // swallow
                }
            }
        } finally {
            this.inFlight = false;
        }
    }

    async forceFlush(_timeoutMs: number = 5000): Promise<void> {
        this.flushNow();
        // Yield once so any microtasks (Promise rejections) settle.
        await new Promise<void>(r => setImmediate(r));
    }

    async shutdown(): Promise<void> {
        this.stopped = true;
        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        await this.forceFlush();
        for (const exporter of this.exporters) {
            try {
                const r = exporter.shutdown();
                if (r instanceof Promise) await r;
            } catch {
                // swallow
            }
        }
    }
}

class FanOutProcessor extends TracingProcessor {
    constructor(private readonly processors: TracingProcessor[]) { super(); }

    onSpanEnd(span: Span): void {
        for (const p of this.processors) {
            try { p.onSpanEnd(span); } catch { /* swallow */ }
        }
    }

    async forceFlush(timeoutMs: number = 5000): Promise<void> {
        await Promise.all(this.processors.map(p => Promise.resolve(p.forceFlush(timeoutMs)).catch(() => {})));
    }

    async shutdown(): Promise<void> {
        await Promise.all(this.processors.map(p => Promise.resolve(p.shutdown()).catch(() => {})));
    }
}

// ─── Module-level default processor ─────────────────────────────────────

let _defaultProcessor: TracingProcessor = new BatchTraceProcessor(new NoopSpanExporter());

export function setDefaultProcessor(processor: TracingProcessor): void {
    const old = _defaultProcessor;
    _defaultProcessor = processor;
    try {
        const r = old.shutdown();
        if (r instanceof Promise) r.catch(() => {});
    } catch {
        // swallow
    }
}

export function getDefaultProcessor(): TracingProcessor {
    return _defaultProcessor;
}

export function addTraceProcessor(processor: TracingProcessor): void {
    const existing = _defaultProcessor;
    _defaultProcessor = new FanOutProcessor([existing, processor]);
}

export async function flushTraces(timeoutMs: number = 5000): Promise<void> {
    await Promise.resolve(_defaultProcessor.forceFlush(timeoutMs));
}

export async function shutdownTracing(): Promise<void> {
    try { await Promise.resolve(_defaultProcessor.forceFlush(5000)); } catch { /* swallow */ }
    try { await Promise.resolve(_defaultProcessor.shutdown()); } catch { /* swallow */ }
}
