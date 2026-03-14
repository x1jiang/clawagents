/**
 * WebSocket handler for the ClawAgents gateway.
 *
 * Attaches to an existing HTTP server on the /ws path. Supports:
 *   - chat.send   — run an agent task with real-time streaming events
 *   - chat.history — retrieve session history (placeholder for future session store)
 *   - chat.inject  — inject an assistant note without triggering a run
 *   - ping         — keepalive
 */

import type { Server as HttpServer } from "node:http";
import type { LLMProvider } from "../providers/llm.js";
import { createClawAgent } from "../agent.js";
import { enqueueCommandInLane, getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { isValidRequest, makeResponse, makeEvent, type WsRequest } from "./protocol.js";

const VALID_LANES = new Set<string>(["main", "cron", "subagent", "nested"]);

interface SessionEntry {
    messages: Array<{ role: string; content: string; timestamp: number }>;
}

const sessions = new Map<string, SessionEntry>();

function resolveLane(raw?: string): string {
    const lane = (raw ?? "").trim().toLowerCase() || CommandLane.Main;
    return VALID_LANES.has(lane) ? lane : CommandLane.Main;
}

function resolveSession(id?: string): string {
    return (typeof id === "string" && id.trim()) ? id.trim() : `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getOrCreateSession(sessionId: string): SessionEntry {
    let s = sessions.get(sessionId);
    if (!s) {
        s = { messages: [] };
        sessions.set(sessionId, s);
    }
    return s;
}

export function attachWebSocket(httpServer: HttpServer, llm: LLMProvider, gatewayApiKey: string) {
    let WebSocketServerCtor: typeof import("ws").WebSocketServer | undefined;
    try {
        // ws is a peer dependency — degrade gracefully if not installed
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const wsModule = require("ws") as typeof import("ws");
        WebSocketServerCtor = wsModule.WebSocketServer ?? (wsModule as any).Server;
    } catch {
        console.log("   WebSocket: disabled (install 'ws' package to enable ws:// /ws)");
        return;
    }

    const wss = new WebSocketServerCtor({ server: httpServer, path: "/ws" });

    wss.on("connection", (ws, req) => {
        // Auth check on upgrade
        if (gatewayApiKey) {
            const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
            const token = url.searchParams.get("token") ?? "";
            if (token !== gatewayApiKey) {
                ws.close(4001, "Unauthorized");
                return;
            }
        }

        ws.on("message", async (raw) => {
            let msg: WsRequest;
            try {
                const parsed = JSON.parse(raw.toString());
                if (!isValidRequest(parsed)) {
                    ws.send(JSON.stringify(makeResponse("?", false, "Invalid frame. Expected {type:'req', id, method, params}")));
                    return;
                }
                msg = parsed;
            } catch {
                ws.send(JSON.stringify(makeResponse("?", false, "Invalid JSON")));
                return;
            }

            switch (msg.method) {
                case "ping":
                    ws.send(JSON.stringify(makeResponse(msg.id, true, { pong: Date.now() })));
                    break;

                case "chat.send":
                    await handleChatSend(ws, msg, llm);
                    break;

                case "chat.history":
                    handleChatHistory(ws, msg);
                    break;

                case "chat.inject":
                    handleChatInject(ws, msg);
                    break;

                default:
                    ws.send(JSON.stringify(makeResponse(msg.id, false, `Unknown method: ${msg.method}`)));
            }
        });
    });

    console.log("   WebSocket: enabled on ws:// /ws");
}

async function handleChatSend(ws: import("ws").WebSocket, msg: WsRequest, llm: LLMProvider) {
    const task = String(msg.params.task ?? "");
    if (!task) {
        ws.send(JSON.stringify(makeResponse(msg.id, false, "Missing 'task' parameter")));
        return;
    }

    const lane = resolveLane(msg.params.lane as string | undefined);
    const sessionId = resolveSession(msg.params.sessionId as string | undefined);
    const session = getOrCreateSession(sessionId);

    let seq = 0;
    const sendEvent = (event: string, payload: Record<string, unknown>) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(makeEvent(event, { ...payload, sessionId }, seq++)));
        }
    };

    sendEvent("queued", { lane, position: getQueueSize(lane) });

    try {
        const result = await enqueueCommandInLane(lane, async () => {
            sendEvent("started", { lane });
            const agent = await createClawAgent({ model: llm });
            return await agent.invoke(task, undefined, (kind, data) => {
                sendEvent("agent", { kind, ...data });
            });
        });

        session.messages.push(
            { role: "user", content: task, timestamp: Date.now() },
            { role: "assistant", content: result.result ?? "", timestamp: Date.now() },
        );

        ws.send(JSON.stringify(makeResponse(msg.id, true, {
            sessionId,
            lane,
            status: result.status,
            result: result.result,
            iterations: result.iterations,
        })));
    } catch (err) {
        ws.send(JSON.stringify(makeResponse(msg.id, false, String(err))));
    }
}

function handleChatHistory(ws: import("ws").WebSocket, msg: WsRequest) {
    const sessionId = resolveSession(msg.params.sessionId as string | undefined);
    const session = sessions.get(sessionId);
    ws.send(JSON.stringify(makeResponse(msg.id, true, {
        sessionId,
        messages: session?.messages ?? [],
    })));
}

function handleChatInject(ws: import("ws").WebSocket, msg: WsRequest) {
    const sessionId = resolveSession(msg.params.sessionId as string | undefined);
    const content = String(msg.params.content ?? "");
    if (!content) {
        ws.send(JSON.stringify(makeResponse(msg.id, false, "Missing 'content' parameter")));
        return;
    }
    const session = getOrCreateSession(sessionId);
    session.messages.push({ role: "assistant", content, timestamp: Date.now() });
    ws.send(JSON.stringify(makeResponse(msg.id, true, { sessionId, injected: true })));
}
