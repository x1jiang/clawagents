/**
 * Adapter wrappers for TRL and Atropos.
 *
 * Unlike Python, TRL and Atropos don't have first-party Node clients —
 * the canonical workflow from a TypeScript agent is:
 *
 *   1. Capture trajectories with {@link RLRecorder}.
 *   2. Export them as JSONL (TRL-SFT, TRL-DPO, or Atropos rollout shape).
 *   3. Hand the JSONL to a Python trainer, *or* submit Atropos rollouts
 *      over HTTP to a running collector.
 *
 * These adapters wrap that workflow into a discoverable API. For
 * Atropos, {@link AtroposAdapter.submit} can post rollouts to any
 * endpoint exposing `POST /rollouts`, or it accepts a user-provided
 * sink function for tests / custom transports.
 *
 * Mirrors `clawagents.rl.adapters` on the Python side.
 */

import {
    exportAtroposRolloutsJsonl,
    exportTrlSftJsonl,
    toAtroposRollout,
    toTrlDpo,
    toTrlSft,
} from "./export.js";
import { Trajectory } from "./trajectory.js";

/**
 * `true` when running in a Node-like environment with `fetch`. Used by
 * {@link AtroposAdapter} to decide whether HTTP submission is possible.
 */
export const FETCH_AVAILABLE: boolean = typeof globalThis.fetch === "function";

/**
 * Reserved for symmetry with Python: TS doesn't import `trl` directly
 * because TRL is Python-only. We always expose the JSONL builders.
 */
export const TRL_AVAILABLE: boolean = true;

/**
 * `true` when an HTTP-capable runtime is available — the only
 * mechanism by which a Node-side adapter can talk to Atropos.
 */
export const ATROPOS_AVAILABLE: boolean = FETCH_AVAILABLE;

/**
 * Produces TRL-shaped JSONL files (or in-memory rows) from
 * trajectories. The actual training happens in Python; this adapter
 * writes the dataset.
 */
export class TrlAdapter {
    /** Materialise SFT rows for downstream `Dataset.from_list(...)`. */
    buildSftRows(trajectories: Iterable<Trajectory>): Array<Record<string, unknown>> {
        return Array.from(trajectories, (t) => toTrlSft(t));
    }

    /** Materialise DPO rows for downstream `DPOTrainer`. */
    buildDpoRows(
        pairs: Iterable<[Trajectory, Trajectory]>
    ): Array<Record<string, unknown>> {
        return Array.from(pairs, ([c, r]) => toTrlDpo(c, r));
    }

    /** Write SFT rows to a JSONL file. Returns the number of rows. */
    writeSftJsonl(
        trajectories: Iterable<Trajectory>,
        filePath: string
    ): number {
        return exportTrlSftJsonl(trajectories, filePath);
    }
}

/** Sink that receives a single Atropos rollout payload. */
export type AtroposSink = (rollout: Record<string, unknown>) => Promise<void> | void;

export interface AtroposSubmitOptions {
    /** Custom sink — bypasses HTTP. */
    sink?: AtroposSink;
    /** HTTP endpoint accepting `POST` of one rollout per request. */
    url?: string;
    /** Optional headers to attach to every HTTP submission. */
    headers?: Record<string, string>;
    /** Stop on first failure (default true). */
    stopOnError?: boolean;
}

/**
 * Streams trajectories into an Atropos rollout collector.
 *
 * If neither `url` nor `sink` is supplied, the adapter just produces
 * rollout dicts (useful when the caller wants to handle transport
 * itself).
 */
export class AtroposAdapter {
    /** Convert trajectories to Atropos rollout dicts (no transport). */
    toRollouts(trajectories: Iterable<Trajectory>): Array<Record<string, unknown>> {
        return Array.from(trajectories, (t) => toAtroposRollout(t));
    }

    /**
     * Push rollouts at a sink (custom or HTTP). Returns the number
     * submitted. If a network error occurs, the adapter stops and
     * throws (or skips, when `stopOnError: false`).
     */
    async submit(
        trajectories: Iterable<Trajectory>,
        opts: AtroposSubmitOptions = {}
    ): Promise<number> {
        const stopOnError = opts.stopOnError ?? true;
        const rollouts = this.toRollouts(trajectories);

        const sink: AtroposSink = await this.resolveSink(opts);

        let n = 0;
        for (const r of rollouts) {
            try {
                await sink(r);
                n += 1;
            } catch (err) {
                if (stopOnError) throw err;
            }
        }
        return n;
    }

    /** Write rollouts to a JSONL file. Returns the number of rows. */
    writeJsonl(
        trajectories: Iterable<Trajectory>,
        filePath: string
    ): number {
        return exportAtroposRolloutsJsonl(trajectories, filePath);
    }

    private async resolveSink(opts: AtroposSubmitOptions): Promise<AtroposSink> {
        if (opts.sink) return opts.sink;
        if (opts.url) {
            if (!FETCH_AVAILABLE) {
                throw new Error(
                    "AtroposAdapter.submit: HTTP submission requires global fetch"
                );
            }
            const url = opts.url;
            const headers = {
                "content-type": "application/json",
                ...(opts.headers ?? {}),
            };
            return async (rollout) => {
                const res = await globalThis.fetch(url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(rollout),
                });
                if (!res.ok) {
                    throw new Error(
                        `AtroposAdapter: POST ${url} failed: ${res.status} ${res.statusText}`
                    );
                }
            };
        }
        // No sink and no URL: caller probably wanted `toRollouts` instead.
        throw new Error(
            "AtroposAdapter.submit: provide either `sink` or `url` " +
                "(or call `toRollouts` to get the payloads without submitting)"
        );
    }
}
