import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Tool, ToolRegistry } from "./tools/registry.js";

export interface ExplorerToolsOptions {
    root?: string;
    tools?: ToolRegistry;
}

function safeRoot(root?: string): string {
    try { return realpathSync(root ?? process.cwd()); } catch { return resolve(root ?? process.cwd()); }
}

function safePath(root: string, userPath: string): string {
    const lexical = resolve(root, userPath || ".");
    let head = lexical;
    const tail: string[] = [];
    while (true) {
        try {
            const realHead = realpathSync(head);
            const final = tail.length ? resolve(realHead, ...tail) : realHead;
            if (final !== root && !final.startsWith(root + sep)) {
                throw new Error(`Path traversal blocked: ${userPath}`);
            }
            return final;
        } catch (err) {
            if (err instanceof Error && err.message.startsWith("Path traversal")) throw err;
            const parent = dirname(head);
            if (parent === head) {
                if (lexical !== root && !lexical.startsWith(root + sep)) throw new Error(`Path traversal blocked: ${userPath}`);
                return lexical;
            }
            tail.unshift(basename(head));
            head = parent;
        }
    }
}

export function createExplorerTools(opts: ExplorerToolsOptions = {}): Tool[] {
    const root = safeRoot(opts.root);

    const listTools: Tool = {
        name: "explorer_list_tools",
        description: "List the ClawAgents tools registered in the supplied registry.",
        parameters: {},
        parallelSafe: true,
        async execute() {
            const entries = opts.tools?.inspectTools?.() ?? [];
            return { success: true, output: JSON.stringify(entries) };
        },
    };

    const readSource: Tool = {
        name: "explorer_read_source",
        description: "Read a source file under the explorer root.",
        parameters: {
            path: { type: "string", description: "Path relative to the explorer root.", required: true },
        },
        parallelSafe: true,
        async execute(args) {
            try {
                const p = safePath(root, String(args.path ?? ""));
                if (!statSync(p).isFile()) return { success: false, output: "", error: "Not a file" };
                return { success: true, output: readFileSync(p, "utf-8") };
            } catch (err) {
                return { success: false, output: "", error: String(err) };
            }
        },
    };

    const listDirectory: Tool = {
        name: "explorer_list_directory",
        description: "List files and directories under the explorer root.",
        parameters: {
            path: { type: "string", description: "Directory path relative to the explorer root." },
        },
        parallelSafe: true,
        async execute(args) {
            try {
                const p = safePath(root, String(args.path ?? "."));
                const entries = readdirSync(p, { withFileTypes: true }).map((e) => ({
                    name: e.name,
                    path: relative(root, join(p, e.name)),
                    is_directory: e.isDirectory(),
                    is_file: e.isFile(),
                }));
                return { success: true, output: JSON.stringify(entries) };
            } catch (err) {
                return { success: false, output: "", error: String(err) };
            }
        },
    };

    const architecture: Tool = {
        name: "explorer_architecture",
        description: "Return a compact architecture summary for the current ClawAgents package.",
        parameters: {},
        parallelSafe: true,
        async execute() {
            return {
                success: true,
                output: JSON.stringify({
                    root,
                    modules: ["agent", "graph", "tools", "sandbox", "session", "trajectory", "rl", "mcp", "gateway"],
                }),
            };
        },
    };

    return [listTools, readSource, listDirectory, architecture];
}
