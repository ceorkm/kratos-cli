import type { CLIContext } from '../core.js';
import { Output } from '../output.js';
import chalk from 'chalk';

export async function askCommand(ctx: CLIContext, question: string, opts: {
  limit?: string;
  json?: boolean;
}): Promise<void> {
  const limit = opts.limit ? parseInt(opts.limit, 10) : 10;

  const parsed = parseNaturalLanguageQuery(question);
  const searchQuery = parsed.searchTerms.join(' ');

  if (!searchQuery) {
    if (opts.json) {
      Output.json({
        question,
        search_query: '',
        count: 0,
        answer: null,
        results: [],
        error: 'Could not extract search terms from your question. Try rephrasing.',
      });
      return;
    }
    Output.warn('Could not extract search terms from your question. Try rephrasing.');
    return;
  }

  // Search with debug info
  const enhanced = ctx.memoryDb.searchWithDebug({
    q: searchQuery,
    k: limit,
  });

  let results = enhanced.results;

  // If no results, try broadening with meaningful words
  if (results.length === 0) {
    const meaningfulTerms = parsed.searchTerms.filter(t => t.length >= 5);
    for (const term of meaningfulTerms) {
      const fallback = ctx.memoryDb.search({ q: term, k: limit });
      if (fallback.length > 0) {
        results = fallback;
        break;
      }
    }
  }

  if (results.length === 0) {
    if (opts.json) {
      Output.json({
        question,
        search_query: searchQuery,
        count: 0,
        answer: null,
        results: [],
      });
      return;
    }
    Output.header(`Answer: "${question}"`);
    Output.dim('No relevant memories found. Try different terms.');
    return;
  }

  if (opts.json) {
    const topResults = results.slice(0, 5);
    Output.json({
      question,
      search_query: searchQuery,
      count: results.length,
      answer: synthesizeAnswer(topResults),
      results: topResults.map(r => ({
        id: r.memory.id,
        summary: r.memory.summary,
        text: r.memory.text,
        tags: r.memory.tags,
        paths: r.memory.paths,
        importance: r.memory.importance,
        created_at: r.memory.created_at,
        updated_at: r.memory.updated_at,
        score: r.score,
        snippet: r.snippet,
      })),
    });
    return;
  }

  // Synthesize an answer from the results
  console.log('');
  console.log(chalk.bold.cyan(`  ${question}`));
  console.log(chalk.dim('  ' + '─'.repeat(Math.min(question.length + 4, 60))));
  console.log('');

  // Build a coherent answer from the top results
  const topResults = results.slice(0, 5);

  // Compose the answer
  if (topResults.length === 1) {
    // Single result — just present it as the answer
    const r = topResults[0];
    console.log(`  ${r.memory.text || r.memory.summary}`);
    if (r.memory.paths && r.memory.paths.length > 0) {
      console.log(chalk.dim(`\n  Files: ${r.memory.paths.join(', ')}`));
    }
  } else {
    // Multiple results — synthesize
    for (let i = 0; i < topResults.length; i++) {
      const r = topResults[i];
      const text = r.memory.text || r.memory.summary;
      const tags = r.memory.tags.filter(t => t !== '__pinned');
      const tagStr = tags.length > 0 ? chalk.dim(` [${tags[0]}]`) : '';
      const paths = r.memory.paths && r.memory.paths.length > 0
        ? chalk.dim(`  → ${r.memory.paths[0]}`)
        : '';

      if (i === 0) {
        // First result — present as the primary answer
        console.log(`  ${text}${tagStr}`);
        if (paths) console.log(paths);
      } else {
        // Additional context
        console.log(`  ${chalk.white('•')} ${text}${tagStr}`);
        if (paths) console.log(`  ${paths}`);
      }
    }
  }

  // Footer
  console.log('');
  console.log(chalk.dim(`  Based on ${results.length} memor${results.length === 1 ? 'y' : 'ies'} | searched: "${searchQuery}"`));
  console.log('');
}

function synthesizeAnswer(results: Array<{ memory: { summary: string; text: string; tags: string[]; paths: string[] } }>): string {
  if (results.length === 0) return '';
  if (results.length === 1) {
    return results[0].memory.text || results[0].memory.summary;
  }

  return results
    .slice(0, 5)
    .map((result, index) => {
      const text = result.memory.text || result.memory.summary;
      return index === 0 ? text : `• ${text}`;
    })
    .join('\n');
}

function parseNaturalLanguageQuery(question: string): {
  searchTerms: string[];
  intent: 'search' | 'list' | 'explain' | 'find';
} {
  const lowerQ = question.toLowerCase();

  const stopWords = new Set([
    'show', 'me', 'all', 'the', 'what', 'how', 'when', 'where', 'why',
    'find', 'get', 'about', 'in', 'on', 'at', 'to', 'for', 'with',
    'by', 'from', 'did', 'do', 'does', 'is', 'are', 'was', 'were',
    'have', 'has', 'had', 'can', 'could', 'would', 'should', 'will',
    'know', 'tell', 'give', 'learned', 'remember', 'recall', 'work',
  ]);

  const words = question
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word.toLowerCase()));

  let intent: 'search' | 'list' | 'explain' | 'find' = 'search';
  if (lowerQ.includes('show me') || lowerQ.includes('list')) intent = 'list';
  else if (lowerQ.includes('explain') || lowerQ.includes('what is')) intent = 'explain';
  else if (lowerQ.includes('find') || lowerQ.includes('where')) intent = 'find';

  return { searchTerms: words, intent };
}
