/**
 * Pluggable reward scorers for trajectories.
 *
 * A scorer is any function with the signature
 * `(traj: Trajectory) => number` returning a value in roughly
 * `[-1, 1]`. The included scorers cover the common heuristics —
 * substring matching, exact match, regex, length penalty —
 * and {@link CompositeScorer} blends several into a single reward.
 *
 * Custom scorers don't need to extend a class; they just need to
 * match {@link RewardScorer}.
 *
 * Mirrors `clawagents.rl.scorers` on the Python side.
 */

import { Trajectory } from "./trajectory.js";

/** A function that scores a trajectory. */
export type RewardScorer = (traj: Trajectory) => number;

export interface ContainsScorerOptions {
    needles: string[];
    caseSensitive?: boolean;
    partialCredit?: boolean;
}

/** +1 if every required substring appears in the assistant output, else -1. */
export function containsScorer(opts: ContainsScorerOptions): RewardScorer {
    const needles = opts.needles;
    const caseSensitive = opts.caseSensitive ?? false;
    const partialCredit = opts.partialCredit ?? false;

    return (traj: Trajectory): number => {
        if (needles.length === 0) return 0;
        const text = caseSensitive
            ? traj.assistantText
            : traj.assistantText.toLowerCase();
        let matches = 0;
        for (const n of needles) {
            const probe = caseSensitive ? n : n.toLowerCase();
            if (text.includes(probe)) matches += 1;
        }
        if (partialCredit) {
            return (matches / needles.length) * 2.0 - 1.0;
        }
        return matches === needles.length ? 1.0 : -1.0;
    };
}

export interface ExactMatchScorerOptions {
    expected: string;
    strip?: boolean;
    caseSensitive?: boolean;
}

/** +1 if the final assistant message matches `expected` exactly, else -1. */
export function exactMatchScorer(opts: ExactMatchScorerOptions): RewardScorer {
    const expected = opts.expected;
    const strip = opts.strip ?? true;
    const caseSensitive = opts.caseSensitive ?? true;

    return (traj: Trajectory): number => {
        const final = traj.finalAssistant;
        if (final === null) return -1.0;
        let actual = final.content;
        let target = expected;
        if (strip) {
            actual = actual.trim();
            target = target.trim();
        }
        if (!caseSensitive) {
            actual = actual.toLowerCase();
            target = target.toLowerCase();
        }
        return actual === target ? 1.0 : -1.0;
    };
}

export interface RegexScorerOptions {
    pattern: string;
    flags?: string;
}

/** +1 if regex matches anywhere in the assistant output, else -1. */
export function regexScorer(opts: RegexScorerOptions): RewardScorer {
    return (traj: Trajectory): number => {
        let rx: RegExp;
        try {
            rx = new RegExp(opts.pattern, opts.flags ?? "");
        } catch {
            return 0.0;
        }
        return rx.test(traj.assistantText) ? 1.0 : -1.0;
    };
}

export interface LengthPenaltyScorerOptions {
    targetChars?: number;
    minChars?: number;
    maxChars?: number;
}

/**
 * Penalise responses outside a target window.
 *
 * Returns 1.0 when length matches the target, decaying linearly to
 * -1.0 at the bounds (and clamped to -1.0 outside).
 */
export function lengthPenaltyScorer(
    opts: LengthPenaltyScorerOptions = {}
): RewardScorer {
    const target = opts.targetChars ?? 400;
    const min = opts.minChars ?? 0;
    const max = opts.maxChars ?? 4000;

    return (traj: Trajectory): number => {
        const n = traj.assistantText.length;
        if (n <= 0) return -1.0;
        if (n < min || n > max) return -1.0;
        if (n === target) return 1.0;
        if (n < target) {
            const span = target - min;
            if (span <= 0) return 0.0;
            return 1.0 - 2.0 * ((target - n) / span);
        }
        const span = max - target;
        if (span <= 0) return 0.0;
        return 1.0 - 2.0 * ((n - target) / span);
    };
}

export interface CompositeScorerOptions {
    scorers: RewardScorer[];
    weights?: number[];
    name?: string;
}

/**
 * Weighted blend of multiple scorers, normalised by sum(|weights|).
 *
 * The result stays in roughly [-1, 1] no matter how many components
 * you stack.
 */
export function compositeScorer(opts: CompositeScorerOptions): RewardScorer {
    const scorers = opts.scorers;
    const weights = opts.weights ?? scorers.map(() => 1.0);
    if (weights.length !== scorers.length) {
        throw new Error("compositeScorer: weights length must match scorers");
    }

    return (traj: Trajectory): number => {
        if (scorers.length === 0) return 0.0;
        const totalW = weights.reduce((a, w) => a + Math.abs(w), 0) || 1.0;
        let score = 0.0;
        for (let i = 0; i < scorers.length; i++) {
            score += weights[i] * Number(scorers[i](traj));
        }
        return score / totalW;
    };
}

/**
 * Run a name → scorer mapping and stash results on `traj.rewards`.
 *
 * The returned object is also written to `traj.rewards` (overwriting
 * any pre-existing keys). `traj.reward` is set to the *mean* across
 * components if it isn't already set.
 */
export function scoreAll(
    traj: Trajectory,
    scorers: Record<string, RewardScorer>
): Record<string, number> {
    const results: Record<string, number> = {};
    for (const [name, scorer] of Object.entries(scorers)) {
        results[name] = Number(scorer(traj));
    }
    Object.assign(traj.rewards, results);
    if (traj.reward === null && Object.keys(results).length > 0) {
        const values = Object.values(results);
        traj.reward = values.reduce((a, b) => a + b, 0) / values.length;
    }
    return results;
}
