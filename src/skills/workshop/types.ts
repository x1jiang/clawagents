/** Governed skill proposal types (OpenClaw Skill Workshop pattern). */

export type ProposalStatus = "pending" | "applied" | "rejected" | "quarantined" | "stale";
export type ProposalAction = "create" | "update" | "revise" | "list" | "inspect" | "apply" | "reject" | "quarantine";
export type SupportFolder = "assets" | "examples" | "references" | "scripts" | "templates";

export const SUPPORT_FOLDERS: readonly SupportFolder[] = [
    "assets",
    "examples",
    "references",
    "scripts",
    "templates",
] as const;

export interface SupportFile {
    path: string;
    content: string;
}

export interface SkillProposalRecord {
    id: string;
    name: string;
    description: string;
    status: ProposalStatus;
    action: "create" | "update";
    targetSkill?: string;
    targetHash?: string;
    goal: string;
    evidence: string;
    createdAt: number;
    updatedAt: number;
    scanFindings: string[];
    supportFiles: SupportFile[];
}
