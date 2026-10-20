'use strict';
// Tests for: project-state compare <name> single-argument mode (v1.1).
// Critical invariant: the live comparison must NEVER write anything into
// .project-state/snapshots/.

const { test } = require('node:test');
const H = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'project-state.js');

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-clive-'));
const { git, cli } = H.bindRunner(proj);
function snapDirEntries() {
  try {
    return fs.readdirSync(path.join(proj, '.project-state', 'snapshots')).sort();
  } catch {
    return [];
  }
}

const LOCK_V1 = {
  name: 'demo',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'demo', version: '1.0.0', dependencies: { lodash: '^4.17.21' } },
    'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
  },
};

test('compare-live setup: repo + snapshot + drift away from it', async () => {
  fs.writeFileSync(path.join(proj, 'app.js'), "console.log('v1');\n");
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { lodash: '^4.17.21' } }, null, 2));
  fs.writeFileSync(path.join(proj, 'package-lock.json'), JSON.stringify(LOCK_V1, null, 2));
  await git(['init']);
  await git(['add', '-A']);
  await git(['commit', '-m', 'init']);
  H.excludeLocalFiles(proj, ['.env']);
  fs.writeFileSync(path.join(proj, '.env'), 'API_KEY=live-secret-777\nDEBUG=\n');
  const s = await cli(['snapshot', 'working']);
  assert.strictEqual(s.status, 0, s.stderr);
  // Drift: new commit + dirty file + env key change
  fs.writeFileSync(path.join(proj, 'app.js'), "console.log('drifted');\n");
  const lock = JSON.parse(JSON.stringify(LOCK_V1));
  lock.packages['node_modules/lodash'].version = '4.17.22';
  fs.writeFileSync(path.join(proj, 'package-lock.json'), JSON.stringify(lock, null, 2));
  fs.writeFileSync(path.join(proj, '.env'), 'API_KEY=live-secret-777\nDEBUG=\nNEW_FLAG=1\n');
  await git(['add', '-A']);
  await git(['commit', '-m', 'drift']);
});

test('compare <name> reports snapshot -> current (live) with correct diffs', async () => {
  const r = await cli(['compare', 'working']);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.ok(out.includes('current (live)'), 'live header present');
  assert.ok(/commit/.test(out), 'git commit diff reported');
  assert.ok(/lodash: 4\.17\.21 -> 4\.17\.22/.test(out), 'lodash version diff reported');
  assert.ok(/NEW_FLAG/.test(out), 'added env key reported');
  assert.ok(!out.includes('live-secret-777'), 'no secret value in output');
  assert.ok(/\d+ difference\(s\)/.test(out), 'summary count present');
});

test('compare <name> writes NOTHING into snapshots/ (hard boundary)', async () => {
  const before = snapDirEntries();
  await cli(['compare', 'working']);
  const after = snapDirEntries();
  assert.deepStrictEqual(after, before, 'snapshots directory must be untouched');
  // Operation locking and transaction recovery use their own metadata dirs;
  // the snapshot inventory and artifacts must remain unchanged.
  const state = fs.readdirSync(path.join(proj, '.project-state')).sort();
  assert.deepStrictEqual(state, ['locks', 'operations', 'secrets', 'snapshots', 'staging'], 'compare may initialize only the documented v2 operation/storage directories');
});

test('compare <name> two-arg mode still works unchanged', async () => {
  await cli(['snapshot', 'drifted']);
  const r = await cli(['compare', 'working', 'drifted']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('current (live)'), 'two-arg header unchanged');
  assert.ok(/lodash: 4\.17\.21 -> 4\.17\.22/.test(r.stdout));
});

test('runtime pin comparison uses private artifact bytes for live and snapshot pairs', async () => {
  const pinProj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-runtime-pin-'));
  try {
    await H.setupGit(pinProj, { '.nvmrc': '22.11.0\n' });
    const { cli: pinCli } = H.bindRunner(pinProj);
    const first = await pinCli(['snapshot', 'pin-before']);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

    const sameLive = await pinCli(['compare', 'pin-before']);
    assert.equal(sameLive.status, 0, `${sameLive.stdout}\n${sameLive.stderr}`);
    assert.doesNotMatch(sameLive.stdout, /runtime pin \.nvmrc changed/,
      'unchanged live pin must not compare the redacted public metadata as an empty value');
    assert.match(sameLive.stdout, /runtime pin \.nvmrc contents match/);
    assert.doesNotMatch(sameLive.stdout, /22\.11\.0/);

    fs.writeFileSync(path.join(pinProj, '.nvmrc'), '24.4.0\n');
    const second = await pinCli(['snapshot', 'pin-after']);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    const pair = await pinCli(['compare', 'pin-before', 'pin-after']);
    assert.equal(pair.status, 0, `${pair.stdout}\n${pair.stderr}`);
    assert.match(pair.stdout, /runtime pin \.nvmrc changed/,
      'snapshot-to-snapshot comparison must read the private pin artifacts');
    assert.doesNotMatch(pair.stdout, /22\.11\.0|24\.4\.0/);
  } finally {
    fs.rmSync(pinProj, { recursive: true, force: true });
  }
});

test('compare <unknown> -> exit 1 with available names', async () => {
  const r = await cli(['compare', 'nope']);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('working'));
});

test('cleanup compare-live fixture', () => {
  fs.rmSync(proj, { recursive: true, force: true });
});
