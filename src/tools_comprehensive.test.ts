/**
 * Comprehensive tests for ClawAgents TypeScript tool implementations.
 *
 * Exercises actual tool execution on real filesystem with temp directories:
 *   - ls: metadata, empty dirs, missing paths
 *   - read_file: pagination, missing files
 *   - write_file: create, overwrite, nested dirs
 *   - edit_file: replace, replace_all, missing target
 *   - grep: single file, recursive, glob filter
 *   - glob: recursive, no matches
 *   - todolist: write, update, edge cases
 *   - memory loader: loading, missing files, tags
 *
 * Run with: npx tsx --test src/tools_comprehensive.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── ls ──────────────────────────────────────────────────────────────────

describe("lsTool", () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), "claw-test-"));
        mkdirSync(join(tmp, "subdir"));
        writeFileSync(join(tmp, "file_a.txt"), "hello");
        writeFileSync(join(tmp, "file_b.py"), "x".repeat(500));
    });

    afterEach(() => rmSync(tmp, { recursive: true }));

    it("shows metadata", async () => {
        const { lsTool } = await import("./tools/filesystem.js");
        const result = await lsTool.execute({ path: tmp });
        assert.equal(result.success, true);
        assert.ok(result.output.includes("[DIR]"));
        assert.ok(result.output.includes("subdir"));
        assert.ok(result.output.includes("[FILE]"));
        assert.ok(result.output.includes("file_a.txt"));
    });

    it("dirs appear first", async () => {
        const { lsTool } = await import("./tools/filesystem.js");
        const result = await lsTool.execute({ path: tmp });
        const lines = (result.output as string).split("\n");
        assert.ok(lines[0].includes("[DIR]"));
    });

    it("handles empty directory", async () => {
        const { lsTool } = await import("./tools/filesystem.js");
        const result = await lsTool.execute({ path: join(tmp, "subdir") });
        assert.equal(result.success, true);
        assert.ok(result.output.includes("(empty directory)"));
    });

    it("fails for nonexistent path", async () => {
        const { lsTool } = await import("./tools/filesystem.js");
        const result = await lsTool.execute({ path: "/nonexistent/path" });
        assert.equal(result.success, false);
    });
});

// ─── read_file ───────────────────────────────────────────────────────────

describe("readFileTool", () => {
    let tmp: string;
    let filePath: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), "claw-test-"));
        filePath = join(tmp, "test.txt");
        const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: content`);
        writeFileSync(filePath, lines.join("\n"));
    });

    afterEach(() => rmSync(tmp, { recursive: true }));

    it("reads file with line numbers", async () => {
        const { readFileTool } = await import("./tools/filesystem.js");
        const result = await readFileTool.execute({ path: filePath });
        assert.equal(result.success, true);
        assert.ok(result.output.includes("Line 1"));
        assert.ok(result.output.includes("50 lines total"));
    });

    it("supports pagination", async () => {
        const { readFileTool } = await import("./tools/filesystem.js");
        const result = await readFileTool.execute({ path: filePath, offset: 10, limit: 5 });
        assert.equal(result.success, true);
        assert.ok(result.output.includes("Line 11"));
        assert.ok(result.output.includes("showing 11-15"));
    });

    it("fails for missing file", async () => {
        const { readFileTool } = await import("./tools/filesystem.js");
        const result = await readFileTool.execute({ path: "/nonexistent/file.txt" });
        assert.equal(result.success, false);
    });
});

// ─── write_file ──────────────────────────────────────────────────────────

describe("writeFileTool", () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), "claw-test-"));
    });

    afterEach(() => rmSync(tmp, { recursive: true }));

    it("creates new file", async () => {
        const { writeFileTool } = await import("./tools/filesystem.js");
        const path = join(tmp, "new.txt");
        const result = await writeFileTool.execute({ path, content: "Hello world!" });
        assert.equal(result.success, true);
        assert.equal(readFileSync(path, "utf-8"), "Hello world!");
    });

    it("creates nested directories", async () => {
        const { writeFileTool } = await import("./tools/filesystem.js");
        const path = join(tmp, "a", "b", "c", "deep.txt");
        const result = await writeFileTool.execute({ path, content: "nested!" });
        assert.equal(result.success, true);
        assert.equal(readFileSync(path, "utf-8"), "nested!");
    });

    it("overwrites existing file", async () => {
        const { writeFileTool } = await import("./tools/filesystem.js");
        const path = join(tmp, "overwrite.txt");
        await writeFileTool.execute({ path, content: "first" });
        await writeFileTool.execute({ path, content: "second" });
        assert.equal(readFileSync(path, "utf-8"), "second");
    });
});

// ─── edit_file ───────────────────────────────────────────────────────────

describe("editFileTool", () => {
    let tmp: string;
    let filePath: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), "claw-test-"));
        filePath = join(tmp, "edit_me.txt");
        writeFileSync(filePath, "Hello World\nFoo Bar\nHello World\nBaz Qux\n");
    });

    afterEach(() => rmSync(tmp, { recursive: true }));

    it("replaces single occurrence", async () => {
        const { editFileTool } = await import("./tools/filesystem.js");
        const result = await editFileTool.execute({
            path: filePath,
            target: "Foo Bar",
            replacement: "FOO REPLACED",
        });
        assert.equal(result.success, true);
        const content = readFileSync(filePath, "utf-8");
        assert.ok(content.includes("FOO REPLACED"));
        assert.ok(!content.includes("Foo Bar"));
    });

    it("fails on non-unique target", async () => {
        const { editFileTool } = await import("./tools/filesystem.js");
        const result = await editFileTool.execute({
            path: filePath,
            target: "Hello World",
            replacement: "Hi",
        });
        assert.equal(result.success, false);
        assert.ok(result.error!.includes("2"));
    });

    it("replace_all works", async () => {
        const { editFileTool } = await import("./tools/filesystem.js");
        const result = await editFileTool.execute({
            path: filePath,
            target: "Hello World",
            replacement: "Replaced!",
            replace_all: true,
        });
        assert.equal(result.success, true);
        const content = readFileSync(filePath, "utf-8");
        assert.equal(content.split("Replaced!").length - 1, 2);
        assert.ok(!content.includes("Hello World"));
    });

    it("fails for missing target text", async () => {
        const { editFileTool } = await import("./tools/filesystem.js");
        const result = await editFileTool.execute({
            path: filePath,
            target: "NONEXISTENT",
            replacement: "...",
        });
        assert.equal(result.success, false);
    });

    it("fails for missing file", async () => {
        const { editFileTool } = await import("./tools/filesystem.js");
        const result = await editFileTool.execute({
            path: "/nonexistent/file.txt",
            target: "x",
            replacement: "y",
        });
        assert.equal(result.success, false);
    });
});

// ─── grep ────────────────────────────────────────────────────────────────

describe("grepTool", () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), "claw-test-"));
        mkdirSync(join(tmp, "src"));
        writeFileSync(join(tmp, "README.md"), "# Project\nThis is a TODO marker\nAnother line\n");
        writeFileSync(join(tmp, "src", "main.py"), "def main():\n    # TODO: implement\n    pass\n");
        writeFileSync(join(tmp, "src", "utils.py"), "def helper():\n    return 42\n");
    });

    afterEach(() => rmSync(tmp, { recursive: true }));

    it("searches single file", async () => {
        const { grepTool } = await import("./tools/filesystem.js");
        const result = await grepTool.execute({
            path: join(tmp, "README.md"),
            pattern: "TODO",
        });
        assert.equal(result.success, true);
        assert.ok(result.output.includes("TODO"));
        assert.ok(result.output.includes("1 match"));
    });

    it("searches directory recursively", async () => {
        const { grepTool } = await import("./tools/filesystem.js");
        const result = await grepTool.execute({
            path: tmp,
            pattern: "TODO",
            recursive: true,
        });
        assert.equal(result.success, true);
        assert.ok(result.output.includes("2 match"));
    });

    it("filters by glob", async () => {
        const { grepTool } = await import("./tools/filesystem.js");
        const result = await grepTool.execute({
            path: tmp,
            pattern: "TODO",
            glob_filter: "*.py",
            recursive: true,
        });
        assert.equal(result.success, true);
        assert.ok(result.output.includes("main.py"));
        assert.ok(!result.output.includes("README"));
    });

    it("reports no matches", async () => {
        const { grepTool } = await import("./tools/filesystem.js");
        const result = await grepTool.execute({
            path: tmp,
            pattern: "ZZZZNONEXISTENT",
            recursive: true,
        });
        assert.equal(result.success, true);
        assert.ok(result.output.includes("No matches"));
    });
});

// ─── glob ────────────────────────────────────────────────────────────────

describe("globTool", () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), "claw-test-"));
        mkdirSync(join(tmp, "src", "deep"), { recursive: true });
        writeFileSync(join(tmp, "README.md"), "readme");
        writeFileSync(join(tmp, "src", "main.py"), "main");
        writeFileSync(join(tmp, "src", "deep", "nested.py"), "nested");
    });

    afterEach(() => rmSync(tmp, { recursive: true }));

    it("finds py files recursively", async () => {
        const { globTool } = await import("./tools/filesystem.js");
        const result = await globTool.execute({ pattern: "**/*.py", path: tmp });
        assert.equal(result.success, true);
        assert.ok(result.output.includes("main.py"));
        assert.ok(result.output.includes("nested.py"));
    });

    it("finds md files non-recursively", async () => {
        const { globTool } = await import("./tools/filesystem.js");
        const result = await globTool.execute({ pattern: "*.md", path: tmp });
        assert.equal(result.success, true);
        assert.ok(result.output.includes("README.md"));
    });

    it("reports no matches", async () => {
        const { globTool } = await import("./tools/filesystem.js");
        const result = await globTool.execute({ pattern: "**/*.xyz", path: tmp });
        assert.equal(result.success, true);
        assert.ok(result.output.includes("No files"));
    });
});

// ─── todolist ────────────────────────────────────────────────────────────

describe("todolistTools", () => {
    it("write and update todos", async () => {
        const { todolistTools } = await import("./tools/todolist.js");
        const writeTool = todolistTools.find((t) => t.name === "write_todos")!;
        const updateTool = todolistTools.find((t) => t.name === "update_todo")!;

        // Write
        const w = await writeTool.execute({ todos: ["Read code", "Fix bug", "Test"] });
        assert.equal(w.success, true);
        assert.ok(w.output.includes("Read code"));
        assert.ok(w.output.includes("0/3"));

        // Update
        const u = await updateTool.execute({ index: 1 });
        assert.equal(u.success, true);
        assert.ok(u.output.includes("[x] Fix bug"));
        assert.ok(u.output.includes("1/3"));
    });

    it("fails on out of range update", async () => {
        const { todolistTools } = await import("./tools/todolist.js");
        const writeTool = todolistTools.find((t) => t.name === "write_todos")!;
        const updateTool = todolistTools.find((t) => t.name === "update_todo")!;

        await writeTool.execute({ todos: ["A"] });
        const result = await updateTool.execute({ index: 99 });
        assert.equal(result.success, false);
    });

    it("handles JSON string input", async () => {
        const { todolistTools } = await import("./tools/todolist.js");
        const writeTool = todolistTools.find((t) => t.name === "write_todos")!;

        const result = await writeTool.execute({ todos: '["Step 1", "Step 2"]' });
        assert.equal(result.success, true);
        assert.ok(result.output.includes("Step 1"));
    });
});

// ─── memory loader ──────────────────────────────────────────────────────

describe("memoryLoader", () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), "claw-test-"));
    });

    afterEach(() => rmSync(tmp, { recursive: true }));

    it("loads single memory file", async () => {
        const { loadMemoryFiles } = await import("./memory/loader.js");
        const path = join(tmp, "AGENTS.md");
        writeFileSync(path, "# Rules\n- Use async/await\n- Type all functions");

        const result = loadMemoryFiles([path]);
        assert.ok(result !== null);
        assert.ok(result!.includes("Agent Memory"));
        assert.ok(result!.includes("Use async/await"));
        assert.ok(result!.includes("AGENTS.md"));
    });

    it("returns null for empty list", async () => {
        const { loadMemoryFiles } = await import("./memory/loader.js");
        const result = loadMemoryFiles([]);
        assert.equal(result, null);
    });

    it("returns null for missing files", async () => {
        const { loadMemoryFiles } = await import("./memory/loader.js");
        const result = loadMemoryFiles(["/nonexistent/AGENTS.md"]);
        assert.equal(result, null);
    });

    it("loads multiple files", async () => {
        const { loadMemoryFiles } = await import("./memory/loader.js");
        const p1 = join(tmp, "AGENTS.md");
        const p2 = join(tmp, "CLAWAGENTS.md");
        writeFileSync(p1, "Rule 1");
        writeFileSync(p2, "Rule 2");

        const result = loadMemoryFiles([p1, p2]);
        assert.ok(result !== null);
        assert.ok(result!.includes("Rule 1"));
        assert.ok(result!.includes("Rule 2"));
    });
});
