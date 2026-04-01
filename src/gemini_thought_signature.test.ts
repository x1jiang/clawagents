import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider } from "./providers/llm.js";

function makeCandidate(parts: any[]) {
    return {
        finishReason: "STOP",
        content: { parts },
    };
}

function makeResponse(parts: any[]) {
    return {
        candidates: [makeCandidate(parts)],
        usageMetadata: { candidatesTokenCount: 7 },
    };
}

describe("Gemini thought_signature propagation", () => {
    it("propagates thought_signature to sibling functionCall parts", async () => {
        const mockClient = {
            models: {
                generateContent: async () => makeResponse([
                    {
                        functionCall: { name: "get_university_detail", args: { id: "u1" } },
                        thought_signature: "sig-123",
                    },
                    {
                        functionCall: { name: "get_program_detail", args: { id: "p1" } },
                    },
                ]),
                generateContentStream: async () => {
                    throw new Error("should not be called");
                },
            },
        };

        const provider = Object.create(GeminiProvider.prototype) as InstanceType<typeof GeminiProvider>;
        (provider as any).client = mockClient;
        (provider as any).model = "gemini-2.5-flash";
        (provider as any).maxTokens = 8192;
        (provider as any).temperature = 0;

        const result = await provider.chat([{ role: "user", content: "Fetch both details" }]);

        assert.ok(result.geminiParts);
        assert.equal(result.geminiParts!.length, 2);
        assert.equal((result.geminiParts![0] as any).thought_signature, "sig-123");
        assert.equal((result.geminiParts![1] as any).thought_signature, "sig-123");
    });
});
