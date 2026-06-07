/** FTS5 session search (Hermes 0.16 pattern). */

import type { DatabaseSync } from "node:sqlite";

import { snippetFromContent } from "./snippet.js";

export { snippetFromContent } from "./snippet.js";

export interface SessionSearchHit {
    messageId: number;
    ord: number;
    role: string;
    snippet: string;
    rank: number;
}

export interface SqliteSearchRow {
    sessionId: string;
    messageId: number;
    ord: number;
    role: string;
    content: string;
}

/**
 * Ensure FTS5 virtual table and insert sync trigger exist.
 * Uses standalone FTS (not external content=) for node:sqlite compatibility.
 * Delete sync is omitted — node:sqlite rejects FTS5 'delete' rows; search JOINs live messages.
 */
export function ensureFts5(db: { exec: (sql: string) => void }): void {
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            session_id UNINDEXED,
            role,
            content
        );
    `);
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, session_id, role, content)
          VALUES (new.id, new.session_id, json_extract(new.payload, '$.role'),
                  json_extract(new.payload, '$.content'));
        END;
    `);
}

export function rebuildFts5(db: { exec: (sql: string) => void }): void {
    ensureFts5(db);
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
}

function ftsMatchQuery(term: string): string {
    const trimmed = term.trim();
    if (!trimmed) return '""';
    return `"${trimmed.replace(/"/g, '""')}"`;
}

/** Shared SQLite LIKE search for in-session and cross-session archive queries. */
export function searchSqliteMessages(
    db: Pick<DatabaseSync, "prepare">,
    query: string,
    opts: { limit?: number; sessionId?: string; orderDesc?: boolean } = {},
): SqliteSearchRow[] {
    const token = query.trim();
    const limit = opts.limit ?? 20;
    if (!token) return [];
    const order = opts.orderDesc === false ? "ord ASC" : "id DESC";
    const pattern = `%${token.toLowerCase()}%`;
    const rows = opts.sessionId
        ? db.prepare(
            `SELECT session_id, id, ord,
                    coalesce(json_extract(payload, '$.role'), '') AS role,
                    coalesce(json_extract(payload, '$.content'), '') AS content
             FROM messages
             WHERE session_id = ? AND lower(payload) LIKE ?
             ORDER BY ${order}
             LIMIT ?`,
        ).all(opts.sessionId, pattern, limit)
        : db.prepare(
            `SELECT session_id, id, ord,
                    coalesce(json_extract(payload, '$.role'), '') AS role,
                    coalesce(json_extract(payload, '$.content'), '') AS content
             FROM messages
             WHERE lower(payload) LIKE ?
             ORDER BY ${order}
             LIMIT ?`,
        ).all(pattern, limit);

    return rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
            sessionId: String(r.session_id ?? ""),
            messageId: Number(r.id),
            ord: Number(r.ord),
            role: String(r.role ?? ""),
            content: String(r.content ?? ""),
        };
    });
}

function searchWithLike(
    db: Pick<DatabaseSync, "prepare">,
    sessionId: string,
    query: string,
    limit: number,
): SessionSearchHit[] {
    const token = query.trim();
    if (!token) return [];
    return searchSqliteMessages(db, query, { limit, sessionId, orderDesc: false }).map((row) => ({
        messageId: row.messageId,
        ord: row.ord,
        role: row.role,
        snippet: snippetFromContent(row.content, token),
        rank: 1,
    }));
}

function searchWithFts(
    db: Pick<DatabaseSync, "prepare">,
    sessionId: string,
    query: string,
    limit: number,
): SessionSearchHit[] {
    const stmt = db.prepare(`
        SELECT m.id, m.ord, json_extract(m.payload, '$.role') as role,
               snippet(messages_fts, 2, '[', ']', '…', 32) as snippet,
               rank
        FROM messages_fts f
        JOIN messages m ON m.id = f.rowid
        WHERE f.session_id = ? AND messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
    `);
    const rows = stmt.all(sessionId, ftsMatchQuery(query), limit) as Array<{
        id: number;
        ord: number;
        role: string | null;
        snippet: string | null;
        rank: number;
    }>;
    return rows.map((row) => ({
        messageId: row.id,
        ord: row.ord,
        role: row.role ?? "",
        snippet: row.snippet ?? "",
        rank: Number(row.rank),
    }));
}

export function searchSessionMessages(
    db: Pick<DatabaseSync, "prepare"> & { exec?: (sql: string) => void },
    sessionId: string,
    query: string,
    opts: { limit?: number } = {},
): SessionSearchHit[] {
    const limit = opts.limit ?? 20;
    const token = query.trim();
    if (!token) return [];

    if (db.exec) {
        try {
            ensureFts5(db as { exec: (sql: string) => void });
            const ftsHits = searchWithFts(db, sessionId, token, limit);
            if (ftsHits.length > 0) return ftsHits;
        } catch {
            // Fall back to LIKE when FTS5 is unavailable or misconfigured.
        }
    }
    return searchWithLike(db, sessionId, token, limit);
}

export function formatSearchHits(hits: SessionSearchHit[]): string {
    if (hits.length === 0) return "No matches.";
    return hits.map((h) => `- #${h.ord} (${h.role}) ${h.snippet.trim()}`).join("\n");
}
