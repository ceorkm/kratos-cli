#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initCLIContext } from './core.js';
import { Output } from './output.js';

// Read version from package.json so it never drifts
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
const VERSION = pkg.version;

const BANNER = `
${chalk.bold.red('  ██╗  ██╗██████╗  █████╗ ████████╗ ██████╗ ███████╗')}
${chalk.bold.red('  ██║ ██╔╝██╔══██╗██╔══██╗╚══██╔══╝██╔═══██╗██╔════╝')}
${chalk.bold.red('  █████╔╝ ██████╔╝███████║   ██║   ██║   ██║███████╗')}
${chalk.bold.red('  ██╔═██╗ ██╔══██╗██╔══██║   ██║   ██║   ██║╚════██║')}
${chalk.bold.red('  ██║  ██╗██║  ██║██║  ██║   ██║   ╚██████╔╝███████║')}
${chalk.bold.red('  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚══════╝')}
${chalk.dim('  ─────────────────────────────────────────────────────')}
${chalk.white('  The God of War remembers everything.')}
${chalk.dim(`  v${VERSION}  |  CLI-first  |  FTS5`)}
${chalk.dim('  Add --global to any command for cross-project memory')}
`;

const program = new Command();

program
  .name('kratos')
  .description('Kratos Memory — Persistent memory for AI coding agents')
  .version(VERSION)
  .addHelpText('before', BANNER);

// ─── save ───────────────────────────────────────────────
program
  .command('save <text>')
  .description('Save a memory')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .option('-p, --paths <paths>', 'Comma-separated file paths')
  .option('-i, --importance <level>', 'Importance 1-5 (default: 3)')
  .option('-c, --compress', 'Compress text before saving')
  .option('-g, --global', 'Use global memory scope')
  .option('-j, --json', 'Output JSON')
  .action(async (text: string, opts) => {
    const ctx = await initCLIContext();
    const { saveCommand } = await import('./commands/save.js');
    await saveCommand(ctx, text, opts);
  });

// ─── search ─────────────────────────────────────────────
program
  .command('search <query>')
  .description('Search memories')
  .option('-l, --limit <n>', 'Max results (default: 10)')
  .option('-t, --tags <tags>', 'Filter by tags')
  .option('-d, --debug', 'Show debug info')
  .option('-g, --global', 'Use global memory scope')
  .option('-j, --json', 'Output JSON')
  .option('--path-match', 'Require path matching')
  .action(async (query: string, opts) => {
    const ctx = await initCLIContext();
    const { searchCommand } = await import('./commands/search.js');
    await searchCommand(ctx, query, opts);
  });

// ─── ask ────────────────────────────────────────────────
program
  .command('ask <question>')
  .description('Ask a natural language question about your memories')
  .option('-l, --limit <n>', 'Max results (default: 10)')
  .option('-j, --json', 'Output JSON')
  .action(async (question: string, opts) => {
    const ctx = await initCLIContext();
    const { askCommand } = await import('./commands/ask.js');
    await askCommand(ctx, question, opts);
  });

// ─── recent ─────────────────────────────────────────────
program
  .command('recent')
  .description('Get recent memories')
  .option('-l, --limit <n>', 'Max results (default: 10)')
  .option('--path-prefix <prefix>', 'Filter by path prefix')
  .option('-g, --global', 'Use global memory scope')
  .option('-j, --json', 'Output JSON')
  .action(async (opts) => {
    const ctx = await initCLIContext();
    const { recentCommand } = await import('./commands/recent.js');
    await recentCommand(ctx, opts);
  });

// ─── get ────────────────────────────────────────────────
program
  .command('get <id>')
  .description('Get a specific memory by ID')
  .option('-g, --global', 'Use global memory scope')
  .option('-j, --json', 'Output JSON')
  .action(async (id: string, opts) => {
    const ctx = await initCLIContext();
    const { getCommand } = await import('./commands/get.js');
    await getCommand(ctx, id, opts);
  });

// ─── update ─────────────────────────────────────────────
program
  .command('update <id> <text>')
  .description('Update a memory')
  .option('-t, --tags <tags>', 'Replace tags (comma-separated)')
  .option('-i, --importance <level>', 'Update importance 1-5')
  .option('-p, --paths <paths>', 'Replace file paths (comma-separated)')
  .option('-g, --global', 'Use global memory scope')
  .option('-j, --json', 'Output JSON')
  .action(async (id: string, text: string, opts) => {
    const ctx = await initCLIContext();
    const { updateCommand } = await import('./commands/update.js');
    await updateCommand(ctx, id, text, opts);
  });

// ─── pin ────────────────────────────────────────────────
program
  .command('pin <id>')
  .description('Pin a memory — pinned memories always surface first')
  .option('-u, --unpin', 'Unpin the memory')
  .option('-g, --global', 'Use global memory scope')
  .option('-j, --json', 'Output JSON')
  .action(async (id: string, opts) => {
    const ctx = await initCLIContext();
    const { pinCommand } = await import('./commands/pin.js');
    await pinCommand(ctx, id, opts);
  });

// ─── export ─────────────────────────────────────────────
program
  .command('export')
  .description('Export all memories as JSON')
  .option('-g, --global', 'Use global memory scope')
  .action(async (opts) => {
    const ctx = await initCLIContext();
    const { exportCommand } = await import('./commands/export.js');
    await exportCommand(ctx, opts);
  });

// ─── summary ────────────────────────────────────────────
program
  .command('summary')
  .description('Generate a project summary from all memories')
  .option('-g, --global', 'Use global memory scope')
  .option('-j, --json', 'Output JSON')
  .action(async (opts) => {
    const ctx = await initCLIContext();
    const { summaryCommand } = await import('./commands/summary.js');
    await summaryCommand(ctx, opts);
  });

// ─── forget ─────────────────────────────────────────────
program
  .command('forget <id>')
  .description('Delete a memory by ID')
  .option('-g, --global', 'Use global memory scope')
  .option('-j, --json', 'Output JSON')
  .action(async (id: string, opts) => {
    const ctx = await initCLIContext();
    const { forgetCommand } = await import('./commands/forget.js');
    await forgetCommand(ctx, id, opts);
  });

// ─── status ─────────────────────────────────────────────
program
  .command('status')
  .description('Show system status and statistics')
  .option('-j, --json', 'Output JSON')
  .action(async (opts) => {
    const ctx = await initCLIContext();
    const { statusCommand } = await import('./commands/status.js');
    await statusCommand(ctx, opts);
  });

// ─── create ─────────────────────────────────────────────
program
  .command('create <path>')
  .description('Create a new project scoped to a directory')
  .option('-j, --json', 'Output JSON')
  .action(async (projectPath: string, opts) => {
    const ctx = await initCLIContext();
    const { createCommand } = await import('./commands/create.js');
    await createCommand(ctx, projectPath, opts);
  });

// ─── switch ─────────────────────────────────────────────
program
  .command('switch <project>')
  .description('Switch to a different project')
  .option('-j, --json', 'Output JSON')
  .action(async (projectPath: string, opts) => {
    const ctx = await initCLIContext();
    const { switchCommand } = await import('./commands/switch.js');
    await switchCommand(ctx, projectPath, opts);
  });

// ─── scan ───────────────────────────────────────────────
program
  .command('scan <text>')
  .description('Scan text for PII and secrets')
  .option('-r, --redact', 'Show redacted version')
  .option('-j, --json', 'Output JSON')
  .action(async (text: string, opts) => {
    const ctx = await initCLIContext();
    const { scanCommand } = await import('./commands/scan.js');
    await scanCommand(ctx, text, opts);
  });

// ─── migrate ────────────────────────────────────────────
program
  .command('migrate')
  .description('Verify and index existing data for CLI use')
  .option('--from <path>', 'Custom data location')
  .action(async (opts) => {
    const ctx = await initCLIContext();
    const { migrateCommand } = await import('./commands/migrate.js');
    await migrateCommand(ctx, opts);
  });

// ─── hooks ──────────────────────────────────────────────
program
  .command('hooks <action>')
  .description('Manage auto-capture hooks (install/uninstall)')
  .action(async (action: string) => {
    const { hooksCommand } = await import('./commands/hooks.js');
    await hooksCommand(action);
  });

// ─── capture (hidden — invoked by hooks) ────────────────
program
  .command('capture', { hidden: true })
  .description('Process auto-captured events (internal)')
  .option('--event <type>', 'Event type')
  .action(async (opts) => {
    const ctx = await initCLIContext();
    const { captureCommand } = await import('./commands/capture.js');
    await captureCommand(ctx, opts);
  });

// ─── Main ───────────────────────────────────────────────
async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof Error) {
      Output.error(error.message);
    }
    process.exit(1);
  }
}

main();
