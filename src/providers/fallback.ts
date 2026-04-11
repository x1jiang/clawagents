/**
 * Three-tier provider fallback with quarantine.
 *
 * Chain: primary → named fallback → global fallback list.
 * Providers that fail consecutively get quarantined.
 */

import type { LLMProvider, LLMMessage, LLMResponse, StreamOptions } from "./llm.js";

const HEALTH_CHECK_MESSAGE: LLMMessage = { role: "user", content: "ping" };

class ProviderState {
    consecutiveFailures = 0;
    quarantined = false;
    quarantineStart = 0;

    recordFailure(): void {
        this.consecutiveFailures++;
    }

    recordSuccess(): void {
        this.consecutiveFailures = 0;
        this.quarantined = false;
    }

    quarantine(): void {
        this.quarantined = true;
        this.quarantineStart = Date.now();
    }

    healthCheckDue(intervalMs: number): boolean {
        return this.quarantined && (Date.now() - this.quarantineStart) >= intervalMs;
    }
}

export type FallbackEventCallback = (level: "warn" | "info", data: { message: string }) => void;

/**
 * Wraps an LLMProvider with a three-tier fallback chain and quarantine logic.
 *
 * Chain: primary → named fallbacks (in order) → skip quarantined providers.
 * A provider that fails `quarantineThreshold` consecutive times is quarantined
 * and excluded from the active pool until it passes a lightweight health check
 * run every `healthCheckIntervalMs` milliseconds.
 */
export class FallbackProvider implements LLMProvider {
    readonly name = "fallback";

    private states = new Map<LLMProvider, ProviderState>();

    constructor(
        private primary: LLMProvider,
        private fallbacks: LLMProvider[],
        private quarantineThreshold = 3,
        private healthCheckIntervalMs = 60_000,
        private onEvent?: FallbackEventCallback,
    ) {
        for (const p of [primary, ...fallbacks]) {
            this.states.set(p, new ProviderState());
        }
    }

    // ── Internal helpers ───────────────────────────────────────────────────

    private state(provider: LLMProvider): ProviderState {
        return this.states.get(provider)!;
    }

    private emit(level: "warn" | "info", message: string): void {
        if (level === "warn") {
            process.stderr.write(`[fallback] ${message}\n`);
        }
        if (this.onEvent) {
            try { this.onEvent(level, { message }); } catch { /* ignore */ }
        }
    }

    private isActive(provider: LLMProvider): boolean {
        return !this.state(provider).quarantined;
    }

    private maybeQuarantine(provider: LLMProvider): void {
        const s = this.state(provider);
        if (s.consecutiveFailures >= this.quarantineThreshold && !s.quarantined) {
            s.quarantine();
            this.emit(
                "warn",
                `Provider '${provider.name}' quarantined after ${s.consecutiveFailures} consecutive failures.`,
            );
        }
    }

    private async tryHealthCheck(provider: LLMProvider): Promise<boolean> {
        try {
            await provider.chat([HEALTH_CHECK_MESSAGE]);
            this.state(provider).recordSuccess();
            this.emit("warn", `Provider '${provider.name}' passed health check — restored to active pool.`);
            return true;
        } catch {
            this.state(provider).quarantineStart = Date.now();
            return false;
        }
    }

    private async healthCheckQuarantined(): Promise<void> {
        for (const p of [this.primary, ...this.fallbacks]) {
            const s = this.state(p);
            if (s.healthCheckDue(this.healthCheckIntervalMs)) {
                await this.tryHealthCheck(p);
            }
        }
    }

    // ── LLMProvider interface ──────────────────────────────────────────────

    async chat(messages: LLMMessage[], options?: StreamOptions): Promise<LLMResponse> {
        await this.healthCheckQuarantined();

        const allProviders = [this.primary, ...this.fallbacks];
        let lastErr: unknown;

        for (let i = 0; i < allProviders.length; i++) {
            const provider = allProviders[i]!;
            const s = this.state(provider);

            if (s.quarantined) {
                this.emit("warn", `Skipping quarantined provider '${provider.name}'.`);
                continue;
            }

            try {
                const response = await provider.chat(messages, options);
                s.recordSuccess();
                return response;
            } catch (exc) {
                lastErr = exc;
                s.recordFailure();
                this.maybeQuarantine(provider);

                const remaining = allProviders.slice(i + 1).filter((p) => !this.state(p).quarantined);
                if (remaining.length > 0) {
                    this.emit(
                        "warn",
                        `Provider '${provider.name}' failed (${exc}), falling back to '${remaining[0]!.name}'.`,
                    );
                } else {
                    this.emit(
                        "warn",
                        `Provider '${provider.name}' failed (${exc}). No active fallback providers remaining.`,
                    );
                }
            }
        }

        throw new Error(`All providers failed. Last error: ${lastErr}`);
    }
}
