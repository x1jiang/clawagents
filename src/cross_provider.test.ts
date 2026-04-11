/**
 * Cross-provider conformance test suite.
 *
 * Shared tests that all SandboxBackend implementations must pass.
 * Mirrors: clawagents_py/tests/test_cross_provider.py
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { LocalBackend } from "./sandbox/local.js";
import { InMemoryBackend } from "./sandbox/memory.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SandboxBackend } from "./sandbox/backend.js";

// ─── Shared conformance tests ───────────────────────────────────────────────

function conformanceSuite(name: string, factory: () => SandboxBackend) {
    describe(`${name} conformance`, () => {
        let backend: SandboxBackend;

        beforeEach(() => {
            backend = factory();
        });

        it("write and read file", async () => {
            const path = backend.resolve("test.txt");
            await backend.writeFile(path, "hello");
            const content = await backend.readFile(path, "utf-8");
            expect(content).toBe("hello");
        });

        it("mkdir and readDir", async () => {
            const subdir = backend.resolve("subdir");
            await backend.mkdir(subdir);
            const entries = await backend.readDir(backend.cwd);
            expect(entries.some((e) => e.name === "subdir")).toBe(true);
        });

        it("overwrite file", async () => {
            const path = backend.resolve("overwrite.txt");
            await backend.writeFile(path, "first");
            await backend.writeFile(path, "second");
            const content = await backend.readFile(path, "utf-8");
            expect(content).toBe("second");
        });

        it("exists returns false then true", async () => {
            const path = backend.resolve("exists.txt");
            expect(await backend.exists(path)).toBe(false);
            await backend.writeFile(path, "data");
            expect(await backend.exists(path)).toBe(true);
        });

        it("stat returns correct info", async () => {
            const path = backend.resolve("stat.txt");
            await backend.writeFile(path, "content");
            const info = await backend.stat(path);
            expect(info.isFile).toBe(true);
            expect(info.isDirectory).toBe(false);
            expect(info.size).toBeGreaterThan(0);
        });

        it("read missing file throws", async () => {
            const path = backend.resolve("no_such_file.txt");
            await expect(backend.readFile(path, "utf-8")).rejects.toThrow();
        });

        it("readFileBytes returns Buffer", async () => {
            const path = backend.resolve("bytes.bin");
            await backend.writeFile(path, "binary-ish");
            const data = await backend.readFileBytes(path);
            expect(data).toBeInstanceOf(Buffer);
            expect(data.length).toBeGreaterThan(0);
        });

        it("resolve produces absolute paths", () => {
            const resolved = backend.resolve("foo", "bar.txt");
            expect(resolved.startsWith("/")).toBe(true);
        });

        it("safePath blocks traversal", () => {
            expect(() => backend.safePath("../../etc/passwd")).toThrow();
        });

        it("mkdir recursive creates nested dirs", async () => {
            const deep = backend.resolve("a", "b", "c");
            await backend.mkdir(deep, true);
            expect(await backend.exists(deep)).toBe(true);
        });

        it("stat on directory", async () => {
            const dir = backend.resolve("statdir");
            await backend.mkdir(dir);
            const info = await backend.stat(dir);
            expect(info.isDirectory).toBe(true);
            expect(info.isFile).toBe(false);
        });
    });
}

// ─── Run suite for each backend ─────────────────────────────────────────────

conformanceSuite("LocalBackend", () => {
    const root = mkdtempSync(join(tmpdir(), "claw-conform-"));
    return new LocalBackend(root);
});

conformanceSuite("InMemoryBackend", () => {
    return new InMemoryBackend("/test-project");
});
