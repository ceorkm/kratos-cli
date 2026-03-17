import type { CLIContext } from '../core.js';
import { Output } from '../output.js';

export async function exportCommand(ctx: CLIContext, opts: {
  format?: string;
}): Promise<void> {
  const memories = ctx.memoryDb.getAll();

  if (memories.length === 0) {
    Output.warn('No memories to export');
    return;
  }

  const exported = {
    project: ctx.project.name,
    project_id: ctx.project.id,
    exported_at: new Date().toISOString(),
    count: memories.length,
    memories: memories.map(m => ({
      id: m.id,
      summary: m.summary,
      text: m.text,
      tags: m.tags,
      paths: m.paths,
      importance: m.importance,
      created_at: new Date(m.created_at).toISOString(),
      updated_at: new Date(m.updated_at).toISOString(),
    })),
  };

  // Output to stdout (pipe-friendly)
  console.log(JSON.stringify(exported, null, 2));
}
