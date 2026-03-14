/**
 * Signal channel adapter using signal-cli (subprocess).
 *
 * Requires: signal-cli installed and registered
 *   - Install: https://github.com/AsamK/signal-cli
 *   - Register: signal-cli -a +1234567890 register
 *   - Verify:   signal-cli -a +1234567890 verify CODE
 *
 * Config: { account: "+1234567890", signalCliBin?: string }
 *
 * The adapter runs `signal-cli -a <account> daemon --json` as a subprocess,
 * reading JSON lines from stdout (same pattern OpenClaw uses).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ChannelAdapter, ChannelMessage } from "./types.js";

export class SignalAdapter implements ChannelAdapter {
    readonly id = "signal";
    readonly name = "Signal";
    onMessage: (msg: ChannelMessage) => void = () => {};

    private proc: ChildProcess | undefined;
    private account = "";

    async start(config: Record<string, unknown>): Promise<void> {
        this.account = String(config.account ?? "");
        if (!this.account) throw new Error("SignalAdapter: missing 'account' (phone number)");

        const bin = String(config.signalCliBin ?? "signal-cli");

        this.proc = spawn(bin, ["-a", this.account, "daemon", "--json"], {
            stdio: ["pipe", "pipe", "inherit"],
        });

        const rl = createInterface({ input: this.proc.stdout! });
        rl.on("line", (line) => {
            try {
                const envelope = JSON.parse(line);
                this.handleEnvelope(envelope);
            } catch { /* ignore non-JSON lines */ }
        });

        this.proc.on("exit", (code) => {
            console.log(`[Signal] signal-cli exited with code ${code}`);
        });

        console.log(`[Signal] Daemon started for ${this.account}`);
    }

    private handleEnvelope(envelope: any) {
        const data = envelope?.envelope;
        if (!data) return;

        const dataMessage = data.dataMessage;
        if (!dataMessage?.message) return;

        const sender = data.source ?? "";
        const senderName = data.sourceName ?? undefined;
        const groupId = dataMessage.groupInfo?.groupId ?? "";
        const conversationId = groupId || sender;

        this.onMessage({
            channelId: "signal",
            senderId: sender,
            senderName,
            conversationId,
            body: dataMessage.message,
            timestamp: data.timestamp ?? Date.now(),
            raw: envelope,
        });
    }

    async send(conversationId: string, content: string): Promise<void> {
        if (!this.proc || !this.proc.stdin) {
            throw new Error("SignalAdapter: daemon not running");
        }
        const isGroup = !conversationId.startsWith("+");
        const cmd = JSON.stringify({
            jsonrpc: "2.0",
            method: "send",
            id: Date.now().toString(),
            params: isGroup
                ? { groupId: conversationId, message: content }
                : { recipient: [conversationId], message: content },
        });
        this.proc.stdin.write(cmd + "\n");
    }

    async stop(): Promise<void> {
        this.proc?.kill("SIGTERM");
        this.proc = undefined;
    }
}
