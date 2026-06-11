import { getScopedMemoryDb, type CLIContext } from '../core.js';
import { Output } from '../output.js';
import chalk from 'chalk';

export async function summaryCommand(ctx: CLIContext, opts: {
  json?: boolean;
  global?: boolean;
} = {}): Promise<void> {
  const memoryDb = getScopedMemoryDb(ctx, opts);
  const scope = memoryDb.getScope();
  const memories = memoryDb.getAll();

  if (memories.length === 0) {
    Output.warn('No memories found. Save some first.');
    return;
  }

  // Get pinned memories
  const pinned = memories.filter(m => m.tags.includes('__pinned'));

  // Key decisions (importance 4-5, not pinned)
  const keyDecisions = memories
    .filter(m => m.importance >= 4 && !m.tags.includes('__pinned'))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 8);

  // Group by PRIMARY tag (first tag only) to avoid duplicates
  const topicMap = new Map<string, typeof memories>();
  const seen = new Set<string>();

  for (const m of memories) {
    if (seen.has(m.id)) continue;
    const primaryTag = m.tags.filter(t => t !== '__pinned')[0];
    if (primaryTag) {
      if (!topicMap.has(primaryTag)) topicMap.set(primaryTag, []);
      topicMap.get(primaryTag)!.push(m);
      seen.add(m.id);
    }
  }

  // Sort topics by memory count
  const topics = [...topicMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8);

  // One-line project overview
  const totalTags = new Set(memories.flatMap(m => m.tags.filter(t => t !== '__pinned')));
  const oldest = new Date(Math.min(...memories.map(m => m.created_at)));
  const newest = new Date(Math.max(...memories.map(m => m.created_at)));
  const recent = memories.slice(0, 5);

  // Most-touched files across all memories
  const pathCounts = new Map<string, number>();
  for (const m of memories) {
    for (const p of m.paths) {
      pathCounts.set(p, (pathCounts.get(p) || 0) + 1);
    }
  }
  const topPaths = [...pathCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  // Prune candidates: old, low-importance, unpinned
  const STALE_AGE_MS = 60 * 24 * 60 * 60 * 1000;
  const staleCutoff = Date.now() - STALE_AGE_MS;
  const stale = memories.filter(m =>
    m.importance <= 2 &&
    m.updated_at < staleCutoff &&
    !m.tags.includes('__pinned')
  );

  if (opts.json) {
    Output.json({
      scope,
      project: ctx.project.name,
      memory_count: memories.length,
      topic_count: totalTags.size,
      date_range: {
        oldest: oldest.toISOString(),
        newest: newest.toISOString(),
      },
      pinned: pinned.map(m => ({
        id: m.id,
        scope,
        summary: m.summary,
        text: m.text,
        tags: m.tags,
      })),
      key_decisions: keyDecisions.map(m => ({
        id: m.id,
        scope,
        summary: m.summary,
        text: m.text,
        tags: m.tags.filter(t => t !== '__pinned'),
        importance: m.importance,
      })),
      topics: topics.map(([tag, mems]) => ({ tag, count: mems.length })),
      top_paths: topPaths.map(([file, count]) => ({ path: file, count })),
      stale: stale.map(m => ({
        id: m.id,
        summary: m.summary,
        importance: m.importance,
        updated_at: m.updated_at,
      })),
      recent: recent.map(m => ({
        id: m.id,
        scope,
        summary: m.summary,
        created_at: m.created_at,
      })),
    });
    return;
  }

  // Build the brief
  console.log('');
  console.log(chalk.bold.cyan(`  ${ctx.project.name.toUpperCase()} — Project Brief`));
  console.log(chalk.dim('  ' + '━'.repeat(40)));
  console.log('');

  console.log(chalk.dim(`  ${memories.length} memories | ${totalTags.size} topics | ${oldest.toLocaleDateString()} — ${newest.toLocaleDateString()}`));
  console.log('');

  // Pinned = critical rules/context
  if (pinned.length > 0) {
    console.log(chalk.bold.yellow('  ALWAYS REMEMBER'));
    for (const m of pinned) {
      console.log(`  ${chalk.yellow('>')} ${m.text || m.summary}`);
    }
    console.log('');
  }

  // Key decisions as a narrative
  if (keyDecisions.length > 0) {
    console.log(chalk.bold.white('  KEY DECISIONS'));
    for (const m of keyDecisions) {
      const tags = m.tags.filter(t => t !== '__pinned');
      const tagStr = tags.length > 0 ? chalk.dim(` [${tags[0]}]`) : '';
      console.log(`  ${chalk.white('•')} ${m.text || m.summary}${tagStr}`);
    }
    console.log('');
  }

  // Topics with counts — compact
  if (topics.length > 0) {
    console.log(chalk.bold.white('  TOPICS'));
    const topicLine = topics
      .map(([tag, mems]) => `${chalk.cyan(tag)}${chalk.dim(`(${mems.length})`)}`)
      .join('  ');
    console.log(`  ${topicLine}`);
    console.log('');
  }

  // Most-touched files — where the project's history concentrates
  if (topPaths.length > 0) {
    console.log(chalk.bold.white('  MOST-TOUCHED FILES'));
    for (const [file, count] of topPaths) {
      console.log(`  ${chalk.dim(String(count).padStart(3))}  ${file}`);
    }
    console.log('');
  }

  // Recent activity — just dates and summaries
  console.log(chalk.bold.white('  RECENT'));
  for (const m of recent) {
    const date = new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    console.log(`  ${chalk.dim(date)}  ${m.summary}`);
  }
  console.log('');

  // Stale memories worth pruning
  if (stale.length > 0) {
    console.log(chalk.bold.white('  PRUNE CANDIDATES'));
    console.log(chalk.dim(`  ${stale.length} low-importance memor${stale.length === 1 ? 'y' : 'ies'} untouched for 60+ days`));
    for (const m of stale.slice(0, 5)) {
      console.log(`  ${chalk.dim(m.id)}  ${m.summary.substring(0, 60)}`);
    }
    if (stale.length > 5) {
      console.log(chalk.dim(`  ... and ${stale.length - 5} more`));
    }
    console.log(chalk.dim('  Remove with: kratos forget <id>'));
    console.log('');
  }
}
