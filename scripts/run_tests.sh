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
WORKERS="${CLAW_TEST_WORKERS:-4}"

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

cd "$REPO_ROOT"

# ── Resolve test target list ────────────────────────────────────────────────
RUN_SURFACES=0
if [ "$#" -gt 0 ]; then
    TARGETS=("$@")
else
    TARGETS=()
    while IFS= read -r target; do
        TARGETS+=("$target")
    done < <(node -e '
const script = require("./package.json").scripts.test;
const parts = script.trim().split(/\s+/);
const start = parts[1] === "--test" ? 2 : 1;
for (const target of parts.slice(start)) console.log(target);
')
    RUN_SURFACES=1
fi

echo "▶ running node:test via tsx with $WORKERS workers, hermetic env, in $REPO_ROOT"
echo "  (TZ=UTC LANG=C.UTF-8 NODE_ENV=test; CLAW_*/credential vars unset)"

npx tsx --test --test-concurrency="$WORKERS" "${TARGETS[@]}"
if [ "$RUN_SURFACES" = "1" ]; then
    npx tsx tests/openai_agents_surfaces.test.ts
fi
