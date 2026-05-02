import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

test("provider profile resolves builtin and explicit overrides", async () => {
    const { resolveProviderProfile } = await import("./provider-profiles.js");
    const resolved = resolveProviderProfile("ollama");
    assert.equal(resolved.model, "llama3.1");
    assert.equal(resolved.baseUrl, "http://localhost:11434/v1");
    assert.equal(resolved.apiKey, "ollama");

    const overridden = resolveProviderProfile("ollama", {
        model: "gpt-5.4-nano",
        baseUrl: "https://example.test/v1",
        apiKey: "explicit",
    });
    assert.equal(overridden.model, "gpt-5.4-nano");
    assert.equal(overridden.baseUrl, "https://example.test/v1");
    assert.equal(overridden.apiKey, "explicit");
});

test("dry-run preview is static and reports tools", async () => {
    const { buildDryRunPreview } = await import("./dry-run.js");
    const preview = await buildDryRunPreview({
        task: "grep for failing tests",
        profile: "ollama",
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.status, "ready");
    assert.equal(preview.provider.profile, "ollama");
    assert.equal(preview.provider.model, "llama3.1");
    assert.ok(preview.toolCount > 0);
    assert.ok(preview.matchingTools.includes("tool_discover"));
});

test("permission decision reports confirm and sensitive path", async () => {
    const { PermissionMode, evaluateToolPermission } = await import("./permissions/mode.js");
    const decision = evaluateToolPermission("execute", {
        mode: PermissionMode.DEFAULT,
        isReadOnly: false,
        command: "npm install demo",
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.requiresConfirmation, true);
    assert.match(decision.reason, /Package installation/);

    const sensitive = evaluateToolPermission("read_file", {
        mode: PermissionMode.BYPASS,
        isReadOnly: true,
        filePath: `${process.env.HOME}/.ssh/id_rsa`,
    });
    assert.equal(sensitive.allowed, false);
    assert.match(sensitive.reason, /sensitive credential path/);
});

test("background task tools run and return output", async () => {
    const { createBackgroundTaskTools } = await import("./tools/background-task.js");
    const dir = mkdtempSync(join(tmpdir(), "claw-task-"));
    const tools = Object.fromEntries(createBackgroundTaskTools().map((tool) => [tool.name, tool]));

    const created = await tools.task_create.execute({
        command: [process.execPath, "-e", "console.log('task-ok')"],
        cwd: dir,
    });
    assert.equal(created.success, true);
    const jobId = JSON.parse(String(created.output)).job_id;

    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = await tools.task_status.execute({ job_id: jobId });
    assert.equal(JSON.parse(String(status.output)).running, false);

    const output = await tools.task_output.execute({ job_id: jobId });
    assert.match(String(output.output), /task-ok/);
});

test("plugin compat loader reads claude-style manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "claw-plugin-"));
    const plugin = join(root, "demo");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    mkdirSync(join(plugin, "skills", "review"), { recursive: true });
    mkdirSync(join(plugin, "commands"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({
        name: "demo-plugin",
        description: "Demo plugin",
        skills_dir: "skills",
        commands_dir: "commands",
        mcp_file: ".mcp.json",
    }));
    writeFileSync(join(plugin, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\nBody");
    writeFileSync(join(plugin, "commands", "hello.md"), "# Hello\nRun hello");
    writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ servers: { demo: { command: "x" } } }));

    const { loadPlugin } = await import("./plugin-compat.js");
    const loaded = loadPlugin(plugin);
    assert.ok(loaded);
    assert.equal(loaded.name, "demo-plugin");
    assert.deepEqual(loaded.skills.map((skill) => skill.name), ["review"]);
    assert.deepEqual(loaded.commands.map((command) => command.name), ["hello"]);
    assert.ok(loaded.mcpServers.demo);
});

test("mcp auth tool updates config and reconnects", async () => {
    const { MCPServerManager } = await import("./mcp/manager.js");
    const { createMcpAuthTool } = await import("./tools/mcp-auth.js");

    class FakeServer {
        name = "demo";
        params = { url: "https://example.test/mcp", headers: {} as Record<string, string> };
        reconnected = 0;
        async connect() { this.reconnected++; }
        async shutdown() {}
        async listTools() { return []; }
        async invokeTool() { return {}; }
    }

    const server = new FakeServer();
    const manager = new MCPServerManager([server as any]);
    const result = await createMcpAuthTool(manager).execute({
        server_name: "demo",
        mode: "bearer",
        value: "secret",
    });
    assert.equal(result.success, true);
    assert.equal(server.params.headers.Authorization, "Bearer secret");
    assert.equal(server.reconnected, 1);
});

test("compaction preserves carryover and emits progress events", async () => {
    const { compactIfNeeded } = await import("./graph/agent-loop.js");
    const { RunContext } = await import("./run-context.js");
    const { setCompactionCarryover } = await import("./context/carryover.js");

    const originalCwd = process.cwd();
    const compactDir = mkdtempSync(join(tmpdir(), "claw-compact-"));
    process.chdir(compactDir);
    try {
        const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = [
            { role: "system", content: "system" },
        ];
        for (let i = 0; i < 24; i++) {
            messages.push({ role: "user" as const, content: `history ${i} ${"x".repeat(500)}` });
        }

        const ctx = new RunContext();
        setCompactionCarryover(ctx, {
            taskFocus: "finish runtime continuity",
            recentFiles: ["src/graph/agent-loop.ts"],
            recentWorkLog: ["added failing tests"],
            invokedSkills: ["autopilot"],
            activeWorkers: ["worker-a"],
            channelLog: [{ channelId: "telegram", conversationId: "chat-1", body: "/status now" }],
            metadata: { release: "6.8" },
        });

        const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
        const compacted = await compactIfNeeded(
            messages,
            200,
            { name: "fake", async chat() { return { content: "summarized old work", model: "fake", tokensUsed: 12 }; } },
            (kind, data) => events.push({ kind, data }),
            1.0,
            undefined,
            ctx,
        );

        const summary = compacted.find((m) => m.content.includes("Compacted History"))?.content ?? "";
        assert.match(summary, /## Carryover State/);
        assert.match(summary, /finish runtime continuity/);
        assert.match(summary, /src\/graph\/agent-loop\.ts/);
        assert.match(summary, /\/status now/);

        const phases = events.filter((e) => e.kind === "compact_progress").map((e) => e.data.phase);
        assert.equal(phases[0], "start");
        assert.ok(phases.includes("end"));
    } finally {
        process.chdir(originalCwd);
    }
});

test("subprocess worker backend runs headless JSON protocol", async () => {
    const { SubprocessWorkerBackend } = await import("./graph/coordinator.js");
    const script = [
        "let input='';",
        "process.stdin.on('data', c => input += c);",
        "process.stdin.on('end', () => {",
        " const payload = JSON.parse(input);",
        " console.log(JSON.stringify({ status: 'done', result: 'subprocess:' + payload.id + ':' + payload.prompt }));",
        "});",
    ].join("");

    const backend = new SubprocessWorkerBackend([process.execPath, "-e", script]);
    const result = await backend.run(
        { id: "task_1", prompt: "hello", tools: ["read_file"], status: "running", result: "", durationS: 0 },
        undefined as any,
        undefined,
        123,
    );

    assert.equal(result.status, "done");
    assert.equal(result.result, "subprocess:task_1:hello");
    assert.ok(result.durationS >= 0);
});

test("channel messages parse commands and normalize attachments", async () => {
    const { normalizeChannelMessage, channelMessageToAgentInput } = await import("./channels/index.js");

    const msg = normalizeChannelMessage({
        channelId: "telegram",
        senderId: "u1",
        conversationId: "chat-1",
        body: "/deploy staging now",
        timestamp: 1,
        media: [{ url: "file:///tmp/log.txt", mimeType: "text/plain", filename: "log.txt" }],
    });

    assert.equal(msg.command?.name, "deploy");
    assert.equal(msg.command?.args, "staging now");
    assert.equal(msg.media?.[0]?.mimeType, "text/plain");

    const prompt = channelMessageToAgentInput(msg);
    assert.match(prompt, /\[Channel Command: deploy\]/);
    assert.match(prompt, /staging now/);
    assert.match(prompt, /log\.txt/);
});
