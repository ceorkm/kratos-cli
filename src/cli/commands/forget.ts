import type { CLIContext } from '../core.js';
import { Output } from '../output.js';

export async function forgetCommand(ctx: CLIContext, id: string): Promise<void> {
  const result = ctx.memoryDb.forget(id);

  if (result.ok) {
    Output.success(`Memory deleted: ${id}`);
  } else {
    Output.error(result.message || `Memory not found: ${id}`);
    process.exit(1);
  }
}
