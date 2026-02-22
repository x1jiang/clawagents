# ClawAgents (TypeScript)

A lean, full-stack agentic protocol. ~2,500 LOC TypeScript.

## Quick Start

```bash
npm install
```

Create a `.env`:

```env
PROVIDER=gemini
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-3-flash-preview
STREAMING=1
CONTEXT_WINDOW=128000
MAX_TOKENS=4096
```

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

## Environment Variables

| Variable | Default | Description |
|:---|:---|:---|
| `PROVIDER` | auto-detect | `openai` or `gemini` |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENAI_MODEL` | `gpt-5-nano` | OpenAI model |
| `GEMINI_API_KEY` | — | Gemini API key |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | Gemini model |
| `STREAMING` | `1` | `1` = enabled, `0` = disabled |
| `CONTEXT_WINDOW` | `128000` | Token budget for compaction |
| `MAX_TOKENS` | `4096` | Max output tokens per response |

## Testing

```bash
npx tsx --test src/tools/registry.test.ts
```
