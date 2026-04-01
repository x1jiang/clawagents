# ClawAgents (TypeScript)

A lean, full-stack agentic protocol. ~2,500 LOC TypeScript. **v5.27.0**

## Installation

```bash
npm install git+https://github.com/x1jiang/clawagents.git
```

---

## 30-Second Quick Start

### 1. Set up `.env`

A ready-to-use template is included in the repo:

```bash
cp .env.example .env   # then fill in your API key
```

Or create one manually:

```env
PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5-mini
STREAMING=1
```

### Where does `.env` go?

ClawAgents loads `.env` from **the directory you run the command from** (your current working directory).

```
~/my-project/
├── .env              ← ClawAgents reads this when you run from ~/my-project/
├── run.ts
├── AGENTS.md
└── src/
```

**Four ways to configure** (in priority order):

1. **`createClawAgent()` parameters** — highest priority, overrides everything
2. **Shell environment variables** — `export OPENAI_API_KEY=sk-...` in `~/.zshrc` (works globally)
3. **`CLAWAGENTS_ENV_FILE`** — set this env var to point to an explicit `.env` file path (useful for CI/Docker/multi-project)
4. **`.env` file** — project-level config, loaded from `cwd/.env` or `cwd/../.env`

### 2. Run

```ts
import { createClawAgent } from "clawagents";

const agent = await createClawAgent({ model: "gpt-5-mini" });
const result = await agent.invoke("List all TypeScript files in src/");
console.log(result.result);
```

Save as `run.ts` and execute:

```bash
npx tsx run.ts
```

### Examples

See the [`examples/`](examples/) directory for ready-to-run scripts:

| File | Provider |
|:---|:---|
| [`01_openai.ts`](examples/01_openai.ts) | OpenAI (GPT-5, GPT-4o) |
| [`02_gemini.ts`](examples/02_gemini.ts) | Google Gemini |
| [`03_azure.ts`](examples/03_azure.ts) | Azure OpenAI |
| [`04_local_ollama.ts`](examples/04_local_ollama.ts) | Ollama (local) |
| [`05_compare_samples.ts`](examples/05_compare_samples.ts) | Multi-sample comparison |

Run any example with: `npx tsx examples/01_openai.ts`

---

## Configuration

### `.env` file

```env
PROVIDER=gemini                    # or "openai"
GEMINI_API_KEY=AIza...             # Your Gemini API key
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
TEMPERATURE=0                      # 0 for deterministic output
CLAW_TRAJECTORY=1
CLAW_RETHINK=1
CLAW_LEARN=1
```
</details>

---

## Usage Patterns

### With custom instructions

```ts
import { createClawAgent } from "clawagents";

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

### Azure OpenAI

```ts
const agent = await createClawAgent({
    model: "gpt-4o",
    apiKey: "your-azure-key",
    baseUrl: "https://myresource.openai.azure.com/",
    apiVersion: "2024-12-01-preview",
    learn: true,
});
```

### AWS Bedrock (via gateway)

```ts
const agent = await createClawAgent({
    model: "anthropic.claude-3-sonnet-20240229-v1:0",
    baseUrl: "http://localhost:8080/v1",
    apiKey: "bedrock",
});
```

### Local Models (Ollama / vLLM / LM Studio)

```ts
// Ollama
const agent = await createClawAgent({
    model: "llama3.1",
    baseUrl: "http://localhost:11434/v1",
});

// vLLM
const agent = await createClawAgent({
    model: "Qwen/Qwen3-8B",
    baseUrl: "http://localhost:8000/v1",
});
```

> **Tip:** For local models that emit `<think>...</think>` tokens (Qwen3, DeepSeek), thinking content is automatically detected, stripped from output, and preserved in trajectory records.

### Multi-Sample Comparison (GRPO-inspired)

```ts
const agent = await createClawAgent({ model: "gpt-5-mini", learn: true });
const result = await agent.compare("Fix the bug in app.ts", 3);
console.log(result.bestResult);  // best answer
console.log(result.bestScore);   // objective score
```

### CLI

```bash
# Check your configuration
npx tsx src/index.ts --doctor

# Run a task directly
npx tsx src/index.ts --task "Find all TODO comments in the codebase"

# Inspect past run trajectories
npx tsx src/index.ts --trajectory        # last run
npx tsx src/index.ts --trajectory 5      # last 5 runs

# Start the gateway server
npx tsx src/index.ts --port 3000

# Show all options
npx tsx src/index.ts --help
```

### Typical First-Time Flow

```bash
npm install git+https://github.com/x1jiang/clawagents.git   # 1. Install
cp .env.example .env                                         # 2. Create config
# edit .env with your API key                                # 3. Configure
npx tsx src/index.ts --doctor                                # 4. Verify setup
npx tsx src/index.ts --task "hello world"                    # 5. Run first task
```

### CLI Reference

| Command | Description |
|:---|:---|
| `--doctor` | Check configuration health: `.env` discovery, API keys, active model, LLM settings, PTRL flags, local endpoint reachability, trajectory history. |
| `--task "..."` | Run a single task. Prints a startup banner (`provider=X model=Y env=Z ptrl=...`), executes the agent, prints the result. |
| `--trajectory [N]` | Inspect the last N run summaries (default: 1). Shows score, quality, failures, judge verdict. Requires `CLAW_TRAJECTORY=1`. |
| `--port N` | Start the HTTP gateway server on port N (default: 3000). |
| `--help` | Show all options with examples. |

---

## API

### `createClawAgent({ model, instruction, ... })`

All parameters are **optional** — zero-config usage (`createClawAgent()`) works if you have a `.env` with at least one API key.

**Model & Provider**

| Param | Type | Default | Required? | Description |
|:---|:---|:---|:---:|:---|
| `model` | `string \| LLMProvider` | auto-detect | No | Model name (e.g. `"gpt-5-mini"`, `"gemini-3-flash"`, `"llama3.1"`), a pre-built `LLMProvider`, or omit to auto-detect from env |
| `apiKey` | `string` | `undefined` | No | API key. Auto-routed to OpenAI or Gemini based on model name. Falls back to `OPENAI_API_KEY` / `GEMINI_API_KEY` env vars. For local models: omit entirely |
| `baseUrl` | `string` | `undefined` | No | Custom endpoint for OpenAI-compatible APIs: **Azure**, **Bedrock gateway**, **Ollama**, **vLLM**, **LM Studio**. Falls back to `OPENAI_BASE_URL` env. Omit for `api.openai.com` |
| `apiVersion` | `string` | `undefined` | No | **Azure only.** API version (e.g. `"2024-12-01-preview"`). Falls back to `OPENAI_API_VERSION` env. Ignored by other providers |

**Agent Behavior**

| Param | Type | Default | Required? | Description |
|:---|:---|:---|:---:|:---|
| `instruction` | `string` | `undefined` | No | System prompt — what the agent should do and how to behave |
| `tools` | `Tool[]` | `[]` | No | Additional tools. Built-in tools (filesystem, exec, grep, etc.) always included |
| `skills` | `string \| string[]` | auto-discover | No | Skill directories. Default: checks `./skills`, `./.skills`. Bundled skills (ByteRover, OpenViking) are always included when eligible. |
| `memory` | `string \| string[]` | auto-discover | No | Memory files. Default: checks `./AGENTS.md`, `./CLAWAGENTS.md` |
| `streaming` | `boolean` | `true` | No | Enable streaming responses |
| `useNativeTools` | `boolean` | `true` | No | Use provider native function calling. `false` = text-based JSON tool calls |
| `onEvent` | `OnEvent` | `undefined` | No | Callback for agent events (tool calls, errors, context messages, etc.) |

**LLM Tuning**

| Param | Type | Default | Required? | Description |
|:---|:---|:---|:---:|:---|
| `contextWindow` | `number` | env `CONTEXT_WINDOW` / `1000000` | No | Token budget. Older turns compacted when exceeded |
| `maxTokens` | `number` | env `MAX_TOKENS` / `8192` | No | Max output tokens per LLM response |
| `temperature` | `number` | env `TEMPERATURE` / `0.0` | No | Sampling temperature. Auto-overridden for reasoning models (o-series, gpt-5/gpt-5-mini/gpt-5-turbo → 1.0). Non-reasoning models (gpt-5-nano, gpt-5-micro, gpt-4o) respect configured value |
| `maxIterations` | `number` | env `MAX_ITERATIONS` / `200` | No | Max tool rounds before the agent stops |

**PTRL & Trajectory**

| Param | Type | Default | Required? | Description |
|:---|:---|:---|:---:|:---|
| `trajectory` | `boolean` | env `CLAW_TRAJECTORY` / `false` | No | Enable trajectory logging + run scoring |
| `rethink` | `boolean` | env `CLAW_RETHINK` / `false` | No | Enable consecutive-failure detection + adaptive rethink |
| `learn` | `boolean` | env `CLAW_LEARN` / `false` | No | Enable full PTRL: lessons, LLM-as-Judge, thinking token preservation. Implies `trajectory: true` |
| `previewChars` | `number` | env `CLAW_PREVIEW_CHARS` / `120` | No | Max chars for tool-output previews in trajectory logs |
| `responseChars` | `number` | env `CLAW_RESPONSE_CHARS` / `500` | No | Max chars for LLM response text in trajectory records |

> **Priority:** Explicit parameter > environment variable > default value. You never need to set both.

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
| **Skills** | `./skills`, `./.skills`, `./skill`, `./.skill`, `./Skills`. Bundled skills are auto-included based on eligibility (see below). |

### Bundled Skills

ClawAgents ships with two complementary bundled skills that work together:

| Skill | Purpose | Prerequisite | Auto-enabled? |
|:---|:---|:---|:---:|
| **[ByteRover](https://clawhub.ai/byteroverinc/byterover)** | **Write** decisions, patterns, and rules to local Markdown files | npm installs `byterover-cli` as optional dep (so `brv` is on PATH from project root) | Always |
| **[OpenViking](https://github.com/volcengine/OpenViking)** | **Read** context from repos, docs, and large knowledge bases with tiered L0/L1/L2 loading | `pip install openviking` + running `openviking-server` | Only when `ov` CLI is on PATH |

**How they complement each other:**

- **ByteRover** is a fast, serverless notebook for the agent. Use `brv curate` to persist decisions ("We chose Postgres for ACID compliance") and `brv query` to recall them. No infrastructure needed — context is stored as Markdown in `.brv/context-tree/`.
- **OpenViking** is a structured context database. Use `ov add-resource` to ingest entire repos or doc sites, then `ov find` for semantic search across all indexed content. Results are organized in a virtual filesystem (`viking://`) with three tiers: **L0** (abstract, ~100 tokens), **L1** (overview, ~2k tokens), **L2** (full content) — the agent loads only what it needs, saving tokens.

**Typical workflow:** OpenViking **retrieves** context → agent works on the task → ByteRover **curates** the decisions made.

**OpenViking prerequisites:**
1. Install: `pip install openviking --upgrade`
2. Configure: create `~/.openviking/ov.conf` with embedding model and VLM settings (see [OpenViking docs](https://github.com/volcengine/OpenViking))
3. Start server: `openviking-server`
4. The `ov` CLI must be on your PATH — the skill auto-enables when detected

Pass explicit paths to override: `memory: "./docs/AGENTS.md"`, `skills: ["./my-skills"]`

## Memory System

### Project Memory
Loads `AGENTS.md` files and injects content into every LLM call. Use for project context.

### Auto-Compaction
When conversation exceeds **75% of `CONTEXT_WINDOW`**:
1. Full history **offloaded** to `.clawagents/history/compacted_*.json`
2. Older messages **summarized** into `[Compacted History]`
3. Last 20 messages kept intact

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

All environment variables are **optional**. They serve as defaults when the corresponding `createClawAgent()` parameter is not provided. Explicit parameters always take priority.

**General**

| Variable | Default | Required? | Description |
|:---|:---|:---:|:---|
| `CLAWAGENTS_ENV_FILE` | *(unset)* | No | Explicit path to a `.env` file. Overrides default `cwd/.env` discovery. Useful for CI, Docker, or multi-project setups |

**Provider & Model** — set at least one API key (or `OPENAI_BASE_URL` for local models)

| Variable | Default | Required? | Description |
|:---|:---|:---:|:---|
| `PROVIDER` | auto-detect | No | Hint: `"openai"` or `"gemini"`. Auto-detected from which API key is set |
| `OPENAI_API_KEY` | — | **Yes** *(OpenAI/Azure)* | API key. **Not needed for local models** — auto-placeholder when `OPENAI_BASE_URL` is set |
| `OPENAI_MODEL` | `gpt-5-nano` | No | Model name, Azure deployment name, or local model ID |
| `OPENAI_BASE_URL` | *(unset)* | No | Custom endpoint: Azure, Bedrock gateway, Ollama, vLLM, LM Studio. Omit for `api.openai.com` |
| `OPENAI_API_VERSION` | *(unset)* | No | **Azure only.** API version (e.g. `2024-12-01-preview`) |
| `GEMINI_API_KEY` | — | **Yes** *(Gemini)* | Google Gemini API key |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | No | Gemini model name |

**LLM Tuning**

| Variable | Default | Required? | Description |
|:---|:---|:---:|:---|
| `STREAMING` | `1` | No | `1` = enabled, `0` = disabled |
| `CONTEXT_WINDOW` | `1000000` | No | Token budget for compaction |
| `MAX_TOKENS` | `8192` | No | Max output tokens per response |
| `TEMPERATURE` | `0.0` | No | Sampling temperature. Auto-overridden for fixed-temp models |
| `MAX_ITERATIONS` | `200` | No | Max tool rounds before the agent stops |

**PTRL & Trajectory Flags** — all off by default, opt-in with `1`/`true`/`yes`

| Variable | Default | Required? | Description |
|:---|:---|:---:|:---|
| `CLAW_TRAJECTORY` | `0` | No | Enable trajectory logging + run scoring |
| `CLAW_RETHINK` | `0` | No | Enable consecutive-failure detection + adaptive rethink |
| `CLAW_LEARN` | `0` | No | Enable full PTRL: lessons, Judge, thinking tokens. Implies `CLAW_TRAJECTORY=1` |
| `CLAW_PREVIEW_CHARS` | `120` | No | Max chars for tool-output previews in trajectory logs |
| `CLAW_RESPONSE_CHARS` | `500` | No | Max chars for LLM response text in trajectory records |

**Claude Code Features** — mostly off by default, opt-in with `1`/`true`/`yes`

| Variable | Default | Required? | Description |
|:---|:---|:---:|:---|
| `CLAW_FEATURE_MICRO_COMPACT` | `1` | No | Aggressively clear old tool result contents to save context |
| `CLAW_FEATURE_FILE_SNAPSHOTS` | `1` | No | Safely copy files to `.clawagents/snapshots/` before writing |
| `CLAW_FEATURE_CACHE_TRACKING` | `0` | No | Extract and log detailed Anthropic/OpenAI prompt cache stats |
| `CLAW_FEATURE_TYPED_MEMORY` | `0` | No | Parse YAML frontmatter in `AGENTS.md` to classify memory types |
| `CLAW_FEATURE_WAL` | `0` | No | Persistent Write-Ahead Logging to `.clawagents/wal.jsonl` (crash recovery) |
| `CLAW_FEATURE_PERMISSION_RULES` | `0` | No | Enforce declarative glob-based `Allow`/`Deny` execution bounds |
| `CLAW_FEATURE_BACKGROUND_MEMORY` | `0` | No | Background thread extracting agent state/metadata implicitly |
| `CLAW_FEATURE_FORKED_AGENTS` | `0` | No | Enable the `run_forked_agent` sandboxed sub-agent API |
| `CLAW_FEATURE_COORDINATOR` | `0` | No | Enable the `run_coordinator` swarm routing orchestration mode |

## Changelog

### v5.27.0 — Claude Code Architectural Patterns

Ported 10 production-grade architectural patterns from Anthropic's Claude Code directly into ClawAgents. These features are controllable via environment variables or constructor injection:

| Feature | Description |
|:---|:---|
| **Micro-Compact Memory** | Aggressively clears giant tool results to save context. |
| **File History Snapshots** | Safely backs up files to `.clawagents/snapshots/` before writing. |
| **Prompt Cache Tracking** | Real-time stats on Anthropic/OpenAI prompt cache hits. |
| **Typed Memory Taxonomy** | Auto-parses `project`, `user`, and `feedback` memories via frontmatter. |
| **Write-Ahead Logging (WAL)** | Crash-resilient interaction logging. |
| **Granular Permission Rules** | Define glob-based `Allow`/`Deny` execution policies. |
| **Background Memory Extraction** | Periodically scans conversations and extracts metadata. |
| **Orchestration** | Access to `run_forked_agent` and `run_coordinator` (swarm routing). |

### v5.26.0 — Bundled OpenViking Skill, Updated ByteRover Skill

| Feature | Description |
|:---|:---|
| **OpenViking skill** | Bundled `skills/openviking/SKILL.md` teaches the agent to use the `ov` CLI for tiered context retrieval (L0/L1/L2). Auto-enabled when `ov` is on PATH |
| **ByteRover skill updated** | Refreshed to match `byterover-cli` v1.8.0 — added `--headless`, `--folder`, removed obsolete commands |
| **Generic bundled skill loader** | Skill loader now scans the entire bundled `skills/` directory instead of hardcoding individual skills |

### v5.25.0 — Gemini Streaming Fix

| Feature | Description |
|:---|:---|
| **Fix Gemini SDK warning** | Eliminated "non-text parts in the response" warning by iterating `candidates[].content.parts[]` instead of accessing the `.text` property on streaming chunks containing function calls |
| **Consistent text extraction** | Streaming path now uses the same parts-based extraction as the non-streaming `requestOnce`, filtering out thought parts |

### v5.24.0 — Zero-Config Channel Auto-Detection

| Feature | Description |
|:---|:---|
| **Auto-detect channels from env vars** | Gateway now reads `TELEGRAM_BOT_TOKEN`, `WHATSAPP_AUTH_DIR`, `SIGNAL_ACCOUNT` from env and auto-starts the ChannelRouter — zero code required |
| **`--doctor` channel status** | Doctor command reports which messaging channels are configured |
| **`.env.example` updated** | All channel env vars documented with inline comments |

### v5.23.0 — WebSocket Gateway, Multi-Channel Messaging (Telegram, WhatsApp, Signal)

Full multi-platform messaging support inspired by OpenClaw's channel architecture:

| Feature | Description |
|:---|:---|
| **WebSocket gateway** | JSON-RPC-over-WS endpoint at `/ws` alongside existing HTTP. Methods: `chat.send` (streaming events), `chat.history`, `chat.inject`, `ping`. Auth via `?token=` query param |
| **Channel adapter interface** | `ChannelAdapter` / `ChannelMessage` types — standard contract for any messaging platform. Implement `start()`, `stop()`, `send()`, set `onMessage` callback |
| **Telegram adapter** | Uses [grammY](https://grammy.dev/) for Bot API. Config: `{ botToken: "..." }` |
| **WhatsApp adapter** | Uses [Baileys](https://github.com/WhiskeySockets/Baileys) for multi-device. QR pairing on first run. Config: `{ authDir: ".whatsapp-auth" }` |
| **Signal adapter** | Uses [signal-cli](https://github.com/AsamK/signal-cli) subprocess with JSON-RPC. Config: `{ account: "+1234567890" }` |
| **Channel router** | `ChannelRouter` dispatches inbound messages to agents, routes replies back. Per-session serialization via `KeyedAsyncQueue`, optional debouncer, `onInbound`/`onOutbound`/`onError` hooks |

```ts
import { createClawAgent, ChannelRouter, TelegramAdapter, WhatsAppAdapter } from "clawagents";

const router = new ChannelRouter(() => createClawAgent({ model: "gpt-5-mini" }));
router.register(new TelegramAdapter());
router.register(new WhatsAppAdapter());
await router.startAll({
  telegram: { botToken: "123456:ABC..." },
  whatsapp: { authDir: ".whatsapp-auth" },
});
```

### v5.22.0 — Tool Result Caching, Parameter Validation & ComposeTool

3 features inspired by ToolUniverse's tool management patterns:

| Feature | Description |
|:---|:---|
| **Tool result caching** | LRU in-memory cache (`ResultCacheManager`) avoids redundant tool calls. Tools opt in with `cacheable: true`. Per-tool TTL overrides via `resultCache.setToolTtl()`. Built-in cacheable tools: `read_file`, `grep`, `web_fetch`. Default: 256 entries, 60s TTL |
| **Parameter validation + coercion** | `validateToolArgs()` checks required params and type-matches before execution. Lenient coercion handles common LLM quirks: `"42"` → `42`, `"true"` → `true`, JSON strings → objects/arrays. Enabled by default on `ToolRegistry` |
| **ComposeTool** | `createComposeTool()` chains multiple tools in a deterministic pipeline without an LLM in the loop. Lighter than sub-agents for predictable workflows. Steps receive previous results and a `callTool` helper. Failures short-circuit with clear error messages |

### v5.21.0 — Context Engine, Loop Detection & Compaction Overhaul

8 improvements inspired by the latest OpenClaw architecture:

| Feature | Description |
|:---|:---|
| **Chunked compaction with retry** | Compaction now splits old messages into ~30K-token chunks, summarizes each separately with up to 3 retries (exponential backoff), and explicitly preserves file paths, function names, error messages, and commands verbatim |
| **Better loop detection** | Result hashing detects "different args, same result" stalls; ping-pong detection catches A→B→A→B oscillation; global circuit breaker hard-stops at 30 no-progress calls |
| **Context pruning (soft-trim)** | New `softTrimMessages` runs at 60% context usage (before the 75% compaction trigger). Trims old tool results >1000 chars, removes duplicates, and stubs stale image data |
| **Skill eligibility gating** | Skills can declare `requires:` in YAML frontmatter (`os`, `bins`, `env`). Ineligible skills are filtered at load time |
| **Skill prompt budget** | Max 20 skills / 4000 chars injected into the system prompt. Full list accessible via `list_skills` |
| **Control token sanitization** | Strips leaked model control tokens (`<\|assistant\|>`, `<\|endoftext\|>`, full-width variants) from final output |
| **Head+tail truncation** | Eviction fallback and content preview now use head+tail (preserving error messages at the end). Also fixes a bug where few-line, huge-character content bypassed preview truncation |
| **Pluggable context engine** | New `ContextEngine` interface with `afterTurn`, `compact`, `bootstrap`, `cleanup` lifecycle hooks. `DefaultContextEngine` is a no-op pass-through. Registry: `registerContextEngine()` / `resolveContextEngine()` |

### v5.20.4 — Gemini MALFORMED_FUNCTION_CALL Retry
- **Gemini malformed FC retry** — When Gemini returns `finish_reason=MALFORMED_FUNCTION_CALL` with 0 parts (common with complex parallel tool calls), the provider now automatically retries with `toolConfig.mode=ANY` instead of stopping the agent
- **Streaming + non-streaming** — Fix applied to both `streamWithRetry` and non-streaming code paths
- **Recursion guard** — Prevents infinite retry loops if mode=ANY also fails

### v5.20.3 — GPT-5 Temperature Corrections
- **GPT-5-nano temperature** — Live API tests confirmed `gpt-5-nano` requires `temperature=1` (not 0). Fixed in `FIXED_TEMPERATURE_MODELS`

### v5.20.0 — Temperature & Compaction Fixes
- **Temperature fix** — GPT-5 models no longer forced to `temperature=1.0`. Only o-series (o1, o3, o4-mini) retain the fixed override
- **Compaction overhaul** — context compaction no longer causes the agent to "forget" its task. Five improvements: `RECENT_MESSAGES_TO_KEEP` 6→20, tool call/result pairs never split, task-aware summary prompt, compacted summary as `role="user"` with `[System — Compacted History]` prefix, structured text log with `[TOOL CALLS]` and `[TOOL RESULT]` markers
- **Debug cleanup** — all development instrumentation removed

### v5.19.0 — Anthropic Provider, Security, Architecture Overhaul
- **Anthropic/Claude provider** — first-class `claude-sonnet-4-5` support via `ANTHROPIC_API_KEY`
- **Optional Gemini** — `@google/genai` moved to `optionalDependencies`, lazy-loaded at runtime
- **Lazy config** — no module-level side effects; `.env` discovery happens on first `loadConfig()` call
- **Lazy `process.cwd()`** — all module-level `process.cwd()` replaced with lazy functions
- **Gateway auth** — `GATEWAY_API_KEY` enables Bearer token auth; CORS via `GATEWAY_CORS_ORIGINS`
- **Improved blocked patterns** — regex-based dangerous command detection
- **Azure detection** — `OPENAI_API_TYPE=azure` env var for explicit Azure OpenAI
- **Global timeout** — `--timeout N` flag and `CLAW_TIMEOUT` env var
- **`--verbose` / `--quiet`** — CLI output verbosity controls
- **`--prune-trajectories N`** — delete old trajectory files
- **Lesson export/import** — `exportLessons()` / `importLessons()` for sharing
- **Trajectory pruning** — `pruneTrajectories(maxAgeDays)` utility
- **SSE fix** — fixed `on_event` signature mismatch in gateway stream endpoint

### v5.18.0 — Doctor, Trajectory Inspector & Config Improvements
- **`--doctor`** — diagnostic command checks `.env`, API keys, active model, PTRL flags, endpoint reachability
- **`--trajectory [N]`** — inspect last N run summaries with score, quality, failures, judge verdict
- **Startup banner** — every `--task` shows `provider=X model=Y env=Z ptrl=...`
- **`CLAWAGENTS_ENV_FILE`** — explicit env file override for CI/Docker/multi-project
- **`--port N`** — gateway server port now configurable
- **Publish hygiene** — GitHub releases exclude runtime artifacts

### v5.17.0 — Quick Start & Examples
- **Examples directory** — 5 ready-to-run TypeScript example scripts: OpenAI, Gemini, Azure, Ollama, multi-sample comparison
- **README overhaul** — new "30-Second Quick Start" section, examples table, clearer onboarding flow
- **Import fix** — examples use `"clawagents"` package import (not relative `"./agent.js"`)

### v5.16.0 — LLM-as-Judge & Thinking Token Preservation
- **G. LLM-as-Judge verification** — after each run (when `learn: true`), a separate LLM call evaluates task accomplishment on a 0-3 scale; results stored as `judgeScore` and `judgeJustification` on `RunSummary`
- **H. Thinking token preservation** — models like Qwen3/DeepSeek that emit `<think>...</think>` are now fully supported; thinking content extracted, preserved on messages/trajectory, stripped from visible output; `stripThinkingTokens()` utility exported

### v5.15.0 — Deterministic Verification & GRPO-Inspired Comparison
- **A. Deterministic rewards** — tool execution results (exit codes, test pass/fail) used as objective ground truth; `deterministicScore` per turn, `verifiedScore` per run
- **B. Multi-sample comparison** — `agent.compare(task, nSamples)` runs N attempts and picks the best using objective scoring (GRPO-inspired)
- **C. Task-type-aware verification** — auto-detects coding/file/search/refactor/general and applies type-specific verifiers
- **D. Progressive context caching** — system prompt tokens computed once and cached for budget calculations
- **E. RFT-ready transitions** — each trajectory exports `{runId}_rft.json` with (observation, action, reward, done) tuples per step
- **F. Adaptive rethink threshold** — threshold adjusts dynamically: complex tasks get more patience (5), simple tasks trigger sooner (3), late runs drop to minimum (2)

### v5.14.0 — SkyRL-Inspired PTRL Improvements
- **Quality gate for lesson extraction** — lessons only extracted from mixed-outcome runs (SkyRL GRPO-inspired dynamic sampling)
- **Lesson staleness decay** — lessons timestamped + model-tagged; `loadLessons(maxChars, maxAgeS)` filters stale lessons
- **Format vs. logic failure classification** — tool failures classified as `"format"` or `"logic"`; rethink messages include type-specific guidance
- **Per-step reward attribution** — `TurnRecord` gains `observationContext`, `productivityScore`; `RunSummary` gains `formatFailures`, `logicFailures`, `hasMixedOutcomes`, `finishReason`
- **Enhanced self-analysis prompt** — failure type breakdown and productivity scores for targeted lesson extraction

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
- Fixed-temperature override for reasoning models (o-series, gpt-5, gpt-5-mini, gpt-5-turbo). Non-reasoning (gpt-5-nano, gpt-5-micro, gpt-4o) respect configured temperature
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
