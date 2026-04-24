/**
 * Corner case and edge case tests for ClawAgents TypeScript.
 *
 * Pushes boundaries: unicode, special chars, large files, empty inputs,
 * boundary conditions, whitespace, error recovery, etc.
 *
 * Run: npx tsx --test src/corner_cases.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Build a fresh set of filesystem tools scoped to `root`. The default module
 * singleton is pinned to the workspace cwd for safety (LLMs shouldn't write
 * outside the project), so per-test tmp dirs need their own backend.
 */
async function sandboxedFs(root: string): Promise<{
    lsTool: import("./tools/registry.js").Tool;
    readFileTool: import("./tools/registry.js").Tool;
    writeFileTool: import("./tools/registry.js").Tool;
    editFileTool: import("./tools/registry.js").Tool;
    grepTool: import("./tools/registry.js").Tool;
    globTool: import("./tools/registry.js").Tool;
}> {
    const { createFilesystemTools } = await import("./tools/filesystem.js");
    const { LocalBackend } = await import("./sandbox/local.js");
    const [lsTool, readFileTool, writeFileTool, editFileTool, grepTool, globTool] =
        createFilesystemTools(new LocalBackend(root));
    return { lsTool: lsTool!, readFileTool: readFileTool!, writeFileTool: writeFileTool!, editFileTool: editFileTool!, grepTool: grepTool!, globTool: globTool! };
}

// ─── Unicode / Special Characters ────────────────────────────────────────

describe("unicode content", () => {
    let tmp: string;
    beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "claw-")); });
    afterEach(() => rmSync(tmp, { recursive: true }));

    it("write and read unicode", async () => {
        const { writeFileTool, readFileTool } = await sandboxedFs(tmp);
        const path = join(tmp, "unicode.txt");
        const content = "Hello 世界! 🎉 résumé über naïve";

        await writeFileTool.execute({ path, content });
        const r = await readFileTool.execute({ path });
        assert.ok(r.output.includes("世界"));
        assert.ok(r.output.includes("🎉"));
        assert.ok(r.output.includes("résumé"));
    });

    it("edit unicode target", async () => {
        const { writeFileTool, editFileTool } = await sandboxedFs(tmp);
        const path = join(tmp, "edit_u.txt");
        await writeFileTool.execute({ path, content: "Hello 世界" });

        const result = await editFileTool.execute({ path, target: "世界", replacement: "World 🌍" });
        assert.equal(result.success, true);
        assert.ok(readFileSync(path, "utf-8").includes("World 🌍"));
    });

    it("grep unicode pattern", async () => {
        const { writeFileTool, grepTool } = await sandboxedFs(tmp);
        const path = join(tmp, "grep_u.txt");
        await writeFileTool.execute({ path, content: "Line 1\n函数定义\nLine 3\n" });

        const result = await grepTool.execute({ path, pattern: "函数" });
        assert.ok(result.output.includes("函数"));
    });
});

// ─── Special Filenames ───────────────────────────────────────────────────

describe("special filenames", () => {
    let tmp: string;
    beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "claw-")); });
    afterEach(() => rmSync(tmp, { recursive: true }));

    it("file with spaces", async () => {
        const { writeFileTool, readFileTool } = await sandboxedFs(tmp);
        const path = join(tmp, "file with spaces.txt");
        await writeFileTool.execute({ path, content: "spaced" });
        const r = await readFileTool.execute({ path });
        assert.ok(r.output.includes("spaced"));
    });

    it("dotfile visible in ls", async () => {
        const { writeFileTool, lsTool } = await sandboxedFs(tmp);
        await writeFileTool.execute({ path: join(tmp, ".hidden"), content: "secret" });
        const r = await lsTool.execute({ path: tmp });
        assert.ok(r.output.includes(".hidden"));
    });

    it("deeply nested path", async () => {
        const { writeFileTool, readFileTool } = await sandboxedFs(tmp);
        const path = join(tmp, "a", "b", "c", "d", "e", "deep.txt");
        await writeFileTool.execute({ path, content: "deep!" });
        const r = await readFileTool.execute({ path });
        assert.ok(r.output.includes("deep!"));
    });
});

// ─── Boundary Conditions ─────────────────────────────────────────────────

describe("boundary conditions", () => {
    let tmp: string;
    beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "claw-")); });
    afterEach(() => rmSync(tmp, { recursive: true }));

    it("read empty file", async () => {
        const { readFileTool } = await sandboxedFs(tmp);
        const path = join(tmp, "empty.txt");
        writeFileSync(path, "");
        const r = await readFileTool.execute({ path });
        assert.equal(r.success, true);
    });

    it("read single-line file", async () => {
        const { readFileTool } = await sandboxedFs(tmp);
        const path = join(tmp, "one.txt");
        writeFileSync(path, "only line");
        const r = await readFileTool.execute({ path });
        assert.ok(r.output.includes("only line"));
    });

    it("large file with pagination", async () => {
        const { readFileTool } = await sandboxedFs(tmp);
        const path = join(tmp, "large.txt");
        const lines = Array.from({ length: 10000 }, (_, i) => `Line ${i}: ${"x".repeat(80)}`);
        writeFileSync(path, lines.join("\n"));
        const r = await readFileTool.execute({ path, limit: 10 });
        assert.equal(r.success, true);
        assert.ok(r.output.includes("10000 lines total"));
    });

    it("write empty content", async () => {
        const { writeFileTool } = await sandboxedFs(tmp);
        const path = join(tmp, "empty_w.txt");
        const r = await writeFileTool.execute({ path, content: "" });
        assert.equal(r.success, true);
    });

    it("edit multiline target", async () => {
        const { editFileTool } = await sandboxedFs(tmp);
        const path = join(tmp, "multi.txt");
        writeFileSync(path, "line1\nline2\nline3\n");
        const r = await editFileTool.execute({ path, target: "line1\nline2", replacement: "REPLACED" });
        assert.equal(r.success, true);
        assert.ok(readFileSync(path, "utf-8").includes("REPLACED\nline3"));
    });

    it("offset beyond file length", async () => {
        const { readFileTool } = await sandboxedFs(tmp);
        const path = join(tmp, "short.txt");
        writeFileSync(path, "two\nlines\n");
        const r = await readFileTool.execute({ path, offset: 100, limit: 10 });
        assert.equal(r.success, true);
    });

    it("ls on file (not dir) fails", async () => {
        const { lsTool } = await sandboxedFs(tmp);
        const path = join(tmp, "notadir.txt");
        writeFileSync(path, "x");
        const r = await lsTool.execute({ path });
        assert.equal(r.success, false);
    });

    it("grep empty pattern fails", async () => {
        const { grepTool } = await sandboxedFs(tmp);
        const r = await grepTool.execute({ path: tmp, pattern: "" });
        assert.equal(r.success, false);
    });
});

// ─── Grep Edge Cases ─────────────────────────────────────────────────────

describe("grep edge cases", () => {
    let tmp: string;
    beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "claw-")); });
    afterEach(() => rmSync(tmp, { recursive: true }));

    it("handles regex special chars as literals", async () => {
        const { grepTool } = await sandboxedFs(tmp);
        const path = join(tmp, "special.txt");
        writeFileSync(path, "price $100.00\nfoo(bar)\n[brackets]\n");

        for (const pattern of ["$100.00", "foo(bar)", "[brackets]"]) {
            const r = await grepTool.execute({ path, pattern });
            assert.equal(r.success, true, `Failed for: ${pattern}`);
            assert.ok(r.output.includes(pattern), `Output missing: ${pattern}`);
        }
    });

    it("case sensitive matching", async () => {
        const { grepTool } = await sandboxedFs(tmp);
        const path = join(tmp, "case.txt");
        writeFileSync(path, "Hello World\nhello world\nHELLO WORLD\n");
        const r = await grepTool.execute({ path, pattern: "Hello" });
        assert.ok(r.output.includes("1 match"));
    });
});

// ─── Edit Replace All Corner Cases ───────────────────────────────────────

describe("edit replace_all corner cases", () => {
    let tmp: string;
    beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "claw-")); });
    afterEach(() => rmSync(tmp, { recursive: true }));

    it("replaces consecutive occurrences", async () => {
        const { editFileTool } = await sandboxedFs(tmp);
        const path = join(tmp, "consec.txt");
        writeFileSync(path, "aaa");
        const r = await editFileTool.execute({ path, target: "a", replacement: "bb", replace_all: true });
        assert.equal(r.success, true);
        assert.equal(readFileSync(path, "utf-8"), "bbbbbb");
    });

    it("replaces with empty string (deletion)", async () => {
        const { editFileTool } = await sandboxedFs(tmp);
        const path = join(tmp, "del.txt");
        writeFileSync(path, "keep DELETE keep");
        const r = await editFileTool.execute({ path, target: " DELETE ", replacement: " " });
        assert.equal(r.success, true);
        assert.equal(readFileSync(path, "utf-8"), "keep keep");
    });

    it("no-op replace (target === replacement)", async () => {
        const { editFileTool } = await sandboxedFs(tmp);
        const path = join(tmp, "noop.txt");
        writeFileSync(path, "same same same");
        const r = await editFileTool.execute({ path, target: "same", replacement: "same", replace_all: true });
        assert.equal(r.success, true);
        assert.equal(readFileSync(path, "utf-8"), "same same same");
    });
});

// ─── TodoList Corner Cases ───────────────────────────────────────────────

describe("todolist corner cases", () => {
    it("100-item list", async () => {
        const { todolistTools } = await import("./tools/todolist.js");
        const write = todolistTools.find((t) => t.name === "write_todos")!;
        const update = todolistTools.find((t) => t.name === "update_todo")!;

        const items = Array.from({ length: 100 }, (_, i) => `Step ${i}`);
        const w = await write.execute({ todos: items });
        assert.ok(w.output.includes("0/100"));

        const u = await update.execute({ index: 99 });
        assert.ok(u.output.includes("1/100"));
    });

    it("double-complete is idempotent", async () => {
        const { todolistTools } = await import("./tools/todolist.js");
        const write = todolistTools.find((t) => t.name === "write_todos")!;
        const update = todolistTools.find((t) => t.name === "update_todo")!;

        await write.execute({ todos: ["Only"] });
        await update.execute({ index: 0 });
        const r = await update.execute({ index: 0 });
        assert.ok(r.output.includes("[x]"));
    });

    it("empty todo list", async () => {
        const { todolistTools } = await import("./tools/todolist.js");
        const write = todolistTools.find((t) => t.name === "write_todos")!;
        const r = await write.execute({ todos: [] });
        assert.equal(r.success, true);
    });

    it("special characters in todos", async () => {
        const { todolistTools } = await import("./tools/todolist.js");
        const write = todolistTools.find((t) => t.name === "write_todos")!;
        const r = await write.execute({
            todos: ["Fix bug #123", "Handle 'quotes'", "Parse <xml> & entities"]
        });
        assert.ok(r.output.includes("#123"));
        assert.ok(r.output.includes("<xml>"));
    });

    it("negative index rejected", async () => {
        const { todolistTools } = await import("./tools/todolist.js");
        const write = todolistTools.find((t) => t.name === "write_todos")!;
        const update = todolistTools.find((t) => t.name === "update_todo")!;

        await write.execute({ todos: ["A"] });
        const r = await update.execute({ index: -1 });
        assert.equal(r.success, false);
    });
});

// ─── Memory Corner Cases ─────────────────────────────────────────────────

describe("memory corner cases", () => {
    let tmp: string;
    beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "claw-")); });
    afterEach(() => rmSync(tmp, { recursive: true }));

    it("whitespace-only file treated as empty", async () => {
        const { loadMemoryFiles } = await import("./memory/loader.js");
        writeFileSync(join(tmp, "ws.md"), "   \n\n   \t\t\n  ");
        const r = loadMemoryFiles([join(tmp, "ws.md")]);
        assert.equal(r, null);
    });

    it("very large memory file", async () => {
        const { loadMemoryFiles } = await import("./memory/loader.js");
        const path = join(tmp, "big.md");
        writeFileSync(path, "x".repeat(100_000));
        const r = loadMemoryFiles([path]);
        assert.ok(r !== null);
        assert.ok(r!.length > 100_000);
    });

    it("mixed existing and missing files", async () => {
        const { loadMemoryFiles } = await import("./memory/loader.js");
        const path = join(tmp, "exists.md");
        writeFileSync(path, "Real content");
        const r = loadMemoryFiles(["/nonexistent.md", path, "/also/missing.md"]);
        assert.ok(r !== null);
        assert.ok(r!.includes("Real content"));
    });
});
