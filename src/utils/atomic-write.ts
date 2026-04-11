/**
 * Atomic file write utility.
 *
 * Writes content to a temporary file first, then renames it to the target
 * path. This ensures that readers never see a partially-written file —
 * either the old content or the new complete content, never a mix.
 *
 * Uses only Node.js stdlib (fs) — no extra dependencies.
 */

import { writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Atomically write `content` to `filePath`.
 *
 * Steps:
 *   1. Write to `<filePath>.tmp.<random>`
 *   2. `rename()` the temp file onto the target path (atomic on POSIX)
 *
 * @param filePath - Destination file path (created if it does not exist).
 * @param content  - Content to write (string or Buffer).
 * @param encoding - File encoding when `content` is a string (default: "utf-8").
 */
export function atomicWriteFileSync(
    filePath: string,
    content: string | Buffer,
    encoding: BufferEncoding = "utf-8",
): void {
    const absPath = resolve(filePath);
    const dir = dirname(absPath);

    // Ensure the directory exists
    mkdirSync(dir, { recursive: true });

    const suffix = randomBytes(6).toString("hex");
    const tmpPath = `${absPath}.tmp.${suffix}`;

    try {
        if (typeof content === "string") {
            writeFileSync(tmpPath, content, encoding);
        } else {
            writeFileSync(tmpPath, content);
        }
        renameSync(tmpPath, absPath);
    } catch (err) {
        // Best-effort cleanup of the temp file on error
        try { unlinkSync(tmpPath); } catch { /* ignore cleanup failures */ }
        throw err;
    }
}
