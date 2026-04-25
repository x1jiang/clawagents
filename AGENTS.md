# AGENTS.md — clawagents (TypeScript)

Operational guide for AI/automation agents working *on* the `clawagents`
TypeScript codebase. This file mirrors the policy in
`clawagents_py/AGENTS.md`; if you change one, change both.

## 1. Prompt-cache policy

Every long-running agent session relies on the LLM provider's **prompt
prefix cache**. A handful of slash-commands and tools mutate state that lives
in the system prompt (skills, permission mode, persona, model routing, …).
If those mutations apply *immediately*, the cached prefix is invalidated and
the next turn pays the full re-prefill cost. For multi-turn tool runs this
typically dominates latency and cost.

The policy mirrors the one we adopted from Hermes:

- **`cacheImpact: "none"`** — read-only commands. Always safe mid-run.
  Examples: `/help`, `/status`, `/version`, `/tools`, `/models`, `/trace`,
  `/profile`, `/redact`, `/history`.
- **`cacheImpact: "deferred"`** — *default* for any command that mutates
  system-prompt state. The change is staged for the **next session** so the
  current prefix cache survives. Pass `--now` to opt into immediate
  invalidation. Examples: `/plan`, `/accept-edits`, `/default`, `/bypass`,
  and any future `/skills install`, `/model`, `/personality` commands.
- **`cacheImpact: "immediate"`** — commands that *cannot* be deferred
  because they rewrite history or start a fresh context. Examples: `/new`,
  `/clear`, `/compress`, `/undo`.

Implementation lives in `src/commands.ts`:

- `CommandDef.cacheImpact?: CacheImpact` (declared per command; `undefined`
  is treated as `"none"`).
- `ResolvedCommand.applyNow: boolean` (computed by `resolveCommand()`,
  combining `cacheImpact` with the `--now` flag).
- The `--now` token is recognised in any position in the argument list and
  is stripped from `ResolvedCommand.args` so consumers never see it.
- The bare word `now` is **not** a flag, so steer/queue prompts like
  `/q now do the next thing` round-trip cleanly.

When you add a new slash-command or skill that touches system-prompt state,
default to `"deferred"`. Use `"immediate"` only when correctness requires
a cache flush (history rewrites, persona swaps that must take effect on the
very next turn).

## 2. User-facing paths

Tool descriptions and user-visible messages must render configuration paths
through `displayClawagentsHome()` / `displayClawagentsWorkspaceDir()`
instead of hardcoding `~/.clawagents/...`. This keeps the message correct
when the user is on a non-default profile (`CLAWAGENTS_PROFILE`) or has
relocated home (`CLAWAGENTS_HOME`).

```ts
import { displayClawagentsHome } from "clawagents";

const description =
    `Read a memory file from ${displayClawagentsHome()}/memories/`;
```

## 3. Subagent boundaries (do not violate)

- Subagent depth is capped at **2**. The `task` tool refuses to spawn a
  subagent from inside a subagent. This prevents recursive blowup and
  protects the iteration / token budget.
- Subagents run with `skipMemory: true`. They do **not** load the parent's
  memory directory, lessons, or skill state. Pass anything they need
  explicitly via the prompt or a tool argument.
- Agent loops respect a per-agent `IterationBudget` (default 50). The
  delegating agent must reserve at least one iteration for itself.

## 4. Parallel tool execution

The agent loop will run independent read-only tools in parallel when their
**path scopes do not overlap**. Two `read_file` calls on different paths
go in parallel; a `read_file` and `write_file` on overlapping paths do not.
If you add a new tool, declare its path scope with the standard helper so
the scheduler can reason about it; otherwise it will be treated as
"unknown scope" and run serially.

## 5. Tests

Always run the hermetic test entry point before shipping:

```bash
scripts/run_tests.sh
```

This pins the test runner concurrency, scrubs `CLAWAGENTS_*` env vars, and
runs both the unit suite and the typed parity checks against
`../clawagents_py/`. Don't run `npm test` directly when validating a
release — concurrency and env scrubbing matter.

## 6. Plugin hooks

Plugins can implement:

- `preToolCall(name, args)` — return `{ veto: true, reason: "..." }` to
  block a call. Thrown errors are also caught and surfaced as veto reasons.
- `postToolCall(name, args, result)` — observation only.
- `transformToolResult(name, args, result)` — *return* a replacement
  result (or `undefined` to leave it unchanged). Use this for redaction,
  summarisation, or schema migration.

`preToolCall` runs first, then the tool itself, then `transformToolResult`,
then `postToolCall`. Hooks must be deterministic-ish; if a hook is slow,
the entire agent loop is slow.
