#!/usr/bin/env bash
# Canonical test runner for clawagents (TypeScript) — pattern learned from
# hermes-agent's hermetic pytest runner. Run this instead of `npm test`
# when you want a deterministic environment that matches CI behavior.
#
# What this script enforces:
#   * Pinned node:test concurrency (fixed across CI and local)
#   * TZ=UTC, LANG=C.UTF-8 (deterministic clocks and locale-sensitive paths)
#   * Credential env vars blanked (belt-and-suspenders for any tool reading
#     them at import time)
#   * Stable test file list — sourced from package.json's `test` script when
#     positional args are not provided
#
# Usage:
#   scripts/run_tests.sh                              # full suite
#   scripts/run_tests.sh src/handoffs.test.ts         # a single file
#   scripts/run_tests.sh src/tools/                   # one directory
#
# Override worker count: CLAW_TEST_WORKERS=2 scripts/run_tests.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Hermetic environment ────────────────────────────────────────────────────
while IFS='=' read -r name _; do
    case "$name" in
        *_API_KEY|*_TOKEN|*_SECRET|*_PASSWORD|*_CREDENTIALS|*_ACCESS_KEY| \
        *_SECRET_ACCESS_KEY|*_PRIVATE_KEY|*_OAUTH_TOKEN|*_WEBHOOK_SECRET| \
        *_ENCRYPT_KEY|*_APP_SECRET|*_CLIENT_SECRET|*_AES_KEY| \
        AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN| \
        GH_TOKEN|GITHUB_TOKEN)
            unset "$name"
            ;;
    esac
done < <(env)

for name in $(env | grep -E '^(CLAW|CLAWAGENTS)_' | cut -d= -f1 || true); do
    unset "$name" || true
done

export TZ=UTC
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export NODE_ENV=test

# Pin node:test concurrency. Without this, --test-concurrency defaults to the
# host's CPU count and exposes ordering flakes that 2-CPU CI never sees.
WORKERS="${CLAW_TEST_WORKERS:-4}"

cd "$REPO_ROOT"

# ── Resolve test target list ────────────────────────────────────────────────
if [ "$#" -gt 0 ]; then
    TARGETS=("$@")
else
    # Mirror the canonical test set from package.json's `test` script. Keep
    # this list aligned with package.json so CI and `scripts/run_tests.sh`
    # cover the same files.
    TARGETS=(
        src/corner_cases.test.ts
        src/tools_comprehensive.test.ts
        src/interface.test.ts
        src/gemini_thought_signature.test.ts
        src/malformed_fn_call.test.ts
        src/redact.test.ts
        src/commands.test.ts
        src/steer.test.ts
        src/paths.test.ts
        src/aux-models.test.ts
        src/transport.test.ts
        src/memory/compaction.test.ts
        src/background.test.ts
        src/tools/registry.test.ts
        src/tools/registry.integration.test.ts
        src/tools/subagent.test.ts
        src/tools/web.test.ts
        src/tools/ask-user-question.test.ts
        src/tools/exec-safety-v2.test.ts
        src/media/images.test.ts
        src/settings/resolver.test.ts
        src/testing/mock-provider.test.ts
        src/tracing/tracing.test.ts
        src/mcp/mcp.test.ts
        src/mcp/env-scrub.test.ts
        src/handoffs.test.ts
        tests/simulated.test.ts
    )
fi

echo "▶ running node:test via tsx with $WORKERS workers, hermetic env, in $REPO_ROOT"
echo "  (TZ=UTC LANG=C.UTF-8 NODE_ENV=test; CLAW_*/credential vars unset)"

exec npx tsx --test --test-concurrency="$WORKERS" "${TARGETS[@]}"
