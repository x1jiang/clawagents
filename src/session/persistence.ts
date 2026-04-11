/**
 * Session persistence for ClawAgents.
 *
 * Saves and restores agent sessions as append-only JSONL files.
 * Each line is a typed event: turn_started, assistant_message,
 * tool_use, tool_result, turn_completed, usage, system_prompt.
 *
 * Inspired by claw-code-main's session.rs.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import type { LLMMessage } from "../providers/llm.js";

const SESSIONS_DIR = ".clawagents/sessions";

function sessionsPath(): string {
    return resolve(process.cwd(), SESSIONS_DIR);
}

function generateSessionId(): string {
    const now = new Date();
    const ts = now.toISOString().replace(/[-:]/g, "").replace("T", "T").slice(0, 15);
    return `session-${ts}`;
}

export interface SessionInfo {
    sessionId: string;
    path: string;
    createdTs: number;
    turnCount: number;
    task: string;
    status: string;
}

export interface SessionEvent {
    type: string;
    ts: number;
    [key: string]: unknown;
}

export class SessionWriter {
    readonly sessionId: string;
    readonly path: string;
    private turnCount = 0;

    constructor(sessionId?: string) {
        this.sessionId = sessionId ?? generateSessionId();
        const dir = sessionsPath();
        mkdirSync(dir, { recursive: true });
        this.path = resolve(dir, `${this.sessionId}.jsonl`);
    }

    append(eventType: string, data?: Record<string, unknown>): void {
        const event: Record<string, unknown> = { type: eventType, ts: Date.now() / 1000 };
        if (data) Object.assign(event, data);
        appendFileSync(this.path, JSON.stringify(event) + "\n");
    }

    writeSystemPrompt(content: string): void {
        this.append("system_prompt", { content });
    }

    writeTurnStarted(iteration: number): void {
        this.turnCount++;
        this.append("turn_started", { iteration });
    }

    writeAssistantMessage(
        content: string,
        toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>,
        thinking?: string | null,
    ): void {
        const data: Record<string, unknown> = { content };
        if (toolCalls?.length) data.tool_calls = toolCalls;
        if (thinking) data.thinking = thinking;
        this.append("assistant_message", data);
    }

    writeToolResult(
        toolCallId: string,
        toolName: string,
        success: boolean,
        output: string,
        error?: string,
    ): void {
        const data: Record<string, unknown> = {
            tool_call_id: toolCallId,
            name: toolName,
            success,
            output: output.slice(0, 2000),
        };
        if (error) data.error = error.slice(0, 500);
        this.append("tool_result", data);
    }

    writeUsage(tokensUsed: number, cacheReadTokens = 0, cacheCreationTokens = 0): void {
        this.append("usage", {
            tokens_used: tokensUsed,
            cache_read_tokens: cacheReadTokens,
            cache_creation_tokens: cacheCreationTokens,
        });
    }

    writeTurnCompleted(iteration: number, toolCalls: number, status: string): void {
        this.append("turn_completed", { iteration, tool_calls: toolCalls, status });
    }
}

export class SessionReader {
    readonly events: SessionEvent[];

    constructor(readonly filePath: string) {
        this.events = [];
        const content = readFileSync(filePath, "utf-8");
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (trimmed) {
                try { this.events.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
            }
        }
    }

    reconstructMessages(): LLMMessage[] {
        const messages: LLMMessage[] = [];

        for (const ev of this.events) {
            if (ev.type === "system_prompt") {
                messages.push({ role: "system", content: ev.content as string });
            } else if (ev.type === "assistant_message") {
                const toolCalls = ev.tool_calls as Array<{ id: string; name: string; args: Record<string, unknown> }> | undefined;
                messages.push({
                    role: "assistant",
                    content: (ev.content as string) ?? "",
                    ...(toolCalls?.length ? {
                        toolCallsMeta: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args ?? {} })),
                    } : {}),
                    ...(ev.thinking ? { thinking: ev.thinking as string } : {}),
                });
            } else if (ev.type === "tool_result") {
                messages.push({
                    role: "tool",
                    content: (ev.output as string) ?? "",
                    toolCallId: ev.tool_call_id as string,
                });
            }
        }

        return messages;
    }

    getTask(): string {
        const msgs = this.reconstructMessages();
        for (const m of msgs) {
            if (m.role === "user") return typeof m.content === "string" ? m.content : String(m.content);
        }
        return "";
    }

    getSummary(): SessionInfo {
        const turnCount = this.events.filter((ev) => ev.type === "turn_completed").length;
        const task = this.getTask();
        let lastStatus = "unknown";
        for (let i = this.events.length - 1; i >= 0; i--) {
            if (this.events[i]!.type === "turn_completed") {
                lastStatus = (this.events[i]!.status as string) ?? "unknown";
                break;
            }
        }
        const created = this.events[0]?.ts ?? 0;

        return {
            sessionId: basename(this.filePath, ".jsonl"),
            path: this.filePath,
            createdTs: created,
            turnCount,
            task: task.slice(0, 100),
            status: lastStatus,
        };
    }
}

export function listSessions(limit = 20): SessionInfo[] {
    const dir = sessionsPath();
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir)
        .filter((f) => f.startsWith("session-") && f.endsWith(".jsonl"))
        .sort()
        .reverse()
        .slice(0, limit);

    const infos: SessionInfo[] = [];
    for (const f of files) {
        try {
            const reader = new SessionReader(resolve(dir, f));
            infos.push(reader.getSummary());
        } catch { /* skip malformed */ }
    }

    return infos;
}
