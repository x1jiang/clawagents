import type { Tool, ToolResult } from "./registry.js";
import { BackgroundJob, BackgroundJobManager } from "../background.js";

const defaultManager = new BackgroundJobManager();

function jobJson(job: BackgroundJob): Record<string, unknown> {
    return {
        job_id: job.id,
        command: job.command,
        cwd: job.cwd,
        pid: job.pid,
        running: job.running,
        exit_code: job.exitCode,
        cancelled: job.cancelled,
    };
}

export function createBackgroundTaskTools(manager: BackgroundJobManager = defaultManager): Tool[] {
    return [
        {
            name: "task_create",
            description: "Start a background command and return its job id.",
            keywords: ["background", "job", "task", "process", "long-running"],
            parameters: {
                command: { type: "array", description: "Command argv list.", required: true, items: { type: "string" } },
                cwd: { type: "string", description: "Working directory." },
            },
            async execute(args): Promise<ToolResult> {
                const command = args.command;
                if (!Array.isArray(command) || command.length === 0) {
                    return { success: false, output: "", error: "command must be a non-empty argv list" };
                }
                const job = await manager.start(command.map(String), { cwd: args.cwd ? String(args.cwd) : undefined });
                return { success: true, output: JSON.stringify(jobJson(job)) };
            },
        },
        {
            name: "task_status",
            description: "Return status for a background job.",
            keywords: ["background", "job", "task", "status"],
            parameters: { job_id: { type: "string", description: "Job id.", required: true } },
            async execute(args): Promise<ToolResult> {
                try {
                    return { success: true, output: JSON.stringify(jobJson(manager.status(String(args.job_id ?? "")))) };
                } catch (err) {
                    return { success: false, output: "", error: String(err) };
                }
            },
        },
        {
            name: "task_output",
            description: "Return captured stdout and stderr for a background job.",
            keywords: ["background", "job", "task", "output", "logs"],
            parameters: { job_id: { type: "string", description: "Job id.", required: true } },
            async execute(args): Promise<ToolResult> {
                try {
                    const job = manager.status(String(args.job_id ?? ""));
                    return { success: true, output: `stdout:\n${job.stdout}\n\nstderr:\n${job.stderr}` };
                } catch (err) {
                    return { success: false, output: "", error: String(err) };
                }
            },
        },
        {
            name: "task_stop",
            description: "Cancel a running background job.",
            keywords: ["background", "job", "task", "stop", "cancel"],
            parameters: { job_id: { type: "string", description: "Job id.", required: true } },
            async execute(args): Promise<ToolResult> {
                try {
                    return { success: true, output: JSON.stringify(jobJson(await manager.cancel(String(args.job_id ?? "")))) };
                } catch (err) {
                    return { success: false, output: "", error: String(err) };
                }
            },
        },
        {
            name: "task_list",
            description: "List known background jobs.",
            keywords: ["background", "job", "task", "list"],
            parameters: {},
            async execute(): Promise<ToolResult> {
                return { success: true, output: JSON.stringify(manager.list().map(jobJson)) };
            },
        },
    ];
}

