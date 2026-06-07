/** Minimal repo autopilot foundation (OpenHarness 0.1.9). */

export enum AutopilotPhase {
    IDLE = "idle",
    PLANNING = "planning",
    EXECUTING = "executing",
    VERIFYING = "verifying",
    DONE = "done",
    FAILED = "failed",
}

export interface AutopilotTask {
    id: string;
    goal: string;
    workspace: string;
    phase?: AutopilotPhase;
    plan?: string[];
    notes?: string[];
    metadata?: Record<string, unknown>;
}

export type AutopilotRunner = (task: AutopilotTask) => Promise<Record<string, unknown>>;

export class AutopilotRegistry {
    private runners = new Map<string, AutopilotRunner>();

    register(name: string, runner: AutopilotRunner): void {
        this.runners.set(name, runner);
    }

    get(name: string): AutopilotRunner | undefined {
        return this.runners.get(name);
    }

    listRunners(): string[] {
        return [...this.runners.keys()].sort();
    }
}

export const DEFAULT_AUTOPILOT_REGISTRY = new AutopilotRegistry();
