import type { CLIContext } from '../core.js';
import { Output } from '../output.js';
import { MemoryDatabase } from '../../memory-server/database.js';
import path from 'node:path';
import fs from 'node:fs';

export async function createCommand(ctx: CLIContext, projectPath: string, opts: {
  json?: boolean;
} = {}): Promise<void> {
  try {
    const resolvedPath = path.resolve(projectPath);

    if (fs.existsSync(resolvedPath) && !fs.statSync(resolvedPath).isDirectory()) {
      Output.error(`Path is a file, not a directory: ${resolvedPath}`);
      process.exit(1);
    }

    if (!fs.existsSync(resolvedPath)) {
      fs.mkdirSync(resolvedPath, { recursive: true });
    }

    // Detect as exact path — don't walk up to parent
    const project = await ctx.projectManager.detectProject(resolvedPath, { exactPath: true });

    // Close old DB handle before switching
    ctx.memoryDb.close();
    ctx.memoryDb = new MemoryDatabase(project.root, project.id);
    ctx.project = project;

    if (opts.json) {
      Output.json({
        ok: true,
        project: {
          id: project.id,
          name: project.name,
          root: project.root,
          data: `~/.kratos/projects/${project.id}/`,
        },
      });
      return;
    }

    Output.success(`Created project: ${project.name}`);
    Output.dim(`Root: ${project.root}`);
    Output.dim(`Data: ~/.kratos/projects/${project.id}/`);
  } catch (error) {
    Output.error(`Failed to create project: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}
