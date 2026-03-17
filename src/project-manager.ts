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
 * Smart Project Manager - Handles project isolation and auto-detection
 * Optimized for CLI: no eager loading, minimal I/O
 */
export class ProjectManager {
  private kratosHome: string;
  private currentProject: Project | null = null;
  private projectsCache: Map<string, Project> | null = null; // Lazy — only loaded when needed

  constructor() {
    this.kratosHome = path.join(process.env.HOME || process.env.USERPROFILE || '', '.kratos');
    // Only mkdir if it doesn't exist (avoid sync I/O when possible)
    if (!fs.existsSync(this.kratosHome)) {
      fs.mkdirSync(this.kratosHome, { recursive: true });
    }
    // DON'T load projects cache here — load lazily when needed
  }

  /**
   * Auto-detect project from current working directory
   * Creates a project ID based on the directory path
   */
  async detectProject(workingDir?: string): Promise<Project> {
    const dir = workingDir || process.cwd();

    // Look for project markers — use sync fs.existsSync (faster than async for local files)
    const markers = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', '.kratos'];

    let projectRoot = dir;
    let found = false;

    let currentDir = dir;
    while (currentDir !== path.dirname(currentDir)) {
      for (const marker of markers) {
        if (fs.existsSync(path.join(currentDir, marker))) {
          projectRoot = currentDir;
          found = true;
          break;
        }
      }
      if (found) break;
      currentDir = path.dirname(currentDir);
    }

    const projectId = this.generateProjectId(projectRoot);
    const projectName = path.basename(projectRoot);

    // Check project dir directly on disk — skip loading entire cache
    const projectDir = this.getProjectDir(projectId);
    const projectJsonPath = path.join(projectDir, 'project.json');

    let project: Project;

    if (fs.existsSync(projectJsonPath)) {
      // Known project — read just this one project's metadata
      const raw = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
      project = {
        ...raw,
        createdAt: new Date(raw.createdAt),
        lastAccessed: new Date()
      };
    } else {
      // New project
      project = {
        id: projectId,
        name: projectName,
        root: projectRoot,
        createdAt: new Date(),
        lastAccessed: new Date()
      };

      // Create isolated project directory
      fs.mkdirSync(projectDir, { recursive: true });

      // Save project metadata
      fs.writeFileSync(projectJsonPath, JSON.stringify(project, null, 2));

      // Update the global projects cache file (append this project)
      this.ensureProjectInCache(project);
    }

    this.currentProject = project;
    return project;
  }

  /**
   * Switch to a different project
   */
  async switchProject(projectIdOrPath: string): Promise<Project> {
    // Check if it's a project ID — look in cache
    const cache = this.getProjectsCache();
    let project = cache.get(projectIdOrPath);

    if (!project) {
      // Maybe it's a path
      if (fs.existsSync(projectIdOrPath)) {
        project = await this.detectProject(projectIdOrPath);
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
   * Get the isolated directory for a project
   * This is where ALL project data lives - memories, concepts, etc.
   */
  getProjectDir(projectId?: string): string {
    const id = projectId || this.currentProject?.id;
    if (!id) {
      throw new Error('No active project');
    }
    return path.join(this.kratosHome, 'projects', id);
  }

  /**
   * Get database path for current project
   * COMPLETELY ISOLATED - no cross-contamination possible
   */
  getDatabasePath(dbName: string): string {
    const projectDir = this.getProjectDir();
    return path.join(projectDir, 'databases', `${dbName}.db`);
  }

  /**
   * List all known projects (loads cache on first call)
   */
  listProjects(): Project[] {
    return Array.from(this.getProjectsCache().values())
      .sort((a, b) => b.lastAccessed.getTime() - a.lastAccessed.getTime());
  }

  /**
   * Get current active project
   */
  getCurrentProject(): Project | null {
    return this.currentProject;
  }

  /**
   * Clean up old project data (optional)
   */
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

  /**
   * Generate stable project ID from path
   */
  private generateProjectId(projectPath: string): string {
    // Use hash of normalized path for stable ID
    const normalized = path.resolve(projectPath).toLowerCase();
    const hash = crypto.createHash('sha256').update(normalized).digest('hex');
    return `proj_${hash.substring(0, 12)}`;
  }

  /**
   * Get projects cache — lazy loaded on first access
   */
  private getProjectsCache(): Map<string, Project> {
    if (this.projectsCache) return this.projectsCache;

    this.projectsCache = new Map();
    const cacheFile = path.join(this.kratosHome, 'projects.json');

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
      } catch {
        // Corrupted cache — start fresh
      }
    }
    return this.projectsCache;
  }

  /**
   * Ensure a single project is registered in the global cache file
   * (append without loading all projects into memory)
   */
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

    // Only add if not already there
    if (!cache.projects.some((p: any) => p.id === project.id)) {
      cache.projects.push(project);
      cache.lastUpdated = new Date();
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    }
  }

  /**
   * Save projects cache to disk
   */
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

  /**
   * Get current Kratos home directory
   */
  getKratosHome(): string {
    return this.kratosHome;
  }

  /**
   * Dynamically update Kratos home directory
   */
  async updateKratosHome(newPath: string): Promise<void> {
    this.kratosHome = newPath;
    fs.mkdirSync(this.kratosHome, { recursive: true });

    // Reset cache so it reloads from new location
    this.projectsCache = null;
  }
}
