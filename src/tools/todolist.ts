/**
 * TodoList planning tools for structured multi-step task execution.
 *
 * Provides write_todos and update_todo tools that let the agent plan
 * before acting.
 */

import type { Tool, ToolResult } from "./registry.js";

// Module-level state
let todos: Array<{ text: string; done: boolean }> = [];

function formatTodos(): string {
    if (todos.length === 0) return "(no todos)";
    const done = todos.filter((t) => t.done).length;
    const lines = [`## Progress: ${done}/${todos.length} complete\n`];
    for (let i = 0; i < todos.length; i++) {
        const mark = todos[i]!.done ? "[x]" : "[ ]";
        lines.push(`${i}. ${mark} ${todos[i]!.text}`);
    }
    return lines.join("\n");
}

export const writeTodosTool: Tool = {
    name: "write_todos",
    description:
        "Create or replace a todo list for the current task. " +
        "Use this at the start of a complex task to plan your approach. " +
        'Pass a JSON array of strings describing each step.',
    parameters: {
        todos: {
            type: "array",
            items: { type: "string" },
            description: 'JSON array of todo strings, e.g. ["Read file", "Fix bug", "Test"]',
            required: true,
        },
    },
    async execute(args): Promise<ToolResult> {
        let raw: unknown = args["todos"];

        if (typeof raw === "string") {
            try {
                raw = JSON.parse(raw);
            } catch {
                return { success: false, output: "", error: "Invalid JSON array" };
            }
        }

        if (!Array.isArray(raw)) {
            return { success: false, output: "", error: "Expected a JSON array of strings" };
        }

        todos = raw.map((item) => ({ text: String(item), done: false }));
        return { success: true, output: formatTodos() };
    },
};

export const updateTodoTool: Tool = {
    name: "update_todo",
    description:
        "Mark a todo item as completed by its index (0-based). " +
        "Use after finishing a planned step.",
    parameters: {
        index: {
            type: "number",
            description: "0-based index of the todo to mark as complete",
            required: true,
        },
    },
    async execute(args): Promise<ToolResult> {
        const rawIdx = Number(args["index"] ?? -1);
        const idx = Number.isFinite(rawIdx) ? Math.floor(rawIdx) : -1;

        if (todos.length === 0) {
            return { success: false, output: "", error: "No todo list exists. Use write_todos first." };
        }
        if (idx < 0 || idx >= todos.length) {
            return { success: false, output: "", error: `Index ${idx} out of range (0-${todos.length - 1})` };
        }

        todos[idx]!.done = true;
        return { success: true, output: formatTodos() };
    },
};

export function resetTodos(): void {
    todos = [];
}

export const todolistTools: Tool[] = [writeTodosTool, updateTodoTool];
