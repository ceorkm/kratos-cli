import { getScopedMemoryDb, type CLIContext } from '../core.js';
import { Output } from '../output.js';

export async function recentCommand(ctx: CLIContext, opts: {
  limit?: string;
  pathPrefix?: string;
  json?: boolean;
  global?: boolean;
}): Promise<void> {
  const memoryDb = getScopedMemoryDb(ctx, opts);
  const scope = memoryDb.getScope();
  const k = opts.limit ? parseInt(opts.limit, 10) : 10;

  const memories = memoryDb.getRecent({
    k,
    path_prefix: opts.pathPrefix,
  });

  if (opts.json) {
    Output.json({
      scope,
      project: ctx.project.name,
      count: memories.length,
      memories: memories.map(memory => ({ ...memory, scope })),
    });
    return;
  }

  Output.header(`Recent memories (${ctx.project.name})`);
  Output.dim(`Showing ${memories.length} of last ${k} requested`);

  for (const m of memories) {
    Output.memoryCard({
      id: m.id,
      summary: m.summary,
      tags: m.tags,
      paths: m.paths,
      importance: m.importance,
      created_at: m.created_at,
      scope,
    });
  }
}
