'use strict';
// Tests for: prune v1.2 extension - hook- snapshots are managed alongside
// auto- snapshots; named snapshots remain unreachable.

const { test } = require('node:test');
const H = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'project-state.js');
const U = require('../lib/utils');

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-prune12-'));
const { git, cli } = H.bindRunner(proj);

function makeSnapshot(name, createdAt) {
  H.writeSnapshotGeneration(proj, name, {
    createdAt,
    layerData: { git: { commit: 'a'.repeat(40), branch: 'main', detached: false, dirty: false, dirtyCount: 0, statusSample: [] } },
  });
}

function exists(name) {
  return U.existsSync(path.join(proj, U.SNAPSHOTS_DIR, name, 'current.json'));
}

test('prune12 setup: 2 auto + 2 hook + 2 named', () => {
  makeSnapshot('auto-20261009-010101', '2026-10-09T01:01:01.000Z');
  makeSnapshot('auto-20261009-020202', '2026-10-09T02:02:02.000Z');
  makeSnapshot('hook-20261009-030303', '2026-10-09T03:03:03.000Z');
  makeSnapshot('hook-20261009-040404', '2026-10-09T04:04:04.000Z');
  makeSnapshot('working', '2026-10-09T05:05:05.000Z');
  makeSnapshot('before-refactor', '2026-10-09T06:06:06.000Z');
});

test('prune --keep 2 --yes: oldest two managed snapshots deleted across both prefixes', async () => {
  const r = await cli(['prune', '--keep', '2', '--yes']);
  assert.strictEqual(r.status, 0);
  assert.ok(!exists('auto-20261009-010101'), 'oldest auto deleted');
  assert.ok(!exists('auto-20261009-020202'), 'second auto deleted');
  assert.ok(exists('hook-20261009-030303'), 'hook kept (within newest 2)');
  assert.ok(exists('hook-20261009-040404'), 'newest hook kept');
  assert.ok(exists('working') && exists('before-refactor'), 'named snapshots NEVER touched');
});

test('prune keeps removing old hook snapshots as they age out', async () => {
  const r = await cli(['prune', '--keep', '0', '--yes']);
  assert.strictEqual(r.status, 0);
  assert.ok(!exists('hook-20261009-030303') && !exists('hook-20261009-040404'), 'hook snapshots managed by prune');
  assert.ok(exists('working') && exists('before-refactor'), 'named snapshots still untouched');
  const l = await cli(['list']);
  assert.ok(!/\[auto\]|\[hook\]/.test(l.stdout), 'no managed snapshots left');
});

test('cleanup prune12 fixture', () => {
  fs.rmSync(proj, { recursive: true, force: true });
});
