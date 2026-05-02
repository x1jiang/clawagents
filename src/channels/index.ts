export type { ChannelMessage, ChannelAdapter, ChannelAttachment, ChannelCommand } from "./types.js";
export {
    channelMessageToAgentInput,
    normalizeChannelAttachments,
    normalizeChannelMessage,
    parseChannelCommand,
} from "./types.js";
export { KeyedAsyncQueue } from "./keyed-queue.js";
export { ChannelRouter } from "./router.js";
export type { AgentFactory, ChannelRouterOptions } from "./router.js";
export { TelegramAdapter } from "./telegram.js";
export { WhatsAppAdapter } from "./whatsapp.js";
export { SignalAdapter } from "./signal.js";
export { detectChannels, startChannelRouter } from "./auto.js";
export type { DetectedChannel } from "./auto.js";
