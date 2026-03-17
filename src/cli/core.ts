import { MemoryDatabase } from '../memory-server/database.js';
import { ProjectManager, type Project } from '../project-manager.js';

export interface CLIContext {
  projectManager: ProjectManager;
  memoryDb: MemoryDatabase;
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
  const memoryDb = new MemoryDatabase(project.root, project.id);

  // Lazy PII detector — only loaded when save/scan commands need it
  let _piiDetector: import('../security/pii-detector.js').PIIDetector | null = null;
  const getPIIDetector = async () => {
    if (!_piiDetector) {
      const { PIIDetector } = await import('../security/pii-detector.js');
      _piiDetector = new PIIDetector();
    }
    return _piiDetector;
  };

  return { projectManager, memoryDb, project, getPIIDetector };
}
