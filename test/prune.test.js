'use strict';
// Tests for: project-state prune (v1.1).
// Iron rule under test: named snapshots are NEVER on any deletion path.

const { test } = require('node:test');
const H = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'project-state.js');
const U = require('../lib/utils');

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-prune-'));
const { git, cli } = H.bindRunner(proj);

function makeSnapshot(name, createdAt) {
  H.writeSnapshotGeneration(proj, name, {
    createdAt,
    layerData: {
      git: { commit: 'a'.repeat(40), branch: 'main', detached: false, dirty: false, dirtyCount: 0, statusSample: [] },
      deps: { packageJson: { name: 'fixture', version: null }, lockFile: null, lockFingerprint: null, resolved: null, note: 'fixture' },
      runtime: { node: process.version, npm: null, python: null, versionPins: [] },
      config: { envFiles: { '.env': { keyCount: 1, keys: { K: { nonEmpty: true } } } } },
    },
    privateFiles: [{ id: 'config:env', layer: 'config', kind: 'file', path: '.env', target: '.env', content: 'K=v\n' }],
  });
}

function exists(name) {
  return U.existsSync(path.join(proj, U.SNAPSHOTS_DIR, name, 'current.json'));
}

test('prune setup: 3 auto + 2 named snapshots', () => {
  makeSnapshot('auto-20261009-010101', '2026-10-09T01:01:01.000Z');
  makeSnapshot('auto-20261009-020202', '2026-10-09T02:02:02.000Z');
  makeSnapshot('auto-20261009-030303', '2026-10-09T03:03:03.000Z');
  makeSnapshot('working', '2026-10-09T04:04:04.000Z');
  makeSnapshot('before-refactor', '2026-10-09T05:05:05.000Z');
  assert.ok(exists('auto-20261009-010101'));
});

test('prune default keep=10 with 3 autos: all complete managed generations retained', async () => {
  const r = await cli(['prune']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /would retire 0/);
  assert.match(r.stdout, /Dry run - nothing was deleted/);
  assert.ok(exists('auto-20261009-010101'), 'dry-run/no-op deleted nothing');
});

test('prune with keep=1 dry-run: shows the 2 oldest, keeps newest, deletes nothing', async () => {
  const r = await cli(['prune', '--keep', '1']);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.ok(out.includes('would retire 2'), 'retirement count listed');
  assert.ok(out.includes('auto-20261009-010101') && out.includes('auto-20261009-020202'), 'oldest two listed');
  const planned = out.split(/\r?\n/).filter((line) => /generation=/.test(line)).map((line) => line.trim().split(/\s+/)[0]);
  assert.deepEqual(planned, ['auto-20261009-010101', 'auto-20261009-020202'], 'plan lists exactly the two oldest generations');
  assert.ok(out.includes('Dry run - nothing was deleted'));
  assert.ok(exists('auto-20261009-010101'), 'dry run deleted nothing');
});

test('prune --keep 1 --yes: deletes exactly the 2 oldest autos, named untouched, secrets removed', async () => {
  const r = await cli(['prune', '--keep', '1', '--yes']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!exists('auto-20261009-010101'), 'oldest deleted');
  assert.ok(!exists('auto-20261009-020202'), 'second deleted');
  assert.ok(exists('auto-20261009-030303'), 'newest kept');
  assert.ok(exists('working'), 'named snapshot NEVER touched');
  assert.ok(exists('before-refactor'), 'named snapshot NEVER touched');
  const retiredPrivateGenerations = path.join(proj, U.SECRETS_DIR, 'auto-20261009-010101', 'generations');
  assert.ok(!U.existsSync(retiredPrivateGenerations) || fs.readdirSync(retiredPrivateGenerations).length === 0, 'retired private generation bytes are removed');
  assert.ok(fs.readdirSync(path.join(proj, U.SECRETS_DIR, 'working', 'generations')).length > 0, 'named private generation remains intact');
});

test('prune --keep 0 --yes deletes every auto snapshot', async () => {
  const r = await cli(['prune', '--keep', '0', '--yes']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!exists('auto-20261009-030303'));
  assert.ok(exists('working') && exists('before-refactor'));
});

test('prune with no auto snapshots -> friendly exit 0', async () => {
  const r = await cli(['prune', '--yes']);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('No eligible auto/hook generation can be retired.'));
});

test('prune --keep abc -> exit 1 with three-part error', async () => {
  const r = await cli(['prune', '--keep', 'abc']);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('Invalid --keep value'));
  assert.ok(r.stderr.includes('Why :') && r.stderr.includes('Next:'), 'three-part error format');
});

test('cleanup prune fixture', () => {
  fs.rmSync(proj, { recursive: true, force: true });
});
