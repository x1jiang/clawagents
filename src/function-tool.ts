/**
 * `functionTool()` — derive a {@link Tool} from a plain function.
 *
 * Before this helper, every tool had to be a class with hand-written
 * `parameters` metadata. With `functionTool()` you write:
 *
 * ```ts
 * const searchWeb = functionTool({
 *     name: "search_web",
 *     description: "Search the web and return the top hits.",
 *     parameters: {
 *         query: { type: "string", description: "Query", required: true },
 *         limit: { type: "integer", description: "Max hits", default: 5 },
 *     },
 *     async execute({ query, limit }) { ... },
 * });
 * ```
 *
 * and get a ready-to-register {@link Tool}. Parameter schema is
 * auto-converted into the JSON-schema-style shape the rest of the
 * framework expects, and `default` values are applied before the
 * function runs.
 *
 * For Zod-based schemas use {@link createTool} which accepts a
 * `z.object({...})` and derives the parameter metadata automatically.
 */

import type { RunContext } from "./run-context.js";
import type { Tool, ToolResult } from "./tools/registry.js";

export type JsonSchemaType =
    | "string"
    | "integer"
    | "number"
    | "boolean"
    | "array"
    | "object"
    | "null";

export interface FunctionToolParamSpec {
    type: JsonSchemaType;
    description?: string;
    required?: boolean;
    default?: unknown;
    items?: { type: JsonSchemaType };
    enum?: readonly unknown[];
}

export interface FunctionToolOptions<A extends Record<string, unknown>, TContext = unknown> {
    name: string;
    description: string;
    keywords?: string[];
    parameters?: Record<string, FunctionToolParamSpec>;
    /**
     * When `true`, the wrapped function receives `runContext` as its
     * second argument. Default: inferred to `true` when
     * `execute.length >= 2`.
     */
    usesRunContext?: boolean;
    execute: (
        args: A,
        runContext?: RunContext<TContext>,
    ) => Promise<ToolResult | string | unknown> | ToolResult | string | unknown;
    /** When true, results are cached by (name, args). */
    cacheable?: boolean;
}

function normaliseResult(result: unknown): ToolResult {
    if (result === null || result === undefined) {
        return { success: true, output: "" };
    }
    if (
        typeof result === "object" &&
        result !== null &&
        "success" in result &&
        ("output" in result || "error" in result)
    ) {
        return result as ToolResult;
    }
    if (typeof result === "string") return { success: true, output: result };
    if (Array.isArray(result)) return { success: true, output: result };
    if (typeof result === "object") {
        try {
            return { success: true, output: JSON.stringify(result) };
        } catch {
            return { success: true, output: String(result) };
        }
    }
    return { success: true, output: String(result) };
}

/** Turn a plain function into a {@link Tool} with a typed arg bag. */
export function functionTool<
    A extends Record<string, unknown> = Record<string, unknown>,
    TContext = unknown,
>(options: FunctionToolOptions<A, TContext>): Tool {
    const parameters: Record<
        string,
        { type: string; description: string; required?: boolean; items?: { type: string } }
    > = {};
    const defaults: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(options.parameters ?? {})) {
        parameters[name] = {
            type: spec.type,
            description: spec.description ?? "",
            required: spec.required,
            items: spec.items,
        };
        if (spec.default !== undefined) defaults[name] = spec.default;
    }

    const fn = options.execute;
    const usesCtx = options.usesRunContext ?? fn.length >= 2;

    const tool: Tool = {
        name: options.name,
        description: options.description,
        keywords: options.keywords,
        parameters,
        cacheable: options.cacheable,
        async execute(
            args: Record<string, unknown>,
            runContext?: RunContext<unknown>,
        ): Promise<ToolResult> {
            const merged = { ...defaults, ...args } as A;
            try {
                const raw = usesCtx
                    ? await fn(merged, runContext as RunContext<TContext> | undefined)
                    : await fn(merged);
                return normaliseResult(raw);
            } catch (err) {
                return {
                    success: false,
                    output: "",
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        },
    };
    return tool;
}

// ─── Zod / JSON-schema adapter ─────────────────────────────────────────────
// Kept dependency-free: we don't import zod; we sniff it at runtime if the
// caller passes a zod-like schema. A caller using Zod just hands their
// `z.object(...)` here and we extract the minimal JSON-schema shape we need.

interface ZodLike {
    _def?: { typeName?: string; shape?: () => Record<string, ZodLike> };
    isOptional?: () => boolean;
    description?: string;
    _def_inner?: ZodLike; // for ZodOptional
}

function zodTypeName(zod: ZodLike): string {
    return zod?._def?.typeName ?? "";
}

function zodDescription(zod: ZodLike): string {
    return zod?.description ?? "";
}

function zodIsOptional(zod: ZodLike): boolean {
    const name = zodTypeName(zod);
    if (name === "ZodOptional" || name === "ZodDefault" || name === "ZodNullable") return true;
    if (typeof zod.isOptional === "function") {
        try { return zod.isOptional(); } catch { /* fall through */ }
    }
    return false;
}

function zodUnwrap(zod: ZodLike): ZodLike {
    const name = zodTypeName(zod);
    if (name === "ZodOptional" || name === "ZodDefault" || name === "ZodNullable") {
        const inner = (zod as any)._def?.innerType;
        if (inner) return zodUnwrap(inner);
    }
    return zod;
}

function zodToJsonType(zod: ZodLike): JsonSchemaType {
    const unwrapped = zodUnwrap(zod);
    const name = zodTypeName(unwrapped);
    switch (name) {
        case "ZodString": return "string";
        case "ZodNumber": return "number";
        case "ZodBigInt": return "integer";
        case "ZodBoolean": return "boolean";
        case "ZodArray": return "array";
        case "ZodObject": return "object";
        case "ZodNull": return "null";
        default: return "string";
    }
}

export interface CreateToolOptions<TContext = unknown> {
    name: string;
    description: string;
    /** Zod object schema OR a plain parameters map. */
    schema?: ZodLike | Record<string, FunctionToolParamSpec>;
    keywords?: string[];
    usesRunContext?: boolean;
    execute: (
        args: Record<string, unknown>,
        runContext?: RunContext<TContext>,
    ) => Promise<ToolResult | string | unknown> | ToolResult | string | unknown;
    cacheable?: boolean;
}

/**
 * Convenience wrapper that accepts either a Zod object schema *or* a
 * plain parameters record and produces a {@link Tool}.
 *
 * Zod is not a runtime dependency — we duck-type at the `._def` level
 * so the import graph stays clean. If the runtime detects something
 * that doesn't look like a Zod schema, the input is treated as a plain
 * parameters record.
 */
export function createTool<TContext = unknown>(
    options: CreateToolOptions<TContext>,
): Tool {
    const { schema } = options;
    let parameters: Record<string, FunctionToolParamSpec> = {};

    if (schema && typeof schema === "object" && "_def" in schema) {
        const zobj = schema as ZodLike;
        if (zodTypeName(zobj) === "ZodObject") {
            const shape = zobj._def?.shape?.() ?? {};
            for (const [key, rawValue] of Object.entries(shape)) {
                const value = rawValue as ZodLike;
                parameters[key] = {
                    type: zodToJsonType(value),
                    description: zodDescription(value),
                    required: !zodIsOptional(value),
                };
            }
        }
    } else if (schema) {
        parameters = { ...(schema as Record<string, FunctionToolParamSpec>) };
    }

    return functionTool({
        name: options.name,
        description: options.description,
        keywords: options.keywords,
        parameters,
        usesRunContext: options.usesRunContext,
        execute: options.execute as FunctionToolOptions<
            Record<string, unknown>,
            TContext
        >["execute"],
        cacheable: options.cacheable,
    });
}
