/**
 * Image sanitization for tool-result content blocks.
 *
 * Anthropic's Messages API rejects images > 5MB and tends to fail on images
 * much larger than ~2000px on a side. Tools that surface remote images,
 * screen captures, or large file attachments can blow past those limits and
 * silently break the conversation. This module clamps base64 image blocks
 * down to safe limits via `sharp` (loaded lazily as an optional dependency).
 *
 * Sharp is optional: if it isn't installed, the sanitizers return the input
 * unchanged after emitting a one-time warning. URL-source images and
 * non-image blocks always pass through untouched.
 */

// We do *not* statically import sharp — it's an optionalDependencies entry,
// and we want this module to load cleanly even when sharp isn't installed
// (e.g. in CI environments without native bindings).

export const DEFAULT_MAX_DIM = 1200;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_QUALITY_STEPS: readonly number[] = [90, 75, 60];
const DROPPED_TEXT = "[image too large after sanitization, dropped]";

// ─── Sharp loader (lazy) ───────────────────────────────────────────────────

type SharpFactory = (input?: Buffer) => any;
let _sharpAttempted = false;
let _sharp: SharpFactory | null = null;
let _warnedNoSharp = false;

async function loadSharp(): Promise<SharpFactory | null> {
    if (_sharpAttempted) return _sharp;
    _sharpAttempted = true;
    try {
        // sharp is in `optionalDependencies`. The dynamic-import name is built
        // at runtime so `tsc --noEmit` doesn't try to resolve a missing module
        // when sharp isn't installed in dev/CI environments.
        const moduleName = "sharp";
        const mod = (await import(moduleName)) as { default?: SharpFactory } & SharpFactory;
        _sharp = mod.default ?? mod;
    } catch {
        _sharp = null;
    }
    return _sharp;
}

function warnMissingSharpOnce(): void {
    if (_warnedNoSharp) return;
    _warnedNoSharp = true;
    // eslint-disable-next-line no-console
    console.warn(
        "[clawagents/media] sharp is not installed — image sanitization is a no-op. " +
        "Install with `npm install sharp` to enable resize/recompress.",
    );
}

/**
 * @internal Test hook — reset the sharp loader's memoized state. Production
 * callers should not need this.
 */
export function _resetSharpCache(): void {
    _sharpAttempted = false;
    _sharp = null;
    _warnedNoSharp = false;
}

export async function isSharpAvailable(): Promise<boolean> {
    const s = await loadSharp();
    return s !== null;
}

// ─── Block helpers ─────────────────────────────────────────────────────────

export type ContentBlock = Record<string, unknown> & { type: string };

export interface ImageBlockBase64Source {
    type: "base64";
    media_type?: string;
    data: string;
}

export interface ImageBlockUrlSource {
    type: "url";
    url: string;
}

export interface ImageBlock extends ContentBlock {
    type: "image";
    source: ImageBlockBase64Source | ImageBlockUrlSource | Record<string, unknown>;
}

export interface SanitizeOptions {
    maxDim?: number;
    maxBytes?: number;
    qualitySteps?: readonly number[];
}

function isImageBlock(block: unknown): block is ImageBlock {
    if (!block || typeof block !== "object") return false;
    const rec = block as Record<string, unknown>;
    if (rec["type"] !== "image") return false;
    const src = rec["source"];
    return Boolean(src && typeof src === "object");
}

function decodeB64(data: string): Buffer {
    let payload = data;
    if (payload.startsWith("data:") && payload.includes(",")) {
        payload = payload.slice(payload.indexOf(",") + 1);
    }
    return Buffer.from(payload, "base64");
}

// ─── Resize/compress core ──────────────────────────────────────────────────

async function resizeAndCompress(
    raw: Buffer,
    sharp: SharpFactory,
    opts: { maxDim: number; maxBytes: number; qualitySteps: readonly number[]; mediaType: string },
): Promise<{ data: Buffer; mediaType: string } | null> {
    let meta: { width?: number; height?: number; hasAlpha?: boolean; format?: string };
    try {
        meta = await sharp(raw).metadata();
    } catch {
        return null;
    }

    const isPng = (meta.format ?? "").toLowerCase() === "png" && meta.hasAlpha === true;
    const targetFormat: "png" | "jpeg" = isPng ? "png" : "jpeg";

    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    const longest = Math.max(w, h);
    const needsResize = longest > opts.maxDim;

    const baseImg = needsResize
        ? sharp(raw).resize({
              width: w >= h ? opts.maxDim : undefined,
              height: h > w ? opts.maxDim : undefined,
              fit: "inside",
              withoutEnlargement: true,
          })
        : sharp(raw);

    if (targetFormat === "png") {
        try {
            const out = await baseImg.clone().png({ compressionLevel: 9, palette: true }).toBuffer();
            if (out.byteLength <= opts.maxBytes) {
                return { data: out, mediaType: "image/png" };
            }
        } catch {
            // fall through to JPEG
        }
        // PNG didn't fit — fall back to JPEG (drops alpha).
        for (const q of opts.qualitySteps) {
            try {
                const out = await baseImg
                    .clone()
                    .flatten({ background: "#ffffff" })
                    .jpeg({ quality: q, mozjpeg: true })
                    .toBuffer();
                if (out.byteLength <= opts.maxBytes) {
                    return { data: out, mediaType: "image/jpeg" };
                }
            } catch {
                continue;
            }
        }
        return null;
    }

    // JPEG path — walk down quality steps.
    for (const q of opts.qualitySteps) {
        try {
            const out = await baseImg.clone().jpeg({ quality: q, mozjpeg: true }).toBuffer();
            if (out.byteLength <= opts.maxBytes) {
                return { data: out, mediaType: "image/jpeg" };
            }
        } catch {
            continue;
        }
    }
    return null;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Sanitize a single Anthropic-style image content block.
 *
 * - base64 source: decode → if bytes or any side exceeds limits, resize the
 *   longest side down to `maxDim` and recompress (JPEG, or PNG when the
 *   input is a PNG with alpha) walking through `qualitySteps`. If even the
 *   smallest quality step doesn't fit `maxBytes`, the block is replaced
 *   with a text block explaining the drop.
 * - URL source: passes through unchanged (we don't refetch).
 * - Non-image blocks: pass through unchanged.
 *
 * Never throws on malformed input — it returns a text fallback block so the
 * conversation can still progress.
 */
export async function sanitizeImageBlock(
    block: ContentBlock,
    opts: SanitizeOptions = {},
): Promise<ContentBlock> {
    if (!isImageBlock(block)) return block;

    const source = (block.source ?? {}) as Record<string, unknown>;
    const srcType = source["type"];
    if (srcType !== "base64") {
        return block; // URL or unknown — leave it alone.
    }

    const sharp = await loadSharp();
    if (!sharp) {
        warnMissingSharpOnce();
        return block;
    }

    const data = source["data"];
    const mediaType = (source["media_type"] as string | undefined) ?? "image/jpeg";
    if (typeof data !== "string" || data.length === 0) {
        return block;
    }

    let raw: Buffer;
    try {
        raw = decodeB64(data);
    } catch {
        return { type: "text", text: "[image source data was not valid base64, dropped]" };
    }

    const maxDim = opts.maxDim ?? DEFAULT_MAX_DIM;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const qualitySteps = opts.qualitySteps ?? DEFAULT_QUALITY_STEPS;

    let needsWork = raw.byteLength > maxBytes;
    if (!needsWork) {
        try {
            const meta = await sharp(raw).metadata();
            if ((meta.width ?? 0) > maxDim || (meta.height ?? 0) > maxDim) {
                needsWork = true;
            }
        } catch {
            return block;
        }
    }
    if (!needsWork) return block;

    const result = await resizeAndCompress(raw, sharp, {
        maxDim,
        maxBytes,
        qualitySteps,
        mediaType,
    });
    if (!result) {
        return { type: "text", text: DROPPED_TEXT };
    }

    return {
        ...block,
        source: {
            type: "base64",
            media_type: result.mediaType,
            data: result.data.toString("base64"),
        },
    };
}

/**
 * Sanitize a tool result (transcript string or list of content blocks).
 *
 * Strings pass through unchanged (no images possible). Lists are walked
 * block-by-block; image blocks go through {@link sanitizeImageBlock},
 * everything else is preserved verbatim.
 */
export async function sanitizeToolOutput(
    output: ContentBlock[] | string,
    opts: SanitizeOptions = {},
): Promise<ContentBlock[] | string> {
    if (typeof output === "string") return output;
    if (!Array.isArray(output)) return output;
    const out: ContentBlock[] = [];
    for (const b of output) {
        if (isImageBlock(b)) {
            out.push(await sanitizeImageBlock(b, opts));
        } else {
            out.push(b);
        }
    }
    return out;
}
