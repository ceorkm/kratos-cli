<div align="center">

```
  ██╗  ██╗██████╗  █████╗ ████████╗ ██████╗ ███████╗
  ██║ ██╔╝██╔══██╗██╔══██╗╚══██╔══╝██╔═══██╗██╔════╝
  █████╔╝ ██████╔╝███████║   ██║   ██║   ██║███████╗
  ██╔═██╗ ██╔══██╗██╔══██║   ██║   ██║   ██║╚════██║
  ██║  ██╗██║  ██║██║  ██║   ██║   ╚██████╔╝███████║
  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚══════╝
```

### The God of War remembers everything.

[![npm version](https://img.shields.io/npm/v/kratos-memory.svg)](https://www.npmjs.com/package/kratos-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Formerly Kratos MCP](https://img.shields.io/badge/Formerly-Kratos%20MCP-333.svg)](https://github.com/ceorkm/kratos-mcp)

**Persistent memory for AI coding agents. Works with any agent — Claude Code, Codex, Cursor, Cline, or anything that runs Bash.**

</div>

---

## What is Kratos?

AI coding tools forget everything between sessions. You explain your architecture, your patterns, your decisions — and next session, you explain it all again.

Kratos gives your AI agent permanent memory. Every observation is saved and searchable locally. No cloud, no API keys, no vendor lock-in.

```
> use npx kratos-memory CLI. save what you learn, search when you need context.

Agent runs: npx kratos-memory search "auth"
Agent gets: JWT auth with refresh tokens, 15-min expiry, httpOnly cookies...
Agent runs: npx kratos-memory save "Added rate limiter to /api routes" --tags middleware
```

Works with **any** AI coding agent that can execute shell commands.

## Install

```bash
npx kratos-memory
```

That's it. No global install needed. Auto-detects your project.

## Commands

| Command | What it does |
|---------|-------------|
| `npx kratos-memory save <text>` | Save a memory (`--tags`, `--importance 1-5`, `--paths`, `--compress`, `--json`) |
| `npx kratos-memory search <query>` | Full-text search with FTS5 (`--limit`, `--tags`, `--debug`, `--json`) |
| `npx kratos-memory ask <question>` | Natural language query — learns vocabulary from your own memories (`--json`) |
| `npx kratos-memory recent` | Recent memories (`--limit`, `--json`) |
| `npx kratos-memory get <id>` | Full memory details (`--json`) |
| `npx kratos-memory forget <id>` | Delete a memory (`--json`) |
| `npx kratos-memory status` | System dashboard (`--json`) |
| `npx kratos-memory switch <path>` | Switch project (`--json`) |
| `npx kratos-memory scan <text>` | Detect PII and secrets (`--redact`, `--json`) |
| `npx kratos-memory context` | Compact memory block for session injection (`--budget`, `--json`) |
| `npx kratos-memory summary` | Project report: decisions, topics, most-touched files, prune candidates |
| `npx kratos-memory hooks install` | Install hooks (Claude Code + Codex): memory injection, auto-capture, git commit capture |

Kratos also supports machine-readable output for automation-heavy workflows. Use `--json` on the core read/write commands when you want agents, scripts, or CI to parse results safely.

## How agents use it

Just tell your agent:

> Use `npx kratos-memory` CLI for persistent memory. Run `npx kratos-memory --help` to see commands. Save important observations. Search before starting work.

Or drop the included `AGENTS.md` file in your project root — any agent that reads project files will pick it up.

### Claude Code

One command, fully automatic:

```bash
npx kratos-memory hooks install
```

This wires three hooks into the project:

- **SessionStart** — `kratos context` injects pinned memories, decisions, and recent work into every new session. The agent starts already knowing the project.
- **PostToolUse / Stop** — file edits and a session summary are captured automatically.
- **git post-commit** — every commit is saved as a memory (message + changed files).

No prompting, no relying on the model to remember to check memory — the hooks enforce it.

### Codex

The same install command also writes `.codex/hooks.json` with identical lifecycle hooks (SessionStart memory injection, auto-capture, session summary):

```bash
npx kratos-memory hooks install
```

Then run `/hooks` once inside Codex to trust them — Codex requires explicit approval for project hooks.

### Cursor / Cline / Any agent

Same pattern. If it can run Bash, it can use Kratos.

## Features

| Feature | Detail |
|---------|--------|
| **FTS5 Search** | Full-text search with porter tokenizer, smart fallbacks, <10ms retrieval |
| **Local-only Storage** | All data stays on your machine, zero network calls |
| **PII Detection** | Auto-detects SSN, credit cards, emails, phones, API keys, AWS keys, JWTs |
| **Project Isolation** | Each project gets its own SQLite database — zero cross-contamination |
| **Smart Compression** | Rule-based compression, no AI dependency |
| **Auto-Capture Hooks** | Optional hooks for Claude Code sessions |
| **Zero Network Calls** | Nothing leaves your machine. Ever. |

## How it works

```
You tell your agent "use kratos-memory"
        ↓
Agent runs: npx kratos-memory search "relevant context"
        ↓
Agent gets memories from local SQLite + FTS5
        ↓
Agent works with full context
        ↓
Agent runs: npx kratos-memory save "what it learned"
        ↓
Stored locally, searchable forever
```

## Data storage

```
~/.kratos/
├── projects/
│   ├── proj_abc123/
│   │   ├── databases/
│   │   │   └── memories.db        # SQLite + FTS5
│   │   └── project.json           # Project metadata
│   └── proj_def456/
│       └── ...
└── projects.json                  # Project registry
```

Each project is completely isolated with its own database.

## Security

- **PII detection** — SSN, credit cards, emails, phones, IPs, DOB
- **Secret scanning** — API keys, AWS keys, GitHub tokens, JWTs, private keys
- **Auto-redaction** — captured hook payloads are scanned and redacted before storage
- **Zero network calls** — nothing ever leaves your machine
- **No telemetry, no analytics, no cloud**

## Coming from Kratos MCP?

This is the successor to [`kratos-mcp`](https://github.com/ceorkm/kratos-mcp). We moved from MCP to CLI because MCP eats tokens before you ever use it. The CLI is lighter, faster, and works with any agent — not just MCP-compatible ones.

**The actual numbers** (measured on Claude Code):

| | MCP server | CLI |
|---|---|---|
| Tool schemas loaded into every session | **1,538 tokens** (12 tools) | **0 tokens** |
| Cost before the first memory is read | 1,538 tokens | 0 tokens |
| Invocation | JSON-RPC tool call | one Bash command (~30 tokens) |

The MCP version pays ~1.5k tokens of schema overhead in *every session of every project*, even sessions that never touch memory. At 20 agent sessions a day that's ~31k tokens/day of pure overhead. The CLI pays nothing until the moment it's actually used — and the responses are the same JSON either way.

**Your data is already compatible.** Both versions use the same `~/.kratos/` storage and SQLite format. Just start using `npx kratos-memory` and your existing memories are there.

```bash
npx kratos-memory status   # see your existing memories
npx kratos-memory recent   # they're all here
```

## Contributing

PRs welcome at [github.com/ceorkm/kratos-cli/pulls](https://github.com/ceorkm/kratos-cli/pulls)

## License

MIT

---

<div align="center">

**Built for developers who are tired of repeating themselves.**

[Report Bug](https://github.com/ceorkm/kratos-cli/issues) · [Request Feature](https://github.com/ceorkm/kratos-cli/issues)

</div>
