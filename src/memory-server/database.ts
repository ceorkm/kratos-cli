import Database from 'better-sqlite3';
import path from 'path';
import fs from 'node:fs';
import crypto from 'crypto';

export interface Memory {
  id: string;
  project_id: string;
  summary: string;
  text: string;
  tags: string[];
  paths: string[];
  importance: number;
  created_at: number;
  updated_at: number;
  ttl?: number;
  expires_at?: number;
}

export interface SearchResult {
  memory: Memory;
  score: number;
  snippet?: string;
  explain?: {
    matched_terms: string[];
    matched_fields: string[];
    exact_tag_match: boolean;
    exact_summary_match: boolean;
    phrase_match: boolean;
    concept_coverage: number;
  };
}

export interface EnhancedSearchResult {
  results: SearchResult[];
  debug_info: {
    original_query: string;
    queries_tried: string[];
    fallback_used?: string;
    total_memories_scanned: number;
    search_time_ms: number;
  };
}

export class MemoryDatabase {
  private db: Database.Database;
  private projectId: string;
  private projectRoot: string;
  constructor(projectRoot: string, projectId: string) {
    this.projectRoot = projectRoot;
    this.projectId = projectId;

    const kratosHome = path.join(process.env.HOME || process.env.USERPROFILE || '', '.kratos');
    const dbDir = path.join(kratosHome, 'projects', projectId, 'databases');
    const dbPath = path.join(dbDir, 'memories.db');

    // Only mkdir if needed
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const isNew = !fs.existsSync(dbPath);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.pragma('foreign_keys = ON');

    // Keep schema and FTS triggers healthy for both new and existing databases.
    if (isNew) {
      this.initializeSchema();
    } else {
      this.ensureSchema();
    }
    // No setInterval — CLI commands are one-shot
  }

  private initializeSchema() {
    // Main memories table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        text TEXT NOT NULL,
        tags TEXT DEFAULT '[]',
        paths TEXT DEFAULT '[]',
        importance INTEGER DEFAULT 3 CHECK(importance >= 1 AND importance <= 5),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ttl INTEGER,
        expires_at INTEGER,
        dedupe_hash TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_mem_project ON memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_mem_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mem_dedupe ON memories(dedupe_hash);
    `);

    this.ensureFTSInfrastructure();
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        text TEXT NOT NULL,
        tags TEXT DEFAULT '[]',
        paths TEXT DEFAULT '[]',
        importance INTEGER DEFAULT 3 CHECK(importance >= 1 AND importance <= 5),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ttl INTEGER,
        expires_at INTEGER,
        dedupe_hash TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_mem_project ON memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_mem_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mem_dedupe ON memories(dedupe_hash);
    `);

    this.ensureFTSInfrastructure();
  }

  private ensureFTSInfrastructure() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
        summary,
        text,
        tags,
        content='memories',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      DROP TRIGGER IF EXISTS mem_fts_insert;
      DROP TRIGGER IF EXISTS mem_fts_delete;
      DROP TRIGGER IF EXISTS mem_fts_update;

      CREATE TRIGGER mem_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO mem_fts(rowid, summary, text, tags)
        VALUES (new.rowid, new.summary, new.text,
                CASE WHEN json_array_length(new.tags) > 0
                     THEN (SELECT group_concat(value, ' ') FROM json_each(new.tags))
                     ELSE ''
                END);
      END;

      CREATE TRIGGER mem_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, summary, text, tags)
        VALUES ('delete', old.rowid, old.summary, old.text,
                CASE WHEN json_array_length(old.tags) > 0
                     THEN (SELECT group_concat(value, ' ') FROM json_each(old.tags))
                     ELSE ''
                END);
      END;

      CREATE TRIGGER mem_fts_update AFTER UPDATE ON memories BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, summary, text, tags)
        VALUES ('delete', old.rowid, old.summary, old.text,
                CASE WHEN json_array_length(old.tags) > 0
                     THEN (SELECT group_concat(value, ' ') FROM json_each(old.tags))
                     ELSE ''
                END);
        INSERT INTO mem_fts(rowid, summary, text, tags)
        VALUES (new.rowid, new.summary, new.text,
                CASE WHEN json_array_length(new.tags) > 0
                     THEN (SELECT group_concat(value, ' ') FROM json_each(new.tags))
                     ELSE ''
                END);
      END;
    `);

    this.db.exec(`INSERT INTO mem_fts(mem_fts) VALUES ('rebuild');`);
  }

  // No background timers — CLI is one-shot. Cleanup runs on save.

  save(params: {
    summary: string;
    text: string;
    tags?: string[];
    paths?: string[];
    importance?: number;
    ttl?: number;
  }): { id: string } {
    // Project isolation is enforced by the database path itself
    // Each project has its own database file, so no cross-contamination is possible

    const now = Date.now();
    const id = this.generateId();

    // Compute dedupe hash
    const dedupeHash = this.computeDedupeHash(params.summary, params.paths || []);

    // Check for duplicates
    const existing = this.db.prepare(
      'SELECT id FROM memories WHERE dedupe_hash = ? AND project_id = ?'
    ).get(dedupeHash, this.projectId);

    if (existing && typeof existing === 'object' && 'id' in existing) {
      // Duplicate — update existing
      return this._update((existing as any).id as string, params);
    }

    // Calculate expiration
    const expires_at = params.ttl ? now + (params.ttl * 1000) : null;

    const stmt = this.db.prepare(`
      INSERT INTO memories (
        id, project_id, summary, text, tags, paths,
        importance, created_at, updated_at, ttl, expires_at, dedupe_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      this.projectId,
      params.summary,
      params.text,
      JSON.stringify(params.tags || []),
      JSON.stringify(params.paths || []),
      params.importance || 3,
      now,
      now,
      params.ttl || null,
      expires_at,
      dedupeHash
    );

    // Cleanup expired on save (instead of background timer)
    this.cleanupExpired();

    // Return the complete memory object
    const memory: Memory = {
      id,
      project_id: this.projectId,
      summary: params.summary,
      text: params.text,
      tags: params.tags || [],
      paths: params.paths || [],
      importance: params.importance || 3,
      created_at: now,
      updated_at: now,
      ttl: params.ttl,
      expires_at: expires_at || undefined
    };

    return memory;
  }

  search(params: {
    q: string;
    k?: number;
    require_path_match?: boolean;
    tags?: string[];
    include_expired?: boolean;
  }): SearchResult[] {
    const k = params.k || 10;

    // Try primary search
    try {
      const results = this.executeSearch(params);
      if (results.length > 0) {
        return results;
      }
    } catch (error) {
      // Primary search failed, try fallbacks
      console.warn('Primary search failed, trying fallbacks:', error);
    }

    // Fallback 1: Try without special characters
    if (params.q.match(/[^\w\s]/)) {
      try {
        const fallbackQuery = params.q.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const results = this.executeSearch({...params, q: fallbackQuery, rankingQuery: params.q});
        if (results.length > 0) {
          return results;
        }
      } catch (error) {
        console.warn('Fallback 1 failed:', error);
      }
    }

    // Fallback 2: Try prefix search — only for longer words (6+ chars) to avoid false matches
    const words = params.q.split(/\s+/).filter(word => word.length > 2);
    const longWords = words.filter(w => w.length >= 6);
    if (longWords.length > 0) {
      try {
        // Use first 5 chars as prefix — specific enough to avoid junk matches
        const prefixQuery = longWords.map(w => w.substring(0, 5) + '*').join(' OR ');
        const results = this.executeSearch({...params, q: prefixQuery, rankingQuery: params.q});
        if (results.length > 0) {
          return results;
        }
      } catch {
        // continue
      }
    }

    // Fallback 3: Try meaningful words only (5+ chars, OR search)
    const meaningfulWords = words.filter(w => w.length >= 5);
    if (meaningfulWords.length > 0) {
      try {
        const orQuery = meaningfulWords.join(' OR ');
        const results = this.executeSearch({...params, q: orQuery, rankingQuery: params.q});
        if (results.length > 0) {
          return results;
        }
      } catch {
        // continue
      }
    }

    // Fallback 4: Try the longest word only
    if (words.length > 0) {
      const longest = words.sort((a, b) => b.length - a.length)[0];
      try {
        const results = this.executeSearch({...params, q: longest, rankingQuery: params.q});
        return results;
      } catch {
        // all failed
      }
    }

    return [];
  }

  searchWithDebug(params: {
    q: string;
    k?: number;
    require_path_match?: boolean;
    tags?: string[];
    include_expired?: boolean;
  }): EnhancedSearchResult {
    const startTime = Date.now();
    const queries_tried: string[] = [];
    let fallback_used: string | undefined;

    // Try primary search
    queries_tried.push(params.q);
    try {
      const results = this.executeSearch(params);
      if (results.length > 0) {
        return {
          results,
          debug_info: {
            original_query: params.q,
            queries_tried,
            search_time_ms: Date.now() - startTime,
            total_memories_scanned: this.getTotalMemoryCount()
          }
        };
      }
    } catch (error) {
      // Continue to fallbacks
    }

    // Fallback 1: Try without special characters
    if (params.q.match(/[^\w\s]/)) {
      const fallbackQuery = params.q.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
      queries_tried.push(fallbackQuery);
      try {
        const results = this.executeSearch({...params, q: fallbackQuery, rankingQuery: params.q});
        if (results.length > 0) {
          return {
            results,
            debug_info: {
              original_query: params.q,
              queries_tried,
              fallback_used: 'removed_special_chars',
              search_time_ms: Date.now() - startTime,
              total_memories_scanned: this.getTotalMemoryCount()
            }
          };
        }
      } catch (error) {
        // Continue to next fallback
      }
    }

    // Fallback 2: Try prefix search — only for longer words (6+ chars)
    const words = params.q.split(/\s+/).filter(word => word.length > 2);
    const longWords = words.filter(w => w.length >= 6);
    if (longWords.length > 0) {
      const prefixQuery = longWords.map(w => w.substring(0, 5) + '*').join(' OR ');
      queries_tried.push(prefixQuery);
      try {
        const results = this.executeSearch({...params, q: prefixQuery, rankingQuery: params.q});
        if (results.length > 0) {
          return {
            results,
            debug_info: {
              original_query: params.q,
              queries_tried,
              fallback_used: 'prefix_search',
              search_time_ms: Date.now() - startTime,
              total_memories_scanned: this.getTotalMemoryCount()
            }
          };
        }
      } catch {
        // Continue to next fallback
      }
    }

    // Fallback 3: Try meaningful words only (5+ chars, OR search)
    const meaningfulWords = words.filter(w => w.length >= 5);
    if (meaningfulWords.length > 0) {
      const orQuery = meaningfulWords.join(' OR ');
      queries_tried.push(orQuery);
      try {
        const results = this.executeSearch({...params, q: orQuery, rankingQuery: params.q});
        if (results.length > 0) {
          return {
            results,
            debug_info: {
              original_query: params.q,
              queries_tried,
              fallback_used: 'or_search',
              search_time_ms: Date.now() - startTime,
              total_memories_scanned: this.getTotalMemoryCount()
            }
          };
        }
      } catch {
        // Continue to next fallback
      }
    }

    // Fallback 4: Try the longest word only
    if (words.length > 0) {
      const longest = [...words].sort((a, b) => b.length - a.length)[0];
      queries_tried.push(longest);
      try {
        const results = this.executeSearch({...params, q: longest, rankingQuery: params.q});
        return {
          results,
          debug_info: {
            original_query: params.q,
            queries_tried,
            fallback_used: 'broad_search',
            search_time_ms: Date.now() - startTime,
            total_memories_scanned: this.getTotalMemoryCount()
          }
        };
      } catch {
        // All fallbacks failed
      }
    }

    return {
      results: [],
      debug_info: {
        original_query: params.q,
        queries_tried,
        fallback_used: 'all_failed',
        search_time_ms: Date.now() - startTime,
        total_memories_scanned: this.getTotalMemoryCount()
      }
    };
  }

  private getTotalMemoryCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE project_id = ?');
    const result = stmt.get(this.projectId) as any;
    return result.count;
  }

  private executeSearch(params: {
    q: string;
    k?: number;
    require_path_match?: boolean;
    tags?: string[];
    include_expired?: boolean;
    rankingQuery?: string;
  }): SearchResult[] {
    const k = params.k || 10;
    const now = Date.now();

    // Build FTS query
    let query = `
      SELECT
        m.*,
        bm25(mem_fts) as fts_score,
        snippet(mem_fts, 0, '[', ']', '...', 32) as snippet
      FROM memories m
      JOIN mem_fts ON m.rowid = mem_fts.rowid
      WHERE mem_fts MATCH ?
        AND m.project_id = ?
    `;

    const queryParams: any[] = [this.escapeQuery(params.q), this.projectId];

    // Add expiration filter
    if (!params.include_expired) {
      query += ' AND (m.expires_at IS NULL OR m.expires_at > ?)';
      queryParams.push(now);
    }

    // Add tag filter
    if (params.tags && params.tags.length > 0) {
      query += ' AND EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value IN (' +
        params.tags.map(() => '?').join(',') + '))';
      queryParams.push(...params.tags);
    }

    // Add path matching filter
    if (params.require_path_match) {
      // Filter by paths that exist relative to current working directory
      const cwd = process.cwd();

      // Use EXISTS to check if any path in the JSON array exists relative to cwd
      query += ` AND EXISTS (
        SELECT 1 FROM json_each(m.paths) as path_item
        WHERE
          -- Check if it's an absolute path under cwd
          (path_item.value LIKE ? || '%') OR
          -- Check if it's a relative path that exists from cwd
          (path_item.value NOT LIKE '/%' AND path_item.value NOT LIKE 'C:%' AND path_item.value NOT LIKE '~%')
      )`;
      queryParams.push(cwd + '/');
    }

    // Pinned memories (__pinned tag) surface first
    query += ` ORDER BY (CASE WHEN m.tags LIKE '%__pinned%' THEN 0 ELSE 1 END), fts_score DESC, m.importance DESC, m.created_at DESC LIMIT ?`;
    queryParams.push(k);

    const stmt = this.db.prepare(query);
    const results = stmt.all(...queryParams) as any[];

    // Compute meaningful relevance scores based on term overlap and match quality.
    const queryTerms = this.normalizeSearchTerms(params.rankingQuery || params.q);
    const normalizedPhrase = queryTerms.join(' ');

    const scoredResults = results.map(row => {
      const memory = this.rowToMemory(row);
      const summary = memory.summary.toLowerCase();
      const text = memory.text.toLowerCase();
      const tags = memory.tags.map(tag => tag.toLowerCase());
      const paths = memory.paths.map(p => p.toLowerCase());
      const content = `${summary} ${text} ${tags.join(' ')} ${paths.join(' ')}`;

      const matchedTerms = new Set<string>();
      const matchedFields = new Set<string>();
      let exactTagMatch = false;
      let exactSummaryMatch = false;

      for (const term of queryTerms) {
        let matched = false;

        if (tags.some(tag => tag === term || tag.includes(term))) {
          matched = true;
          matchedTerms.add(term);
          matchedFields.add('tags');
          if (tags.some(tag => tag === term)) exactTagMatch = true;
        }
        if (summary.includes(term)) {
          matched = true;
          matchedTerms.add(term);
          matchedFields.add('summary');
          if (summary.split(/\W+/).includes(term)) exactSummaryMatch = true;
        }
        if (paths.some(p => p.includes(term))) {
          matched = true;
          matchedTerms.add(term);
          matchedFields.add('paths');
        }
        if (text.includes(term)) {
          matched = true;
          matchedTerms.add(term);
          matchedFields.add('text');
        }

        if (!matched && content.includes(term)) {
          matchedTerms.add(term);
        }
      }

      const conceptCoverage = queryTerms.length > 0 ? matchedTerms.size / queryTerms.length : 0;
      const phraseMatch = normalizedPhrase.length > 0 && (
        summary.includes(normalizedPhrase) ||
        text.includes(normalizedPhrase) ||
        tags.join(' ').includes(normalizedPhrase)
      );

      let fieldBoost = 0;
      if (matchedFields.has('tags')) fieldBoost += 0.22;
      if (matchedFields.has('summary')) fieldBoost += 0.16;
      if (matchedFields.has('paths')) fieldBoost += 0.1;
      if (phraseMatch) fieldBoost += 0.12;
      if (exactTagMatch) fieldBoost += 0.08;
      if (exactSummaryMatch) fieldBoost += 0.06;

      const importanceBoost = (memory.importance - 1) / 4 * 0.12;
      const coverageBoost = conceptCoverage * 0.32;
      const baseFtsSignal = Math.min(0.28, Math.max(0, (-1 * Number(row.fts_score || 0)) * 0.04));

      const score = Math.min(1, coverageBoost + fieldBoost + importanceBoost + baseFtsSignal);

      return {
        memory,
        score: Math.round(score * 100), // 0-100%
        snippet: row.snippet,
        explain: {
          matched_terms: Array.from(matchedTerms),
          matched_fields: Array.from(matchedFields),
          exact_tag_match: exactTagMatch,
          exact_summary_match: exactSummaryMatch,
          phrase_match: phraseMatch,
          concept_coverage: Number(conceptCoverage.toFixed(2)),
        }
      };
    });

    return scoredResults.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.memory.importance !== a.memory.importance) return b.memory.importance - a.memory.importance;
      return b.memory.created_at - a.memory.created_at;
    });
  }

  private normalizeSearchTerms(query: string): string[] {
    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  getRecent(params: {
    k?: number;
    path_prefix?: string;
    include_expired?: boolean;
  }): Memory[] {
    const k = params.k || 10;
    const now = Date.now();

    let query = `
      SELECT * FROM memories
      WHERE project_id = ?
    `;
    const queryParams: any[] = [this.projectId];

    if (!params.include_expired) {
      query += ' AND (expires_at IS NULL OR expires_at > ?)';
      queryParams.push(now);
    }

    if (params.path_prefix) {
      query += ` AND EXISTS (
        SELECT 1 FROM json_each(paths)
        WHERE value LIKE ? || '%'
      )`;
      queryParams.push(params.path_prefix);
    }

    query += ` ORDER BY
      (CASE WHEN tags LIKE '%"__pinned"%' THEN 0 ELSE 1 END),
      created_at DESC
      LIMIT ?`;
    queryParams.push(k);

    const stmt = this.db.prepare(query);
    const results = stmt.all(...queryParams) as any[];

    return results.map(row => this.rowToMemory(row));
  }

  // Get a single memory by ID with full text
  get(id: string): Memory | null {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE id = ? AND project_id = ?
    `);

    const result = stmt.get(id, this.projectId) as any;

    if (!result) {
      return null;
    }

    return this.rowToMemory(result);
  }

  // Get multiple memories by IDs (bulk operation)
  getMultiple(ids: string[]): { [id: string]: Memory | null } {
    const result: { [id: string]: Memory | null } = {};

    if (ids.length === 0) {
      return result;
    }

    // Build query with placeholders for all IDs
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE id IN (${placeholders}) AND project_id = ?
    `);

    const queryParams = [...ids, this.projectId];
    const results = stmt.all(...queryParams) as any[];

    // Initialize all IDs as null (not found)
    ids.forEach(id => {
      result[id] = null;
    });

    // Fill in found memories
    results.forEach(row => {
      const memory = this.rowToMemory(row);
      result[memory.id] = memory;
    });

    return result;
  }

  forget(id: string): { ok: boolean; message?: string } {
    try {
      // Project isolation is enforced - each project has its own database

      // Check if memory exists first
      const checkStmt = this.db.prepare('SELECT id FROM memories WHERE id = ? AND project_id = ?');
      const exists = checkStmt.get(id, this.projectId);

      if (!exists) {
        return {
          ok: false,
          message: `Memory ${id} not found in project ${this.projectId}`
        };
      }

      // Delete from main table
      const stmt = this.db.prepare('DELETE FROM memories WHERE id = ? AND project_id = ?');
      const result = stmt.run(id, this.projectId);

      // deleted
      return {
        ok: result.changes > 0,
        message: result.changes > 0 ? 'Memory deleted successfully' : 'Memory not found'
      };
    } catch (error: any) {
      // Failed to delete
      return {
        ok: false,
        message: `Error: ${error.message}`
      };
    }
  }

  updateMemory(id: string, params: {
    summary?: string;
    text?: string;
    tags?: string[];
    paths?: string[];
    importance?: number;
  }): { ok: boolean; id: string; message?: string } {
    // Check exists first
    const existing = this.get(id);
    if (!existing) {
      return { ok: false, id, message: `Memory ${id} not found` };
    }

    const result = this._update(id, params);
    return { ok: true, id: result.id };
  }

  pin(id: string, pinned: boolean): { ok: boolean; message?: string } {
    const existing = this.get(id);
    if (!existing) {
      return { ok: false, message: `Memory ${id} not found` };
    }

    // Use importance 5 for pinned, restore original otherwise
    // We store pin state via a special tag
    const tags = existing.tags.filter(t => t !== '__pinned');
    if (pinned) tags.push('__pinned');

    this.db.prepare('UPDATE memories SET tags = ?, updated_at = ? WHERE id = ? AND project_id = ?')
      .run(JSON.stringify(tags), Date.now(), id, this.projectId);

    return { ok: true, message: pinned ? 'Memory pinned' : 'Memory unpinned' };
  }

  getAll(): Memory[] {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE project_id = ? ORDER BY created_at DESC');
    const results = stmt.all(this.projectId) as any[];
    return results.map(row => this.rowToMemory(row));
  }

  private _update(id: string, params: Partial<Memory>): { id: string } {
    const now = Date.now();
    const updates: string[] = ['updated_at = ?'];
    const values: any[] = [now];

    if (params.summary !== undefined) {
      updates.push('summary = ?');
      values.push(params.summary);
    }
    if (params.text !== undefined) {
      updates.push('text = ?');
      values.push(params.text);
    }
    if (params.tags !== undefined) {
      updates.push('tags = ?');
      values.push(JSON.stringify(params.tags));
    }
    if (params.paths !== undefined) {
      updates.push('paths = ?');
      values.push(JSON.stringify(params.paths));
    }
    if (params.importance !== undefined) {
      updates.push('importance = ?');
      values.push(params.importance);
    }

    values.push(id, this.projectId);

    const stmt = this.db.prepare(`
      UPDATE memories
      SET ${updates.join(', ')}
      WHERE id = ? AND project_id = ?
    `);

    stmt.run(...values);
    return { id };
  }

  private cleanupExpired() {
    const now = Date.now();
    const stmt = this.db.prepare('DELETE FROM memories WHERE expires_at < ?');
    const result = stmt.run(now);

    if (result.changes > 0) {
      // Cleaned up expired memories
    }
  }

  searchPreview(params: {
    q: string;
    k?: number;
    require_path_match?: boolean;
    tags?: string[];
    include_expired?: boolean;
  }): {
    preview: {
      would_return: number;
      search_explanation: string;
      query_breakdown: {
        original: string;
        processed: string;
        terms: string[];
        filters_applied: string[];
      };
      match_examples: Array<{
        summary: string;
        match_reason: string;
        score_estimate: string;
      }>;
    };
    suggestions: string[];
  } {
    const startTime = Date.now();
    const now = Date.now();
    const k = params.k || 10;

    // Process query the same way as real search
    const escapedQuery = this.escapeQuery(params.q);
    const terms = params.q.toLowerCase().split(/\s+/).filter(t => t.length > 0);

    let filtersApplied: string[] = [];
    let baseQuery = `
      SELECT COUNT(*) as total_matches,
             m.summary,
             bm25(mem_fts) as fts_score,
             snippet(mem_fts, 0, '[', ']', '...', 32) as snippet
      FROM memories m
      JOIN mem_fts ON m.rowid = mem_fts.rowid
      WHERE mem_fts MATCH ?
        AND m.project_id = ?
    `;

    let queryParams: any[] = [escapedQuery, this.projectId];

    // Apply filters same as real search
    if (!params.include_expired) {
      baseQuery += ' AND (m.expires_at IS NULL OR m.expires_at > ?)';
      queryParams.push(now);
      filtersApplied.push('Excluding expired memories');
    }

    if (params.tags && params.tags.length > 0) {
      const tagConditions = params.tags.map(() => 'json_extract(m.tags, ?) IS NOT NULL').join(' AND ');
      baseQuery += ` AND (${tagConditions})`;
      params.tags.forEach((tag, i) => queryParams.push(`$[${i}]`));
      filtersApplied.push(`Filtering by tags: ${params.tags.join(', ')}`);
    }

    if (params.require_path_match) {
      const cwd = process.cwd();
      baseQuery += ` AND EXISTS (
        SELECT 1 FROM json_each(m.paths) as path_item
        WHERE
          (path_item.value LIKE ? || '%') OR
          (path_item.value NOT LIKE '/%' AND path_item.value NOT LIKE 'C:%' AND path_item.value NOT LIKE '~%')
      )`;
      queryParams.push(cwd + '/');
      filtersApplied.push(`Requiring path match for current directory`);
    }

    // Build separate queries for count and samples
    let countQuery = `
      SELECT COUNT(*) as total_matches
      FROM memories m
      JOIN mem_fts ON m.rowid = mem_fts.rowid
      WHERE mem_fts MATCH ?
        AND m.project_id = ?
    `;

    let sampleQuery = `
      SELECT m.summary,
             bm25(mem_fts) as fts_score,
             snippet(mem_fts, 0, '[', ']', '...', 32) as snippet
      FROM memories m
      JOIN mem_fts ON m.rowid = mem_fts.rowid
      WHERE mem_fts MATCH ?
        AND m.project_id = ?
    `;

    // Apply the same filters to both queries
    const countParams = [...queryParams];
    const sampleParams = [...queryParams];

    if (!params.include_expired) {
      countQuery += ' AND (m.expires_at IS NULL OR m.expires_at > ?)';
      sampleQuery += ' AND (m.expires_at IS NULL OR m.expires_at > ?)';
    }

    if (params.tags && params.tags.length > 0) {
      const tagConditions = params.tags.map(() => 'json_extract(m.tags, ?) IS NOT NULL').join(' AND ');
      countQuery += ` AND (${tagConditions})`;
      sampleQuery += ` AND (${tagConditions})`;
    }

    if (params.require_path_match) {
      const cwd = process.cwd();

      countQuery += ` AND EXISTS (
        SELECT 1 FROM json_each(m.paths) as path_item
        WHERE
          (path_item.value LIKE ? || '%') OR
          (path_item.value NOT LIKE '/%' AND path_item.value NOT LIKE 'C:%' AND path_item.value NOT LIKE '~%')
      )`;
      countParams.push(cwd + '/');

      sampleQuery += ` AND EXISTS (
        SELECT 1 FROM json_each(m.paths) as path_item
        WHERE
          (path_item.value LIKE ? || '%') OR
          (path_item.value NOT LIKE '/%' AND path_item.value NOT LIKE 'C:%' AND path_item.value NOT LIKE '~%')
      )`;
      sampleParams.push(cwd + '/');
    }

    sampleQuery += ` ORDER BY bm25(mem_fts) LIMIT 3`;

    const countStmt = this.db.prepare(countQuery);
    const sampleStmt = this.db.prepare(sampleQuery);

    let totalMatches = 0;
    let sampleResults: any[] = [];

    try {
      const countResult = countStmt.get(...countParams) as any;
      totalMatches = countResult?.total_matches || 0;

      if (totalMatches > 0) {
        sampleResults = sampleStmt.all(...sampleParams) as any[];
      }
    } catch (error) {
      // Query failed - try fallback explanations
      const suggestions = [
        'Try removing special characters or using simpler terms',
        'Check if memories exist with: kratos recent',
        `Query failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      ];

      return {
        preview: {
          would_return: 0,
          search_explanation: `Search would fail with error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          query_breakdown: {
            original: params.q,
            processed: escapedQuery,
            terms: terms,
            filters_applied: filtersApplied
          },
          match_examples: []
        },
        suggestions: suggestions
      };
    }

    // Create explanation
    let explanation = `Search for "${params.q}" would return ${Math.min(totalMatches, k)} of ${totalMatches} total matches.`;
    if (filtersApplied.length > 0) {
      explanation += ` Filters: ${filtersApplied.join(', ')}.`;
    }

    const matchExamples = sampleResults.map((r, i) => ({
      summary: r.summary || 'No summary',
      match_reason: `Matched terms: ${terms.filter(term =>
        r.summary?.toLowerCase().includes(term) || r.snippet?.toLowerCase().includes(term)
      ).join(', ') || 'FTS match'}`,
      score_estimate: r.fts_score > -1 ? 'High relevance' : r.fts_score > -3 ? 'Medium relevance' : 'Low relevance'
    }));

    const suggestions: string[] = [];
    if (totalMatches === 0) {
      suggestions.push('Try removing special characters or using broader terms');
      suggestions.push('Check if memories exist with: kratos recent');
      if (params.require_path_match) {
        suggestions.push('Try without require_path_match to search all memories');
      }
      if (params.tags && params.tags.length > 0) {
        suggestions.push('Try without tag filters to broaden search');
      }
    } else if (totalMatches < k) {
      suggestions.push(`Consider using broader terms to find more than ${totalMatches} results`);
    }

    return {
      preview: {
        would_return: Math.min(totalMatches, k),
        search_explanation: explanation,
        query_breakdown: {
          original: params.q,
          processed: escapedQuery,
          terms: terms,
          filters_applied: filtersApplied
        },
        match_examples: matchExamples
      },
      suggestions: suggestions
    };
  }

  private generateId(): string {
    return `mem_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  private computeDedupeHash(summary: string, paths: string[]): string {
    const normalized = summary.toLowerCase().trim() + '|' + paths.sort().join('|');
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  private escapeQuery(query: string): string {
    // Escape FTS5 special characters and wrap in double quotes for phrase search
    // This prevents "grably-desktop" from being interpreted as "grably MINUS desktop"
    const cleaned = query
      .replace(/["]/g, '""')           // Escape existing quotes
      .replace(/[^\w\s]/g, ' ')        // Replace special chars with spaces
      .replace(/\s+/g, ' ')            // Normalize whitespace
      .trim();

    // If query contains spaces or was modified, wrap in quotes for phrase search
    if (cleaned !== query || cleaned.includes(' ')) {
      return `"${cleaned}"`;
    }

    return cleaned;
  }

  private rowToMemory(row: any): Memory {
    return {
      id: row.id,
      project_id: row.project_id,
      summary: row.summary,
      text: row.text,
      tags: JSON.parse(row.tags),
      paths: JSON.parse(row.paths),
      importance: row.importance,
      created_at: row.created_at,
      updated_at: row.updated_at,
      ttl: row.ttl,
      expires_at: row.expires_at
    };
  }

  private getActiveProjectId(): string {
    // Always use the projectId passed to constructor - ensures true isolation
    // No environment variable dependency - each database instance is bound to its project
    return this.projectId;
  }

  close() {
    this.db.close();
  }
}
