/**
 * Deterministic fake LLM service for offline e2e tests.
 *
 * Mirrors `clawagents_py/src/clawagents/testing/mock_provider.py`.
 *
 * Bind a tiny stdlib `http.createServer` on `127.0.0.1:0` and answer any
 * POST with a scenario-shaped JSON response. Real provider clients can be
 * pointed at it via `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` /
 * `GOOGLE_API_BASE_URL`.
 *
 * Scenario routing
 * ----------------
 * Picks a scenario via either:
 *   1. an HTTP header `X-Parity-Scenario: <name>`, or
 *   2. a system message preamble of the form `PARITY_SCENARIO: <name>`.
 *
 * A request matches a scenario if any of:
 *   - tag (header / preamble) equals `scenario.name`,
 *   - `scenario.requestPredicate` returns true,
 *   - any `scenario.keywordMatch` substring is in the stringified body.
 *
 * No new runtime deps — pure stdlib.
 */

import * as http from "node:http";
import { AddressInfo } from "node:net";
import { URL } from "node:url";

export const PARITY_SCENARIO_HEADER = "X-Parity-Scenario";
export const PARITY_SCENARIO_MARKER = "PARITY_SCENARIO:";

export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [k: string]: JsonValue };

export type RequestBody = Record<string, unknown>;
export type ResponseFactory = (body: RequestBody) => Record<string, unknown>;
export type RequestPredicate = (body: RequestBody) => boolean;

export interface Scenario {
    /** Stable identifier; can be used as the scenario tag. */
    name: string;
    /** Either a fixed JSON-able dict or a callable returning one. */
    response: Record<string, unknown> | ResponseFactory;
    /** Optional predicate over the decoded request body. */
    requestPredicate?: RequestPredicate;
    /** Optional substrings to match against the stringified body. */
    keywordMatch?: string[];
    /** HTTP status to return (default 200). */
    status?: number;
    /** Extra response headers. */
    headers?: Record<string, string>;
}

interface MatchedScenario {
    scenario: Scenario;
    payload: Record<string, unknown>;
}

// ─── Built-in OpenAI-shaped scenario presets ────────────────────────

interface ChatCompletionOpts {
    content?: string;
    toolCalls?: Array<Record<string, unknown>>;
    finishReason?: string;
    model?: string;
}

function chatCompletion(opts: ChatCompletionOpts = {}): Record<string, unknown> {
    const message: Record<string, unknown> = {
        role: "assistant",
        content: opts.content ?? "",
    };
    if (opts.toolCalls && opts.toolCalls.length > 0) {
        message["tool_calls"] = opts.toolCalls;
    }
    return {
        id: "chatcmpl-mock-001",
        object: "chat.completion",
        created: 1700000000,
        model: opts.model ?? "mock-gpt",
        choices: [
            {
                index: 0,
                message,
                finish_reason: opts.finishReason ?? "stop",
            },
        ],
        usage: {
            prompt_tokens: 10,
            completion_tokens: 8,
            total_tokens: 18,
        },
    };
}

const streamingTextResponse: ResponseFactory = () =>
    chatCompletion({
        content: "hello from mock streaming text",
        finishReason: "stop",
    });

const singleToolCallResponse: ResponseFactory = () =>
    chatCompletion({
        toolCalls: [
            {
                id: "call_mock_1",
                type: "function",
                function: {
                    name: "echo",
                    arguments: JSON.stringify({ text: "hi" }),
                },
            },
        ],
        finishReason: "tool_calls",
    });

const multiToolTurnResponse: ResponseFactory = () =>
    chatCompletion({
        toolCalls: [
            {
                id: "call_mock_a",
                type: "function",
                function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "/tmp/a" }),
                },
            },
            {
                id: "call_mock_b",
                type: "function",
                function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "/tmp/b" }),
                },
            },
        ],
        finishReason: "tool_calls",
    });

const bashPermissionDeniedResponse: ResponseFactory = () =>
    chatCompletion({
        toolCalls: [
            {
                id: "call_mock_bash",
                type: "function",
                function: {
                    name: "bash",
                    arguments: JSON.stringify({ cmd: "rm -rf /" }),
                },
            },
        ],
        finishReason: "tool_calls",
    });

const truncatedJsonRecoveryResponse: ResponseFactory = () =>
    chatCompletion({
        toolCalls: [
            {
                id: "call_mock_trunc",
                type: "function",
                function: {
                    name: "echo",
                    // Intentionally missing trailing brace — exercises the
                    // client's JSON repair path.
                    arguments: '{"text": "hello world"',
                },
            },
        ],
        finishReason: "tool_calls",
    });

export const BUILTIN_SCENARIOS: Scenario[] = [
    { name: "streaming_text", response: streamingTextResponse },
    { name: "single_tool_call", response: singleToolCallResponse },
    { name: "multi_tool_turn", response: multiToolTurnResponse },
    { name: "bash_permission_denied", response: bashPermissionDeniedResponse },
    { name: "truncated_json_recovery", response: truncatedJsonRecoveryResponse },
];

// ─── Helpers ────────────────────────────────────────────────────────

function extractScenarioTag(
    headers: Record<string, string>,
    body: RequestBody,
): string | null {
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === PARITY_SCENARIO_HEADER.toLowerCase()) {
            const trimmed = v.trim();
            return trimmed.length > 0 ? trimmed : null;
        }
    }
    const messages = (body as { messages?: unknown }).messages;
    if (Array.isArray(messages)) {
        for (const m of messages) {
            if (m && typeof m === "object" && !Array.isArray(m)) {
                const content = (m as { content?: unknown }).content;
                if (typeof content === "string" && content.includes(PARITY_SCENARIO_MARKER)) {
                    const after = content.split(PARITY_SCENARIO_MARKER, 2)[1] ?? "";
                    const tag = after.trim().split(/\s+/)[0] ?? "";
                    if (tag.length > 0) return tag;
                }
            }
        }
    }
    return null;
}

function matches(
    scenario: Scenario,
    body: RequestBody,
    scenarioTag: string | null,
): boolean {
    if (scenarioTag !== null && scenarioTag === scenario.name) return true;
    if (scenario.requestPredicate) {
        try {
            if (scenario.requestPredicate(body)) return true;
        } catch {
            /* defensive — predicate errors don't crash the service */
        }
    }
    if (scenario.keywordMatch && scenario.keywordMatch.length > 0) {
        const haystack = JSON.stringify(body);
        for (const kw of scenario.keywordMatch) {
            if (haystack.includes(kw)) return true;
        }
    }
    return false;
}

function renderScenario(
    scenario: Scenario,
    body: RequestBody,
): Record<string, unknown> {
    if (typeof scenario.response === "function") {
        return scenario.response(body);
    }
    return scenario.response;
}

function pickScenario(
    scenarios: Scenario[],
    body: RequestBody,
    scenarioTag: string | null,
): MatchedScenario | null {
    for (const sc of scenarios) {
        if (matches(sc, body, scenarioTag)) {
            return { scenario: sc, payload: renderScenario(sc, body) };
        }
    }
    return null;
}

async function readBody(req: http.IncomingMessage): Promise<{ body: RequestBody; raw: string }> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            let body: RequestBody = {};
            if (raw.length > 0) {
                try {
                    const parsed: unknown = JSON.parse(raw);
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        body = parsed as RequestBody;
                    }
                } catch {
                    /* leave body as {} */
                }
            }
            resolve({ body, raw });
        });
        req.on("error", reject);
    });
}

function headersDict(req: http.IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") out[k] = v;
        else if (Array.isArray(v)) out[k] = v.join(",");
    }
    return out;
}

// ─── Logged request shape ───────────────────────────────────────────

export interface LoggedRequest {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: RequestBody;
    scenarioTag: string | null;
}

// ─── Service ────────────────────────────────────────────────────────

export interface MockLLMServiceOptions {
    /** Bind port. `0` → OS picks a free one. Default `0`. */
    port?: number;
    /** Bind host. Default `"127.0.0.1"`. */
    host?: string;
    /** Scenarios. Defaults to `BUILTIN_SCENARIOS`. Pass `[]` for an empty service. */
    scenarios?: Scenario[];
}

/**
 * Deterministic fake LLM service.
 *
 * @example
 *   const mock = new MockLLMService();
 *   await mock.start();
 *   try {
 *     process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
 *     // run real provider clients...
 *   } finally {
 *     await mock.stop();
 *   }
 */
export class MockLLMService {
    private readonly host: string;
    private readonly initialPort: number;
    private readonly scenariosList: Scenario[];
    private server: http.Server | null = null;
    private boundUrl: string | null = null;
    readonly requestLog: LoggedRequest[] = [];

    constructor(options: MockLLMServiceOptions = {}) {
        this.host = options.host ?? "127.0.0.1";
        this.initialPort = options.port ?? 0;
        this.scenariosList = options.scenarios !== undefined
            ? [...options.scenarios]
            : [...BUILTIN_SCENARIOS];
    }

    get scenarios(): Scenario[] {
        return this.scenariosList;
    }

    addScenario(s: Scenario): void {
        this.scenariosList.push(s);
    }

    get url(): string {
        if (this.boundUrl === null) {
            throw new Error("MockLLMService not started");
        }
        return this.boundUrl;
    }

    async start(): Promise<string> {
        if (this.server !== null && this.boundUrl !== null) return this.boundUrl;

        const server = http.createServer((req, res) => {
            void this.handle(req, res);
        });
        this.server = server;

        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(this.initialPort, this.host, () => {
                server.removeListener("error", reject);
                resolve();
            });
        });

        const addr = server.address() as AddressInfo;
        this.boundUrl = `http://${this.host}:${addr.port}`;
        return this.boundUrl;
    }

    async stop(): Promise<void> {
        const server = this.server;
        if (server === null) return;
        await new Promise<void>((resolve, reject) => {
            server.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        this.server = null;
        this.boundUrl = null;
    }

    private writeJson(
        res: http.ServerResponse,
        status: number,
        payload: unknown,
        extraHeaders: Record<string, string> = {},
    ): void {
        const encoded = Buffer.from(JSON.stringify(payload), "utf-8");
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Length", String(encoded.length));
        for (const [k, v] of Object.entries(extraHeaders)) {
            res.setHeader(k, v);
        }
        res.end(encoded);
    }

    private async handle(
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ): Promise<void> {
        const path = (req.url ?? "/").split("?", 1)[0] ?? "/";

        // Health probe convenience.
        if (req.method === "GET" && (path === "/health" || path === "/_mock/health")) {
            this.writeJson(res, 200, { ok: true });
            return;
        }

        const { body } = await readBody(req);
        const headers = headersDict(req);
        const scenarioTag = extractScenarioTag(headers, body);

        this.requestLog.push({
            method: req.method ?? "?",
            path,
            headers,
            body,
            scenarioTag,
        });

        const matched = pickScenario(this.scenariosList, body, scenarioTag);
        if (matched !== null) {
            this.writeJson(
                res,
                matched.scenario.status ?? 200,
                matched.payload,
                matched.scenario.headers ?? {},
            );
            return;
        }

        this.writeJson(res, 404, {
            error: "scenario_not_found",
            scenario_tag: scenarioTag,
            path,
            available: this.scenariosList.map((s) => s.name),
        });
    }
}
