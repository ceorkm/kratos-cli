import type { CLIContext } from '../core.js';
import { Output } from '../output.js';
import chalk from 'chalk';

export async function summaryCommand(ctx: CLIContext): Promise<void> {
  const memories = ctx.memoryDb.getAll();

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

  // Build the brief
  console.log('');
  console.log(chalk.bold.cyan(`  ${ctx.project.name.toUpperCase()} — Project Brief`));
  console.log(chalk.dim('  ' + '━'.repeat(40)));
  console.log('');

  // One-line project overview
  const totalTags = new Set(memories.flatMap(m => m.tags.filter(t => t !== '__pinned')));
  const oldest = new Date(Math.min(...memories.map(m => m.created_at)));
  const newest = new Date(Math.max(...memories.map(m => m.created_at)));
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

  // Recent activity — just dates and summaries
  const recent = memories.slice(0, 5);
  console.log(chalk.bold.white('  RECENT'));
  for (const m of recent) {
    const date = new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    console.log(`  ${chalk.dim(date)}  ${m.summary}`);
  }
  console.log('');
}
