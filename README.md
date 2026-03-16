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

**Persistent memory for AI coding agents. Works with any agent — Claude Code, Codex, Cursor, Cline, or anything that runs Bash.**

</div>

---

## What is Kratos?

AI coding tools forget everything between sessions. You explain your architecture, your patterns, your decisions — and next session, you explain it all again.

Kratos gives your AI agent permanent memory. Every observation is saved, searchable, and encrypted locally. No cloud, no API keys, no vendor lock-in.

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
| `npx kratos-memory save <text>` | Save a memory (`--tags`, `--importance 1-5`, `--paths`, `--compress`) |
| `npx kratos-memory search <query>` | Full-text search with FTS5 (`--limit`, `--tags`, `--debug`) |
| `npx kratos-memory ask <question>` | Natural language query |
| `npx kratos-memory recent` | Recent memories (`--limit`) |
| `npx kratos-memory get <id>` | Full memory details |
| `npx kratos-memory forget <id>` | Delete a memory |
| `npx kratos-memory status` | System dashboard |
| `npx kratos-memory switch <path>` | Switch project |
| `npx kratos-memory scan <text>` | Detect PII and secrets (`--redact`) |
| `npx kratos-memory migrate` | Import existing data |
| `npx kratos-memory hooks install` | Install auto-capture hooks |

## How agents use it

Just tell your agent:

> Use `npx kratos-memory` CLI for persistent memory. Run `npx kratos-memory --help` to see commands. Save important observations. Search before starting work.

Or drop the included `AGENTS.md` file in your project root — any agent that reads project files will pick it up.

### Claude Code

```
> use npx kratos-memory CLI (run help first)
```

### Codex

```
> use npx kratos-memory CLI for memory. search for context at the start, save decisions as you go.
```

### Cursor / Cline / Any agent

Same pattern. If it can run Bash, it can use Kratos.

## Features

| Feature | Detail |
|---------|--------|
| **FTS5 Search** | Full-text search with porter tokenizer, smart fallbacks, <10ms retrieval |
| **AES-256-GCM Encryption** | Per-project encryption keys, all data encrypted at rest |
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
Encrypted, stored locally, searchable forever
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
├── .keys/
│   └── proj_abc123.key            # AES-256 encryption key
└── projects.json                  # Project registry
```

Each project is completely isolated. Different database, different encryption key.

## Security

- **AES-256-GCM** encryption at rest with per-project keys
- **PII detection** — SSN, credit cards, emails, phones, IPs, DOB
- **Secret scanning** — API keys, AWS keys, GitHub tokens, JWTs, private keys
- **Key rotation** support
- **Zero network calls** — nothing ever leaves your machine
- **No telemetry, no analytics, no cloud**

## Migrating from kratos-mcp

If you were using the MCP version:

```bash
npx kratos-memory migrate
```

Same database format. Your memories are already compatible.

## Contributing

```bash
git clone https://github.com/ceorkm/kratos-cli.git
cd kratos-cli
npm install
npm run build
node bin/kratos-cli --help
```

## License

MIT
