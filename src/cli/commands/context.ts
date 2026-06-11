import type { CLIContext } from '../core.js';
import { Output } from '../output.js';
import type { Memory } from '../../memory-server/database.js';

interface ContextEntry {
  memory: Memory;
  scope: 'project' | 'global';
}

const DEFAULT_BUDGET_TOKENS = 2000;
const CHARS_PER_TOKEN = 4;

/**
 * Emit a compact, token-budgeted context block built from memories.
 * Designed for SessionStart hook injection: stdout becomes session context.
 * Plain text — chalk is bypassed so hook output stays clean.
 */
export async function contextCommand(ctx: CLIContext, opts: {
  budget?: string;
  json?: boolean;
}): Promise<void> {
  const budgetTokens = opts.budget ? parseInt(opts.budget, 10) : DEFAULT_BUDGET_TOKENS;
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;

  const projectMemories = ctx.projectMemoryDb.getRecent({ k: 100 });
  const globalMemories = ctx.globalMemoryDb.getRecent({ k: 50 });

  const entries: ContextEntry[] = [
    ...projectMemories.map(m => ({ memory: m, scope: 'project' as const })),
    ...globalMemories.map(m => ({ memory: m, scope: 'global' as const })),
  ];

  if (entries.length === 0) {
    if (opts.json) {
      Output.json({ project: ctx.project.name, count: 0, sections: {} });
    }
    // No memories — emit nothing so hooks inject nothing
    return;
  }

  const isPinned = (m: Memory) => m.tags.includes('__pinned');
  const isAutoCapture = (m: Memory) => m.tags.includes('auto-capture');
  const isSessionSummary = (m: Memory) => m.tags.includes('session-summary');

  const pinned = entries.filter(e => isPinned(e.memory));
  const important = entries.filter(e =>
    !isPinned(e.memory) && !isAutoCapture(e.memory) && e.memory.importance >= 4
  ).sort((a, b) => b.memory.importance - a.memory.importance || b.memory.created_at - a.memory.created_at);
  const recent = entries.filter(e =>
    !isPinned(e.memory) && !isAutoCapture(e.memory) && e.memory.importance < 4
  ).sort((a, b) => b.memory.created_at - a.memory.created_at);

  // Latest auto-captured session summary gets one line of its own
  const lastSession = entries
    .filter(e => isSessionSummary(e.memory))
    .sort((a, b) => b.memory.created_at - a.memory.created_at)[0];

  if (opts.json) {
    Output.json({
      project: ctx.project.name,
      count: entries.length,
      sections: {
        pinned: pinned.map(serializeEntry),
        important: important.map(serializeEntry),
        recent: recent.slice(0, 15).map(serializeEntry),
        last_session: lastSession ? serializeEntry(lastSession) : null,
      },
    });
    return;
  }

  const lines: string[] = [];
  lines.push(`# Kratos memory — ${ctx.project.name}`);
  lines.push('Prior knowledge about this project, loaded from local memory. ' +
    'Before solving a problem, check it here first: `kratos search "<topic>"`. ' +
    'After fixing a bug or making a decision, save it: `kratos save "<what + why>" --tags <tags>`.');
  lines.push('');

  let used = lines.join('\n').length;

  const sections: Array<{ title: string; items: ContextEntry[]; max: number }> = [
    { title: 'Pinned', items: pinned, max: pinned.length },
    { title: 'Decisions & fixes', items: important, max: 20 },
    { title: 'Recent', items: recent, max: 10 },
  ];

  for (const section of sections) {
    if (section.items.length === 0) continue;
    const sectionLines: string[] = [`## ${section.title}`];
    let added = 0;

    for (const entry of section.items.slice(0, section.max)) {
      const line = formatEntry(entry);
      if (used + sectionLines.join('\n').length + line.length > budgetChars) break;
      sectionLines.push(line);
      added++;
    }

    if (added > 0) {
      lines.push(...sectionLines, '');
      used = lines.join('\n').length;
    }
  }

  if (lastSession && used + 200 < budgetChars) {
    lines.push(`Last session: ${truncate(lastSession.memory.summary, 160)} (${relativeTime(lastSession.memory.created_at)})`);
  }

  console.log(lines.join('\n').trimEnd());
}

function formatEntry(entry: ContextEntry): string {
  const m = entry.memory;
  const scopeTag = entry.scope === 'global' ? ' [global]' : '';
  const body = m.text && m.text !== m.summary
    ? `${m.summary}: ${truncate(m.text, 200)}`
    : truncate(m.summary, 200);
  return `- ${body}${scopeTag} (${relativeTime(m.created_at)})`;
}

function serializeEntry(entry: ContextEntry) {
  return {
    id: entry.memory.id,
    scope: entry.scope,
    summary: entry.memory.summary,
    text: entry.memory.text,
    tags: entry.memory.tags,
    importance: entry.memory.importance,
    created_at: entry.memory.created_at,
  };
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.substring(0, max - 1) + '…' : oneLine;
}

function relativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
