/**
 * Tool Result Cache — LRU in-memory cache with per-tool TTLs.
 *
 * Inspired by ToolUniverse's two-tier caching: avoids redundant API calls,
 * file reads, and web fetches when the agent re-invokes the same tool with
 * identical arguments within the TTL window.
 *
 * Tools opt in via `cacheable: true` on the Tool interface.
 */

import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import type { ToolResult } from "./registry.js";

interface CacheEntry {
    toolName: string;
    result: ToolResult;
    createdAt: number;
}

export class ResultCacheManager {
    private cache = new Map<string, CacheEntry>();
    private maxSize: number;
    private defaultTtlMs: number;
    private toolTtls = new Map<string, number>();

    constructor(maxSize = 256, defaultTtlMs = 60_000) {
        this.maxSize = maxSize;
        this.defaultTtlMs = defaultTtlMs;
    }

    setToolTtl(toolName: string, ttlMs: number): void {
        this.toolTtls.set(toolName, ttlMs);
    }

    private buildKey(toolName: string, args: Record<string, unknown>): string {
        const sortedArgs: Record<string, unknown> = {};
        for (const k of Object.keys(args).sort()) sortedArgs[k] = args[k];
        const payload = toolName + "\0" + JSON.stringify(sortedArgs);
        return createHash("sha256").update(payload).digest("hex").slice(0, 32);
    }

    get(toolName: string, args: Record<string, unknown>): ToolResult | undefined {
        const key = this.buildKey(toolName, args);
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        const ttl = this.toolTtls.get(toolName) ?? this.defaultTtlMs;
        if (Date.now() - entry.createdAt > ttl) {
            this.cache.delete(key);
            return undefined;
        }

        // LRU promotion: move to end
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.result;
    }

    set(toolName: string, args: Record<string, unknown>, result: ToolResult): void {
        const key = this.buildKey(toolName, args);

        if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
        }

        this.cache.set(key, { toolName, result, createdAt: Date.now() });
    }

    invalidateTool(toolName: string): void {
        for (const [key, entry] of this.cache) {
            if (entry.toolName === toolName) {
                this.cache.delete(key);
            }
        }
    }

    clear(): void {
        this.cache.clear();
    }

    get size(): number {
        return this.cache.size;
    }
}

export interface SqliteResultCacheOptions {
    dbPath: string;
    maxSize?: number;
    defaultTtlMs?: number;
    persistDenylist?: Iterable<string> | false;
}

const DEFAULT_PERSIST_DENYLIST = new Set(["read_file", "grep", "web_fetch", "explorer_read_source"]);

/**
 * SQLite-backed result cache.
 *
 * Uses Node's built-in `node:sqlite` when available. This keeps persistent
 * caching dependency-free and opt-in: normal imports still use the in-memory
 * cache, while callers that want cross-process/offline reuse can construct
 * this manager explicitly and pass it to a registry.
 */
export class SqliteResultCacheManager extends ResultCacheManager {
    private db: any;
    private maxRows: number;
    private sqliteDefaultTtlMs: number;
    private sqliteToolTtls = new Map<string, number>();
    private persistDenylist: Set<string>;

    constructor(opts: SqliteResultCacheOptions) {
        super(0, opts.defaultTtlMs ?? 60_000);
        this.maxRows = opts.maxSize ?? 2048;
        this.sqliteDefaultTtlMs = opts.defaultTtlMs ?? 60_000;
        this.persistDenylist = new Set(
            Array.from(opts.persistDenylist === false ? [] : opts.persistDenylist ?? DEFAULT_PERSIST_DENYLIST)
                .map((name) => name.toLowerCase()),
        );
        const require = createRequire(import.meta.url);
        let mod: any;
        try {
            mod = require("node:sqlite");
        } catch (err) {
            throw new Error(
                "SqliteResultCacheManager requires node:sqlite. " +
                `Use ResultCacheManager on older Node versions. Original: ${String(err)}`,
            );
        }
        const Database = mod.DatabaseSync ?? mod.default?.DatabaseSync;
        if (!Database) throw new Error("node:sqlite did not expose DatabaseSync");
        this.db = new Database(opts.dbPath);
        try { chmodSync(opts.dbPath, 0o600); } catch { /* best-effort on platforms without POSIX modes */ }
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tool_cache (
                cache_key TEXT PRIMARY KEY,
                tool_name TEXT NOT NULL,
                args_json TEXT NOT NULL,
                result_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_accessed INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tool_cache_tool ON tool_cache(tool_name);
            CREATE INDEX IF NOT EXISTS idx_tool_cache_lru ON tool_cache(last_accessed);
        `);
    }

    override setToolTtl(toolName: string, ttlMs: number): void {
        this.sqliteToolTtls.set(toolName, ttlMs);
    }

    private key(toolName: string, args: Record<string, unknown>): string {
        const sortedArgs: Record<string, unknown> = {};
        for (const k of Object.keys(args).sort()) sortedArgs[k] = args[k];
        return createHash("sha256")
            .update(JSON.stringify({ t: toolName, a: sortedArgs }))
            .digest("hex")
            .slice(0, 32);
    }

    private canPersist(toolName: string): boolean {
        return !this.persistDenylist.has(toolName.toLowerCase());
    }

    override get(toolName: string, args: Record<string, unknown>): ToolResult | undefined {
        if (!this.canPersist(toolName)) return undefined;
        const key = this.key(toolName, args);
        const row = this.db
            .prepare("SELECT result_json, created_at FROM tool_cache WHERE cache_key = ?")
            .get(key) as { result_json: string; created_at: number } | undefined;
        if (!row) return undefined;

        const ttl = this.sqliteToolTtls.get(toolName) ?? this.sqliteDefaultTtlMs;
        const now = Date.now();
        if (now - row.created_at > ttl) {
            this.db.prepare("DELETE FROM tool_cache WHERE cache_key = ?").run(key);
            return undefined;
        }

        this.db.prepare("UPDATE tool_cache SET last_accessed = ? WHERE cache_key = ?").run(now, key);
        return JSON.parse(row.result_json) as ToolResult;
    }

    override set(toolName: string, args: Record<string, unknown>, result: ToolResult): void {
        if (!this.canPersist(toolName)) return;
        const now = Date.now();
        const key = this.key(toolName, args);
        this.db.prepare(`
            INSERT OR REPLACE INTO tool_cache
                (cache_key, tool_name, args_json, result_json, created_at, last_accessed)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(key, toolName, JSON.stringify(args), JSON.stringify(result), now, now);

        const row = this.db.prepare("SELECT COUNT(*) AS n FROM tool_cache").get() as { n: number };
        if (row.n > this.maxRows) {
            this.db.prepare(`
                DELETE FROM tool_cache
                WHERE cache_key IN (
                    SELECT cache_key FROM tool_cache
                    ORDER BY last_accessed ASC
                    LIMIT ?
                )
            `).run(row.n - this.maxRows);
        }
    }

    override invalidateTool(toolName: string): void {
        this.db.prepare("DELETE FROM tool_cache WHERE tool_name = ?").run(toolName);
    }

    override clear(): void {
        this.db.prepare("DELETE FROM tool_cache").run();
    }

    override get size(): number {
        const row = this.db.prepare("SELECT COUNT(*) AS n FROM tool_cache").get() as { n: number };
        return row.n;
    }
}
