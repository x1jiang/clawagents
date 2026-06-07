/** skill_workshop tool — governed skill proposals. */

import { cwd } from "node:process";

import { SkillWorkshopService } from "../skills/workshop/service.js";
import type { Tool, ToolResult } from "./registry.js";

export function createSkillWorkshopTool(workspace?: string, skillsDir?: string): Tool {
    const ws = workspace ?? cwd();
    const service = new SkillWorkshopService(ws, skillsDir);

    return {
        name: "skill_workshop",
        description:
            "Governed skill authoring: create/update proposals, scan, apply, reject, quarantine, rollback. " +
            "Never write live SKILL.md directly — use create/update then apply after review.",
        parameters: {
            action: {
                type: "string",
                description: "Workshop action",
                required: true,
            },
            proposal_id: { type: "string", description: "Proposal id" },
            rollback_id: { type: "string", description: "Rollback snapshot id" },
            name: { type: "string", description: "Skill name" },
            target_skill: { type: "string", description: "Target skill for update" },
            description: { type: "string", description: "Skill description" },
            body: { type: "string", description: "Proposal SKILL.md body" },
            goal: { type: "string", description: "Authoring goal" },
            evidence: { type: "string", description: "Supporting evidence" },
            reason: { type: "string", description: "Reject/quarantine reason" },
            support_files: { type: "string", description: "JSON array of {path, content}" },
        },
        async execute(args: Record<string, unknown>): Promise<ToolResult> {
            const action = String(args.action ?? "");
            let result: Record<string, unknown> | Array<Record<string, unknown>>;

            const supportFiles = parseSupportFiles(args.support_files);

            try {
                switch (action) {
                    case "create":
                        result = service.create({
                            name: String(args.name ?? ""),
                            description: String(args.description ?? ""),
                            body: String(args.body ?? ""),
                            goal: String(args.goal ?? ""),
                            evidence: String(args.evidence ?? ""),
                            supportFiles,
                        });
                        break;
                    case "update":
                        result = service.update({
                            targetSkill: String(args.target_skill ?? args.name ?? ""),
                            description: String(args.description ?? ""),
                            body: String(args.body ?? ""),
                            goal: String(args.goal ?? ""),
                            evidence: String(args.evidence ?? ""),
                            supportFiles,
                        });
                        break;
                    case "revise":
                        result = service.revise(String(args.proposal_id ?? ""), {
                            body: String(args.body ?? ""),
                            description: args.description !== undefined ? String(args.description) : undefined,
                        });
                        break;
                    case "list":
                        result = { proposals: service.list() };
                        break;
                    case "inspect":
                        result = service.inspect(String(args.proposal_id ?? ""));
                        break;
                    case "apply":
                        result = service.apply(String(args.proposal_id ?? ""));
                        break;
                    case "reject":
                        result = service.reject(String(args.proposal_id ?? ""), String(args.reason ?? ""));
                        break;
                    case "quarantine":
                        result = service.quarantine(String(args.proposal_id ?? ""), String(args.reason ?? ""));
                        break;
                    case "rollback":
                        result = service.rollback(String(args.rollback_id ?? ""));
                        break;
                    default:
                        result = { ok: false, error: `unknown action ${action}` };
                }
                return { success: true, output: JSON.stringify(result, null, 2) };
            } catch (err) {
                return { success: false, output: "", error: String(err) };
            }
        },
    };
}

function parseSupportFiles(raw: unknown): Array<{ path: string; content: string }> | undefined {
    if (raw === undefined || raw === null || raw === "") return undefined;
    if (Array.isArray(raw)) {
        return raw.map((item) => {
            const o = item as Record<string, unknown>;
            return { path: String(o.path ?? ""), content: String(o.content ?? "") };
        });
    }
    if (typeof raw === "string") {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return undefined;
        return parsed.map((item) => {
            const o = item as Record<string, unknown>;
            return { path: String(o.path ?? ""), content: String(o.content ?? "") };
        });
    }
    return undefined;
}
