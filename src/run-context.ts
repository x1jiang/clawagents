/**
 * Typed user context threaded through an agent run.
 *
 * `RunContext<TContext>` carries user-supplied state (`context`), a live
 * {@link Usage} accumulator, and the per-call tool approval store through
 * the agent loop. It is passed to any tool whose `execute` signature
 * declares a `runContext` parameter, and to class-based hooks
 * ({@link RunHooks}, {@link AgentHooks}).
 *
 * Mirrors `clawagents_py`'s ``RunContext`` and openai-agents-python's
 * ``RunContextWrapper``. Backward-compatible: existing tools that accept
 * only ``args`` continue to work unchanged.
 */

import { IterationBudget } from "./iteration-budget.js";
import { PermissionMode } from "./permissions/mode.js";
import { Usage } from "./usage.js";

/**
 * Maximum nesting depth for sub-agent delegation. Mirrors Hermes' policy:
 * a subagent (depth=1) may not itself spawn another subagent (depth=2 is the
 * hard cap; the `task` tool refuses any new spawn when
 * `depth >= MAX_SUBAGENT_DEPTH`). Bounds worst-case token / iteration / time
 * blowup of recursive delegation.
 */
export const MAX_SUBAGENT_DEPTH = 2;

/** Per-call-ID approval decision for a tool call. */
export interface ApprovalRecord {
    /** True to run the tool, false to reject. */
    approved: boolean;
    /**
     * If true, the decision persists for subsequent calls to the same tool
     * (keyed by tool name) in this run.
     */
    always?: boolean;
    /** Optional explanation echoed back to the model on rejection. */
    reason?: string;
}

/** Typed context wrapper passed through a run. */
export class RunContext<TContext = unknown> {
    public context: TContext | undefined;
    public usage: Usage;
    /**
     * Current permission mode. Mutated only by the dedicated plan-mode
     * tools (enter_plan_mode / exit_plan_mode). Read by the registry to
     * gate write-class tools when in PLAN mode.
     */
    public permissionMode: PermissionMode;
    /**
     * Sub-agent nesting depth. `0` for the top-level / user-facing run,
     * `1` for a first-level subagent, `2` for a sub-subagent (capped at
     * {@link MAX_SUBAGENT_DEPTH}). The `task` tool refuses to spawn when
     * `depth >= MAX_SUBAGENT_DEPTH`.
     */
    public depth: number;
    /**
     * When `true`, the agent loop and any memory loaders skip reading the
     * parent's memory directory, lessons, and persisted skill state.
     * Sub-agent runs default to `true` so they remain isolated.
     */
    public skipMemory: boolean;
    /**
     * Optional per-agent iteration budget. When set, the agent loop
     * consumes one unit per round and stops when the budget is exhausted,
     * even if `maxIterations` would still allow more rounds. Each
     * subagent gets a *fresh* budget so a runaway delegate cannot starve
     * the parent run. Mirrors Hermes' ``IterationBudget``.
     */
    public iterationBudget: IterationBudget | undefined;
    /** Per-call-ID approvals. */
    public _approvals: Map<string, ApprovalRecord>;
    /** "Always approve/reject" decisions keyed by tool name. */
    public _alwaysApprovals: Map<string, ApprovalRecord>;
    /** Free-form metadata bag for integrations (e.g. tracing). */
    public _metadata: Record<string, unknown>;

    constructor(init: {
        context?: TContext;
        usage?: Usage;
        metadata?: Record<string, unknown>;
        permissionMode?: PermissionMode;
        depth?: number;
        skipMemory?: boolean;
        iterationBudget?: IterationBudget;
    } = {}) {
        this.context = init.context;
        this.usage = init.usage ?? new Usage();
        this.permissionMode = init.permissionMode ?? PermissionMode.DEFAULT;
        this.depth = init.depth ?? 0;
        this.skipMemory = init.skipMemory ?? false;
        this.iterationBudget = init.iterationBudget;
        this._approvals = new Map();
        this._alwaysApprovals = new Map();
        this._metadata = init.metadata ?? {};
    }

    /**
     * Record an approval for a specific tool `callId`.
     * If `always` and `toolName` are provided, future calls to the same
     * tool in this run will be auto-approved.
     */
    approveTool(
        callId: string,
        options: { always?: boolean; toolName?: string } = {},
    ): void {
        const rec: ApprovalRecord = { approved: true, always: !!options.always };
        this._approvals.set(callId, rec);
        if (options.always && options.toolName) {
            this._alwaysApprovals.set(options.toolName, rec);
        }
    }

    /** Record a rejection for a specific tool `callId`. */
    rejectTool(
        callId: string,
        options: { always?: boolean; toolName?: string; reason?: string } = {},
    ): void {
        const rec: ApprovalRecord = {
            approved: false,
            always: !!options.always,
            reason: options.reason,
        };
        this._approvals.set(callId, rec);
        if (options.always && options.toolName) {
            this._alwaysApprovals.set(options.toolName, rec);
        }
    }

    /** Return true if approved, false if rejected, undefined if undecided. */
    isToolApproved(
        callId: string,
        options: { toolName?: string } = {},
    ): boolean | undefined {
        const rec = this._approvals.get(callId);
        if (rec !== undefined) return rec.approved;
        if (options.toolName) {
            const always = this._alwaysApprovals.get(options.toolName);
            if (always) return always.approved;
        }
        return undefined;
    }

    /** Return the full {@link ApprovalRecord} (including reason), if any. */
    getApproval(
        callId: string,
        options: { toolName?: string } = {},
    ): ApprovalRecord | undefined {
        const rec = this._approvals.get(callId);
        if (rec !== undefined) return rec;
        if (options.toolName) return this._alwaysApprovals.get(options.toolName);
        return undefined;
    }
}
