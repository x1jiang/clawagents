/**
 * Example: Azure OpenAI
 *
 * Run:  npx tsx examples/03_azure.ts
 */
import { createClawAgent } from "clawagents";

const agent = await createClawAgent({
  model: "gpt-4o",                                            // Azure deployment name
  apiKey: "your-azure-key",                                   // or OPENAI_API_KEY in .env
  baseUrl: "https://YOUR_RESOURCE.openai.azure.com/",         // or OPENAI_BASE_URL in .env
  apiVersion: "2024-12-01-preview",                           // or OPENAI_API_VERSION in .env
});

const result = await agent.invoke("Analyze the codebase for security issues");
console.log(result.result);
