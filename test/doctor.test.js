'use strict';
// Tests for: project-state doctor (v1.2) - read-only, three-state verdicts.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'project-state.js');

const { git, cli, setupGit, excludeLocalFiles } = require('./helpers');

function setup(proj) {
  fs.mkdirSync(path.join(proj, 'node_modules', 'lodash'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { lodash: '^4.17.21' } }));
  fs.writeFileSync(path.join(proj, 'package-lock.json'), JSON.stringify(LOCK));
  fs.writeFileSync(path.join(proj, 'node_modules', 'lodash', 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.21' }));
  fs.writeFileSync(path.join(proj, '.env'), 'API_KEY=abc\n');
  fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
}

const LOCK = {
  name: 'demo',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: {
    '': { name: 'demo', version: '1.0.0', dependencies: { lodash: '^4.17.21' } },
    'node_modules/lodash': { version: '4.17.21' },
  },
};

test('doctor: healthy project -> all ok, exit 0', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-doc-ok-'));
  try {
    setup(proj);
    await git(proj, ['init']);
    excludeLocalFiles(proj, ['.env', '.env.local']);
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'init']);
    const r = await cli(proj, ['snapshot', 'baseline']);
    assert.strictEqual(r.status, 0, r.stderr);
    const d = await cli(proj, ['doctor']);
    assert.strictEqual(d.status, 0, `stdout: ${d.stdout}`);
    const out = d.stdout;
    assert.ok(/git\s+ok/.test(out), 'git ok');
    assert.ok(/deps sync\s+ok/.test(out), 'deps in sync');
    assert.ok(/env keys\s+ok/.test(out), 'env keys match baseline');
    assert.ok(/sqlite3\s+(ok|unknown)/.test(out), 'sqlite3 probed honestly');
    assert.ok(/Verdict:/.test(out), 'one-line verdict present');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('doctor: dependency drift + missing env key correctly blamed, exit 1', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-doc-bad-'));
  try {
    setup(proj);
    await git(proj, ['init']);
    excludeLocalFiles(proj, ['.env', '.env.local']);
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'init']);
    await cli(proj, ['snapshot', 'baseline']);
    // Break: node_modules version drift + .env key removed (key name, not just value)
    fs.writeFileSync(path.join(proj, 'node_modules', 'lodash', 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.15' }));
    fs.writeFileSync(path.join(proj, '.env'), 'DEBUG=1\n');
    const d = await cli(proj, ['doctor']);
    assert.strictEqual(d.status, 1, 'issues must yield exit 1');
    const out = d.stdout;
    assert.ok(/lodash: lockfile 4\.17\.21, node_modules 4\.17\.15/.test(out), 'drift named precisely');
    assert.ok(out.includes('Next:'), 'issues carry an actionable next step');
    assert.ok(/env keys\s+issue/.test(out), 'env drift flagged');
    assert.ok(/Verdict: 2 issue/.test(out), 'verdict counts both issues');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('doctor: missing node_modules -> issue with npm install advice', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-doc-fresh-'));
  try {
    setup(proj);
    await git(proj, ['init']);
    excludeLocalFiles(proj, ['.env', '.env.local']);
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'init']);
    await cli(proj, ['snapshot', 'baseline']);
    fs.rmSync(path.join(proj, 'node_modules'), { recursive: true, force: true });
    const d = await cli(proj, ['doctor']);
    assert.strictEqual(d.status, 1);
    assert.ok(/MISSING in node_modules/.test(d.stdout));
    assert.ok(d.stdout.includes('npm install'));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('doctor: no snapshots -> env keys unknown (honest, not guessed), exit reflects only real issues', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-doc-nosnap-'));
  try {
    setup(proj);
    await git(proj, ['init']);
    excludeLocalFiles(proj, ['.env', '.env.local']);
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'init']);
    const d = await cli(proj, ['doctor']);
    assert.strictEqual(d.status, 0, 'unknown is not an issue');
    assert.ok(/env keys\s+unknown/.test(d.stdout), 'unknown state shown');
    assert.ok(/no detected metadata issues; some checks are unknown/i.test(d.stdout), 'unknown checks are reported without implying every check passed');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('doctor: non-git project flagged with git init advice', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-doc-nogit-'));
  try {
    setup(proj);
    const d = await cli(proj, ['doctor']);
    assert.strictEqual(d.status, 1);
    assert.ok(/git repo\s+issue/.test(d.stdout));
    assert.ok(d.stdout.includes('git init'));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// Regression (v1.2 review): a project with ONLY .env.local (no .env) used to
// crash doctor with "Cannot read properties of undefined (reading 'keys')".
test('doctor: .env.local-only project must not crash; key drift detected', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-doc-envlocal-'));
  try {
    fs.writeFileSync(path.join(proj, '.env.local'), 'API_KEY=abc\n');
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await git(proj, ['init']);
    excludeLocalFiles(proj, ['.env.local']);
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'init']);

    const d = await cli(proj, ['doctor']);
    assert.strictEqual(d.status, 0, 'healthy differently-shaped env is not an issue');
    assert.ok(!d.stdout.includes('Unexpected crash'), 'must not crash on missing .env');
    assert.ok(/env keys\s+unknown/.test(d.stdout), 'unknown without a reference snapshot');

    const s = await cli(proj, ['snapshot', 'base']);
    assert.strictEqual(s.status, 0, s.stdout);
    fs.appendFileSync(path.join(proj, '.env.local'), 'EXTRA_FLAG=1\n');
    const d2 = await cli(proj, ['doctor']);
    assert.strictEqual(d2.status, 1, 'drift is an issue');
    assert.ok(/env keys\s+issue/.test(d2.stdout), 'drift detected in .env.local');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
