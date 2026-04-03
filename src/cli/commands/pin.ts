import { getScopedMemoryDb, type CLIContext } from '../core.js';
import { Output } from '../output.js';

export async function pinCommand(ctx: CLIContext, id: string, opts: {
  unpin?: boolean;
  json?: boolean;
  global?: boolean;
}): Promise<void> {
  const memoryDb = getScopedMemoryDb(ctx, opts);
  const scope = memoryDb.getScope();
  const pinned = !opts.unpin;
  const result = memoryDb.pin(id, pinned);

  if (result.ok) {
    if (opts.json) {
      Output.json({
        ok: true,
        id,
        scope,
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
        scope,
        pinned,
        error: result.message || 'Pin failed',
      });
      process.exit(1);
    }
    Output.error(result.message || 'Pin failed');
    process.exit(1);
  }
}
