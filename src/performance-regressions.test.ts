import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgentGraph, IncrementalTokenLedger } from "./graph/agent-loop.js";
import { OpenAIProvider, type LLMProvider } from "./providers/llm.js";
import { LocalBackend } from "./sandbox/local.js";
import { BoundedTextAccumulator } from "./utils/bounded-output.js";

describe("OpenAI prompt cache affinity", () => {
    it("sends one stable opaque cache key through the body and affinity headers", async () => {
        const calls: Array<{ body: Record<string, unknown>; options?: { headers?: Record<string, string> } }> = [];
        const provider = Object.create(OpenAIProvider.prototype) as OpenAIProvider;
        (provider as any).client = {
            chat: {
                completions: {
                    create: async (body: Record<string, unknown>, options?: { headers?: Record<string, string> }) => {
                        calls.push({ body, options });
                        return {
                            choices: [{ message: { content: "ok" } }],
                            usage: {
                                total_tokens: 15,
                                prompt_tokens: 10,
                                prompt_tokens_details: { cached_tokens: 7 },
                            },
                        };
                    },
                },
            },
        };
        (provider as any).model = "gpt-5-nano";
        (provider as any).maxTokens = 128;
        (provider as any).temperature = 1;
        (provider as any).baseUrl = "https://api.openai.com/v1";

        const options = { sessionId: "customer/session/with sensitive path" };
        const first = await provider.chat([{ role: "user", content: "one" }], options);
        await provider.chat([{ role: "user", content: "two" }], options);

        assert.equal(calls.length, 2);
        const firstKey = calls[0]!.body.prompt_cache_key;
        assert.equal(typeof firstKey, "string");
        assert.equal(firstKey, calls[1]!.body.prompt_cache_key);
        assert.notEqual(firstKey, options.sessionId);
        assert.equal(calls[0]!.options?.headers?.session_id, firstKey);
        assert.equal(calls[0]!.options?.headers?.["x-client-request-id"], firstKey);
        assert.equal(first.cacheReadTokens, 7);
    });
});

describe("incremental context token ledger", () => {
    it("counts only appended messages after an exact provider checkpoint", () => {
        const calls: number[] = [];
        const estimate = (messages: Array<{ content: string }>) => {
            calls.push(messages.length);
            return messages.reduce((sum, message) => sum + message.content.length, 0);
        };
        const initial = [{ role: "system" as const, content: "large-prefix" }];
        const ledger = new IncrementalTokenLedger(estimate as any);
        ledger.rebase(initial, 100);

        const next = [...initial, { role: "user" as const, content: "new" }];
        assert.equal(ledger.estimate(next), 103);
        assert.deepEqual(calls, [1]);

        ledger.recordProviderUsage(next, 80);
        assert.equal(ledger.estimate([...next, { role: "assistant" as const, content: "tail" }]), 84);
        assert.deepEqual(calls, [1, 1]);
    });
});

describe("performance telemetry", () => {
    it("records TTFT, provider input/cache usage, and observed peak memory", async () => {
        const provider: LLMProvider = {
            name: "telemetry-test",
            async chat(_messages, options) {
                // Tool-call-only streams have no text chunks, so TTFT must not
                // depend exclusively on onChunk.
                options?.onFirstToken?.();
                return {
                    content: "hello",
                    model: "telemetry-test",
                    tokensUsed: 15,
                    promptTokens: 10,
                    cacheReadTokens: 6,
                };
            },
        };

        const state = await runAgentGraph(
            "hello",
            provider,
            undefined,
            undefined,
            1,
            true,
            10_000,
            () => undefined,
        );

        assert.equal(state.usage?.inputTokens, 10);
        assert.equal(state.usage?.cachedInputTokens, 6);
        assert.equal(state.usage?.perRequest[0]?.timeToFirstTokenMs !== undefined, true);
        assert.ok((state.usage?.peakMemoryBytes ?? 0) > 0);
    });
});

describe("bounded command output", () => {
    it("keeps bounded head and tail content while tracking discarded characters", () => {
        const output = new BoundedTextAccumulator(20);
        output.append("abcdefghij");
        output.append("klmnopqrstuvwxyz");
        const result = output.toString();

        assert.match(result, /^abcdefghij/);
        assert.match(result, /qrstuvwxyz$/);
        assert.match(result, /truncated 6 chars/);
        assert.equal(output.totalChars, 26);
    });

    it("bounds LocalBackend output while the child process is streaming", async () => {
        const root = mkdtempSync(join(tmpdir(), "claw-bounded-exec-"));
        const backend = new LocalBackend(root);
        const result = await backend.exec(
            `${JSON.stringify(process.execPath)} -e "process.stdout.write('a'.repeat(200000))"`,
            { maxOutputChars: 1_000 },
        );

        assert.equal(result.exitCode, 0);
        assert.ok(result.stdout.length < 1_200);
        assert.match(result.stdout, /truncated 199000 chars/);
    });
});
