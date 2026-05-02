/**
 * Multi-channel router that dispatches inbound messages to agents
 * and routes outbound replies through the originating adapter.
 *
 * Features:
 *   - Per-session serialization via KeyedAsyncQueue (prevents race conditions)
 *   - Configurable agent factory (fresh agent per message, or shared)
 *   - Optional inbound debouncer (batches rapid messages)
 *   - Hooks: onInbound, onOutbound, onError for observability
 */

import {
    channelMessageToAgentInput,
    normalizeChannelMessage,
    type ChannelAdapter,
    type ChannelMessage,
} from "./types.js";
import { KeyedAsyncQueue } from "./keyed-queue.js";
import type { ClawAgent } from "../agent.js";

export type AgentFactory = () => Promise<ClawAgent>;

export interface ChannelRouterOptions {
    /** Called before dispatching to the agent. Return false to drop the message. */
    onInbound?: (msg: ChannelMessage) => boolean | Promise<boolean>;
    /** Called after the agent produces a reply, before sending. */
    onOutbound?: (msg: ChannelMessage, reply: string) => string | Promise<string>;
    /** Called when an error occurs during processing. */
    onError?: (msg: ChannelMessage, error: unknown) => void;
    /** Debounce window in ms — batches rapid messages from the same session. 0 = disabled. */
    debounceMs?: number;
}

export class ChannelRouter {
    private adapters = new Map<string, ChannelAdapter>();
    private sessionQueue = new KeyedAsyncQueue();
    private agentFactory: AgentFactory;
    private opts: ChannelRouterOptions;

    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private debounceBatches = new Map<string, ChannelMessage[]>();

    constructor(agentFactory: AgentFactory, opts: ChannelRouterOptions = {}) {
        this.agentFactory = agentFactory;
        this.opts = opts;
    }

    /** Register a channel adapter. Sets the onMessage callback automatically. */
    register(adapter: ChannelAdapter): this {
        adapter.onMessage = (msg) => this.handleInbound(msg);
        this.adapters.set(adapter.id, adapter);
        return this;
    }

    /** Start all registered adapters with their respective configs. */
    async startAll(configs: Record<string, Record<string, unknown>>): Promise<void> {
        const startPromises: Promise<void>[] = [];
        for (const [id, config] of Object.entries(configs)) {
            const adapter = this.adapters.get(id);
            if (adapter) {
                startPromises.push(adapter.start(config));
            } else {
                console.warn(`[Router] No adapter registered for channel "${id}"`);
            }
        }
        await Promise.all(startPromises);
        console.log(`[Router] ${this.adapters.size} channel(s) started`);
    }

    /** Stop all adapters gracefully. */
    async stopAll(): Promise<void> {
        for (const timer of this.debounceTimers.values()) clearTimeout(timer);
        this.debounceTimers.clear();
        this.debounceBatches.clear();
        await Promise.all([...this.adapters.values()].map((a) => a.stop()));
        console.log("[Router] All channels stopped");
    }

    get registeredChannels(): string[] {
        return [...this.adapters.keys()];
    }

    get activeSessions(): number {
        return this.sessionQueue.activeKeys;
    }

    private handleInbound(msg: ChannelMessage) {
        const debounceMs = this.opts.debounceMs ?? 0;
        if (debounceMs <= 0) {
            this.dispatch(msg);
            return;
        }

        const key = `${msg.channelId}:${msg.conversationId}`;
        let batch = this.debounceBatches.get(key);
        if (!batch) {
            batch = [];
            this.debounceBatches.set(key, batch);
        }
        batch.push(msg);

        const existing = this.debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
            key,
            setTimeout(() => {
                this.debounceTimers.delete(key);
                const messages = this.debounceBatches.get(key) ?? [];
                this.debounceBatches.delete(key);
                if (messages.length === 0) return;

                const combined: ChannelMessage = {
                    ...messages[messages.length - 1]!,
                    body: messages.map((m) => m.body).join("\n"),
                    media: messages.flatMap((m) => m.media ?? []),
                };
                this.dispatch(combined);
            }, debounceMs),
        );
    }

    private dispatch(msg: ChannelMessage) {
        const sessionKey = `${msg.channelId}:${msg.conversationId}`;

        this.sessionQueue
            .enqueue(sessionKey, async () => {
                if (this.opts.onInbound) {
                    const allow = await this.opts.onInbound(msg);
                    if (!allow) return;
                }

                const agent = await this.agentFactory();
                const normalized = normalizeChannelMessage(msg);
                const result = await agent.invoke(channelMessageToAgentInput(normalized));
                let reply = result.result ?? "";

                if (this.opts.onOutbound) {
                    reply = await this.opts.onOutbound(msg, reply);
                }

                if (!reply) return;

                const adapter = this.adapters.get(msg.channelId);
                if (adapter) {
                    await adapter.send(msg.conversationId, reply);
                }
            })
            .catch((err) => {
                if (this.opts.onError) {
                    this.opts.onError(msg, err);
                } else {
                    console.error(`[Router] Error processing ${msg.channelId}:${msg.conversationId}:`, err);
                }
            });
    }
}
