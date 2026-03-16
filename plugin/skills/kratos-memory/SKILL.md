---
name: kratos-memory
description: Save, search, and manage persistent memories across coding sessions. Use when the user asks to remember something, recall past work, or search their memory.
---

# Kratos Memory

You have access to a persistent memory system via the `npx kratos-cli` command. Use it to save important observations and recall past decisions.

## When to save memories

- Architecture decisions ("we chose X because Y")
- Bug fixes ("fixed Z by doing W")
- File/component relationships ("auth logic lives in src/auth/")
- User preferences and project conventions
- Important discoveries about the codebase

## Commands

### Save a memory
```bash
npx kratos-cli save "description of what happened" --tags tag1,tag2 --importance 3 --paths file1.ts,file2.ts
```
- `--tags`: comma-separated tags for categorization
- `--importance`: 1-5 (5 = critical, 3 = default)
- `--paths`: related file paths
- `--compress`: compress before saving

### Search memories
```bash
npx kratos-cli search "query terms"
npx kratos-cli search "auth" --tags backend --debug
```

### Ask natural language questions
```bash
npx kratos-cli ask "what do I know about the database schema?"
```

### Get recent memories
```bash
npx kratos-cli recent --limit 10
```

### Get full memory details
```bash
npx kratos-cli get <memory-id>
```

### Delete a memory
```bash
npx kratos-cli forget <memory-id>
```

### Check system status
```bash
npx kratos-cli status
```

### Scan for PII/secrets
```bash
npx kratos-cli scan "text that might contain secrets" --redact
```

## Guidelines

- Save memories with relevant tags so they're findable later
- Use importance 4-5 for architecture decisions and critical fixes
- Use importance 1-2 for routine observations
- Always include file paths when the memory relates to specific files
- Keep summaries concise but preserve technical terms
