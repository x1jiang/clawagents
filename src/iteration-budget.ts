/**
 * Per-agent iteration budget (Hermes-style).
 *
 * Each agent (parent or subagent) gets its own {@link IterationBudget}.
 * The parent's budget is capped at ``maxIterations`` (default ``200`` for
 * clawagents). Each subagent gets an *independent* budget capped at
 * ``delegation.maxIterations`` (default ``50``) — this means total
 * iterations across parent + subagents can exceed the parent's cap.
 *
 * Why a budget rather than a plain counter?
 *   * Subagents must not silently steal turns from the parent. Giving each
 *     delegate its own budget ensures that a runaway subagent cannot
 *     starve the top-level conversation.
 *   * Some "free" iterations (e.g., programmatic tool batches that the
 *     loop inserted, MCP listing tools that just return schemas) shouldn't
 *     eat the user's budget. {@link IterationBudget.refund} lets the loop
 *     give an iteration back without racing the remaining counter.
 *   * A central budget object gives the loop a single source of truth for
 *     "are we out of turns?" instead of scattered counters.
 *
 * Mirrors Hermes' ``IterationBudget`` (``run_agent.py``). Node's event loop
 * is single-threaded so no explicit lock is needed; the helpers still
 * guard the counter against re-entrant ``consume``/``refund`` patterns
 * by checking bounds on every call.
 */

/**
 * Default budget for a delegated subagent. Mirrors Hermes'
 * ``delegation.max_iterations`` default of 50 so users that import this
 * constant aren't surprised by a different ceiling. Override per-call via
 * the ``task`` tool's ``max_iterations`` argument or per-agent via
 * ``delegation.max_iterations`` in your runtime config.
 */
export const DEFAULT_DELEGATION_MAX_ITERATIONS = 50;

/**
 * Bounded iteration counter for a single agent run.
 *
 * The budget is consumed once per tool-calling round in the agent loop.
 * Long agent runs that delegate to subagents create a *fresh* budget for
 * each child; the parent's budget is unaffected by subagent iterations.
 *
 * @example
 * const budget = new IterationBudget(10);
 * while (budget.remaining > 0) {
 *     if (!budget.consume()) break;
 *     // ...one round of tool calls...
 * }
 */
export class IterationBudget {
    public readonly maxTotal: number;
    private _used = 0;

    constructor(maxTotal: number) {
        if (!Number.isFinite(maxTotal) || maxTotal < 0) {
            throw new RangeError(
                `IterationBudget maxTotal must be a finite non-negative number, got ${maxTotal}`,
            );
        }
        this.maxTotal = Math.floor(maxTotal);
    }

    /**
     * Try to consume one iteration. Returns ``true`` if allowed, ``false``
     * once the budget is exhausted. Callers should treat the first
     * ``false`` as a signal to stop the loop and return whatever partial
     * output exists, mirroring Hermes' "max_iterations reached" outcome.
     */
    consume(): boolean {
        if (this._used >= this.maxTotal) {
            return false;
        }
        this._used += 1;
        return true;
    }

    /**
     * Give back one iteration. Used for "free" turns the user shouldn't
     * pay for (programmatic continuation rounds, internal MCP-listing
     * tool calls, etc.).
     */
    refund(): void {
        if (this._used > 0) {
            this._used -= 1;
        }
    }

    get used(): number {
        return this._used;
    }

    get remaining(): number {
        return Math.max(0, this.maxTotal - this._used);
    }

    toString(): string {
        return `IterationBudget(used=${this._used}, maxTotal=${this.maxTotal}, remaining=${this.remaining})`;
    }
}
