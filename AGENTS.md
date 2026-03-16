# Memory System

This project uses Kratos CLI for persistent memory across coding sessions.

## Commands
- Save: `npx kratos-cli save "description" --tags tag1,tag2 --importance 3`
- Search: `npx kratos-cli search "query"`
- Ask: `npx kratos-cli ask "question about the project"`
- Recent: `npx kratos-cli recent --limit 10`
- Status: `npx kratos-cli status`
- Get: `npx kratos-cli get <memory-id>`
- Forget: `npx kratos-cli forget <memory-id>`
- Scan: `npx kratos-cli scan "text to check" --redact`

## When to save
- Architecture decisions
- Bug fixes (what was wrong + how you fixed it)
- Important codebase patterns
- Feature implementations
- User preferences and conventions

## When to search
- Start of each session — get context about current work
- When asked about past decisions
- Before making changes to understand existing patterns
