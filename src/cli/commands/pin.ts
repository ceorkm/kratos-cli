import type { CLIContext } from '../core.js';
import { Output } from '../output.js';

export async function pinCommand(ctx: CLIContext, id: string, opts: {
  unpin?: boolean;
  json?: boolean;
}): Promise<void> {
  const pinned = !opts.unpin;
  const result = ctx.memoryDb.pin(id, pinned);

  if (result.ok) {
    if (opts.json) {
      Output.json({
        ok: true,
        id,
        pinned,
        message: result.message || null,
      });
      return;
    }
    Output.success(result.message!);
  } else {
    if (opts.json) {
      Output.json({
        ok: false,
        id,
        pinned,
        error: result.message || 'Pin failed',
      });
      process.exit(1);
    }
    Output.error(result.message || 'Pin failed');
    process.exit(1);
  }
}
