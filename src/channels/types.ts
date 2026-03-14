/**
 * Core channel abstraction for multi-platform messaging.
 *
 * Each messaging platform (WhatsApp, Telegram, Signal, Slack, Discord, …)
 * implements the ChannelAdapter interface. The ChannelRouter dispatches
 * inbound messages to agents and routes outbound replies through the
 * originating adapter.
 */

export interface ChannelMessage {
    /** Platform identifier, e.g. "telegram", "whatsapp", "signal" */
    channelId: string;
    /** Platform-specific sender identifier */
    senderId: string;
    /** Human-readable sender name (when available) */
    senderName?: string;
    /** Group or chat identifier — combined with channelId forms the session key */
    conversationId: string;
    /** Text body of the message */
    body: string;
    /** Optional media attachments */
    media?: Array<{ url: string; mimeType: string; filename?: string }>;
    /** ID of the message being replied to (threading) */
    replyToId?: string;
    /** Platform-specific raw message object for advanced use */
    raw?: unknown;
    /** When the message was sent (epoch ms) */
    timestamp: number;
}

export interface ChannelAdapter {
    /** Unique platform identifier (e.g. "telegram") */
    readonly id: string;
    /** Human-readable name (e.g. "Telegram") */
    readonly name: string;

    /**
     * Start the adapter (connect, authenticate, begin polling/listening).
     * Called by the ChannelRouter during startAll().
     */
    start(config: Record<string, unknown>): Promise<void>;

    /** Gracefully shut down the adapter. */
    stop(): Promise<void>;

    /**
     * Callback set by the ChannelRouter when the adapter is registered.
     * The adapter calls this for every inbound message.
     */
    onMessage: (msg: ChannelMessage) => void;

    /** Send a text message (and optionally media) to a conversation. */
    send(
        conversationId: string,
        content: string,
        media?: Array<{ url: string; mimeType: string }>,
    ): Promise<void>;
}
