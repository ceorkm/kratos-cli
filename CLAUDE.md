# CLAUDE.md

Guidance for working in the **kratos-memory** (a.k.a. `kratos-cli`) repository.

## What this is

A CLI-first persistent memory store for AI coding agents. Memories are saved to
local SQLite databases with FTS5 full-text search — **zero network calls**, all
data stays on disk under `~/.kratos/`. Published to npm as `kratos-memory`;
exposed as the `kratos` / `kratos-memory` binaries.

The deferred `mcp__kratos__*` tools available in this environment are a separate
MCP wrapper around the same data store — **this repo contains no MCP server
code** (the `src/memory-server/` name is historical; it's just the DB layer).

## Commands

```bash
npm run build      # tsc → dist/
npm run dev        # tsx src/cli/index.ts (run CLI from source)
npm start          # node dist/cli/index.js (run built CLI)
npm test           # builds, then runs node --test against tests/*.test.mjs
```

Tests (`tests/cli.test.mjs`) spawn the **built** CLI in a sandboxed `$HOME`, so
always `npm run build` before testing. There is no lint step.

`npm install` runs `scripts/ensure-better-sqlite3.mjs` (postinstall), which
self-heals the `better-sqlite3` native binary by rebuilding it if the prebuilt
`.node` file is missing or fails to load.

## Architecture

Entry: `bin/kratos-cli` → loads native-module guard → imports `dist/cli/index.js`.

- **`src/cli/index.ts`** — Commander setup. Every subcommand lazily
  `import()`s its handler from `src/cli/commands/<name>.ts` so startup stays fast.
  Adding a command = register it here + add a file in `commands/`.
- **`src/cli/core.ts`** — `initCLIContext()` builds the `CLIContext`: detects the
  project, opens the project DB **and** the global DB. `getScopedMemoryDb(ctx, {global})`
  picks which DB a command writes to. PII detector is loaded lazily.
- **`src/project-manager.ts`** — Registry-based project detection. No filesystem
  marker sniffing: cwd (or its deepest registered ancestor) maps to a project.
  Metadata lives in `~/.kratos/projects/<id>/project.json` with a `projects.json`
  cache that rebuilds from disk if corrupted. Override cwd with `KRATOS_PROJECT_ROOT`.
- **`src/memory-server/database.ts`** — `MemoryDatabase`, the core. SQLite + WAL,
  a `memories` table mirrored into an FTS5 virtual table (`mem_fts`) via triggers.
  Scoped per-project (`~/.kratos/projects/<id>/databases/memories.db`) or global
  (`~/.kratos/global/memories.db`).
- **`src/security/pii-detector.ts`** — pattern + entropy based PII/secret
  detection and redaction. Backs `save` (warns) and `scan`.
- **`src/compression/`** — `RuleCompressor` (via `factory.createCompressor`)
  shortens text on `save --compress` and in auto-capture summaries.
- **`src/cli/capture-handler.ts`** + **`commands/hooks.ts`** — opt-in auto-capture.
  `hooks install` writes a `PostToolUse`/`Stop` hook into `.claude/settings.local.json`
  that calls the hidden `capture` command to buffer session activity into a memory.

### Search & ranking (the heart of it)

`MemoryDatabase.search()` runs `executeSearch()` then, on FTS syntax/empty
failures, retries through a **fallback ladder**: sanitized query → 5-char prefix
globs (`term*`) → OR-joined terms → longest single term. `searchWithDebug()`
mirrors this and records which queries were tried.

Ranking is **not** raw bm25. `executeSearch` over-fetches candidates (5x k,
min 50) ordered by pin status then bm25, then recomputes a 0–100 score in JS
from: concept coverage (term overlap), per-field boosts (tags > summary >
paths > text), phrase match, exact-match bonuses, importance, a recency decay
(30-day half-life), and a small clamped bm25 signal — then slices to k. The
over-fetch matters: bm25 and the JS score disagree, so cutting at k in SQL
would drop true best matches.

Saves are **deduped** by a `dedupe_hash`; an identical save updates the existing
memory instead of inserting. Memories support TTL → `expires_at`; expired rows
are filtered from reads and cleaned up on save.

### Hooks & context injection

`kratos hooks install` wires three enforcement points: a Claude Code
**SessionStart** hook running `kratos context` (its stdout is injected into the
session — a token-budgeted block of pinned/important/recent memories built by
`commands/context.ts`), **PostToolUse/Stop** capture hooks, and a **git
post-commit** hook (marker-delimited block appended to `.git/hooks/post-commit`,
handled by `CaptureHandler.handleGitCommit`). Claude Code requires the nested
`{matcher, hooks: [{type: 'command', command}]}` schema — flat `{matcher,
command}` entries (written by kratos <= 1.6.x) are silently ignored; install
migrates them.

## Conventions & gotchas

- ESM throughout (`"type": "module"`). Imports use **`.js`** extensions even for
  `.ts` sources — required by `moduleResolution: node` + ESM output.
- `strict` TypeScript. Target ES2022.
- `VERSION` is read from `package.json` at runtime — don't hardcode it.
- **`generateProjectId()` in `project-manager.ts` is frozen.** Its output is the
  hash directory every existing user's memories live under. Changing the
  algorithm, normalization, or `toLowerCase()` orphans all existing databases —
  this already happened once (v1.5.0 → v1.6.1) and needed a migration. Don't touch it.
- `dist/` and `.kratos/` are gitignored, but a built `dist/` is currently checked
  in / shipped via the `files` allowlist in `package.json`.
- New work: add a command file, register it in `index.ts`, and add a sandboxed
  test to `tests/cli.test.mjs`.
