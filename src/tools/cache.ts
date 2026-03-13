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
