import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig, type EngineConfig } from "../config/config.js";
import { createProvider, type LLMProvider } from "../providers/llm.js";
import { enqueueCommand } from "../process/command-queue.js";
import { runAgentGraph } from "../graph/agent-loop.js";

export function startGateway(port: number = 3000) {
    const config = loadConfig();
    const llm = createProvider(config);
    const activeModel = config.provider === "openai" ? config.openaiModel : config.geminiModel;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // Health endpoint
        if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", provider: llm.name, model: activeModel }));
            return;
        }

        // Chat endpoint
        if (req.method === "POST" && req.url === "/chat") {
            let body = "";
            req.on("data", (chunk: Buffer) => {
                body += chunk.toString();
            });

            req.on("end", () => {
                try {
                    const payload = JSON.parse(body) as { task?: string };
                    const task = payload.task || "Unknown task";

                    enqueueCommand(async () => {
                        console.log(`[Gateway] Processing task: ${task}`);
                        const finalState = await runAgentGraph(task, llm);
                        return finalState;
                    })
                        .then((result) => {
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({
                                success: true,
                                status: result.status,
                                result: result.result,
                                iterations: result.iterations,
                            }));
                        })
                        .catch((err: unknown) => {
                            res.writeHead(500, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ success: false, error: String(err) }));
                        });
                } catch {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Invalid JSON. Send { \"task\": \"your task here\" }" }));
                }
            });
        } else if (req.method !== "GET" || req.url !== "/health") {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not Found. Use POST /chat or GET /health" }));
        }
    });

    server.listen(port, () => {
        console.log(`\n🦞 ClawAgents Gateway running on http://localhost:${port}`);
        console.log(`   Provider: ${llm.name}`);
        console.log(`   Model: ${activeModel}`);
        console.log(`   Endpoints: POST /chat | GET /health\n`);
    });

    return server;
}
