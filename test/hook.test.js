'use strict';
// Tests for: project-state hook install/uninstall (v1.2).
// Contract under test: the hook is a tenant - foreign hooks survive installs
// byte-for-byte, chain correctly during commits, and are restored exactly.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'project-state.js');
const Hook = require('../lib/hook');
const { BEGIN_MARKER, BACKUP_NAME } = Hook;

const { git, cli, setupGit } = require('./helpers');

function preCommit(proj) {
  return path.join(proj, '.git', 'hooks', 'pre-commit');
}

function setupRepo(proj) {
  fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  return git(proj, ['init']).then(() => git(proj, ['add', '-A'])).then(() => git(proj, ['commit', '-m', 'init']));
}

test('hook install on a repo without pre-commit: writes managed block', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-hk-a-'));
  try {
    await setupRepo(proj);
    const r = await cli(proj, ['hook', 'install']);
    assert.strictEqual(r.status, 0, r.stderr);
    const content = fs.readFileSync(preCommit(proj), 'utf8');
    assert.ok(content.includes(BEGIN_MARKER), 'managed markers present');
    assert.ok(content.includes('hook-$(date'), 'snapshot call present');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('hook install with foreign pre-commit: chained, original byte-for-byte in backup', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-hk-b-'));
  try {
    await setupRepo(proj);
    const original = '#!/bin/sh\necho foreign-ran > foreign-marker.txt\necho "lint ok"\n';
    fs.writeFileSync(preCommit(proj), original, 'utf8');
    fs.chmodSync(preCommit(proj), 0o755);
    const r = await cli(proj, ['hook', 'install']);
    assert.strictEqual(r.status, 0, r.stderr);
    const backup = fs.readFileSync(path.join(proj, '.git', 'hooks', BACKUP_NAME), 'utf8');
    assert.strictEqual(backup, original, 'original preserved byte-for-byte');
    assert.ok(!fs.readFileSync(preCommit(proj), 'utf8').includes('foreign-ran'), 'foreign logic moved out of pre-commit');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('git commit with installed hook: foreign logic RUNS + hook- snapshot created', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-hk-c-'));
  try {
    await setupRepo(proj);
    fs.writeFileSync(preCommit(proj), '#!/bin/sh\necho foreign-ran > foreign-marker.txt\n', 'utf8');
    fs.chmodSync(preCommit(proj), 0o755);
    await cli(proj, ['hook', 'install']);
    fs.writeFileSync(path.join(proj, 'app.js'), 'x(2);\n');
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'with hook']);
    assert.ok(fs.existsSync(path.join(proj, 'foreign-marker.txt')), 'foreign hook logic executed');
    const l = await cli(proj, ['list']);
    assert.strictEqual(l.status, 0, l.stderr);
    assert.ok(/hook-\d{8}-\d{6}.*\[hook\]/.test(l.stdout), 'hook- snapshot listed with [hook] tag');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('hard-linked hook.log failure does not block a real commit or modify the external target', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-hk-hardlink-'));
  const outsideMarker = path.join(os.tmpdir(), `pss-hook-log-marker-${process.pid}-${Date.now()}`);
  const originalBytes = Buffer.from('external log marker must remain byte-for-byte unchanged\n');
  try {
    await setupRepo(proj);
    const initialHead = (await git(proj, ['rev-parse', 'HEAD'])).trim();
    const installed = await cli(proj, ['hook', 'install']);
    assert.strictEqual(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);

    fs.writeFileSync(outsideMarker, originalBytes);
    const stateDir = path.join(proj, '.project-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const hookLog = path.join(stateDir, 'hook.log');
    fs.linkSync(outsideMarker, hookLog);
    assert.ok(fs.lstatSync(outsideMarker).nlink > 1, 'fixture is a real hard link to a file outside the repository');

    fs.writeFileSync(path.join(proj, 'app.js'), 'x(4);\n');
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'commit with hard-linked project-state log']);

    const committedHead = (await git(proj, ['rev-parse', 'HEAD'])).trim();
    assert.notStrictEqual(committedHead, initialHead, "tool-owned log failure does not block the user's commit");
    assert.deepStrictEqual(fs.readFileSync(outsideMarker), originalBytes, 'external hard-link target bytes are not appended to or changed');
    assert.deepStrictEqual(fs.readFileSync(hookLog), originalBytes, 'the repository hook.log hard link remains untouched');
    assert.ok(fs.lstatSync(hookLog).nlink > 1, 'hook.log remains hard-linked; logging did not replace the unsafe path');
    assert.strictEqual(fs.statSync(outsideMarker).ino, fs.statSync(hookLog).ino, 'hook.log was not replaced to evade the link check');

    const listed = await cli(proj, ['list']);
    assert.strictEqual(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
    assert.match(listed.stdout, /hook-\d{8}-\d{6}.*\[hook\]/,
      'the managed hook ran and snapshot work completed despite best-effort log refusal');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(outsideMarker, { force: true });
  }
});

test('C03 hook log open race rejects a raced-in hardlink and never blocks the caller', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-c03-hook-log-race-'));
  const outside = path.join(os.tmpdir(), `pss-c03-hook-race-${process.pid}-${Date.now()}.txt`);
  const original = Buffer.from('external log must remain unchanged\n');
  const realOpen = fs.promises.open;
  try {
    await setupRepo(proj);
    const state = path.join(proj, '.project-state');
    fs.mkdirSync(state, { recursive: true });
    const log = path.join(state, 'hook.log');
    fs.writeFileSync(log, 'safe initial log\n');
    fs.writeFileSync(outside, original);
    fs.promises.open = async function(target, ...args) {
      if (path.resolve(String(target)) === log) {
        fs.unlinkSync(log);
        fs.linkSync(outside, log);
        return realOpen.call(fs.promises, target, ...args);
      }
      return realOpen.call(fs.promises, target, ...args);
    };
    await Hook.appendHookLog(proj, 'completed');
    fs.promises.open = realOpen;
    assert.deepStrictEqual(fs.readFileSync(outside), original, 'opened handle link count and path identity are checked before append');
    assert.deepStrictEqual(fs.readFileSync(log), original);
    assert.ok(fs.statSync(log).nlink > 1);
  } finally {
    fs.promises.open = realOpen;
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('foreign hook FAILURE blocks commit AND produces no hook snapshot', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-hk-d-'));
  try {
    await setupRepo(proj);
    fs.writeFileSync(preCommit(proj), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n', 'utf8');
    fs.chmodSync(preCommit(proj), 0o755);
    await cli(proj, ['hook', 'install']);
    fs.writeFileSync(path.join(proj, 'app.js'), 'x(3);\n');
    await git(proj, ['add', '-A']);
    const r = await git(proj, ['commit', '-m', 'should be blocked']).then(
      () => 'committed',
      () => 'blocked'
    );
    assert.strictEqual(r, 'blocked', 'foreign hook still blocks the commit');
    const l = await cli(proj, ['list']);
    assert.ok(!/hook-\d{8}/.test(l.stdout), 'no snapshot for a rejected commit');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('hook uninstall with foreign hook: restored byte-for-byte, zero tool traces', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-hk-e-'));
  try {
    await setupRepo(proj);
    const original = '#!/bin/sh\necho foreign-ran > foreign-marker.txt\n';
    fs.writeFileSync(preCommit(proj), original, 'utf8');
    fs.chmodSync(preCommit(proj), 0o755);
    await cli(proj, ['hook', 'install']);
    const u = await cli(proj, ['hook', 'uninstall']);
    assert.strictEqual(u.status, 0, u.stderr);
    assert.strictEqual(fs.readFileSync(preCommit(proj), 'utf8'), original, 'byte-for-byte restore');
    assert.ok(!fs.existsSync(path.join(proj, '.git', 'hooks', BACKUP_NAME)), 'backup cleaned up');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('hook uninstall refuses modified wrapper and preserves user logic plus backup', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-hk-modified-'));
  try {
    await setupRepo(proj);
    const original = '#!/bin/sh\necho foreign-ran > foreign-marker.txt\n';
    fs.writeFileSync(preCommit(proj), original, 'utf8');
    fs.chmodSync(preCommit(proj), 0o755);
    await cli(proj, ['hook', 'install']);
    const modified = '#!/bin/sh\necho user-added-before-wrapper\n' + fs.readFileSync(preCommit(proj), 'utf8');
    fs.writeFileSync(preCommit(proj), modified, 'utf8');
    const u = await cli(proj, ['hook', 'uninstall']);
    assert.equal(u.status, 1);
    assert.equal(fs.readFileSync(preCommit(proj), 'utf8'), modified);
    assert.equal(fs.readFileSync(path.join(proj, '.git', 'hooks', BACKUP_NAME), 'utf8'), original);
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('hook uninstall with no foreign hook: pre-commit removed entirely', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-hk-f-'));
  try {
    await setupRepo(proj);
    await cli(proj, ['hook', 'install']);
    const u = await cli(proj, ['hook', 'uninstall']);
    assert.strictEqual(u.status, 0);
    assert.ok(!fs.existsSync(preCommit(proj)));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('hook uninstall when not installed -> exit 1 with clear report', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-hk-g-'));
  try {
    await setupRepo(proj);
    const u = await cli(proj, ['hook', 'uninstall']);
    assert.strictEqual(u.status, 1);
    assert.ok(u.stderr.includes('not installed'));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('hook install when already installed -> idempotent, exit 0', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-hk-h-'));
  try {
    await setupRepo(proj);
    await cli(proj, ['hook', 'install']);
    const r = await cli(proj, ['hook', 'install']);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('already installed'));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('hook install refused when core.hooksPath is overridden (husky-style)', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-hk-i-'));
  try {
    await setupRepo(proj);
    await git(proj, ['config', 'core.hooksPath', '.githooks']);
    const r = await cli(proj, ['hook', 'install']);
    assert.strictEqual(r.status, 1);
    assert.ok(r.stderr.includes('core.hooksPath'), 'three-part explanation names the cause');
    assert.ok(r.stderr.includes('Why :') && r.stderr.includes('Next:'), 'three-part error format');
    assert.ok(!fs.existsSync(preCommit(proj)), 'nothing written to .git/hooks');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
