/**
 * Tests for the Gemini MALFORMED_FUNCTION_CALL retry logic.
 *
 * When Gemini returns finishReason=MALFORMED_FUNCTION_CALL with 0 parts,
 * the provider should retry with toolConfig mode=ANY instead of returning
 * an empty response that the agent loop interprets as "done".
 *
 * Run: npx tsx --test src/malformed_fn_call.test.ts
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider } from "./providers/llm.js";

function makeCandidate(finishReason = "STOP", parts?: any[]) {
    return {
        finishReason,
        content: parts ? { parts } : null,
    };
}

function makeResponse(candidates?: any[], tokens = 10) {
    return {
        candidates,
        usageMetadata: { candidatesTokenCount: tokens },
    };
}

function makeFunctionCallPart(name = "search_db", args: Record<string, unknown> = { query: "test" }) {
    return { functionCall: { name, args }, text: undefined, thought: false };
}

function makeTextPart(text = "some text") {
    return { text, thought: false, functionCall: undefined };
}

describe("MALFORMED_FUNCTION_CALL retry — non-streaming", () => {
    it("retries with mode=ANY when first call returns MALFORMED_FUNCTION_CALL", async () => {
        const malformedResp = makeResponse([makeCandidate("MALFORMED_FUNCTION_CALL")]);
        const validResp = makeResponse([makeCandidate("STOP", [makeFunctionCallPart("search_db", { query: "patients" })])]);

        let callCount = 0;
        const mockClient = {
            models: {
                generateContent: async (_opts: any) => {
                    callCount++;
                    if (callCount === 1) return malformedResp;
                    return validResp;
                },
                generateContentStream: async () => { throw new Error("should not be called"); },
            },
        };

        const provider = Object.create(GeminiProvider.prototype) as InstanceType<typeof GeminiProvider>;
        (provider as any).client = mockClient;
        (provider as any).model = "gemini-2.5-flash";
        (provider as any).maxTokens = 8192;
        (provider as any).temperature = 0;

        const result = await provider.chat(
            [{ role: "user", content: "Build a patient cohort" }],
            { tools: [{ name: "search_db", description: "Search", parameters: { query: { type: "string", description: "q", required: true } } }] },
        );

        assert.equal(callCount, 2, "should make 2 API calls (original + retry)");
        assert.ok(result.toolCalls, "should have tool calls after retry");
        assert.equal(result.toolCalls!.length, 1);
        assert.equal(result.toolCalls![0].toolName, "search_db");
    });

    it("does NOT retry when finishReason is STOP", async () => {
        const normalResp = makeResponse([makeCandidate("STOP", [makeTextPart("Here is your answer")])]);

        let callCount = 0;
        const mockClient = {
            models: {
                generateContent: async () => { callCount++; return normalResp; },
                generateContentStream: async () => { throw new Error("should not be called"); },
            },
        };

        const provider = Object.create(GeminiProvider.prototype) as InstanceType<typeof GeminiProvider>;
        (provider as any).client = mockClient;
        (provider as any).model = "gemini-2.5-flash";
        (provider as any).maxTokens = 8192;
        (provider as any).temperature = 0;

        const result = await provider.chat(
            [{ role: "user", content: "Hello" }],
        );

        assert.equal(callCount, 1, "should make only 1 API call");
        assert.equal(result.content, "Here is your answer");
        assert.equal(result.toolCalls, undefined);
    });

    it("does not infinite-loop on double MALFORMED_FUNCTION_CALL", async () => {
        const malformedResp = makeResponse([makeCandidate("MALFORMED_FUNCTION_CALL")]);

        let callCount = 0;
        const mockClient = {
            models: {
                generateContent: async () => { callCount++; return malformedResp; },
                generateContentStream: async () => { throw new Error("should not be called"); },
            },
        };

        const provider = Object.create(GeminiProvider.prototype) as InstanceType<typeof GeminiProvider>;
        (provider as any).client = mockClient;
        (provider as any).model = "gemini-2.5-flash";
        (provider as any).maxTokens = 8192;
        (provider as any).temperature = 0;

        const result = await provider.chat(
            [{ role: "user", content: "Build a cohort" }],
            { tools: [{ name: "search_db", description: "Search", parameters: { query: { type: "string", description: "q", required: true } } }] },
        );

        assert.ok(callCount <= 3, `should not infinite loop (callCount=${callCount})`);
        assert.equal(result.content, "");
    });
});

describe("MALFORMED_FUNCTION_CALL retry — streaming", () => {
    it("retries with non-stream mode=ANY when stream returns MALFORMED_FUNCTION_CALL", async () => {
        const malformedChunk = {
            text: undefined,
            candidates: [makeCandidate("MALFORMED_FUNCTION_CALL")],
            usageMetadata: { candidatesTokenCount: 5 },
        };

        const validResp = makeResponse([makeCandidate("STOP", [makeFunctionCallPart("search_db", { query: "patients" })])]);

        let streamCallCount = 0;
        let contentCallCount = 0;
        const mockClient = {
            models: {
                generateContentStream: async () => {
                    streamCallCount++;
                    return (async function* () { yield malformedChunk; })();
                },
                generateContent: async (_opts: any) => {
                    contentCallCount++;
                    return validResp;
                },
            },
        };

        const provider = Object.create(GeminiProvider.prototype) as InstanceType<typeof GeminiProvider>;
        (provider as any).client = mockClient;
        (provider as any).model = "gemini-2.5-flash";
        (provider as any).maxTokens = 8192;
        (provider as any).temperature = 0;

        const chunks: string[] = [];
        const result = await provider.chat(
            [{ role: "user", content: "Build a patient cohort" }],
            {
                onChunk: (c) => chunks.push(c),
                tools: [{ name: "search_db", description: "Search", parameters: { query: { type: "string", description: "q", required: true } } }],
            },
        );

        assert.equal(streamCallCount, 1, "should make 1 streaming call");
        assert.equal(contentCallCount, 1, "should make 1 non-stream retry call");
        assert.ok(result.toolCalls, "should have tool calls after retry");
        assert.equal(result.toolCalls!.length, 1);
        assert.equal(result.toolCalls![0].toolName, "search_db");
    });

    it("does NOT retry when stream finishReason is STOP", async () => {
        const normalChunk = {
            text: "Stream answer",
            candidates: [makeCandidate("STOP", [makeTextPart("Stream answer")])],
            usageMetadata: { candidatesTokenCount: 12 },
        };

        let contentCallCount = 0;
        const mockClient = {
            models: {
                generateContentStream: async () => {
                    return (async function* () { yield normalChunk; })();
                },
                generateContent: async () => { contentCallCount++; return makeResponse(); },
            },
        };

        const provider = Object.create(GeminiProvider.prototype) as InstanceType<typeof GeminiProvider>;
        (provider as any).client = mockClient;
        (provider as any).model = "gemini-2.5-flash";
        (provider as any).maxTokens = 8192;
        (provider as any).temperature = 0;

        const result = await provider.chat(
            [{ role: "user", content: "Hello" }],
            { onChunk: () => {} },
        );

        assert.equal(contentCallCount, 0, "should NOT make a non-stream retry call");
        assert.equal(result.content, "Stream answer");
    });
});
