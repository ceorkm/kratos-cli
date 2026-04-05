import type { CLIContext } from '../core.js';
import { Output } from '../output.js';
import path from 'path';
import fs from 'node:fs';
import crypto from 'crypto';

export async function migrateCommand(ctx: CLIContext, opts: {
  from?: string;
}): Promise<void> {
  const kratosHome = opts.from || path.join(process.env.HOME || process.env.USERPROFILE || '', '.kratos');
  const projectsDir = path.join(kratosHome, 'projects');

  Output.header('Kratos Data Migration');

  if (!fs.existsSync(projectsDir)) {
    Output.warn('No existing data found at: ' + projectsDir);
    Output.dim('If your data is elsewhere, use --from <path>');
    return;
  }

  const entries = fs.readdirSync(projectsDir);
  let totalMemories = 0;
  let totalProjects = 0;
  let mergedCount = 0;

  // Build map: canonical (lowercase) project ID → project root
  // Then find orphans: projects whose ID doesn't match the canonical hash of their root
  const Database = (await import('better-sqlite3')).default;
  const orphans: { dir: string; name: string; root: string; canonicalId: string }[] = [];

  for (const entry of entries) {
    const projectJsonPath = path.join(projectsDir, entry, 'project.json');
    const dbPath = path.join(projectsDir, entry, 'databases', 'memories.db');

    if (!fs.existsSync(projectJsonPath)) continue;

    let meta: any;
    try {
      meta = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
    } catch { continue; }

    const root = meta.root;
    if (!root) continue;

    // Compute canonical ID (lowercase path hash — the correct one)
    const canonicalHash = crypto.createHash('sha256')
      .update(root.toLowerCase())
      .digest('hex');
    const canonicalId = `proj_${canonicalHash.substring(0, 12)}`;

    totalProjects++;

    // Count memories
    if (fs.existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        const row = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
        totalMemories += row.count;
        db.close();
      } catch { /* skip */ }
    }

    // If this project's folder name doesn't match canonical ID, it's an orphan
    if (entry !== canonicalId && fs.existsSync(dbPath)) {
      orphans.push({ dir: entry, name: meta.name || entry, root, canonicalId });
    }
  }

  if (orphans.length > 0) {
    Output.header('Merging Orphaned Projects');
    Output.dim(`Found ${orphans.length} orphaned project(s) from case-sensitive ID change`);
    console.log('');

    for (const orphan of orphans) {
      const orphanDbPath = path.join(projectsDir, orphan.dir, 'databases', 'memories.db');
      const canonicalDir = path.join(projectsDir, orphan.canonicalId);
      const canonicalDbDir = path.join(canonicalDir, 'databases');
      const canonicalDbPath = path.join(canonicalDbDir, 'memories.db');

      try {
        const srcDb = new Database(orphanDbPath, { readonly: true });
        const memories = srcDb.prepare('SELECT * FROM memories').all() as any[];
        srcDb.close();

        if (memories.length === 0) {
          Output.dim(`  ${orphan.name} (${orphan.dir}): empty, skipping`);
          continue;
        }

        // Ensure canonical project directory exists
        fs.mkdirSync(canonicalDbDir, { recursive: true });

        // Write project.json if missing
        const canonicalPjPath = path.join(canonicalDir, 'project.json');
        if (!fs.existsSync(canonicalPjPath)) {
          fs.writeFileSync(canonicalPjPath, JSON.stringify({
            id: orphan.canonicalId,
            name: orphan.name,
            root: orphan.root,
            createdAt: new Date(),
            lastAccessed: new Date(),
          }, null, 2));
        }

        // Open or create canonical DB and copy memories
        const dstDb = new Database(canonicalDbPath);
        dstDb.pragma('journal_mode = WAL');

        // Ensure schema exists
        dstDb.exec(`
          CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            summary TEXT NOT NULL,
            text TEXT NOT NULL,
            tags TEXT DEFAULT '[]',
            paths TEXT DEFAULT '[]',
            importance INTEGER DEFAULT 3,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            ttl INTEGER,
            expires_at INTEGER,
            dedupe_hash TEXT
          )
        `);

        const insert = dstDb.prepare(`
          INSERT OR IGNORE INTO memories (id, project_id, summary, text, tags, paths, importance, created_at, updated_at, ttl, expires_at, dedupe_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let copied = 0;
        for (const mem of memories) {
          const result = insert.run(
            mem.id, orphan.canonicalId, mem.summary, mem.text,
            mem.tags, mem.paths, mem.importance,
            mem.created_at, mem.updated_at, mem.ttl, mem.expires_at,
            mem.dedupe_hash
          );
          if (result.changes > 0) copied++;
        }

        dstDb.close();
        mergedCount += copied;

        Output.success(`  ${orphan.name}: merged ${copied}/${memories.length} memories → ${orphan.canonicalId}`);
      } catch (error) {
        Output.warn(`  ${orphan.name}: merge failed — ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
  }

  console.log('');
  Output.header('Migration Summary');
  Output.info(`Projects found:  ${totalProjects}`);
  Output.info(`Total memories:  ${totalMemories}`);
  if (mergedCount > 0) {
    Output.success(`Merged memories: ${mergedCount}`);
  }
  Output.info(`Data location:   ${projectsDir}`);

  if (orphans.length === 0) {
    console.log('');
    Output.success('All projects are using canonical IDs. No migration needed.');
  }
}
