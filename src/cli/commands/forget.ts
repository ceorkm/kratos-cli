import { getScopedMemoryDb, type CLIContext } from '../core.js';
import { Output } from '../output.js';

export async function forgetCommand(ctx: CLIContext, id: string, opts: {
  json?: boolean;
  global?: boolean;
} = {}): Promise<void> {
  const memoryDb = getScopedMemoryDb(ctx, opts);
  const scope = memoryDb.getScope();
  const result = memoryDb.forget(id);

  if (result.ok) {
    if (opts.json) {
      Output.json({
        ok: true,
        id,
        scope,
        message: result.message || null,
      });
      return;
    }
    Output.success(`Memory deleted: ${id}`);
  } else {
    if (opts.json) {
      Output.json({
        ok: false,
        id,
        scope,
        error: result.message || `Memory not found: ${id}`,
      });
      process.exit(1);
    }
    Output.error(result.message || `Memory not found: ${id}`);
    process.exit(1);
  }
}
