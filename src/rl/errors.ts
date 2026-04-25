/**
 * Errors raised by the ClawAgents RL fine-tuning adapter.
 */

export class RLError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RLError";
    }
}

/**
 * Thrown when an optional training-framework dependency isn't installed.
 *
 * The TRL / Atropos adapters are intentionally lazy — importing
 * `clawagents/rl` never imports a training framework. We only probe for
 * one when the user actually invokes `adapter.buildSftDataset(...)` or
 * similar, and raise this error if it's missing.
 */
export class MissingRLDependencyError extends RLError {
    public readonly framework: string;
    public readonly installHint: string;

    constructor(framework: string, installHint: string) {
        super(
            `clawagents/rl: optional dependency for '${framework}' is not ` +
                `installed. Install it with: ${installHint}`
        );
        this.name = "MissingRLDependencyError";
        this.framework = framework;
        this.installHint = installHint;
    }
}
