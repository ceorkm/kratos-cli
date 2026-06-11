import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const requireFromPackage = createRequire(path.join(packageRoot, 'package.json'));

const LOCK_WAIT_MS = 180_000;   // how long a process waits for another's rebuild
const LOCK_STALE_MS = 600_000;  // locks older than this are abandoned crashes

function resolveBetterSqlite3Dir() {
  const pkgPath = requireFromPackage.resolve('better-sqlite3/package.json');
  return path.dirname(pkgPath);
}

function getBinaryPath(moduleDir) {
  return path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node');
}

function canLoadBetterSqlite3(moduleDir) {
  if (!existsSync(getBinaryPath(moduleDir))) {
    return false;
  }

  const script = `
    const { createRequire } = require('node:module');
    const req = createRequire(${JSON.stringify(path.join(packageRoot, 'package.json'))});
    req('better-sqlite3');
  `;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: packageRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  return result.status === 0;
}

function runCommand(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      npm_config_loglevel: process.env.npm_config_loglevel || 'error',
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function findNpmCommand() {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      argsPrefix: [process.env.npm_execpath],
    };
  }

  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    argsPrefix: [],
  };
}

function formatOutput(result) {
  const chunks = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean);
  return chunks.join('\n');
}

function sleepSync(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(() => process.exit(0), ${ms})`]);
}

/**
 * Cross-process lock via atomic mkdir. Concurrent kratos invocations on a
 * fresh install must not rebuild the native module simultaneously — the
 * second process waits for the first, then re-checks instead of rebuilding.
 */
function acquireLock(lockDir) {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      return true;
    } catch {
      try {
        const stat = statSync(lockDir);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between attempts — retry immediately
      }
      if (Date.now() - start > LOCK_WAIT_MS) {
        return false;
      }
      sleepSync(500);
    }
  }
}

function releaseLock(lockDir) {
  rmSync(lockDir, { recursive: true, force: true });
}

/**
 * Fast path: download the official prebuilt binary (seconds, no compiler).
 * This is what better-sqlite3's own install script does — it gets skipped
 * when users install with --ignore-scripts.
 */
function tryPrebuildInstall(moduleDir) {
  let prebuildBin;
  try {
    const requireFromModule = createRequire(path.join(moduleDir, 'package.json'));
    const prebuildPkg = requireFromModule.resolve('prebuild-install/package.json');
    const prebuildDir = path.dirname(prebuildPkg);
    const binRel = JSON.parse(
      spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(prebuildPkg)}).bin))`], { encoding: 'utf8' }).stdout.trim()
    );
    prebuildBin = path.join(prebuildDir, typeof binRel === 'string' ? binRel : Object.values(binRel)[0]);
  } catch {
    return false; // prebuild-install not resolvable — fall through to source build
  }

  const result = runCommand(process.execPath, [prebuildBin], moduleDir);
  return result.status === 0;
}

export function ensureBetterSqlite3() {
  let moduleDir;

  try {
    moduleDir = resolveBetterSqlite3Dir();
  } catch (error) {
    console.warn('[kratos-memory] better-sqlite3 is not installed yet:', error.message);
    return;
  }

  if (canLoadBetterSqlite3(moduleDir)) {
    return;
  }

  const lockDir = path.join(moduleDir, '.kratos-setup-lock');
  if (!acquireLock(lockDir)) {
    // Another process held the lock the whole time — check its result
    if (canLoadBetterSqlite3(moduleDir)) return;
    throw new Error('Timed out waiting for another kratos process to finish native setup.');
  }

  try {
    // Another process may have completed setup while we waited for the lock
    if (canLoadBetterSqlite3(moduleDir)) {
      return;
    }

    rmSync(path.join(moduleDir, 'build'), { recursive: true, force: true });

    console.warn('[kratos-memory] one-time native setup: fetching prebuilt SQLite binary...');
    if (tryPrebuildInstall(moduleDir) && canLoadBetterSqlite3(moduleDir)) {
      console.warn('[kratos-memory] prebuilt binary installed.');
      return;
    }

    console.warn('[kratos-memory] no prebuilt binary available — compiling from source (one time, may take a minute)...');
    const npm = findNpmCommand();
    const rebuild = runCommand(
      npm.command,
      [...npm.argsPrefix, 'run', 'build-release', '--foreground-scripts'],
      moduleDir
    );

    if (canLoadBetterSqlite3(moduleDir)) {
      console.warn('[kratos-memory] better-sqlite3 rebuild succeeded.');
      return;
    }

    const detail = formatOutput(rebuild);
    throw new Error(
      detail
        ? `Failed to build better-sqlite3.\n${detail}`
        : 'Failed to build better-sqlite3.'
    );
  } finally {
    releaseLock(lockDir);
  }
}

if (process.argv[1] === __filename) {
  ensureBetterSqlite3();
}
