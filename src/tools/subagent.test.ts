/**
 * Tests for subagent depth-cap and memory isolation (Hermes parity).
 *
 * The {@link TaskTool} must refuse to spawn a child sub-agent when the parent
 * `RunContext.depth` is already at `MAX_SUBAGENT_DEPTH`. This bounds recursive
 * delegation and keeps cost predictable. Children must also run with
 * `skipMemory=true` so they cannot read the parent's memory state.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TaskTool, type RunAgentGraphFn } from "./subagent.js";
import { MAX_SUBAGENT_DEPTH, RunContext } from "../run-context.js";
import type { AgentState } from "../graph/agent-loop.js";

type AnyArgs = Record<string, unknown>;

const fakeState = {
    status: "done",
    result: "ok",
    toolCalls: 0,
    iterations: 1,
} as unknown as AgentState;

interface CapturedCall {
    extras?: { runContext?: RunContext };
}

/**
 * Build a fake `runAgentGraph` and a record of how it was called. The
 * extras arg is the *last* positional argument of the real signature.
 */
function makeFakeRunAgentGraph(): { fn: RunAgentGraphFn; captured: CapturedCall } {
    const captured: CapturedCall = {};
    const fn = ((...args: unknown[]) => {
        const extras = args[args.length - 1] as
            | { runContext?: RunContext }
            | undefined;
        captured.extras = extras;
        return Promise.resolve(fakeState);
    }) as unknown as RunAgentGraphFn;
    return { fn, captured };
}

function makeTaskTool(runAgentGraphImpl: RunAgentGraphFn): TaskTool {
    return new TaskTool(
        null as never, // llm — not dereferenced in these tests
        null as never, // tools — not dereferenced in these tests
        [],
        false,
        runAgentGraphImpl,
    );
}

describe("TaskTool subagent depth-cap and memory isolation", () => {
    it("top-level call (depth=0) spawns child with depth=1 and skipMemory=true", async () => {
        const { fn, captured } = makeFakeRunAgentGraph();
        const tool = makeTaskTool(fn);
        const ctx = new RunContext();

        const result = await tool.execute(
            { description: "do a thing" } as AnyArgs,
            ctx,
        );

        assert.equal(result.success, true);
        assert.ok(captured.extras, "extras arg was captured");
        const child = captured.extras!.runContext!;
        assert.equal(child.depth, 1);
        assert.equal(child.skipMemory, true);
    });

    it("subagent at depth=1 can still spawn one grandchild (depth=2)", async () => {
        const { fn, captured } = makeFakeRunAgentGraph();
        const tool = makeTaskTool(fn);
        const ctx = new RunContext({ depth: 1 });

        const result = await tool.execute(
            { description: "nested" } as AnyArgs,
            ctx,
        );

        assert.equal(result.success, true);
        const child = captured.extras!.runContext!;
        assert.equal(child.depth, 2);
        assert.equal(child.skipMemory, true);
    });

    it("subagent at depth=MAX_SUBAGENT_DEPTH is refused; runAgentGraph is NOT called", async () => {
        let called = false;
        const fn = ((..._args: unknown[]) => {
            called = true;
            return Promise.resolve(fakeState);
        }) as unknown as RunAgentGraphFn;

        const tool = makeTaskTool(fn);
        const ctx = new RunContext({ depth: MAX_SUBAGENT_DEPTH });
        const result = await tool.execute(
            { description: "should be refused" } as AnyArgs,
            ctx,
        );

        assert.equal(called, false);
        assert.equal(result.success, false);
        const msg = `${result.error ?? ""}${result.output ?? ""}`.toLowerCase();
        assert.ok(msg.includes("depth cap"), `expected 'depth cap' in: ${msg}`);
        assert.ok(msg.includes(String(MAX_SUBAGENT_DEPTH)));
    });

    it("missing runContext is treated as top-level (depth=0)", async () => {
        const { fn, captured } = makeFakeRunAgentGraph();
        const tool = makeTaskTool(fn);

        const result = await tool.execute({
            description: "do a thing",
        } as AnyArgs);

        assert.equal(result.success, true);
        const child = captured.extras!.runContext!;
        assert.equal(child.depth, 1);
        assert.equal(child.skipMemory, true);
    });

    it("RunContext defaults: depth=0, skipMemory=false", () => {
        const ctx = new RunContext();
        assert.equal(ctx.depth, 0);
        assert.equal(ctx.skipMemory, false);
    });

    it("MAX_SUBAGENT_DEPTH is locked to 2 (matches AGENTS.md)", () => {
        assert.equal(MAX_SUBAGENT_DEPTH, 2);
    });
});
