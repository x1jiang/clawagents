/**
 * Advanced Filesystem Tools — tree, diff, insert_lines
 *
 * Backed by a pluggable SandboxBackend (same as filesystem.ts).
 */

import type { Tool, ToolResult } from "./registry.js";
import type { SandboxBackend } from "../sandbox/backend.js";
import { LocalBackend } from "../sandbox/local.js";

const IGNORE_DIRS = new Set([
    "node_modules", ".git", ".venv", "venv", "env",
    "__pycache__", "dist", "build", ".next", ".cache",
    ".idea", ".vscode", "coverage", ".tox", ".mypy_cache",
]);

// ─── tree ──────────────────────────────────────────────────────────────────

function createTreeTool(sb: SandboxBackend): Tool {
    return {
        name: "tree",
        description:
            "Show a recursive directory tree. Much faster than ls for getting a project overview. " +
            "Automatically skips node_modules, .git, __pycache__, etc.",
        parameters: {
            path: { type: "string", description: "Root directory. Default: current directory" },
            max_depth: { type: "number", description: "Max depth to recurse. Default: 4" },
        },
        async execute(args): Promise<ToolResult> {
            const root = sb.safePath(String(args["path"] ?? "."));
            const maxDepth = Math.max(1, Math.min(10, Number(args["max_depth"] ?? 4) || 4));

            const rootStat = await sb.stat(root).catch(() => null);
            if (!rootStat?.isDirectory) {
                return { success: false, output: "", error: `Not a directory: ${root}` };
            }

            const lines: string[] = [sb.relative(sb.cwd, root) || "."];
            let fileCount = 0;
            let dirCount = 0;
            const MAX_ENTRIES = 500;

            async function walk(dir: string, prefix: string, depth: number): Promise<void> {
                if (fileCount + dirCount >= MAX_ENTRIES) return;

                let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
                try {
                    entries = await sb.readDir(dir);
                    entries.sort((a, b) => {
                        if (a.isDirectory && !b.isDirectory) return -1;
                        if (!a.isDirectory && b.isDirectory) return 1;
                        return a.name.localeCompare(b.name);
                    });
                } catch {
                    return;
                }

                for (let i = 0; i < entries.length; i++) {
                    if (fileCount + dirCount >= MAX_ENTRIES) {
                        lines.push(`${prefix}... (truncated at ${MAX_ENTRIES} entries)`);
                        return;
                    }

                    const entry = entries[i]!;
                    const fullPath = sb.resolve(dir, entry.name);
                    const isLast = i === entries.length - 1;
                    const connector = isLast ? "└── " : "├── ";
                    const childPrefix = prefix + (isLast ? "    " : "│   ");

                    if (entry.isDirectory) {
                        dirCount++;
                        lines.push(`${prefix}${connector}${entry.name}/`);
                        if (depth < maxDepth && !IGNORE_DIRS.has(entry.name)) {
                            await walk(fullPath, childPrefix, depth + 1);
                        }
                    } else {
                        fileCount++;
                        lines.push(`${prefix}${connector}${entry.name}`);
                    }
                }
            }

            await walk(root, "", 1);
            lines.push(`\n${dirCount} directories, ${fileCount} files`);
            return { success: true, output: lines.join("\n") };
        },
    };
}

// ─── diff ──────────────────────────────────────────────────────────────────

function createDiffTool(sb: SandboxBackend): Tool {
    return {
        name: "diff",
        description:
            "Compare two files and show their differences in unified diff format. " +
            "Useful for reviewing changes before or after edits.",
        parameters: {
            file_a: { type: "string", description: "Path to the first file", required: true },
            file_b: { type: "string", description: "Path to the second file", required: true },
            context_lines: { type: "number", description: "Lines of context around changes. Default: 3" },
        },
        async execute(args): Promise<ToolResult> {
            const pathA = sb.safePath(String(args["file_a"] ?? ""));
            const pathB = sb.safePath(String(args["file_b"] ?? ""));
            const ctx = Math.max(0, Math.min(20, Number(args["context_lines"] ?? 3) || 3));

            if (!(await sb.exists(pathA))) return { success: false, output: "", error: `File not found: ${pathA}` };
            if (!(await sb.exists(pathB))) return { success: false, output: "", error: `File not found: ${pathB}` };

            try {
                const linesA = (await sb.readFile(pathA, "utf-8")).split("\n");
                const linesB = (await sb.readFile(pathB, "utf-8")).split("\n");

                const result = unifiedDiff(
                    linesA, linesB,
                    sb.relative(sb.cwd, pathA),
                    sb.relative(sb.cwd, pathB),
                    ctx,
                );

                return { success: true, output: result || "Files are identical." };
            } catch (err) {
                return { success: false, output: "", error: `diff failed: ${String(err)}` };
            }
        },
    };
}

function unifiedDiff(a: string[], b: string[], nameA: string, nameB: string, ctx: number): string {
    const lcs = computeLCS(a, b);
    let i = 0, j = 0, k = 0;

    const changes: Array<{ type: "keep" | "del" | "add"; lineA: number; lineB: number; text: string }> = [];

    while (i < a.length || j < b.length) {
        if (k < lcs.length && i < a.length && j < b.length && a[i] === lcs[k] && b[j] === lcs[k]) {
            changes.push({ type: "keep", lineA: i, lineB: j, text: a[i]! });
            i++; j++; k++;
        } else if (j < b.length && (k >= lcs.length || b[j] !== lcs[k])) {
            changes.push({ type: "add", lineA: i, lineB: j, text: b[j]! });
            j++;
        } else if (i < a.length) {
            changes.push({ type: "del", lineA: i, lineB: j, text: a[i]! });
            i++;
        }
    }

    if (changes.every((c) => c.type === "keep")) return "";

    const lines = [`--- ${nameA}`, `+++ ${nameB}`];

    let start = 0;
    while (start < changes.length) {
        let changeStart = -1;
        for (let c = start; c < changes.length; c++) {
            if (changes[c]!.type !== "keep") { changeStart = c; break; }
        }
        if (changeStart === -1) break;

        const hunkStart = Math.max(0, changeStart - ctx);
        let changeEnd = changeStart;
        for (let c = changeStart; c < changes.length; c++) {
            if (changes[c]!.type !== "keep") changeEnd = c;
        }
        const hunkEnd = Math.min(changes.length - 1, changeEnd + ctx);

        for (let c = hunkStart; c <= hunkEnd; c++) {
            const ch = changes[c]!;
            if (ch.type === "keep") lines.push(` ${ch.text}`);
            else if (ch.type === "del") lines.push(`-${ch.text}`);
            else lines.push(`+${ch.text}`);
        }

        start = hunkEnd + 1;
    }

    return lines.join("\n");
}

function computeLCS(a: string[], b: string[]): string[] {
    const m = a.length, n = b.length;
    if (m === 0 || n === 0) return [];
    if (m * n > 10_000_000) {
        return a.filter((line) => b.includes(line));
    }

    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i]![j] = a[i - 1] === b[j - 1]
                ? dp[i - 1]![j - 1]! + 1
                : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
        }
    }

    const result: string[] = [];
    let ri = m, rj = n;
    while (ri > 0 && rj > 0) {
        if (a[ri - 1] === b[rj - 1]) {
            result.unshift(a[ri - 1]!);
            ri--; rj--;
        } else if (dp[ri - 1]![rj]! >= dp[ri]![rj - 1]!) {
            ri--;
        } else {
            rj--;
        }
    }
    return result;
}

// ─── insert_lines ──────────────────────────────────────────────────────────

function createInsertLinesTool(sb: SandboxBackend): Tool {
    return {
        name: "insert_lines",
        description:
            "Insert text at a specific line number in a file. Line 0 inserts at the top; " +
            "a line beyond the file length appends at the end. More precise than edit_file for adding new code.",
        parameters: {
            path: { type: "string", description: "Path to the file", required: true },
            line: { type: "number", description: "Line number to insert before (1-indexed). 0 = top of file.", required: true },
            content: { type: "string", description: "The text to insert", required: true },
        },
        async execute(args): Promise<ToolResult> {
            const filePath = sb.safePath(String(args["path"] ?? ""));
            const lineNum = Math.max(0, Number(args["line"] ?? 0) || 0);
            const content = String(args["content"] ?? "");

            if (!content) {
                return { success: false, output: "", error: "No content to insert" };
            }

            try {
                if (!(await sb.exists(filePath))) {
                    return { success: false, output: "", error: `File not found: ${filePath}` };
                }

                const existing = await sb.readFile(filePath, "utf-8");
                const lines = existing.split("\n");
                const insertIdx = Math.min(lineNum, lines.length);

                const newLines = content.split("\n");
                lines.splice(insertIdx, 0, ...newLines);

                await sb.writeFile(filePath, lines.join("\n"));

                return {
                    success: true,
                    output: `Inserted ${newLines.length} line(s) at line ${insertIdx} in ${filePath} (now ${lines.length} lines total)`,
                };
            } catch (err) {
                return { success: false, output: "", error: `insert_lines failed: ${String(err)}` };
            }
        },
    };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function createAdvancedFsTools(backend: SandboxBackend): Tool[] {
    return [createTreeTool(backend), createDiffTool(backend), createInsertLinesTool(backend)];
}

export const advancedFsTools: Tool[] = createAdvancedFsTools(new LocalBackend());
