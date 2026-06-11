import { getScopedMemoryDb, type CLIContext } from '../core.js';
import { Output } from '../output.js';
import chalk from 'chalk';
import type { Memory, MemoryDatabase, SearchResult } from '../../memory-server/database.js';

type AskIntent = 'search' | 'list' | 'explain' | 'find';

interface ParsedQuestion {
  intent: AskIntent;
  searchTerms: string[];
  expandedTerms: string[];
  rawTerms: string[];
  normalizedQuestion: string;
  // Each search term mapped to itself + its synonyms/learned expansions
  termExpansions: Map<string, string[]>;
}

const STOP_WORDS = new Set([
  'show', 'me', 'all', 'the', 'what', 'how', 'when', 'where', 'why',
  'find', 'get', 'about', 'in', 'on', 'at', 'to', 'for', 'with',
  'by', 'from', 'did', 'do', 'does', 'is', 'are', 'was', 'were',
  'have', 'has', 'had', 'can', 'could', 'would', 'should', 'will',
  'know', 'tell', 'give', 'learned', 'remember', 'recall', 'work',
  'into', 'over', 'after', 'use', 'uses', 'used', 'using', 'anywhere', 'there',
  'this', 'that', 'these', 'those', 'and', 'but', 'not', 'you',
  'our', 'your', 'their', 'its', 'his', 'her', 'they', 'them',
  'anything', 'something', 'everything', 'stuff', 'things',
]);

const STRICT_QUERY_TERMS = new Set(['password', 'passphrase', 'secret', 'credential', 'credentials']);

// Language-level synonyms only — universal English/devops words, never product
// or project vocabulary (that's learned from the user's own memories below).
const GENERIC_SYNONYMS: Record<string, string[]> = {
  machine: ['server', 'box', 'host'],
  machines: ['server', 'box', 'host'],
  box: ['server', 'machine', 'host'],
  boxes: ['server', 'machine', 'host'],
  server: ['host', 'machine', 'box'],
  servers: ['host', 'machine', 'box'],
  private: ['internal'],
  internal: ['private'],
  sign: ['auth', 'login'],
  signin: ['auth', 'login'],
  login: ['auth', 'signin'],
  remove: ['delete'],
  delete: ['remove'],
};

/**
 * Vocabulary learned from this project's own memories. Terms that co-occur in
 * saved memories become query expansions — no hardcoded synonym tables, so it
 * adapts to whatever stack the project actually uses.
 */
class LearnedVocabulary {
  private termDocs = new Map<string, Set<number>>();
  private docCount = 0;

  constructor(memories: Memory[]) {
    this.docCount = memories.length;
    memories.forEach((memory, idx) => {
      const corpus = [
        memory.summary,
        memory.text.slice(0, 400),
        ...(memory.tags || []).filter(t => t !== '__pinned'),
        ...(memory.paths || []).map(p => p.split('/').pop() || ''),
      ].join(' ');

      for (const token of new Set(tokenize(corpus))) {
        if (STOP_WORDS.has(token)) continue;
        if (!this.termDocs.has(token)) this.termDocs.set(token, new Set());
        this.termDocs.get(token)!.add(idx);
      }
    });
  }

  /** Top co-occurring terms for a query term, strongest associations first. */
  expand(term: string, max = 3): string[] {
    const docs = this.termDocs.get(term);
    if (!docs || docs.size === 0) return [];

    const scores = new Map<string, number>();
    // Terms in more than half the corpus are too generic to expand with
    const ubiquityCap = Math.max(2, Math.ceil(this.docCount / 2));

    for (const [other, otherDocs] of this.termDocs) {
      if (other === term) continue;
      if (otherDocs.size > ubiquityCap) continue;
      let co = 0;
      for (const doc of docs) {
        if (otherDocs.has(doc)) co++;
      }
      if (co === 0) continue;
      // Need repeated co-occurrence unless the term itself is rare
      if (co < 2 && docs.size > 2) continue;
      // An expansion is only useful if it reaches memories the original term
      // doesn't — reward terms that also appear in other docs
      if (otherDocs.size <= co) continue;
      scores.set(other, co * Math.log(1 + otherDocs.size));
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([t]) => t);
  }
}

export async function askCommand(ctx: CLIContext, question: string, opts: {
  limit?: string;
  json?: boolean;
  global?: boolean;
}): Promise<void> {
  const limit = opts.limit ? parseInt(opts.limit, 10) : 10;
  const memoryDb = getScopedMemoryDb(ctx, opts);

  const vocabulary = new LearnedVocabulary(memoryDb.getAll());
  const parsed = parseNaturalLanguageQuery(question, vocabulary);
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

  const searchPlan = buildSearchPlan(parsed, limit);
  const results = runAskSearch(memoryDb, parsed, searchPlan, limit);

  if (results.length === 0) {
    if (opts.json) {
      Output.json({
        question,
        search_query: searchQuery,
        queries_tried: searchPlan,
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
      queries_tried: searchPlan,
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

function parseNaturalLanguageQuery(question: string, vocabulary: LearnedVocabulary): ParsedQuestion {
  const lowerQ = question.toLowerCase();
  const normalizedQuestion = normalizeWhitespace(lowerQ.replace(/[^\w\s]/g, ' '));

  const rawTerms = normalizedQuestion
    .split(/\s+/)
    .filter(Boolean);

  const words = rawTerms
    .filter(word => word.length > 2 && !STOP_WORDS.has(word));

  // Expand each term: generic English synonyms + vocabulary learned from
  // this project's own memories
  const expandedSet = new Set<string>();
  const termExpansions = new Map<string, string[]>();
  for (const word of words) {
    const expansions = uniquePreservingOrder([
      ...(GENERIC_SYNONYMS[word] || []),
      ...vocabulary.expand(word),
    ]);
    termExpansions.set(word, [word, ...expansions]);
    expansions.forEach(term => expandedSet.add(term));
  }

  let intent: AskIntent = 'search';
  if (lowerQ.includes('show me') || lowerQ.includes('list')) intent = 'list';
  else if (lowerQ.includes('explain') || lowerQ.includes('what is')) intent = 'explain';
  else if (lowerQ.includes('find') || lowerQ.includes('where')) intent = 'find';

  const searchTerms = uniquePreservingOrder(words);
  const expandedTerms = uniquePreservingOrder([...searchTerms, ...expandedSet].filter(term => term.length > 2));

  return { searchTerms, expandedTerms, rawTerms, intent, normalizedQuestion, termExpansions };
}

function buildSearchPlan(parsed: ParsedQuestion, limit: number): string[] {
  const variants: string[] = [];

  if (parsed.searchTerms.length > 0) {
    variants.push(parsed.searchTerms.join(' '));
  }

  if (parsed.expandedTerms.length > parsed.searchTerms.length) {
    variants.push(parsed.expandedTerms.join(' '));
  }

  const strongTerms = parsed.expandedTerms.filter(term => term.length >= 4);
  if (strongTerms.length > 1) {
    variants.push(strongTerms.slice(0, Math.min(5, Math.max(3, limit))).join(' '));
  }

  for (const term of parsed.expandedTerms.filter(term => term.length >= 3)) {
    variants.push(term);
  }

  return uniquePreservingOrder(
    variants
      .map(variant => normalizeWhitespace(variant))
      .filter(variant => variant.length > 0)
  ).slice(0, 8);
}

function runAskSearch(memoryDb: MemoryDatabase, parsed: ParsedQuestion, queries: string[], limit: number): SearchResult[] {
  const merged = new Map<string, SearchResult>();

  queries.forEach((query, index) => {
    const results = memoryDb.search({ q: query, k: Math.max(limit * 2, 6) });
    for (const result of results) {
      const reranked = rerankResult(result, parsed, query, index);
      if (reranked.score < 45) {
        continue;
      }

      const existing = merged.get(reranked.memory.id);
      if (!existing || reranked.score > existing.score) {
        merged.set(reranked.memory.id, reranked);
      }
    }
  });

  const ranked = Array.from(merged.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.memory.importance !== a.memory.importance) return b.memory.importance - a.memory.importance;
      return b.memory.created_at - a.memory.created_at;
    })
    .slice(0, limit);

  // Multi-term questions must be fully covered: every meaningful word (or one
  // of its expansions) has to appear in the memory. Stops cross-topic false
  // positives like "what machine do I ssh to for billing" matching pure-ssh notes.
  let gated = ranked;
  if (parsed.searchTerms.length >= 3) {
    gated = ranked.filter(result => {
      const memoryTerms = new Set(extractMemoryTerms(result.memory).map(singularize));
      return parsed.searchTerms.every(term => {
        const candidates = parsed.termExpansions.get(term) || [term];
        return candidates.some(candidate => memoryTerms.has(singularize(candidate)));
      });
    });
  }

  const strictTerms = parsed.searchTerms.filter(term => STRICT_QUERY_TERMS.has(term));
  if (strictTerms.length > 0) {
    return gated.filter(result => {
      const memoryTerms = extractMemoryTerms(result.memory);
      return strictTerms.every(term => memoryTerms.includes(term));
    });
  }

  return gated;
}

/** Naive plural folding so "machines" covers "machine", "boxes" covers "box". */
function singularize(term: string): string {
  if (term.length > 4 && term.endsWith('es')) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith('s')) return term.slice(0, -1);
  return term;
}

function rerankResult(result: SearchResult, parsed: ParsedQuestion, query: string, queryIndex: number): SearchResult {
  const memoryTerms = extractMemoryTerms(result.memory);
  const overlap = countOverlap(parsed.expandedTerms, memoryTerms);
  const directOverlap = countOverlap(parsed.searchTerms, memoryTerms);
  const queryTerms = query.split(/\s+/).filter(Boolean);
  const queryOverlap = countOverlap(queryTerms, memoryTerms);

  let score = result.score;
  score += Math.min(24, overlap * 8);
  score += Math.min(16, directOverlap * 8);
  score += Math.min(12, queryOverlap * 4);
  score += Math.max(0, 8 - queryIndex * 2);

  const strongTerms = parsed.searchTerms.filter(term => term.length >= 5);
  if (strongTerms.length > 0 && strongTerms.every(term => !memoryTerms.includes(term))) {
    score -= 14;
  }

  return {
    ...result,
    score: Math.max(0, Math.min(100, Math.round(score))),
  };
}

function extractMemoryTerms(memory: SearchResult['memory']): string[] {
  const corpus = [memory.summary, memory.text, ...(memory.tags || []), ...(memory.paths || [])]
    .filter(Boolean)
    .join(' ');

  return uniquePreservingOrder(tokenize(corpus));
}

function tokenize(value: string): string[] {
  return normalizeWhitespace(value.toLowerCase().replace(/[^\w\s]/g, ' '))
    .split(/\s+/)
    .filter(token => token.length > 2);
}

function countOverlap(sourceTerms: string[], targetTerms: string[]): number {
  const target = new Set(targetTerms);
  return uniquePreservingOrder(sourceTerms).filter(term => target.has(term)).length;
}

function uniquePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
