/**
 * InMemoryBackend — pure in-process virtual filesystem + exec stub.
 *
 * Designed for fast, deterministic testing of the full agent loop
 * without touching the real filesystem. No temp directories, no cleanup.
 *
 * Usage:
 *   const mem = new InMemoryBackend("/project");
 *   mem.seed({ "src/index.ts": "console.log('hi');" });
 *   const tools = createFilesystemTools(mem);
 */

import type {
    SandboxBackend,
    DirEntry,
    FileStat,
    ExecResult,
} from "./backend.js";

interface VFSNode {
    kind: "file" | "dir";
    content?: string;
    bytes?: Buffer;
    mtimeMs: number;
}

export type ExecStub = (
    command: string,
    opts?: { timeout?: number; cwd?: string; env?: Record<string, string> },
) => Promise<ExecResult> | ExecResult;

export class InMemoryBackend implements SandboxBackend {
    readonly kind = "memory" as const;
    readonly cwd: string;
    readonly sep = "/";

    private nodes = new Map<string, VFSNode>();
    private execStub: ExecStub;

    constructor(root = "/project", execStub?: ExecStub) {
        this.cwd = root;
        this.execStub = execStub ?? (async () => ({ stdout: "", stderr: "exec not available in memory backend", exitCode: 1 }));
        this.nodes.set(this.normalize(root), { kind: "dir", mtimeMs: Date.now() });
    }

    /**
     * Pre-populate the VFS with files. Keys are paths relative to cwd.
     *
     * @example mem.seed({ "src/index.ts": "hello", "README.md": "# hi" })
     */
    seed(files: Record<string, string | Buffer>): void {
        for (const [relPath, content] of Object.entries(files)) {
            const abs = this.resolve(relPath);
            this.ensureParentDirs(abs);
            if (typeof content === "string") {
                this.nodes.set(abs, { kind: "file", content, mtimeMs: Date.now() });
            } else {
                this.nodes.set(abs, { kind: "file", bytes: content, mtimeMs: Date.now() });
            }
        }
    }

    /** Return a snapshot of all files (relative paths → contents). */
    snapshot(): Record<string, string> {
        const result: Record<string, string> = {};
        for (const [abs, node] of this.nodes) {
            if (node.kind === "file") {
                const rel = this.relative(this.cwd, abs);
                result[rel] = node.content ?? (node.bytes?.toString("utf-8") ?? "");
            }
        }
        return result;
    }

    // ── Path helpers ────────────────────────────────────────────────

    resolve(...segments: string[]): string {
        let path = segments.reduce((base, seg) => {
            if (seg.startsWith("/")) return seg;
            return base + "/" + seg;
        }, this.cwd);
        return this.normalize(path);
    }

    relative(from: string, to: string): string {
        const f = this.normalize(from);
        const t = this.normalize(to);
        if (t.startsWith(f + "/")) return t.slice(f.length + 1);
        if (t === f) return ".";
        return t;
    }

    dirname(path: string): string {
        const n = this.normalize(path);
        const idx = n.lastIndexOf("/");
        return idx > 0 ? n.slice(0, idx) : "/";
    }

    basename(path: string): string {
        const n = this.normalize(path);
        const idx = n.lastIndexOf("/");
        return idx >= 0 ? n.slice(idx + 1) : n;
    }

    join(...segments: string[]): string {
        return this.normalize(segments.join("/"));
    }

    safePath(userPath: string): string {
        const resolved = this.resolve(userPath);
        if (resolved !== this.cwd && !resolved.startsWith(this.cwd + "/")) {
            throw new Error(`Path traversal blocked: ${userPath}`);
        }
        return resolved;
    }

    // ── File I/O ────────────────────────────────────────────────────

    async readFile(path: string, _encoding: "utf-8"): Promise<string> {
        const n = this.normalize(path);
        const node = this.nodes.get(n);
        if (!node || node.kind !== "file") throw new Error(`ENOENT: no such file: ${path}`);
        return node.content ?? (node.bytes?.toString("utf-8") ?? "");
    }

    async readFileBytes(path: string): Promise<Buffer> {
        const n = this.normalize(path);
        const node = this.nodes.get(n);
        if (!node || node.kind !== "file") throw new Error(`ENOENT: no such file: ${path}`);
        if (node.bytes) return node.bytes;
        return Buffer.from(node.content ?? "", "utf-8");
    }

    async writeFile(path: string, content: string): Promise<void> {
        const n = this.normalize(path);
        this.ensureParentDirs(n);
        this.nodes.set(n, { kind: "file", content, mtimeMs: Date.now() });
    }

    // ── Directory operations ────────────────────────────────────────

    async readDir(path: string): Promise<DirEntry[]> {
        const n = this.normalize(path);
        const node = this.nodes.get(n);
        if (!node || node.kind !== "dir") throw new Error(`ENOTDIR: not a directory: ${path}`);

        const prefix = n + "/";
        const seen = new Set<string>();
        const entries: DirEntry[] = [];

        for (const key of this.nodes.keys()) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const name = rest.split("/")[0]!;
            if (seen.has(name)) continue;
            seen.add(name);

            const childPath = prefix + name;
            const child = this.nodes.get(childPath);
            entries.push({
                name,
                isDirectory: child?.kind === "dir" || rest.includes("/"),
                isFile: child?.kind === "file" && !rest.includes("/"),
            });
        }

        return entries.sort((a, b) => a.name.localeCompare(b.name));
    }

    async mkdir(path: string, recursive = false): Promise<void> {
        const n = this.normalize(path);
        if (this.nodes.has(n)) return;
        if (recursive) {
            this.ensureParentDirs(n + "/dummy");
            this.nodes.set(n, { kind: "dir", mtimeMs: Date.now() });
        } else {
            const parent = this.dirname(n);
            const pNode = this.nodes.get(parent);
            if (!pNode || pNode.kind !== "dir") throw new Error(`ENOENT: parent not found: ${parent}`);
            this.nodes.set(n, { kind: "dir", mtimeMs: Date.now() });
        }
    }

    // ── Metadata ────────────────────────────────────────────────────

    async exists(path: string): Promise<boolean> {
        const n = this.normalize(path);
        if (this.nodes.has(n)) return true;
        const prefix = n + "/";
        for (const key of this.nodes.keys()) {
            if (key.startsWith(prefix)) return true;
        }
        return false;
    }

    async stat(path: string): Promise<FileStat> {
        const n = this.normalize(path);
        const node = this.nodes.get(n);
        if (node) {
            return {
                isFile: node.kind === "file",
                isDirectory: node.kind === "dir",
                size: node.content?.length ?? node.bytes?.length ?? 0,
                mtimeMs: node.mtimeMs,
            };
        }
        const prefix = n + "/";
        for (const key of this.nodes.keys()) {
            if (key.startsWith(prefix)) {
                return { isFile: false, isDirectory: true, size: 0, mtimeMs: Date.now() };
            }
        }
        throw new Error(`ENOENT: no such file or directory: ${path}`);
    }

    // ── Command execution ───────────────────────────────────────────

    async exec(
        command: string,
        opts?: { timeout?: number; cwd?: string; env?: Record<string, string> },
    ): Promise<ExecResult> {
        return await this.execStub(command, opts);
    }

    // ── Internal ────────────────────────────────────────────────────

    private normalize(p: string): string {
        const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
        const stack: string[] = [];
        for (const part of parts) {
            if (part === "..") { stack.pop(); }
            else if (part !== ".") { stack.push(part); }
        }
        return "/" + stack.join("/");
    }

    private ensureParentDirs(absPath: string): void {
        const parts = absPath.split("/").filter(Boolean);
        let current = "";
        for (let i = 0; i < parts.length - 1; i++) {
            current += "/" + parts[i];
            if (!this.nodes.has(current)) {
                this.nodes.set(current, { kind: "dir", mtimeMs: Date.now() });
            }
        }
    }
}
