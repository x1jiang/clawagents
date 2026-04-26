import { execFile as execFileCb } from "node:child_process";
import { access, mkdir, readFile, readdir, stat as fsStat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { DirEntry, ExecResult, FileStat, SandboxBackend } from "./backend.js";

const execFile = promisify(execFileCb);

const SENSITIVE_ENV_RE = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)$/i;

export interface DockerBackendOptions {
    root?: string;
    image?: string;
    dockerBin?: string;
    containerWorkdir?: string;
    readOnlyRoot?: boolean;
}

export class DockerBackend implements SandboxBackend {
    readonly kind = "docker" as const;
    readonly cwd: string;
    readonly sep = sep;
    readonly image: string;
    readonly dockerBin: string;
    readonly containerWorkdir: string;
    readonly readOnlyRoot: boolean;

    constructor(opts: DockerBackendOptions = {}) {
        const raw = opts.root ?? process.cwd();
        try {
            this.cwd = realpathSync(raw);
        } catch {
            this.cwd = resolve(raw);
        }
        this.image = opts.image ?? "node:20-alpine";
        this.dockerBin = opts.dockerBin ?? "docker";
        this.containerWorkdir = opts.containerWorkdir ?? "/workspace";
        this.readOnlyRoot = opts.readOnlyRoot ?? false;
    }

    resolve(...segments: string[]): string { return resolve(this.cwd, ...segments); }
    relative(from: string, to: string): string { return relative(from, to); }
    dirname(path: string): string { return dirname(path); }
    basename(path: string): string { return basename(path); }
    join(...segments: string[]): string { return join(...segments); }

    safePath(userPath: string): string {
        const lexical = resolve(this.cwd, userPath);
        let head = lexical;
        const tail: string[] = [];
        while (true) {
            try {
                const realHead = realpathSync(head);
                const final = tail.length ? resolve(realHead, ...tail) : realHead;
                if (final !== this.cwd && !final.startsWith(this.cwd + sep)) {
                    throw new Error(`Path traversal blocked: ${userPath}`);
                }
                return final;
            } catch (err) {
                if (err instanceof Error && err.message.startsWith("Path traversal")) throw err;
                const parent = dirname(head);
                if (parent === head) {
                    if (lexical !== this.cwd && !lexical.startsWith(this.cwd + sep)) {
                        throw new Error(`Path traversal blocked: ${userPath}`);
                    }
                    return lexical;
                }
                tail.unshift(basename(head));
                head = parent;
            }
        }
    }

    async readFile(path: string, encoding: "utf-8"): Promise<string> {
        return await readFile(path, encoding);
    }
    async readFileBytes(path: string): Promise<Buffer> { return await readFile(path); }
    async writeFile(path: string, content: string): Promise<void> { await writeFile(path, content, "utf-8"); }
    async readDir(path: string): Promise<DirEntry[]> {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
    }
    async mkdir(path: string, recursive = false): Promise<void> { await mkdir(path, { recursive }); }
    async exists(path: string): Promise<boolean> {
        try { await access(path); return true; } catch { return false; }
    }
    async stat(path: string): Promise<FileStat> {
        const s = await fsStat(path);
        return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
    }

    buildDockerArgs(
        command: string,
        opts: { timeout?: number; cwd?: string; env?: Record<string, string> } = {},
    ): string[] {
        const cwd = opts.cwd ? this.safePath(opts.cwd) : this.cwd;
        const rel = relative(this.cwd, cwd);
        const containerCwd = rel && !rel.startsWith("..")
            ? `${this.containerWorkdir}/${rel}`.replace(/\/+/g, "/")
            : this.containerWorkdir;
        const mountMode = this.readOnlyRoot ? "ro" : "rw";
        const args = [
            "run", "--rm",
            "-v", `${this.cwd}:${this.containerWorkdir}:${mountMode}`,
            "-w", containerCwd,
        ];
        for (const [key, value] of Object.entries(opts.env ?? {})) {
            if (!SENSITIVE_ENV_RE.test(key)) args.push("-e", `${key}=${value}`);
        }
        args.push(this.image, "sh", "-lc", command);
        return args;
    }

    async exec(
        command: string,
        opts?: { timeout?: number; cwd?: string; env?: Record<string, string> },
    ): Promise<ExecResult> {
        try {
            const { stdout, stderr } = await execFile(
                this.dockerBin,
                this.buildDockerArgs(command, opts),
                { timeout: opts?.timeout ?? 30_000, maxBuffer: 1024 * 1024 },
            );
            return { stdout: stdout || "", stderr: stderr || "", exitCode: 0 };
        } catch (err: unknown) {
            const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean; code?: number };
            return {
                stdout: e.stdout ?? "",
                stderr: e.stderr ?? e.message ?? String(err),
                exitCode: typeof e.code === "number" ? e.code : 1,
                ...(e.killed ? { killed: true } : {}),
            };
        }
    }
}
