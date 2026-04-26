import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AgentStatus, runAgentGraph, type AgentState } from "./graph/agent-loop.js";
import { createClawAgent } from "./agent.js";
import type { LLMProvider } from "./providers/llm.js";
import { InMemorySession } from "./session/backends.js";
import { ToolRegistry, type Tool } from "./tools/registry.js";
import { createExecTools } from "./tools/exec.js";
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

const fakeLLM: LLMProvider = {
    name: "fake",
    async chat() {
        throw new Error("chat should not be called");
    },
};

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

    const tokenDiscover = await registry.executeTool("tool_discover", { query: "find units" });
    assert.equal(tokenDiscover.success, true);
    const tokenFound = JSON.parse(String(tokenDiscover.output));
    assert.deepEqual(tokenFound.map((x: { name: string }) => x.name), ["scan_x7"]);

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

test("agent factory registers compact discovery and token-aware lookup by default", async () => {
    const agent = await createClawAgent({ model: fakeLLM, memory: [], skills: [] });
    assert.ok(agent.tools.get("tool_discover"));

    const grepResult = await agent.tools.executeTool("tool_discover", { query: "find text", profile: "read-only" });
    assert.equal(grepResult.success, true);
    const grepFound = JSON.parse(String(grepResult.output));
    assert.equal(grepFound[0].name, "grep");
    assert.ok(grepFound[0].keywords.includes("find text"));

    const listResult = await agent.tools.executeTool("tool_discover", { query: "list folder", profile: "read-only" });
    const listFound = JSON.parse(String(listResult.output));
    assert.ok(listFound.some((x: { name: string }) => x.name === "ls"));

    const editResult = await agent.tools.executeTool("tool_discover", { query: "edit text", profile: "full" });
    const editFound = JSON.parse(String(editResult.output));
    assert.ok(editFound.some((x: { name: string }) => x.name === "edit_file"));
});

test("execute returns structured context for nonzero command exits", async () => {
    const backend = {
        kind: "fake",
        cwd: "/tmp",
        sep: "/",
        resolve: (...parts: string[]) => parts.join("/"),
        relative: (_from: string, to: string) => to,
        dirname: (p: string) => path.dirname(p),
        basename: (p: string) => path.basename(p),
        join: (...parts: string[]) => path.join(...parts),
        safePath: (p: string) => p,
        readFile: async () => "",
        readFileBytes: async () => Buffer.from(""),
        writeFile: async () => undefined,
        readDir: async () => [],
        mkdir: async () => undefined,
        exists: async () => false,
        stat: async () => ({ isFile: false, isDirectory: false, size: 0, mtimeMs: 0 }),
        exec: async () => ({
            stdout: "F\nFAILED tests/test_sample.ts::test_demo",
            stderr: "assertion failed",
            exitCode: 1,
        }),
    };
    const tool = createExecTools(backend)[0]!;
    const result = await tool.execute({ command: "npm test" });

    assert.equal(result.success, false);
    const payload = JSON.parse(String(result.output));
    assert.equal(payload.command_executed, true);
    assert.equal(payload.exit_code, 1);
    assert.equal(payload.command, "npm test");
    assert.match(payload.stdout, /FAILED/);
    assert.match(payload.stderr, /assertion failed/);
    assert.match(payload.interpretation, /nonzero/i);
});

test("repeated execute calls get a command-specific recovery hint", async () => {
    class RepeatingExecuteLLM implements LLMProvider {
        name = "repeat";
        calls = 0;
        seen: Array<Parameters<LLMProvider["chat"]>[0]> = [];

        async chat(messages: Parameters<LLMProvider["chat"]>[0]) {
            this.calls += 1;
            this.seen.push(messages.map((m) => ({ ...m })));
            if (this.calls <= 4) {
                return {
                    content: "",
                    model: "fake",
                    tokensUsed: 1,
                    toolCalls: [{
                        toolName: "execute",
                        args: { command: "npm test" },
                        toolCallId: `call_${this.calls}`,
                    }],
                };
            }
            return { content: "done", model: "fake", tokensUsed: 1 };
        }
    }

    const llm = new RepeatingExecuteLLM();
    const registry = new ToolRegistry();
    registry.register({
        name: "execute",
        description: "Execute a command",
        parameters: { command: { type: "string", description: "command", required: true } },
        async execute() {
            return {
                success: false,
                output: '{"command_executed":true,"exit_code":1,"stdout":"FAILED","stderr":""}',
                error: "Command exited with code 1: npm test",
            };
        },
    });

    await runAgentGraph(
        "run tests",
        llm,
        registry,
        undefined,
        8,
        false,
        1_000_000,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
    );

    const hints = llm.seen.flatMap((batch) =>
        batch.filter((m) => m.role === "user").map((m) => String(m.content)),
    );
    const transcript = llm.seen.flat().map((m) => String(m.content)).join("\n");
    assert.match(transcript, /command_executed/);
    assert.match(transcript, /exit_code/);
    assert.ok(hints.some((m) =>
        m.includes("execute command") &&
        m.includes("nonzero") &&
        m.includes("Do not rerun"),
    ));
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
