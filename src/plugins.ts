/**
 * Plugin manager for ClawAgents (learned from Hermes).
 *
 * A *plugin* is a named bundle of hooks. The manager composes plugins in
 * priority order into the single hook slots accepted by `runAgentGraph` /
 * `Agent`. This lets callers register multiple cross-cutting concerns
 * (observability, redaction, policy, sandbox limits) without losing the
 * backward-compatible single-hook signature.
 *
 * Hooks supported per plugin:
 *  - `preTool` (alias `beforeTool`) — pre_tool veto. Returning `false` or
 *    `{ allowed: false, reason }` blocks the call. Returning `{ allowed: true,
 *    updatedArgs }` rewrites the call. The first plugin to deny wins.
 *  - `transformToolResult` (alias `afterTool`) — composed left-to-right;
 *    each plugin receives the previous plugin's transformed result.
 *  - `beforeLLM` — pre-flight message rewriter, composed left-to-right.
 *
 * Plugin priority is ascending (lower number runs first). Two plugins with
 * the same priority retain registration order.
 */

import type {
    BeforeLLMHook,
    BeforeToolHook,
    AfterToolHook,
    HookResult,
} from "./graph/agent-loop.js";
import type { ToolResult } from "./tools/registry.js";

export interface Plugin {
    name: string;
    priority?: number;
    /** Pre-tool veto/rewrite hook. Alias: `beforeTool`. */
    preTool?: BeforeToolHook;
    beforeTool?: BeforeToolHook;
    /** Post-tool transform hook. Alias: `afterTool`. */
    transformToolResult?: AfterToolHook;
    afterTool?: AfterToolHook;
    /** Pre-LLM message rewriter. */
    beforeLLM?: BeforeLLMHook;
}

interface RegisteredPlugin extends Plugin {
    _seq: number;
    _priority: number;
}

function resolveBefore(p: Plugin): BeforeToolHook | undefined {
    return p.preTool ?? p.beforeTool;
}

function resolveAfter(p: Plugin): AfterToolHook | undefined {
    return p.transformToolResult ?? p.afterTool;
}

export class PluginManager {
    private _plugins: RegisteredPlugin[] = [];
    private _seq = 0;

    register(plugin: Plugin): void {
        const entry: RegisteredPlugin = {
            ...plugin,
            _seq: this._seq++,
            _priority: plugin.priority ?? 50,
        };
        const idx = this._plugins.findIndex(
            (p) => p._priority > entry._priority
                || (p._priority === entry._priority && p._seq > entry._seq),
        );
        if (idx === -1) this._plugins.push(entry);
        else this._plugins.splice(idx, 0, entry);
    }

    unregister(name: string): void {
        this._plugins = this._plugins.filter((p) => p.name !== name);
    }

    listPlugins(): Plugin[] {
        return this._plugins.map((p) => ({ ...p }));
    }

    composedBeforeTool(): BeforeToolHook | undefined {
        const hooks = this._plugins.map(resolveBefore).filter(Boolean) as BeforeToolHook[];
        if (hooks.length === 0) return undefined;
        return (toolName, args) => {
            let currentArgs = args;
            for (const h of hooks) {
                let raw: boolean | HookResult;
                try { raw = h(toolName, currentArgs); } catch { continue; }
                if (raw === false) return { allowed: false, reason: "rejected by plugin" };
                if (typeof raw === "object" && raw !== null) {
                    if (raw.allowed === false) return raw;
                    if (raw.updatedArgs) currentArgs = raw.updatedArgs;
                }
            }
            if (currentArgs !== args) return { allowed: true, updatedArgs: currentArgs };
            return { allowed: true };
        };
    }

    composedAfterTool(): AfterToolHook | undefined {
        const hooks = this._plugins.map(resolveAfter).filter(Boolean) as AfterToolHook[];
        if (hooks.length === 0) return undefined;
        return (toolName, args, result) => {
            let current: ToolResult = result;
            for (const h of hooks) {
                try {
                    const out = h(toolName, args, current);
                    if (out && typeof out === "object" && "success" in out) current = out;
                } catch { /* ignore */ }
            }
            return current;
        };
    }

    composedBeforeLLM(): BeforeLLMHook | undefined {
        const hooks = this._plugins.map((p) => p.beforeLLM).filter(Boolean) as BeforeLLMHook[];
        if (hooks.length === 0) return undefined;
        return (messages) => {
            let current = messages;
            for (const h of hooks) {
                try {
                    const out = h(current);
                    if (Array.isArray(out)) current = out;
                } catch { /* ignore */ }
            }
            return current;
        };
    }
}
