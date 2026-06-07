/** search_history tool — cross-session raw message recall. */

import { formatSearchHistoryResponse, searchHistory } from "../session/history-search.js";
import type { Tool, ToolResult } from "./registry.js";

export function createSearchHistoryTool(workspace?: string): Tool {
    const ws = workspace ?? process.cwd();

    return {
        name: "search_history",
        description:
            "Search raw messages from past agent sessions (cross-session archive). " +
            "Returns actual prior user/assistant/tool content snippets, not summaries. " +
            "For the current chat only, use the session backend search instead.",
        parameters: {
            query: { type: "string", description: "Text to search for", required: true },
            limit: { type: "integer", description: "Max hits (1-50)" },
            session_id: { type: "string", description: "Optional: restrict to one archived session id" },
            include_jsonl: { type: "boolean", description: "Also search JSONL session event logs" },
            format: { type: "string", description: "Response format: text (default) or json" },
        },
        async execute(args: Record<string, unknown>): Promise<ToolResult> {
            const query = String(args.query ?? "").trim();
            if (!query) return { success: false, output: "", error: "query is required" };
            const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 50);
            const sessionId = args.session_id ? String(args.session_id) : undefined;
            const includeJsonl = args.include_jsonl !== false;
            const hits = searchHistory(query, {
                limit,
                sessionId,
                workspace: ws,
                includeJsonl,
            });
            const asJson = String(args.format ?? "").toLowerCase() === "json";
            return {
                success: true,
                output: formatSearchHistoryResponse(query, hits, { asJson }),
            };
        },
    };
}
