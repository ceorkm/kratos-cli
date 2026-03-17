import type { CLIContext } from '../core.js';
import { Output } from '../output.js';
import type { SearchResult } from '../../memory-server/database.js';

export async function searchCommand(ctx: CLIContext, query: string, opts: {
  limit?: string;
  tags?: string;
  debug?: boolean;
  pathMatch?: boolean;
  json?: boolean;
}): Promise<void> {
  const k = opts.limit ? parseInt(opts.limit, 10) : 10;
  const tags = opts.tags ? opts.tags.split(',').map(t => t.trim()) : undefined;

  if (opts.debug) {
    const enhanced = ctx.memoryDb.searchWithDebug({
      q: query,
      k,
      tags,
      require_path_match: opts.pathMatch,
    });

    if (opts.json) {
      Output.json({
        query,
        count: enhanced.results.length,
        results: serializeResults(enhanced.results),
        debug_info: enhanced.debug_info,
      });
      return;
    }

    Output.header(`Search results for "${query}"`);
    Output.dim(`Found ${enhanced.results.length} results in ${enhanced.debug_info.search_time_ms}ms`);
    if (enhanced.debug_info.fallback_used) {
      Output.warn(`Fallback used: ${enhanced.debug_info.fallback_used}`);
    }

    renderResults(enhanced.results);
  } else {
    const results = ctx.memoryDb.search({
      q: query,
      k,
      tags,
      require_path_match: opts.pathMatch,
    });

    if (opts.json) {
      Output.json({
        query,
        count: results.length,
        results: serializeResults(results),
      });
      return;
    }

    Output.header(`Search results for "${query}"`);
    Output.dim(`Found ${results.length} results`);

    renderResults(results);
  }
}

function serializeResults(results: SearchResult[]) {
  return results.map(r => ({
    id: r.memory.id,
    summary: r.memory.summary,
    text: r.memory.text,
    tags: r.memory.tags,
    paths: r.memory.paths,
    importance: r.memory.importance,
    created_at: r.memory.created_at,
    updated_at: r.memory.updated_at,
    ttl: r.memory.ttl,
    score: r.score,
    snippet: r.snippet,
    matched_terms: r.explain?.matched_terms || [],
    matched_fields: r.explain?.matched_fields || [],
    exact_tag_match: r.explain?.exact_tag_match || false,
    exact_summary_match: r.explain?.exact_summary_match || false,
    phrase_match: r.explain?.phrase_match || false,
    concept_coverage: r.explain?.concept_coverage ?? 0,
  }));
}

function renderResults(results: SearchResult[]): void {
  for (const r of results) {
    Output.memoryCard({
      id: r.memory.id,
      summary: r.memory.summary,
      text: r.memory.text,
      tags: r.memory.tags,
      paths: r.memory.paths,
      importance: r.memory.importance,
      created_at: r.memory.created_at,
      score: r.score,
      snippet: r.snippet,
    });
  }
}
