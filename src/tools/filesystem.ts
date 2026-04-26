/**
 * Filesystem Tools — backed by a pluggable SandboxBackend.
 *
 * Provides: ls (with metadata), read_file, write_file, edit_file, grep, glob
 *
 * Default export uses LocalBackend (real filesystem). Call
 * `createFilesystemTools(backend)` to plug in InMemoryBackend or DockerBackend.
 */

import type { Tool, ToolResult } from "./registry.js";
import type { SandboxBackend, DirEntry } from "../sandbox/backend.js";
import { LocalBackend } from "../sandbox/local.js";

function formatSize(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const IGNORE_DIRS = new Set([
    "node_modules", ".git", ".venv", "venv", "env",
    "__pycache__", "dist", "build", ".next", ".cache",
    ".idea", ".vscode", "coverage",
]);

function matchesGlob(name: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
    return name === pattern;
}

// ─── Tool factory functions ────────────────────────────────────────────────

function createLsTool(sb: SandboxBackend): Tool {
    return {
        name: "ls",
        description: "List files and directories with metadata (size, modified time).",
        parameters: {
            path: { type: "string", description: "Path to list. Default: current directory", required: true },
        },
        async execute(args): Promise<ToolResult> {
            try {
                const targetPath = sb.safePath(String(args["path"] ?? "."));
                const entries = await sb.readDir(targetPath);
                const sorted = entries.sort((a, b) => {
                    if (a.isDirectory && !b.isDirectory) return -1;
                    if (!a.isDirectory && b.isDirectory) return 1;
                    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
                });

                const lines: string[] = [];
                for (const e of sorted) {
                    try {
                        const fullPath = sb.resolve(targetPath, e.name);
                        const s = await sb.stat(fullPath);
                        const mtime = new Date(s.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
                        if (e.isDirectory) {
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
}

function createReadFileTool(sb: SandboxBackend): Tool {
    return {
        name: "read_file",
        cacheable: true,
        description: "Read file contents with line numbers. Supports offset/limit for pagination.",
        parameters: {
            path: { type: "string", description: "Path to the file to read", required: true },
            offset: { type: "number", description: "Line number to start from (0-indexed). Default: 0" },
            limit: { type: "number", description: "Max lines to return. Default: 100" },
        },
        async execute(args): Promise<ToolResult> {
            try {
                const filePath = sb.safePath(String(args["path"] ?? ""));
                const ext = filePath.split(".").pop()?.toLowerCase();
                const isImage = ["png", "jpg", "jpeg", "webp"].includes(ext || "");

                if (isImage) {
                    const buffer = await sb.readFileBytes(filePath);
                    const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
                    if (buffer.length > MAX_IMAGE_BYTES) {
                        return { success: false, output: "", error: `Image too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB > 15MB limit)` };
                    }
                    const base64 = buffer.toString("base64");
                    const mime = ext === "jpg" ? "jpeg" : ext;
                    return {
                        success: true,
                        output: [
                            { type: "text", text: `Image loaded from ${filePath}` },
                            { type: "image_url", image_url: { url: `data:image/${mime};base64,${base64}` } },
                        ],
                    };
                }

                const offset = Math.max(0, Number(args["offset"] ?? 0) || 0);
                const limit = Math.max(1, Number(args["limit"] ?? 100) || 100);

                const content = await sb.readFile(filePath, "utf-8");
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
}

function createWriteFileTool(sb: SandboxBackend): Tool {
    return {
        name: "write_file",
        description: "Write content to a file. Creates parent directories if needed.",
        parameters: {
            path: { type: "string", description: "Path to write the file", required: true },
            content: { type: "string", description: "Content to write to the file", required: true },
        },
        async execute(args): Promise<ToolResult> {
            const content = String(args["content"] ?? "");
            try {
                const filePath = sb.safePath(String(args["path"] ?? ""));
                const dir = sb.dirname(filePath);
                if (!(await sb.exists(dir))) {
                    await sb.mkdir(dir, true);
                }
                await sb.writeFile(filePath, content);
                return { success: true, output: `Wrote ${content.length} bytes to ${filePath}` };
            } catch (err) {
                return { success: false, output: "", error: `write_file failed: ${String(err)}` };
            }
        },
    };
}

function createEditFileTool(sb: SandboxBackend): Tool {
    return {
        name: "edit_file",
        description: "Edit a file by replacing a specific block of text. The target must exactly match existing content.",
        parameters: {
            path: { type: "string", description: "Path to the file to edit", required: true },
            target: { type: "string", description: "The exact block of text to replace", required: true },
            replacement: { type: "string", description: "The new text", required: true },
            replace_all: { type: "boolean", description: "Replace all occurrences (default: false, requires unique match)" },
        },
        async execute(args): Promise<ToolResult> {
            const target = String(args["target"] ?? "");
            const replacement = String(args["replacement"] ?? "");
            const replaceAll = Boolean(args["replace_all"] ?? false);

            try {
                const filePath = sb.safePath(String(args["path"] ?? ""));
                if (!(await sb.exists(filePath))) {
                    return { success: false, output: "", error: `edit_file failed: File does not exist at ${filePath}` };
                }

                const content = await sb.readFile(filePath, "utf-8");

                if (!content.includes(target)) {
                    return { success: false, output: "", error: `edit_file failed: Could not find exact target text in ${filePath}. Check whitespace and line endings.` };
                }

                const count = content.split(target).length - 1;
                if (count > 1 && !replaceAll) {
                    return { success: false, output: "", error: `edit_file failed: Target text appears ${count} times. Use replace_all=true or provide a more specific target.` };
                }

                const newContent = replaceAll
                    ? content.replaceAll(target, replacement)
                    : content.replace(target, replacement);

                await sb.writeFile(filePath, newContent);
                return {
                    success: true,
                    output: `Edited ${filePath}: replaced ${replaceAll ? count : 1} occurrence(s) (${target.length} → ${replacement.length} bytes)`,
                };
            } catch (err) {
                return { success: false, output: "", error: `edit_file failed: ${String(err)}` };
            }
        },
    };
}

async function* walkDir(
    sb: SandboxBackend,
    dir: string,
    filter: string,
    recursive: boolean,
): AsyncGenerator<string> {
    const entries = await sb.readDir(dir);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const fullPath = sb.resolve(dir, entry.name);
        if (entry.isDirectory) {
            if (recursive && !IGNORE_DIRS.has(entry.name)) {
                yield* walkDir(sb, fullPath, filter, recursive);
            }
        } else if (entry.isFile) {
            if (matchesGlob(entry.name, filter)) {
                yield fullPath;
            }
        }
    }
}

function createGrepTool(sb: SandboxBackend): Tool {
    return {
        name: "grep",
        cacheable: true,
        description: "Search for a text pattern in files. Supports recursive multi-file search with glob filtering.",
        parameters: {
            path: { type: "string", description: "File or directory to search", required: true },
            pattern: { type: "string", description: "Text pattern to search for", required: true },
            glob_filter: { type: "string", description: "Glob pattern to filter files (e.g., '*.ts'). Only for directories." },
            recursive: { type: "boolean", description: "Search recursively in subdirectories. Default: false" },
        },
        async execute(args): Promise<ToolResult> {
            const pattern = String(args["pattern"] ?? "");
            const globFilter = String(args["glob_filter"] ?? "*");
            const recursive = Boolean(args["recursive"] ?? false);

            if (!pattern) {
                return { success: false, output: "", error: "No pattern provided" };
            }

            try {
                const target = sb.safePath(String(args["path"] ?? ""));
                const targetStat = await sb.stat(target).catch(() => null);

                if (targetStat?.isFile) {
                    const content = await sb.readFile(target, "utf-8");
                    const lines = content.split("\n");
                    const maxMatches = 100;
                    const matches: Array<{ line: string; num: number }> = [];
                    let truncated = false;
                    for (let i = 0; i < lines.length; i++) {
                        if (!lines[i]!.includes(pattern)) continue;
                        if (matches.length >= maxMatches) {
                            truncated = true;
                            break;
                        }
                        matches.push({ line: lines[i]!, num: i + 1 });
                    }

                    if (matches.length === 0) {
                        return { success: true, output: `No matches for "${pattern}" in ${target}` };
                    }
                    const output = matches
                        .map(({ line, num }) => `${String(num).padStart(4)}: ${line}`)
                        .join("\n");
                    const suffix = truncated ? ` (truncated at ${maxMatches})` : "";
                    return { success: true, output: `${matches.length} match(es) in ${target}${suffix}:\n${output}` };
                }

                if (!targetStat?.isDirectory) {
                    return { success: false, output: "", error: `Path does not exist: ${target}` };
                }

                const allMatches: string[] = [];
                let filesSearched = 0;
                const maxMatches = 100;

                for await (const filePath of walkDir(sb, target, globFilter, recursive)) {
                    filesSearched++;
                    try {
                        const content = await sb.readFile(filePath, "utf-8");
                        const rel = sb.relative(target, filePath);
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
}

function createGlobTool(sb: SandboxBackend): Tool {
    return {
        name: "glob",
        description: "Find files matching a glob pattern. Use '**/*.ts' for recursive search.",
        parameters: {
            pattern: { type: "string", description: "Glob pattern (e.g., '**/*.ts', 'src/**/*.js')", required: true },
            path: { type: "string", description: "Root directory to search from. Default: current directory" },
        },
        async execute(args): Promise<ToolResult> {
            const pattern = String(args["pattern"] ?? "");

            if (!pattern) {
                return { success: false, output: "", error: "No glob pattern provided" };
            }

            try {
                const root = sb.safePath(String(args["path"] ?? "."));
                const rootStat = await sb.stat(root).catch(() => null);
                if (!rootStat?.isDirectory) {
                    return { success: false, output: "", error: `Directory does not exist: ${root}` };
                }

                const results: string[] = [];
                const maxResults = 200;
                const isRecursive = pattern.includes("**");
                const ext = pattern.includes("*.") ? pattern.split("*.").pop() ?? "" : "";

                for await (const filePath of walkDir(sb, root, ext ? `*.${ext}` : "*", isRecursive)) {
                    try {
                        const rel = sb.relative(root, filePath);
                        const s = await sb.stat(filePath);
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
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create filesystem tools backed by a specific SandboxBackend.
 * Pass InMemoryBackend for tests, LocalBackend for production.
 */
export function createFilesystemTools(backend: SandboxBackend): Tool[] {
    return [
        createLsTool(backend),
        createReadFileTool(backend),
        createWriteFileTool(backend),
        createEditFileTool(backend),
        createGrepTool(backend),
        createGlobTool(backend),
    ];
}

/** Default tools using LocalBackend (backward compatible). */
const _defaultBackend = new LocalBackend();
export const filesystemTools: Tool[] = createFilesystemTools(_defaultBackend);

// Backward-compatible named exports for tests and external consumers
export const lsTool: Tool = filesystemTools[0]!;
export const readFileTool: Tool = filesystemTools[1]!;
export const writeFileTool: Tool = filesystemTools[2]!;
export const editFileTool: Tool = filesystemTools[3]!;
export const grepTool: Tool = filesystemTools[4]!;
export const globTool: Tool = filesystemTools[5]!;
