import { getScopedMemoryDb, type CLIContext } from '../core.js';
import { Output } from '../output.js';

export async function updateCommand(ctx: CLIContext, id: string, text: string, opts: {
  tags?: string;
  importance?: string;
  paths?: string;
  json?: boolean;
  global?: boolean;
}): Promise<void> {
  const memoryDb = getScopedMemoryDb(ctx, opts);
  const scope = memoryDb.getScope();
  const params: any = {};

  if (text) {
    params.text = text;
    params.summary = text.substring(0, 200);
  }
  if (opts.tags) {
    params.tags = opts.tags.split(',').map((t: string) => t.trim());
  }
  if (opts.importance) {
    params.importance = parseInt(opts.importance, 10);
  }
  if (opts.paths) {
    params.paths = opts.paths.split(',').map((p: string) => p.trim());
  }

  const result = memoryDb.updateMemory(id, params);

  if (result.ok) {
    if (opts.json) {
      Output.json({
        ok: true,
        id,
        scope,
        text: params.text ?? null,
        summary: params.summary ?? null,
        tags: params.tags ?? null,
        paths: params.paths ?? null,
        importance: params.importance ?? null,
      });
      return;
    }
    Output.success(`Memory updated: ${id}`);
  } else {
    if (opts.json) {
      Output.json({
        ok: false,
        id,
        scope,
        error: result.message || 'Update failed',
      });
      process.exit(1);
    }
    Output.error(result.message || 'Update failed');
    process.exit(1);
  }
}
