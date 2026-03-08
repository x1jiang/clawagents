/**
 * SandboxBackend — unified abstraction over filesystem + command execution.
 *
 * Implementations:
 *   LocalBackend    — thin wrapper over node:fs  (production)
 *   InMemoryBackend — pure in-process VFS        (testing)
 *   DockerBackend   — ephemeral containers        (future)
 */

export interface DirEntry {
    name: string;
    isDirectory: boolean;
    isFile: boolean;
}

export interface FileStat {
    isFile: boolean;
    isDirectory: boolean;
    size: number;
    mtimeMs: number;
}

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    killed?: boolean;
}

export interface SandboxBackend {
    /** Human-readable label (e.g. "local", "memory", "docker"). */
    readonly kind: string;

    /** Working directory root for this sandbox. */
    readonly cwd: string;

    /** Platform path separator. */
    readonly sep: string;

    // ── Path helpers (pure, no I/O) ─────────────────────────────────

    resolve(...segments: string[]): string;
    relative(from: string, to: string): string;
    dirname(path: string): string;
    basename(path: string): string;
    join(...segments: string[]): string;

    /**
     * Validate & resolve a user-supplied path against the sandbox root.
     * Throws on traversal attempts. Equivalent to the old `safePath()`.
     */
    safePath(userPath: string): string;

    // ── File I/O ────────────────────────────────────────────────────

    readFile(path: string, encoding: "utf-8"): Promise<string>;
    readFileBytes(path: string): Promise<Buffer>;
    writeFile(path: string, content: string, encoding?: "utf-8"): Promise<void>;

    // ── Directory operations ────────────────────────────────────────

    readDir(path: string): Promise<DirEntry[]>;
    mkdir(path: string, recursive?: boolean): Promise<void>;

    // ── Metadata ────────────────────────────────────────────────────

    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<FileStat>;

    // ── Command execution ───────────────────────────────────────────

    exec(
        command: string,
        opts?: { timeout?: number; cwd?: string; env?: Record<string, string> },
    ): Promise<ExecResult>;
}
