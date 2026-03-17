import type { CLIContext } from '../core.js';
import { Output } from '../output.js';

export async function forgetCommand(ctx: CLIContext, id: string, opts: {
  json?: boolean;
} = {}): Promise<void> {
  const result = ctx.memoryDb.forget(id);

  if (result.ok) {
    if (opts.json) {
      Output.json({
        ok: true,
        id,
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
        error: result.message || `Memory not found: ${id}`,
      });
      process.exit(1);
    }
    Output.error(result.message || `Memory not found: ${id}`);
    process.exit(1);
  }
}
