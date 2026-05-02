/** Structured state preserved across context compaction. */

import type { RunContext } from "../run-context.js";

export const COMPACTION_CARRYOVER_KEY = "compactionCarryover";

export interface ChannelCarryoverEntry {
    channelId?: string;
    channel_id?: string;
    conversationId?: string;
    conversation_id?: string;
    body?: string;
    [key: string]: unknown;
}

export interface CompactionCarryover {
    taskFocus?: string;
    recentFiles: string[];
    recentWorkLog: string[];
    invokedSkills: string[];
    activeWorkers: string[];
    channelLog: ChannelCarryoverEntry[];
    metadata: Record<string, unknown>;
}

export function emptyCompactionCarryover(taskFocus?: string): CompactionCarryover {
    return {
        taskFocus,
        recentFiles: [],
        recentWorkLog: [],
        invokedSkills: [],
        activeWorkers: [],
        channelLog: [],
        metadata: {},
    };
}

export function setCompactionCarryover(
    runContext: RunContext<unknown>,
    carryover: Partial<CompactionCarryover>,
): CompactionCarryover {
    const normalized = normalizeCompactionCarryover(carryover);
    runContext._metadata[COMPACTION_CARRYOVER_KEY] = normalized;
    return normalized;
}

export function getCompactionCarryover(
    runContext?: RunContext<unknown>,
    taskContext = "",
): CompactionCarryover {
    const raw = runContext?._metadata?.[COMPACTION_CARRYOVER_KEY];
    const carryover = normalizeCompactionCarryover(raw);
    if (!carryover.taskFocus && taskContext) carryover.taskFocus = taskContext;
    return carryover;
}

export function normalizeCompactionCarryover(value: unknown): CompactionCarryover {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return emptyCompactionCarryover();
    }
    const record = value as Record<string, unknown>;
    const channelLogRaw = record.channelLog ?? record.channel_log;
    return {
        taskFocus: str(record.taskFocus ?? record.task_focus),
        recentFiles: strList(record.recentFiles ?? record.recent_files),
        recentWorkLog: strList(record.recentWorkLog ?? record.recent_work_log),
        invokedSkills: strList(record.invokedSkills ?? record.invoked_skills),
        activeWorkers: strList(record.activeWorkers ?? record.active_workers),
        channelLog: Array.isArray(channelLogRaw)
            ? channelLogRaw.filter(isRecord).map((entry) => ({ ...entry }))
            : [],
        metadata: isRecord(record.metadata) ? { ...record.metadata } : {},
    };
}

export function isCompactionCarryoverEmpty(carryover: CompactionCarryover): boolean {
    return !carryover.taskFocus &&
        carryover.recentFiles.length === 0 &&
        carryover.recentWorkLog.length === 0 &&
        carryover.invokedSkills.length === 0 &&
        carryover.activeWorkers.length === 0 &&
        carryover.channelLog.length === 0 &&
        Object.keys(carryover.metadata).length === 0;
}

export function formatCompactionCarryover(carryover: CompactionCarryover): string {
    if (isCompactionCarryoverEmpty(carryover)) return "";

    const lines = ["## Carryover State"];
    if (carryover.taskFocus) lines.push(`- Task focus: ${clip(carryover.taskFocus, 500)}`);
    if (carryover.recentFiles.length) lines.push(`- Recent files: ${carryover.recentFiles.slice(0, 12).join(", ")}`);
    if (carryover.recentWorkLog.length) {
        lines.push("- Recent work:");
        for (const item of carryover.recentWorkLog.slice(0, 12)) lines.push(`  - ${clip(item, 500)}`);
    }
    if (carryover.invokedSkills.length) lines.push(`- Invoked skills: ${carryover.invokedSkills.slice(0, 12).join(", ")}`);
    if (carryover.activeWorkers.length) lines.push(`- Active workers: ${carryover.activeWorkers.slice(0, 12).join(", ")}`);
    if (carryover.channelLog.length) {
        lines.push("- Recent channel messages:");
        for (const item of carryover.channelLog.slice(0, 8)) {
            const channel = String(item.channelId ?? item.channel_id ?? "channel");
            const conversation = String(item.conversationId ?? item.conversation_id ?? "conversation");
            lines.push(`  - ${channel}:${conversation}: ${clip(String(item.body ?? ""), 300)}`);
        }
    }
    if (Object.keys(carryover.metadata).length) {
        lines.push(`- Metadata: ${clip(JSON.stringify(carryover.metadata), 500)}`);
    }
    return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strList(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (typeof value === "string") return [value];
    if (!Array.isArray(value)) return [];
    return value.filter((item) => item !== undefined && item !== null).map(String);
}

function clip(value: string, limit: number): string {
    return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}
