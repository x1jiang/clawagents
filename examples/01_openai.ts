/**
 * Example: OpenAI (GPT-5, GPT-4o, etc.)
 *
 * Run:  npx tsx examples/01_openai.ts
 */
import { createClawAgent } from "clawagents";

const agent = await createClawAgent({
  model: "gpt-5-mini",
  apiKey: "sk-...",        // or set OPENAI_API_KEY in .env
  learn: true,             // enable PTRL (optional)
  rethink: true,           // enable rethink on failures (optional)
});

const result = await agent.invoke("List all TypeScript files and summarize the project structure");
console.log(result.result);
