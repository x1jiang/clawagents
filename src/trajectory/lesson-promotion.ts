/** Promote recurring PTRL lessons into governed skill_workshop proposals. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SkillWorkshopService } from "../skills/workshop/service.js";
import {
    lessonKey,
    parseLessonBullets,
    slugifyLessonName,
} from "./lessons.js";

const INDEX_FILE = "lesson-index.json";
const DEFAULT_MIN_OCCURRENCES = 3;

interface LessonIndexEntry {
    text: string;
    count: number;
    first_seen: number;
    last_seen: number;
    promoted_proposal_id: string | null;
}

interface LessonIndex {
    lessons: Record<string, LessonIndexEntry>;
}

function clawagentsDir(workspace: string): string {
    return join(workspace, ".clawagents");
}

function indexPath(workspace: string): string {
    return join(clawagentsDir(workspace), INDEX_FILE);
}

function loadIndex(workspace: string): LessonIndex {
    const path = indexPath(workspace);
    if (!existsSync(path)) return { lessons: {} };
    try {
        const data = JSON.parse(readFileSync(path, "utf-8")) as LessonIndex;
        if (data && typeof data.lessons === "object") return data;
    } catch {
        // corrupt index — start fresh
    }
    return { lessons: {} };
}

function saveIndex(workspace: string, data: LessonIndex): void {
    const dir = clawagentsDir(workspace);
    mkdirSync(dir, { recursive: true });
    writeFileSync(indexPath(workspace), JSON.stringify(data, null, 2), "utf-8");
}

export function recordLessonsInIndex(newLessonsMd: string, workspace: string): Record<string, LessonIndexEntry> {
    const index = loadIndex(workspace);
    const now = Math.floor(Date.now() / 1000);
    const updated: Record<string, LessonIndexEntry> = {};

    for (const bullet of parseLessonBullets(newLessonsMd)) {
        const key = lessonKey(bullet);
        let entry = index.lessons[key];
        if (!entry) {
            entry = {
                text: bullet,
                count: 0,
                first_seen: now,
                last_seen: now,
                promoted_proposal_id: null,
            };
            index.lessons[key] = entry;
        }
        entry.count += 1;
        entry.last_seen = now;
        entry.text = bullet;
        updated[key] = entry;
    }

    saveIndex(workspace, index);
    return updated;
}

export function maybePromoteRecurringLessons(
    newLessonsMd: string,
    opts: {
        task: string;
        workspace?: string;
        minOccurrences?: number;
        skillsDir?: string;
    },
): Array<Record<string, unknown>> {
    const ws = opts.workspace ?? process.cwd();
    const minOccurrences = opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
    const updated = recordLessonsInIndex(newLessonsMd, ws);
    const created: Array<Record<string, unknown>> = [];

    let service: SkillWorkshopService;
    try {
        service = new SkillWorkshopService(ws, opts.skillsDir);
    } catch {
        return created;
    }

    const existingNames = new Set(service.list().map((p) => String(p.name ?? "")));
    const index = loadIndex(ws);

    for (const [key, entry] of Object.entries(updated)) {
        if (entry.count < minOccurrences) continue;
        if (entry.promoted_proposal_id) continue;

        const text = entry.text;
        const name = slugifyLessonName(text);
        if (existingNames.has(name)) {
            index.lessons[key]!.promoted_proposal_id = "existing";
            entry.promoted_proposal_id = "existing";
            continue;
        }

        const body = [
            `# ${name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`,
            "",
            `Recurring lesson promoted from PTRL (seen ${entry.count} times).`,
            "",
            "## Guidance",
            `- ${text}`,
            "",
            "## Evidence",
            `Extracted from lessons.md after run: ${opts.task.slice(0, 120)}`,
            "",
        ].join("\n");

        try {
            const proposal = service.create({
                name,
                description: text.slice(0, 200),
                body,
                goal: "Automated promotion from recurring PTRL lesson",
                evidence: `lesson_key=${key}; occurrences=${entry.count}`,
            });
            const proposalId = String(proposal.id ?? "");
            index.lessons[key]!.promoted_proposal_id = proposalId;
            entry.promoted_proposal_id = proposalId;
            existingNames.add(name);
            created.push(proposal);
        } catch {
            // best effort
        }
    }

    saveIndex(ws, index);
    return created;
}
