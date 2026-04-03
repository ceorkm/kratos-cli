import { MemoryDatabase } from '../memory-server/database.js';
import { ProjectManager, type Project } from '../project-manager.js';

export interface CLIContext {
  projectManager: ProjectManager;
  memoryDb: MemoryDatabase;
  projectMemoryDb: MemoryDatabase;
  globalMemoryDb: MemoryDatabase;
  project: Project;
  // PIIDetector loaded lazily — only commands that need it will import it
  getPIIDetector: () => Promise<import('../security/pii-detector.js').PIIDetector>;
}

/**
 * Initialize CLI context — fast path: detect project + open DB. That's it.
 */
export async function initCLIContext(): Promise<CLIContext> {
  const projectManager = new ProjectManager();
  const workingDir = process.env.KRATOS_PROJECT_ROOT || process.cwd();
  const project = await projectManager.detectProject(workingDir);
  const projectMemoryDb = new MemoryDatabase(project.root, project.id);
  const globalMemoryDb = new MemoryDatabase({ scope: 'global' });
  const memoryDb = projectMemoryDb;

  // Lazy PII detector — only loaded when save/scan commands need it
  let _piiDetector: import('../security/pii-detector.js').PIIDetector | null = null;
  const getPIIDetector = async () => {
    if (!_piiDetector) {
      const { PIIDetector } = await import('../security/pii-detector.js');
      _piiDetector = new PIIDetector();
    }
    return _piiDetector;
  };

  return {
    projectManager,
    memoryDb,
    projectMemoryDb,
    globalMemoryDb,
    project,
    getPIIDetector,
  };
}

export function getScopedMemoryDb(
  ctx: CLIContext,
  opts?: { global?: boolean }
): MemoryDatabase {
  return opts?.global ? ctx.globalMemoryDb : ctx.memoryDb;
}
