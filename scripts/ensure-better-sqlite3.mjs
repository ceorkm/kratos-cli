import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const requireFromPackage = createRequire(path.join(packageRoot, 'package.json'));

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

  const binaryPath = getBinaryPath(moduleDir);
  console.warn(`[kratos-memory] better-sqlite3 binary missing or unloadable at ${binaryPath}`);
  console.warn('[kratos-memory] rebuilding better-sqlite3 from source...');

  rmSync(path.join(moduleDir, 'build'), { recursive: true, force: true });

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
}

if (process.argv[1] === __filename) {
  ensureBetterSqlite3();
}
