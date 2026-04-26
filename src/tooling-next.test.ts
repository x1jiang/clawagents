import test from "node:test";
import assert from "node:assert/strict";

import { runTextEnvironment } from "./eval.js";
import { normalizeSandboxManifest } from "./sandbox/manifest.js";
import { createToolProgramTool } from "./tools/tool-program.js";
import {
    ToolRegistry,
    truncateToolOutput,
    type Tool,
} from "./tools/registry.js";

const echoTool: Tool = {
    name: "echo",
    description: "Echo a message",
    parameters: {
        message: { type: "string", description: "Message to echo", required: true },
    },
    async execute(args) {
        return { success: true, output: String(args["message"] ?? "") };
    },
};

test("truncateToolOutput respects small custom budgets and preserves the tail", () => {
    const input = "a".repeat(200) + "TAIL";
    const out = truncateToolOutput(input, 80);

    assert.equal(typeof out, "string");
    const text = out as string;
    assert.ok(text.length <= 120, `expected bounded output, got ${text.length}`);
    assert.ok(text.includes("truncated"));
    assert.ok(text.endsWith("TAIL"));
});

test("ToolRegistry exposes an inspectable native-compatible catalog", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    const catalog = registry.inspectTools();
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0]!.name, "echo");
    assert.deepEqual(catalog[0]!.parameters, echoTool.parameters);
    assert.deepEqual(registry.toNativeSchemas()[0]!.parameters, catalog[0]!.parameters);
});

test("normalizeSandboxManifest validates explicit workspace entries", () => {
    const manifest = normalizeSandboxManifest({
        entries: {
            repo: { type: "git", repo: "x1jiang/clawagents", ref: "main", target: "repo" },
            cache: { type: "path", source: "/tmp/cache", target: "cache", readOnly: true },
        },
        env: { NODE_ENV: "test" },
        workdir: "repo",
    });

    assert.equal(manifest.entries.length, 2);
    assert.equal(manifest.entries[0]!.name, "repo");
    assert.equal(manifest.env["NODE_ENV"], "test");
    assert.throws(() => normalizeSandboxManifest({ entries: { bad: { type: "path", source: "" } } }), /source/i);
});

test("runTextEnvironment records observations, rewards, done, and metrics", async () => {
    let turn = 0;
    const result = await runTextEnvironment(
        async (messages) => `reply:${messages.at(-1)?.content ?? ""}`,
        {
            async init() {
                return { observations: [{ role: "user", content: "start" }], metadata: { id: "case-1" } };
            },
            async step(action) {
                turn += 1;
                return {
                    observations: [{ role: "user", content: `turn-${turn}` }],
                    reward: action.includes("start") ? 1 : 0,
                    done: turn >= 1,
                    metadata: { turn },
                };
            },
            getMetrics() {
                return { custom: 7 };
            },
        },
    );

    assert.equal(result.totalReward, 1);
    assert.equal(result.steps.length, 1);
    assert.deepEqual(result.metrics, { custom: 7 });
});

test("tool_program runs a bounded read-only tool sequence with substitutions", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    registry.register(createToolProgramTool(registry, { allowedTools: ["echo"], maxSteps: 3 }));

    const result = await registry.executeTool("tool_program", {
        steps: [
            { id: "first", tool: "echo", args: { message: "hello" } },
            { tool: "echo", args: { message: "${first.output} world" } },
        ],
    });

    assert.equal(result.success, true);
    assert.equal(result.output, "hello world");
});
