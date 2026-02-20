/**
 * Filesystem Tools — ported from deepagents FilesystemMiddleware
 *
 * Provides: ls, read_file, write_file, grep
 */

import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { existsSync } from "node:fs";
import type { Tool, ToolResult } from "./registry.js";

const ROOT = process.cwd();

function safePath(p: string): string {
    // Resolve to absolute, ensure it's under ROOT for safety
    const resolved = resolve(ROOT, p);
    return resolved;
}

// ─── ls ────────────────────────────────────────────────────────────────────

export const lsTool: Tool = {
    name: "ls",
    description: "List files and directories at the given path.",
    parameters: {
        path: { type: "string", description: "Absolute or relative path to list", required: true },
    },
    async execute(args): Promise<ToolResult> {
        const targetPath = safePath(String(args["path"] ?? "."));
        try {
            const entries = await readdir(targetPath, { withFileTypes: true });
            const lines = entries.map((e) => {
                const prefix = e.isDirectory() ? "[DIR]  " : "[FILE] ";
                return prefix + e.name;
            });
            return { success: true, output: lines.join("\n") || "(empty directory)" };
        } catch (err) {
            return { success: false, output: "", error: `ls failed: ${String(err)}` };
        }
    },
};

// ─── read_file ─────────────────────────────────────────────────────────────

export const readFileTool: Tool = {
    name: "read_file",
    description: "Read the contents of a file. Returns the file content with line numbers.",
    parameters: {
        path: { type: "string", description: "Path to the file to read", required: true },
        offset: { type: "number", description: "Line number to start reading from (0-indexed). Default: 0" },
        limit: { type: "number", description: "Max lines to return. Default: 100" },
    },
    async execute(args): Promise<ToolResult> {
        const filePath = safePath(String(args["path"] ?? ""));
        const offset = Number(args["offset"] ?? 0);
        const limit = Number(args["limit"] ?? 100);

        try {
            const content = await readFile(filePath, "utf-8");
            const lines = content.split("\n");
            const slice = lines.slice(offset, offset + limit);
            const numbered = slice.map((line, i) => `${String(offset + i + 1).padStart(4)}: ${line}`);
            const header = `File: ${filePath} (${lines.length} lines total, showing ${offset + 1}-${offset + slice.length})`;
            return { success: true, output: header + "\n" + numbered.join("\n") };
        } catch (err) {
            return { success: false, output: "", error: `read_file failed: ${String(err)}` };
        }
    },
};

// ─── write_file ────────────────────────────────────────────────────────────

export const writeFileTool: Tool = {
    name: "write_file",
    description: "Write content to a file. Creates parent directories if needed.",
    parameters: {
        path: { type: "string", description: "Path to write the file", required: true },
        content: { type: "string", description: "Content to write to the file", required: true },
    },
    async execute(args): Promise<ToolResult> {
        const filePath = safePath(String(args["path"] ?? ""));
        const content = String(args["content"] ?? "");

        try {
            const dir = dirname(filePath);
            if (!existsSync(dir)) {
                await mkdir(dir, { recursive: true });
            }
            await writeFile(filePath, content, "utf-8");
            return { success: true, output: `Wrote ${content.length} bytes to ${filePath}` };
        } catch (err) {
            return { success: false, output: "", error: `write_file failed: ${String(err)}` };
        }
    },
};

// ─── grep ──────────────────────────────────────────────────────────────────

export const grepTool: Tool = {
    name: "grep",
    description: "Search for a pattern in a file. Returns matching lines with line numbers.",
    parameters: {
        path: { type: "string", description: "Path to the file to search", required: true },
        pattern: { type: "string", description: "Text pattern to search for", required: true },
    },
    async execute(args): Promise<ToolResult> {
        const filePath = safePath(String(args["path"] ?? ""));
        const pattern = String(args["pattern"] ?? "");

        try {
            const content = await readFile(filePath, "utf-8");
            const lines = content.split("\n");
            const matches = lines
                .map((line, i) => ({ line, num: i + 1 }))
                .filter(({ line }) => line.includes(pattern));

            if (matches.length === 0) {
                return { success: true, output: `No matches for "${pattern}" in ${filePath}` };
            }

            const output = matches
                .map(({ line, num }) => `${String(num).padStart(4)}: ${line}`)
                .join("\n");
            return { success: true, output: `${matches.length} match(es) in ${filePath}:\n${output}` };
        } catch (err) {
            return { success: false, output: "", error: `grep failed: ${String(err)}` };
        }
    },
};

// ─── edit_file ─────────────────────────────────────────────────────────────

export const editFileTool: Tool = {
    name: "edit_file",
    description: "Edit a file by replacing a specific block of text. Use this for surgical edits instead of write_file. The target text must exactly match the existing file content (including whitespace).",
    parameters: {
        path: { type: "string", description: "Path to the file to edit", required: true },
        target: { type: "string", description: "The exact block of text to be replaced.", required: true },
        replacement: { type: "string", description: "The new block of text that replaces the target.", required: true },
    },
    async execute(args): Promise<ToolResult> {
        const filePath = safePath(String(args["path"] ?? ""));
        const target = String(args["target"] ?? "");
        const replacement = String(args["replacement"] ?? "");

        try {
            if (!existsSync(filePath)) {
                return { success: false, output: "", error: `edit_file failed: File does not exist at ${filePath}` };
            }

            const content = await readFile(filePath, "utf-8");

            if (!content.includes(target)) {
                return { success: false, output: "", error: `edit_file failed: Could not find exact target text in ${filePath}. Check whitespace and line endings.` };
            }

            // check unique
            const firstIndex = content.indexOf(target);
            const lastIndex = content.lastIndexOf(target);
            if (firstIndex !== lastIndex) {
                return { success: false, output: "", error: `edit_file failed: The target text appears multiple times. Please provide a larger block of text to uniquely identify the replacement.` };
            }

            const newContent = content.replace(target, replacement);
            await writeFile(filePath, newContent, "utf-8");

            return { success: true, output: `Successfully edited ${filePath}. Replaced ${target.length} bytes with ${replacement.length} bytes.` };
        } catch (err) {
            return { success: false, output: "", error: `edit_file failed: ${String(err)}` };
        }
    },
};

/** Register all filesystem tools */
export const filesystemTools: Tool[] = [lsTool, readFileTool, writeFileTool, editFileTool, grepTool];
