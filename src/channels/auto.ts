/**
 * Auto-detect messaging channels from environment variables.
 *
 * When the gateway starts, this module checks for channel env vars
 * and automatically configures + starts the ChannelRouter.
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN     → starts Telegram adapter
 *   WHATSAPP_AUTH_DIR      → starts WhatsApp adapter (Baileys)
 *   SIGNAL_ACCOUNT         → starts Signal adapter
 *   CHANNEL_DEBOUNCE_MS    → debounce window (default: 500)
 */

import { ChannelRouter } from "./router.js";
import type { LLMProvider } from "../providers/llm.js";
import { createClawAgent } from "../agent.js";

export interface DetectedChannel {
    id: string;
    config: Record<string, unknown>;
    description: string;
}

export function detectChannels(): DetectedChannel[] {
    const channels: DetectedChannel[] = [];

    const telegramToken = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
    if (telegramToken) {
        channels.push({
            id: "telegram",
            config: { botToken: telegramToken },
            description: `telegram (${telegramToken.slice(0, 6)}...)`,
        });
    }

    const waAuthDir = process.env["WHATSAPP_AUTH_DIR"] ?? "";
    if (waAuthDir) {
        channels.push({
            id: "whatsapp",
            config: { authDir: waAuthDir },
            description: `whatsapp (baileys)`,
        });
    }

    const signalAccount = process.env["SIGNAL_ACCOUNT"] ?? "";
    if (signalAccount) {
        channels.push({
            id: "signal",
            config: {
                account: signalAccount,
                signalCliBin: process.env["SIGNAL_CLI_BIN"] ?? "signal-cli",
            },
            description: `signal (${signalAccount})`,
        });
    }

    return channels;
}

export async function startChannelRouter(llm: LLMProvider): Promise<ChannelRouter | undefined> {
    const channels = detectChannels();
    if (channels.length === 0) return undefined;

    const debounceMs = parseInt(process.env["CHANNEL_DEBOUNCE_MS"] ?? "500", 10) || 500;

    const router = new ChannelRouter(
        () => createClawAgent({ model: llm }),
        { debounceMs },
    );

    const configs: Record<string, Record<string, unknown>> = {};

    for (const ch of channels) {
        if (ch.id === "telegram") {
            const { TelegramAdapter } = await import("./telegram.js");
            router.register(new TelegramAdapter());
        } else if (ch.id === "whatsapp") {
            const { WhatsAppAdapter } = await import("./whatsapp.js");
            router.register(new WhatsAppAdapter());
        } else if (ch.id === "signal") {
            const { SignalAdapter } = await import("./signal.js");
            router.register(new SignalAdapter());
        }
        configs[ch.id] = ch.config;
    }

    await router.startAll(configs);
    return router;
}
