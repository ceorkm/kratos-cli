import type { CLIContext } from '../core.js';
import { Output } from '../output.js';

export async function pinCommand(ctx: CLIContext, id: string, opts: {
  unpin?: boolean;
}): Promise<void> {
  const pinned = !opts.unpin;
  const result = ctx.memoryDb.pin(id, pinned);

  if (result.ok) {
    Output.success(result.message!);
  } else {
    Output.error(result.message || 'Pin failed');
  }
}
