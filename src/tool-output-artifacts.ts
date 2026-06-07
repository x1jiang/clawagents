/** Offload large tool outputs to artifact files (OpenHarness 0.1.9 pattern). */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

export const DEFAULT_INLINE_CHARS = 12_000;
export const DEFAULT_PREVIEW_CHARS = 2_000;

function safeName(toolName: string): string {
    const cleaned = toolName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
    return cleaned || "tool";
}

export function toolArtifactDir(workspace?: string): string {
    const root = resolve(workspace ?? process.cwd(), ".clawagents", "tool-artifacts");
    mkdirSync(root, { recursive: true });
    return root;
}

function timestamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function offloadToolOutputIfNeeded(opts: {
    toolName: string;
    toolUseId: string;
    output: string;
    workspace?: string;
    inlineLimit?: number;
    previewChars?: number;
}): [inline: string, artifactPath: string | null] {
    const inlineLimit = opts.inlineLimit ?? DEFAULT_INLINE_CHARS;
    const previewChars = opts.previewChars ?? DEFAULT_PREVIEW_CHARS;

    if (opts.output.length <= inlineLimit) {
        return [opts.output, null];
    }

    const artifactPath = resolve(
        toolArtifactDir(opts.workspace),
        `${timestamp()}-${safeName(opts.toolName)}-${randomBytes(6).toString("hex")}.txt`,
    );
    writeFileSync(artifactPath, opts.output, "utf-8");

    const preview = opts.output.slice(0, previewChars);
    const omitted = Math.max(0, opts.output.length - preview.length);
    let inline =
        "[Tool output truncated]\n" +
        `Tool: ${opts.toolName}\n` +
        `Tool use id: ${opts.toolUseId}\n` +
        `Original size: ${opts.output.length} chars\n` +
        `Full output saved to: ${artifactPath}\n` +
        `Inline preview: first ${preview.length} chars`;
    if (omitted > 0) inline += ` (${omitted} chars omitted)`;
    if (preview) inline += `\n\nPreview:\n${preview}`;

    return [inline, artifactPath];
}
