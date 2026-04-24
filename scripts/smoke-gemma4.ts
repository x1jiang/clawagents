/**
 * One-off smoke test: verify `gemma4:*` tags route through the Ollama factory
 * and resolve correct context budgets. Not wired into CI — run manually:
 *
 *   npx tsx scripts/smoke-gemma4.ts
 */
import { createProvider, OpenAIProvider } from "../src/providers/llm.js";
import { loadConfig } from "../src/config/config.js";

async function main(): Promise<void> {
    const cases = ["gemma4:e4b", "gemma4:e2b", "gemma4:26b", "gemma4", "ollama/gemma4:e4b", "gpt-5.4"];
    for (const name of cases) {
        const cfg = loadConfig();
        cfg.openaiBaseUrl = "";
        cfg.openaiApiKey = "";
        const p = await createProvider(name, cfg);
        const kind = p instanceof OpenAIProvider ? "OpenAIProvider" : p.constructor.name;
        const base = cfg.openaiBaseUrl || "<none>";
        console.log(
            `${name.padEnd(24)} -> provider=${kind.padEnd(16)} base_url=${base.padEnd(34)} model=${cfg.openaiModel}`,
        );
    }
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
