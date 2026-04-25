/**
 * AskUserQuestion — structured human-in-the-loop multiple-choice tool.
 *
 * Inspired by Claude Code's `AskUserQuestionTool`. The agent emits a small
 * batch (1-3) of structured questions; the host UI is responsible for
 * collecting answers via a callback supplied by the embedder.
 *
 * Usage:
 *
 *   import { askUserQuestionTool } from "clawagents";
 *
 *   const tool = askUserQuestionTool({
 *       onAsk: async (questions) => {
 *           // render questions in a TUI / web / channel adapter
 *           return Object.fromEntries(questions.map((q) => [
 *               q.header,
 *               { question: q.question, answer: q.options[0] },
 *           ]));
 *       },
 *   });
 *
 * If no `onAsk` is provided the tool still validates input but returns
 * `success: false` rather than hanging on stdin — this keeps it safe to
 * install in headless / channel gateways.
 */

import type { Tool, ToolResult } from "./registry.js";

// ─── Spec types ────────────────────────────────────────────────────────────

export interface QuestionSpec {
    question: string;
    header: string;
    options: string[];
    multiSelect?: boolean;
}

export interface AnswerSpec {
    question: string;
    answer: string;
    free_text?: string;
}

export type OnAskCallback = (questions: QuestionSpec[]) => Promise<Record<string, AnswerSpec>>;

export interface AskUserQuestionOptions {
    onAsk?: OnAskCallback;
}

// ─── Constants ─────────────────────────────────────────────────────────────

export const QUESTION_MAX_CHARS = 256;
export const HEADER_MAX_CHARS = 80;
export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 3;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const OTHER_OPTION = "Other (please specify)";

// ─── Validation ────────────────────────────────────────────────────────────

function validate(questions: unknown): string | null {
    if (!Array.isArray(questions)) {
        return "`questions` must be an array";
    }
    if (questions.length < MIN_QUESTIONS || questions.length > MAX_QUESTIONS) {
        return `must provide ${MIN_QUESTIONS}-${MAX_QUESTIONS} questions, got ${questions.length}`;
    }

    const seenHeaders = new Set<string>();
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (!q || typeof q !== "object") {
            return `question[${i}] must be an object`;
        }
        const rec = q as Record<string, unknown>;
        const question = rec["question"];
        const header = rec["header"];
        const options = rec["options"];
        const multiSelect = rec["multiSelect"];

        if (typeof question !== "string" || question.trim() === "") {
            return `question[${i}].question must be a non-empty string`;
        }
        if (question.length > QUESTION_MAX_CHARS) {
            return `question[${i}].question exceeds ${QUESTION_MAX_CHARS} characters`;
        }

        if (typeof header !== "string" || header.trim() === "") {
            return `question[${i}].header must be a non-empty string`;
        }
        if (header.length > HEADER_MAX_CHARS) {
            return `question[${i}].header exceeds ${HEADER_MAX_CHARS} characters`;
        }
        if (seenHeaders.has(header)) {
            return `duplicate header: ${JSON.stringify(header)}`;
        }
        seenHeaders.add(header);

        if (!Array.isArray(options)) {
            return `question[${i}].options must be an array`;
        }
        if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
            return `question[${i}].options must have ${MIN_OPTIONS}-${MAX_OPTIONS} items, got ${options.length}`;
        }
        if (!options.every((o) => typeof o === "string" && o.trim() !== "")) {
            return `question[${i}].options entries must be non-empty strings`;
        }
        if (new Set(options).size !== options.length) {
            return `question[${i}].options entries must be unique`;
        }

        if (multiSelect !== undefined && typeof multiSelect !== "boolean") {
            return `question[${i}].multiSelect must be a boolean`;
        }
    }
    return null;
}

function injectOther(questions: QuestionSpec[]): QuestionSpec[] {
    return questions.map((q) => {
        const opts = [...q.options];
        if (!opts.includes(OTHER_OPTION)) {
            opts.push(OTHER_OPTION);
        }
        return {
            question: q.question,
            header: q.header,
            options: opts,
            multiSelect: Boolean(q.multiSelect),
        };
    });
}

// ─── Tool factory ──────────────────────────────────────────────────────────

export function askUserQuestionTool(opts: AskUserQuestionOptions = {}): Tool {
    const onAsk = opts.onAsk;

    return {
        name: "ask_user_question",
        description:
            "Ask the user 1-3 structured multiple-choice questions in a single batch. " +
            "Use when you need clarification with a small, well-defined option set. " +
            "Each question must have a short header (≤80 chars), the question text " +
            "(≤256 chars), and 2-4 options. An implicit 'Other (please specify)' " +
            "option is always appended so the user can break out of the menu.",
        parameters: {
            questions: {
                type: "array",
                description:
                    "Array of 1-3 question objects, each with `question` (string), " +
                    "`header` (string), `options` (array of 2-4 unique strings) and " +
                    "optional `multiSelect` (boolean, default false). Headers must be " +
                    "unique across the batch.",
                required: true,
                items: { type: "object" },
            },
        },
        async execute(args): Promise<ToolResult> {
            const raw = args["questions"];
            const err = validate(raw);
            if (err) {
                return { success: false, output: "", error: err };
            }
            const prepared = injectOther(raw as QuestionSpec[]);

            if (!onAsk) {
                return {
                    success: false,
                    output: "",
                    error:
                        "ask_user_question: no UI registered. Pass an `onAsk` " +
                        "callback to askUserQuestionTool() to enable HITL prompts.",
                };
            }

            let answers: Record<string, AnswerSpec>;
            try {
                answers = await onAsk(prepared);
            } catch (e) {
                return { success: false, output: "", error: `ask_user_question UI error: ${String(e)}` };
            }

            if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
                return {
                    success: false,
                    output: "",
                    error: "ask_user_question: onAsk callback must return an object keyed by header",
                };
            }

            const out: Record<string, AnswerSpec> = {};
            for (const q of prepared) {
                const ans = answers[q.header];
                if (!ans || typeof ans !== "object") {
                    out[q.header] = { question: q.question, answer: "", free_text: "" };
                    continue;
                }
                const entry: AnswerSpec = {
                    question: q.question,
                    answer: String(ans.answer ?? ""),
                };
                if (ans.free_text) {
                    entry.free_text = String(ans.free_text);
                }
                out[q.header] = entry;
            }

            return { success: true, output: JSON.stringify(out) };
        },
    };
}
