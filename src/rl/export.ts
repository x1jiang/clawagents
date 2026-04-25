/**
 * JSONL / ChatML / TRL / Atropos export helpers.
 *
 * These functions don't require any training framework — they only
 * reshape trajectories into the dict layouts the frameworks expect.
 * The {@link TrlAdapter} / {@link AtroposAdapter} in `./adapters` provide
 * deeper integration when their optional packages are installed.
 *
 * Mirrors `clawagents.rl.export` on the Python side.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Trajectory } from "./trajectory.js";

function ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/** Write trajectories as JSONL (one trajectory per line). Returns the count. */
export function exportJsonl(
    trajectories: Iterable<Trajectory>,
    filePath: string
): number {
    ensureDir(filePath);
    let n = 0;
    const fd = fs.openSync(filePath, "w");
    try {
        for (const traj of trajectories) {
            fs.writeSync(fd, traj.toJsonString() + "\n");
            n += 1;
        }
    } finally {
        fs.closeSync(fd);
    }
    return n;
}

/** Read trajectories previously written by {@link exportJsonl}. */
export function loadJsonl(filePath: string): Trajectory[] {
    const text = fs.readFileSync(filePath, "utf-8");
    const out: Trajectory[] = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        out.push(Trajectory.fromJsonString(trimmed));
    }
    return out;
}

/**
 * Convert a trajectory to a ChatML-compatible message list.
 *
 * The output matches what `transformers`' `apply_chat_template` and
 * most TRL trainers expect.
 */
export function toChatML(traj: Trajectory): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = [];
    for (const step of traj.steps) {
        if (step.role === "assistant" && step.toolCalls.length > 0) {
            msgs.push({
                role: "assistant",
                content: step.content || "",
                tool_calls: step.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function",
                    function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.arguments),
                    },
                })),
            });
        } else if (step.role === "tool") {
            const m: Record<string, unknown> = {
                role: "tool",
                content: step.content,
                tool_call_id: step.toolCallId ?? "",
            };
            if (step.name) m.name = step.name;
            msgs.push(m);
        } else {
            msgs.push({ role: step.role, content: step.content });
        }
    }
    return msgs;
}

/**
 * Shape one row for TRL's `SFTTrainer`.
 *
 * Emits both a `messages` list and a separated `prompt`/`completion`
 * pair so the user can pick whichever matches their pipeline.
 */
export function toTrlSft(traj: Trajectory): Record<string, unknown> {
    const messages = toChatML(traj);
    const final = traj.finalAssistant;
    const promptMsgs = messages.filter((m) => m.role !== "assistant");
    return {
        messages,
        prompt: promptMsgs,
        completion: [
            {
                role: "assistant",
                content: final ? final.content : "",
            },
        ],
        metadata: {
            run_id: traj.runId,
            task: traj.task,
            model: traj.model,
            reward: traj.reward,
        },
    };
}

/**
 * Shape a preference pair for TRL's `DPOTrainer`.
 *
 * Both trajectories should share the same prompt prefix (system +
 * user). The function uses `chosen`'s prefix as the reference.
 */
export function toTrlDpo(
    chosen: Trajectory,
    rejected: Trajectory
): Record<string, unknown> {
    const chosenFinal = chosen.finalAssistant;
    const rejectedFinal = rejected.finalAssistant;
    const promptMsgs = chosen.steps
        .filter((s) => s.role === "system" || s.role === "user")
        .map((s) => ({ role: s.role, content: s.content }));
    return {
        prompt: promptMsgs,
        chosen: [
            {
                role: "assistant",
                content: chosenFinal ? chosenFinal.content : "",
            },
        ],
        rejected: [
            {
                role: "assistant",
                content: rejectedFinal ? rejectedFinal.content : "",
            },
        ],
        metadata: {
            chosen_run_id: chosen.runId,
            rejected_run_id: rejected.runId,
            chosen_reward: chosen.reward,
            rejected_reward: rejected.reward,
        },
    };
}

/**
 * Shape a rollout for the Atropos / Nous environment harness.
 *
 * Atropos rollouts are dictionaries with `messages`, `score`, and
 * `metadata` — we just thread the trajectory through.
 */
export function toAtroposRollout(traj: Trajectory): Record<string, unknown> {
    return {
        messages: toChatML(traj),
        score: traj.reward ?? 0.0,
        rewards: { ...traj.rewards },
        metadata: {
            run_id: traj.runId,
            task: traj.task,
            model: traj.model,
            ...traj.metadata,
        },
    };
}

/** Write a TRL-SFT-shaped JSONL file. */
export function exportTrlSftJsonl(
    trajs: Iterable<Trajectory>,
    filePath: string
): number {
    ensureDir(filePath);
    let n = 0;
    const fd = fs.openSync(filePath, "w");
    try {
        for (const t of trajs) {
            fs.writeSync(fd, JSON.stringify(toTrlSft(t)) + "\n");
            n += 1;
        }
    } finally {
        fs.closeSync(fd);
    }
    return n;
}

/** Write an Atropos rollouts JSONL file. */
export function exportAtroposRolloutsJsonl(
    trajs: Iterable<Trajectory>,
    filePath: string
): number {
    ensureDir(filePath);
    let n = 0;
    const fd = fs.openSync(filePath, "w");
    try {
        for (const t of trajs) {
            fs.writeSync(fd, JSON.stringify(toAtroposRollout(t)) + "\n");
            n += 1;
        }
    } finally {
        fs.closeSync(fd);
    }
    return n;
}
