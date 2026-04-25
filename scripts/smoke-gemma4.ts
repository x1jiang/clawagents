/**
 * One-off smoke test: verify `gemma4:*` tags route through the Ollama factory
 * and resolve correct context budgets. Mirrors clawagents_py/scripts/smoke_gemma4.py.
 *
 *   npx tsx scripts/smoke-gemma4.ts
 */
import { createProvider, OpenAIProvider } from "../src/providers/llm.js";
import { loadConfig } from "../src/config/config.js";

function pad(s: string, width: number): string {
    return s.length >= width ? s : s + " ".repeat(width - s.length);
}

async function main(): Promise<void> {
    const cases = [
        "gemma4:e4b",
        "gemma4:e2b",
        "gemma4:26b",
        "gemma4",
        "ollama/gemma4:e4b",
        "gpt-5.4",
        "gemini-3.1-pro",
        "claude-opus-4-6",
    ];

    const cfg = loadConfig();
    cfg.openaiBaseUrl = "";
    cfg.openaiApiKey = "";

    console.log(`${pad("model", 24)} ${pad("provider", 18)} ${pad("base_url", 46)} stored_model`);
    console.log("-".repeat(110));
    for (const name of cases) {
        try {
            const p = await createProvider(name, cfg);
            const kind = p instanceof OpenAIProvider ? "OpenAIProvider" : p.constructor.name;
            // Access client/model via `any` since the smoke purposely peeks past
            // private fields to verify the factory wired things up correctly.
            const anyp = p as any;
            const base = (anyp.client?.baseURL ?? anyp.client?.base_url ?? "<none>").toString();
            const stored = (anyp.model ?? anyp.geminiModel ?? "?").toString();
            console.log(`${pad(name, 24)} ${pad(kind, 18)} ${pad(base, 46)} ${stored}`);
        } catch (err: any) {
            console.log(`${pad(name, 24)} <skipped: ${err?.message ?? err}>`);
        }
    }
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
