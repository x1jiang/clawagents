import { scanProposalContent } from "./scanner.js";
import { SkillWorkshopStore } from "./store.js";
import type { SkillProposalRecord } from "./types.js";

export class SkillWorkshopService {
    readonly store: SkillWorkshopStore;

    constructor(workspace: string, skillsDir?: string) {
        this.store = new SkillWorkshopStore(workspace, skillsDir);
    }

    create(opts: {
        name: string;
        description: string;
        body: string;
        goal?: string;
        evidence?: string;
        supportFiles?: Array<{ path: string; content: string }>;
    }): Record<string, unknown> {
        const pairs = (opts.supportFiles ?? []).map((f) => [f.path, f.content] as [string, string]);
        const findings = scanProposalContent(opts.name, opts.description, opts.body, pairs);
        const rec = this.store.createProposal({
            name: opts.name,
            description: opts.description,
            body: opts.body,
            action: "create",
            goal: opts.goal,
            evidence: opts.evidence,
            supportFiles: pairs,
            scanFindings: findings,
        });
        return this.serialize(rec, findings);
    }

    update(opts: {
        targetSkill: string;
        description: string;
        body: string;
        goal?: string;
        evidence?: string;
        supportFiles?: Array<{ path: string; content: string }>;
    }): Record<string, unknown> {
        const pairs = (opts.supportFiles ?? []).map((f) => [f.path, f.content] as [string, string]);
        const findings = scanProposalContent(opts.targetSkill, opts.description, opts.body, pairs);
        const rec = this.store.createProposal({
            name: opts.targetSkill,
            description: opts.description,
            body: opts.body,
            action: "update",
            targetSkill: opts.targetSkill,
            goal: opts.goal,
            evidence: opts.evidence,
            supportFiles: pairs,
            scanFindings: findings,
        });
        return this.serialize(rec, findings);
    }

    revise(proposalId: string, opts: { body: string; description?: string }): Record<string, unknown> {
        const rec = this.store.get(proposalId);
        if (!rec || rec.status !== "pending") return { ok: false, error: "proposal not pending" };
        const pairs = rec.supportFiles.map((s) => [s.path, s.content] as [string, string]);
        const desc = opts.description ?? rec.description;
        const findings = scanProposalContent(rec.name, desc, opts.body, pairs);
        const updated = this.store.updateProposalContent(proposalId, opts.body, desc, findings);
        if (!updated) return { ok: false, error: "proposal missing after revise" };
        return this.serialize(updated, findings);
    }

    list(): Array<Record<string, unknown>> {
        return this.store.listProposals().map((r) => this.serialize(r, r.scanFindings));
    }

    inspect(proposalId: string): Record<string, unknown> {
        const rec = this.store.get(proposalId);
        if (!rec) return { ok: false, error: "not found" };
        return {
            ...this.serialize(rec, rec.scanFindings),
            body: this.store.proposalBody(proposalId),
        };
    }

    apply(proposalId: string): Record<string, unknown> {
        const rec = this.store.get(proposalId);
        if (!rec) return { ok: false, error: "not found" };
        // Every finding the scanner emits is a real reason to refuse writing the
        // proposal to a live SKILL.md — most importantly the "suspicious
        // pattern …" findings (rm -rf, `curl … | sh`, `eval(`, `__import__` …)
        // and the oversize/too-many/bad-path ones. The old substring gate
        // ("exceeds"/"invalid"/"must be") let the security and resource findings
        // through, making the malicious-pattern check cosmetic. Block on any.
        if (rec.scanFindings.length > 0) {
            return { ok: false, error: "scan blocked apply", findings: rec.scanFindings };
        }
        const [ok, msg, rollbackId] = this.store.applyProposal(proposalId);
        return { ok, message: msg, rollback_id: rollbackId };
    }

    reject(proposalId: string, reason = ""): Record<string, unknown> {
        const rec = this.store.updateStatus(proposalId, "rejected");
        if (!rec) return { ok: false, error: "not found" };
        return { ok: true, status: "rejected", reason };
    }

    quarantine(proposalId: string, reason = ""): Record<string, unknown> {
        const rec = this.store.updateStatus(proposalId, "quarantined");
        if (!rec) return { ok: false, error: "not found" };
        return { ok: true, status: "quarantined", reason };
    }

    rollback(rollbackId: string): Record<string, unknown> {
        const snap = this.store.loadRollback(rollbackId);
        if (!snap) return { ok: false, error: "rollback not found" };
        this.store.restoreSnapshot(snap);
        return { ok: true, restored: snap.name };
    }

    private serialize(rec: SkillProposalRecord, findings: string[]): Record<string, unknown> {
        return {
            id: rec.id,
            name: rec.name,
            description: rec.description,
            status: rec.status,
            action: rec.action,
            target_skill: rec.targetSkill,
            target_hash: rec.targetHash,
            goal: rec.goal,
            evidence: rec.evidence,
            scan_findings: findings,
            support_file_count: rec.supportFiles.length,
        };
    }
}
