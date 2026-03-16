#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { initCLIContext } from './core.js';
import { Output } from './output.js';

const BANNER = `
${chalk.bold.red('  ██╗  ██╗██████╗  █████╗ ████████╗ ██████╗ ███████╗')}
${chalk.bold.red('  ██║ ██╔╝██╔══██╗██╔══██╗╚══██╔══╝██╔═══██╗██╔════╝')}
${chalk.bold.red('  █████╔╝ ██████╔╝███████║   ██║   ██║   ██║███████╗')}
${chalk.bold.red('  ██╔═██╗ ██╔══██╗██╔══██║   ██║   ██║   ██║╚════██║')}
${chalk.bold.red('  ██║  ██╗██║  ██║██║  ██║   ██║   ╚██████╔╝███████║')}
${chalk.bold.red('  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚══════╝')}
${chalk.dim('  ─────────────────────────────────────────────────────')}
${chalk.white('  The God of War remembers everything.')}
${chalk.dim(`  v1.0.0  |  CLI-first  |  FTS5  |  Encrypted`)}
`;

const program = new Command();

program
  .name('kratos')
  .description('Kratos Memory — Persistent memory for AI coding agents')
  .version('1.0.0')
  .addHelpText('before', BANNER);

// ─── save ───────────────────────────────────────────────
program
  .command('save <text>')
  .description('Save a memory')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .option('-p, --paths <paths>', 'Comma-separated file paths')
  .option('-i, --importance <level>', 'Importance 1-5 (default: 3)')
  .option('-c, --compress', 'Compress text before saving')
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
  .action(async (opts) => {
    const ctx = await initCLIContext();
    const { recentCommand } = await import('./commands/recent.js');
    await recentCommand(ctx, opts);
  });

// ─── get ────────────────────────────────────────────────
program
  .command('get <id>')
  .description('Get a specific memory by ID')
  .action(async (id: string) => {
    const ctx = await initCLIContext();
    const { getCommand } = await import('./commands/get.js');
    await getCommand(ctx, id);
  });

// ─── forget ─────────────────────────────────────────────
program
  .command('forget <id>')
  .description('Delete a memory by ID')
  .action(async (id: string) => {
    const ctx = await initCLIContext();
    const { forgetCommand } = await import('./commands/forget.js');
    await forgetCommand(ctx, id);
  });

// ─── status ─────────────────────────────────────────────
program
  .command('status')
  .description('Show system status and statistics')
  .action(async () => {
    const ctx = await initCLIContext();
    const { statusCommand } = await import('./commands/status.js');
    await statusCommand(ctx);
  });

// ─── switch ─────────────────────────────────────────────
program
  .command('switch <project>')
  .description('Switch to a different project')
  .action(async (projectPath: string) => {
    const ctx = await initCLIContext();
    const { switchCommand } = await import('./commands/switch.js');
    await switchCommand(ctx, projectPath);
  });

// ─── scan ───────────────────────────────────────────────
program
  .command('scan <text>')
  .description('Scan text for PII and secrets')
  .option('-r, --redact', 'Show redacted version')
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
