import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig, getDefaultModel } from "../config/config.js";
import { createProvider, type LLMProvider } from "../providers/llm.js";
import {
    enqueueCommandInLane,
    getQueueSize,
    getTotalQueueSize,
    getActiveTaskCount,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { createClawAgent } from "../agent.js";
import { attachWebSocket } from "./ws.js";

const VALID_LANES = new Set<string>(["main", "cron", "subagent", "nested"]);

function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
            body += chunk.toString();
            if (body.length > maxBytes) {
                req.destroy();
                reject(new Error("body_too_large"));
            }
        });
        req.on("end", () => resolve(body));
        req.on("error", reject);
    });
}

function resolveLane(raw?: string): string {
    const lane = (raw ?? "").trim().toLowerCase() || CommandLane.Main;
    return VALID_LANES.has(lane) ? lane : CommandLane.Main;
}

export async function startGateway(port: number = 3000) {
    const config = loadConfig();
    const activeModel = getDefaultModel(config);
    const llm = await createProvider(activeModel, config);
    const gatewayApiKey = process.env["GATEWAY_API_KEY"] ?? "";

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        try {
            await handleRequest(req, res, llm, activeModel, gatewayApiKey);
        } catch (err) {
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: String(err) }));
            }
        }
    });

    attachWebSocket(server, llm, gatewayApiKey);

    const authStatus = gatewayApiKey ? "enabled" : "disabled (set GATEWAY_API_KEY to enable)";
    server.listen(port, () => {
        console.log(`\n🦞 ClawAgents Gateway running on http://localhost:${port}`);
        console.log(`   Provider: ${llm.name}`);
        console.log(`   Model: ${activeModel}`);
        console.log(`   Auth: ${authStatus}`);
        console.log(`   Endpoints: POST /chat | POST /chat/stream | WS /ws | GET /queue | GET /health\n`);
    });

    return server;
}

async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    llm: LLMProvider,
    activeModel: string,
    gatewayApiKey = "",
) {
    // CORS headers
    const corsOrigins = process.env["GATEWAY_CORS_ORIGINS"] ?? "*";
    res.setHeader("Access-Control-Allow-Origin", corsOrigins);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    // Auth check for POST endpoints
    if (gatewayApiKey && req.method === "POST") {
        const authHeader = req.headers.authorization ?? "";
        const rawApiKey = req.headers["x-api-key"];
        const apiKeyHeader = Array.isArray(rawApiKey) ? rawApiKey[0] ?? "" : rawApiKey ?? "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : apiKeyHeader;
        if (token !== gatewayApiKey) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized. Set Authorization: Bearer <GATEWAY_API_KEY>" }));
            return;
        }
    }

    // GET /health
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", provider: llm.name, model: activeModel }));
        return;
    }

    // GET /queue — per-lane queue status
    if (req.method === "GET" && req.url === "/queue") {
        const status: Record<string, number> = {};
        for (const lane of VALID_LANES) {
            status[lane] = getQueueSize(lane);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            lanes: status,
            total: getTotalQueueSize(),
            active: getActiveTaskCount(),
        }));
        return;
    }

    // POST /chat — lane-routed JSON response
    if (req.method === "POST" && req.url === "/chat") {
        let body: string;
        try {
            body = await readBody(req);
        } catch {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Request body too large (max 1MB)" }));
            return;
        }

        let payload: { task?: string; lane?: string };
        try {
            payload = JSON.parse(body);
        } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: 'Invalid JSON. Send { "task": "...", "lane": "main|cron|subagent" }' }));
            return;
        }

        const task = payload.task || "Unknown task";
        const lane = resolveLane(payload.lane);

        try {
            const result = await enqueueCommandInLane(lane, async () => {
                console.log(`[Gateway] lane=${lane} task: ${task}`);
                const agent = await createClawAgent({ model: llm });
                return await agent.invoke(task);
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                success: true,
                lane,
                status: result.status,
                result: result.result,
                iterations: result.iterations,
            }));
        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, lane, error: String(err) }));
        }
        return;
    }

    // POST /chat/stream — lane-routed SSE
    if (req.method === "POST" && req.url === "/chat/stream") {
        let body: string;
        try {
            body = await readBody(req);
        } catch {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Request body too large (max 1MB)" }));
            return;
        }

        let payload: { task?: string; lane?: string };
        try {
            payload = JSON.parse(body);
        } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: 'Invalid JSON. Send { "task": "...", "lane": "main|cron|subagent" }' }));
            return;
        }

        const task = payload.task || "Unknown task";
        const lane = resolveLane(payload.lane);

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        const sse = (event: string, data: unknown) =>
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

        sse("queued", { lane, position: getQueueSize(lane) });

        try {
            const result = await enqueueCommandInLane(lane, async () => {
                sse("started", { lane });
                const agent = await createClawAgent({ model: llm });
                return await agent.invoke(task, undefined, (kind, data) => {
                    sse("agent", { kind, ...data });
                });
            });
            sse("done", {
                lane,
                status: result.status,
                result: result.result,
                iterations: result.iterations,
            });
        } catch (err) {
            sse("error", { lane, error: String(err) });
        }
        res.end();
        return;
    }

    // Fallback 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found. Use POST /chat | POST /chat/stream | GET /queue | GET /health" }));
}
