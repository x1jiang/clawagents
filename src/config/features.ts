/**
 * Feature flags for ClawAgents.
 *
 * Inspired by Claude Code's build-time feature() system — but runtime-based
 * so features can be toggled via environment variables without rebuilding.
 *
 * Usage:
 *   import { isEnabled } from "./config/features.js";
 *   if (isEnabled("micro_compact")) { ... }
 */

// ─── Feature Registry ─────────────────────────────────────────────────────
// Each feature maps to an env var. Default values control whether the feature
// is opt-in (default "0") or opt-out (default "1").

const FEATURE_DEFAULTS: Record<string, string> = {
    // Quick wins — enabled by default
    micro_compact:        "1",   // Clear old tool result content aggressively
    file_snapshots:       "1",   // Snapshot files before write tools modify them
    cache_tracking:       "0",   // Log prompt cache hit rates from API responses

    // Medium effort — opt-in
    typed_memory:         "0",   // Parse frontmatter in memory files for type-based recall
    wal:                  "0",   // Write-ahead logging for crash recovery
    permission_rules:     "0",   // Declarative tool permission rules
    background_memory:    "0",   // Continuous memory extraction every N turns

    // New features (inspired by claw-code-main)
    cache_boundary:       "1",   // Prompt cache boundary optimization for Anthropic
    session_persistence:  "0",   // Session persistence + resume
    error_taxonomy:       "1",   // Structured error classification + recovery recipes
    external_hooks:       "0",   // External shell hook system

    // Complex — opt-in
    forked_agents:        "0",   // Background forked agent pattern
    coordinator:          "0",   // Coordinator/swarm orchestration mode
};

const ENV_PREFIX = "CLAW_FEATURE_";

function resolveFeatures(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const [name, defaultVal] of Object.entries(FEATURE_DEFAULTS)) {
        const envKey = ENV_PREFIX + name.toUpperCase();
        const envVal = process.env[envKey];
        const StringVal = (envVal === undefined || envVal === "") ? defaultVal : envVal;
        result[name] = ["1", "true", "yes", "on"].includes(StringVal.toLowerCase());
    }
    return result;
}

// Lazy singleton — resolved once on first access
let _resolved: Record<string, boolean> | null = null;

function getFeatures(): Record<string, boolean> {
    if (!_resolved) {
        _resolved = resolveFeatures();
    }
    return _resolved;
}

/** Check if a feature flag is enabled. */
export function isEnabled(feature: string): boolean {
    return getFeatures()[feature] ?? false;
}

/** Return a copy of all feature flags and their current state. */
export function allFeatures(): Record<string, boolean> {
    return { ...getFeatures() };
}

/** Reset cached features (useful for testing). */
export function resetFeatures(): void {
    _resolved = null;
}

/** Explicitly override feature flags (useful for constructor injection). */
export function setOverrides(overrides: Record<string, boolean>): void {
    if (!_resolved) {
        _resolved = resolveFeatures();
    }
    for (const [k, v] of Object.entries(overrides)) {
        _resolved[k] = Boolean(v);
    }
}
