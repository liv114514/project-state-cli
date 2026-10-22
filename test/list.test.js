'use strict';
// Tests for: project-state list (v1.1 feature).

const { test } = require('node:test');
const H = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'project-state.js');
const U = require('../lib/utils');
const { listCmd } = require('../lib/list');

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-list-'));
const { git, cli } = H.bindRunner(proj);

// Async spawn helper (spawnSync is unavailable in some sandboxed environments).
function makeSnapshot(name, createdAt, opts = {}) {
  H.writeSnapshotGeneration(proj, name, {
    createdAt,
    layerData: {
      git: { commit: 'a'.repeat(40), branch: 'main', detached: false, dirty: false, dirtyCount: 0, statusSample: [] },
      deps: { packageJson: { name: 'fixture', version: null }, lockFile: null, lockFingerprint: null, resolved: null, note: 'fixture' },
      runtime: { node: process.version, npm: null, python: null, versionPins: [] },
    },
  });
  if (opts.secrets) {
    // An old/orphan secrets directory alone is not a declared artifact and
    // must not make list claim that the current generation is restorable.
    const orphan = path.join(proj, '.project-state', 'secrets', name);
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, '.env'), 'K=v\n', 'utf8');
  }
}

test('list: absent inventory is distinguished from a real empty directory', async () => {
  const r = await cli(['list']);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('No snapshot inventory exists yet'));
  assert.ok(r.stdout.includes('Create one with:'), 'next action is introduced');
  assert.ok(r.stdout.includes('snapshot') && r.stdout.includes('before-change'), 'next action contains a concrete snapshot command');
  fs.mkdirSync(path.join(proj, '.project-state', 'snapshots'), { recursive: true });
  const empty = await cli(['list']);
  assert.strictEqual(empty.status, 0, empty.stderr);
  assert.ok(empty.stdout.includes('Snapshot inventory is empty'));
  assert.ok(!empty.stdout.includes('No snapshot inventory exists yet'));
});

test('list: ENOTDIR inventory is an error and never recommends creating a snapshot', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-list-enotdir-'));
  t.after(() => H.removeTemporaryTree(root));
  fs.mkdirSync(path.join(root, '.project-state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.project-state', 'snapshots'), 'blocking file\n');
  const before = fs.readFileSync(path.join(root, '.project-state', 'snapshots'));
  const result = await H.cli(root, ['list']);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /inventory state is unknown \(ENOTDIR\)/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No snapshot inventory|Create one with/);
  assert.deepEqual(fs.readFileSync(path.join(root, '.project-state', 'snapshots')), before);
  assert.deepEqual(fs.readdirSync(path.join(root, '.project-state')), ['snapshots']);
});

test('list: EACCES inventory refusal is non-mutating and distinguishes unreadable state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-list-eacces-'));
  t.after(() => H.removeTemporaryTree(root));
  const base = path.join(root, '.project-state', 'snapshots');
  fs.mkdirSync(base, { recursive: true });
  const before = fs.readdirSync(path.join(root, '.project-state')).sort();
  const original = fs.promises.readdir;
  fs.promises.readdir = async function (target, ...args) {
    if (path.resolve(String(target)) === path.resolve(base)) {
      const error = new Error('synthetic permission refusal');
      error.code = 'EACCES';
      throw error;
    }
    return original.call(this, target, ...args);
  };
  const errorOutput = [];
  const originalError = console.error;
  console.error = (...args) => errorOutput.push(args.join(' '));
  try {
    const status = await listCmd(root);
    assert.equal(status, 2);
    assert.match(errorOutput.join('\n'), /inventory state is unknown \(EACCES\)/);
    assert.doesNotMatch(errorOutput.join('\n'), /Create one with/);
  } finally {
    fs.promises.readdir = original;
    console.error = originalError;
  }
  assert.deepEqual(fs.readdirSync(path.join(root, '.project-state')).sort(), before);
});

test('list: damaged-only metadata is not described as an empty inventory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-list-damaged-only-'));
  t.after(() => H.removeTemporaryTree(root));
  const folder = path.join(root, '.project-state', 'snapshots', 'broken');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'manifest.json'), '{ broken', 'utf8');
  const result = await H.cli(root, ['list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Excluded 1 incomplete, unsupported, or damaged snapshot/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /No snapshot inventory|Create one with/);
  assert.equal(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'), '{ broken');
});

test('list: three snapshots newest first, [auto] flag visible', async () => {
  makeSnapshot('working', '2026-10-09T08:00:00.000Z', { secrets: true });
  makeSnapshot('auto-20261009-083905', '2026-10-09T08:39:05.000Z', { secrets: true });
  makeSnapshot('before-refactor', '2026-10-09T09:00:00.000Z', { secrets: false });
  const r = await cli(['list']);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = r.stdout;
  // newest first
  const iBefore = out.indexOf('before-refactor');
  const iAuto = out.indexOf('auto-20261009-083905');
  const iWorking = out.indexOf('working');
  assert.ok(iBefore < iAuto && iAuto < iWorking, `order wrong: ${iBefore} ${iAuto} ${iWorking}`);
  // auto marker + validated artifact counts. An unlisted secrets directory
  // does not imply that the snapshot is fully restorable.
  assert.ok(out.includes('[auto]'), 'auto marker shown');
  assert.ok(/Collection: 6 layer\(s\), 3 collected\./.test(out), 'collection scope is shown separately from integrity');
  assert.ok(out.includes('3 required artifact(s) verified'), 'validated artifacts are counted');
  assert.ok(!out.includes('fully restorable'), 'list makes no completeness claim based on the secrets directory');
  assert.ok(/2026-10-09 1[0-9]:\d\d|2026-10-09 0\d:\d\d/.test(out), 'human-readable local time');
});

test('list: damaged manifest skipped with warning, others listed', async () => {
  const P = U.snapshotPaths(proj, 'broken-snap');
  fs.mkdirSync(P.snapDir, { recursive: true });
  fs.writeFileSync(path.join(P.snapDir, 'manifest.json'), '{ not valid json', 'utf8');
  const r = await cli(['list']);
  assert.strictEqual(r.status, 0, 'broken snapshot must not fail the listing');
  assert.ok(r.stderr.includes('broken-snap'), 'damaged one named in warning');
  assert.ok(r.stdout.includes('working'), 'healthy ones still listed');
});

test('list: junk dir without manifest is not listed at all', async () => {
  fs.mkdirSync(path.join(proj, '.project-state', 'snapshots', 'garbage-dir'), { recursive: true });
  const r = await cli(['list']);
  assert.strictEqual(r.status, 0);
  assert.ok(!r.stdout.includes('garbage-dir'));
  assert.ok(r.stderr.includes('garbage-dir'), 'incomplete candidate is diagnosed, not shown as a snapshot');
});

test('cleanup list fixture', () => {
  fs.rmSync(proj, { recursive: true, force: true });
});
