/**
 * JSON-RPC-style WebSocket protocol for ClawAgents Gateway.
 *
 * Follows a similar pattern to OpenClaw's gateway protocol:
 *   - Inbound: { type: "req", id, method, params }
 *   - Outbound: { type: "res", id, ok, payload?, error? }
 *   - Events:   { type: "event", event, payload, seq }
 */

export interface WsRequest {
    type: "req";
    id: string;
    method: "chat.send" | "chat.history" | "chat.inject" | "ping";
    params: Record<string, unknown>;
}

export interface WsResponse {
    type: "res";
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: string;
}

export interface WsEvent {
    type: "event";
    event: string;
    payload: Record<string, unknown>;
    seq: number;
}

export type WsOutbound = WsResponse | WsEvent;

export function isValidRequest(msg: unknown): msg is WsRequest {
    if (typeof msg !== "object" || msg === null) return false;
    const m = msg as Record<string, unknown>;
    return (
        m.type === "req" &&
        typeof m.id === "string" &&
        typeof m.method === "string" &&
        typeof m.params === "object" &&
        m.params !== null
    );
}

export function makeResponse(id: string, ok: boolean, payloadOrError: unknown): WsResponse {
    if (ok) return { type: "res", id, ok: true, payload: payloadOrError };
    return { type: "res", id, ok: false, error: String(payloadOrError) };
}

export function makeEvent(event: string, payload: Record<string, unknown>, seq: number): WsEvent {
    return { type: "event", event, payload, seq };
}
