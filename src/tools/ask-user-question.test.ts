/**
 * Unit tests for AskUserQuestion structured HITL tool.
 * Run with: npx tsx --test src/tools/ask-user-question.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { askUserQuestionTool, OTHER_OPTION } from "./ask-user-question.js";

function goodQuestion(overrides: Record<string, unknown> = {}) {
    return {
        question: "Which framework?",
        header: "Framework",
        options: ["FastAPI", "Flask"],
        ...overrides,
    };
}

// ─── Validation paths ──────────────────────────────────────────────────────

describe("askUserQuestionTool — validation", () => {
    it("rejects zero questions", async () => {
        const tool = askUserQuestionTool();
        const res = await tool.execute({ questions: [] });
        assert.equal(res.success, false);
        assert.match(res.error ?? "", /1-3 questions/);
    });

    it("rejects four questions", async () => {
        const tool = askUserQuestionTool();
        const questions = [0, 1, 2, 3].map((i) => goodQuestion({ header: `H${i}` }));
        const res = await tool.execute({ questions });
        assert.equal(res.success, false);
        assert.match(res.error ?? "", /1-3 questions/);
    });

    it("rejects single-option list", async () => {
        const tool = askUserQuestionTool();
        const res = await tool.execute({
            questions: [goodQuestion({ options: ["only"] })],
        });
        assert.equal(res.success, false);
        assert.match(res.error ?? "", /2-4/);
    });

    it("rejects five-option list", async () => {
        const tool = askUserQuestionTool();
        const res = await tool.execute({
            questions: [goodQuestion({ options: ["a", "b", "c", "d", "e"] })],
        });
        assert.equal(res.success, false);
        assert.match(res.error ?? "", /2-4/);
    });

    it("rejects duplicate headers across questions", async () => {
        const tool = askUserQuestionTool();
        const res = await tool.execute({
            questions: [
                goodQuestion({ header: "Same" }),
                goodQuestion({ header: "Same", question: "Different question?" }),
            ],
        });
        assert.equal(res.success, false);
        assert.match(res.error ?? "", /duplicate header/i);
    });

    it("rejects duplicate options within a question", async () => {
        const tool = askUserQuestionTool();
        const res = await tool.execute({
            questions: [goodQuestion({ options: ["A", "A"] })],
        });
        assert.equal(res.success, false);
        assert.match(res.error ?? "", /unique/);
    });

    it("rejects question text over 256 chars", async () => {
        const tool = askUserQuestionTool();
        const res = await tool.execute({
            questions: [goodQuestion({ question: "x".repeat(257) })],
        });
        assert.equal(res.success, false);
        assert.match(res.error ?? "", /256/);
    });

    it("rejects header over 80 chars", async () => {
        const tool = askUserQuestionTool();
        const res = await tool.execute({
            questions: [goodQuestion({ header: "h".repeat(81) })],
        });
        assert.equal(res.success, false);
        assert.match(res.error ?? "", /80/);
    });

    it("returns error when no callback registered", async () => {
        const tool = askUserQuestionTool();
        const res = await tool.execute({ questions: [goodQuestion()] });
        assert.equal(res.success, false);
        assert.match(res.error ?? "", /no UI registered/);
    });
});

// ─── Happy path ────────────────────────────────────────────────────────────

describe("askUserQuestionTool — happy path", () => {
    it("calls the callback and returns mapped answers", async () => {
        let captured: any = null;
        const tool = askUserQuestionTool({
            async onAsk(questions) {
                captured = questions;
                return {
                    Framework: { question: "Which framework?", answer: "FastAPI" },
                    DB: {
                        question: "Which DB?",
                        answer: OTHER_OPTION,
                        free_text: "DuckDB",
                    },
                };
            },
        });
        const res = await tool.execute({
            questions: [
                goodQuestion(),
                goodQuestion({
                    header: "DB",
                    question: "Which DB?",
                    options: ["Postgres", "SQLite"],
                }),
            ],
        });
        assert.equal(res.success, true, res.error ?? "");
        const parsed = JSON.parse(String(res.output));
        assert.deepEqual(parsed.Framework, {
            question: "Which framework?",
            answer: "FastAPI",
        });
        assert.equal(parsed.DB.answer, OTHER_OPTION);
        assert.equal(parsed.DB.free_text, "DuckDB");
        assert.equal(captured.length, 2);
    });

    it('appends implicit "Other (please specify)" to each question', async () => {
        let captured: any = null;
        const tool = askUserQuestionTool({
            async onAsk(questions) {
                captured = questions;
                const out: Record<string, any> = {};
                for (const q of questions) {
                    out[q.header] = { question: q.question, answer: q.options[0]! };
                }
                return out;
            },
        });
        const res = await tool.execute({ questions: [goodQuestion()] });
        assert.equal(res.success, true);
        assert.equal(captured[0].options.at(-1), OTHER_OPTION);
        assert.equal(captured[0].options.length, 3); // 2 originals + Other
    });

    it("does not double-inject Other when caller already included it", async () => {
        let captured: any = null;
        const tool = askUserQuestionTool({
            async onAsk(questions) {
                captured = questions;
                const out: Record<string, any> = {};
                for (const q of questions) {
                    out[q.header] = { question: q.question, answer: q.options[0]! };
                }
                return out;
            },
        });
        const res = await tool.execute({
            questions: [goodQuestion({ options: ["A", "B", OTHER_OPTION] })],
        });
        assert.equal(res.success, true);
        const otherCount = captured[0].options.filter((o: string) => o === OTHER_OPTION).length;
        assert.equal(otherCount, 1);
    });

    it("surfaces UI exceptions as tool errors", async () => {
        const tool = askUserQuestionTool({
            async onAsk() {
                throw new Error("ui crashed");
            },
        });
        const res = await tool.execute({ questions: [goodQuestion()] });
        assert.equal(res.success, false);
        assert.match(res.error ?? "", /ui crashed/);
    });
});
