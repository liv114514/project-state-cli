'use strict';
// v1.3 security regression tests (5 hardening items).
// 1) command hijack via binaries planted in the project root
// 2) hostile snapshot name / manifest / config.json path traversal
// 3) linked-worktree secrets must never be git-visible
// 4) SQLite database artifacts and sensitive values stay in the private generation
// 5) hook script quoting for paths with single quotes and spaces

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const U = require('../lib/utils');
const H = require('./helpers');

const { git, cli, setupGit, GITENV, HAS_SQLITE, envWithSqlite, makeDb, sql, sqliteBinary, CLI, excludeLocalFiles } = require('./helpers');
const SQLITE_OR_PATH = sqliteBinary();
const Storage = require('../lib/storage');

test('sec1: planted npm.cmd/python.cmd in project root are never executed', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-hijack-'));
  try {
    // Poison: project-root shims that write a marker when executed.
    const poison = '@echo off\necho hijacked > npm-hijacked.marker\n@echo 9.9.9\n';
    const poisonPy = '@echo off\necho hijacked > python-hijacked.marker\n@echo Python 9.9.9\n';
    fs.writeFileSync(path.join(proj, 'npm.cmd'), poison, 'utf8');
    fs.writeFileSync(path.join(proj, 'python.cmd'), poisonPy, 'utf8');
    fs.writeFileSync(path.join(proj, 'npm'), poison, 'utf8');
    await setupGit(proj);
    const d = await cli(proj, ['doctor']);
    assert.ok(d.status === 0 || d.status === 1, `doctor runs (exit ${d.status}): ${d.stderr}`);
    assert.ok(!fs.existsSync(path.join(proj, 'npm-hijacked.marker')), 'planted npm.cmd must never run');
    assert.ok(!fs.existsSync(path.join(proj, 'python-hijacked.marker')), 'planted python.cmd must never run');
    const s = await cli(proj, ['snapshot', 's1']);
    assert.strictEqual(s.status, 0, s.stderr);
    assert.ok(!fs.existsSync(path.join(proj, 'npm-hijacked.marker')), 'still not executed via snapshot');
    assert.ok(!fs.existsSync(path.join(proj, 'python-hijacked.marker')), 'still not executed via snapshot');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('sec1: resolveTrustedBinary skips project-dir entries on PATH', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-res-'));
  try {
    // Fake "git.exe" inside a poisoned PATH entry that IS the project dir.
    fs.writeFileSync(path.join(tmp, 'git.exe'), 'evil', 'utf8');
    const saved = process.env.PATH;
    process.env.PATH = tmp + path.delimiter + saved;
    try {
      const r = U.resolveTrustedBinary('git', tmp);
      assert.ok(r, 'real git found outside the project');
      assert.ok(!r.path.startsWith(tmp), 'resolved binary must live outside the project dir');
      assert.ok(!r.isScript, 'git resolves to a real executable');
    } finally {
      process.env.PATH = saved;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- 2. hostile snapshot names / manifests ----------------------------------

test('sec2: restore/compare reject traversal snapshot names', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-trav-'));
  try {
    await setupGit(proj);
    for (const evil of ['../evil', '..\\evil', 'a/b']) {
      const r = await cli(proj, ['restore', evil]);
      assert.strictEqual(r.status, 1, `restore "${evil}" must be refused`);
      assert.match(r.stderr, /invalid|unsafe|snapshot|name|path/i);
      const c = await cli(proj, ['compare', evil]);
      assert.strictEqual(c.status, 1, `compare "${evil}" must be refused`);
    }
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('sec2: legacy traversal metadata and invalid v2 config are refused before reading outside inputs', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-man-'));
  try {
    await setupGit(proj);
    const snap = path.join(proj, '.project-state', 'snapshots', 'evil');
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(
      path.join(snap, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'evil',
        createdAt: new Date().toISOString(),
        layers: { git: { status: 'collected', file: '..\\..\\..\\stolen-secret.json' } },
      }),
      'utf8'
    );
    const secretTarget = path.join(proj, 'stolen-secret.json');
    fs.writeFileSync(secretTarget, '{"top":"secret"}', 'utf8');
    const listed = await cli(proj, ['list']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stderr + listed.stdout, /legacy|privacy warning/i, 'v1 metadata is diagnostic-only');
    assert.ok(!listed.stdout.includes('secret') && !listed.stderr.includes('secret'), 'hostile outside file content is not read or printed');
    const r = await cli(proj, ['restore', 'evil', '--yes']);
    assert.strictEqual(r.status, 1, 'restore refuses a legacy snapshot before resolving its layer path');
    // A v2 config layer with a traversal key is integrity-correct but violates
    // the layer schema. Reject it before any project write.
    fs.rmSync(path.join(snap, 'manifest.json'), { force: true });
    H.writeSnapshotGeneration(proj, 'evil', {
      layerData: { config: { envFiles: { '../../escaped-env': { keyCount: 1, keys: { A: { nonEmpty: true } } } } } },
    });
    const headBefore = (await git(proj, ['rev-parse', 'HEAD'])).trim();
    const indexBefore = (await git(proj, ['write-tree'])).trim();
    const r2 = await cli(proj, ['restore', 'evil', '--yes']);
    assert.strictEqual(r2.status, 1, `v2 integrity-validated config refuses a hostile env path: ${r2.stderr}`);
    assert.match(r2.stderr, /hostile|unsafe|refus|invalid/i, 'controlled refusal names the unsafe snapshot entry');
    assert.ok(!fs.existsSync(path.join(proj, 'escaped-env')), 'nothing written outside the whitelist');
    assert.ok(fs.existsSync(secretTarget), 'pre-existing root file untouched');
    assert.strictEqual((await git(proj, ['rev-parse', 'HEAD'])).trim(), headBefore, 'HEAD unchanged');
    assert.strictEqual((await git(proj, ['write-tree'])).trim(), indexBefore, 'index unchanged');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ---- 3. linked worktree secrets ----------------------------------------------

test('sec2d: undeclared control-directory marker invalidates the v2 generation before restore', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-control-marker-'));
  try {
    await setupGit(proj);
    const created = await cli(proj, ['snapshot', 'safe']);
    assert.equal(created.status, 0, created.stderr);
    const checked = await Storage.validateSnapshot(proj, 'safe', { mode: 'restore' });
    const gitConfig = path.join(proj, '.git', 'config');
    const configBefore = fs.readFileSync(gitConfig);
    const headBefore = (await git(proj, ['rev-parse', 'HEAD'])).trim();
    const indexBefore = (await git(proj, ['write-tree'])).trim();
    const marker = 'UNDECLARED_CONTROL_DIRECTORY_MARKER';
    const planted = path.join(checked.paths.publicGenerationDir, 'files', '.git', 'config');
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, marker, 'utf8');

    // A generation tree must contain exactly its declared artifact set.
    const restored = await cli(proj, ['restore', 'safe', '--yes']);
    assert.equal(restored.status, 1, restored.stderr);
    assert.match(restored.stderr, /undeclared|unsafe|reserved/i);
    assert.deepEqual(fs.readFileSync(gitConfig), configBefore, 'live .git/config bytes are unchanged');
    assert.equal(fs.readFileSync(gitConfig, 'utf8').includes(marker), false);
    assert.equal((await git(proj, ['rev-parse', 'HEAD'])).trim(), headBefore, 'HEAD is unchanged');
    assert.equal((await git(proj, ['write-tree'])).trim(), indexBefore, 'index tree is unchanged');
    assert.equal(restored.stdout.includes(marker) || restored.stderr.includes(marker), false, 'marker content is not surfaced');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('sec3: linked worktree - secrets written only when exclude is secured', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-wt-'));
  const wt = proj + '-wt';
  try {
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await git(proj, ['init']);
    await git(proj, ['add', 'app.js']);
    await git(proj, ['commit', '-m', 'init']);
    await git(proj, ['worktree', 'add', wt]);
    // Secret is a private local input, created after the worktree commit.
    fs.writeFileSync(path.join(wt, '.env'), 'API_KEY=wt-secret-555\n');
    // Snapshot inside the linked worktree (its .git is a pointer FILE).
    const s = await cli(wt, ['snapshot', 'wtsnap']);
    assert.strictEqual(s.status, 0, s.stderr);
    const checked = await Storage.validateSnapshot(wt, 'wtsnap', { mode: 'restore' });
    const envArtifact = checked.artifacts.find((artifact) => artifact.layer === 'config' && artifact.kind === 'file'
      && artifact.privacy === 'private' && artifact.target === '.env');
    assert.ok(envArtifact, 'linked-worktree snapshot declares its private environment artifact');
    assert.equal(fs.readFileSync(envArtifact.absolutePath, 'utf8'), 'API_KEY=wt-secret-555\n', 'private bytes are stored in the active v2 generation');
    // THE contract: the secrets directory is git-ignored, so .env values can
    // never show up as untracked/committable content.
    const check = await new Promise((resolve) => {
      execFile('git', ['check-ignore', '-q', '.project-state/secrets/'], { cwd: wt }, (e) => resolve(e ? 'visible' : 'ignored'));
    });
    assert.strictEqual(check, 'ignored', '.project-state/secrets must be git-ignored in the worktree');
    const st = await git(wt, ['status', '--porcelain']);
    assert.ok(!/secrets/.test(st), 'secrets never appear in git status');
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ---- 4. private SQLite artifact boundary -------------------------------------

(HAS_SQLITE ? test : test.skip)('sec4: explicit full backup remains private and database SQL is never an apply artifact', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-sql-'));
  try {
    const env = envWithSqlite();
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await setupGit(proj);
    const sqlite = SQLITE_OR_PATH;
    const marker = 'SENSITIVE_DB_ROW_MARKER';
    await new Promise((res, rej) =>
      execFile(sqlite, [path.join(proj, 'app.db'), `CREATE TABLE customers (id INTEGER, phone TEXT, address TEXT, secret TEXT); INSERT INTO customers VALUES (1,'555-0100','221B Baker Street','${marker}');`], { cwd: proj }, (e) => (e ? rej(e) : res()))
    );
    excludeLocalFiles(proj, ['app.db']);
    const s = await cli(proj, ['snapshot', 's1', '--with-seed'], env);
    assert.strictEqual(s.status, 0, s.stderr);
    const checked = await Storage.validateSnapshot(proj, 's1', { mode: 'restore' });
    const full = checked.artifacts.find((a) => a.layer === 'database' && a.kind === 'sqlite-backup' && a.target === 'app.db');
    assert.ok(full, 'explicit consent creates a complete binary backup despite sensitive-looking schema');
    assert.equal(full.privacy, 'private');
    assert.equal(full.restore, 'sqlite-create-missing');
    assert.ok(checked.artifacts.some((a) => a.layer === 'database' && a.kind === 'sqlite-schema' && a.privacy === 'private' && a.restore === 'record-only'));
    assert.ok(checked.artifacts.every((a) => a.layer !== 'database' || a.privacy === 'private'));
    assert.ok(checked.manifest.artifacts.every((a) => a.layer !== 'database'), 'public manifest excludes database metadata and artifacts');
    const backupBytes = fs.readFileSync(full.absolutePath);
    assert.equal(backupBytes.subarray(0, 16).toString('binary'), 'SQLite format 3\0');
    const count = await new Promise((res, rej) =>
      execFile(sqlite, [full.absolutePath, `SELECT count(*) FROM customers WHERE secret='${marker}';`], { encoding: 'utf8' }, (e, so) => (e ? rej(e) : res(so.trim())))
    );
    assert.equal(count, '1', 'private backup contains the opted-in row');
    const publicDir = path.join(proj, '.project-state', 'snapshots', 's1');
    const publicFiles = [];
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(fullPath);
        else publicFiles.push(fullPath);
      }
    };
    visit(publicDir);
    const publicText = publicFiles.map((file) => fs.readFileSync(file)).join('\n');
    assert.equal(publicText.includes(marker), false, 'database row value is absent from public generation files');
    assert.equal(publicText.includes('password_hash'), false, 'sensitive schema text is absent from public generation files');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ---- 5. hook quoting -----------------------------------------------------------

test('sec5: hook script escapes single quotes and spaces in recorded paths', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "pss-sec-hk-'q dir'-"));
  try {
    await setupGit(proj);
    const inst = await cli(proj, ['hook', 'install']);
    assert.strictEqual(inst.status, 0, inst.stderr);
    const hook = fs.readFileSync(path.join(proj, '.git', 'hooks', 'pre-commit'), 'utf8');
    // Absolute fallback paths are emitted as POSIX single-quoted shell words.
    const nodePath = process.execPath.replace(/\\/g, '/');
    const cliPath = CLI.replace(/\\/g, '/');
    assert.ok(hook.includes(`'${nodePath}'`), 'node fallback path is a single-quoted shell word');
    assert.ok(hook.includes(`'${cliPath}'`), 'script fallback path, including spaces, is a single-quoted shell word');
    // Executing the fallback branch via sh must parse (no syntax errors):
    // syntax-check with a RESOLVED sh (Git for Windows bundles one); if no sh
    // exists at all we cannot assume a bare "sh" on PATH - skip honestly.
    const shBin = U.resolveTrustedBinary('sh', proj);
    if (shBin) {
      await new Promise((resolve, reject) => {
        execFile(shBin.path, ['-n', path.join(proj, '.git', 'hooks', 'pre-commit')], (e, so, se) => (e ? reject(new Error(se)) : resolve()));
      });
    }
    // And a real commit through the fallback (CLI off PATH) still snapshots.
    const stripped = process.env.PATH.split(path.delimiter).filter((p) => !/node_versions|npm/i.test(p)).join(path.delimiter);
    fs.writeFileSync(path.join(proj, 'app.js'), 'y();\n');
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'quoted-path commit'], { ...process.env, ...GITENV, PATH: stripped });
    const l = await cli(proj, ['list']);
    assert.ok(/hook-\d{8}-\d{6}/.test(l.stdout), 'snapshot created despite hostile path chars');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ---- manifest deep validation (hardening acceptance #3) ----------------------

function writeManifest(proj, name, manifest) {
  const generation = require('crypto').randomBytes(16).toString('hex');
  const common = {
    schemaVersion: 2, state: 'complete', generation, kind: 'named', name,
    createdAt: new Date().toISOString(), toolVersion: require('../package.json').version,
    host: { platform: process.platform, arch: process.arch, node: process.version },
    layers: {}, artifacts: [],
    ...manifest,
  };
  const snap = path.join(proj, '.project-state', 'snapshots', name);
  const publicGeneration = path.join(snap, 'generations', generation);
  const privateGeneration = path.join(proj, '.project-state', 'secrets', name, 'generations', generation);
  fs.mkdirSync(publicGeneration, { recursive: true });
  fs.mkdirSync(privateGeneration, { recursive: true });
  const publicBytes = Buffer.from(JSON.stringify(common));
  fs.writeFileSync(path.join(publicGeneration, 'manifest.json'), publicBytes);
  fs.writeFileSync(path.join(privateGeneration, 'manifest.json'), JSON.stringify(common));
  fs.writeFileSync(path.join(snap, 'current.json'), JSON.stringify({
    schemaVersion: 1, name, generation, publicManifestSha256: U.sha256(publicBytes),
  }));
  return snap;
}

test('sec2b: manifest deep validation - name mismatch, null layers, unknown ids, bad status all refused', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-man2-'));
  try {
    await setupGit(proj);
    const cases = [
      ['name-mismatch', { name: 'other', createdAt: 'x', layers: {} }],
      ['null-layers', { name: 'null-layers', createdAt: 'x', layers: null }],
      ['array-layers', { name: 'array-layers', createdAt: 'x', layers: [] }],
      ['unknown-layer', { name: 'unknown-layer', createdAt: 'x', layers: { evil: { status: 'collected', file: 'evil.json' } } }],
      ['bad-status', { name: 'bad-status', createdAt: 'x', layers: { git: { status: 'EXEC', file: 'git.json' } } }],
      ['wrong-file', { name: 'wrong-file', createdAt: 'x', layers: { git: { status: 'collected', file: 'other.json' } } }],
      ['null-layer-meta', { name: 'null-layer-meta', createdAt: 'x', layers: { git: null } }],
    ];
    for (const [dirName, manifest] of cases) {
      writeManifest(proj, dirName, manifest);
      const r = await cli(proj, ['restore', dirName, '--yes']);
      assert.strictEqual(r.status, 1, `restore of "${dirName}" must be refused`);
      assert.match(r.stderr, /refus/i, `controlled refusal for "${dirName}"`);
      const c = await cli(proj, ['compare', dirName]);
      assert.strictEqual(c.status, 1, `compare of "${dirName}" must be controlled-not-crash`);
    }
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('sec2c: copied snapshot generation cannot be rebound to another snapshot name', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-xsnap-'));
  try {
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await setupGit(proj);
    fs.writeFileSync(path.join(proj, '.env'), 'API_TOKEN=CROSS_GENERATION_SECRET\n');
    excludeLocalFiles(proj, ['.env']);
    const s = await cli(proj, ['snapshot', 'good']);
    assert.strictEqual(s.status, 0, s.stderr);
    const good = await Storage.validateSnapshot(proj, 'good', { mode: 'restore' });
    assert.ok(good.artifacts.some((a) => a.layer === 'config' && a.privacy === 'private'), 'fixture contains a private artifact');
    const state = path.join(proj, '.project-state');
    fs.cpSync(path.join(state, 'snapshots', 'good'), path.join(state, 'snapshots', 'evil'), { recursive: true });
    fs.cpSync(path.join(state, 'secrets', 'good'), path.join(state, 'secrets', 'evil'), { recursive: true });
    await assert.rejects(() => Storage.validateSnapshot(proj, 'evil', { mode: 'restore' }), /name|identity|generation/i);
    const r = await cli(proj, ['restore', 'evil', '--yes']);
    assert.strictEqual(r.status, 1, 'copied generation bound to another name refuses');
    assert.match(r.stderr, /name|identity|generation|snapshot/i);
    assert.equal(fs.readFileSync(path.join(proj, '.env'), 'utf8'), 'API_TOKEN=CROSS_GENERATION_SECRET\n');
    assert.doesNotMatch(r.stdout + r.stderr, /CROSS_GENERATION_SECRET/, 'refusal does not disclose private content');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// Schema v1 snapshots could execute database SQL from the public tree without
// integrity/privacy metadata. The current contract rejects that legacy format
// before SQL execution; keeping this regression ensures no compatibility path
// silently reopens the old public-SQL trust boundary.

test('sec4b: legacy public SQL snapshot is diagnostic-only and never creates or changes a database', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-legacy-'));
  try {
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await setupGit(proj);
    const marker = 'LEGACY_SQL_MUST_REMAIN_INERT';
    const rootDb = path.join(proj, 'app.db');
    fs.writeFileSync(rootDb, 'LIVE_DATABASE_BYTES_UNCHANGED', 'utf8');
    const dbBefore = fs.readFileSync(rootDb);
    // Hand-build the old public v1 SQL layout. It is diagnostic-only; the
    // content below is inert data and must never be passed to sqlite3.
    const snap = path.join(proj, '.project-state', 'snapshots', 'legacy');
    fs.mkdirSync(path.join(snap, 'files', 'db'), { recursive: true });
    fs.writeFileSync(
      path.join(snap, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'legacy',
        createdAt: new Date().toISOString(),
        layers: { database: { status: 'collected', file: 'database.json' } },
      }),
      'utf8'
    );
    fs.writeFileSync(path.join(snap, 'database.json'), JSON.stringify({ databases: [{ file: 'app.db', mode: 'dump' }] }), 'utf8');
    fs.writeFileSync(path.join(snap, 'files', 'db', 'app.db.dump.sql'), `CREATE TABLE ${marker}(id);`, 'utf8');
    const originalHead = (await git(proj, ['rev-parse', 'HEAD'])).trim();
    const r = await cli(proj, ['restore', 'legacy', '--yes', '--force']);
    assert.strictEqual(r.status, 1, `legacy schema must be refused: ${r.stderr}`);
    assert.match(r.stderr, /legacy|schemaVersion 1|unsupported snapshot/i);
    assert.deepEqual(fs.readFileSync(rootDb), dbBefore, 'existing database bytes are unchanged');
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(marker), 'SQL text is not surfaced in CLI output');
    assert.equal((await git(proj, ['rev-parse', 'HEAD'])).trim(), originalHead, 'refusal leaves HEAD untouched');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ---- trusted ComSpec (hardening acceptance #5) --------------------------------

test('sec5b: ComSpec pointing INSIDE the project is rejected for script shims', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-cs-'));
  try {
    fs.writeFileSync(path.join(proj, 'npm.cmd'), '@echo off\necho hijacked > cs-hijacked.marker\n@echo 9.9.9\n', 'utf8');
    // ComSpec = a fake cmd.exe inside the project -> must never be used.
    const evilCmd = path.join(proj, 'evil-cmd.exe');
    fs.writeFileSync(evilCmd, 'evil', 'utf8');
    const env = { ...process.env, ComSpec: evilCmd };
    const d = await cli(proj, ['doctor'], env);
    assert.ok(d.status === 0 || d.status === 1, 'doctor runs');
    assert.ok(!fs.existsSync(path.join(proj, 'cs-hijacked.marker')), 'in-project ComSpec must never execute');
    // npm must degrade to unknown/skipped, not crash.
    assert.ok(/npm\s+(unknown|ok)/.test(d.stdout), 'npm degrades to unknown or uses a trusted path');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ---- version consistency (hardening acceptance #6) -----------------------------

test('sec6: TOOL_VERSION matches package.json version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(U.TOOL_VERSION, pkg.version);
});

// ---- symlink / reparse boundary (hardening round 2, acceptance #1) ------------

const linkCapable = (() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-linkcap-'));
  let ok = false;
  try {
    fs.mkdirSync(path.join(tmp, 'd'));
    fs.symlinkSync('d', path.join(tmp, 'l'), 'dir');
    ok = fs.lstatSync(path.join(tmp, 'l')).isSymbolicLink();
  } catch { ok = false; }
  fs.rmSync(tmp, { recursive: true, force: true });
  return ok;
})();

test('sec7a: symlink under snapshot files invalidates the generation before restore', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-sym-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-out-'));
  try {
    await setupGit(proj);
    const s = await cli(proj, ['snapshot', 'good']);
    assert.strictEqual(s.status, 0, s.stderr);
    const checked = await Storage.validateSnapshot(proj, 'good', { mode: 'restore' });
    // Plant a symlinked directory in the active public generation.
    const outsideFile = path.join(outside, 'stolen.txt');
    fs.writeFileSync(outsideFile, 'TOP SECRET OUTSIDE', 'utf8');
    const filesDb = path.join(checked.paths.publicGenerationDir, 'files');
    fs.symlinkSync(outside, path.join(filesDb, 'leaky'), 'junction');
    fs.writeFileSync(path.join(proj, 'app.js'), 'y();\n');
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'drift']);
    const r = await cli(proj, ['restore', 'good', '--yes']);
    assert.strictEqual(r.status, 1, 'restore refuses a linked artifact tree');
    assert.match(r.stderr, /link|reparse|unsafe/i);
    assert.ok(!r.stdout.includes('TOP SECRET OUTSIDE'), 'outside content never read into the plan');
    assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), 'TOP SECRET OUTSIDE', 'outside file untouched');
    assert.ok(!fs.existsSync(path.join(proj, 'leaky', 'stolen.txt')), 'undeclared link target is not copied into the project');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('sec7b: storage path validation refuses linked parents and link targets', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-tsym-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-tout-'));
  try {
    await setupGit(proj);
    const outsideFile = path.join(outside, 'victim.json');
    fs.writeFileSync(outsideFile, '{"victim": true}', 'utf8');
    // A junction inside the project pointing OUTSIDE, with the restore target
    // behind it. assertNoSymlinkPath must refuse this write path.
    fs.mkdirSync(path.join(proj, 'sub'));
    fs.symlinkSync(outside, path.join(proj, 'sub', 'leak'), 'junction');
    const target = path.join(proj, 'sub', 'leak', 'victim.json');
    await assert.rejects(() => Storage.assertNoLinks(target, { allowMissing: false }),
      /symlink|reparse/i, 'path walk refuses a junction ancestor before access');
    assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), '{"victim": true}', 'link target NEVER overwritten');
    // Same refusal when the TARGET ITSELF is a link (junction form - the only
    // real link type this sandbox produces; file/dir symlinks are silently
    // degraded to plain files here. Production checks the identical
    // lstat.isSymbolicLink() branch for all link kinds).
    fs.symlinkSync(outside, path.join(proj, 'link-as-target'), 'junction');
    await assert.rejects(() => Storage.assertNoLinks(path.join(proj, 'link-as-target'), { allowMissing: false }),
      /symlink|reparse/i, 'path walk refuses the link itself');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('C02 a hard-linked Git exclude is refused without changing external bytes or publishing secrets', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-c02-exclude-'));
  const outside = path.join(os.tmpdir(), `pss-c02-exclude-${process.pid}-${Date.now()}.txt`);
  const original = Buffer.from('external owner data\n');
  try {
    await setupGit(proj);
    const exclude = path.join(proj, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(outside, original);
    fs.unlinkSync(exclude);
    fs.linkSync(outside, exclude);
    await assert.rejects(() => U.ensureLocalExclude(proj, '.project-state/'), /single-link|identity|link/i);
    assert.deepStrictEqual(fs.readFileSync(outside), original, 'the linked external file was not rewritten or appended');
    fs.writeFileSync(path.join(proj, '.env'), 'FAKE_CREDENTIAL=must-not-publish\n');
    const result = await cli(proj, ['snapshot', 'c02-private-boundary']);
    assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /must-not-publish/);
    assert.deepStrictEqual(fs.readFileSync(outside), original);
    const validated = await Storage.validateSnapshot(proj, 'c02-private-boundary', { mode: 'restore' });
    assert.equal(validated.manifest.layers.config.status, 'skipped', 'the public record states that private config capture was skipped');
    assert.equal(validated.artifacts.some((artifact) => artifact.privacy === 'private' && artifact.target === '.env'), false,
      'the secret is not published to either artifact tree when exclusion cannot be verified');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('C09 run honors caller maxBuffer bounds for trusted child output', async () => {
  const script = "process.stdout.write('x'.repeat(4096))";
  const bounded = await U.run(process.execPath, ['-e', script], { cwd: process.cwd(), timeout: 10000, maxBuffer: 1024 });
  assert.equal(bounded.ok, false);
  assert.equal(bounded.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  const sufficient = await U.run(process.execPath, ['-e', script], { cwd: process.cwd(), timeout: 10000, maxBuffer: 8192 });
  assert.equal(sufficient.ok, true, sufficient.stderr || sufficient.message);
  assert.equal(sufficient.stdout.length, 4096);
});

(linkCapable ? test : test.skip)('sec7c: symlinked FILE inside snapshot files/ -> restore refused', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-symf-'));
  try {
    await setupGit(proj);
    const s = await cli(proj, ['snapshot', 'good']);
    assert.strictEqual(s.status, 0, s.stderr);
    const checked = await Storage.validateSnapshot(proj, 'good', { mode: 'restore' });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-symf-out-'));
    const outsideFile = path.join(outside, 'secret.js');
    fs.writeFileSync(outsideFile, 'LEAK-ME', 'utf8');
    const filesDb = path.join(checked.paths.publicGenerationDir, 'files');
    fs.symlinkSync(outsideFile, path.join(filesDb, 'leak.js'), 'file');
    assert.ok(fs.lstatSync(path.join(filesDb, 'leak.js')).isSymbolicLink(), 'prerequisite: real file symlink exists');
    fs.writeFileSync(path.join(proj, 'app.js'), 'y();\n');
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'drift']);
    const r = await cli(proj, ['restore', 'good', '--yes']);
    assert.strictEqual(r.status, 1, 'restore refused');
    assert.ok(r.stderr.includes('symlink/reparse'), 'refusal names the link boundary');
    assert.ok(!r.stdout.includes('LEAK-ME'), 'outside content never read');
    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

// ---- CMD metacharacter refusal, per-character (hardening round 2, #2) ---------

(process.platform === 'win32' ? test : test.skip)('sec1b: runTrusted refuses .cmd shims per CMD metacharacter, no process started', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-sec-cmd-'));
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pss sec cmd shim '));
  try {
    fs.writeFileSync(path.join(proj, 'npm.cmd'), '@echo off\necho hijacked > cmd-hijacked.marker\n@echo 9.9.9\n', 'utf8');
    fs.writeFileSync(path.join(shimDir, 'npm.cmd'), '@echo off\necho external-shim > external-shim.marker\n@echo 9.9.9\n', 'utf8');
    await setupGit(proj);
    const previousPath = process.env.PATH;
    process.env.PATH = shimDir + path.delimiter + previousPath;
    try {
    const chars = ['%', '!', '^', '&', '|', '<', '>', '(', ')', '"', "'"];
    for (const ch of chars) {
      const r = await U.runTrusted('npm', ['--version', `arg${ch}tail`], { cwd: proj });
      assert.strictEqual(r.ok, false, `metacharacter "${ch}" must refuse`);
      assert.ok(r.message.includes('CMD metacharacters'), `diagnosable reason for "${ch}": ${r.message}`);
      assert.ok(!fs.existsSync(path.join(proj, 'cmd-hijacked.marker')), `no external process for "${ch}"`);
    }
    // Clean args reach only the external fixture; project-root poison remains blocked.
    const ok = await U.runTrusted('npm', ['--version'], { cwd: proj });
    assert.strictEqual(ok.ok, true, `clean args still work: ${ok.message || ''}`);
    assert.ok(fs.existsSync(path.join(proj, 'external-shim.marker')), 'clean invocation reached the external fixture');
    assert.ok(!fs.existsSync(path.join(proj, 'cmd-hijacked.marker')), 'project-root shim was never started');
    } finally {
      process.env.PATH = previousPath;
    }
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});
