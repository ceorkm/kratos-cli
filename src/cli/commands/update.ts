import type { CLIContext } from '../core.js';
import { Output } from '../output.js';

export async function updateCommand(ctx: CLIContext, id: string, text: string, opts: {
  tags?: string;
  importance?: string;
  paths?: string;
}): Promise<void> {
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

  const result = ctx.memoryDb.updateMemory(id, params);

  if (result.ok) {
    Output.success(`Memory updated: ${id}`);
  } else {
    Output.error(result.message || 'Update failed');
  }
}
