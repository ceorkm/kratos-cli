import type { CLIContext } from '../core.js';
import { Output } from '../output.js';
import chalk from 'chalk';
import type { SearchResult } from '../../memory-server/database.js';

type AskIntent = 'search' | 'list' | 'explain' | 'find';
type AskDomain = 'infra' | 'auth' | 'billing' | 'ops' | 'data' | 'cache';

interface ParsedQuestion {
  intent: AskIntent;
  searchTerms: string[];
  expandedTerms: string[];
  rawTerms: string[];
  domains: AskDomain[];
  normalizedQuestion: string;
}

const STOP_WORDS = new Set([
  'show', 'me', 'all', 'the', 'what', 'how', 'when', 'where', 'why',
  'find', 'get', 'about', 'in', 'on', 'at', 'to', 'for', 'with',
  'by', 'from', 'did', 'do', 'does', 'is', 'are', 'was', 'were',
  'have', 'has', 'had', 'can', 'could', 'would', 'should', 'will',
  'know', 'tell', 'give', 'learned', 'remember', 'recall', 'work',
  'into', 'over', 'after', 'use', 'using', 'anywhere', 'there',
]);

const TOKEN_SYNONYMS: Record<string, string[]> = {
  ssh: ['ssh', 'server', 'vps'],
  vps: ['vps', 'server', 'ssh'],
  server: ['server', 'vps', 'ssh'],
  box: ['box', 'server', 'ssh'],
  boxes: ['boxes', 'server', 'ssh'],
  machine: ['machine', 'server'],
  machines: ['machines', 'server'],
  private: ['private', 'internal'],
  internal: ['internal', 'private'],
  sign: ['sign', 'login', 'auth'],
  login: ['login', 'auth'],
  auth: ['auth', 'login', 'jwt'],
  token: ['token', 'tokens', 'jwt', 'auth'],
  tokens: ['tokens', 'token', 'jwt', 'auth'],
  cookie: ['cookie', 'cookies', 'auth'],
  cookies: ['cookies', 'cookie', 'auth'],
  billing: ['billing', 'webhooks', 'stripe'],
  webhook: ['webhook', 'webhooks', 'stripe'],
  webhooks: ['webhooks', 'webhook', 'stripe'],
  stripe: ['stripe', 'billing', 'webhooks'],
  backup: ['backup', 'backups', 'postgres'],
  backups: ['backups', 'backup', 'postgres'],
  postgres: ['postgres', 'backup', 'backups'],
  redis: ['redis', 'rate', 'locks'],
  rate: ['rate', 'redis', 'limiting'],
  alert: ['alert', 'alerts', 'ops', 'sentry'],
  alerts: ['alerts', 'alert', 'ops', 'sentry'],
  sentry: ['sentry', 'alerts', 'errors'],
};

const PHRASE_SYNONYMS: Array<[RegExp, string[]]> = [
  [/\bsign\s+in(to)?\b/, ['login', 'auth']],
  [/\blog\s+in(to)?\b/, ['login', 'auth']],
  [/\blog\s+into\b/, ['ssh', 'server']],
  [/\benter\s+the\s+box\b/, ['ssh', 'server']],
  [/\benter\s+the\s+server\b/, ['ssh', 'server']],
  [/\bprivate\s+machines?\b/, ['internal', 'boxes', 'tailscale', 'ssh']],
  [/\binternal\s+machines?\b/, ['internal', 'boxes', 'tailscale', 'ssh']],
  [/\baccess\s+the\s+vps\b/, ['ssh', 'vps']],
  [/\baccess\s+the\s+server\b/, ['ssh', 'server']],
  [/\blogin\s+security\b/, ['auth', 'login', 'jwt', 'cookies']],
];

const DOMAIN_KEYWORDS: Record<AskDomain, string[]> = {
  infra: ['ssh', 'server', 'vps', 'box', 'boxes', 'machine', 'machines', 'tailscale', 'docker', 'deploy', 'pm2', 'internal', 'private'],
  auth: ['auth', 'jwt', 'token', 'tokens', 'cookie', 'cookies', 'signin', 'security'],
  billing: ['billing', 'webhook', 'webhooks', 'stripe', 'invoice'],
  ops: ['sentry', 'alert', 'alerts', 'ops', 'monitor', 'errors', 'slack'],
  data: ['postgres', 'backup', 'backups', 'storage', 'database'],
  cache: ['redis', 'rate', 'limiting', 'locks', 'lock', 'ephemeral'],
};

const STRICT_QUERY_TERMS = new Set(['password', 'passphrase', 'secret', 'credential', 'credentials']);

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

  const searchPlan = buildSearchPlan(parsed, limit);
  const results = runAskSearch(ctx, parsed, searchPlan, limit);

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

function parseNaturalLanguageQuery(question: string): ParsedQuestion {
  const lowerQ = question.toLowerCase();
  const normalizedQuestion = normalizeWhitespace(lowerQ.replace(/[^\w\s]/g, ' '));
  const expandedSet = new Set<string>();

  for (const [pattern, expansions] of PHRASE_SYNONYMS) {
    if (pattern.test(lowerQ)) {
      expansions.forEach(term => expandedSet.add(term));
    }
  }

  const rawTerms = normalizedQuestion
    .split(/\s+/)
    .filter(Boolean);

  const words = rawTerms
    .filter(word => word.length > 2 && !STOP_WORDS.has(word));

  for (const word of words) {
    const expansions = TOKEN_SYNONYMS[word] || [word];
    expansions.forEach(term => expandedSet.add(term));
  }

  let intent: AskIntent = 'search';
  if (lowerQ.includes('show me') || lowerQ.includes('list')) intent = 'list';
  else if (lowerQ.includes('explain') || lowerQ.includes('what is')) intent = 'explain';
  else if (lowerQ.includes('find') || lowerQ.includes('where')) intent = 'find';

  const searchTerms = uniquePreservingOrder(words);
  const expandedTerms = uniquePreservingOrder([...searchTerms, ...expandedSet].filter(term => term.length > 2));
  const domains = detectDomains(expandedTerms);

  return { searchTerms, expandedTerms, rawTerms, domains, intent, normalizedQuestion };
}

function buildSearchPlan(parsed: ParsedQuestion, limit: number): string[] {
  const variants: string[] = [];

  if (parsed.searchTerms.length > 0) {
    variants.push(parsed.searchTerms.join(' '));
  }

  if (parsed.expandedTerms.length > 0) {
    variants.push(parsed.expandedTerms.join(' '));
  }

  const strongTerms = parsed.expandedTerms.filter(term => term.length >= 4);
  if (strongTerms.length > 1) {
    variants.push(strongTerms.slice(0, Math.min(5, Math.max(3, limit))).join(' '));
  }

  for (const domain of parsed.domains) {
    const keywords = DOMAIN_KEYWORDS[domain];
    const domainTerms = keywords.filter(keyword => parsed.expandedTerms.includes(keyword));
    const seed = domainTerms.length > 0 ? domainTerms : keywords.slice(0, 3);
    variants.push(uniquePreservingOrder(seed).slice(0, 4).join(' '));
    uniquePreservingOrder(seed).slice(0, 3).forEach(term => variants.push(term));
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

function runAskSearch(ctx: CLIContext, parsed: ParsedQuestion, queries: string[], limit: number): SearchResult[] {
  const merged = new Map<string, SearchResult>();

  queries.forEach((query, index) => {
    const results = ctx.memoryDb.search({ q: query, k: Math.max(limit * 2, 6) });
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

  if (parsed.domains.length > 1) {
    const strongMatches = ranked.filter(result => countSharedDomains(parsed, result) >= Math.min(2, parsed.domains.length));
    if (strongMatches.length === 0) {
      return [];
    }
    return strongMatches;
  }

  const strictTerms = parsed.searchTerms.filter(term => STRICT_QUERY_TERMS.has(term));
  if (strictTerms.length > 0) {
    return ranked.filter(result => {
      const memoryTerms = extractMemoryTerms(result.memory);
      return strictTerms.every(term => memoryTerms.includes(term));
    });
  }

  return ranked;
}

function rerankResult(result: SearchResult, parsed: ParsedQuestion, query: string, queryIndex: number): SearchResult {
  const memoryTerms = extractMemoryTerms(result.memory);
  const overlap = countOverlap(parsed.expandedTerms, memoryTerms);
  const queryTerms = query.split(/\s+/).filter(Boolean);
  const queryOverlap = countOverlap(queryTerms, memoryTerms);
  const memoryDomains = detectDomains(memoryTerms);

  let score = result.score;
  score += Math.min(24, overlap * 8);
  score += Math.min(12, queryOverlap * 4);
  score += Math.max(0, 8 - queryIndex * 2);

  const sharedDomains = parsed.domains.filter(domain => memoryDomains.includes(domain));
  score += sharedDomains.length * 14;

  if (parsed.domains.length > 0 && sharedDomains.length === 0) {
    score -= 28;
  }

  if (parsed.domains.length > 1 && sharedDomains.length < parsed.domains.length) {
    score -= (parsed.domains.length - sharedDomains.length) * 18;
  }

  if (parsed.domains.includes('infra') && !memoryDomains.includes('infra')) {
    score -= 18;
  }
  if (parsed.domains.includes('auth') && !memoryDomains.includes('auth')) {
    score -= 18;
  }

  const strongTerms = parsed.expandedTerms.filter(term => term.length >= 5);
  if (strongTerms.length > 0 && strongTerms.every(term => !memoryTerms.includes(term))) {
    score -= 14;
  }

  return {
    ...result,
    score: Math.max(0, Math.min(100, Math.round(score))),
  };
}

function countSharedDomains(parsed: ParsedQuestion, result: SearchResult): number {
  const memoryDomains = detectDomains(extractMemoryTerms(result.memory));
  return parsed.domains.filter(domain => memoryDomains.includes(domain)).length;
}

function extractMemoryTerms(memory: SearchResult['memory']): string[] {
  const corpus = [memory.summary, memory.text, ...(memory.tags || []), ...(memory.paths || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const raw = normalizeWhitespace(corpus.replace(/[^\w\s]/g, ' '))
    .split(/\s+/)
    .filter(token => token.length > 2);

  const expanded = new Set<string>();
  for (const token of raw) {
    const synonyms = TOKEN_SYNONYMS[token] || [token];
    synonyms.forEach(term => expanded.add(term));
  }

  for (const [pattern, expansions] of PHRASE_SYNONYMS) {
    if (pattern.test(corpus)) {
      expansions.forEach(term => expanded.add(term));
    }
  }

  return uniquePreservingOrder([...raw, ...expanded]);
}

function detectDomains(terms: string[]): AskDomain[] {
  const domainMatches: AskDomain[] = [];
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS) as Array<[AskDomain, string[]]>) {
    if (keywords.some(keyword => terms.includes(keyword))) {
      domainMatches.push(domain);
    }
  }
  return domainMatches;
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
