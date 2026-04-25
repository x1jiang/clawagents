/**
 * ACP wire-format message types and codec helpers.
 *
 * These mirror the relevant subset of Zed's Agent Client Protocol so
 * library users can construct, log, and round-trip ACP frames in tests
 * without installing any optional extras. Mirrors
 * `clawagents.acp.messages` on the Python side.
 */

import * as crypto from "node:crypto";

export type StopReason =
    | "end_turn"
    | "max_tokens"
    | "max_turn_requests"
    | "refusal"
    | "cancelled"
    | "error";

export const StopReasonValues = {
    END_TURN: "end_turn" as const,
    MAX_TOKENS: "max_tokens" as const,
    MAX_TURN_REQUESTS: "max_turn_requests" as const,
    REFUSAL: "refusal" as const,
    CANCELLED: "cancelled" as const,
    ERROR: "error" as const,
} as const;

function newId(prefix: string): string {
    return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

// ── Inbound: prompt request ─────────────────────────────────────────

export interface PromptRequest {
    sessionId: string;
    text: string;
    /** Original ACP content blocks, preserved for non-text consumers. */
    blocks: Record<string, unknown>[];
    /** Original raw payload, untouched. */
    raw?: Record<string, unknown>;
}

export function promptFromDict(
    payload: Record<string, unknown>
): PromptRequest {
    const sessionId = String(
        (payload.sessionId as string | undefined) ??
            (payload.session_id as string | undefined) ??
            ""
    );
    const promptVal = payload.prompt;
    const blocks: Record<string, unknown>[] = Array.isArray(promptVal)
        ? (promptVal as Record<string, unknown>[])
        : promptVal && typeof promptVal === "object"
          ? [promptVal as Record<string, unknown>]
          : [];
    const textParts: string[] = [];
    for (const block of blocks) {
        if (block && block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
        }
    }
    return {
        sessionId,
        text: textParts.join("\n"),
        blocks: [...blocks],
        raw: { ...payload },
    };
}

export function promptToDict(req: PromptRequest): Record<string, unknown> {
    return {
        sessionId: req.sessionId,
        prompt:
            req.blocks.length > 0
                ? [...req.blocks]
                : [{ type: "text", text: req.text }],
    };
}

// ── Outbound: session/update variants ───────────────────────────────

export interface AgentMessageChunk {
    kind: "message";
    text: string;
}

export function agentMessageChunk(text: string): AgentMessageChunk {
    return { kind: "message", text };
}

export interface AgentThoughtChunk {
    kind: "thought";
    text: string;
}

export function agentThoughtChunk(text: string): AgentThoughtChunk {
    return { kind: "thought", text };
}

export interface ToolCallStart {
    kind: "tool_call_start";
    toolCallId: string;
    name: string;
    arguments: Record<string, unknown>;
    label?: string;
}

export function toolCallStart(
    name: string,
    args: Record<string, unknown> = {},
    label?: string
): ToolCallStart {
    return {
        kind: "tool_call_start",
        toolCallId: newId("tc"),
        name,
        arguments: { ...args },
        label,
    };
}

export interface ToolCallComplete {
    kind: "tool_call_complete";
    toolCallId: string;
    name: string;
    output?: unknown;
    error?: string;
    arguments?: Record<string, unknown>;
}

export type SessionUpdate =
    | AgentMessageChunk
    | AgentThoughtChunk
    | ToolCallStart
    | ToolCallComplete;

// ── Bidirectional: permission request / decision ────────────────────

export interface PermissionRequest {
    toolCallId: string;
    name: string;
    arguments: Record<string, unknown>;
    description?: string;
}

export interface PermissionDecision {
    allowed: boolean;
    rationale?: string;
    /** ``true`` if the decision should not be remembered. */
    oneTime: boolean;
}

export function permissionDecisionFromDict(
    payload: Record<string, unknown>
): PermissionDecision {
    const outcomeRaw =
        (payload.outcome as Record<string, unknown> | undefined) ??
        (payload.decision as Record<string, unknown> | undefined) ??
        "denied";
    let kind: string;
    if (typeof outcomeRaw === "object" && outcomeRaw !== null) {
        kind = String(
            (outcomeRaw.kind as string | undefined) ??
                (outcomeRaw.type as string | undefined) ??
                "denied"
        );
    } else {
        kind = String(outcomeRaw);
    }
    const allowed = ["allow", "allowed", "approve", "approved"].includes(
        kind.toLowerCase()
    );
    const rationale =
        (payload.rationale as string | undefined) ??
        (payload.reason as string | undefined);
    return {
        allowed,
        rationale: rationale ? String(rationale) : undefined,
        oneTime: !payload.remember,
    };
}

// ── Codec helpers ───────────────────────────────────────────────────

export function encodeUpdate(update: SessionUpdate): Record<string, unknown> {
    switch (update.kind) {
        case "message":
            return {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: update.text },
            };
        case "thought":
            return {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: update.text },
            };
        case "tool_call_start":
            return {
                sessionUpdate: "tool_call",
                toolCallId: update.toolCallId,
                name: update.name,
                label: update.label ?? update.name,
                status: "in_progress",
                rawInput: { ...update.arguments },
            };
        case "tool_call_complete": {
            const status = update.error ? "failed" : "completed";
            const out: Record<string, unknown> = {
                sessionUpdate: "tool_call_update",
                toolCallId: update.toolCallId,
                status,
                name: update.name,
            };
            const blocks: Record<string, unknown>[] = [];
            if (update.error) {
                blocks.push({ type: "text", text: String(update.error) });
            } else if (update.output !== undefined && update.output !== null) {
                const text =
                    typeof update.output === "string"
                        ? update.output
                        : safeStringify(update.output);
                blocks.push({ type: "text", text });
            }
            if (blocks.length > 0) {
                out.content = blocks;
            }
            if (update.arguments !== undefined) {
                out.rawInput = { ...update.arguments };
            }
            return out;
        }
    }
}

export function decodeUpdate(
    payload: Record<string, unknown>
): SessionUpdate {
    const kind = payload.sessionUpdate;
    switch (kind) {
        case "agent_message_chunk":
            return {
                kind: "message",
                text: String(
                    ((payload.content as Record<string, unknown> | undefined)
                        ?.text as string | undefined) ?? ""
                ),
            };
        case "agent_thought_chunk":
            return {
                kind: "thought",
                text: String(
                    ((payload.content as Record<string, unknown> | undefined)
                        ?.text as string | undefined) ?? ""
                ),
            };
        case "tool_call":
            return {
                kind: "tool_call_start",
                toolCallId: String(payload.toolCallId ?? newId("tc")),
                name: String(payload.name ?? ""),
                arguments: {
                    ...((payload.rawInput as Record<string, unknown> | undefined) ??
                        {}),
                },
                label: payload.label ? String(payload.label) : undefined,
            };
        case "tool_call_update": {
            const content = payload.content;
            let textOut: string | undefined;
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (
                        block &&
                        typeof block === "object" &&
                        (block as Record<string, unknown>).type === "text"
                    ) {
                        textOut = String(
                            (block as Record<string, unknown>).text ?? ""
                        );
                        break;
                    }
                }
            }
            const status = String(payload.status ?? "completed").toLowerCase();
            return {
                kind: "tool_call_complete",
                toolCallId: String(payload.toolCallId ?? ""),
                name: String(payload.name ?? ""),
                output: status !== "failed" ? textOut : undefined,
                error: status === "failed" ? textOut : undefined,
                arguments: payload.rawInput
                    ? {
                          ...(payload.rawInput as Record<string, unknown>),
                      }
                    : undefined,
            };
        }
        default:
            throw new Error(`Unknown sessionUpdate variant: ${String(kind)}`);
    }
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
