/**
 * Tests for the deterministic mock LLM service.
 * Mirrors `clawagents_py/tests/test_mock_provider.py`.
 *
 * Run with: npx tsx --test src/testing/mock-provider.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    BUILTIN_SCENARIOS,
    MockLLMService,
    PARITY_SCENARIO_HEADER,
    Scenario,
} from "./mock-provider.js";

interface PostResult {
    status: number;
    body: Record<string, unknown>;
}

async function postJson(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
): Promise<PostResult> {
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
    const text = await resp.text();
    let parsed: Record<string, unknown> = {};
    if (text.length > 0) {
        try {
            parsed = JSON.parse(text);
        } catch {
            /* leave parsed as {} */
        }
    }
    return { status: resp.status, body: parsed };
}

// ─── Lifecycle ──────────────────────────────────────────────────────

describe("MockLLMService lifecycle", () => {
    it("starts, binds a port, and stops", async () => {
        const svc = new MockLLMService();
        try {
            const url = await svc.start();
            assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
            assert.equal(svc.url, url);
            const health = await fetch(url + "/health");
            assert.equal(health.status, 200);
            const body = (await health.json()) as { ok: boolean };
            assert.equal(body.ok, true);
        } finally {
            await svc.stop();
        }
    });

    it("throws if .url is read before start", () => {
        const svc = new MockLLMService();
        assert.throws(() => svc.url, /not started/);
    });
});

// ─── Built-in scenarios ─────────────────────────────────────────────

describe("MockLLMService built-in scenarios", () => {
    for (const name of [
        "streaming_text",
        "single_tool_call",
        "multi_tool_turn",
        "bash_permission_denied",
        "truncated_json_recovery",
    ]) {
        it(`routes ${name} via header`, async () => {
            const svc = new MockLLMService();
            try {
                await svc.start();
                const { status, body } = await postJson(
                    svc.url + "/v1/chat/completions",
                    { messages: [{ role: "user", content: "hi" }] },
                    { [PARITY_SCENARIO_HEADER]: name },
                );
                assert.equal(status, 200);
                assert.equal(body["object"], "chat.completion");
                const choices = body["choices"] as Array<{ message: { role: string } }>;
                assert.equal(choices[0]?.message.role, "assistant");
            } finally {
                await svc.stop();
            }
        });
    }

    it("routes via system message preamble", async () => {
        const svc = new MockLLMService();
        try {
            await svc.start();
            const { status, body } = await postJson(svc.url + "/v1/chat/completions", {
                messages: [
                    { role: "system", content: "PARITY_SCENARIO: streaming_text" },
                    { role: "user", content: "anything" },
                ],
            });
            assert.equal(status, 200);
            const choices = body["choices"] as Array<{ message: { content: string } }>;
            assert.match(choices[0]!.message.content, /hello from mock/);
        } finally {
            await svc.stop();
        }
    });

    it("single_tool_call payload shape", async () => {
        const svc = new MockLLMService();
        try {
            await svc.start();
            const { body } = await postJson(
                svc.url + "/v1/chat/completions",
                { messages: [{ role: "user", content: "go" }] },
                { [PARITY_SCENARIO_HEADER]: "single_tool_call" },
            );
            const choices = body["choices"] as Array<{
                message: { content: string; tool_calls: Array<{ function: { name: string } }> };
                finish_reason: string;
            }>;
            const msg = choices[0]!.message;
            assert.equal(msg.content, "");
            assert.equal(msg.tool_calls.length, 1);
            assert.equal(msg.tool_calls[0]!.function.name, "echo");
            assert.equal(choices[0]!.finish_reason, "tool_calls");
        } finally {
            await svc.stop();
        }
    });

    it("multi_tool_turn returns two tool calls", async () => {
        const svc = new MockLLMService();
        try {
            await svc.start();
            const { body } = await postJson(
                svc.url + "/v1/chat/completions",
                { messages: [{ role: "user", content: "go" }] },
                { [PARITY_SCENARIO_HEADER]: "multi_tool_turn" },
            );
            const choices = body["choices"] as Array<{
                message: { tool_calls: Array<{ function: { name: string } }> };
            }>;
            const tc = choices[0]!.message.tool_calls;
            assert.equal(tc.length, 2);
            assert.equal(tc[0]!.function.name, "read_file");
            assert.equal(tc[1]!.function.name, "read_file");
        } finally {
            await svc.stop();
        }
    });

    it("truncated_json_recovery returns malformed args", async () => {
        const svc = new MockLLMService();
        try {
            await svc.start();
            const { body } = await postJson(
                svc.url + "/v1/chat/completions",
                { messages: [{ role: "user", content: "go" }] },
                { [PARITY_SCENARIO_HEADER]: "truncated_json_recovery" },
            );
            const choices = body["choices"] as Array<{
                message: { tool_calls: Array<{ function: { arguments: string } }> };
            }>;
            const args = choices[0]!.message.tool_calls[0]!.function.arguments;
            assert.ok(args.endsWith('"hello world"'));
            assert.ok(!args.endsWith("}"));
        } finally {
            await svc.stop();
        }
    });
});

// ─── Scenario-not-found ─────────────────────────────────────────────

describe("MockLLMService scenario-not-found", () => {
    it("returns 404 with a list of available scenarios", async () => {
        const svc = new MockLLMService();
        try {
            await svc.start();
            const { status, body } = await postJson(
                svc.url + "/v1/chat/completions",
                { messages: [{ role: "user", content: "hi" }] },
                { [PARITY_SCENARIO_HEADER]: "not_a_real_scenario" },
            );
            assert.equal(status, 404);
            assert.equal(body["error"], "scenario_not_found");
            assert.equal(body["scenario_tag"], "not_a_real_scenario");
            const available = body["available"] as string[];
            assert.ok(available.includes("streaming_text"));
        } finally {
            await svc.stop();
        }
    });

    it("empty scenario list always 404s", async () => {
        const svc = new MockLLMService({ scenarios: [] });
        try {
            await svc.start();
            const { status, body } = await postJson(svc.url + "/v1/chat/completions", {
                messages: [{ role: "user", content: "hi" }],
            });
            assert.equal(status, 404);
            assert.deepEqual(body["available"], []);
        } finally {
            await svc.stop();
        }
    });
});

// ─── Custom scenarios ───────────────────────────────────────────────

describe("MockLLMService custom scenarios", () => {
    it("matches via keywordMatch", async () => {
        const custom: Scenario = {
            name: "haiku_about_cats",
            keywordMatch: ["cat"],
            response: { id: "cust", object: "chat.completion", model: "m" },
        };
        const svc = new MockLLMService({ scenarios: [custom] });
        try {
            await svc.start();
            const { body } = await postJson(svc.url + "/v1/chat/completions", {
                messages: [{ role: "user", content: "write a cat haiku" }],
            });
            assert.equal(body["id"], "cust");
        } finally {
            await svc.stop();
        }
    });

    it("matches via requestPredicate", async () => {
        const isLong = (b: Record<string, unknown>): boolean => {
            const msgs = (b["messages"] as Array<{ content?: string }> | undefined) ?? [];
            return msgs.some((m) => (m.content ?? "").length > 50);
        };
        const custom: Scenario = {
            name: "long_input",
            requestPredicate: isLong,
            response: { id: "long", object: "chat.completion", model: "m" },
        };
        const svc = new MockLLMService({ scenarios: [custom] });
        try {
            await svc.start();
            const short = await postJson(svc.url + "/v1/chat/completions", {
                messages: [{ role: "user", content: "hi" }],
            });
            const long = await postJson(svc.url + "/v1/chat/completions", {
                messages: [{ role: "user", content: "x".repeat(100) }],
            });
            assert.equal(short.status, 404);
            assert.equal(long.status, 200);
            assert.equal(long.body["id"], "long");
        } finally {
            await svc.stop();
        }
    });

    it("callable response sees the request body", async () => {
        const seen: Record<string, unknown> = {};
        const custom: Scenario = {
            name: "echo_back",
            response: (body) => {
                Object.assign(seen, body);
                return { id: "echoed", object: "chat.completion", model: "m" };
            },
        };
        const svc = new MockLLMService({ scenarios: [custom] });
        try {
            await svc.start();
            const { body } = await postJson(
                svc.url + "/v1/chat/completions",
                { messages: [{ role: "user", content: "ping" }] },
                { [PARITY_SCENARIO_HEADER]: "echo_back" },
            );
            assert.equal(body["id"], "echoed");
            const msgs = seen["messages"] as Array<{ content: string }>;
            assert.equal(msgs[0]!.content, "ping");
        } finally {
            await svc.stop();
        }
    });

    it("requestLog records traffic", async () => {
        const svc = new MockLLMService();
        try {
            await svc.start();
            await postJson(
                svc.url + "/v1/chat/completions",
                { messages: [{ role: "user", content: "logme" }] },
                { [PARITY_SCENARIO_HEADER]: "streaming_text" },
            );
            const last = svc.requestLog[svc.requestLog.length - 1];
            assert.ok(last);
            assert.equal(last!.scenarioTag, "streaming_text");
            const msgs = (last!.body as { messages: Array<{ content: string }> }).messages;
            assert.equal(msgs[0]!.content, "logme");
        } finally {
            await svc.stop();
        }
    });
});

// ─── Sanity ─────────────────────────────────────────────────────────

describe("MockLLMService sanity", () => {
    it("built-in scenarios have unique names", () => {
        const names = BUILTIN_SCENARIOS.map((s) => s.name);
        assert.equal(names.length, new Set(names).size);
        assert.ok(names.includes("streaming_text"));
    });
});
