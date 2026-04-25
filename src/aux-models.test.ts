/**
 * Tests for clawagents/aux-models.ts.
 *
 * Mirrors `clawagents_py/tests/test_aux_models.py`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    AuxModelRegistry,
    AuxModelTask,
    coerceAuxSpec,
    withOverrides,
    type AuxModelSpec,
} from "./aux-models.js";

describe("coerceAuxSpec", () => {
    it("promotes a bare model id", () => {
        assert.deepEqual(coerceAuxSpec("gpt-5.4-mini"), { model: "gpt-5.4-mini" });
    });

    it("splits model@base_url shorthand", () => {
        assert.deepEqual(coerceAuxSpec("llama3.2:3b@http://localhost:11434"), {
            model: "llama3.2:3b",
            baseUrl: "http://localhost:11434",
        });
    });

    it("passes existing AuxModelSpec through", () => {
        const src: AuxModelSpec = { model: "gpt-5.4" };
        assert.equal(coerceAuxSpec(src), src);
    });

    it("rejects empty/whitespace strings", () => {
        assert.throws(() => coerceAuxSpec(""));
        assert.throws(() => coerceAuxSpec("   "));
    });
});

describe("withOverrides", () => {
    it("returns a new spec without mutating the input", () => {
        const spec: AuxModelSpec = { model: "gpt-5.4" };
        const out = withOverrides(spec, { maxTokens: 20, temperature: 0 });
        assert.notEqual(out, spec);
        assert.equal(out.model, "gpt-5.4");
        assert.equal(out.maxTokens, 20);
        assert.equal(out.temperature, 0);
        assert.equal(spec.maxTokens, undefined);
    });
});

describe("AuxModelRegistry", () => {
    it("returns the primary spec via get(Primary) and primary()", () => {
        const reg = new AuxModelRegistry("gpt-5.4");
        assert.equal(reg.primary().model, "gpt-5.4");
        assert.equal(reg.get(AuxModelTask.Primary).model, "gpt-5.4");
    });

    it("falls back to primary when no aux binding is set", () => {
        const reg = new AuxModelRegistry("gpt-5.4");
        const spec = reg.get(AuxModelTask.Compression);
        assert.equal(spec.model, "gpt-5.4");
        assert.equal(reg.has(AuxModelTask.Compression), false);
    });

    it("set() and get() work for aux tasks", () => {
        const reg = new AuxModelRegistry("gpt-5.4");
        reg.set(AuxModelTask.Compression, "gpt-5.4-mini");
        assert.equal(reg.get(AuxModelTask.Compression).model, "gpt-5.4-mini");
        assert.equal(reg.has(AuxModelTask.Compression), true);
        // Title still falls back.
        assert.equal(reg.get(AuxModelTask.Title).model, "gpt-5.4");
    });

    it("set() accepts a full AuxModelSpec object", () => {
        const reg = new AuxModelRegistry("gpt-5.4");
        reg.set(AuxModelTask.Title, { model: "gpt-5.4-mini", maxTokens: 20 });
        const spec = reg.get(AuxModelTask.Title);
        assert.equal(spec.model, "gpt-5.4-mini");
        assert.equal(spec.maxTokens, 20);
    });

    it("set() overwrites existing bindings", () => {
        const reg = new AuxModelRegistry("gpt-5.4");
        reg.set(AuxModelTask.Compression, "a");
        reg.set(AuxModelTask.Compression, "b");
        assert.equal(reg.get(AuxModelTask.Compression).model, "b");
    });

    it("unset() removes bindings and re-enables fallback", () => {
        const reg = new AuxModelRegistry("gpt-5.4");
        reg.set(AuxModelTask.Compression, "gpt-5.4-mini");
        reg.unset(AuxModelTask.Compression);
        assert.equal(reg.has(AuxModelTask.Compression), false);
        assert.equal(reg.get(AuxModelTask.Compression).model, "gpt-5.4");
    });

    it("unset(Primary) throws", () => {
        const reg = new AuxModelRegistry("gpt-5.4");
        assert.throws(() => reg.unset(AuxModelTask.Primary));
    });

    it("accepts custom string task ids", () => {
        const reg = new AuxModelRegistry("gpt-5.4");
        reg.set("embedding", "text-embedding-3-large");
        assert.equal(reg.has("embedding"), true);
        assert.equal(reg.get("embedding").model, "text-embedding-3-large");
        assert.equal(reg.get("not-set").model, "gpt-5.4");
    });

    it("slots() returns a copy that does not affect the registry when mutated", () => {
        const reg = new AuxModelRegistry("gpt-5.4");
        reg.set(AuxModelTask.Compression, "gpt-5.4-mini");
        const snap = reg.slots();
        delete snap[AuxModelTask.Compression];
        assert.equal(reg.has(AuxModelTask.Compression), true);
    });
});

describe("AuxModelRegistry.fromEnv", () => {
    it("pulls known aux vars from a custom env dict", () => {
        const env = {
            CLAW_MODEL_COMPRESSION: "gpt-5.4-mini",
            CLAW_MODEL_TITLE: "claude-4.5-haiku@http://h",
            CLAW_MODEL_VISION: "gemini-3.1-pro",
            CLAW_MODEL_JUDGE: "  ", // blank → ignored
            UNRELATED: "ignored",
        };
        const reg = AuxModelRegistry.fromEnv("gpt-5.4", env);
        assert.equal(reg.get(AuxModelTask.Compression).model, "gpt-5.4-mini");
        const title = reg.get(AuxModelTask.Title);
        assert.equal(title.model, "claude-4.5-haiku");
        assert.equal(title.baseUrl, "http://h");
        assert.equal(reg.get(AuxModelTask.Vision).model, "gemini-3.1-pro");
        // Judge was blank → falls back to primary.
        assert.equal(reg.has(AuxModelTask.Judge), false);
        assert.equal(reg.get(AuxModelTask.Judge).model, "gpt-5.4");
    });

    it("defaults to process.env when no env dict is provided", () => {
        const saved = process.env.CLAW_MODEL_COMPRESSION;
        try {
            process.env.CLAW_MODEL_COMPRESSION = "gpt-5.4-mini";
            delete process.env.CLAW_MODEL_TITLE;
            delete process.env.CLAW_MODEL_VISION;
            delete process.env.CLAW_MODEL_JUDGE;
            const reg = AuxModelRegistry.fromEnv("gpt-5.4");
            assert.equal(reg.get(AuxModelTask.Compression).model, "gpt-5.4-mini");
            assert.equal(reg.get(AuxModelTask.Title).model, "gpt-5.4");
        } finally {
            if (saved === undefined) delete process.env.CLAW_MODEL_COMPRESSION;
            else process.env.CLAW_MODEL_COMPRESSION = saved;
        }
    });

    it("preserves a complex AuxModelSpec primary by reference", () => {
        const primary: AuxModelSpec = { model: "gpt-5.4", baseUrl: "http://gw" };
        const reg = AuxModelRegistry.fromEnv(primary, {});
        assert.equal(reg.primary(), primary);
        assert.equal(reg.get(AuxModelTask.Compression), primary);
    });
});
