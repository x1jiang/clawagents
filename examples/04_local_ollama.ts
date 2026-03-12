/**
 * Example: Local model with Ollama
 *
 * Prerequisites:
 *   1. Install Ollama: https://ollama.ai
 *   2. Pull a model: ollama pull llama3.1
 *   3. Ollama runs on http://localhost:11434 by default
 *
 * Run:  npx tsx examples/04_local_ollama.ts
 */
import { createClawAgent } from "clawagents";

const agent = await createClawAgent({
  model: "llama3.1",                               // model name in Ollama
  baseUrl: "http://localhost:11434/v1",             // Ollama's OpenAI-compatible endpoint
  // No apiKey needed for local models
});

const result = await agent.invoke("List all files in the current directory");
console.log(result.result);
