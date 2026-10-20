'use strict';
// v1.2.1 regression tests: the four review fixes.
//   1) restore no longer blocked by its own .gitignore dirt; honest --force hints
//   2) doctor shows node and npm as separate three-state lines
//   3) hook falls back to the recorded absolute install path when project-state
//      is not on PATH (README option C users)
//   4) ignore rules live in .git/info/exclude - stable across reset --hard churn

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CLI = path.join(__dirname, '..', 'bin', 'project-state.js');
const NODE = process.execPath;
const { HAS_SQLITE, envWithSqlite, sql, makeDb, excludeLocalFiles } = require('./helpers');
const Storage = require('../lib/storage');

const GITENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

const { git, cli, setupGit } = require('./helpers');

// Safe restore requires a clean Git state. Tool-owned ignore text is still
// ordinary worktree data and cannot be treated as recoverable by ownership.
test('v121: restore refuses dirty .gitignore even with --force and preserves Git state', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss121-exempt-'));
  try {
    await setupGit(proj);
    // Simulate a pre-v1.2.1 install: .gitignore containing only tool lines.
    fs.writeFileSync(
      path.join(proj, '.gitignore'),
      '# project-state: never commit real secret values\n.project-state/\n',
      'utf8'
    );
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'add gitignore']);
    const s = await cli(proj, ['snapshot', 'base']);
    assert.strictEqual(s.status, 0, s.stderr);
    // Commit a changed source so restore must perform a Git transition.
    fs.writeFileSync(path.join(proj, 'app.js'), 'y();\n');
    await git(proj, ['add', 'app.js']);
    await git(proj, ['commit', '-m', 'drift']);
    const head = (await git(proj, ['rev-parse', 'HEAD'])).trim();
    const index = (await git(proj, ['write-tree'])).trim();
    const appBefore = fs.readFileSync(path.join(proj, 'app.js'));
    for (const dirtyText of ['junk-user-line\n', '# project-state: local-only state\n.project-state/\n']) {
      fs.writeFileSync(path.join(proj, '.gitignore'), dirtyText, 'utf8');
      const ignoredBefore = fs.readFileSync(path.join(proj, '.gitignore'));
      const r = await cli(proj, ['restore', 'base', '--yes', '--force']);
      assert.strictEqual(r.status, 1, `dirty .gitignore blocks even with --force: ${r.stderr}`);
      assert.match(r.stderr, /dirty|clean|preserv/i);
      assert.strictEqual((await git(proj, ['rev-parse', 'HEAD'])).trim(), head, 'HEAD unchanged');
      assert.strictEqual((await git(proj, ['write-tree'])).trim(), index, 'index unchanged');
      assert.deepEqual(fs.readFileSync(path.join(proj, 'app.js')), appBefore, 'source bytes unchanged');
      assert.deepEqual(fs.readFileSync(path.join(proj, '.gitignore')), ignoredBefore, 'dirty ignore bytes unchanged');
      fs.writeFileSync(path.join(proj, '.gitignore'), 'junk-user-line\n', 'utf8');
    }
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('v121: restore records pre-operation missing database state privately before creating target', { skip: !HAS_SQLITE }, async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss121-hint-'));
  try {
    const env = envWithSqlite();
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await setupGit(proj);
    excludeLocalFiles(proj, ['app.db']);
    await makeDb(proj);
    const s = await cli(proj, ['snapshot', 'good', '--with-seed'], env);
    assert.strictEqual(s.status, 0, s.stderr);
    assert.ok(/database\s+collected/.test(s.stdout), 'db layer must be collected for this scenario');
    fs.unlinkSync(path.join(proj, 'app.db'));
    assert.equal(fs.existsSync(path.join(proj, 'app.db')), false, 'target is missing before restore');
    fs.writeFileSync(path.join(proj, 'app.js'), 'y();\n');
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'drift']);
    const r = await cli(proj, ['restore', 'good', '--yes'], env);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(await sql(proj, 'app.db', 'SELECT count(*) FROM items;'), '3', 'target snapshot data restored');
    assert.strictEqual(await sql(proj, 'app.db', 'PRAGMA integrity_check;'), 'ok', 'restored database integrity verified');
    const auto = fs.readdirSync(path.join(proj, '.project-state', 'snapshots')).find((n) => n.startsWith('auto-'));
    assert.ok(auto, 'automatic recovery point exists');
    const checked = await Storage.validateSnapshot(proj, auto, { mode: 'restore' });
    const absence = checked.artifacts.find((a) => a.kind === 'absent' && a.target === 'app.db');
    assert.ok(absence, 'pre-restore absence is recorded for operation-bound compensation');
    assert.equal(absence.privacy, 'private');
    assert.equal(absence.path, null);
    assert.equal(absence.sha256, null);
    assert.equal(absence.size, 0);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ---- fix 2: doctor node / npm split -----------------------------------------

test('v121: doctor shows independent node and npm lines', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss121-doc-'));
  try {
    await setupGit(proj);
    const d = await cli(proj, ['doctor']);
    assert.strictEqual(d.status === 0 || d.status === 1, true, 'doctor runs');
    const out = d.stdout;
    const nodeLine = out.split('\n').find((l) => /^\s+node\s+/.test(l));
    const npmLine = out.split('\n').find((l) => /^\s+npm\s+/.test(l));
    assert.ok(nodeLine, 'dedicated node line');
    assert.ok(npmLine, 'dedicated npm line');
    assert.ok(/v\d+\./.test(nodeLine), 'node line shows process.version');
    assert.ok(!/v\d+\.\d+\.\d+ \//.test(npmLine), 'npm line no longer carries the node version');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ---- fix 3: hook fallback chain ----------------------------------------------

test('v121: hook still snapshots via recorded absolute path when CLI is off PATH', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss121-hk-'));
  try {
    await setupGit(proj);
    const inst = await cli(proj, ['hook', 'install']);
    assert.strictEqual(inst.status, 0, inst.stderr);
    // Recorded paths must be in the managed block.
    const hook = fs.readFileSync(path.join(proj, '.git', 'hooks', 'pre-commit'), 'utf8');
    assert.ok(hook.includes(NODE.replace(/\\/g, '/')), 'node absolute path recorded');
    assert.ok(hook.includes('project-state.js'), 'script absolute path recorded');
    // Strip the global install directory from PATH so `project-state` is
    // unresolvable; the fallback chain must still snapshot.
    const strippedPath = process.env.PATH.split(path.delimiter).filter((p) => !/node_versions|npm/i.test(p)).join(path.delimiter);
    await cli(proj, ['hook', 'uninstall']);
    await cli(proj, ['hook', 'install']);
    fs.writeFileSync(path.join(proj, 'app.js'), 'y();\n');
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'fallback commit'], { ...process.env, ...GITENV, PATH: strippedPath });
    const l = await cli(proj, ['list']);
    assert.ok(/hook-\d{8}-\d{6}/.test(l.stdout), 'hook snapshot created via fallback');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ---- fix 4: exclude stability across reset --hard churn ----------------------

test('v121: exclude entry survives three snapshot/reset cycles; .gitignore untouched', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss121-exc-'));
  try {
    await setupGit(proj);
    await cli(proj, ['snapshot', 's1']);
    const excludeFile = path.join(proj, '.git', 'info', 'exclude');
    assert.ok(fs.readFileSync(excludeFile, 'utf8').includes('.project-state/'), 'exclude entry written');
    const giBefore = fs.existsSync(path.join(proj, '.gitignore'))
      ? fs.readFileSync(path.join(proj, '.gitignore'), 'utf8')
      : null;
    for (let i = 0; i < 3; i++) {
      await cli(proj, ['snapshot', `c${i}`]);
      await git(proj, ['reset', '--hard']);
    }
    assert.ok(fs.readFileSync(excludeFile, 'utf8').includes('.project-state/'), 'exclude stable after 3x reset --hard');
    const occurrences = fs.readFileSync(excludeFile, 'utf8').split('.project-state/').length - 1;
    assert.strictEqual(occurrences, 1, 'idempotent - exactly one entry');
    const giAfter = fs.existsSync(path.join(proj, '.gitignore'))
      ? fs.readFileSync(path.join(proj, '.gitignore'), 'utf8')
      : null;
    assert.strictEqual(giAfter, giBefore, 'user .gitignore byte-identical');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
