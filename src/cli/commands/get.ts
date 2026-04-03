import { getScopedMemoryDb, type CLIContext } from '../core.js';
import { Output } from '../output.js';

export async function getCommand(ctx: CLIContext, id: string, opts: {
  json?: boolean;
  global?: boolean;
} = {}): Promise<void> {
  const memoryDb = getScopedMemoryDb(ctx, opts);
  const scope = memoryDb.getScope();
  const memory = memoryDb.get(id);

  if (!memory) {
    Output.error(`Memory not found: ${id}`);
    process.exit(1);
  }

  if (opts.json) {
    Output.json({ ...memory, scope });
    return;
  }

  Output.header('Memory Details');
  console.log('');
  Output.info(`ID:         ${memory.id}`);
  Output.info(`Scope:      ${scope}`);
  Output.info(`Summary:    ${memory.summary}`);
  Output.info(`Importance: ${memory.importance}`);
  Output.info(`Created:    ${new Date(memory.created_at).toLocaleString()}`);
  Output.info(`Updated:    ${new Date(memory.updated_at).toLocaleString()}`);

  if (memory.tags.length > 0) {
    Output.info(`Tags:       ${memory.tags.join(', ')}`);
  }
  if (memory.paths.length > 0) {
    Output.info(`Paths:      ${memory.paths.join(', ')}`);
  }
  if (memory.ttl) {
    Output.info(`TTL:        ${memory.ttl}s`);
  }

  console.log('');
  Output.header('Full Text');
  console.log(memory.text);
}
