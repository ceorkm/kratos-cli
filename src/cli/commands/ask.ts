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
  docCount = 0;

  constructor(memories: Memory[]) {
    this.docCount = memories.length;
    memories.forEach((memory, idx) => {
      const corpus = [
        memory.summary,
        memory.text.slice(0, 400),
        ...(memory.tags || []).filter(t => t !== '__pinned'),
        ...(memory.paths || []).map(p => p.split('/').pop() || ''),
      ].join(' ');

      for (const token of new Set(tokenize(corpus).map(singularize))) {
        if (STOP_WORDS.has(token)) continue;
        if (!this.termDocs.has(token)) this.termDocs.set(token, new Set());
        this.termDocs.get(token)!.add(idx);
      }
    });
  }

  /** Document frequency for a term (plural-folded). */
  df(term: string): number {
    return this.termDocs.get(singularize(term))?.size || 0;
  }

  /** Rarity weight: rare terms count for much more than ubiquitous ones. */
  idf(term: string): number {
    const df = this.df(term);
    if (df === 0 || this.docCount === 0) return 0;
    return Math.log(1 + this.docCount / df);
  }

  /** Top co-occurring terms for a query term, strongest associations first. */
  expand(term: string, max = 3): string[] {
    const docs = this.termDocs.get(singularize(term));
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
  why?: boolean;
}): Promise<void> {
  const limit = opts.limit ? parseInt(opts.limit, 10) : 5;
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
  const ranked = runAskSearch(memoryDb, parsed, searchPlan, limit, vocabulary) as AskResult[];
  const results = applyScoreCliff(ranked, limit);
  const confidence = classifyConfidence(results);

  if (results.length === 0) {
    if (opts.json) {
      Output.json({
        question,
        search_query: searchQuery,
        queries_tried: searchPlan,
        count: 0,
        total_matched: 0,
        confidence: 'low',
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
      total_matched: ranked.length,
      confidence,
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
        ...(opts.why ? { why: (r as AskResult).askExplain } : {}),
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
  const confColor = confidence === 'high' ? chalk.green : confidence === 'medium' ? chalk.yellow : chalk.dim;
  console.log(confColor(`  Confidence: ${confidence}`) + chalk.dim(` | ${results.length} memor${results.length === 1 ? 'y' : 'ies'}${ranked.length > results.length ? ` (cut ${ranked.length - results.length} weakly related)` : ''} | searched: "${searchQuery}"`));

  if (opts.why) {
    console.log('');
    console.log(chalk.bold.white('  Why these results:'));
    for (const r of results as AskResult[]) {
      const e = r.askExplain;
      if (!e) continue;
      const directs = e.direct_hits.map(h => `${h.term}(${h.weight})`).join(' ') || 'none';
      const expansions = e.expansion_hits.map(h => `${h.term}→${h.via}`).join(' ') || 'none';
      console.log(chalk.dim(`  [${r.score}] ${r.memory.summary.substring(0, 50)}`));
      console.log(chalk.dim(`        coverage ${e.coverage} | direct: ${directs} | via expansion: ${expansions} | fts ${e.fts_signal}`));
    }
  }
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

// English phrase folds: "sign in" is authentication, not signatures. Applied
// before tokenization so the bare verb doesn't collide with e.g. "signed commits".
const PHRASE_FOLDS: Array<[RegExp, string]> = [
  [/\bsign(?:s|ed|ing)?[\s-]+in(?:to)?\b/g, ' login auth '],
  [/\blog(?:s|ged|ging)?[\s-]+in(?:to)?\b/g, ' login auth '],
];

function parseNaturalLanguageQuery(question: string, vocabulary: LearnedVocabulary): ParsedQuestion {
  let lowerQ = question.toLowerCase();
  for (const [pattern, replacement] of PHRASE_FOLDS) {
    lowerQ = lowerQ.replace(pattern, replacement);
  }
  const normalizedQuestion = normalizeWhitespace(lowerQ.replace(/[^\w\s]/g, ' '));

  const rawTerms = normalizedQuestion
    .split(/\s+/)
    .filter(Boolean);

  const words = tokenize(lowerQ)
    .filter(word => !STOP_WORDS.has(word));

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

interface AskResult extends SearchResult {
  askExplain?: {
    coverage: number;
    direct_hits: Array<{ term: string; weight: number }>;
    expansion_hits: Array<{ term: string; via: string }>;
    fts_signal: number;
  };
}

/**
 * Dynamic cutoff: results after a steep score drop are word-related, not
 * answer-related. 98/92/86/69/66 should stop at 86.
 */
function applyScoreCliff(results: AskResult[], limit: number): AskResult[] {
  if (results.length <= 1) return results.slice(0, limit);
  const kept: AskResult[] = [results[0]];
  for (let i = 1; i < results.length && kept.length < limit; i++) {
    const drop = kept[kept.length - 1].score - results[i].score;
    if (drop > 14 && results[i].score < results[0].score * 0.82) break;
    kept.push(results[i]);
  }
  return kept;
}

type Confidence = 'high' | 'medium' | 'low';

function classifyConfidence(results: AskResult[]): Confidence {
  if (results.length === 0) return 'low';
  const top = results[0];
  const directs = top.askExplain?.direct_hits.length ?? 0;
  if (top.score >= 75 && directs >= 1) return 'high';
  if (top.score >= 55) return 'medium';
  return 'low';
}

function runAskSearch(memoryDb: MemoryDatabase, parsed: ParsedQuestion, queries: string[], limit: number, vocabulary: LearnedVocabulary): SearchResult[] {
  const merged = new Map<string, SearchResult>();

  queries.forEach((query, index) => {
    const results = memoryDb.search({ q: query, k: Math.max(limit * 2, 6) });
    for (const result of results) {
      const reranked = rerankResult(result, parsed, query, index, vocabulary);
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
    // Anchor terms are the rare, information-carrying words of the question
    // (they exist in the corpus but in few memories). A result must cover
    // every anchor; common words and words absent from the corpus are forgiven.
    const anchorCap = Math.max(2, Math.ceil(vocabulary.docCount * 0.2));
    const anchors = parsed.searchTerms.filter(term => {
      const df = vocabulary.df(term);
      return df > 0 && df <= anchorCap;
    });
    if (anchors.length > 0) {
      gated = ranked.filter(result => {
        const memoryTerms = new Set(extractMemoryTerms(result.memory).map(singularize));
        return anchors.every(term => {
          const candidates = parsed.termExpansions.get(term) || [term];
          return candidates.some(candidate => memoryTerms.has(singularize(candidate)));
        });
      });
    }
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

/**
 * Light stemming so "sign" matches "signed"/"signing" and "machines" matches
 * "machine". Both sides are folded identically, so internal consistency
 * matters more than linguistic perfection.
 */
function singularize(term: string): string {
  let t = term;
  if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 5 && t.endsWith('ed')) t = t.slice(0, -2);
  if (t.length > 4 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

function rerankResult(result: SearchResult, parsed: ParsedQuestion, query: string, queryIndex: number, vocabulary: LearnedVocabulary): SearchResult {
  const memoryTerms = new Set(extractMemoryTerms(result.memory).map(singularize));

  // IDF-weighted coverage of the full question: rare terms dominate, common
  // words ("memory", "changed") barely count. Terms absent from the corpus
  // get a neutral weight so questions in unseen vocabulary still rank.
  let totalWeight = 0;
  let matchedWeight = 0;
  const directHits: Array<{ term: string; weight: number }> = [];
  const expansionHits: Array<{ term: string; via: string }> = [];
  for (const term of parsed.searchTerms) {
    const weight = vocabulary.df(term) > 0 ? vocabulary.idf(term) : 1;
    totalWeight += weight;
    if (memoryTerms.has(singularize(term))) {
      // Direct hit: full rarity-weighted credit
      matchedWeight += weight;
      directHits.push({ term, weight: Number(weight.toFixed(2)) });
    } else {
      // Expansion-only hit: capped credit — co-occurrence guesses must not
      // satisfy rare anchor terms cheaply
      const candidates = parsed.termExpansions.get(term) || [term];
      const via = candidates.find(candidate => memoryTerms.has(singularize(candidate)));
      if (via) {
        matchedWeight += Math.min(weight, 1);
        expansionHits.push({ term, via });
      }
    }
  }
  const coverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;

  const expandedOverlap = parsed.expandedTerms
    .filter(term => memoryTerms.has(singularize(term))).length;

  let score = 58 * coverage;
  score += Math.min(12, expandedOverlap * 3);
  score += result.score * 0.22;
  score += Math.max(0, 6 - queryIndex * 2);

  return {
    ...result,
    score: Math.max(0, Math.min(100, Math.round(score))),
    askExplain: {
      coverage: Number(coverage.toFixed(2)),
      direct_hits: directHits,
      expansion_hits: expansionHits,
      fts_signal: Math.round(result.score * 0.22),
    },
  } as AskResult;
}

function extractMemoryTerms(memory: SearchResult['memory']): string[] {
  const corpus = [memory.summary, memory.text, ...(memory.tags || []), ...(memory.paths || [])]
    .filter(Boolean)
    .join(' ');

  return uniquePreservingOrder(tokenize(corpus));
}

function tokenize(value: string): string[] {
  const base = normalizeWhitespace(value.toLowerCase().replace(/[^\w\s]/g, ' '))
    .split(/\s+/)
    .filter(token => token.length > 2);
  // Keep dotted version tokens ("1.8.0") that the split above destroys
  const versions = (value.toLowerCase().match(/\d+(?:\.\d+)+/g) || [])
    .filter(token => token.length > 2);
  return [...base, ...versions];
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
