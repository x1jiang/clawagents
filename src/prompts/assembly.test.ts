import test from "node:test";
import assert from "node:assert/strict";
import {
    PROMPT_CACHE_BOUNDARY,
    appendPromptInjection,
    buildPromptInjection,
    buildSystemPrompt,
} from "./index.js";

test("buildSystemPrompt places tools before the cache boundary", () => {
    const system = buildSystemPrompt({
        basePrompt: "base instructions",
        toolDescription: "tool schemas",
        lessonPreamble: "\nlessons",
    });

    assert.equal(system, `base instructions\nlessons\n\ntool schemas\n${PROMPT_CACHE_BOUNDARY}`);
});

test("appendPromptInjection updates the system message without mutating the original", () => {
    const messages = [
        { role: "system" as const, content: "base" },
        { role: "user" as const, content: "task" },
    ];
    const injection = buildPromptInjection({
        memoryContent: "## Agent Memory\nremember this",
        skillSummaries: "## Available Skills\n- **review**: Review code",
    });

    const updated = appendPromptInjection(messages, injection);

    assert.equal(messages[0].content, "base");
    assert.equal(
        updated[0]?.content,
        "base\n\n## Agent Memory\nremember this\n\n## Available Skills\n- **review**: Review code",
    );
    assert.equal(updated[1], messages[1]);
});

test("appendPromptInjection returns the original messages when there is no injection", () => {
    const messages = [{ role: "system" as const, content: "base" }];

    assert.equal(appendPromptInjection(messages, null), messages);
});
