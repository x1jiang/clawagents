/**
 * Filesystem Tools — full-stack upgrade
 *
 * Provides: ls (with metadata), read_file, write_file, edit_file (replace_all), grep (recursive), glob
 */

import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { resolve, dirname, relative, sep } from "node:path";
import { existsSync, statSync, readFileSync } from "node:fs";
import { glob as globFn } from "node:fs/promises";
import type { Tool, ToolResult } from "./registry.js";

const ROOT = process.cwd();

function safePath(p: string): string {
    const resolved = resolve(ROOT, p);
    if (resolved !== ROOT && !resolved.startsWith(ROOT + sep)) {
        throw new Error(`Path traversal blocked: ${p}`);
    }
    return resolved;
}

function formatSize(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── ls (with metadata) ────────────────────────────────────────────────────

export const lsTool: Tool = {
    name: "ls",
    description: "List files and directories with metadata (size, modified time).",
    parameters: {
        path: { type: "string", description: "Path to list. Default: current directory", required: true },
    },
    async execute(args): Promise<ToolResult> {
        const targetPath = safePath(String(args["path"] ?? "."));
        try {
            const entries = await readdir(targetPath, { withFileTypes: true });
            // Sort: dirs first, then files, case-insensitive
            const sorted = entries.sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
            });

            const lines: string[] = [];
            for (const e of sorted) {
                try {
                    const fullPath = resolve(targetPath, e.name);
                    const s = statSync(fullPath);
                    const mtime = new Date(s.mtimeMs).toISOString().slice(0, 16).replace("T", " ");

                    if (e.isDirectory()) {
                        lines.push(`[DIR]  ${e.name}/`);
                    } else {
                        lines.push(`[FILE] ${e.name} (${formatSize(s.size)}, ${mtime})`);
                    }
                } catch {
                    lines.push(`[????] ${e.name}`);
                }
            }
            return { success: true, output: lines.join("\n") || "(empty directory)" };
        } catch (err) {
            return { success: false, output: "", error: `ls failed: ${String(err)}` };
        }
    },
};

// ─── read_file ─────────────────────────────────────────────────────────────

export const readFileTool: Tool = {
    name: "read_file",
    description: "Read file contents with line numbers. Supports offset/limit for pagination.",
    parameters: {
        path: { type: "string", description: "Path to the file to read", required: true },
        offset: { type: "number", description: "Line number to start from (0-indexed). Default: 0" },
        limit: { type: "number", description: "Max lines to return. Default: 100" },
    },
    async execute(args): Promise<ToolResult> {
        const filePath = safePath(String(args["path"] ?? ""));
        const offset = Math.max(0, Number(args["offset"] ?? 0) || 0);
        const limit = Math.max(1, Number(args["limit"] ?? 100) || 100);

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

// ─── grep (recursive multi-file) ──────────────────────────────────────────

export const grepTool: Tool = {
    name: "grep",
    description: "Search for a text pattern in files. Supports recursive multi-file search with glob filtering.",
    parameters: {
        path: { type: "string", description: "File or directory to search", required: true },
        pattern: { type: "string", description: "Text pattern to search for", required: true },
        glob_filter: { type: "string", description: "Glob pattern to filter files (e.g., '*.ts'). Only for directories." },
        recursive: { type: "boolean", description: "Search recursively in subdirectories. Default: false" },
    },
    async execute(args): Promise<ToolResult> {
        const target = safePath(String(args["path"] ?? ""));
        const pattern = String(args["pattern"] ?? "");
        const globFilter = String(args["glob_filter"] ?? "*");
        const recursive = Boolean(args["recursive"] ?? false);

        if (!pattern) {
            return { success: false, output: "", error: "No pattern provided" };
        }

        try {
            // Single-file search
            if (existsSync(target) && statSync(target).isFile()) {
                return searchFile(target, pattern);
            }

            if (!existsSync(target) || !statSync(target).isDirectory()) {
                return { success: false, output: "", error: `Path does not exist: ${target}` };
            }

            // Multi-file search using walkDir
            const allMatches: string[] = [];
            let filesSearched = 0;
            const maxMatches = 100;

            for await (const filePath of walkDir(target, globFilter, recursive)) {
                filesSearched++;
                try {
                    const content = await readFile(filePath, "utf-8");
                    const rel = relative(target, filePath);
                    const lines = content.split("\n");
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i]!.includes(pattern)) {
                            allMatches.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
                            if (allMatches.length >= maxMatches) break;
                        }
                    }
                } catch {
                    continue;
                }
                if (allMatches.length >= maxMatches) break;
            }

            if (allMatches.length === 0) {
                return { success: true, output: `No matches for "${pattern}" in ${filesSearched} files under ${target}` };
            }

            const truncated = allMatches.length >= maxMatches ? ` (truncated at ${maxMatches})` : "";
            return {
                success: true,
                output: `${allMatches.length} match(es) in ${filesSearched} files${truncated}:\n${allMatches.join("\n")}`,
            };
        } catch (err) {
            return { success: false, output: "", error: `grep failed: ${String(err)}` };
        }
    },
};

function searchFile(filePath: string, pattern: string): ToolResult {
    try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const matches = lines
            .map((line: string, i: number) => ({ line, num: i + 1 }))
            .filter(({ line }: { line: string }) => line.includes(pattern));

        if (matches.length === 0) {
            return { success: true, output: `No matches for "${pattern}" in ${filePath}` };
        }

        const output = matches
            .map(({ line, num }: { line: string; num: number }) => `${String(num).padStart(4)}: ${line}`)
            .join("\n");
        return { success: true, output: `${matches.length} match(es) in ${filePath}:\n${output}` };
    } catch (err) {
        return { success: false, output: "", error: `grep failed: ${String(err)}` };
    }
}

async function* walkDir(dir: string, filter: string, recursive: boolean): AsyncGenerator<string> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory() && recursive) {
            yield* walkDir(fullPath, filter, recursive);
        } else if (entry.isFile()) {
            if (matchesGlob(entry.name, filter)) {
                yield fullPath;
            }
        }
    }
}

function matchesGlob(name: string, pattern: string): boolean {
    if (pattern === "*") return true;
    // Simple glob: *.ext
    if (pattern.startsWith("*.")) {
        return name.endsWith(pattern.slice(1));
    }
    return name === pattern;
}

// ─── edit_file (with replace_all) ─────────────────────────────────────────

export const editFileTool: Tool = {
    name: "edit_file",
    description: "Edit a file by replacing a specific block of text. The target must exactly match existing content.",
    parameters: {
        path: { type: "string", description: "Path to the file to edit", required: true },
        target: { type: "string", description: "The exact block of text to replace", required: true },
        replacement: { type: "string", description: "The new text", required: true },
        replace_all: { type: "boolean", description: "Replace all occurrences (default: false, requires unique match)" },
    },
    async execute(args): Promise<ToolResult> {
        const filePath = safePath(String(args["path"] ?? ""));
        const target = String(args["target"] ?? "");
        const replacement = String(args["replacement"] ?? "");
        const replaceAll = Boolean(args["replace_all"] ?? false);

        try {
            if (!existsSync(filePath)) {
                return { success: false, output: "", error: `edit_file failed: File does not exist at ${filePath}` };
            }

            const content = await readFile(filePath, "utf-8");

            if (!content.includes(target)) {
                return { success: false, output: "", error: `edit_file failed: Could not find exact target text in ${filePath}. Check whitespace and line endings.` };
            }

            const count = content.split(target).length - 1;
            if (count > 1 && !replaceAll) {
                return { success: false, output: "", error: `edit_file failed: Target text appears ${count} times. Use replace_all=true or provide a more specific target.` };
            }

            let newContent: string;
            if (replaceAll) {
                newContent = content.replaceAll(target, replacement);
            } else {
                newContent = content.replace(target, replacement);
            }

            await writeFile(filePath, newContent, "utf-8");
            return {
                success: true,
                output: `Edited ${filePath}: replaced ${replaceAll ? count : 1} occurrence(s) (${target.length} → ${replacement.length} bytes)`,
            };
        } catch (err) {
            return { success: false, output: "", error: `edit_file failed: ${String(err)}` };
        }
    },
};

// ─── glob ──────────────────────────────────────────────────────────────────

export const globTool: Tool = {
    name: "glob",
    description: "Find files matching a glob pattern. Use '**/*.ts' for recursive search.",
    parameters: {
        pattern: { type: "string", description: "Glob pattern (e.g., '**/*.ts', 'src/**/*.js')", required: true },
        path: { type: "string", description: "Root directory to search from. Default: current directory" },
    },
    async execute(args): Promise<ToolResult> {
        const root = safePath(String(args["path"] ?? "."));
        const pattern = String(args["pattern"] ?? "");

        if (!pattern) {
            return { success: false, output: "", error: "No glob pattern provided" };
        }

        try {
            if (!existsSync(root) || !statSync(root).isDirectory()) {
                return { success: false, output: "", error: `Directory does not exist: ${root}` };
            }

            const results: string[] = [];
            const maxResults = 200;

            // Walk and match manually (Node.js glob API may not be available in all versions)
            const isRecursive = pattern.includes("**");
            const ext = pattern.includes("*.") ? pattern.split("*.").pop() ?? "" : "";

            for await (const filePath of walkDir(root, ext ? `*.${ext}` : "*", isRecursive)) {
                try {
                    const rel = relative(root, filePath);
                    const s = statSync(filePath);
                    results.push(`${rel} (${formatSize(s.size)})`);
                } catch {
                    continue;
                }
                if (results.length >= maxResults) break;
            }

            if (results.length === 0) {
                return { success: true, output: `No files matching '${pattern}' in ${root}` };
            }

            const truncated = results.length >= maxResults ? ` (showing first ${maxResults})` : "";
            return {
                success: true,
                output: `${results.length} file(s) matching '${pattern}'${truncated}:\n${results.join("\n")}`,
            };
        } catch (err) {
            return { success: false, output: "", error: `glob failed: ${String(err)}` };
        }
    },
};

/** All filesystem tools */
export const filesystemTools: Tool[] = [lsTool, readFileTool, writeFileTool, editFileTool, grepTool, globTool];
