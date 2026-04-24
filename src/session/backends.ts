/**
 * Pluggable conversation-history backends.
 *
 * The {@link Session} interface describes a simple CRUD surface for
 * {@link LLMMessage} lists, keyed by a session id. Two built-in
 * backends are provided:
 *
 * - {@link InMemorySession} — ephemeral, useful for tests and notebooks.
 * - {@link SqliteSession} — local on-disk persistence via `node:sqlite`
 *   (Node 22+). If `node:sqlite` is unavailable, callers can fall back
 *   to {@link JsonlFileSession}, a single-file append-only JSONL store.
 *
 * The existing {@link SessionWriter} / {@link SessionReader} remain the
 * JSONL-based event log used by the loop for trajectory-style replay.
 * {@link Session} targets the *messages*-level abstraction callers want
 * when they simply say "give me a chat-style memory": append messages
 * on each turn, read them back on the next.
 */

import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import type { LLMMessage } from "../providers/llm.js";

export interface Session {
    readonly sessionId: string;
    getItems(limit?: number): Promise<LLMMessage[]>;
    addItems(items: Iterable<LLMMessage>): Promise<void>;
    popItem(): Promise<LLMMessage | null>;
    clearSession(): Promise<void>;
}

function cloneMessage(m: LLMMessage): LLMMessage {
    return {
        role: m.role,
        content: m.content,
        ...(m.toolCallId !== undefined ? { toolCallId: m.toolCallId } : {}),
        ...(m.toolCallsMeta !== undefined
            ? { toolCallsMeta: m.toolCallsMeta.map((tc) => ({ ...tc, args: { ...tc.args } })) }
            : {}),
        ...(m.thinking !== undefined ? { thinking: m.thinking } : {}),
    };
}

export class InMemorySession implements Session {
    readonly sessionId: string;
    private items: LLMMessage[] = [];

    constructor(sessionId: string = "default") {
        this.sessionId = sessionId;
    }

    async getItems(limit?: number): Promise<LLMMessage[]> {
        const items = this.items.map(cloneMessage);
        if (typeof limit === "number" && limit >= 0) return items.slice(-limit);
        return items;
    }

    async addItems(items: Iterable<LLMMessage>): Promise<void> {
        for (const it of items) this.items.push(cloneMessage(it));
    }

    async popItem(): Promise<LLMMessage | null> {
        if (this.items.length === 0) return null;
        return this.items.pop() ?? null;
    }

    async clearSession(): Promise<void> {
        this.items.length = 0;
    }
}

/**
 * JSONL-file-backed session — one line per message, appended on
 * write. Good when `node:sqlite` isn't available, or when callers want
 * easy human-readable logs.
 */
export class JsonlFileSession implements Session {
    readonly sessionId: string;
    readonly filePath: string;

    constructor(sessionId: string, options: { filePath?: string; dir?: string } = {}) {
        this.sessionId = sessionId;
        if (options.filePath) {
            this.filePath = resolve(options.filePath);
        } else {
            const dir = options.dir
                ? resolve(options.dir)
                : resolve(process.cwd(), ".clawagents", "sessions-memory");
            this.filePath = resolve(dir, `${sessionId}.jsonl`);
        }
        mkdirSync(dirname(this.filePath), { recursive: true });
    }

    async getItems(limit?: number): Promise<LLMMessage[]> {
        if (!existsSync(this.filePath)) return [];
        const content = readFileSync(this.filePath, "utf-8");
        const items: LLMMessage[] = [];
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                items.push(JSON.parse(trimmed) as LLMMessage);
            } catch {
                // skip malformed
            }
        }
        if (typeof limit === "number" && limit >= 0) return items.slice(-limit);
        return items;
    }

    async addItems(items: Iterable<LLMMessage>): Promise<void> {
        const arr = Array.from(items);
        if (arr.length === 0) return;
        const payload = arr.map((m) => JSON.stringify(cloneMessage(m))).join("\n") + "\n";
        appendFileSync(this.filePath, payload);
    }

    async popItem(): Promise<LLMMessage | null> {
        const items = await this.getItems();
        if (items.length === 0) return null;
        const popped = items.pop() ?? null;
        const rewritten = items.map((m) => JSON.stringify(cloneMessage(m))).join("\n");
        writeFileSync(this.filePath, rewritten.length ? rewritten + "\n" : "");
        return popped;
    }

    async clearSession(): Promise<void> {
        if (existsSync(this.filePath)) writeFileSync(this.filePath, "");
    }
}

/**
 * SQLite-backed session using `node:sqlite` (experimental, Node 22+).
 *
 * `import("node:sqlite")` is performed lazily in the constructor so
 * that callers on older Node versions can use {@link InMemorySession}
 * or {@link JsonlFileSession} without paying the import cost. On
 * unsupported runtimes the constructor throws a helpful error with
 * pointers to the JSONL alternative.
 */
export class SqliteSession implements Session {
    readonly sessionId: string;
    readonly dbPath: string;
    private db: any = null;
    private ready: Promise<void>;

    constructor(
        sessionId: string,
        options: { dbPath?: string } = {},
    ) {
        this.sessionId = sessionId;
        this.dbPath = resolve(
            options.dbPath ?? resolve(process.cwd(), ".clawagents", "sessions.db"),
        );
        mkdirSync(dirname(this.dbPath), { recursive: true });
        this.ready = this._init();
    }

    private async _init(): Promise<void> {
        try {
            const mod: any = await import("node:sqlite");
            const Database = mod.DatabaseSync ?? mod.default?.DatabaseSync;
            if (!Database) throw new Error("node:sqlite missing DatabaseSync");
            this.db = new Database(this.dbPath);
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    created_at REAL DEFAULT (unixepoch('now'))
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    ord INTEGER NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ord);
            `);
            this.db
                .prepare("INSERT OR IGNORE INTO sessions(session_id) VALUES (?)")
                .run(this.sessionId);
        } catch (err) {
            throw new Error(
                `SqliteSession requires node:sqlite (Node 22+ with --experimental-sqlite). ` +
                `Use JsonlFileSession or InMemorySession instead. Original: ${String(err)}`,
            );
        }
    }

    async getItems(limit?: number): Promise<LLMMessage[]> {
        await this.ready;
        if (typeof limit === "number" && limit >= 0) {
            const stmt = this.db.prepare(
                "SELECT payload FROM messages WHERE session_id = ? ORDER BY ord DESC LIMIT ?",
            );
            const rows: Array<{ payload: string }> = stmt.all(this.sessionId, limit);
            return rows
                .map((r) => JSON.parse(r.payload) as LLMMessage)
                .reverse();
        }
        const stmt = this.db.prepare(
            "SELECT payload FROM messages WHERE session_id = ? ORDER BY ord ASC",
        );
        const rows: Array<{ payload: string }> = stmt.all(this.sessionId);
        return rows.map((r) => JSON.parse(r.payload) as LLMMessage);
    }

    async addItems(items: Iterable<LLMMessage>): Promise<void> {
        await this.ready;
        const arr = Array.from(items);
        if (arr.length === 0) return;
        const row = this.db
            .prepare("SELECT COALESCE(MAX(ord), -1) AS m FROM messages WHERE session_id = ?")
            .get(this.sessionId) as { m: number } | undefined;
        let nextOrd = (row?.m ?? -1) + 1;
        const insert = this.db.prepare(
            "INSERT INTO messages(session_id, ord, payload) VALUES (?, ?, ?)",
        );
        const tx = this.db.transaction((rows: Array<[string, number, string]>) => {
            for (const r of rows) insert.run(...r);
        });
        const payload: Array<[string, number, string]> = arr.map((m, i) => [
            this.sessionId,
            nextOrd + i,
            JSON.stringify(cloneMessage(m)),
        ]);
        tx(payload);
    }

    async popItem(): Promise<LLMMessage | null> {
        await this.ready;
        const row = this.db
            .prepare(
                "SELECT id, payload FROM messages WHERE session_id = ? ORDER BY ord DESC LIMIT 1",
            )
            .get(this.sessionId) as { id: number; payload: string } | undefined;
        if (!row) return null;
        this.db.prepare("DELETE FROM messages WHERE id = ?").run(row.id);
        return JSON.parse(row.payload) as LLMMessage;
    }

    async clearSession(): Promise<void> {
        await this.ready;
        this.db
            .prepare("DELETE FROM messages WHERE session_id = ?")
            .run(this.sessionId);
    }

    /** Close the underlying database. Safe to call more than once. */
    async close(): Promise<void> {
        await this.ready.catch(() => undefined);
        if (this.db && typeof this.db.close === "function") {
            try { this.db.close(); } catch { /* ignore */ }
        }
        this.db = null;
    }
}
