/**
 * Telegram channel adapter using the grammY framework.
 *
 * Requires: npm install grammy
 * Config: { botToken: string }
 */

import type { ChannelAdapter, ChannelMessage } from "./types.js";

export class TelegramAdapter implements ChannelAdapter {
    readonly id = "telegram";
    readonly name = "Telegram";
    onMessage: (msg: ChannelMessage) => void = () => {};

    private bot: any;

    async start(config: Record<string, unknown>): Promise<void> {
        const token = String(config.botToken ?? "");
        if (!token) throw new Error("TelegramAdapter: missing botToken in config");

        let Bot: any;
        try {
            const grammy = await import("grammy");
            Bot = grammy.Bot;
        } catch {
            throw new Error(
                "TelegramAdapter: 'grammy' package not installed. Run: npm install grammy",
            );
        }

        this.bot = new Bot(token);

        this.bot.on("message:text", (ctx: any) => {
            const msg = ctx.message;
            const chatId = String(msg.chat.id);
            const senderId = String(msg.from?.id ?? chatId);
            const senderName =
                [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || undefined;

            this.onMessage({
                channelId: "telegram",
                senderId,
                senderName,
                conversationId: chatId,
                body: msg.text ?? "",
                timestamp: msg.date * 1000,
                raw: msg,
            });
        });

        this.bot.start();
        console.log(`[Telegram] Bot started (${token.slice(0, 6)}...)`);
    }

    async send(conversationId: string, content: string): Promise<void> {
        if (!this.bot) throw new Error("TelegramAdapter: bot not started");
        await this.bot.api.sendMessage(Number(conversationId), content, { parse_mode: "Markdown" });
    }

    async stop(): Promise<void> {
        this.bot?.stop();
        this.bot = undefined;
    }
}
