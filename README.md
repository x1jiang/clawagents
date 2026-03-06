# ClawAgents (TypeScript)

A lean, full-stack agentic protocol. ~2,500 LOC TypeScript. **v5.13.0**

## Quick Start

```bash
npm install git+https://github.com/x1jiang/clawagents.git
```

Create a `.env`:

```env
PROVIDER=gemini
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-3-flash-preview
STREAMING=1
CONTEXT_WINDOW=1000000
MAX_TOKENS=8192
TEMPERATURE=0                      # Model-specific overrides apply (see below)

# Optional: RL-inspired agent improvements
CLAW_TRAJECTORY=1                  # Enable trajectory logging + scoring
CLAW_RETHINK=1                     # Enable consecutive-failure detection
CLAW_LEARN=1                       # Enable PTRL (lessons from past runs)
```

<details>
<summary><strong>OpenAI configuration</strong></summary>

```env
PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5-nano
STREAMING=1
CONTEXT_WINDOW=1000000
MAX_TOKENS=8192
TEMPERATURE=1                      # GPT-5 family requires temperature=1
CLAW_TRAJECTORY=1
CLAW_RETHINK=1
CLAW_LEARN=1
```
</details>

### One-Line Agent

```ts
import { createClawAgent } from "./agent.js";

const agent = await createClawAgent({ model: "gemini-3-flash" });
const result = await agent.invoke("List all TypeScript files in src/");
console.log(result.result);
```

### With Instruction

```ts
const agent = await createClawAgent({
    model: "gpt-5",
    instruction: "You are a code reviewer.",
});
const result = await agent.invoke("Review the code and suggest improvements");
```

### With Trajectory Logging & Rethink

```ts
const agent = await createClawAgent({
    model: "gpt-5-mini",
    trajectory: true,   // logs every turn + scores the run
    rethink: true,       // auto-injects "rethink" after 3 consecutive failures
});
const result = await agent.invoke("Refactor the auth module and add tests");
// Run summary written to .clawagents/trajectories/runs.jsonl
```

### With PTRL (Prompt-Time Reinforcement Learning)

```ts
const agent = await createClawAgent({
    model: "gpt-5-mini",
    learn: true,    // enables all 3 PTRL layers (implies trajectory: true)
    rethink: true,  // enhanced rethink uses past lessons
});
const result = await agent.invoke("Build the data pipeline");
// After the run: lessons extracted and saved to .clawagents/lessons.md
// Next run: lessons injected into system prompt automatically
```

### CLI

```bash
npx tsx src/index.ts --task "Find all TODO comments in the codebase"
```

## API

### `createClawAgent({ model, instruction, ... })`

| Param | Type | Default | Description |
|:---|:---|:---|:---|
| `model` | `string \| LLMProvider` | auto-detect | Model name or provider |
| `instruction` | `string` | `undefined` | What the agent should do / how it should behave |
| `tools` | `Tool[]` | `[]` | Additional tools. Built-in tools always included |
| `skills` | `string \| string[]` | auto-discover | Skill directories. Default: checks `./skills`, `./.skills`, etc. |
| `memory` | `string \| string[]` | auto-discover | Memory files. Default: checks `./AGENTS.md`, `./CLAWAGENTS.md` |
| `streaming` | `boolean` | `true` | Enable streaming |
| `contextWindow` | `number \| undefined` | from env / `1000000` | Token budget for compaction |
| `maxTokens` | `number \| undefined` | from env / `8192` | Max output tokens per response |
| `temperature` | `number \| undefined` | from env / `0.0` | LLM temperature (model-specific overrides apply) |
| `trajectory` | `boolean \| undefined` | from `CLAW_TRAJECTORY` / `false` | Enable trajectory logging + run scoring |
| `rethink` | `boolean \| undefined` | from `CLAW_RETHINK` / `false` | Enable consecutive-failure detection |
| `learn` | `boolean \| undefined` | from `CLAW_LEARN` / `false` | Enable PTRL: post-run self-analysis, pre-run lesson injection, enhanced rethink. Implies `trajectory: true` |
| `maxIterations` | `number \| undefined` | from `MAX_ITERATIONS` / `200` | Max tool rounds before the agent stops |
| `previewChars` | `number \| undefined` | from `CLAW_PREVIEW_CHARS` / `120` | Max chars for tool-output previews in trajectory logs |
| `responseChars` | `number \| undefined` | from `CLAW_RESPONSE_CHARS` / `500` | Max chars for LLM response text in trajectory records |
| `onEvent` | `OnEvent` | `undefined` | Event callback |

### Built-in Tools

Every agent includes these — no setup needed:

| Tool | Description |
|:---|:---|
| `ls` | List directory with size + modified time |
| `read_file` | Read file with line numbers + pagination |
| `write_file` | Write/create file (auto-creates dirs) |
| `edit_file` | Replace text (supports `replace_all`) |
| `grep` | Search — single file or recursive with glob filter |
| `glob` | Find files by pattern (`**/*.ts`) |
| `execute` | Shell command execution |
| `write_todos` | Plan tasks as a checklist |
| `update_todo` | Mark plan items complete |
| `task` | Delegate to a sub-agent with isolated context |
| `use_skill` | Load a skill's instructions (when skills exist) |

### Hooks (Convenience Methods)

```ts
const agent = await createClawAgent({ model: "gemini-3-flash", instruction: "Code reviewer" });

// Block dangerous tools
agent.blockTools("execute", "write_file");

// Or whitelist only safe tools
agent.allowOnlyTools("read_file", "ls", "grep", "glob");

// Inject context into every LLM call
agent.injectContext("Always respond in Spanish");

// Limit tool output size
agent.truncateOutput(3000);
```

**Advanced:** Raw hooks are also available for custom logic:

```ts
agent.beforeLLM = (messages) => messages;           // modify messages before LLM
agent.beforeTool = (name, args) => true;             // return false to block
agent.afterTool = (name, args, result) => result;    // modify tool results
```

## Auto-Discovery

The factory automatically discovers project files:

| What | Default locations checked |
|:---|:---|
| **Memory** | `./AGENTS.md`, `./CLAWAGENTS.md` |
| **Skills** | `./skills`, `./.skills`, `./skill`, `./.skill`, `./Skills` |

Pass explicit paths to override: `memory: "./docs/AGENTS.md"`, `skills: ["./my-skills"]`

## Memory System

### Project Memory
Loads `AGENTS.md` files and injects content into every LLM call. Use for project context.

### Auto-Compaction
When conversation exceeds **75% of `CONTEXT_WINDOW`**:
1. Full history **offloaded** to `.clawagents/history/compacted_*.json`
2. Older messages **summarized** into `[Compacted History]`
3. Last 6 messages kept intact

## Trajectory Logging & RL-Inspired Scoring

Enable with `trajectory: true` or `CLAW_TRAJECTORY=1`. Inspired by [CUDA-Agent](https://github.com/NexaAI/CUDA-Agent) and [OpenClaw-RL](https://github.com/anthropics/openclaw-rl).

### Discrete reward bands

Each run receives a score from **-1 to +3**:

| Score | Meaning |
|:---:|:---|
| **+3** | All tools succeeded, task completed cleanly |
| **+2** | Minor hiccups but overall success |
| **+1** | Partial success with some failures |
| **0** | Inconclusive — mixed results |
| **-1** | Majority of tool calls failed |

### Quality grading

| Quality | Criteria |
|:---|:---|
| `clean` | Score >= 2 and <= 2 mid-run failures |
| `noisy` | Score >= 0 but too many mid-run failures |
| `failed` | Score < 0 |

### Anti-gaming protections

Tools like `think`, `todolist`, `use_skill`, `list_skills`, and `update_todo` are excluded from scoring.

### Consecutive-failure rethink

With `rethink: true` or `CLAW_RETHINK=1`, after **3 consecutive meaningful failures** the agent receives a system "rethink" prompt.

### Output

Run summaries appended to `.clawagents/trajectories/runs.jsonl`:

```json
{
  "run_id": "a1b2c3d4",
  "model": "gpt-5-mini",
  "total_turns": 8,
  "tool_calls": 12,
  "successes": 10,
  "failures": 2,
  "run_score": 2,
  "quality": "clean",
  "elapsed_ms": 45230
}
```

## Environment Variables

| Variable | Default | Description |
|:---|:---|:---|
| `PROVIDER` | auto-detect | `openai` or `gemini` |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENAI_MODEL` | `gpt-5-nano` | OpenAI model |
| `GEMINI_API_KEY` | — | Gemini API key |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | Gemini model |
| `STREAMING` | `1` | `1` = enabled, `0` = disabled |
| `CONTEXT_WINDOW` | `1000000` | Token budget for compaction |
| `MAX_TOKENS` | `8192` | Max output tokens per response (`max_completion_tokens` for OpenAI, `max_output_tokens` for Gemini) |
| `TEMPERATURE` | `0.0` | LLM temperature. Auto-overridden for fixed-temp models (GPT-5 family -> 1.0, o1/o3 series -> 1.0) |
| `CLAW_TRAJECTORY` | `0` | `1` = enable trajectory logging + run scoring |
| `CLAW_RETHINK` | `0` | `1` = enable consecutive-failure rethink injection |
| `CLAW_LEARN` | `0` | `1` = enable PTRL. Post-run lessons saved to `.clawagents/lessons.md`, injected pre-run. Implies `CLAW_TRAJECTORY=1` |
| `MAX_ITERATIONS` | `200` | Max tool rounds before the agent stops |
| `CLAW_PREVIEW_CHARS` | `120` | Max chars for tool-output previews in trajectory logs |
| `CLAW_RESPONSE_CHARS` | `500` | Max chars for LLM response text in trajectory records |

## Changelog

### v5.13.0 — Prompt-Time Reinforcement Learning (PTRL)
- **PTRL: Post-run self-analysis** — LLM reviews its own trajectory and extracts actionable lessons to `.clawagents/lessons.md`
- **PTRL: Pre-run lesson injection** — stored lessons injected into system prompt on subsequent runs
- **PTRL: Enhanced mid-run rethink** — past lessons included in rethink messages during consecutive failures
- **`learn` flag / `CLAW_LEARN` env** — opt-in via `learn: true` or `CLAW_LEARN=1` (implies `trajectory: true`)
- **Default `contextWindow` → 1,000,000** — increased from 128,000 for modern large-context models

### v5.12.1 — Streamlit / Jupyter Compatibility
- Signal handler fix: catches `RuntimeError` for non-main-thread environments (Streamlit, Jupyter)

### v5.12.0 — Gemini 3 Thought Signature Support
- `thought_signature` preservation for Gemini 3 thinking models (prevents 400 errors in multi-turn function calling)
- New `geminiParts` field on `LLMMessage` / `LLMResponse` carries raw Gemini parts through conversation history
- Automatic — no user action required

### v5.11.0 — Configurable Limits
- `maxIterations` / `MAX_ITERATIONS` env (default 200) — max tool rounds
- `previewChars` / `CLAW_PREVIEW_CHARS` env (default 120) — tool-output preview length
- `responseChars` / `CLAW_RESPONSE_CHARS` env (default 500) — response text in trajectory records
- Priority: explicit param > env var > default

### v5.10.0 — Discrete Reward Bands & Weighted Scoring
- Discrete reward bands (-1 to +3) inspired by CUDA-Agent PPO reward shaping
- Weighted execution scoring (`execute`, `shell`, `run_code` weighted 2x)
- Run quality grading (`clean` / `noisy` / `failed`)
- Gameable tool exclusion from scoring

### v5.9.0 — Trajectory Logging & Rethink
- Structured trajectory logging to `runs.jsonl`
- Consecutive-failure rethink injection (opt-in)

### v5.8.0 — JSON Resilience
- `repairJson()` utility for truncated JSON from `max_completion_tokens` limits
- Truncated JSON detection + LLM retry

### v5.7.0 — Model-Specific Temperature
- Fixed-temperature override for GPT-5 family and o1/o3/o4 series
- Configurable `TEMPERATURE` env var + `temperature` parameter

### v5.6.0 — LLM Parameter Fixes
- `max_completion_tokens` for OpenAI (replacing deprecated `max_tokens`)
- `max_output_tokens` for Gemini
- Config priority: explicit param > `.env` > default

### v5.5.0 — Foundation
- Pluggable sandbox backend, Gateway server, Advanced FS tools, Think tool, Skills system

## Testing

```bash
npx tsx --test src/tools/registry.test.ts
```
