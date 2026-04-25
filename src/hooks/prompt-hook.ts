/**
 * PromptHook — LLM-evaluated guardrail.
 *
 * A `PromptHook` is configured in code or in `settings.json` like this::
 *
 *   new PromptHook({
 *     prompt: "Block tool calls that write files outside the project root.",
 *     model: "claude-haiku-4-5",
 *   });
 *
 * When the runtime evaluates the hook, it sends a small JSON-shaped prompt to
 * the configured cheap model and parses a verdict:
 *
 *   {"ok": true | false, "reason": "..."}
 *
 * If `ok=false`, the hooked action is blocked with the model's stated reason
 * fed back into the agent's transcript. This lets users write natural-language
 * guardrails without writing code.
 *
 * Mirrors `clawagents_py/src/clawagents/hooks/prompt_hook.py`.
 */

import type { LLMProvider, LLMMessage } from "../providers/llm.js";

export interface PromptHookVerdict {
    ok: boolean;
    reason: string | null;
    rawResponse: string | null;
}

export interface PromptHookOptions {
    prompt: string;
    model?: string | null;
    /** Max ms to wait for a verdict before failing open. Default 8000. */
    timeoutMs?: number;
}

/** Stub interface that just exposes the bits of LLMProvider PromptHook needs. */
type LLMResolver = (model: string | null | undefined) => LLMProvider | Promise<LLMProvider>;

const VERDICT_SYSTEM =
    "You are a strict JSON-output evaluator. Read a rule and an event " +
    "payload, decide whether to allow or block, and reply with a single " +
    'JSON object: {"ok": true|false, "reason": "..."}. Never include ' +
    "any other text, code fences, or commentary.";

const JSON_OBJ_RE = /\{[\s\S]*\}/;

export class PromptHook {
    readonly prompt: string;
    readonly model: string | null;
    readonly timeoutMs: number;

    constructor(opts: PromptHookOptions) {
        if (!opts.prompt || !opts.prompt.trim()) {
            throw new Error("PromptHook.prompt must be non-empty");
        }
        this.prompt = opts.prompt;
        this.model = opts.model ?? null;
        this.timeoutMs = opts.timeoutMs ?? 8000;
    }

    /**
     * Evaluate the hook against `payload` and return a verdict.
     *
     * Always returns a verdict — never throws. On any error it logs and
     * FAILS OPEN.
     */
    async evaluate(
        payload: Record<string, unknown>,
        opts: { llmResolver?: LLMResolver } = {},
    ): Promise<PromptHookVerdict> {
        let llm: LLMProvider;
        try {
            llm = await this.resolveLlm(opts.llmResolver);
        } catch (e) {
            return {
                ok: true,
                reason: `failed-open (no model): ${(e as Error)?.message ?? String(e)}`,
                rawResponse: null,
            };
        }

        const fullPrompt = this.renderPrompt(payload);
        const messages: LLMMessage[] = [
            { role: "system", content: VERDICT_SYSTEM },
            { role: "user", content: fullPrompt },
        ];

        let response;
        try {
            response = await this.withTimeout(
                llm.chat(messages),
                this.timeoutMs,
            );
        } catch (e) {
            const err = e as Error;
            const isTimeout = err && err.message === "__prompt_hook_timeout";
            return {
                ok: true,
                reason: isTimeout
                    ? "failed-open (timeout)"
                    : `failed-open (error): ${err?.message ?? String(err)}`,
                rawResponse: null,
            };
        }

        return parseVerdict(response.content ?? "");
    }

    private async resolveLlm(resolver?: LLMResolver): Promise<LLMProvider> {
        if (resolver) {
            const r = resolver(this.model);
            return r instanceof Promise ? await r : r;
        }
        // Best-effort: use the existing provider-resolution path.
        const { resolveModel } = await import("../providers/llm.js") as {
            resolveModel?: (
                model: string,
                streaming: boolean,
                apiKey: string | undefined,
                contextWindow: number | undefined,
            ) => Promise<LLMProvider>;
        };
        if (typeof resolveModel === "function") {
            return resolveModel(this.model ?? "", false, undefined, undefined);
        }
        throw new Error(
            "PromptHook: no llmResolver provided and resolveModel() is not exported. " +
            "Pass an explicit `llmResolver` for now.",
        );
    }

    private renderPrompt(payload: Record<string, unknown>): string {
        let payloadJson: string;
        try {
            payloadJson = JSON.stringify(payload, null, 2).slice(0, 6000);
        } catch {
            payloadJson = String(payload).slice(0, 6000);
        }
        return (
            `Rule:\n${this.prompt.trim()}\n\n` +
            `Event payload (JSON):\n\`\`\`json\n${payloadJson}\n\`\`\`\n\n` +
            'Reply with ONLY a single JSON object: {"ok": true|false, "reason": "..."}.\n' +
            "  - ok=true means ALLOW the action.\n" +
            "  - ok=false means BLOCK; reason will be shown to the agent."
        );
    }

    private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("__prompt_hook_timeout")), ms);
            promise.then(
                (v) => { clearTimeout(timer); resolve(v); },
                (e) => { clearTimeout(timer); reject(e); },
            );
        });
    }
}

/**
 * Parse the model's text into a verdict. Tolerates code fences, leading/trailing
 * prose, and missing fields. If we can't extract a clear verdict, FAIL OPEN
 * (ok=true) with the raw response in the reason for debugging.
 */
export function parseVerdict(text: string): PromptHookVerdict {
    if (!text) {
        return { ok: true, reason: "failed-open (empty response)", rawResponse: text };
    }

    let candidate = text.trim();
    if (candidate.startsWith("```")) {
        candidate = candidate.replace(/^```(?:json)?\s*/, "");
        candidate = candidate.replace(/```\s*$/, "").trim();
    }

    const match = JSON_OBJ_RE.exec(candidate);
    if (!match) {
        return { ok: true, reason: "failed-open (no JSON found)", rawResponse: text };
    }
    let obj: Record<string, unknown>;
    try {
        obj = JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
        return { ok: true, reason: "failed-open (bad JSON)", rawResponse: text };
    }

    const ok = obj.ok !== false; // any truthy or missing → true
    const reasonRaw = obj.reason;
    return {
        ok: Boolean(ok),
        reason: reasonRaw == null ? null : String(reasonRaw),
        rawResponse: text,
    };
}
