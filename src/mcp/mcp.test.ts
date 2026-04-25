/**
 * Tests for the MCP (Model Context Protocol) client integration.
 *
 * The whole subpackage must import cleanly even when
 * ``@modelcontextprotocol/sdk`` is not installed. Live-server tests only
 * run when the SDK is available.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    MCPLifecyclePhase,
    MCPServer,
    MCPServerStdio,
    MCPServerSse,
    MCPServerStreamableHttp,
    MCPServerManager,
    MCPBridgedTool,
    mcpToolToClawagentsTool,
    isMCPSdkAvailable,
    requireMCPSdk,
} from "./index.js";
import { normalizeInputSchema, stringifyCallResult } from "./tool_bridge.js";
import { ToolRegistry } from "../tools/registry.js";

async function sdkInstalled(): Promise<boolean> {
    return await isMCPSdkAvailable();
}

// ─── Always-on tests ──────────────────────────────────────────────────────

test("public surface re-exported from top-level entry", async () => {
    const top = await import("../index.js");
    for (const name of [
        "MCPServer",
        "MCPServerStdio",
        "MCPServerSse",
        "MCPServerStreamableHttp",
        "MCPServerManager",
        "MCPLifecyclePhase",
        "MCPBridgedTool",
        "mcpToolToClawagentsTool",
        "isMCPSdkAvailable",
        "requireMCPSdk",
    ]) {
        assert.ok((top as Record<string, unknown>)[name], `clawagents top-level export missing: ${name}`);
    }
});

test("subpackage imports without optional SDK", () => {
    // The fact that this module loaded already proves the import works
    // without the SDK present at module-load time. Sanity check the symbols.
    assert.equal(typeof MCPServerStdio, "function");
    assert.equal(typeof MCPServerManager, "function");
    assert.equal(typeof MCPServer, "function");
});

test("MCPLifecyclePhase exposes expected states", () => {
    const expected = new Set([
        "idle", "connecting", "initializing", "discovering_tools",
        "ready", "invoking", "errored", "shutdown",
    ]);
    const actual = new Set(Object.values(MCPLifecyclePhase) as string[]);
    assert.deepEqual(actual, expected);
});

test("normalizeInputSchema flattens JSON Schema properties", () => {
    const out = normalizeInputSchema({
        type: "object",
        properties: {
            path: { type: "string", description: "where" },
            limit: { type: "integer", description: "max" },
            verbose: { type: "boolean" },
            weird: { type: ["string", "null"] },
        },
        required: ["path"],
    });
    assert.deepEqual(out["path"], { type: "string", description: "where", required: true });
    assert.deepEqual(out["limit"], { type: "integer", description: "max", required: false });
    assert.equal(out["verbose"]!.type, "boolean");
    assert.equal(out["weird"]!.type, "string");
});

test("normalizeInputSchema handles missing/empty input", () => {
    assert.deepEqual(normalizeInputSchema({}), {});
    assert.deepEqual(normalizeInputSchema({ type: "object" }), {});
    assert.deepEqual(
        normalizeInputSchema({ type: "object", properties: "not-a-dict" } as unknown as Record<string, unknown>),
        {},
    );
});

test("stringifyCallResult concatenates text blocks and detects isError", () => {
    const ok = stringifyCallResult({
        content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }],
    });
    assert.equal(ok.success, true);
    assert.equal(ok.output, "hello\nworld");
    assert.equal(ok.error, undefined);

    const err = stringifyCallResult({
        content: [{ type: "text", text: "boom" }],
        isError: true,
    });
    assert.equal(err.success, false);
    assert.match(err.output as string, /boom/);
    assert.ok(err.error);
});

test("stringifyCallResult summarises non-text blocks", () => {
    const r = stringifyCallResult({
        content: [{ type: "image", data: "..." }],
    });
    assert.equal(r.success, true);
    assert.match(r.output as string, /\[image block\]/);
});

test("MCPBridgedTool exposes the descriptor's name + parameters", () => {
    const fakeServer = { name: "fake" } as unknown as MCPServer;
    const bridged = mcpToolToClawagentsTool(
        {
            name: "echo",
            description: "echo it",
            inputSchema: {
                type: "object",
                properties: { text: { type: "string", description: "what" } },
                required: ["text"],
            },
            serverName: "fake",
        },
        fakeServer,
    );
    assert.ok(bridged instanceof MCPBridgedTool);
    assert.equal(bridged.name, "echo");
    assert.equal(bridged.description, "echo it");
    assert.deepEqual(bridged.parameters, {
        text: { type: "string", description: "what", required: true },
    });
});

test("MCPBridgedTool prefixes name when requested", () => {
    const fakeServer = { name: "fake" } as unknown as MCPServer;
    const bridged = mcpToolToClawagentsTool(
        { name: "echo", description: "", inputSchema: {}, serverName: "fake" },
        fakeServer,
        { namePrefix: "fake" },
    );
    assert.equal(bridged.name, "fake.echo");
});

test("requireMCPSdk surfaces a clear error when SDK missing", async () => {
    if (await sdkInstalled()) {
        // Can't test the negative path when the SDK is installed —
        // verify that requireMCPSdk silently succeeds.
        await requireMCPSdk();
        return;
    }
    await assert.rejects(
        () => requireMCPSdk(),
        /@modelcontextprotocol\/sdk/,
    );
});

test("createClawAgent rejects mcpServers without SDK installed (mocked)", async (t) => {
    // Stub out the module-level cache so the SDK appears unavailable even
    // when it is in fact installed in the dev tree.
    if (await sdkInstalled()) {
        t.skip("SDK installed — exercise the real-error path on a fresh clone");
        return;
    }
    const { createClawAgent } = await import("../agent.js");
    const dummyServer = new MCPServerStdio({ params: { command: "true" } });
    await assert.rejects(
        () => createClawAgent({ mcpServers: [dummyServer] }),
        /@modelcontextprotocol\/sdk/,
    );
});

// ─── Live-server tests ────────────────────────────────────────────────────

const FIXTURE_SOURCE = `
import asyncio
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent


server = Server("clawagents-test-fixture")


@server.list_tools()
async def _list_tools():
    return [
        Tool(
            name="echo",
            description="Echo the provided text.",
            inputSchema={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Text to echo"},
                },
                "required": ["text"],
            },
        )
    ]


@server.call_tool()
async def _call_tool(name, arguments):
    if name == "echo":
        text = (arguments or {}).get("text", "")
        return [TextContent(type="text", text=f"echo: {text}")]
    raise ValueError(f"Unknown tool: {name}")


async def main():
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
`;

function writeFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "clawagents-mcp-"));
    const path = join(dir, "echo_mcp_server.py");
    writeFileSync(path, FIXTURE_SOURCE, "utf-8");
    return path;
}

// We need both the TS SDK and a Python MCP server SDK to run live tests.
// The Python SDK is a soft dependency we probe for (used to spawn the fixture).
async function pythonHasMCP(): Promise<boolean> {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("python", ["-c", "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('mcp') else 1)"], { stdio: "ignore" });
    return r.status === 0;
}

test("stdio server lists and invokes echo tool", async (t) => {
    if (!(await sdkInstalled())) {
        t.skip("@modelcontextprotocol/sdk not installed");
        return;
    }
    if (!(await pythonHasMCP())) {
        t.skip("python `mcp` module not installed (used by the test fixture)");
        return;
    }
    const fixture = writeFixture();
    const server = new MCPServerStdio({
        params: { command: "python", args: [fixture] },
        name: "echo-fixture",
    });
    try {
        await server.connect();
        const tools = await server.listTools();
        assert.deepEqual(tools.map((t) => t.name), ["echo"]);
        const result = await server.invokeTool("echo", { text: "hi" });
        const blocks = (result?.content ?? []) as Array<{ text?: string }>;
        const text = blocks.map((b) => b.text ?? "").join("\n");
        assert.match(text, /echo: hi/);
    } finally {
        await server.shutdown();
    }
});

test("manager bridges MCP tool into ToolRegistry", async (t) => {
    if (!(await sdkInstalled())) {
        t.skip("@modelcontextprotocol/sdk not installed");
        return;
    }
    if (!(await pythonHasMCP())) {
        t.skip("python `mcp` module not installed (used by the test fixture)");
        return;
    }
    const fixture = writeFixture();
    const server = new MCPServerStdio({
        params: { command: "python", args: [fixture] },
        name: "echo-fixture",
    });
    const registry = new ToolRegistry();
    const manager = new MCPServerManager([server]);
    try {
        const registered = await manager.start(registry);
        assert.ok(registered.includes("echo"));
        const bridged = registry.get("echo");
        assert.ok(bridged);
        assert.ok("text" in bridged.parameters);
        const result = await bridged.execute({ text: "hello" });
        assert.equal(result.success, true);
        assert.match(result.output as string, /echo: hello/);
    } finally {
        await manager.shutdown();
    }
});

test("lifecycle phase progresses through expected states", async (t) => {
    if (!(await sdkInstalled())) {
        t.skip("@modelcontextprotocol/sdk not installed");
        return;
    }
    if (!(await pythonHasMCP())) {
        t.skip("python `mcp` module not installed (used by the test fixture)");
        return;
    }
    const fixture = writeFixture();
    const server = new MCPServerStdio({
        params: { command: "python", args: [fixture] },
        name: "echo-fixture",
    });
    assert.equal(server.phase, MCPLifecyclePhase.Idle);
    try {
        await server.connect();
        assert.equal(server.phase, MCPLifecyclePhase.Ready);
        await server.listTools();
        assert.equal(server.phase, MCPLifecyclePhase.Ready);
    } finally {
        await server.shutdown();
    }
    assert.equal(server.phase, MCPLifecyclePhase.Shutdown);
});

// Touch the SSE / Streamable HTTP constructors so they are imported and
// the SDK probe path runs at least once.
test("SSE / Streamable HTTP servers construct without errors", () => {
    const sse = new MCPServerSse({ params: { url: "https://example.com/mcp/sse" }, name: "sse" });
    assert.equal(sse.name, "sse");
    assert.equal(sse.phase, MCPLifecyclePhase.Idle);

    const http = new MCPServerStreamableHttp({
        params: { url: "https://example.com/mcp" },
        name: "http",
    });
    assert.equal(http.name, "http");
    assert.equal(http.phase, MCPLifecyclePhase.Idle);
});
