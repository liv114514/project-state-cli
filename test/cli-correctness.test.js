'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const CLI = path.join(__dirname, '..', 'bin', 'project-state.js');
const U = require('../lib/utils');
const Store = require('../lib/storage');
const { snapshotInternal } = require('../lib/snapshot');
const { validCreatedAt, collisionOrdinal } = require('../lib/prune');

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'project-state-test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'project-state-test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
function git(cwd, args, env = gitEnv) {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(stderr || error.message), { code: error.code, status: error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? null : error.code }));
    else resolve({ stdout, stderr });
  }));
}
function cli(cwd, args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: gitEnv, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ status: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}
async function setupGit(root, files = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 1;\n');
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  await git(root, ['init']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'initial']);
}
function tempRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

test('F05 compare reports database equality as unknown when data is unavailable', async () => {
  const root = tempRoot('pss-db-compare-');
  try {
    await setupGit(root);
    for (const name of ['before', 'after']) {
      const snap = await cli(root, ['snapshot', name]);
      assert.equal(snap.status, 0, `${snap.stdout}\n${snap.stderr}`);
    }
    const result = await cli(root, ['compare', 'before', 'after']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /database row contents 未比较/);
    assert.match(result.stdout, /database metadata\/schema 未比较|database collection skipped in both/);
    assert.doesNotMatch(result.stdout, /No differences found across all layers/);
    assert.doesNotMatch(result.stdout, /[a-f0-9]{64}/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F06 prune uses manifest time across auto/hook and respects persistent generation pins', async () => {
  const root = tempRoot('pss-prune-');
  try {
    await setupGit(root);
    const oldName = `hook-${stamp()}`;
    const old = await snapshotInternal(root, oldName, { kind: 'hook' });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const newName = `auto-${stamp()}`;
    const newer = await snapshotInternal(root, newName, { kind: 'auto' });
    const pin = await Store.pinSnapshot(root, { name: newName, generation: newer.generation, operationId: Store.randomId(), reason: 'manual' });
    assert.ok(old.generation);
    const result = await cli(root, ['prune', '--keep', '0', '--yes']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /pinned|referenced/i);
    assert.ok(fs.existsSync(path.join(root, U.SNAPSHOTS_DIR, oldName, 'current.json')) === false, 'older hook generation is retired despite its lexically later prefix');
    assert.ok(fs.existsSync(path.join(root, U.SNAPSHOTS_DIR, newName, 'current.json')), 'pinned newer generation remains current');
    assert.ok(pin && (pin.pinId || pin.id || typeof pin === 'string'), 'pin is persisted');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F06 invalid and future prune timestamps are retained; same-second suffixes sort numerically', () => {
  assert.equal(validCreatedAt('not-a-time'), false);
  assert.equal(validCreatedAt('2100-01-01T00:00:00.000Z'), false);
  assert.equal(validCreatedAt('2000-01-01T00:00:00.000Z'), true);
  assert.ok(collisionOrdinal('auto-20261017-120000-10') > collisionOrdinal('auto-20261017-120000-2'));
  assert.equal(collisionOrdinal('auto-20261017-120000'), 0);
  assert.equal(collisionOrdinal('hook-20261017-120000'), 0);
  assert.equal(collisionOrdinal('hook-20261017-120000-10'), 10);
});

test('recover CLI inspects and resolves a killed snapshot after current pointer publication', async () => {
  const root = tempRoot('pss-recover-snapshot-');
  try {
    await setupGit(root);
    const initial = await cli(root, ['snapshot', 'recover-target']);
    assert.equal(initial.status, 0, `${initial.stdout}\n${initial.stderr}`);
    const childSource = String.raw`
      const fs = require('node:fs');
      const path = require('node:path');
      const { snapshotInternal } = require('./lib/snapshot');
      const fsp = fs.promises;
      const rename = fsp.rename.bind(fsp);
      fsp.rename = async (from, to) => {
        const result = await rename(from, to);
        if (path.basename(to) === 'current.json') {
          process.stderr.write('KILLPOINT:pointer-published\\n');
          process.kill(process.pid, 'SIGKILL');
        }
        return result;
      };
      snapshotInternal(process.argv[1], process.argv[2], { overwrite: true })
        .catch((error) => { process.stderr.write('CHILD_ERROR:' + String(error.stack || error)); process.exitCode = 1; });
    `;
    const child = spawn(process.execPath, ['-e', childSource, root, 'recover-target'], {
      cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childStderr = '';
    child.stderr.on('data', (chunk) => { childStderr += chunk; });
    const termination = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.ok(termination.signal || termination.code !== 0, `child must terminate abnormally: ${childStderr}`);
    assert.match(childStderr, /KILLPOINT:pointer-published/);
    assert.doesNotMatch(childStderr, /CHILD_ERROR/);

    const operationDir = path.join(root, '.project-state', 'operations');
    const journals = await Promise.all((await fs.promises.readdir(operationDir)).map(async (file) =>
      Store.readJournal(root, path.join(operationDir, file))));
    const pending = journals.find((journal) => journal.operation === 'snapshot' && journal.status === 'in-progress' && !journal.terminalOutcome);
    assert.ok(pending, 'killed snapshot journal remains unresolved');
    const lockDir = path.join(root, '.project-state', 'locks', 'operation.lock');
    assert.ok(fs.existsSync(lockDir), 'killed snapshot lock remains until explicit recovery');

    const inspected = await cli(root, ['recover', pending.operationId, '--inspect']);
    assert.equal(inspected.status, 0, `${inspected.stdout}\n${inspected.stderr}`);
    assert.match(inspected.stdout, /Snapshot operation .*process not running/);
    assert.match(inspected.stdout, /resolution: published/);
    assert.ok(fs.existsSync(lockDir), 'inspect is read-only and leaves the stale lock in place');

    const resolved = await cli(root, ['recover', pending.operationId, '--compensate', '--yes']);
    assert.equal(resolved.status, 0, `${resolved.stdout}\n${resolved.stderr}`);
    assert.match(resolved.stdout, /resolved: completed/);
    assert.equal(fs.existsSync(lockDir), false, 'verified resolution releases only its claimed lock');
    const finalJournal = await Store.readJournal(root, Store.operationJournalPath(root, pending.operationId));
    assert.equal(finalJournal.snapshotTransaction.phase, 'committed');
    assert.equal(finalJournal.terminalOutcome, 'verified-complete');
    const finalSnapshot = await Store.validateSnapshot(root, 'recover-target', { mode: 'restore' });
    assert.equal(finalSnapshot.generation, pending.snapshotTransaction.generation);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('recover CLI refuses ambiguous snapshot pointer evidence and retains lock and generations', async () => {
  const root = tempRoot('pss-recover-ambiguous-');
  try {
    await setupGit(root);
    assert.equal((await cli(root, ['snapshot', 'ambiguous-target'])).status, 0);
    const childSource = String.raw`
      const fs = require('node:fs');
      const path = require('node:path');
      const { snapshotInternal } = require('./lib/snapshot');
      const fsp = fs.promises;
      const rename = fsp.rename.bind(fsp);
      fsp.rename = async (from, to) => {
        const result = await rename(from, to);
        if (path.basename(to) === 'current.json') {
          process.stderr.write('KILLPOINT:pointer-published\\n');
          process.kill(process.pid, 'SIGKILL');
        }
        return result;
      };
      snapshotInternal(process.argv[1], process.argv[2], { overwrite: true })
        .catch((error) => { process.stderr.write('CHILD_ERROR:' + String(error.stack || error)); process.exitCode = 1; });
    `;
    const child = spawn(process.execPath, ['-e', childSource, root, 'ambiguous-target'], {
      cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let childStderr = '';
    child.stderr.on('data', (chunk) => { childStderr += chunk; });
    const termination = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.ok(termination.signal || termination.code !== 0, `child must terminate abnormally: ${childStderr}`);
    assert.match(childStderr, /KILLPOINT:pointer-published/);
    const opDir = path.join(root, '.project-state', 'operations');
    const journals = await Promise.all((await fs.promises.readdir(opDir)).map((file) => Store.readJournal(root, path.join(opDir, file))));
    const pending = journals.find((journal) => journal.operation === 'snapshot' && journal.status === 'in-progress' && !journal.terminalOutcome);
    assert.ok(pending);

    const currentFile = path.join(root, '.project-state', 'snapshots', 'ambiguous-target', 'current.json');
    fs.writeFileSync(currentFile, '{ damaged pointer evidence');
    const rejected = await cli(root, ['recover', pending.operationId, '--compensate', '--yes']);
    assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
    assert.match(rejected.stderr, /Keep the operation lock, journal, snapshot generations and staging data/);
    assert.ok(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')));
    const unchangedJournal = await Store.readJournal(root, Store.operationJournalPath(root, pending.operationId));
    assert.equal(unchangedJournal.status, 'in-progress');
    assert.equal(unchangedJournal.terminalOutcome, undefined);
    for (const generation of [pending.snapshotTransaction.previousGeneration, pending.snapshotTransaction.generation]) {
      assert.ok(fs.existsSync(path.join(root, '.project-state', 'snapshots', 'ambiguous-target', 'generations', generation)));
      assert.ok(fs.existsSync(path.join(root, '.project-state', 'secrets', 'ambiguous-target', 'generations', generation)));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F07 hook unknown options return a controlled CLI error without changing hooks', async () => {
  const root = tempRoot('pss-hook-args-');
  try {
    await setupGit(root);
    const result = await cli(root, ['hook', 'install', '--not-a-real-option']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Unknown option/);
    assert.equal(fs.existsSync(path.join(root, '.git', 'hooks', 'pre-commit')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unknown legacy hook flag is rejected and cannot mint a prunable hook snapshot', async () => {
  const root = tempRoot('pss-hook-legacy-flag-');
  try {
    await setupGit(root);
    const result = await cli(root, ['snapshot', 'hook-20261017-120000', '--hook-internal']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Unknown option "--hook-internal"/);
    assert.equal(fs.existsSync(path.join(root, U.SNAPSHOTS_DIR, 'hook-20261017-120000')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F09 tool storage and log failures do not block a real git commit', async () => {
  const root = tempRoot('pss-hook-failure-');
  try {
    await setupGit(root);
    const install = await cli(root, ['hook', 'install']);
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    fs.writeFileSync(path.join(root, '.project-state'), 'occupied');
    fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 2;\n');
    await git(root, ['add', 'app.js']);
    await git(root, ['commit', '-m', 'tool failure must not block']);
    const head = await git(root, ['log', '-1', '--format=%s']);
    assert.equal(head.stdout.trim(), 'tool failure must not block');
    assert.equal(fs.readFileSync(path.join(root, '.project-state'), 'utf8'), 'occupied');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F09 log-only failure does not block commit after a hook snapshot succeeds', async () => {
  const root = tempRoot('pss-hook-log-only-');
  try {
    await setupGit(root);
    const install = await cli(root, ['hook', 'install']);
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    const state = path.join(root, '.project-state');
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(path.join(state, 'hook.log'));
    fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 4;\n');
    await git(root, ['add', 'app.js']);
    await git(root, ['commit', '-m', 'log failure must not block']);
    assert.equal((await git(root, ['log', '-1', '--format=%s'])).stdout.trim(), 'log failure must not block');
    const snapshots = path.join(state, 'snapshots');
    assert.ok(fs.readdirSync(snapshots).some((name) => name.startsWith('hook-')), 'hook snapshot committed despite log failure');
    assert.ok(fs.statSync(path.join(state, 'hook.log')).isDirectory(), 'failed log target was left untouched');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F09 hook snapshot storage failure is logged when logging remains available and commit proceeds', async () => {
  const root = tempRoot('pss-hook-storage-only-');
  try {
    await setupGit(root);
    const install = await cli(root, ['hook', 'install']);
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    const state = path.join(root, '.project-state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'snapshots'), 'blocked');
    fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 5;\n');
    await git(root, ['add', 'app.js']);
    await git(root, ['commit', '-m', 'snapshot failure must not block']);
    assert.equal((await git(root, ['log', '-1', '--format=%s'])).stdout.trim(), 'snapshot failure must not block');
    assert.match(fs.readFileSync(path.join(state, 'hook.log'), 'utf8'), /failed or timed out/);
    assert.equal(fs.readFileSync(path.join(state, 'snapshots'), 'utf8'), 'blocked');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('foreign hook failure still blocks commit and foreign hook bytes survive uninstall', async () => {
  const root = tempRoot('pss-hook-foreign-');
  try {
    await setupGit(root);
    const hookPath = path.join(root, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    const foreign = Buffer.from('#!/bin/sh\nprintf marker > foreign.marker\nexit 23\n');
    fs.writeFileSync(hookPath, foreign);
    fs.chmodSync(hookPath, 0o755);
    const install = await cli(root, ['hook', 'install']);
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    const before = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 3;\n');
    await git(root, ['add', 'app.js']);
    await assert.rejects(git(root, ['commit', '-m', 'foreign hook should block']));
    assert.equal((await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), before);
    assert.equal(fs.readFileSync(path.join(root, 'foreign.marker'), 'utf8'), 'marker');
    const uninstall = await cli(root, ['hook', 'uninstall']);
    assert.equal(uninstall.status, 0, `${uninstall.stdout}\n${uninstall.stderr}`);
    assert.deepEqual(fs.readFileSync(hookPath), foreign);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
