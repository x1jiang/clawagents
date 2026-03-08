/**
 * LocalBackend — SandboxBackend backed by the real filesystem.
 *
 * Drop-in replacement for the scattered node:fs calls that filesystem
 * and exec tools previously made directly.
 */

import {
    readdir,
    readFile,
    writeFile,
    stat as fsStat,
    mkdir as fsMkdir,
    access,
} from "node:fs/promises";
import {
    resolve,
    relative,
    dirname,
    basename,
    join,
    sep,
} from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import type {
    SandboxBackend,
    DirEntry,
    FileStat,
    ExecResult,
} from "./backend.js";

const execAsync = promisify(execCb);

export class LocalBackend implements SandboxBackend {
    readonly kind = "local" as const;
    readonly cwd: string;
    readonly sep = sep;

    constructor(root?: string) {
        this.cwd = root ?? process.cwd();
    }

    // ── Path helpers ────────────────────────────────────────────────

    resolve(...segments: string[]): string {
        return resolve(this.cwd, ...segments);
    }

    relative(from: string, to: string): string {
        return relative(from, to);
    }

    dirname(path: string): string {
        return dirname(path);
    }

    basename(path: string): string {
        return basename(path);
    }

    join(...segments: string[]): string {
        return join(...segments);
    }

    safePath(userPath: string): string {
        const resolved = resolve(this.cwd, userPath);
        if (resolved !== this.cwd && !resolved.startsWith(this.cwd + sep)) {
            throw new Error(`Path traversal blocked: ${userPath}`);
        }
        return resolved;
    }

    // ── File I/O ────────────────────────────────────────────────────

    async readFile(path: string, encoding: "utf-8"): Promise<string> {
        return await readFile(path, encoding);
    }

    async readFileBytes(path: string): Promise<Buffer> {
        return await readFile(path);
    }

    async writeFile(path: string, content: string): Promise<void> {
        await writeFile(path, content, "utf-8");
    }

    // ── Directory operations ────────────────────────────────────────

    async readDir(path: string): Promise<DirEntry[]> {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((e) => ({
            name: e.name,
            isDirectory: e.isDirectory(),
            isFile: e.isFile(),
        }));
    }

    async mkdir(path: string, recursive = false): Promise<void> {
        await fsMkdir(path, { recursive });
    }

    // ── Metadata ────────────────────────────────────────────────────

    async exists(path: string): Promise<boolean> {
        try {
            await access(path);
            return true;
        } catch {
            return false;
        }
    }

    async stat(path: string): Promise<FileStat> {
        const s = await fsStat(path);
        return {
            isFile: s.isFile(),
            isDirectory: s.isDirectory(),
            size: s.size,
            mtimeMs: s.mtimeMs,
        };
    }

    // ── Command execution ───────────────────────────────────────────

    async exec(
        command: string,
        opts?: { timeout?: number; cwd?: string; env?: Record<string, string> },
    ): Promise<ExecResult> {
        try {
            const { stdout, stderr } = await execAsync(command, {
                timeout: opts?.timeout ?? 30_000,
                maxBuffer: 1024 * 1024,
                cwd: opts?.cwd ?? this.cwd,
                env: { ...process.env, ...opts?.env, PAGER: "cat" },
            });
            return { stdout: stdout || "", stderr: stderr || "", exitCode: 0 };
        } catch (err: unknown) {
            const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean; code?: number };
            if (e.killed) {
                return { stdout: "", stderr: "", exitCode: 1, killed: true };
            }
            return {
                stdout: e.stdout ?? "",
                stderr: e.stderr ?? e.message ?? String(err),
                exitCode: typeof e.code === "number" ? e.code : 1,
            };
        }
    }
}
