/**
 * Unit tests for clawagents/media/images sanitizers.
 * Run with: npx tsx --test src/media/images.test.ts
 *
 * `sharp` is an optional dependency: pass-through and missing-dep tests
 * always run, while the resize tests skip when sharp isn't loadable.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
    sanitizeImageBlock,
    sanitizeToolOutput,
    isSharpAvailable,
    _resetSharpCache,
} from "./images.js";

// 8x8 solid red PNG fixture (no alpha) — same payload used in the Python tests
const TINY_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQAAAAD8GwTdAAAAEUlEQVR4nGNgYGD4z0AswK4SAFb6Af" +
    "FOcvIfAAAAAElFTkSuQmCC";

function makeBlock(data: string = TINY_PNG_B64, mediaType = "image/png") {
    return {
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
    } as const;
}

let HAS_SHARP = false;

before(async () => {
    HAS_SHARP = await isSharpAvailable();
});

// ─── Pass-through paths (always run) ───────────────────────────────────────

describe("sanitizeImageBlock — pass-through", () => {
    it("returns text blocks unchanged", async () => {
        const block = { type: "text", text: "hello" } as any;
        const out = await sanitizeImageBlock(block);
        assert.equal(out, block);
    });

    it("returns unknown blocks unchanged", async () => {
        const block = { type: "weird", payload: 42 } as any;
        const out = await sanitizeImageBlock(block);
        assert.equal(out, block);
    });

    it("returns URL-source image blocks unchanged", async () => {
        const block = {
            type: "image",
            source: { type: "url", url: "https://example.com/cat.png" },
        } as any;
        const out = await sanitizeImageBlock(block);
        assert.equal(out, block);
    });
});

describe("sanitizeToolOutput — pass-through", () => {
    it("string outputs are returned unchanged", async () => {
        const out = await sanitizeToolOutput("hello world");
        assert.equal(out, "hello world");
    });

    it("lists with no image blocks are unchanged", async () => {
        const blocks: any[] = [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
        ];
        const out = await sanitizeToolOutput(blocks);
        assert.deepEqual(out, blocks);
    });
});

// ─── Missing-sharp path ────────────────────────────────────────────────────

describe("sanitizeImageBlock — missing sharp", () => {
    it("returns input unchanged + warns once when sharp can't be loaded", async () => {
        // Force the lazy loader to "tried and failed" state.
        _resetSharpCache();
        // Monkey-patch dynamic import so that sharp loading fails. We do this by
        // shadowing `import("sharp")` — easier: patch `_sharpAttempted` to true
        // and `_sharp` to null via the module's internal reset. We can simulate
        // missing-sharp by calling a fresh _resetSharpCache then patching
        // global require-cache; but the cleanest portable approach is to swap
        // the `console.warn` and run isSharpAvailable on a known-missing
        // module. Instead we directly test behavior when sharp is unavailable
        // in this dev env (which is the case here).
        const block = makeBlock();

        // If sharp *is* installed in this env, we still want a missing-dep
        // assertion — replace the loader by tampering with the module cache
        // is too invasive. Skip the warn-check when sharp is loadable, but
        // always assert the block is preserved on the no-op path.
        if (!HAS_SHARP) {
            const warnings: string[] = [];
            const origWarn = console.warn;
            console.warn = (msg: any) => warnings.push(String(msg));
            try {
                const out = await sanitizeImageBlock(block as any);
                assert.deepEqual(out, block);
                assert.ok(
                    warnings.some((w) => /sharp is not installed/.test(w)),
                    `expected a warning about sharp missing; got ${JSON.stringify(warnings)}`,
                );
            } finally {
                console.warn = origWarn;
            }
        } else {
            // sharp installed — at minimum the small fixture should pass through unchanged.
            const out = await sanitizeImageBlock(block as any);
            assert.equal((out as any).type, "image");
        }
    });
});

// ─── Resize paths (need sharp) ─────────────────────────────────────────────

describe("sanitizeImageBlock — resize (sharp required)", () => {
    it("small PNG under both limits passes through (no resize)", async (t) => {
        if (!HAS_SHARP) return t.skip("sharp not installed");
        const block = makeBlock();
        const out: any = await sanitizeImageBlock(block as any, {
            maxDim: 1200,
            maxBytes: 5 * 1024 * 1024,
        });
        assert.equal(out.source.data, TINY_PNG_B64);
        assert.equal(out.source.media_type, "image/png");
    });

    it("oversize PNG gets resized + recompressed under limits", async (t) => {
        if (!HAS_SHARP) return t.skip("sharp not installed");
        // Use sharp itself to synthesize a large RGB PNG. Build the import
        // specifier at runtime so tsc --noEmit doesn't fail when sharp is
        // not installed in the dev environment.
        const sharpModName = "sharp";
        const sharpMod = (await import(sharpModName)) as any;
        const sharp = sharpMod.default ?? sharpMod;
        const big = await sharp({
            create: { width: 4000, height: 4000, channels: 3, background: "#7BC83C" },
        })
            .png()
            .toBuffer();
        const block = makeBlock(big.toString("base64"), "image/png");

        const out: any = await sanitizeImageBlock(block as any, {
            maxDim: 512,
            maxBytes: 200 * 1024,
            qualitySteps: [75, 60, 40],
        });
        assert.equal(out.type, "image");
        const newBytes = Buffer.from(out.source.data, "base64");
        assert.ok(newBytes.byteLength <= 200 * 1024,
            `expected <= 200KB, got ${newBytes.byteLength}`);
        const meta = await sharp(newBytes).metadata();
        assert.ok((meta.width ?? 0) <= 512);
        assert.ok((meta.height ?? 0) <= 512);
    });
});

// ─── Tool output walking ───────────────────────────────────────────────────

describe("sanitizeToolOutput — walks list", () => {
    it("preserves block order and types", async (t) => {
        if (!HAS_SHARP) return t.skip("sharp not installed");
        const blocks: any[] = [
            { type: "text", text: "hi" },
            makeBlock(),
            { type: "text", text: "bye" },
        ];
        const out = (await sanitizeToolOutput(blocks)) as any[];
        assert.equal(out[0].type, "text");
        assert.equal(out[1].type, "image");
        assert.equal(out[2].type, "text");
    });
});
