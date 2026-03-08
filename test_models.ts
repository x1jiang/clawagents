/**
 * Multi-model validation for ClawAgents (TypeScript)
 * Tests all GPT/Gemini/Codex models to verify they work correctly.
 */

import { createClawAgent } from "./src/agent.js";

const MODELS = [
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-4o",
    "gpt-4o-mini",
    "codex-mini-latest",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
];

const PROMPT = "What is the capital of France? Answer in one word.";

async function main() {
    console.log("Model                     OK?   Time     Answer");
    console.log("-".repeat(70));

    for (const modelName of MODELS) {
        try {
            const agent = await createClawAgent({
                model: modelName,
                streaming: false,
                onEvent: () => { },
            });
            const t0 = performance.now();
            const state = await agent.invoke(PROMPT, 2);
            const elapsed = (performance.now() - t0) / 1000;
            const ok = state.status === "done" && state.result.toLowerCase().includes("paris");
            const sym = ok ? "✓" : "✗";
            const answer = state.result.replace(/\n/g, " ").slice(0, 30);
            console.log(`${modelName.padEnd(25)} ${sym.padEnd(5)} ${elapsed.toFixed(1).padStart(5)}s  ${answer}`);
        } catch (err) {
            console.log(`${modelName.padEnd(25)} ✗     ERR    ${String(err).slice(0, 40)}`);
        }
    }
}

main().catch(console.error);
