import path from 'path';
import fs from 'node:fs';
import crypto from 'crypto';

export interface Project {
  id: string;
  name: string;
  root: string;
  createdAt: Date;
  lastAccessed: Date;
}

/**
 * Smart Project Manager - Registry-based project detection
 * No filesystem marker sniffing — Kratos remembers where it's been activated.
 */
export class ProjectManager {
  private kratosHome: string;
  private currentProject: Project | null = null;
  private projectsCache: Map<string, Project> | null = null;

  constructor() {
    this.kratosHome = path.join(process.env.HOME || process.env.USERPROFILE || '', '.kratos');
    if (!fs.existsSync(this.kratosHome)) {
      fs.mkdirSync(this.kratosHome, { recursive: true });
    }
  }

  /**
   * Auto-detect project from current working directory.
   * 1. Check if cwd (or an ancestor) is already a registered kratos project
   * 2. If yes, use the deepest (most specific) match
   * 3. If no, register cwd as a new project
   */
  async detectProject(workingDir?: string, options: {
    exactPath?: boolean;
  } = {}): Promise<Project> {
    const requestedPath = workingDir || process.cwd();
    const dir = this.resolveRequestedPath(requestedPath);
    let projectRoot = dir;

    if (!options.exactPath) {
      const registered = this.findRegisteredProjectForPath(dir);
      if (registered) {
        projectRoot = registered.root;
      }
      // No registered project found — projectRoot stays as cwd
    }

    projectRoot = this.normalizeProjectPath(projectRoot);
    const projectId = this.generateProjectId(projectRoot);
    const projectName = path.basename(projectRoot);

    const projectDir = this.getProjectDir(projectId);
    const projectJsonPath = path.join(projectDir, 'project.json');

    let project: Project;

    if (fs.existsSync(projectJsonPath)) {
      const raw = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
      project = {
        ...raw,
        createdAt: new Date(raw.createdAt),
        lastAccessed: new Date()
      };
      // Persist updated lastAccessed
      fs.writeFileSync(projectJsonPath, JSON.stringify(project, null, 2));
      // Keep in-memory cache and projects.json in sync
      this.ensureProjectInCache(project);
    } else {
      project = {
        id: projectId,
        name: projectName,
        root: projectRoot,
        createdAt: new Date(),
        lastAccessed: new Date()
      };

      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(projectJsonPath, JSON.stringify(project, null, 2));
      this.ensureProjectInCache(project);
    }

    this.currentProject = project;
    return project;
  }

  /**
   * Switch to a different project
   */
  async switchProject(projectIdOrPath: string): Promise<Project> {
    const cache = this.getProjectsCache();
    let project = cache.get(projectIdOrPath);

    if (!project) {
      const normalizedTarget = projectIdOrPath.trim().toLowerCase();
      const matches = Array.from(cache.values()).filter(candidate =>
        candidate.name.toLowerCase() === normalizedTarget
      );
      if (matches.length > 1) {
        const roots = matches.map(m => `  ${m.id} → ${m.root}`).join('\n');
        throw new Error(`Ambiguous project name "${projectIdOrPath}". Multiple matches:\n${roots}\nUse the project ID or path instead.`);
      }
      project = matches[0] || undefined;
    }

    if (!project) {
      if (fs.existsSync(projectIdOrPath)) {
        project = await this.detectProject(projectIdOrPath, { exactPath: true });
      } else {
        throw new Error(`Project not found: ${projectIdOrPath}`);
      }
    }

    this.currentProject = project;
    project.lastAccessed = new Date();
    this.saveProjectsCache();

    return project;
  }

  /**
   * Find the deepest registered project whose root contains dir.
   * $HOME and / are exact-match only — they never swallow subdirectories.
   */
  private findRegisteredProjectForPath(dir: string): Project | null {
    const homeDir = this.normalizeProjectPath(process.env.HOME || process.env.USERPROFILE || '');
    const cache = this.getProjectsCache();
    let best: Project | null = null;
    let bestLen = -1;

    for (const project of cache.values()) {
      const root = project.root;

      // $HOME and / are exact-match only
      if (root === homeDir || root === '/') {
        if (dir === root && root.length > bestLen) {
          best = project;
          bestLen = root.length;
        }
        continue;
      }

      // Check if dir is equal to or a descendant of this project root
      if (dir === root || dir.startsWith(root + path.sep)) {
        if (root.length > bestLen) {
          best = project;
          bestLen = root.length;
        }
      }
    }

    return best;
  }

  getProjectDir(projectId?: string): string {
    const id = projectId || this.currentProject?.id;
    if (!id) {
      throw new Error('No active project');
    }
    return path.join(this.kratosHome, 'projects', id);
  }

  getDatabasePath(dbName: string): string {
    const projectDir = this.getProjectDir();
    return path.join(projectDir, 'databases', `${dbName}.db`);
  }

  listProjects(): Project[] {
    return Array.from(this.getProjectsCache().values())
      .sort((a, b) => b.lastAccessed.getTime() - a.lastAccessed.getTime());
  }

  getCurrentProject(): Project | null {
    return this.currentProject;
  }

  async cleanupProject(projectId: string, options: {
    keepMemories?: boolean;
    keepConcepts?: boolean;
  } = {}): Promise<void> {
    const projectDir = this.getProjectDir(projectId);

    if (!options.keepMemories) {
      const memoriesDb = path.join(projectDir, 'databases', 'memories.db');
      if (fs.existsSync(memoriesDb)) {
        fs.unlinkSync(memoriesDb);
      }
    }

    if (!options.keepConcepts) {
      const conceptsDb = path.join(projectDir, 'databases', 'concepts.db');
      if (fs.existsSync(conceptsDb)) {
        fs.unlinkSync(conceptsDb);
      }
    }
  }

  // WARNING: DO NOT CHANGE THIS FUNCTION'S OUTPUT.
  // Every existing user's memories are stored under the hash this produces.
  // Changing the hashing (e.g. removing toLowerCase, changing the algorithm,
  // or altering normalization) will orphan every existing project's database.
  // This happened once already (v1.5.0 → v1.6.1) and required a migration fix.
  private generateProjectId(projectPath: string): string {
    const normalized = this.normalizeProjectPath(projectPath).toLowerCase();
    const hash = crypto.createHash('sha256').update(normalized).digest('hex');
    return `proj_${hash.substring(0, 12)}`;
  }

  private normalizeProjectPath(projectPath: string): string {
    try {
      return fs.realpathSync.native(projectPath);
    } catch {
      return path.resolve(projectPath);
    }
  }

  private resolveRequestedPath(projectPath: string): string {
    const normalized = this.normalizeProjectPath(projectPath);
    try {
      const stat = fs.statSync(normalized);
      return stat.isDirectory() ? normalized : path.dirname(normalized);
    } catch {
      return normalized;
    }
  }

  /**
   * Get projects cache — lazy loaded on first access.
   * If projects.json is corrupted, rebuild from individual project.json files.
   */
  private getProjectsCache(): Map<string, Project> {
    if (this.projectsCache) return this.projectsCache;

    this.projectsCache = new Map();
    const cacheFile = path.join(this.kratosHome, 'projects.json');

    let loaded = false;
    if (fs.existsSync(cacheFile)) {
      try {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        for (const project of cache.projects || []) {
          this.projectsCache.set(project.id, {
            ...project,
            createdAt: new Date(project.createdAt),
            lastAccessed: new Date(project.lastAccessed)
          });
        }
        loaded = true;
      } catch {
        // Corrupted — fall through to rebuild
      }
    }

    if (!loaded) {
      this.rebuildCacheFromDisk();
    }

    return this.projectsCache;
  }

  /**
   * Rebuild projects.json by scanning per-project metadata files on disk
   */
  private rebuildCacheFromDisk(): void {
    const projectsDir = path.join(this.kratosHome, 'projects');
    if (!fs.existsSync(projectsDir)) return;

    try {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pjPath = path.join(projectsDir, entry.name, 'project.json');
        if (!fs.existsSync(pjPath)) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(pjPath, 'utf-8'));
          this.projectsCache!.set(raw.id, {
            ...raw,
            createdAt: new Date(raw.createdAt),
            lastAccessed: new Date(raw.lastAccessed)
          });
        } catch {
          // Skip corrupted individual project
        }
      }
    } catch {
      // projectsDir unreadable — nothing to rebuild
    }

    // Persist the rebuilt cache
    this.saveProjectsCache();
  }

  private ensureProjectInCache(project: Project): void {
    const cacheFile = path.join(this.kratosHome, 'projects.json');
    let cache: { projects: any[]; lastUpdated: Date } = { projects: [], lastUpdated: new Date() };

    if (fs.existsSync(cacheFile)) {
      try {
        cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      } catch {
        // Corrupted — start fresh
      }
    }

    const idx = cache.projects.findIndex((p: any) => p.id === project.id);
    if (idx >= 0) {
      cache.projects[idx] = project;
    } else {
      cache.projects.push(project);
    }
    cache.lastUpdated = new Date();
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));

    // Also update in-memory cache if loaded
    if (this.projectsCache) {
      this.projectsCache.set(project.id, project);
    }
  }

  private saveProjectsCache(): void {
    const cacheFile = path.join(this.kratosHome, 'projects.json');
    const cache = {
      projects: Array.from(this.getProjectsCache().values()),
      lastUpdated: new Date()
    };

    try {
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    } catch {
      // Silently fail — non-critical
    }
  }

  getKratosHome(): string {
    return this.kratosHome;
  }

  async updateKratosHome(newPath: string): Promise<void> {
    this.kratosHome = newPath;
    fs.mkdirSync(this.kratosHome, { recursive: true });
    this.projectsCache = null;
  }
}
