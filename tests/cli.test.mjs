import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI_PATH = path.resolve('/Users/femi/sso/kratos-cli/dist/cli/index.js');

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
