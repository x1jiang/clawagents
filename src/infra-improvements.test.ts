import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AgentStatus, type AgentState } from "./graph/agent-loop.js";
import { InMemorySession } from "./session/backends.js";
import { ToolRegistry, type Tool } from "./tools/registry.js";
import { createToolDiscoveryTools, namesForToolProfile } from "./tools/catalog.js";
import { SqliteResultCacheManager } from "./tools/cache.js";
import { DockerBackend } from "./sandbox/docker.js";
import { RunResult } from "./run-result.js";
import { createExplorerTools } from "./explorer.js";
import { runAgentEnvironment } from "./eval.js";
import { Trajectory, toNextStateTransitions } from "./rl/index.js";

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `clawagents-${prefix}-`));
}

const require = createRequire(import.meta.url);
const hasNodeSqlite = (() => {
    try { require("node:sqlite"); return true; } catch { return false; }
})();

function makeTool(name: string, description = `tool ${name}`, keywords?: string[]): Tool {
    return {
        name,
        description,
        keywords,
        parameters: {
            value: { type: "string", description: "value" },
        },
        async execute(args) {
            return { success: true, output: `${name}:${String(args.value ?? "")}` };
        },
    };
}

test("compact tool discovery exposes searchable catalog and named profiles", async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("read_file", "Read a file"));
    registry.register(makeTool("write_file", "Write a file"));
    registry.register(makeTool("grep", "Search file contents"));
    for (const tool of createToolDiscoveryTools(registry)) registry.register(tool);

    const discover = await registry.executeTool("tool_discover", { query: "search" });
    assert.equal(discover.success, true);
    const found = JSON.parse(String(discover.output));
    assert.deepEqual(found.map((x: { name: string }) => x.name), ["grep"]);

    registry.register(makeTool("scan_x7", "Process text units", ["search", "find text", "file contents"]));
    const keywordDiscover = await registry.executeTool("tool_discover", { query: "find text" });
    assert.equal(keywordDiscover.success, true);
    const keywordFound = JSON.parse(String(keywordDiscover.output));
    assert.deepEqual(keywordFound.map((x: { name: string }) => x.name), ["scan_x7"]);
    assert.deepEqual(keywordFound[0].keywords, ["search", "find text", "file contents"]);

    const described = await registry.executeTool("tool_describe", { name: "scan_x7" });
    assert.equal(described.success, true);
    assert.deepEqual(JSON.parse(String(described.output)).keywords, ["search", "find text", "file contents"]);

    const profileNames = namesForToolProfile(registry, "read-only");
    assert.ok(profileNames.includes("read_file"));
    assert.ok(!profileNames.includes("write_file"));

    const bounded = new ToolRegistry();
    bounded.register(makeTool("read_file", "Read a file"));
    bounded.register(makeTool("write_file", "Write a file"));
    for (const tool of createToolDiscoveryTools(bounded, { maxProfile: "read-only" })) bounded.register(tool);
    const denied = await bounded.executeTool("tool_describe", { name: "write_file" });
    assert.equal(denied.success, false);
});

test("sqlite result cache persists successful tool results across instances", { skip: !hasNodeSqlite }, () => {
    const dir = tmpDir("cache");
    const dbPath = path.join(dir, "cache.sqlite");
    const first = new SqliteResultCacheManager({ dbPath, defaultTtlMs: 60_000 });
    first.set("expensive_lookup", { key: "a" }, { success: true, output: "hello" });

    const second = new SqliteResultCacheManager({ dbPath, defaultTtlMs: 60_000 });
    const cached = second.get("expensive_lookup", { key: "a" });
    assert.deepEqual(cached, { success: true, output: "hello" });
    second.set("read_file", { path: ".env" }, { success: true, output: "secret" });
    assert.equal(second.get("read_file", { path: ".env" }), undefined);
});

test("docker backend builds safe docker run arguments without exposing host secrets", () => {
    const root = tmpDir("docker");
    const backend = new DockerBackend({ root, image: "node:20-alpine" });
    const args = backend.buildDockerArgs("echo hi", { env: { OPENAI_API_KEY: "secret", SAFE: "1" } });

    assert.equal(args[0], "run");
    assert.ok(args.includes("--rm"));
    assert.ok(args.some((arg) => arg.includes(`${root}:/workspace`)));
    assert.ok(args.includes("SAFE=1"));
    assert.ok(!args.includes("OPENAI_API_KEY=secret"));
});

test("docker backend blocks symlink escapes in host file operations", () => {
    const root = tmpDir("docker-safe");
    const outside = tmpDir("docker-outside");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    try {
        fs.symlinkSync(outside, path.join(root, "link"), "dir");
    } catch {
        return;
    }
    const backend = new DockerBackend({ root });
    assert.throws(() => backend.safePath("link/secret.txt"), /Path traversal blocked/);
});

test("run result serializes agent state and can resume session messages", async () => {
    const state: AgentState = {
        messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }],
        currentTask: "hello",
        status: "done" as AgentStatus,
        result: "hi",
        iterations: 1,
        maxIterations: 3,
        toolCalls: 0,
    };
    const result = RunResult.fromAgentState(state);
    const restored = RunResult.fromState(result.toState());
    assert.equal(restored.finalOutput, "hi");

    const session = new InMemorySession("resume");
    await restored.resumeInto(session);
    assert.equal((await session.getItems()).length, 2);
});

test("explorer tools list tools and read files inside the configured root", async () => {
    const root = tmpDir("explorer");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "demo.ts"), "export const answer = 42;\n");
    const subject = new ToolRegistry();
    subject.register(makeTool("read_file", "Read a file"));

    const explorer = new ToolRegistry();
    for (const tool of createExplorerTools({ root, tools: subject })) explorer.register(tool);

    const catalog = await explorer.executeTool("explorer_list_tools", {});
    assert.ok(String(catalog.output).includes("read_file"));

    const file = await explorer.executeTool("explorer_read_source", { path: "src/demo.ts" });
    assert.equal(file.success, true);
    assert.ok(String(file.output).includes("answer"));
});

test("runAgentEnvironment is a gym-style alias around text environments", async () => {
    const result = await runAgentEnvironment(
        async (messages) => `reply:${messages.at(-1)?.content}`,
        {
            init: () => ({ observations: [{ role: "user", content: "start" }] }),
            step: () => ({ observations: [], reward: 1, done: true }),
        },
    );
    assert.equal(result.totalReward, 1);
    assert.equal(result.steps.length, 1);
});

test("next-state trajectory export links assistant actions to following feedback", () => {
    const t = new Trajectory({ task: "demo", model: "mock" });
    t.addUser("write code");
    t.addAssistant("done", [], { trainable: true });
    t.addUser("tests failed", { feedback: true });
    t.addAssistant("fixed", [], { trainable: true });
    t.addUser("tests passed", { feedback: true });

    const transitions = toNextStateTransitions(t);
    assert.equal(transitions.length, 2);
    assert.equal(transitions[0].action.content, "done");
    assert.equal(transitions[0].next_state.content, "tests failed");
    assert.equal(transitions[1].done, true);
});
