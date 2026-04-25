# ClawAgents (TypeScript)

A lean, full-stack agentic protocol. ~2,500 LOC TypeScript. **v6.4.0**

> **v6.4.0 (April 2026)** — Big feature release. Hierarchical tracing
> infrastructure, MCP client (stdio + SSE + Streamable-HTTP), handoffs +
> `Agent.asTool()`, Exec Safety v2 (Plan Mode + bash validator + obfuscation
> detector), expanded hook taxonomy + LLM-evaluated `PromptHook`,
> AskUserQuestion structured HITL, settings hierarchy, image sanitization,
> mock-provider parity harness. **226 tests** pass, `tsc --noEmit` clean.
> See [Changelog](#changelog).

## Installation

```bash
# From npm (recommended once published)
npm install clawagents

# Or directly from GitHub (HEAD of main)
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

### With Advisor Model (smart model guides cheap model)

```ts
// GPT-5.4-nano executes, GPT-5.4 advises 2-3 times per task
const agent = await createClawAgent({
    model: "gpt-5.4-nano",
    advisorModel: "gpt-5.4",
});

// Cross-provider: Gemini Flash executes, Opus advises
const agent = await createClawAgent({
    model: "gemini-3-flash",
    advisorModel: "claude-opus-4-6",
    advisorApiKey: "sk-ant-...",
});
```

The advisor is consulted at three points: (1) after initial orientation, before committing to an approach, (2) when stuck (consecutive failures trigger rethink), and (3) before declaring the task complete. Set `ADVISOR_MODEL` in `.env` or pass `advisorModel` in code.

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
clawagents --doctor

# Run a task directly
clawagents --task "Find all TODO comments in the codebase"

# Inspect past run trajectories
clawagents --trajectory        # last run
clawagents --trajectory 5      # last 5 runs

# Start the gateway server
clawagents --port 3000

# Show all options
clawagents --help

# Or, in a checkout of this repo (no install required):
npx tsx src/cli.ts --doctor
npx tsx src/cli.ts --task "..."
```

### Typical First-Time Flow

```bash
npm install clawagents                                       # 1. Install
cp .env.example .env                                         # 2. Create config
# edit .env with your API key                                # 3. Configure
clawagents --doctor                                          # 4. Verify setup
clawagents --task "hello world"                              # 5. Run first task
```

### CLI Reference

| Command | Description |
|:---|:---|
| `--doctor` | Check configuration health: `.env` discovery, API keys, active model, LLM settings, PTRL flags, local endpoint reachability, trajectory history. |
| `--task "..."` | Run a single task. Prints a startup banner (`provider=X model=Y env=Z ptrl=...`), executes the agent, prints the result. |
| `--trajectory [N]` | Inspect the last N run summaries (default: 1). Shows score, quality, failures, judge verdict. Requires `CLAW_TRAJECTORY=1`. |
| `--port N` | Start the HTTP gateway server on port N (default: 3000). |
| `--sessions` | List saved sessions (requires `CLAW_FEATURE_SESSION_PERSISTENCE=1`). |
| `--resume [ID\|latest]` | Resume a saved session from JSONL. Defaults to `latest`. |
| `--help` | Show all options with examples. |
| `--advisor MODEL` | Pair a stronger model for strategic guidance (e.g. `--advisor gpt-5.4`). |

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

**Advisor Model**

| Param | Type | Default | Required? | Description |
|:---|:---|:---|:---:|:---|
| `advisorModel` | `string \| LLMProvider` | env `ADVISOR_MODEL` / `undefined` | No | Stronger model for strategic guidance. Consulted 2-3 times per task. Cross-provider supported |
| `advisorApiKey` | `string` | env `ADVISOR_API_KEY` / `undefined` | No | API key for the advisor (only if different provider than executor) |
| `advisorMaxCalls` | `number` | env `ADVISOR_MAX_CALLS` / `3` | No | Max advisor consultations per task |

**MCP Servers (v6.4)**

| Param | Type | Default | Required? | Description |
|:---|:---|:---|:---:|:---|
| `mcpServers` | `MCPServer[]` | `undefined` | No | External MCP servers to connect at startup. Each server's tools are bridged into the registry; lifecycle phases emit tracing spans. Requires the optional `@modelcontextprotocol/sdk` peer dep. |

> **Priority:** Explicit parameter > environment variable > default value. You never need to set both.

### MCP Servers

ClawAgents v6.4 ships first-class **Model Context Protocol** support — wire any
MCP server (stdio, HTTP+SSE, Streamable HTTP) and its tools become first-class
clawagents tools, no boilerplate:

```ts
import { createClawAgent, MCPServerStdio } from "clawagents";

const agent = await createClawAgent({
    model: "gpt-5-mini",
    mcpServers: [
        new MCPServerStdio({
            params: { command: "node", args: ["./my-mcp-server.js"] },
            name: "my-mcp",
            cacheToolsList: true,
        }),
    ],
});
const result = await agent.invoke("Use the my-mcp tools to do X");
```

Install the SDK once: `npm install @modelcontextprotocol/sdk`. If `mcpServers`
is non-empty without the SDK, `createClawAgent` throws a clear error. The
manager connects each server, lists its tools, bridges them via
`MCPBridgedTool` into the existing `ToolRegistry`, and stashes itself on
`agent.mcpManager` so callers can `await agent.mcpManager.shutdown()`. Every
lifecycle phase (`Idle → Connecting → Initializing → DiscoveringTools → Ready
→ Invoking → Errored / Shutdown`) emits a `customSpan`, so MCP activity flows
through the standard tracing exporters.

For HTTP-based servers:

```ts
import { MCPServerSse, MCPServerStreamableHttp } from "clawagents";

const mcpServers = [
    new MCPServerSse({ params: { url: "https://example.com/mcp/sse" } }),
    new MCPServerStreamableHttp({ params: { url: "https://example.com/mcp" } }),
];
```

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
| `ask_user_question` | Structured HITL: ask 1-3 multiple-choice questions in one batch (opt-in) |

### Structured HITL — `ask_user_question`

`askUserQuestionTool` lets the agent ask 1-3 multiple-choice questions in a single batch — useful for upfront clarification with a small, well-defined option set. Each question has a short `header` (≤80 chars), the `question` text (≤256 chars), and 2-4 unique `options`. Headers must be unique across the batch; an implicit `Other (please specify)` option is appended automatically so the user can break out of the menu.

The actual rendering and answer collection is delegated to a callback you supply, so the same tool plugs into a CLI prompt, a TUI, a web UI, or a channel adapter without code changes:

```ts
import { askUserQuestionTool } from "clawagents";

const tool = askUserQuestionTool({
    async onAsk(questions) {
        // Render with your UI of choice; return a record keyed by header.
        return Object.fromEntries(questions.map((q) => [
            q.header,
            { question: q.question, answer: q.options[0]! },
        ]));
    },
});
```

If no `onAsk` is supplied the tool fails fast with a clear error rather than hanging on stdin — safe to install in headless gateways.

### Multimodal — Tool Output Hygiene

Anthropic's Messages API rejects images > 5MB and tends to fail on images much larger than ~2000px on a side. When tool results surface large screenshots or attachments, they can silently break the conversation. `clawagents`' `media/images` clamps base64 image blocks down to safe limits via `sharp`:

```ts
import { sanitizeImageBlock, sanitizeToolOutput } from "clawagents";

const cleanBlock = await sanitizeImageBlock(block, { maxDim: 1200, maxBytes: 5 * 1024 * 1024 });
const cleanOutput = await sanitizeToolOutput(toolResultBlocks);
```

- Base64 sources: decode → resize the longest side down to `maxDim` (aspect-preserving), recompress as JPEG (or PNG when the input is a PNG with alpha) walking through `qualitySteps=[90, 75, 60]` until under `maxBytes`. If still too big at the lowest quality, the block is replaced with a `[image too large after sanitization, dropped]` text block.
- URL sources and non-image blocks pass through unchanged.
- `sharp` is an **optional** dependency (`npm install sharp`). Without it, the helpers no-op and emit a one-time warning. `isSharpAvailable()` reports the runtime state.

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

## Trust Boundaries & Hardening

A few surfaces are deliberately powerful — they exist for trusted operators,
and you should treat them as such when running ClawAgents in environments
with untrusted prompts or LAN exposure:

- **`exec_shell` tool** — runs arbitrary commands inside the configured
  sandbox. Pair with `LocalBackend({ cwd })` constraints and ideally a
  containerized runtime; the tool's blocklist is a guardrail, not a
  security boundary.
- **External hooks** (`CLAW_FEATURE_EXTERNAL_HOOKS=1`, `CLAW_HOOK_*`)
  execute shell commands defined in your env or `.clawagents/hooks.json`.
  Anyone who controls those configs has code execution. Treat hooks as
  **trusted-only**.
- **`web_fetch` tool** — refuses loopback / RFC1918 / link-local /
  multicast IPs by default to block SSRF. Set
  `CLAWAGENTS_WEB_ALLOW_PRIVATE=1` only in trusted dev environments.
- **Gateway** — defaults to loopback (`127.0.0.1`) bind. Set
  `GATEWAY_HOST=0.0.0.0` to expose on LAN, and **always** set
  `GATEWAY_API_KEY=<secret>` when you do — startup will warn loudly
  otherwise.

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

**v5.28.0 Features** — inspired by [claw-code-main](https://github.com/anthropics/claw-code) (Rust reference)

| Variable | Default | Required? | Description |
|:---|:---|:---:|:---|
| `CLAW_FEATURE_CACHE_BOUNDARY` | `1` | No | Split system prompt for Anthropic prompt caching. Static prefix cached, dynamic suffix fresh each turn. |
| `CLAW_FEATURE_SESSION_PERSISTENCE` | `0` | No | Save sessions as append-only JSONL to `.clawagents/sessions/`. Enables `--sessions` and `--resume`. |
| `CLAW_FEATURE_ERROR_TAXONOMY` | `1` | No | Classify errors into 7 discrete classes with recovery hints. |
| `CLAW_FEATURE_EXTERNAL_HOOKS` | `0` | No | Run shell hooks before/after tool calls and LLM calls. Config via `.clawagents/hooks.json` or `CLAW_HOOK_*` env vars. |

**External Hook Env Vars** (requires `CLAW_FEATURE_EXTERNAL_HOOKS=1`)

| Variable | Description |
|:---|:---|
| `CLAW_HOOK_PRE_TOOL_USE` | Shell command before each tool. Can block or modify args. |
| `CLAW_HOOK_POST_TOOL_USE` | Shell command after each tool. Can modify results. |
| `CLAW_HOOK_PRE_LLM` | Shell command before each LLM call. Can inject messages. |
| `CLAW_HOOK_POST_LLM` | Shell command after each LLM response. Fire-and-forget logging. |

## Changelog

### v6.4.1 — Public-API export polish (no behavior change)

Patch release. Surfaces `PromptHook`, `PromptHookVerdict`, and `parseVerdict`
at the top-level `clawagents` package so users can `import { PromptHook } from
"clawagents"` instead of reaching into `clawagents/dist/hooks/prompt-hook.js`.
No code-path changes; both ports remain at 226/516 passing.

### v6.4.0 — Tracing, MCP, Handoffs, Plan Mode (April 2026)

Big feature release. Nine new subsystems shipped on **both** Python and TypeScript ports — every change comes with regression tests on both. Test totals: **TypeScript 226 passed**, **Python 516 passed**, `tsc --noEmit` clean, mypy clean.

**Tier 1 — production interop & safety:**

- **🔭 Tracing infrastructure** (`clawagents/tracing/`) — hierarchical Span model with 8 kinds (`agent` / `turn` / `generation` / `tool` / `handoff` / `guardrail` / `subagent` / `custom`), pluggable `TracingProcessor` + `TracingExporter` ABCs, batched `BatchTraceProcessor`, ready-made `JsonlSpanExporter` / `ConsoleSpanExporter` / `NoopSpanExporter`, and `agentSpan` / `turnSpan` / `generationSpan` / `toolSpan` / `handoffSpan` helpers. Spans propagate via Node's `AsyncLocalStorage`. Replaces flat trajectory JSONL — drop in OTLP/Langfuse/Logfire by writing one exporter.
- **🔌 MCP (Model Context Protocol) integration** (`clawagents/mcp/`) — full client supporting **stdio**, **SSE**, and **Streamable-HTTP** transports. `MCPServerStdio` / `MCPServerSse` / `MCPServerStreamableHttp` with `MCPServerManager` lifecycling a list of servers and `MCPBridgedTool` adapting MCP tools into the `ToolRegistry`. SDK is an optional dep (`npm install @modelcontextprotocol/sdk`). 11 lifecycle phases tracked with tracing spans.
- **🔁 Handoffs + `Agent.asTool()`** — fills the previously-stub `onHandoff` lifecycle hook. `Handoff` + `handoff()` builder transfers control between agents (with optional `inputFilter`); `agent.asTool({toolName, toolDescription})` exposes any agent as a callable tool. Built-in `removeAllTools` filter + `HandoffOccurredEvent` typed stream event.
- **🛡️ Exec safety v2** (`clawagents/permissions/`, `clawagents/tools/{plan-mode,bash-validator,exec-obfuscation}`) — three security upgrades: (1) `PermissionMode` enum (`DEFAULT|PLAN|ACCEPT_EDITS|BYPASS`) on `RunContext` plus `enterPlanModeTool` / `exitPlanModeTool`; (2) Bash semantic validator with 47-row corpus; (3) Command obfuscation detector for base64/hex/printf decode-then-exec, `<(curl …)`, `curl … | sh`, and 9 other patterns with allowlist for known-safe installers.
- **🪝 Hook event taxonomy expansion + `PromptHook`** — extended `RunHooks` with 8 additive events: `onPreCompact`, `onPostCompact`, `onSubagentStart`, `onSubagentEnd`, `onUserPromptSubmit`, `onSessionStart`, `onSessionEnd`, `onToolFailure`. New `PromptHook({prompt, model})` evaluates a guardrail using a small/cheap model with strict-JSON `{"ok":bool, "reason":str}` verdict — write a natural-language guardrail without writing TypeScript code. Fails open on timeout/error.

**Tier 2 — ergonomics & correctness:**

- **❓ AskUserQuestion structured tool** (`clawagents/tools/ask-user-question`) — structured HITL primitive: 1-3 multi-choice questions per call, 2-4 options each, implicit `"Other (please specify)"` always appended. Renders cleanly to Telegram inline buttons / WhatsApp quick-replies via the `onAsk` callback.
- **⚙️ Settings hierarchy** (`clawagents/settings/`) — `user → project → local → flag → policy` precedence, deep-merged. Policy layer ALWAYS wins. Repo root walks up looking for `.git`/`package.json`. `getSetting("hooks.beforeTool")` for dotted-path access.
- **🖼️ Image sanitization** (`clawagents/media/images`) — clamps tool-result base64 image blocks to ≤1200px / ≤5MB before transcript ingest. Closes a silent-failure path on Anthropic's 5MB limit. `sharp` is **optional** (`npm install sharp`).

**Tier 3 — testing infrastructure:**

- **🎭 Mock-provider parity harness** (`clawagents/testing/mock-provider`) — deterministic fake LLM service (`MockLLMService`) bound to `127.0.0.1:0`. Real provider clients point at it via `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`. Routes via `X-Parity-Scenario:` header or `PARITY_SCENARIO: <name>` system message. Five built-in scenarios. Pure stdlib `node:http`, zero new deps.

**v6.5 backlog (deferred):** Anthropic prompt-cache tracking + cache-break detection, auth-profile rotation with cooldowns, multi-provider routing prefix + LiteLLM extension, file checkpoint snapshots, cache-TTL provider eligibility map, `toolUseBehavior` / `StopAtTools`, granular lifecycle payload widening, skills hot-reload watcher, `finalize` cleanup hook, `editScope` allowlist in skills.

### v6.3.0 — Sandbox & SSRF Hardening, Python Parity

Security/correctness release. Eleven bugs fixed across the TypeScript and Python ports. All tests green: **121 passed**, **`tsc --noEmit` clean**.

**Security fixes (TypeScript):**
- **Sandbox escape via symlink** — `LocalBackend.safePath` was lexical-only (`path.resolve`), so an agent that ran `ln -s /etc evil` could read `/etc/*` through the symlink. Now uses `realpathSync` for both cwd (at construction) and resolved paths (at check time), so symlinks are followed before the containment check. For paths that don't yet exist (write-file flow), walks up the path until it finds an existing ancestor and realpath's that.
- **SSRF gap — incomplete IPv6 link-local match** — `isPrivateIp` checked `lower.startsWith("fe8")`, missing `fe9X`/`feaX`/`febX`. The full `fe80::/10` range covers hex prefixes `fe80–febf`. Replaced with `/^fe[89ab]/`.
- **`> /dev/null` blocked legitimate redirects** — `BLOCKED_PATTERNS` had `"> /dev/null"` (typo for `"> /dev/sd"`, which IS dangerous). Removed.
- **`rm /` regex parity with Python** — `DANGEROUS_RE` was missing the `*` quantifier on the flag group, so `rm /` (no flags) slipped past while Python's regex blocked it. Added `*`.
- **`wget http` / `curl http` blocked** — added to `BLOCKED_PATTERNS` for parity with Python. Agents should use the `web_fetch` tool (with SSRF guards) for HTTP, not raw shell utilities that bypass those protections.

**Regression coverage added:**
- `src/tools/web.test.ts` — 6 unit tests for `isPrivateIp`: full `fe80::/10` link-local range, ULA `fc00::/7`, loopback, IPv4-mapped private, public IPv6 (Google DNS, Cloudflare).
- `tests/simulated.test.ts` — added asserts in section 16 (Path Traversal) for symlink-escape blocking, both for read paths and write paths through symlinked parents. Added asserts in section 17 (Exec Safety) for `> /dev/null` allowed, `dd if=/dev/zero of=/dev/sda` blocked, `rm /` blocked, `rm /tmp/foo` allowed, `wget http://...` blocked, `curl http://...` blocked.

**Companion Python fixes** (in `clawagents_py` v6.3.0): multimodal system message context shedding, parallel native tool-call indexing under `before_tool` hooks, subagent env-mutation race under `credential_proxy`, `BaseException` widening for `CancelledError` classification, Gemini provider `None`-parts iteration. Plus a full mypy cleanup (46 errors → 0).

### v6.2.2 — Dependency Audit Cleanup

Patch release for the TypeScript package dependency tree.

- Removed `byterover-cli` from optional runtime dependencies; it pulled in bundled `socket.io-parser@4.2.4` and older Vertex/Google auth dependencies that were not required by ClawAgents runtime.
- Refreshed `package-lock.json` so `protobufjs`, `minimatch`, and `brace-expansion` resolve to patched versions.
- `npm audit` now reports **0 vulnerabilities**.

### v6.2.1 — npm Packaging, Redirect-Safe `web_fetch`, and Release CI

Patch release focused on making the TypeScript package install cleanly as a normal npm/GitHub dependency and keeping parity with the Python sibling.

- **Standard npm package layout** — `package.json` now points `main`, `types`, `exports`, and `bin` at built `dist/` artifacts. `src/index.ts` is a side-effect-free library entrypoint; CLI runtime lives in `src/cli.ts`.
- **Build and publish guardrails** — `tsconfig.build.json` emits JS + declarations, `scripts/postbuild.mjs` ensures the CLI has a shebang and executable bit, and `prepublishOnly` rebuilds before release.
- **Install smoke in CI** — GitHub Actions now builds a tarball, installs it into a fresh consumer project, imports `clawagents`, verifies public exports, and runs the `clawagents` binary.
- **Redirect-aware SSRF protection** — `webFetchTool` uses manual redirects with per-hop validation and a 5-hop limit, blocking public-to-private redirect bypasses.
- **Parity and test coverage** — `scripts/smoke-gemma4.ts` mirrors `clawagents_py/scripts/smoke_gemma4.py`; `npm run typecheck` is clean and `npm test` reports **115 passed**.

### v6.2.0 — OpenAI-Agents Parity, Ollama/Gemma4 First-Class Routing, 63 Model Profiles

Additive release — mirrors the Python sibling [clawagents (PyPI)](https://pypi.org/project/clawagents/). Everything is backward compatible.

**1. Ten OpenAI-Agents-SDK parity surfaces** (all additive, all new modules)

| Surface | Module | What it adds |
|:---|:---|:---|
| **Run Context** | `src/run-context.ts` | `RunContext` carries per-run state, approvals, and user data through hooks and tools. |
| **Usage Tracking** | `src/usage.ts` | `Usage` + `RequestUsage` aggregate token/latency stats across turns, providers, and sub-agents. |
| **Lifecycle Hooks** | `src/lifecycle.ts` | `RunHooks` / `AgentHooks` with typed `LLMStart/LLMEnd/ToolStart/ToolEnd/AgentStart/AgentEnd/RunStart/RunEnd/Handoff` payloads. `compositeHooks` chains multiple observers. |
| **Guardrails** | `src/guardrails.ts` | `inputGuardrail` / `outputGuardrail` decorators, `GuardrailTripwireTriggered`, behavior modes (raise / log / filter). |
| **Stream Events** | `src/stream-events.ts` | First-class `TurnStartedEvent`, `AssistantDeltaEvent`, `ToolCallPlannedEvent`, `ApprovalRequiredEvent`, `UsageEvent`, `GuardrailTrippedEvent`, `FinalOutputEvent`, `ErrorStreamEvent`. |
| **Retry Policy** | `src/retry.ts` | `RetryPolicy` + `DEFAULT_RETRY_POLICY`. Exponential backoff with jitter, per-error-class overrides. |
| **Function Tools** | `src/function-tool.ts` | `functionTool()` helper auto-derives JSON Schema from Zod schemas — zero hand-written schemas. |
| **Session Backends** | `src/session/backends.ts` | Unified `Session` interface with `InMemorySession`, `JsonlFileSession`, `SqliteSession` (uses `node:sqlite`). |
| **Structured Outputs** | `OutputTypeSpec` | Return typed objects via Zod schema or JSON schema. Validated before the run finalizes. |
| **Tool Approval** | `ApprovalHandler` | HITL gate — async callback returns allow/deny/redirect per tool call. Integrates with `ApprovalRequiredEvent`. |

**2. Ollama & Gemma 4 first-class routing**

`createProvider()` now auto-routes 24 Ollama-family prefixes to `http://localhost:11434/v1` with no config. Use either the bare tag (`gemma4:e4b`) or the explicit routing form (`ollama/gemma4:e4b`).

| Family | Examples | Routed to |
|:---|:---|:---|
| **Gemma 4** | `gemma4`, `gemma4:e2b`, `gemma4:e4b`, `gemma4:26b`, `gemma4:31b` | Ollama @ :11434/v1 |
| **Gemma 3 / 3n / 2** | `gemma3`, `gemma3n:e4b`, `gemma2`, `gemma` | Ollama @ :11434/v1 |
| **Llama / Qwen / Mistral / Phi / Deepseek / Codellama** | `llama3`, `qwen2`, `mistral`, `mixtral`, `phi4`, `deepseek-r1`, `codellama`, … | Ollama @ :11434/v1 |
| **Explicit routing** | `ollama/<any-tag>` | Ollama @ :11434/v1 (prefix stripped) |

Override with `OPENAI_BASE_URL` if Ollama runs on a different host/port. API key auto-set to placeholder `"ollama"`.

**3. 63 model profiles + model-aware context budget**

`MODEL_PROFILES` now covers frontier (GPT-5.4 → 400K, Gemini 3.1 → 1M, Claude 4.6 Opus), Ollama (Gemma4 e2b/e4b → 128K, 26b/31b → 256K), and a long tail of OSS variants. `resolveContextBudget()` walks insertion order for deterministic prefix matching (most-specific first) — identical to the Python sibling.

**4. Cross-package parity** — the Python sibling [`clawagents` on PyPI](https://pypi.org/project/clawagents/) has the identical 24-entry Ollama prefix list, 63-entry model profile table with the same (window, ratio) values, and the same `create_provider` routing logic. Parity can be exercised manually with the matching smoke scripts in each repo (`clawagents/scripts/smoke-gemma4.ts` and `clawagents_py/scripts/smoke_gemma4.py`); both print the same provider, base URL and stored model for `gemma4:*`, `ollama/...`, `gpt-5.4`, `gemini-3.1-pro` and `claude-opus-4-6`. The GitHub Actions workflow added in v6.2.1 runs `npm run typecheck`, `npm run build`, `node --test`, and a real install-from-tarball + `import 'clawagents'` smoke on every push.

**5. Quality / debug pass**

- Hardened filesystem sandbox — all six fs tools now resolve paths inside `try/catch`, so `Path traversal blocked` errors become graceful `ToolResult { success: false }` instead of thrown exceptions.
- Ported `tests/openai_agents_surfaces.test.ts` — full coverage for RunContext, Usage, Hooks, Guardrails, StreamEvents, Retry, FunctionTool, Session backends.
- Added `scripts/smoke-gemma4.ts` — manual routing probe for Gemma4 variants + `gpt-5.4`.
- Test suite: **109 passed** via `node --test`.

**New public exports** (from `clawagents`):
`RunContext`, `ApprovalRecord`, `Usage`, `RequestUsage`, `RunHooks`, `AgentHooks`, `compositeHooks`, `InputGuardrail`, `OutputGuardrail`, `inputGuardrail`, `outputGuardrail`, `GuardrailBehavior`, `GuardrailResult`, `GuardrailTripwireTriggered`, `StreamEvent` (+ 10 concrete event types), `streamEventFromKind`, `RetryPolicy`, `DEFAULT_RETRY_POLICY`, `functionTool`, `InMemorySession`, `JsonlFileSession`, `SqliteSession`.

### v6.1.1 — Credential Isolation & Lazy Tool Provisioning

| Feature | Description |
|:---|:---|
| **Credential Isolation** | `execute` tool strips sensitive env vars (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) from subprocess environment. Claude-generated code can no longer read API keys via `env` or `process.env`. |
| **Lazy Tool Provisioning** | Sandbox-backed tools (filesystem, exec, advanced-fs, web) defer module import to first `execute()` call. Schema is available immediately for the LLM. Reduces startup overhead. |
| **LazyFactoryTool** | New `LazyFactoryTool` class in registry — wraps a factory function that creates the real tool on first use. |

### v6.1.0 — Advisor Model: Smart Model Guides Cheap Model

Pair a stronger "advisor" model with a cheaper "executor" model. The executor runs every turn; the advisor is consulted 2-3 times per task for strategic guidance. Cross-provider supported — any model can advise any other model.

| Feature | Description |
|:---|:---|
| **Advisor Model** | New `advisorModel` config field. Set it and the agent gets smarter. Don't set it, nothing changes. Fully backward compatible. |
| **Three Trigger Points** | (1) After initial orientation, before planning. (2) When stuck (consecutive failures). (3) Before declaring done. |
| **Cross-Provider** | Mix providers freely: `gpt-5.4-nano` executor + `claude-opus-4-6` advisor, or any combination. |
| **CLI Flag** | `--advisor MODEL` flag for one-line usage. |
| **Env Config** | `ADVISOR_MODEL`, `ADVISOR_API_KEY`, `ADVISOR_MAX_CALLS` env vars. |

```ts
const agent = await createClawAgent({
    model: "gpt-5.4-nano",
    advisorModel: "gpt-5.4",
});
```

### v6.0.0 — Production Hardening: 17 Improvements

**High Priority**

| Feature | Description |
|:---|:---|
| **Native Tool Call Patching (H1)** | `patchDanglingToolCalls` now handles native function calling (`toolCallsMeta`), not just text-mode JSON. Injects synthetic cancelled responses for orphaned tool call IDs. |
| **Three-Tier Provider Fallback (H2)** | New `FallbackProvider` wraps any LLM with `primary → named fallback → global fallback` chain. Quarantines providers after consecutive failures. Config via `fallbackModels` param or `CLAWAGENTS_FALLBACK_MODELS` env var. |
| **Credential Proxy (H3)** | New `CredentialProxy` — local HTTP proxy injects API keys into outbound requests so sandboxed sub-agents never see raw credentials. Opt-in via `CLAW_FEATURE_CREDENTIAL_PROXY=1`. |
| **Rich Hook Result Model (H4)** | `BeforeToolHook` now accepts `HookResult` return (backward-compatible with `boolean`). Hooks can block with reason, redirect args, inject messages. `HookResult` interface exported from public API. |
| **Fraction-Based Summarization (H5)** | Soft-trim threshold derives from per-model `budgetRatio` instead of hardcoded 0.60. Auto-adapts to any model's context window. |
| **Lazy Static Tool Registry (H7)** | New `LazyTool` class + `ToolRegistry.registerLazy()`. Tools imported only on first `execute()` call. |

**Medium Priority**

| Feature | Description |
|:---|:---|
| **Subagent State Isolation (M1)** | `EXCLUDED_STATE_KEYS` prevents parent state from leaking into child sub-agents. |
| **SKILL.md Constraint Documents (M4)** | Skills now support `forbiddenActions`, `workspaceLayout`, `successCriteria`, `workflowSteps` in YAML frontmatter. |
| **Pre-Compact Transcript Archival (M5)** | Full transcript archived to `.clawagents/transcripts/` before context compaction. Opt-in via `CLAW_FEATURE_TRANSCRIPT_ARCHIVAL=1`. |
| **Atomic File Writes (M7)** | Trajectory recorder and session persistence use temp-then-rename via `atomicWriteFileSync()`. Prevents corruption on crash. |
| **Barrier-Based Scheduling (M8)** | Command queue supports barrier entries. Destructive ops wait for active tasks to complete. |
| **Session Heartbeat (M9)** | New `SessionHeartbeat` class auto-releases stale sessions after timeout. |
| **Cross-Provider Test Suite (M10)** | 22 conformance tests ensuring `LocalBackend` and `InMemoryBackend` satisfy the `SandboxBackend` interface. |

**New files:** `providers/fallback.ts`, `sandbox/credential-proxy.ts`, `utils/atomic-write.ts`, `session/heartbeat.ts`, `cross_provider.test.ts`

**New feature flags:** `transcript_archival` (off), `credential_proxy` (off)

**New exports:** `HookResult`, `FallbackProvider`, `CredentialProxy`, `SessionHeartbeat`, `LazyTool`, `atomicWriteFileSync`

### v5.28.0 — Error Taxonomy, Prompt Caching, Session Persistence & External Hooks

Four production-grade features ported from the [claw-code-main](https://github.com/anthropics/claw-code) Rust reference:

| Feature | Description |
|:---|:---|
| **Prompt Cache Boundary** | `__CACHE_BOUNDARY__` marker in system prompt. Anthropic provider splits into static (cached) + dynamic blocks. ON by default. |
| **Error Taxonomy & Recovery** | 7 discrete error classes with `retryable`, `recoveryHint`, `failoverModel`. Structured error events via `onEvent`. ON by default. |
| **Session Persistence** | Append-only JSONL to `.clawagents/sessions/`. New CLI: `--sessions` and `--resume [ID|latest]`. Opt-in. |
| **External Hook System** | Shell hooks before/after tools and LLM calls. `.clawagents/hooks.json` or `CLAW_HOOK_*` env vars. 10s timeout, fail-open. Opt-in. |

Also: Anthropic cache token extraction, `AgentState.sessionFile`, new exports (`ErrorClass`, `classifyError`, `SessionWriter`, `SessionReader`, `ExternalHookRunner`, etc.), removed circular self-dependency in `package.json`.

### v5.27.3 — Gemini Signature Regression Coverage
- **Gemini signature regression test** — Added a provider-level test ensuring `thought_signature` propagation across sibling parallel `functionCall` parts.
- **Release verification update** — Added release coverage for Gemini signature behavior and malformed function-call retry paths.

### v5.27.2 — Gemini 3 Thought Signature Fix
- **Gemini 3 Propagation** — Propagated `thoughtSignature` to all parallel `functionCall` parts, preventing `400 INVALID_ARGUMENT` errors.

### v5.27.1 — Timeout Bugfix
- **Added timeoutS override** — Updated `ClawAgent.invoke` to correctly receive and pass through a per-invocation `timeoutS` parameter, matching the Python SDK convention.

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
npm install

# Run the full test suite (expected: 121 passed on v6.3.0)
npm test

# Type-check without emitting (expected: clean, exit 0 on v6.3.0)
npm run typecheck

# Build dist/ (runs typecheck under the hood)
npm run build

# Run a single file
npx tsx --test src/tools/registry.test.ts
```

The `web.test.ts` and `simulated.test.ts` suites cover every bug fixed in
v6.3.0: symlink-escape blocking via the real `LocalBackend.safePath`, full
`fe80::/10` IPv6 link-local matching, and the exec denylist (`> /dev/null`,
`rm /`, `wget http`, `curl http`).
