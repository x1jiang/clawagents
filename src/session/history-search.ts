/** Cross-session message archive search (SQLite messages + JSONL event logs).

Use searchSessionMessages / SqliteSession.search() for the **current** session.
This module searches the **archive** across sessions.
*/

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getClawagentsWorkspaceDir, getSessionsDir } from "../paths.js";
import { searchSqliteMessages } from "./search.js";
import { snippetFromContent } from "./snippet.js";

export interface HistorySearchHit {
    sessionId: string;
    source: "sqlite" | "jsonl";
    role: string;
    content: string;
    snippet: string;
    messageId?: number;
    ord?: number;
    ts?: number;
}

function resolveArchivePaths(workspace?: string): { dbPath: string; jsonlDir: string } {
    if (workspace) {
        return {
            dbPath: join(workspace, ".clawagents", "sessions.db"),
            jsonlDir: join(workspace, ".clawagents", "sessions"),
        };
    }
    const ws = getClawagentsWorkspaceDir();
    return {
        dbPath: join(ws, "sessions.db"),
        jsonlDir: getSessionsDir({ scope: "workspace" }),
    };
}

export function searchSqliteHistory(
    dbPath: string,
    query: string,
    opts: { limit?: number; sessionId?: string } = {},
): HistorySearchHit[] {
    const token = query.trim();
    const limit = opts.limit ?? 20;
    if (!token || !existsSync(dbPath)) return [];

    let db: DatabaseSync;
    try {
        db = new DatabaseSync(dbPath);
    } catch {
        return [];
    }
    try {
        const rows = searchSqliteMessages(db, query, {
            limit,
            sessionId: opts.sessionId,
            orderDesc: true,
        });
        return rows.map((row) => {
            const content = row.content.slice(0, 4000);
            return {
                sessionId: row.sessionId,
                source: "sqlite" as const,
                messageId: row.messageId,
                ord: row.ord,
                role: row.role,
                content,
                snippet: snippetFromContent(content, token),
            };
        });
    } finally {
        db.close();
    }
}

export function searchJsonlHistory(
    sessionsDir: string,
    query: string,
    limit = 20,
): HistorySearchHit[] {
    const token = query.trim().toLowerCase();
    if (!token || !existsSync(sessionsDir)) return [];

    const hits: HistorySearchHit[] = [];
    const files = readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(sessionsDir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

    for (const path of files) {
        if (hits.length >= limit) break;
        const sessionId = path.split("/").pop()?.replace(/\.jsonl$/, "") ?? "unknown";
        try {
            const lines = readFileSync(path, "utf-8").split("\n");
            for (const line of lines) {
                if (!line.trim()) continue;
                const ev = JSON.parse(line) as Record<string, unknown>;
                const evType = String(ev.type ?? "");
                let role = "";
                let content = "";
                if (evType === "assistant_message") {
                    role = "assistant";
                    content = String(ev.content ?? "");
                } else if (evType === "tool_result") {
                    role = "tool";
                    content = String(ev.output ?? "");
                } else {
                    continue;
                }
                if (!content.toLowerCase().includes(token)) continue;
                hits.push({
                    sessionId,
                    source: "jsonl",
                    role,
                    content: content.slice(0, 4000),
                    snippet: snippetFromContent(content, query.trim()),
                    ts: typeof ev.ts === "number" ? ev.ts : undefined,
                });
                if (hits.length >= limit) break;
            }
        } catch {
            continue;
        }
    }
    return hits;
}

export function searchHistory(
    query: string,
    opts: {
        limit?: number;
        sessionId?: string;
        workspace?: string;
        includeJsonl?: boolean;
    } = {},
): HistorySearchHit[] {
    const { dbPath, jsonlDir } = resolveArchivePaths(opts.workspace);
    const limit = Math.max(1, opts.limit ?? 20);
    const hits = searchSqliteHistory(dbPath, query, {
        limit,
        sessionId: opts.sessionId,
    });
    const remaining = limit - hits.length;
    if (opts.includeJsonl !== false && remaining > 0 && !opts.sessionId) {
        hits.push(...searchJsonlHistory(jsonlDir, query, remaining));
    }
    return hits.slice(0, limit);
}

export function serializeHistoryHits(hits: HistorySearchHit[]): Array<Record<string, unknown>> {
    return hits.map((h) => ({
        session_id: h.sessionId,
        source: h.source,
        role: h.role,
        content: h.content,
        snippet: h.snippet,
        message_id: h.messageId ?? null,
        ord: h.ord ?? null,
        ts: h.ts ?? null,
    }));
}

export function formatHistoryHits(hits: HistorySearchHit[]): string {
    if (!hits.length) return "No matching messages in past sessions.";
    return hits.map((h) => {
        const loc = h.ord != null ? `${h.sessionId}#${h.ord}` : h.sessionId;
        return `- [${h.source}] ${loc} (${h.role})\n  ${h.snippet.trim()}`;
    }).join("\n");
}

export function formatSearchHistoryResponse(
    query: string,
    hits: HistorySearchHit[],
    opts: { asJson?: boolean } = {},
): string {
    if (opts.asJson) {
        return JSON.stringify({ query, hits: serializeHistoryHits(hits) }, null, 2);
    }
    return `Found ${hits.length} match(es) for '${query}':\n${formatHistoryHits(hits)}`;
}
