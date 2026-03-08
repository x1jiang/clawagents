/**
 * Example: Multi-sample comparison (GRPO-inspired)
 *
 * Runs the same task N times and picks the best result based on objective scoring.
 * Useful for high-stakes tasks where you want the best possible outcome.
 *
 * Run:  npx tsx examples/05_compare_samples.ts
 */
import { createClawAgent } from "clawagents";

const agent = await createClawAgent({
  model: "gpt-5-mini",
  learn: true,
  rethink: true,
});

const result = await agent.compare(
  "Write a TypeScript function to merge two sorted arrays efficiently",
  3,    // run 3 times, pick the best
);

console.log(`Best score: ${result.bestScore}`);
console.log(`Best result:\n${result.bestResult}`);
console.log(`\nAll scores: ${result.allScores}`);
