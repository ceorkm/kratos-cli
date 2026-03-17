import type { CLIContext } from '../core.js';
import { Output } from '../output.js';
import { MemoryDatabase } from '../../memory-server/database.js';

export async function switchCommand(ctx: CLIContext, projectPath: string, opts: {
  json?: boolean;
} = {}): Promise<void> {
  try {
    const newProject = await ctx.projectManager.switchProject(projectPath);

    // Re-initialize memory database for the new project
    ctx.memoryDb = new MemoryDatabase(newProject.root, newProject.id);
    ctx.project = newProject;

    if (opts.json) {
      Output.json({
        ok: true,
        project: {
          id: newProject.id,
          name: newProject.name,
          root: newProject.root,
          data: `~/.kratos/projects/${newProject.id}/`,
        },
      });
      return;
    }

    Output.success(`Switched to project: ${newProject.name}`);
    Output.dim(`Root: ${newProject.root}`);
    Output.dim(`Data: ~/.kratos/projects/${newProject.id}/`);
  } catch (error) {
    Output.error(`Failed to switch project: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}
