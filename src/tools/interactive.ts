/**
 * Interactive Tools — ask_user
 *
 * Allows the agent to ask the user a question and wait for a response.
 * Reads from stdin in CLI mode.
 */

import { createInterface } from "node:readline";
import type { Tool, ToolResult } from "./registry.js";

export const askUserTool: Tool = {
    name: "ask_user",
    description:
        "Ask the user a question and wait for their response. " +
        "Use when you need clarification, confirmation, or input to proceed. " +
        "Only use this when the task is genuinely ambiguous — don't over-ask.",
    parameters: {
        question: { type: "string", description: "The question to ask the user", required: true },
    },
    async execute(args): Promise<ToolResult> {
        const question = String(args["question"] ?? "");
        if (!question) {
            return { success: false, output: "", error: "No question provided" };
        }

        try {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            const answer = await new Promise<string>((resolve) => {
                rl.question(`\n🦞 Agent asks: ${question}\n> `, (ans) => {
                    rl.close();
                    resolve(ans);
                });
            });
            return { success: true, output: `User response: ${answer}` };
        } catch (err) {
            return { success: false, output: "", error: `ask_user failed: ${String(err)}` };
        }
    },
};

export const interactiveTools: Tool[] = [askUserTool];
