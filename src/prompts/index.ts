export const PROMPT_CACHE_BOUNDARY = "__CACHE_BOUNDARY__";

export interface SystemPromptParts {
    basePrompt: string;
    toolDescription?: string | null;
    lessonPreamble?: string | null;
    cacheBoundary?: string;
}

export interface PromptInjectionParts {
    memoryContent?: string | null;
    skillSummaries?: string | null;
}

export interface PromptMessage {
    role: string;
    content: string;
}

export function buildSystemPrompt({
    basePrompt,
    toolDescription = "",
    lessonPreamble = "",
    cacheBoundary = PROMPT_CACHE_BOUNDARY,
}: SystemPromptParts): string {
    return `${basePrompt}${lessonPreamble ?? ""}\n\n${toolDescription ?? ""}\n${cacheBoundary}`;
}

export function buildPromptInjection({
    memoryContent,
    skillSummaries,
}: PromptInjectionParts): string | null {
    const parts = [memoryContent, skillSummaries].filter(
        (part): part is string => typeof part === "string" && part.length > 0,
    );
    return parts.length > 0 ? parts.join("\n\n") : null;
}

export function appendPromptInjection<T extends PromptMessage>(
    messages: T[],
    injection?: string | null,
): T[] {
    if (!injection) return messages;

    const result = [...messages];
    for (let i = 0; i < result.length; i++) {
        const message = result[i]!;
        if (message.role === "system") {
            result[i] = {
                ...message,
                content: `${message.content}\n\n${injection}`,
            };
            return result;
        }
    }

    return messages;
}
