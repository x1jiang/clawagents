/**
 * Auxiliary model registry — pick the right model for each task.
 *
 * Real agent runs do more than just "the main reasoning LLM". They
 * also:
 *
 * - **Compress** long conversations into a running summary (a cheap +
 *   fast model is a better fit than the flagship reasoner).
 * - **Title** threads / runs (a tiny model is plenty).
 * - **Process images** (only the multimodal models can do this).
 * - **Judge / evaluate** trajectories or outputs.
 *
 * Hermes-style frameworks let operators pin a *different* model to
 * each of these auxiliary tasks. This module gives ClawAgents the same
 * capability via a small, dependency-free registry.
 *
 * @example
 * ```ts
 * import { AuxModelRegistry, AuxModelTask } from "clawagents";
 *
 * const aux = AuxModelRegistry.fromEnv("gpt-5.4");
 * aux.set(AuxModelTask.Compression, "gpt-5.4-mini");
 * aux.set(AuxModelTask.Title, { model: "gpt-5.4-mini", maxTokens: 20 });
 *
 * const spec = aux.get(AuxModelTask.Compression);
 * // → { model: "gpt-5.4-mini", ... }
 * ```
 *
 * The registry is a *lookup table* — it never calls the LLM itself.
 * Any component that wants to pick a task-specific model imports this
 * module, asks for the spec, and feeds the result into its provider
 * call.
 *
 * Environment overrides:
 * - `CLAW_MODEL_COMPRESSION` — compression task default
 * - `CLAW_MODEL_TITLE`       — title task default
 * - `CLAW_MODEL_VISION`      — vision task default
 * - `CLAW_MODEL_JUDGE`       — judge task default
 *
 * Each can be either a model id (`"gpt-5.4-mini"`) or a
 * `model@base_url` shorthand (`"llama3.2:3b@http://localhost:11434"`).
 *
 * Mirrors `clawagents_py/src/clawagents/aux_models.py`.
 */

/** A named slot for an auxiliary model role. */
export const AuxModelTask = {
    Primary: "primary",
    Compression: "compression",
    Title: "title",
    Vision: "vision",
    Judge: "judge",
} as const;
export type AuxModelTask = (typeof AuxModelTask)[keyof typeof AuxModelTask];

const ENV_VAR: Record<Exclude<AuxModelTask, "primary">, string> = {
    compression: "CLAW_MODEL_COMPRESSION",
    title: "CLAW_MODEL_TITLE",
    vision: "CLAW_MODEL_VISION",
    judge: "CLAW_MODEL_JUDGE",
};

/** Provider-agnostic description of *which* model to use for a task. */
export interface AuxModelSpec {
    /** Required. The model identifier (e.g. `"gpt-5.4-mini"`). */
    model: string;
    /** Optional non-default endpoint (Ollama, self-hosted gateway, …). */
    baseUrl?: string;
    /** Optional API key override. Avoid embedding secrets here. */
    apiKey?: string;
    /** Optional sampling temperature. */
    temperature?: number;
    /** Optional response length cap (e.g. `20` for snappy titles). */
    maxTokens?: number;
    /** Free-form provider-specific knobs. */
    extra?: Record<string, unknown>;
}

/** Promote a bare `string` model id (or `model@base_url`) to a spec. */
export function coerceAuxSpec(value: string | AuxModelSpec): AuxModelSpec {
    if (typeof value !== "string") return value;
    const s = value.trim();
    if (!s) throw new Error("coerceAuxSpec: empty model string");
    const at = s.indexOf("@");
    if (at >= 0) {
        const model = s.slice(0, at).trim();
        const baseUrl = s.slice(at + 1).trim();
        return baseUrl ? { model, baseUrl } : { model };
    }
    return { model: s };
}

/** Return a new spec with the given fields overridden. */
export function withOverrides(spec: AuxModelSpec, changes: Partial<AuxModelSpec>): AuxModelSpec {
    return { ...spec, ...changes };
}

/**
 * Per-run lookup table from {@link AuxModelTask} (or a custom string
 * id) to {@link AuxModelSpec}.
 *
 * Construct one for each agent run. Fallback rule: if a task has no
 * explicit binding, {@link get} returns the `Primary` spec. This means
 * callers can ask for `Compression` even when the operator hasn't
 * configured one — they still get *a* model.
 */
export class AuxModelRegistry {
    private slotsMap: Map<string, AuxModelSpec> = new Map();

    constructor(primary: string | AuxModelSpec) {
        this.set(AuxModelTask.Primary, primary);
    }

    /** Bind a model to a task slot. Overwrites any existing binding. */
    set(task: AuxModelTask | string, spec: string | AuxModelSpec): void {
        this.slotsMap.set(task, coerceAuxSpec(spec));
    }

    /** Remove a binding (so {@link get} falls back to Primary). */
    unset(task: AuxModelTask | string): void {
        if (task === AuxModelTask.Primary) {
            throw new Error("Primary is required and cannot be unset");
        }
        this.slotsMap.delete(task);
    }

    /** Return the spec for a task, falling back to Primary. */
    get(task: AuxModelTask | string): AuxModelSpec {
        const found = this.slotsMap.get(task);
        if (found) return found;
        return this.slotsMap.get(AuxModelTask.Primary)!;
    }

    /** True iff an explicit binding exists for `task` (no fallback). */
    has(task: AuxModelTask | string): boolean {
        return this.slotsMap.has(task);
    }

    /** Shorthand for `this.get(AuxModelTask.Primary)`. */
    primary(): AuxModelSpec {
        return this.slotsMap.get(AuxModelTask.Primary)!;
    }

    /** Return a shallow copy of the binding map. */
    slots(): Record<string, AuxModelSpec> {
        const out: Record<string, AuxModelSpec> = {};
        for (const [k, v] of this.slotsMap) out[k] = v;
        return out;
    }

    /**
     * Build a registry, populating known tasks from env vars.
     *
     * @param primary  The primary model (always required — env vars
     *                 are only consulted for the auxiliary slots).
     * @param env      Optional env dict (defaults to `process.env`).
     *                 Mainly useful for tests.
     */
    static fromEnv(
        primary: string | AuxModelSpec,
        env?: Record<string, string | undefined>,
    ): AuxModelRegistry {
        const e = env ?? (process.env as Record<string, string | undefined>);
        const reg = new AuxModelRegistry(primary);
        for (const [task, varName] of Object.entries(ENV_VAR) as [
            Exclude<AuxModelTask, "primary">,
            string,
        ][]) {
            const raw = e[varName];
            if (raw && raw.trim()) reg.set(task, raw);
        }
        return reg;
    }
}
