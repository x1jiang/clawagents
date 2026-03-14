/**
 * WhatsApp channel adapter using Baileys (multi-device).
 *
 * Requires: npm install baileys
 * Config: { authDir: string }
 *
 * On first run, a QR code is printed to the terminal for phone pairing.
 * Subsequent runs use cached credentials from authDir.
 */

import type { ChannelAdapter, ChannelMessage } from "./types.js";

export class WhatsAppAdapter implements ChannelAdapter {
    readonly id = "whatsapp";
    readonly name = "WhatsApp";
    onMessage: (msg: ChannelMessage) => void = () => {};

    private sock: any;
    private saveCreds: (() => Promise<void>) | undefined;

    async start(config: Record<string, unknown>): Promise<void> {
        const authDir = String(config.authDir ?? ".whatsapp-auth");

        let makeWASocket: any;
        let useMultiFileAuthState: any;
        let DisconnectReason: any;

        try {
            const baileys = await import("baileys");
            makeWASocket = baileys.default ?? baileys.makeWASocket ?? (baileys as any).default;
            useMultiFileAuthState = baileys.useMultiFileAuthState;
            DisconnectReason = baileys.DisconnectReason;
        } catch {
            throw new Error(
                "WhatsAppAdapter: 'baileys' package not installed. Run: npm install baileys",
            );
        }

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        this.saveCreds = saveCreds;

        this.sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
        });

        this.sock.ev.on("creds.update", saveCreds);

        this.sock.ev.on("connection.update", (update: any) => {
            const { connection, lastDisconnect } = update;
            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason?.loggedOut;
                if (shouldReconnect) {
                    console.log("[WhatsApp] Reconnecting...");
                    this.start(config).catch(console.error);
                } else {
                    console.log("[WhatsApp] Logged out. Delete auth dir and restart to re-pair.");
                }
            } else if (connection === "open") {
                console.log("[WhatsApp] Connected");
            }
        });

        this.sock.ev.on("messages.upsert", ({ messages, type }: any) => {
            for (const m of messages) {
                if (m.key.fromMe) continue;
                const text =
                    m.message?.conversation ??
                    m.message?.extendedTextMessage?.text ??
                    "";
                if (!text) continue;

                const jid = m.key.remoteJid ?? "";
                const participant = m.key.participant ?? jid;

                this.onMessage({
                    channelId: "whatsapp",
                    senderId: participant,
                    senderName: m.pushName ?? undefined,
                    conversationId: jid,
                    body: text,
                    timestamp: (m.messageTimestamp as number) * 1000,
                    raw: m,
                });
            }
        });
    }

    async send(conversationId: string, content: string): Promise<void> {
        if (!this.sock) throw new Error("WhatsAppAdapter: not connected");
        await this.sock.sendMessage(conversationId, { text: content });
    }

    async stop(): Promise<void> {
        this.sock?.end(undefined);
        this.sock = undefined;
    }
}
