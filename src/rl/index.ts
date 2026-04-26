/**
 * Reinforcement-learning fine-tuning hooks for ClawAgents.
 *
 * This module layers on top of the agent's event stream to expose
 * runs as training data for RL/SFT/DPO pipelines (TRL, Atropos,
 * SLIME). It is intentionally hermetic: nothing here imports a
 * training framework — the relevant adapters either produce JSONL
 * (for downstream Python trainers) or submit over HTTP.
 *
 * Mirrors `clawagents.rl` on the Python side.
 *
 * Typical workflow:
 * ```ts
 * const rec = new RLRecorder({ task: "solve x^2 = 16" });
 * agent.onEvent = (kind, payload) => rec.observe(kind, payload);
 * const answer = await agent.run("solve x^2 = 16");
 *
 * const traj = rec.finalise({ prompt: "solve x^2 = 16", final: answer });
 * traj.reward = containsScorer({ needles: ["x = 4"] })(traj);
 *
 * exportJsonl([traj], "runs.jsonl");
 * ```
 */

export { MissingRLDependencyError, RLError } from "./errors.js";

export type {
    NextStateTransition,
    ToolCall,
    TrajectoryRole,
    TrajectoryStep,
} from "./trajectory.js";
export {
    Trajectory,
    toNextStateTransitions,
    stepFromJson,
    stepToJson,
    toolCall,
    toolCallFromJson,
    toolCallToJson,
    trajectoryStep,
} from "./trajectory.js";

export type { RecorderConfig } from "./recorder.js";
export { RLRecorder } from "./recorder.js";

export type {
    CompositeScorerOptions,
    ContainsScorerOptions,
    ExactMatchScorerOptions,
    LengthPenaltyScorerOptions,
    RegexScorerOptions,
    RewardScorer,
} from "./scorers.js";
export {
    compositeScorer,
    containsScorer,
    exactMatchScorer,
    lengthPenaltyScorer,
    regexScorer,
    scoreAll,
} from "./scorers.js";

export {
    exportAtroposRolloutsJsonl,
    exportJsonl,
    exportTrlSftJsonl,
    loadJsonl,
    toAtroposRollout,
    toChatML,
    toTrlDpo,
    toTrlSft,
} from "./export.js";

export type { AtroposSink, AtroposSubmitOptions } from "./adapters.js";
export {
    ATROPOS_AVAILABLE,
    AtroposAdapter,
    FETCH_AVAILABLE,
    TRL_AVAILABLE,
    TrlAdapter,
} from "./adapters.js";
