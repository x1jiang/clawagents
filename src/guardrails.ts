/**
 * Input / output guardrails.
 *
 * A guardrail is an async function that inspects either the incoming
 * user task ({@link InputGuardrail}) or a final assistant message
 * ({@link OutputGuardrail}) and returns a {@link GuardrailResult}. The
 * agent loop enforces the result using the {@link GuardrailBehavior}
 * enum:
 *
 * - `ALLOW` — proceed unchanged (default when a guardrail passes).
 * - `REJECT_CONTENT` — replace the offending payload with the
 *   guardrail's `replacementOutput` and stop the loop.
 * - `RAISE_EXCEPTION` — throw {@link GuardrailTripwireTriggered}.
 *
 * Both input and output guardrails can be attached to an agent; they
 * fire in registration order and short-circuit on the first non-ALLOW
 * decision.
 */

import type { RunContext } from "./run-context.js";

export enum GuardrailBehavior {
    ALLOW = "allow",
    REJECT_CONTENT = "reject_content",
    RAISE_EXCEPTION = "raise_exception",
}

export interface GuardrailResult {
    behavior: GuardrailBehavior;
    replacementOutput?: string;
    message?: string;
    metadata?: Record<string, unknown>;
}

export const GuardrailResult = {
    allow(): GuardrailResult {
        return { behavior: GuardrailBehavior.ALLOW };
    },
    reject(replacement: string, options: { message?: string } = {}): GuardrailResult {
        return {
            behavior: GuardrailBehavior.REJECT_CONTENT,
            replacementOutput: replacement,
            message: options.message,
        };
    },
    raiseExc(message: string): GuardrailResult {
        return { behavior: GuardrailBehavior.RAISE_EXCEPTION, message };
    },
} as const;

export class GuardrailTripwireTriggered extends Error {
    guardrailName: string;
    where: "input" | "output";
    result: GuardrailResult;

    constructor(
        guardrailName: string,
        where: "input" | "output",
        result: GuardrailResult,
    ) {
        super(
            `[${where} guardrail '${guardrailName}'] ${result.message || "tripwire triggered"}`,
        );
        this.name = "GuardrailTripwireTriggered";
        this.guardrailName = guardrailName;
        this.where = where;
        this.result = result;
    }
}

export type InputGuardrailFn<TContext = unknown> = (
    ctx: RunContext<TContext>,
    task: string,
) => Promise<GuardrailResult> | GuardrailResult;

export type OutputGuardrailFn<TContext = unknown> = (
    ctx: RunContext<TContext>,
    output: string,
) => Promise<GuardrailResult> | GuardrailResult;

export class InputGuardrail<TContext = unknown> {
    constructor(
        public readonly name: string,
        public readonly guardrailFn: InputGuardrailFn<TContext>,
    ) {}

    async run(
        ctx: RunContext<TContext>,
        task: string,
    ): Promise<GuardrailResult> {
        return await this.guardrailFn(ctx, task);
    }
}

export class OutputGuardrail<TContext = unknown> {
    constructor(
        public readonly name: string,
        public readonly guardrailFn: OutputGuardrailFn<TContext>,
    ) {}

    async run(
        ctx: RunContext<TContext>,
        output: string,
    ): Promise<GuardrailResult> {
        return await this.guardrailFn(ctx, output);
    }
}

/** Helper: wrap a function into an {@link InputGuardrail}. */
export function inputGuardrail<TContext = unknown>(
    name: string,
    fn: InputGuardrailFn<TContext>,
): InputGuardrail<TContext> {
    return new InputGuardrail(name, fn);
}

/** Helper: wrap a function into an {@link OutputGuardrail}. */
export function outputGuardrail<TContext = unknown>(
    name: string,
    fn: OutputGuardrailFn<TContext>,
): OutputGuardrail<TContext> {
    return new OutputGuardrail(name, fn);
}
