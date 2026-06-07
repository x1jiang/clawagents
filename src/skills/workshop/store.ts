/** File-backed proposal store under `.clawagents/skill-workshop/`. */

import { createHash, randomBytes } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { SkillProposalRecord, SupportFile } from "./types.js";

function sha256Text(text: string): string {
    return createHash("sha256").update(text, "utf-8").digest("hex");
}

function readText(path: string): string {
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf-8") : "";
}

function walkFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkFiles(full));
        else if (entry.isFile()) out.push(full);
    }
    return out;
}

export class SkillWorkshopStore {
    readonly workspace: string;
    readonly skillsDir: string;
    readonly root: string;
    readonly proposalsDir: string;
    readonly rollbackDir: string;

    constructor(workspace: string, skillsDir?: string) {
        this.workspace = resolve(workspace);
        this.skillsDir = resolve(skillsDir ?? join(this.workspace, "skills"));
        this.root = join(this.workspace, ".clawagents", "skill-workshop");
        this.proposalsDir = join(this.root, "proposals");
        this.rollbackDir = join(this.root, "rollback");
        mkdirSync(this.proposalsDir, { recursive: true });
        mkdirSync(this.rollbackDir, { recursive: true });
    }

    private proposalDir(proposalId: string): string {
        return join(this.proposalsDir, proposalId);
    }

    private metaPath(proposalId: string): string {
        return join(this.proposalDir(proposalId), "meta.json");
    }

    private bodyPath(proposalId: string): string {
        return join(this.proposalDir(proposalId), "PROPOSAL.md");
    }

    listProposals(): SkillProposalRecord[] {
        const out: SkillProposalRecord[] = [];
        if (!existsSync(this.proposalsDir)) return out;
        for (const entry of readdirSync(this.proposalsDir).sort()) {
            const dir = join(this.proposalsDir, entry);
            if (statSync(dir).isDirectory() && existsSync(join(dir, "meta.json"))) {
                const rec = this.get(entry);
                if (rec) out.push(rec);
            }
        }
        return out;
    }

    get(proposalId: string): SkillProposalRecord | null {
        const metaPath = this.metaPath(proposalId);
        if (!existsSync(metaPath)) return null;
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;

        const support: SupportFile[] = [];
        const supportRoot = join(this.proposalDir(proposalId), "support");
        if (existsSync(supportRoot)) {
            for (const path of walkFiles(supportRoot).sort()) {
                const rel = path.slice(supportRoot.length + 1);
                support.push({ path: rel, content: readFileSync(path, "utf-8") });
            }
        }

        return {
            id: String(meta.id),
            name: String(meta.name),
            description: String(meta.description ?? ""),
            status: (meta.status as SkillProposalRecord["status"]) ?? "pending",
            action: (meta.action as SkillProposalRecord["action"]) ?? "create",
            targetSkill: meta.target_skill as string | undefined,
            targetHash: meta.target_hash as string | undefined,
            goal: String(meta.goal ?? ""),
            evidence: String(meta.evidence ?? ""),
            createdAt: Number(meta.created_at ?? 0),
            updatedAt: Number(meta.updated_at ?? 0),
            scanFindings: Array.isArray(meta.scan_findings) ? meta.scan_findings.map(String) : [],
            supportFiles: support,
        };
    }

    createProposal(opts: {
        name: string;
        description: string;
        body: string;
        action?: "create" | "update";
        targetSkill?: string;
        goal?: string;
        evidence?: string;
        supportFiles?: Array<[string, string]>;
        scanFindings?: string[];
    }): SkillProposalRecord {
        const proposalId = randomBytes(6).toString("hex");
        const now = Date.now() / 1000;
        let targetHash: string | undefined;
        if (opts.action === "update" && opts.targetSkill) {
            const skillPath = join(this.skillsDir, opts.targetSkill, "SKILL.md");
            if (existsSync(skillPath)) targetHash = sha256Text(readText(skillPath));
        }

        const meta: Record<string, unknown> = {
            id: proposalId,
            name: opts.name,
            description: opts.description,
            status: "pending",
            action: opts.action ?? "create",
            target_skill: opts.targetSkill,
            target_hash: targetHash,
            goal: opts.goal ?? "",
            evidence: opts.evidence ?? "",
            created_at: now,
            updated_at: now,
            scan_findings: opts.scanFindings ?? [],
        };

        const pdir = this.proposalDir(proposalId);
        mkdirSync(pdir, { recursive: true });
        writeFileSync(this.bodyPath(proposalId), opts.body, "utf-8");

        if (opts.supportFiles) {
            for (const [rel, content] of opts.supportFiles) {
                const dest = join(pdir, "support", rel);
                mkdirSync(dirname(dest), { recursive: true });
                writeFileSync(dest, content, "utf-8");
            }
        }

        writeFileSync(this.metaPath(proposalId), JSON.stringify(meta, null, 2), "utf-8");
        const rec = this.get(proposalId);
        if (!rec) throw new Error("failed to create proposal");
        return rec;
    }

    updateStatus(proposalId: string, status: string): SkillProposalRecord | null {
        const metaPath = this.metaPath(proposalId);
        if (!existsSync(metaPath)) return null;
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
        meta.status = status;
        meta.updated_at = Date.now() / 1000;
        writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
        return this.get(proposalId);
    }

    proposalBody(proposalId: string): string {
        return readText(this.bodyPath(proposalId));
    }

    updateProposalContent(
        proposalId: string,
        body: string,
        description: string,
        scanFindings: string[],
    ): SkillProposalRecord | null {
        const metaPath = this.metaPath(proposalId);
        if (!existsSync(metaPath)) return null;
        writeFileSync(this.bodyPath(proposalId), body, "utf-8");
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>;
        meta.description = description;
        meta.scan_findings = scanFindings;
        meta.updated_at = Date.now() / 1000;
        writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
        return this.get(proposalId);
    }

    skillPath(name: string): string {
        return join(this.skillsDir, name, "SKILL.md");
    }

    skillHash(name: string): string | null {
        const path = this.skillPath(name);
        return existsSync(path) ? sha256Text(readText(path)) : null;
    }

    saveRollback(skillName: string, snapshot: Record<string, unknown>): string {
        const rollbackId = `${skillName}-${Math.floor(Date.now() / 1000)}`;
        writeFileSync(
            join(this.rollbackDir, `${rollbackId}.json`),
            JSON.stringify(snapshot, null, 2),
            "utf-8",
        );
        return rollbackId;
    }

    loadRollback(rollbackId: string): Record<string, unknown> | null {
        const path = join(this.rollbackDir, `${rollbackId}.json`);
        if (!existsSync(path)) return null;
        return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    }

    snapshotSkill(name: string): Record<string, unknown> {
        const skillRoot = join(this.skillsDir, name);
        const files: Record<string, string> = {};
        if (existsSync(skillRoot)) {
            for (const path of walkFiles(skillRoot)) {
                const rel = path.slice(skillRoot.length + 1);
                files[rel] = readFileSync(path, "utf-8");
            }
        }
        return { name, files };
    }

    restoreSnapshot(snapshot: Record<string, unknown>): void {
        const name = String(snapshot.name);
        const skillRoot = join(this.skillsDir, name);
        if (existsSync(skillRoot)) {
            rmSync(skillRoot, { recursive: true, force: true });
        }
        const files = snapshot.files as Record<string, string> | undefined;
        if (files) {
            for (const [rel, content] of Object.entries(files)) {
                const dest = join(skillRoot, rel);
                mkdirSync(dirname(dest), { recursive: true });
                writeFileSync(dest, content, "utf-8");
            }
        }
    }

    applyProposal(proposalId: string): [ok: boolean, message: string, rollbackId: string | null] {
        const rec = this.get(proposalId);
        if (!rec) return [false, "proposal not found", null];
        if (rec.status !== "pending") return [false, `proposal status is ${rec.status}`, null];
        if (rec.action === "update" && rec.targetSkill && rec.targetHash) {
            const current = this.skillHash(rec.targetSkill);
            if (current && current !== rec.targetHash) {
                this.updateStatus(proposalId, "stale");
                return [false, "target skill changed since proposal; marked stale", null];
            }
        }

        const body = this.proposalBody(proposalId);
        const skillName = rec.action === "update" ? rec.targetSkill! : rec.name;
        const rollbackId = this.saveRollback(skillName, this.snapshotSkill(skillName));
        const skillRoot = join(this.skillsDir, skillName);
        mkdirSync(skillRoot, { recursive: true });
        writeFileSync(this.skillPath(skillName), body, "utf-8");

        const supportDir = join(this.proposalDir(proposalId), "support");
        if (existsSync(supportDir)) {
            for (const path of walkFiles(supportDir)) {
                const rel = path.slice(supportDir.length + 1);
                const dest = join(skillRoot, rel);
                mkdirSync(dirname(dest), { recursive: true });
                writeFileSync(dest, readFileSync(path, "utf-8"), "utf-8");
            }
        }

        this.updateStatus(proposalId, "applied");
        return [true, `applied skill ${skillName}`, rollbackId];
    }
}
