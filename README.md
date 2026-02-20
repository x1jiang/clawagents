# 🦞 ClawAgents Playbook

A complete guide to installing, configuring, and using ClawAgents — a backend agent engine that combines **openclaw's** production resilience (Lane Queues, Memory Compaction, Gateway) with **deepagents'** clean reasoning DAG (Understand → Act → Verify).

---

## Table of Contents

1. [Installation](#installation)
2. [Configuration](#configuration)
3. [Running ClawAgents](#running-clawagents)
4. [Architecture Overview](#architecture-overview)
5. [Tools Reference](#tools-reference)
6. [Skills System](#skills-system)
7. [Memory & Compaction](#memory--compaction)
8. [Streaming Output](#streaming-output)
9. [Extending ClawAgents](#extending-clawagents)
10. [Benchmarks](#benchmarks)

---

## Installation

### From GitHub

```bash
git clone https://github.com/x1jiang/clawagents.git
cd clawagents
npm install
```

### As a Dependency

```bash
npm install github:x1jiang/clawagents
```

### Prerequisites

- **Node.js** ≥ 18
- **npm** or **pnpm**
- An API key for **OpenAI** or **Google Gemini** (or both)

---

## Configuration

ClawAgents uses a `.env` file for configuration. Create one in the project root:

```env
# Choose your provider: "openai" or "gemini"
PROVIDER=gemini

# OpenAI Configuration
OPENAI_API_KEY=sk-proj-your-key-here
OPENAI_MODEL=gpt-5-nano

# Gemini Configuration
GEMINI_API_KEY=AIzaSy-your-key-here
GEMINI_MODEL=gemini-2.5-flash
```

### Configuration Priority

| Variable | Default | Description |
|----------|---------|-------------|
| `PROVIDER` | Auto-detect | `"openai"` or `"gemini"`. If omitted, uses whichever API key is present. |
| `OPENAI_MODEL` | `gpt-5-nano` | Any OpenAI chat model. |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | Any Gemini model. |

### .env File Resolution

ClawAgents searches for `.env` in this order:
1. `./clawagents/.env` (project root)
2. `../.env` (parent directory — useful for monorepos)
3. System environment variables

---

## Running ClawAgents

### Mode 1: Single Task (CLI)

Run one task and exit:

```bash
# With npx (no build needed)
npx tsx src/index.ts --task "List all TypeScript files in the src directory"

# Or using npm script
npm start -- --task "Read package.json and tell me all dependencies"
```

**Example output:**

```
🦞 ClawAgents Engine v1.0
   Provider: gemini | Model: gemini-2.5-flash
   Tools: ls, read_file, write_file, edit_file, grep, execute

🦞 ClawAgent starting task: "Read package.json and tell me all dependencies"
   Provider: gemini | Max iterations: 3
   Tools: ls, read_file, write_file, edit_file, grep, execute

  [Understand] Analyzing task...
  [Act] Executing planned actions...
    -> Tool: read_file({"path":"package.json"})
    <- OK: File: /path/to/package.json (32 lines)...
  [Verify] Checking results...

🦞 ClawAgent finished. Status: done | Tool calls: 1

━━━ Final Result ━━━
The dependencies are: @google/genai ^1.9.0, dotenv ^16.6.1, openai ^5.8.2
━━━ Tool calls: 1 | Iterations: 1 ━━━
```

### Mode 2: Gateway Server

Start a persistent WebSocket server for real-time agent interaction:

```bash
npx tsx src/index.ts
# → 🦞 ClawAgents Gateway listening on ws://localhost:3000
```

Connect any WebSocket client to send tasks and receive streamed results.

### Switching Providers on the Fly

```bash
# Use Gemini
PROVIDER=gemini npx tsx src/index.ts --task "What files are in src/tools?"

# Use OpenAI
PROVIDER=openai npx tsx src/index.ts --task "What files are in src/tools?"
```

---

## Architecture Overview

ClawAgents uses a **3-node state graph** that loops until the task is complete:

```
┌─────────────┐     ┌─────────┐     ┌──────────┐
│  Understand │ ──► │   Act   │ ──► │  Verify  │
│  (analyze)  │     │ (tools) │     │ (check)  │
└─────────────┘     └─────────┘     └──────────┘
       ▲                                  │
       │            RETRY                 │
       └──────────────────────────────────┘
                     │
                   PASS ──► Done ✅
```

### Node Descriptions

| Node | Purpose | LLM Calls |
|------|---------|-----------|
| **Understand** | Analyzes the task and creates a brief plan of action | 1 |
| **Act** | Executes tools in a loop (up to 5 tool calls per iteration) | 1+ per tool |
| **Verify** | Checks if the result is correct. Returns `PASS` or `RETRY: <reason>` | 1 |

### Max Iterations

The graph runs at most **3 iterations** (configurable). Each iteration is a full Understand → Act → Verify cycle. If the Verify node returns `RETRY`, the agent loops back to Understand with the feedback.

---

## Tools Reference

ClawAgents ships with 6 built-in tools:

### `ls` — List directory contents

```json
{"tool": "ls", "args": {"path": "src/tools"}}
```

Returns `[FILE]` and `[DIR]` prefixed entries.

### `read_file` — Read file with line numbers

```json
{"tool": "read_file", "args": {"path": "package.json", "offset": 0, "limit": 50}}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | **required** | File path |
| `offset` | number | `0` | Start line (0-indexed) |
| `limit` | number | `100` | Max lines to return |

### `write_file` — Create/overwrite a file

```json
{"tool": "write_file", "args": {"path": "output.txt", "content": "Hello world"}}
```

Creates parent directories automatically.

### `edit_file` — Surgical text replacement

```json
{"tool": "edit_file", "args": {
  "path": "src/index.ts",
  "target": "console.log(\"old\")",
  "replacement": "console.log(\"new\")"
}}
```

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | File to edit |
| `target` | string | Exact text to find (must be unique in the file) |
| `replacement` | string | Text to replace it with |

**Safety:** Fails if the target text appears 0 or 2+ times.

### `grep` — Search for patterns in a file

```json
{"tool": "grep", "args": {"path": "src/tools/exec.ts", "pattern": "error"}}
```

Returns matching lines with line numbers.

### `execute` — Run shell commands

```json
{"tool": "execute", "args": {"command": "node --version"}}
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | string | **required** | Shell command to run |
| `timeout` | number | `30000` | Timeout in ms |

---

## Skills System

ClawAgents inherits openclaw's **SKILL.md** progressive disclosure system. Skills are loaded from:

1. `./skills/` (project root)
2. `../openclaw-main/skills/` (sibling openclaw install)

### Creating a Skill

Create a file at `skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: Helps the agent do X
---

# My Skill

## When to Use
Use this skill when the user asks about X.

## Instructions
1. First, do A
2. Then, do B
3. Finally, verify C
```

### Skill Tools

Two tools are auto-generated:

| Tool | Description |
|------|-------------|
| `list_skills` | Lists all available skills |
| `read_skill` | Reads a specific skill's SKILL.md content |

The LLM can call `list_skills` to discover capabilities, then `read_skill` to get detailed instructions — without all skill content being loaded into the context window upfront.

---

## Memory & Compaction

ClawAgents implements **rolling LLM-powered context summarization** (ported from openclaw):

```typescript
import { summarizeWithFallback } from "./memory/compaction.js";

const summary = await summarizeWithFallback({
    llm: provider,           // Your LLMProvider instance
    messages: agentMessages,  // Array of {role, content} messages
    maxChunkTokens: 2000,     // Max tokens per chunk to summarize
    contextWindow: 128000,    // Model's context window size
    previousSummary: "...",   // Optional: previous summary to extend
});
```

### How It Works

1. **Token estimation** — Messages are sized at ~4 chars/token
2. **Chunking** — Long histories are split into digestible chunks
3. **LLM summarization** — Each chunk is sent to the LLM with a summarization prompt that preserves critical facts (file paths, errors, values)
4. **Rolling accumulation** — Summaries build on each other across chunks
5. **Graceful fallback** — If the LLM call fails, falls back to a basic `[Summarized N messages]` placeholder

### History Pruning

```typescript
import { pruneHistoryForContextShare } from "./memory/compaction.js";

const { messages, droppedTokens } = pruneHistoryForContextShare({
    messages: allMessages,
    maxContextTokens: 128000,
    maxHistoryShare: 0.5,  // Use at most 50% of context for history
});
```

---

## Streaming Output

Both providers (OpenAI and Gemini) support **real-time streaming**. The agent loop automatically streams LLM output to `stdout` as it's generated:

```typescript
// The agent loop does this automatically, but you can use it directly:
const response = await provider.chat(messages, {
    onChunk: (chunk) => process.stdout.write(chunk),
});
```

### Provider Details

| Provider | Streaming API | Method |
|----------|---------------|--------|
| **OpenAI** | `chat.completions.create({ stream: true })` | Server-Sent Events |
| **Gemini** | `models.generateContentStream()` | Async iterator |

---

## Extending ClawAgents

### Adding a Custom Tool

```typescript
import type { Tool, ToolResult } from "./tools/registry.js";

export const myTool: Tool = {
    name: "my_tool",
    description: "Does something useful",
    parameters: {
        input: { type: "string", description: "The input value", required: true },
    },
    async execute(args): Promise<ToolResult> {
        const input = String(args["input"] ?? "");
        // Your logic here
        return { success: true, output: `Processed: ${input}` };
    },
};
```

Register it in `src/index.ts`:

```typescript
import { myTool } from "./tools/my-tool.js";
registry.register(myTool);
```

### Using a Different LLM

Implement the `LLMProvider` interface:

```typescript
import type { LLMProvider, LLMMessage, LLMResponse } from "./providers/llm.js";

export class MyProvider implements LLMProvider {
    name = "my-provider";
    
    async chat(
        messages: LLMMessage[],
        options?: { onChunk?: (chunk: string) => void }
    ): Promise<LLMResponse> {
        // Call your LLM API here
        return { content: "...", model: "my-model", tokensUsed: 0 };
    }
}
```

---

## Benchmarks

Tested across 4 sophisticated tasks using both Gemini 2.5 Flash and OpenAI gpt-5-nano:

| Task | Gemini 2.5 Flash | gpt-5-nano |
|------|-----------------|------------|
| Multi-File Analysis | **8.76s** ⚡ | 56.54s |
| Code Generation | 8.32s ❌ | **39.68s** ✅ |
| Shell + Data Extract | **7.87s** ⚡ | 40.13s |
| Code Search + Reasoning | **17.30s** ⚡ | 60.58s |

**Key findings:**
- **Gemini 2.5 Flash** is 4-8× faster but struggles with complex tool outputs (JSON-in-prompt code generation)
- **gpt-5-nano** is slower but more reliable for multi-step tool chains
- Both models work well for file analysis, shell execution, and code search tasks

---

## Project Structure

```
clawagents/
├── src/
│   ├── index.ts              # Entry point (CLI + Gateway modes)
│   ├── config/
│   │   └── config.ts          # .env loader and configuration
│   ├── graph/
│   │   └── agent-loop.ts      # State graph: Understand → Act → Verify
│   ├── providers/
│   │   └── llm.ts             # OpenAI + Gemini providers with streaming
│   ├── tools/
│   │   ├── registry.ts        # Tool registry + JSON parser
│   │   ├── filesystem.ts      # ls, read_file, write_file, edit_file, grep
│   │   ├── exec.ts            # Shell command execution
│   │   └── skills.ts          # SKILL.md loader
│   ├── memory/
│   │   └── compaction.ts      # LLM-powered context summarization
│   ├── process/
│   │   ├── command-queue.ts   # Lane-based command serialization
│   │   └── lanes.ts           # Concurrent lane management
│   ├── gateway/
│   │   └── server.ts          # WebSocket gateway server
│   └── logging/
│       └── diagnostic.ts      # Structured diagnostic logging
├── package.json
├── tsconfig.json
└── .env                       # Your API keys (not committed)
```

---

## License

ISC
