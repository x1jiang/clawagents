/**
 * Example: Google Gemini
 *
 * Run:  npx tsx examples/02_gemini.ts
 */
import { createClawAgent } from "clawagents";

const agent = await createClawAgent({
  model: "gemini-3-flash",
  apiKey: "AIza...",       // or set GEMINI_API_KEY in .env
});

const result = await agent.invoke("Read README.md and suggest improvements");
console.log(result.result);
