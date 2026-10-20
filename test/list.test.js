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

test('list: empty project -> friendly hint, exit 0', async () => {
  const r = await cli(['list']);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('No snapshots yet'));
  assert.ok(r.stdout.includes('project-state snapshot'), 'next action offered');
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
  assert.ok(/6 layers \(3 collected\)/.test(out), 'layer stats counted');
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
