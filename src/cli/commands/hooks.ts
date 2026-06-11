import { Output } from '../output.js';
import path from 'path';
import fs from 'fs-extra';

// Claude Code hook schema: each event holds matcher groups, each group holds
// hooks of { type: 'command', command }. Flat { matcher, command } entries
// (written by kratos <= 1.6.x) are silently ignored by Claude Code — install
// migrates them to this format.
const KRATOS_HOOKS: Record<string, any[]> = {
  SessionStart: [
    {
      hooks: [{ type: 'command', command: 'kratos context' }],
    },
  ],
  PostToolUse: [
    {
      matcher: 'Edit|Write|MultiEdit',
      hooks: [{ type: 'command', command: 'kratos capture --event post-tool-use' }],
    },
  ],
  Stop: [
    {
      hooks: [{ type: 'command', command: 'kratos capture --event session-end' }],
    },
  ],
};

const HOOK_EVENTS = Object.keys(KRATOS_HOOKS);

// Codex (OpenAI) lifecycle hooks — same event names and nested schema as
// Claude Code, discovered at <repo>/.codex/hooks.json. Tool names differ
// (apply_patch) and SessionStart takes a source matcher.
const KRATOS_CODEX_HOOKS: Record<string, any[]> = {
  SessionStart: [
    {
      matcher: 'startup|resume|clear',
      hooks: [{ type: 'command', command: 'kratos context', statusMessage: 'Loading Kratos memory', timeout: 30 }],
    },
  ],
  PostToolUse: [
    {
      matcher: 'Edit|Write|apply_patch',
      hooks: [{ type: 'command', command: 'kratos capture --event post-tool-use', timeout: 30 }],
    },
  ],
  Stop: [
    {
      hooks: [{ type: 'command', command: 'kratos capture --event session-end', timeout: 30 }],
    },
  ],
};

const GIT_HOOK_START = '# >>> kratos-memory post-commit >>>';
const GIT_HOOK_END = '# <<< kratos-memory post-commit <<<';
const GIT_HOOK_BLOCK = [
  GIT_HOOK_START,
  'command -v kratos >/dev/null 2>&1 && kratos capture --event git-commit >/dev/null 2>&1 || true',
  GIT_HOOK_END,
].join('\n');

export async function hooksCommand(action: string): Promise<void> {
  switch (action) {
    case 'install':
      await installHooks();
      break;
    case 'uninstall':
      await uninstallHooks();
      break;
    case 'status':
      await checkHooksStatus();
      break;
    default:
      Output.error(`Unknown action: ${action}. Use: install, uninstall, status`);
      process.exit(1);
  }
}

/** Matches both current-format and legacy flat-format kratos entries. */
function isKratosEntry(entry: any): boolean {
  if (typeof entry?.command === 'string' && entry.command.includes('kratos ')) return true;
  if (Array.isArray(entry?.hooks)) {
    return entry.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes('kratos '));
  }
  return false;
}

/** Legacy flat entries ({ matcher, command }) that Claude Code never executed. */
function isLegacyEntry(entry: any): boolean {
  return typeof entry?.command === 'string' && !Array.isArray(entry?.hooks);
}

function settingsFilePath(): string {
  return path.join(process.cwd(), '.claude', 'settings.local.json');
}

async function installHooks(): Promise<void> {
  const settingsPath = settingsFilePath();
  await fs.ensureDir(path.dirname(settingsPath));

  let settings: any = {};
  if (await fs.pathExists(settingsPath)) {
    try {
      settings = await fs.readJson(settingsPath);
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) settings.hooks = {};

  let migrated = 0;
  for (const event of HOOK_EVENTS) {
    const existing: any[] = settings.hooks[event] || [];
    migrated += existing.filter((e) => isKratosEntry(e) && isLegacyEntry(e)).length;
    // Drop any prior kratos entries (legacy or current), keep everything else
    const others = existing.filter((e) => !isKratosEntry(e));
    settings.hooks[event] = [...others, ...KRATOS_HOOKS[event]];
  }

  await fs.writeJson(settingsPath, settings, { spaces: 2 });

  Output.success('Kratos hooks installed');
  if (migrated > 0) {
    Output.warn(`Migrated ${migrated} legacy hook entr${migrated === 1 ? 'y' : 'ies'} that Claude Code was ignoring`);
  }
  Output.dim(`Config written to: ${settingsPath}`);
  Output.dim('SessionStart: injects project memory into every session (kratos context)');
  Output.dim('PostToolUse:  captures file edits (Edit/Write/MultiEdit)');
  Output.dim('Stop:         saves a session summary');

  await installCodexHooks();
  await installGitHook();
}

function codexHooksPath(): string {
  return path.join(process.cwd(), '.codex', 'hooks.json');
}

async function installCodexHooks(): Promise<void> {
  const hooksPath = codexHooksPath();
  await fs.ensureDir(path.dirname(hooksPath));

  let config: any = {};
  if (await fs.pathExists(hooksPath)) {
    try {
      config = await fs.readJson(hooksPath);
    } catch {
      config = {};
    }
  }

  if (!config.hooks) config.hooks = {};
  for (const event of Object.keys(KRATOS_CODEX_HOOKS)) {
    const others = (config.hooks[event] || []).filter((e: any) => !isKratosEntry(e));
    config.hooks[event] = [...others, ...KRATOS_CODEX_HOOKS[event]];
  }

  await fs.writeJson(hooksPath, config, { spaces: 2 });
  Output.dim(`Codex:        same hooks written to ${path.relative(process.cwd(), hooksPath)}`);
  Output.dim('              run /hooks inside Codex once to trust them');
}

async function uninstallCodexHooks(): Promise<void> {
  const hooksPath = codexHooksPath();
  if (!await fs.pathExists(hooksPath)) return;

  try {
    const config = await fs.readJson(hooksPath);
    if (!config.hooks) return;

    for (const event of Object.keys(config.hooks)) {
      config.hooks[event] = (config.hooks[event] || []).filter((e: any) => !isKratosEntry(e));
      if (config.hooks[event].length === 0) delete config.hooks[event];
    }

    if (Object.keys(config.hooks).length === 0) delete config.hooks;

    if (Object.keys(config).length === 0) {
      await fs.remove(hooksPath);
    } else {
      await fs.writeJson(hooksPath, config, { spaces: 2 });
    }
    Output.dim('Codex hooks removed');
  } catch {
    // Unreadable — leave it alone
  }
}

async function installGitHook(): Promise<void> {
  const hooksDir = path.join(process.cwd(), '.git', 'hooks');
  if (!await fs.pathExists(path.join(process.cwd(), '.git'))) {
    Output.dim('No .git directory — skipped git post-commit capture');
    return;
  }

  await fs.ensureDir(hooksDir);
  const hookPath = path.join(hooksDir, 'post-commit');

  if (await fs.pathExists(hookPath)) {
    const existing = await fs.readFile(hookPath, 'utf8');
    if (existing.includes(GIT_HOOK_START)) {
      Output.dim('Git post-commit capture already installed');
      return;
    }
    // Preserve the user's existing hook — append our block
    await fs.writeFile(hookPath, existing.trimEnd() + '\n\n' + GIT_HOOK_BLOCK + '\n');
  } else {
    await fs.writeFile(hookPath, '#!/bin/sh\n' + GIT_HOOK_BLOCK + '\n');
  }
  await fs.chmod(hookPath, 0o755);
  Output.dim('Git:          post-commit saves each commit as a memory');
}

async function uninstallGitHook(): Promise<void> {
  const hookPath = path.join(process.cwd(), '.git', 'hooks', 'post-commit');
  if (!await fs.pathExists(hookPath)) return;

  const existing = await fs.readFile(hookPath, 'utf8');
  if (!existing.includes(GIT_HOOK_START)) return;

  const startIdx = existing.indexOf(GIT_HOOK_START);
  const endIdx = existing.indexOf(GIT_HOOK_END);
  if (endIdx === -1) return;

  const cleaned = (existing.slice(0, startIdx) + existing.slice(endIdx + GIT_HOOK_END.length))
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

  // Nothing left but the shebang — remove the file entirely
  if (cleaned.replace(/^#!.*$/m, '').trim() === '') {
    await fs.remove(hookPath);
  } else {
    await fs.writeFile(hookPath, cleaned + '\n');
  }
  Output.dim('Git post-commit capture removed');
}

async function uninstallHooks(): Promise<void> {
  const settingsPath = settingsFilePath();

  if (!await fs.pathExists(settingsPath)) {
    Output.warn('No hooks configuration found');
    return;
  }

  try {
    const settings = await fs.readJson(settingsPath);

    if (!settings.hooks) {
      Output.warn('No hooks found in settings');
      return;
    }

    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = (settings.hooks[event] || []).filter((e: any) => !isKratosEntry(e));
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }

    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    await fs.writeJson(settingsPath, settings, { spaces: 2 });

    Output.success('Kratos hooks removed');
  } catch {
    Output.error('Failed to read settings file');
    process.exit(1);
  }

  await uninstallCodexHooks();
  await uninstallGitHook();
}

async function checkHooksStatus(): Promise<void> {
  const settingsPath = settingsFilePath();

  if (!await fs.pathExists(settingsPath)) {
    Output.info('No hooks installed (no settings file found)');
    return;
  }

  try {
    const settings = await fs.readJson(settingsPath);
    let installed = 0;
    let legacy = 0;

    for (const event of HOOK_EVENTS) {
      const entries: any[] = settings.hooks?.[event] || [];
      for (const entry of entries) {
        if (!isKratosEntry(entry)) continue;
        if (isLegacyEntry(entry)) legacy++;
        else installed++;
      }
    }

    if (installed === 0 && legacy === 0) {
      Output.info('Kratos hooks are NOT installed');
      return;
    }

    if (legacy > 0) {
      Output.warn(`${legacy} kratos hook entr${legacy === 1 ? 'y is' : 'ies are'} in a legacy format Claude Code ignores — run: kratos hooks install`);
    }
    if (installed > 0) {
      Output.success(`Kratos hooks are installed (${installed} active entr${installed === 1 ? 'y' : 'ies'})`);
      for (const event of HOOK_EVENTS) {
        const count = (settings.hooks?.[event] || []).filter(
          (e: any) => isKratosEntry(e) && !isLegacyEntry(e)
        ).length;
        if (count > 0) Output.dim(`${event}: ${count}`);
      }
    }

    const codexPath = codexHooksPath();
    if (await fs.pathExists(codexPath)) {
      try {
        const codexConfig = await fs.readJson(codexPath);
        const codexCount = Object.values(codexConfig.hooks || {})
          .flat()
          .filter((e: any) => isKratosEntry(e)).length;
        if (codexCount > 0) Output.dim(`Codex hooks: ${codexCount} (trust via /hooks in Codex)`);
      } catch {
        // Unreadable codex config — skip
      }
    }

    const gitHookPath = path.join(process.cwd(), '.git', 'hooks', 'post-commit');
    if (await fs.pathExists(gitHookPath)) {
      const content = await fs.readFile(gitHookPath, 'utf8');
      if (content.includes(GIT_HOOK_START)) {
        Output.dim('Git post-commit: installed');
      }
    }
  } catch {
    Output.error('Failed to read settings file');
  }
}
