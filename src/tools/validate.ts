/**
 * Tool Parameter Validation + Lenient Type Coercion
 *
 * Validates tool arguments against their declared parameter schemas before
 * execution, catching type mismatches and missing required params early.
 * Includes lenient coercion (e.g. "42" → 42) to handle common LLM output
 * quirks without failing the tool call.
 *
 * Inspired by ToolUniverse's BaseTool.validate_parameters().
 */

import type { Tool } from "./registry.js";

export interface ValidationError {
    param: string;
    message: string;
}

export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    coerced: Record<string, unknown>;
}

const COERCIBLE_TYPES: Record<string, (v: unknown) => unknown> = {
    number: (v) => {
        if (typeof v === "number") return v;
        if (typeof v === "string") {
            const n = Number(v);
            if (!Number.isNaN(n)) return n;
        }
        return undefined;
    },
    integer: (v) => {
        if (typeof v === "number" && Number.isInteger(v)) return v;
        if (typeof v === "string") {
            const n = Number(v);
            if (!Number.isNaN(n) && Number.isInteger(n)) return n;
        }
        return undefined;
    },
    boolean: (v) => {
        if (typeof v === "boolean") return v;
        if (typeof v === "string") {
            const lower = v.toLowerCase();
            if (lower === "true" || lower === "1" || lower === "yes") return true;
            if (lower === "false" || lower === "0" || lower === "no") return false;
        }
        if (typeof v === "number") return v !== 0;
        return undefined;
    },
    string: (v) => {
        if (typeof v === "string") return v;
        if (v != null) return String(v);
        return undefined;
    },
    array: (v) => {
        if (Array.isArray(v)) return v;
        if (typeof v === "string") {
            try {
                const parsed = JSON.parse(v);
                if (Array.isArray(parsed)) return parsed;
            } catch { /* not JSON array */ }
        }
        return undefined;
    },
    object: (v) => {
        if (v != null && typeof v === "object" && !Array.isArray(v)) return v;
        if (typeof v === "string") {
            try {
                const parsed = JSON.parse(v);
                if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
            } catch { /* not JSON object */ }
        }
        return undefined;
    },
};

/**
 * Validate and coerce tool arguments against the tool's declared parameter schema.
 * Returns coerced args and any validation errors.
 */
export function validateToolArgs(
    tool: Tool,
    args: Record<string, unknown>,
): ValidationResult {
    const errors: ValidationError[] = [];
    const coerced: Record<string, unknown> = { ...args };
    const params = tool.parameters;

    // Check required params
    for (const [name, info] of Object.entries(params)) {
        if (info.required && (args[name] === undefined || args[name] === null)) {
            errors.push({ param: name, message: `required parameter "${name}" is missing` });
        }
    }

    // Coerce and type-check provided params
    for (const [name, value] of Object.entries(args)) {
        const schema = params[name];
        if (!schema) continue; // extra params are passed through

        const expectedType = schema.type?.toLowerCase() ?? "string";
        const coercer = COERCIBLE_TYPES[expectedType];

        if (coercer) {
            const coercedValue = coercer(value);
            if (coercedValue === undefined && value !== undefined) {
                errors.push({
                    param: name,
                    message: `expected type "${expectedType}" but got ${typeof value}: ${JSON.stringify(value)?.slice(0, 80)}`,
                });
            } else if (coercedValue !== undefined) {
                coerced[name] = coercedValue;
            }
        }
    }

    return { valid: errors.length === 0, errors, coerced };
}

/** Format validation errors into a single human-readable string. */
export function formatValidationErrors(errors: ValidationError[]): string {
    return errors.map((e) => `- ${e.param}: ${e.message}`).join("\n");
}
