/**
 * Core channel abstraction for multi-platform messaging.
 *
 * Each messaging platform (WhatsApp, Telegram, Signal, Slack, Discord, …)
 * implements the ChannelAdapter interface. The ChannelRouter dispatches
 * inbound messages to agents and routes outbound replies through the
 * originating adapter.
 */

export interface ChannelAttachment {
    url: string;
    mimeType: string;
    filename?: string;
    kind?: string;
    altText?: string;
    metadata?: Record<string, unknown>;
}

export interface ChannelCommand {
    name: string;
    args: string;
    argv: string[];
    raw: string;
}

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
    media?: ChannelAttachment[];
    /** Parsed slash command when the body starts with a command prefix */
    command?: ChannelCommand;
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

export function parseChannelCommand(body: string, prefix = "/"): ChannelCommand | undefined {
    const stripped = body.trim();
    if (!stripped.startsWith(prefix) || stripped.startsWith(prefix + prefix)) return undefined;
    const bodyWithoutPrefix = stripped.slice(prefix.length);
    const firstSpace = bodyWithoutPrefix.search(/\s/);
    const name = (firstSpace === -1 ? bodyWithoutPrefix : bodyWithoutPrefix.slice(0, firstSpace)).trim().toLowerCase();
    if (!name || /\s/.test(name)) return undefined;
    const args = firstSpace === -1 ? "" : bodyWithoutPrefix.slice(firstSpace).trim();
    return { name, args, argv: args ? args.split(/\s+/) : [], raw: stripped };
}

export function normalizeChannelAttachments(media?: Array<Partial<ChannelAttachment> & { mime_type?: string }>): ChannelAttachment[] {
    const out: ChannelAttachment[] = [];
    for (const item of media ?? []) {
        const url = typeof item.url === "string" ? item.url : "";
        const mimeType = typeof item.mimeType === "string"
            ? item.mimeType
            : typeof item.mime_type === "string"
                ? item.mime_type
                : "";
        if (!url || !mimeType) continue;
        out.push({
            url,
            mimeType,
            filename: item.filename,
            kind: item.kind ?? "file",
            altText: item.altText,
            metadata: item.metadata ? { ...item.metadata } : {},
        });
    }
    return out;
}

export function normalizeChannelMessage(msg: ChannelMessage): ChannelMessage {
    return {
        ...msg,
        media: normalizeChannelAttachments(msg.media as Array<Partial<ChannelAttachment> & { mime_type?: string }> | undefined),
        command: msg.command ?? parseChannelCommand(msg.body),
    };
}

export function channelMessageToAgentInput(msg: ChannelMessage): string {
    const normalized = normalizeChannelMessage(msg);
    const parts: string[] = [];
    if (normalized.command) {
        parts.push(`[Channel Command: ${normalized.command.name}]`);
        if (normalized.command.args) parts.push(`Args: ${normalized.command.args}`);
        parts.push("");
    }
    parts.push(normalized.body);
    if (normalized.media?.length) {
        parts.push("\n[Attachments]");
        for (const attachment of normalized.media) {
            const name = attachment.filename ?? attachment.url;
            parts.push(`- ${name} (${attachment.mimeType}): ${attachment.url}`);
        }
    }
    return parts.join("\n").trim();
}
