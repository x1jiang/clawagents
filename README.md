# 🦞 ClawAgents

A standalone TypeScript agent engine combining **openclaw's resilience** (lane-based queueing, context compaction, SKILL.md system) with **deepagents' reasoning** (Understand → Act → Verify loop).

## Quick Start

### Prerequisites

- Node.js 18+
- An OpenAI or Gemini API key

### Setup

```bash
cd clawagents
npm install
```

Create a `.env` file (or use the parent directory's `.env`):

```env
# Pick one (or both)
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-5-nano

GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-3-flash-preview

# Force a provider (optional — auto-detected from keys)
PROVIDER=gemini
```

### Run a Task (CLI)

```bash
# Using Gemini
PROVIDER=gemini npm run task -- "List the files in the current directory"

# Using OpenAI
PROVIDER=openai npm run task -- "Read package.json and summarize it"

# Multi-step task with tool use
npm run task -- "Run node --version, then write the result to env-info.txt"
```

### Start the HTTP Gateway

```bash
npm start
# Server runs on http://localhost:3000

# Health check
curl http://localhost:3000/health

# Send a task
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"task": "List files in the src/ directory"}'
```

## Architecture

```
clawagents/
├── src/
│   ├── index.ts              # Entry point (CLI + server modes)
│   ├── config/config.ts      # .env loader with PROVIDER override
│   ├── providers/llm.ts      # Dual LLM provider (OpenAI + Gemini)
│   ├── graph/agent-loop.ts   # Understand → Act → Verify loop
│   ├── gateway/server.ts     # HTTP gateway with lane queueing
│   ├── process/
│   │   ├── command-queue.ts  # Lane-based command serialization
│   │   └── lanes.ts          # CommandLane enum
│   ├── memory/
│   │   └── compaction.ts     # Context window management
│   └── tools/
│       ├── registry.ts       # Tool interface + JSON parser
│       ├── filesystem.ts     # ls, read_file, write_file, grep
│       ├── exec.ts           # Shell command execution
│       └── skills.ts         # SKILL.md loader
├── package.json
└── tsconfig.json
```

## How It Works

### The 3-Phase Loop

Every task runs through: **Understand → Act → Verify**

1. **Understand** — The LLM analyzes the task and plans which tools to use
2. **Act** — Executes tools (up to 5 per iteration) with results fed back to the LLM
3. **Verify** — Checks if the task is complete. Returns `PASS` or `RETRY: <reason>`

If Verify says RETRY, the loop restarts with the feedback. Max 3 iterations.

### Tools (7 built-in)

| Tool | Description |
|------|-------------|
| `ls` | List directory contents |
| `read_file` | Read file with optional line range |
| `write_file` | Write content to a file |
| `grep` | Search for patterns in files |
| `execute` | Run shell commands (with safety guards) |
| `list_skills` | List available SKILL.md skills |
| `use_skill` | Load a skill's instructions |

### Skills (openclaw's SKILL.md system)

ClawAgents loads skills from `skills/` directories. Each skill is a folder with a `SKILL.md` file containing YAML frontmatter and markdown instructions:

```markdown
---
name: my-skill
description: What this skill does
---

# My Skill

Instructions for the agent...
```

Skills are loaded from:
- `./skills/` (project-local)
- `../openclaw-main/skills/` (openclaw ecosystem)

### Dual LLM Provider

Supports both **OpenAI** (Responses API) and **Google Gemini** with automatic detection:

- Set `OPENAI_API_KEY` → uses OpenAI
- Set `GEMINI_API_KEY` → uses Gemini
- Set both → defaults to OpenAI (override with `PROVIDER=gemini`)

## npm Scripts

| Script | Command |
|--------|---------|
| `npm start` | Start HTTP gateway server |
| `npm run dev` | Start with file watching |
| `npm run task -- "..."` | Run a single task from CLI |
| `npm run build` | Compile TypeScript |
| `npm run typecheck` | Type-check without emitting |

## Origins

ClawAgents extracts the best of two frameworks:

| Component | Source |
|-----------|--------|
| Lane queueing, compaction, skills | [openclaw](https://github.com/nicholasgriffintn/openclaw) |
| Understand→Act→Verify loop, filesystem tools | [deepagents](https://github.com/langchain-ai/deepagents) |
| Dual LLM provider, tool registry | Custom (built for this engine) |

## License

ISC
