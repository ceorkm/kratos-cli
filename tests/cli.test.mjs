import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI_PATH = path.resolve(new URL('../dist/cli/index.js', import.meta.url).pathname);

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kratos-cli-test-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  return { root, home, workspace };
}

function makeProject(workspaceRoot, name) {
  const projectDir = path.join(workspaceRoot, name);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name, private: true }, null, 2));
  return fs.realpathSync.native(projectDir);
}

function runCli(args, options = {}) {
  const env = {
    ...process.env,
    HOME: options.home,
    USERPROFILE: options.home,
  };

  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: options.cwd,
    env,
    encoding: 'utf8',
  });
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

test('update exits non-zero for missing memory', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'missing-update');

  const result = runCli(['update', 'mem_DOES_NOT_EXIST', 'should fail'], {
    cwd: project,
    home: sandbox.home,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not found/i);
});

test('switch accepts a project name listed in status', () => {
  const sandbox = makeSandbox();
  const alpha = makeProject(sandbox.workspace, 'alpha-project');
  const beta = makeProject(sandbox.workspace, 'beta-project');

  runCli(['save', 'alpha memory'], { cwd: alpha, home: sandbox.home });
  runCli(['save', 'beta memory'], { cwd: beta, home: sandbox.home });

  const result = runCli(['switch', 'alpha-project', '--json'], {
    cwd: beta,
    home: sandbox.home,
  });

  assert.equal(result.status, 0, result.stderr);
  const json = parseJson(result.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.project.name, 'alpha-project');
  assert.equal(json.project.root, alpha);
});

test('switching to an explicit nested path keeps that exact directory as the project root', () => {
  const sandbox = makeSandbox();
  const parent = makeProject(sandbox.workspace, 'parent-project');
  const child = path.join(parent, 'nested', 'securityclaw');
  fs.mkdirSync(child, { recursive: true });

  runCli(['save', 'parent memory'], { cwd: parent, home: sandbox.home });

  const result = runCli(['switch', child, '--json'], {
    cwd: parent,
    home: sandbox.home,
  });

  assert.equal(result.status, 0, result.stderr);
  const json = parseJson(result.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.project.root, fs.realpathSync.native(child));
  assert.equal(json.project.name, 'securityclaw');
});

test('auto-detect does not let a weak parent marker hijack a child directory', () => {
  const sandbox = makeSandbox();
  const parent = makeProject(sandbox.workspace, 'femi-home');
  const child = path.join(parent, 'Securityclaw');
  fs.mkdirSync(child, { recursive: true });

  const result = runCli(['status', '--json'], {
    cwd: child,
    home: sandbox.home,
  });

  assert.equal(result.status, 0, result.stderr);
  const json = parseJson(result.stdout);
  assert.equal(json.project.root, fs.realpathSync.native(child));
  assert.equal(json.project.name, 'Securityclaw');
});

test('registry-based detection: first run registers cwd, second run from subdirectory reuses it', () => {
  const sandbox = makeSandbox();
  const projectDir = path.join(sandbox.workspace, 'my-app');
  const nested = path.join(projectDir, 'src', 'components');
  fs.mkdirSync(nested, { recursive: true });

  // First run from project root — registers it
  const first = runCli(['status', '--json'], {
    cwd: projectDir,
    home: sandbox.home,
  });
  assert.equal(first.status, 0, first.stderr);
  const firstJson = parseJson(first.stdout);
  assert.equal(firstJson.project.root, fs.realpathSync.native(projectDir));
  assert.equal(firstJson.project.name, 'my-app');

  // Second run from nested subdirectory — reuses registered project
  const second = runCli(['status', '--json'], {
    cwd: nested,
    home: sandbox.home,
  });
  assert.equal(second.status, 0, second.stderr);
  const secondJson = parseJson(second.stdout);
  assert.equal(secondJson.project.root, fs.realpathSync.native(projectDir));
  assert.equal(secondJson.project.name, 'my-app');
});

test('scan suppresses overlapping phone false positive inside API key', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'scan-project');

  const result = runCli(
    ['scan', 'api_key=sk-test-1234567890 and email me@example.com', '--redact', '--json'],
    { cwd: project, home: sandbox.home }
  );

  assert.equal(result.status, 0, result.stderr);
  const json = parseJson(result.stdout);
  const patterns = json.findings.map(f => f.pattern);
  assert.deepEqual(patterns.sort(), ['API Key', 'Email']);
  assert.equal(json.redacted_text, '[REDACTED_SECRET] and email [REDACTED_EMAIL]@example.com');
});

test('pinned memories surface first in recent output', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'pin-project');

  const first = parseJson(runCli(['save', 'older memory', '--json'], { cwd: project, home: sandbox.home }).stdout);
  const second = parseJson(runCli(['save', 'newer memory', '--json'], { cwd: project, home: sandbox.home }).stdout);

  const pinResult = runCli(['pin', first.id, '--json'], { cwd: project, home: sandbox.home });
  assert.equal(pinResult.status, 0, pinResult.stderr);

  const recent = parseJson(runCli(['recent', '--json'], { cwd: project, home: sandbox.home }).stdout);
  assert.equal(recent.memories[0].id, first.id);
  assert.equal(recent.memories[1].id, second.id);
});

test('read commands emit parser-safe JSON', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'json-project');

  const saved = parseJson(runCli(['save', 'Auth uses JWT', '--tags', 'auth,jwt', '--json'], {
    cwd: project,
    home: sandbox.home,
  }).stdout);

  const status = parseJson(runCli(['status', '--json'], { cwd: project, home: sandbox.home }).stdout);
  const recent = parseJson(runCli(['recent', '--json'], { cwd: project, home: sandbox.home }).stdout);
  const search = parseJson(runCli(['search', 'auth', '--json'], { cwd: project, home: sandbox.home }).stdout);
  const ask = parseJson(runCli(['ask', 'What do you know about auth?', '--json'], { cwd: project, home: sandbox.home }).stdout);
  const get = parseJson(runCli(['get', saved.id, '--json'], { cwd: project, home: sandbox.home }).stdout);
  const summary = parseJson(runCli(['summary', '--json'], { cwd: project, home: sandbox.home }).stdout);

  assert.equal(status.project.name, 'json-project');
  assert.equal(recent.count, 1);
  assert.equal(search.count, 1);
  assert.equal(ask.count, 1);
  assert.equal(get.id, saved.id);
  assert.equal(summary.project, 'json-project');
});

test('write commands emit parser-safe JSON', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'write-json-project');

  const saved = parseJson(runCli(['save', 'write json memory', '--json'], {
    cwd: project,
    home: sandbox.home,
  }).stdout);
  assert.equal(saved.ok, true);

  const updated = parseJson(runCli(['update', saved.id, 'write json memory updated', '--json'], {
    cwd: project,
    home: sandbox.home,
  }).stdout);
  assert.equal(updated.ok, true);

  const pinned = parseJson(runCli(['pin', saved.id, '--json'], {
    cwd: project,
    home: sandbox.home,
  }).stdout);
  assert.equal(pinned.ok, true);
  assert.equal(pinned.pinned, true);

  const unpinned = parseJson(runCli(['pin', saved.id, '--unpin', '--json'], {
    cwd: project,
    home: sandbox.home,
  }).stdout);
  assert.equal(unpinned.ok, true);
  assert.equal(unpinned.pinned, false);

  const forgotten = parseJson(runCli(['forget', saved.id, '--json'], {
    cwd: project,
    home: sandbox.home,
  }).stdout);
  assert.equal(forgotten.ok, true);
});

test('ask handles paraphrases and avoids cross-domain false positives', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'ask-paraphrase-project');

  const sshMemory = parseJson(runCli([
    'save',
    'SSH into the VPS with: ssh root@203.0.113.10 -p 22. Use the deploy key and restart docker after login.',
    '--tags',
    'ssh,vps,deploy',
    '--json',
  ], { cwd: project, home: sandbox.home }).stdout);

  const authMemory = parseJson(runCli([
    'save',
    'Production auth uses JWT access tokens plus rotating refresh tokens in httpOnly cookies.',
    '--tags',
    'auth,jwt',
    '--json',
  ], { cwd: project, home: sandbox.home }).stdout);

  parseJson(runCli([
    'save',
    'Billing webhooks are signed with Stripe signatures and retried for up to 72 hours.',
    '--tags',
    'billing,webhooks,stripe',
    '--json',
  ], { cwd: project, home: sandbox.home }).stdout);

  parseJson(runCli([
    'save',
    'Use Tailscale SSH for internal boxes when direct public SSH is disabled.',
    '--tags',
    'ssh,tailscale,infra',
    '--json',
  ], { cwd: project, home: sandbox.home }).stdout);

  const enterBox = parseJson(runCli(['ask', 'How do I enter the box?', '--json'], {
    cwd: project,
    home: sandbox.home,
  }).stdout);
  assert.equal(enterBox.count > 0, true);
  assert.match(enterBox.answer, /ssh/i);

  const privateMachines = parseJson(runCli(['ask', 'How do I use SSH for private machines?', '--json'], {
    cwd: project,
    home: sandbox.home,
  }).stdout);
  assert.equal(privateMachines.count > 0, true);
  assert.match(privateMachines.answer, /tailscale ssh/i);

  const signInUsers = parseJson(runCli(['ask', 'How do I sign in users?', '--json'], {
    cwd: project,
    home: sandbox.home,
  }).stdout);
  assert.equal(signInUsers.count > 0, true);
  assert.equal(signInUsers.results[0].id, authMemory.id);

  const wrongDomain = parseJson(runCli(['ask', 'What machine do I ssh to for billing?', '--json'], {
    cwd: project,
    home: sandbox.home,
  }).stdout);
  assert.equal(wrongDomain.count, 0);
});

test('search boosts strong fields, rewards concept coverage, and exposes explain fields', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'search-ranking-project');

  const tagged = parseJson(runCli([
    'save',
    'Authentication architecture and rollout notes',
    '--tags',
    'auth,jwt',
    '--json',
  ], { cwd: project, home: sandbox.home }).stdout);

  parseJson(runCli([
    'save',
    'This note mentions auth once in the body but is mostly about general cleanup.',
    '--json',
  ], { cwd: project, home: sandbox.home }).stdout);

  const fullCoverage = parseJson(runCli([
    'save',
    'Deploy to the VPS over SSH using the standard deploy workflow.',
    '--tags',
    'deploy,ssh,vps',
    '--json',
  ], { cwd: project, home: sandbox.home }).stdout);

  parseJson(runCli([
    'save',
    'Deploy workflow notes for the release train.',
    '--tags',
    'deploy',
    '--json',
  ], { cwd: project, home: sandbox.home }).stdout);

  const authSearch = parseJson(runCli(['search', 'auth', '--json'], {
    cwd: project,
    home: sandbox.home,
  }).stdout);
  assert.equal(authSearch.results[0].id, tagged.id);
  assert.equal(authSearch.results[0].exact_tag_match, true);
  assert.equal(Array.isArray(authSearch.results[0].matched_terms), true);
  assert.equal(Array.isArray(authSearch.results[0].matched_fields), true);

  const coverageSearch = parseJson(runCli(['search', 'ssh vps deploy', '--json'], {
    cwd: project,
    home: sandbox.home,
  }).stdout);
  assert.equal(coverageSearch.results[0].id, fullCoverage.id);
  assert.equal(coverageSearch.results[0].concept_coverage >= 0.66, true);
  assert.equal(coverageSearch.results[0].matched_fields.includes('tags') || coverageSearch.results[0].matched_fields.includes('summary'), true);
});

test('context command emits budgeted sections and stays silent when empty', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'context-proj');

  const empty = runCli(['context'], { cwd: project, home: sandbox.home });
  assert.equal(empty.stdout.trim(), '');

  parseJson(runCli([
    'save', 'Auth uses JWT with refresh tokens',
    '--tags', 'auth', '--importance', '5', '--json',
  ], { cwd: project, home: sandbox.home }).stdout);

  const pinned = parseJson(runCli([
    'save', 'Never change the project id hashing',
    '--tags', 'critical', '--importance', '5', '--json',
  ], { cwd: project, home: sandbox.home }).stdout);
  runCli(['pin', pinned.id], { cwd: project, home: sandbox.home });

  const out = runCli(['context'], { cwd: project, home: sandbox.home }).stdout;
  assert.match(out, /# Kratos memory/);
  assert.match(out, /## Pinned/);
  assert.match(out, /Never change the project id hashing/);
  assert.match(out, /## Decisions & fixes/);
  assert.match(out, /Auth uses JWT/);

  const json = parseJson(runCli(['context', '--json'], { cwd: project, home: sandbox.home }).stdout);
  assert.equal(json.sections.pinned.length, 1);
  assert.equal(json.sections.important.length >= 1, true);
});

test('hooks install writes valid Claude Code schema and migrates legacy entries', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'hooks-proj');

  const claudeDir = path.join(project, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: 'Edit|Write|MultiEdit', command: 'kratos capture --event post-tool-use' },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] },
      ],
    },
  }, null, 2));

  const install = runCli(['hooks', 'install'], { cwd: project, home: sandbox.home });
  assert.match(install.stdout, /Migrated 1 legacy/);

  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.local.json'), 'utf8'));

  // SessionStart injection installed
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'kratos context');
  // Every kratos entry uses the nested hooks schema Claude Code requires
  for (const event of ['SessionStart', 'PostToolUse', 'Stop']) {
    for (const entry of settings.hooks[event]) {
      assert.equal(Array.isArray(entry.hooks), true, `${event} entry missing nested hooks array`);
    }
  }
  // User's own hook untouched
  const userHook = settings.hooks.PostToolUse.find(e =>
    e.hooks?.some(h => h.command === 'echo user-hook'));
  assert.notEqual(userHook, undefined);

  const uninstall = runCli(['hooks', 'uninstall'], { cwd: project, home: sandbox.home });
  assert.match(uninstall.stdout, /removed/);
  const after = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.local.json'), 'utf8'));
  assert.equal(after.hooks.SessionStart, undefined);
  assert.notEqual(after.hooks.PostToolUse.find(e =>
    e.hooks?.some(h => h.command === 'echo user-hook')), undefined);
});

test('search re-ranks beyond the bm25 cut and respects the limit', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'rank-proj');

  // The winner: exact tag match + importance 5, single mention in the body —
  // weak by bm25 term frequency, strongest under the JS re-ranker.
  const winner = parseJson(runCli([
    'save', 'Production deploy checklist for the release pipeline',
    '--tags', 'deploy', '--importance', '5', '--json',
  ], { cwd: project, home: sandbox.home }).stdout);

  // 30 high term-frequency fillers that bm25 ranks above a single mention
  for (let i = 0; i < 30; i++) {
    parseJson(runCli([
      'save', `deploy deploy deploy scratch note ${i} about deploy deploy retries`,
      '--importance', '1', '--json',
    ], { cwd: project, home: sandbox.home }).stdout);
  }

  const search = parseJson(runCli(['search', 'deploy', '--limit', '10', '--json'], {
    cwd: project,
    home: sandbox.home,
  }).stdout);

  assert.equal(search.results.length, 10);
  assert.equal(search.results[0].id, winner.id);
});

test('git-commit capture saves the last commit once (deduped)', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'git-proj');
  const sh = (cmd) => spawnSync('sh', ['-c', cmd], {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, HOME: sandbox.home, USERPROFILE: sandbox.home },
  });

  sh('git init -q . && git config user.email t@t.co && git config user.name T');
  fs.writeFileSync(path.join(project, 'a.txt'), 'hi');
  sh('git add a.txt && git commit -qm "Add rate limiting"');

  runCli(['capture', '--event', 'git-commit'], { cwd: project, home: sandbox.home });
  runCli(['capture', '--event', 'git-commit'], { cwd: project, home: sandbox.home });

  const recent = parseJson(runCli(['recent', '--json'], { cwd: project, home: sandbox.home }).stdout);
  const commits = recent.memories.filter(m => m.tags.includes('git-commit'));
  assert.equal(commits.length, 1);
  assert.equal(commits[0].summary, 'Add rate limiting');
  assert.deepEqual(commits[0].paths, ['a.txt']);
});

test('ask learns vocabulary from project memories (no hardcoded synonyms)', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'ask-proj');

  // Domain the old hardcoded tables knew nothing about
  const saves = [
    ['Paywall uses RevenueCat, entitlement is checked in SubscriptionManager', 'paywall,revenuecat', '5'],
    ['RevenueCat sandbox receipts fail on simulator, test on device', 'revenuecat,testing', '4'],
    ['Onboarding ends with ATT prompt after the paywall', 'onboarding,att', '4'],
    ['SwiftUI navigation uses NavigationStack with path binding', 'swiftui', '3'],
  ];
  for (const [text, tags, importance] of saves) {
    parseJson(runCli(['save', text, '--tags', tags, '--importance', importance, '--json'],
      { cwd: project, home: sandbox.home }).stdout);
  }

  const ask = parseJson(runCli(['ask', 'how does the paywall work', '--json'],
    { cwd: project, home: sandbox.home }).stdout);
  assert.match(ask.results[0].summary, /RevenueCat/);
  // "revenuecat" was never in the question — learned from co-occurrence
  assert.equal(ask.queries_tried.some(q => q.includes('revenuecat')), true);

  const miss = parseJson(runCli(['ask', 'what is the kubernetes ingress config', '--json'],
    { cwd: project, home: sandbox.home }).stdout);
  assert.equal(miss.count, 0);
});

test('hooks install writes Codex hooks.json and uninstall preserves user entries', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'codex-proj');

  const codexDir = path.join(project, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'echo user-codex-hook' }] }] },
  }, null, 2));

  runCli(['hooks', 'install'], { cwd: project, home: sandbox.home });

  const config = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8'));
  assert.equal(config.hooks.SessionStart[0].hooks[0].command, 'kratos context');
  assert.match(config.hooks.PostToolUse.at(-1).matcher, /apply_patch/);
  assert.equal(config.hooks.Stop[0].hooks[0].command, 'kratos capture --event session-end');
  assert.notEqual(config.hooks.PreToolUse.find(e =>
    e.hooks?.some(h => h.command === 'echo user-codex-hook')), undefined);

  runCli(['hooks', 'uninstall'], { cwd: project, home: sandbox.home });
  const after = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8'));
  assert.equal(after.hooks.SessionStart, undefined);
  assert.notEqual(after.hooks.PreToolUse.find(e =>
    e.hooks?.some(h => h.command === 'echo user-codex-hook')), undefined);
});

test('ask supports --global scope', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'ask-global-proj');

  parseJson(runCli(['save', 'Always use conventional commits everywhere', '--tags', 'rules', '--importance', '5', '--global', '--json'],
    { cwd: project, home: sandbox.home }).stdout);
  parseJson(runCli(['save', 'This project uses tabs not spaces', '--tags', 'style', '--json'],
    { cwd: project, home: sandbox.home }).stdout);

  const globalAsk = parseJson(runCli(['ask', 'what are the commit rules', '--global', '--json'],
    { cwd: project, home: sandbox.home }).stdout);
  assert.equal(globalAsk.count >= 1, true);
  assert.match(globalAsk.results[0].summary, /conventional commits/);

  // Project scope must NOT see the global memory
  const projectAsk = parseJson(runCli(['ask', 'what are the commit rules', '--json'],
    { cwd: project, home: sandbox.home }).stdout);
  assert.equal((projectAsk.results || []).some(r => /conventional/.test(r.summary)), false);
});

test('ask ranks rare terms above common words on a noisy corpus', () => {
  const sandbox = makeSandbox();
  const project = makeProject(sandbox.workspace, 'idf-proj');

  // Noise: high-importance memories sharing the common words of the question
  for (let i = 0; i < 6; i++) {
    parseJson(runCli(['save', `Changed the deploy memory settings for service ${i} hooks cleanup`, '--importance', '5', '--json'],
      { cwd: project, home: sandbox.home }).stdout);
  }
  const exact = parseJson(runCli(['save', 'Release 2.3.1 adds Codex lifecycle hooks support', '--tags', 'release', '--importance', '3', '--json'],
    { cwd: project, home: sandbox.home }).stdout);

  // Broad natural wording; "2.3.1" and "codex" are the rare anchors
  const ask = parseJson(runCli(['ask', 'What changed in release 2.3.1 for Codex hooks?', '--json'],
    { cwd: project, home: sandbox.home }).stdout);
  assert.equal(ask.results[0].id, exact.id);
  // Version token must survive tokenization
  assert.equal(ask.queries_tried.some(q => q.includes('2.3.1')), true);
});
