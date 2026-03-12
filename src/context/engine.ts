/**
 * Pluggable Context Engine — allows alternative context management strategies.
 *
 * The default engine uses the built-in compaction + soft-trim behavior.
 * Plugins can provide custom engines (e.g., lossless context, RAG-based, etc.)
 */

import type { LLMMessage } from "../providers/llm.js";
import type { LLMProvider } from "../providers/llm.js";

export interface ContextEngineConfig {
    contextWindow: number;
    modelName?: string;
    budgetRatio?: number;
    softTrimRatio?: number;
}

export interface ContextEngine {
    readonly name: string;

    /** Called once when the agent starts a run. */
    bootstrap?(config: ContextEngineConfig): Promise<void>;

    /**
     * Called after each turn to manage context.
     * Should handle soft-trimming, compaction, or any other context management.
     * Returns the (possibly modified) message list.
     */
    afterTurn(
        messages: LLMMessage[],
        llm: LLMProvider,
        config: ContextEngineConfig,
    ): Promise<LLMMessage[]>;

    /**
     * Called when context needs compaction (over budget).
     * Returns compacted messages or null to fall back to default behavior.
     */
    compact?(
        messages: LLMMessage[],
        llm: LLMProvider,
        config: ContextEngineConfig,
    ): Promise<LLMMessage[] | null>;

    /** Called when the agent run ends. */
    cleanup?(): Promise<void>;
}

/**
 * Default context engine — wraps the existing soft-trim + compaction behavior.
 * Used when no custom engine is configured.
 */
export class DefaultContextEngine implements ContextEngine {
    readonly name = "default";

    async afterTurn(
        messages: LLMMessage[],
        _llm: LLMProvider,
        _config: ContextEngineConfig,
    ): Promise<LLMMessage[]> {
        return messages;
    }
}

/** Registry for context engine plugins. */
let _registeredEngines = new Map<string, () => ContextEngine>();

export function registerContextEngine(name: string, factory: () => ContextEngine): void {
    _registeredEngines.set(name, factory);
}

export function resolveContextEngine(name?: string): ContextEngine {
    if (!name || name === "default") return new DefaultContextEngine();
    const factory = _registeredEngines.get(name);
    if (!factory) {
        throw new Error(`Unknown context engine: "${name}". Available: ${Array.from(_registeredEngines.keys()).join(", ") || "default"}`);
    }
    return factory();
}

export function listContextEngines(): string[] {
    return ["default", ...Array.from(_registeredEngines.keys())];
}
