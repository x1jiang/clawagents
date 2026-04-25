/**
 * Built-in {@link InputFilter} helpers for handoffs.
 *
 * Mirrors `openai-agents-python/src/agents/extensions/handoff_filters.py`
 * but operates on `LLMMessage` lists, the shape clawagents uses
 * internally.
 */

import type { HandoffInputData } from "./handoffs.js";
import type { LLMMessage } from "./providers/llm.js";

function isToolRelated(msg: LLMMessage): boolean {
    if (msg.role === "tool") return true;
    if (msg.role === "assistant") {
        const meta = (msg as { toolCallsMeta?: unknown[] }).toolCallsMeta;
        if (meta && Array.isArray(meta) && meta.length > 0) return true;
        const content = typeof msg.content === "string" ? msg.content : "";
        const stripped = content.trim();
        if (stripped.startsWith('{"tool":') || stripped.startsWith("[{")) return true;
    }
    return false;
}

function isToolResultUser(msg: LLMMessage): boolean {
    if (msg.role !== "user") return false;
    const content = typeof msg.content === "string" ? msg.content : "";
    return content.startsWith("[Tool Result]") || content.startsWith("[Tool Results]");
}

function filterMessages(messages: Iterable<LLMMessage>): LLMMessage[] {
    const out: LLMMessage[] = [];
    for (const m of messages) {
        if (isToolRelated(m) || isToolResultUser(m)) continue;
        out.push(m);
    }
    return out;
}

/** Strip every tool-call / tool-result exchange from the conversation. */
export function removeAllTools<TContext = unknown>(
    data: HandoffInputData<TContext>,
): HandoffInputData<TContext> {
    return {
        inputHistory: filterMessages(data.inputHistory),
        preHandoffItems: data.preHandoffItems ? [...data.preHandoffItems] : undefined,
        newItems: data.newItems ? [...data.newItems] : undefined,
        runContext: data.runContext,
    };
}

/**
 * Replace prior history with a single nested summary user message.
 *
 * The previous transcript is collapsed to a marker so the new agent
 * starts on a fresh context window but still knows a handoff happened.
 * The first system message (if any) and the most recent user message
 * are preserved verbatim.
 */
export function nestHandoffHistory<TContext = unknown>(
    data: HandoffInputData<TContext>,
): HandoffInputData<TContext> {
    const history = data.inputHistory;
    if (history.length === 0) return data;

    const systemMsg = history.find((m) => m.role === "system");
    let lastUser: LLMMessage | undefined;
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]!.role === "user") {
            lastUser = history[i];
            break;
        }
    }

    const nested: LLMMessage[] = [];
    if (systemMsg) nested.push(systemMsg);
    nested.push({
        role: "user",
        content: (
            "[Handoff] The previous agent transferred this conversation. " +
            "The full prior transcript has been summarised away. Continue " +
            "from the most recent user request below."
        ),
    });
    if (lastUser && lastUser !== systemMsg) nested.push(lastUser);

    return {
        inputHistory: nested,
        preHandoffItems: data.preHandoffItems ? [...data.preHandoffItems] : undefined,
        newItems: data.newItems ? [...data.newItems] : undefined,
        runContext: data.runContext,
    };
}
