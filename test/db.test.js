'use strict';
// Tests for SQLite online-backup collection and create-missing restore.
// Uses an explicitly installed sqlite3 CLI on PATH. No executable is bundled.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');
const { git, cli, runPrintedRollback, sql, makeDb, excludeLocalFiles, envWithSqlite, SQLITE, HAS_SQLITE, REQUIRE_SQLITE_TESTS } = require('./helpers');
const U = require('../lib/utils');
const Storage = require('../lib/storage');
const RestoreDb = require('../lib/restore-database');

(HAS_SQLITE ? test : test.skip)('db compare binds live schema digest and detects same-row-count schema drift', async (t) => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-db-schema-compare-'));
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  await makeDb(proj);
  const saved = await cli(proj, ['snapshot', 'schema-before'], envWithSqlite());
  assert.equal(saved.status, 0, `${saved.stdout}\n${saved.stderr}`);
  const same = await cli(proj, ['compare', 'schema-before'], envWithSqlite());
  assert.equal(same.status, 0, `${same.stdout}\n${same.stderr}`);
  assert.match(same.stdout, /schema matches/);
  await sql(proj, 'app.db', 'ALTER TABLE items ADD COLUMN note TEXT;');
  const changed = await cli(proj, ['compare', 'schema-before'], envWithSqlite());
  assert.equal(changed.status, 0, `${changed.stdout}\n${changed.stderr}`);
  assert.match(changed.stdout, /schema changed/);
  assert.match(changed.stdout, /row contents 未比较/);
  assert.doesNotMatch(changed.stdout, /CREATE TABLE|schemaFingerprint|[a-f0-9]{64}/i);
  assert.equal(await sql(proj, 'app.db', 'SELECT count(*) FROM items;'), '3', 'row count is unchanged while schema differs');
});

(HAS_SQLITE ? test : test.skip)('db inspection batches row counts and safely quotes unusual table names', async (t) => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-db-inspection-'));
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  const statements = [];
  for (let index = 0; index < 10; index += 1) {
    const name = index === 0 ? 'odd " name' : index === 1 ? "odd ' literal" : `table_${index}`;
    const quoted = `"${name.replace(/"/g, '""')}"`;
    statements.push(`CREATE TABLE ${quoted} (value TEXT); INSERT INTO ${quoted} VALUES ('x');`);
  }
  await sql(proj, 'app.db', statements.join('\n'));
  const U = require('../lib/utils');
  const DB = require('../lib/database');
  const originalRun = U.run;
  let childProcesses = 0;
  U.run = (...args) => { childProcesses += 1; return originalRun(...args); };
  try {
    const inspected = await DB.inspectBackup(proj, path.join(proj, 'app.db'));
    assert.equal(inspected.tables.length, 10);
    assert.equal(inspected.totalRows, 10);
    assert.ok(inspected.tables.includes('odd " name'));
    assert.ok(inspected.tables.includes("odd ' literal"));
    assert.equal(childProcesses, 3, 'integrity, schema, and one batched row-count process');
  } finally { U.run = originalRun; }
});

test('required sqlite3 CLI is available when REQUIRE_SQLITE_TESTS=1', { skip: !REQUIRE_SQLITE_TESTS }, () => {
    assert.ok(HAS_SQLITE, 'REQUIRE_SQLITE_TESTS=1 but no sqlite3 CLI was found on PATH');
});

function rowCount(proj, db) {
  return sql(proj, db, 'SELECT count(*) FROM items;');
}

async function restorableProject(prefix) {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await git(proj, ['init']);
    excludeLocalFiles(proj, ['app.db', 'app.db-wal', 'app.db-shm', 'app.db-journal']);
    await makeDb(proj);
    await git(proj, ['add', 'app.js']);
    await git(proj, ['commit', '-m', 'init']);
    const saved = await cli(proj, ['snapshot', 'good', '--with-seed'], envWithSqlite());
    assert.equal(saved.status, 0, `${saved.stdout}\n${saved.stderr}`);
    return proj;
  } catch (error) {
    fs.rmSync(proj, { recursive: true, force: true });
    throw error;
  }
}

function waitForOutput(child, read, marker, stderr) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sqlite process did not print ${marker}: ${read()}\n${stderr()}`)), 10000);
    const check = () => {
      if (read().includes(marker)) { clearTimeout(timer); resolve(); }
      else if (child.exitCode !== null) { clearTimeout(timer); reject(new Error(`sqlite process exited early: ${read()}\n${stderr()}`)); }
    };
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', check);
    check();
  });
}

test('db: without sqlite3 on PATH the layer skips cleanly, other layers unaffected', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-db-skip-'));
  try {
    fs.writeFileSync(path.join(proj, 'app.db'), 'not really sqlite but presence matters');
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await git(proj, ['init']);
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'init']);
    // Build a PATH that has git but NOT sqlite3 (CI runners provision sqlite3
    // into the system PATH, so stripping node dirs alone cannot create the
    // skip scenario there).
    const trusted = U.resolveTrustedBinary('git', proj);
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-gitonly-'));
    if (process.platform === 'win32') {
      // Windows: a junction to the git install dir (Git for Windows ships no sqlite3).
      fs.symlinkSync(path.dirname(trusted.path), path.join(binDir, 'gitdir'), 'junction');
      var gitOnlyPath = path.join(binDir, 'gitdir');
    } else {
      // POSIX: a real file symlink to the git binary.
      fs.symlinkSync(trusted.path, path.join(binDir, 'git'), 'file');
      var gitOnlyPath = binDir;
    }
    const r = await cli(proj, ['snapshot', 's1'], { ...process.env, PATH: gitOnlyPath });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(/database\s+skipped\s+sqlite3 CLI not found/.test(r.stdout), 'skip reason is specific');
    assert.ok(/git\s+collected/.test(r.stdout), 'other layers unaffected');
    const checked = await Storage.validateSnapshot(proj, 's1', { mode: 'diagnostic' });
    assert.equal(checked.manifest.layers.database.status, 'skipped');
    assert.equal(checked.artifacts.some((artifact) => artifact.layer === 'database'), false, 'invalid source file produces no database artifacts');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

(HAS_SQLITE ? test : test.skip)('db: schema-only snapshot by default (seed withheld, database artifacts private)', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-db-schema-'));
  try {
    await makeDb(proj);
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await git(proj, ['init']);
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'init']);
    const r = await cli(proj, ['snapshot', 's1'], envWithSqlite());
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(/app\.db \(schema/.test(r.stdout), 'database layer collected, schema mode');
    const checked = await Storage.validateSnapshot(proj, 's1', { mode: 'restore' });
    const schema = checked.artifacts.find((a) => a.layer === 'database' && a.kind === 'sqlite-schema');
    assert.ok(schema, 'schema artifact present');
    assert.equal(schema.privacy, 'private');
    assert.equal(schema.restore, 'record-only', 'schema text is diagnostic metadata, never an apply step');
    assert.ok(!checked.artifacts.some((a) => a.kind === 'sqlite-backup'), 'no full-data artifact without --with-seed');
    assert.ok(checked.manifest.artifacts.every((a) => a.layer !== 'database'), 'public manifest contains no database artifacts');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

(HAS_SQLITE ? test : test.skip)('db: online backup includes committed WAL data while a writer connection stays open', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-db-live-wal-'));
  let writer;
  try {
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await git(proj, ['init']);
    excludeLocalFiles(proj, ['app.db']);
    await git(proj, ['add', 'app.js']);
    await git(proj, ['commit', '-m', 'init']);

    writer = spawn(SQLITE, [path.join(proj, 'app.db')], { cwd: proj, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    writer.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    writer.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sqlite writer did not confirm committed WAL marker: ${stdout}\n${stderr}`)), 10000);
      writer.once('error', (error) => { clearTimeout(timer); reject(error); });
      const check = () => {
        if (stdout.includes('committed-wal-marker')) { clearTimeout(timer); resolve(); }
        else if (writer.exitCode !== null) { clearTimeout(timer); reject(new Error(`sqlite writer exited early: ${stdout}\n${stderr}`)); }
        else setTimeout(check, 20);
      };
      writer.stdin.write([
        '.bail on',
        'PRAGMA journal_mode=WAL;',
        'PRAGMA wal_autocheckpoint=0;',
        'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);',
        "INSERT INTO items(name) VALUES ('committed-wal-marker');",
        "SELECT name FROM items WHERE name='committed-wal-marker';",
        '',
      ].join('\n'));
      check();
    });

    const wal = `${path.join(proj, 'app.db')}-wal`;
    assert.ok(fs.existsSync(wal), 'writer connection keeps the WAL sidecar present');
    assert.ok(fs.statSync(wal).size > 0, 'committed transaction has WAL bytes');
    assert.equal(await sql(proj, 'app.db', "SELECT name FROM items WHERE name='committed-wal-marker';"), 'committed-wal-marker', 'separate live reader observes the committed WAL row');

    const snap = await cli(proj, ['snapshot', 'live-wal', '--with-seed'], envWithSqlite());
    assert.equal(snap.status, 0, `${snap.stdout}\n${snap.stderr}`);
    const checked = await Storage.validateSnapshot(proj, 'live-wal', { mode: 'restore' });
    const backup = checked.artifacts.find((a) => a.layer === 'database' && a.kind === 'sqlite-backup' && a.target === 'app.db');
    assert.ok(backup, 'online backup artifact is present');
    const backupPath = path.relative(proj, backup.absolutePath);
    assert.equal(await sql(proj, backupPath, "SELECT name FROM items WHERE name='committed-wal-marker';"), 'committed-wal-marker', 'online backup contains the committed WAL row');
    assert.equal(await sql(proj, backupPath, 'PRAGMA integrity_check;'), 'ok', 'online backup is structurally valid');

    writer.stdin.write('.quit\n');
    writer.stdin.end();
    await new Promise((resolve) => writer.once('close', resolve));
    writer = null;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const source = `${path.join(proj, 'app.db')}${suffix}`;
      if (fs.existsSync(source)) fs.unlinkSync(source);
    }
    assert.equal(fs.existsSync(path.join(proj, 'app.db')), false, 'restore target is missing');
    const restored = await cli(proj, ['restore', 'live-wal', '--yes'], envWithSqlite());
    assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
    assert.equal(await sql(proj, 'app.db', "SELECT name FROM items WHERE name='committed-wal-marker';"), 'committed-wal-marker', 'restoring the online backup preserves the committed WAL row');
    assert.equal(await sql(proj, 'app.db', 'PRAGMA integrity_check;'), 'ok', 'restored online backup passes integrity_check');
    assert.equal(await sql(proj, 'app.db', "SELECT sql FROM sqlite_schema WHERE type='table' AND name='items';"), 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)', 'restored online backup preserves schema');
  } finally {
    if (writer && writer.exitCode === null) {
      writer.stdin.write('.quit\n');
      writer.stdin.end();
      await new Promise((resolve) => writer.once('close', resolve));
    }
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

(HAS_SQLITE ? test : test.skip)('db: --with-seed stores a private consistent SQLite binary; SQL stays record-only', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-db-seed-'));
  try {
    await makeDb(proj);
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await git(proj, ['init']);
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'init']);
    const r = await cli(proj, ['snapshot', 's1', '--with-seed'], envWithSqlite());
    assert.strictEqual(r.status, 0, r.stderr);
    const checked = await Storage.validateSnapshot(proj, 's1', { mode: 'restore' });
    const full = checked.artifacts.find((a) => a.layer === 'database' && a.kind === 'sqlite-backup');
    assert.ok(full, 'full consistent database artifact exists');
    assert.equal(full.privacy, 'private');
    assert.equal(full.restore, 'sqlite-create-missing');
    assert.ok(checked.manifest.artifacts.every((a) => a.layer !== 'database'), 'public manifest contains no database metadata or bytes');
    const bytes = fs.readFileSync(full.absolutePath);
    assert.equal(bytes.subarray(0, 16).toString('binary'), 'SQLite format 3\0', 'backup is a SQLite binary, not SQL text');
    const backupPath = path.relative(proj, full.absolutePath);
    assert.equal(await sql(proj, backupPath, 'PRAGMA integrity_check;'), 'ok', 'private backup is a valid SQLite database');
    assert.equal(await sql(proj, backupPath, 'SELECT count(*) FROM items;'), '3', 'backup contains the captured rows');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

(HAS_SQLITE ? test : test.skip)('db: restores complete binary backup only to a missing target and verifies contents', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-db-restore-'));
  try {
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await git(proj, ['init']);
    excludeLocalFiles(proj, ['app.db']);
    await makeDb(proj); // 3 rows; ignored local input, absent from Git history
    await git(proj, ['add', 'app.js']);
    await git(proj, ['commit', '-m', 'init']);
    const s = await cli(proj, ['snapshot', 'good', '--with-seed'], envWithSqlite());
    assert.strictEqual(s.status, 0, s.stderr);

    fs.unlinkSync(path.join(proj, 'app.db'));
    assert.equal(fs.existsSync(path.join(proj, 'app.db')), false, 'target is missing before restore');
    fs.writeFileSync(path.join(proj, 'app.js'), 'drift();\n');
    await git(proj, ['add', 'app.js']);
    await git(proj, ['commit', '-m', 'oops']);
    const driftHead = (await git(proj, ['rev-parse', 'HEAD'])).trim();

    const r = await cli(proj, ['restore', 'good', '--yes'], envWithSqlite());
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(await rowCount(proj, 'app.db'), '3', 'all rows restored from the binary backup');
    assert.equal(await sql(proj, 'app.db', "SELECT sql FROM sqlite_schema WHERE type='table' AND name='items';"), 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)', 'schema matches the captured database');
    assert.equal(await sql(proj, 'app.db', 'PRAGMA integrity_check;'), 'ok', 'restored database passes integrity_check');

    const rollback = runPrintedRollback(r.stdout, proj, envWithSqlite());
    assert.equal(rollback.status, 0, `${rollback.stdout}\n${rollback.stderr}\n${rollback.error?.message || ''}`);
    assert.equal(fs.existsSync(path.join(proj, 'app.db')), false, 'exact printed rollback restores the originally missing database to missing');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      assert.equal(fs.existsSync(path.join(proj, `app.db${suffix}`)), false, `rollback leaves no ${suffix} sidecar`);
    }
    assert.equal((await git(proj, ['rev-parse', 'HEAD'])).trim(), driftHead, 'database rollback returns Git to the pre-restore HEAD');
    assert.equal(fs.readFileSync(path.join(proj, 'app.js'), 'utf8').replace(/\r\n/g, '\n'), 'drift();\n', 'database rollback restores the pre-restore file bytes');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

(HAS_SQLITE ? test : test.skip)('db: explicit seed opt-in keeps sensitive database bytes private', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-db-sens-'));
  try {
    await sql(proj, 'users.db', "CREATE TABLE users (id INTEGER, password_hash TEXT); INSERT INTO users VALUES (1,'x'),(2,'y');");
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await git(proj, ['init']);
    await git(proj, ['add', '-A']);
    await git(proj, ['commit', '-m', 'init']);
    const r = await cli(proj, ['snapshot', 's1', '--with-seed'], envWithSqlite());
    assert.strictEqual(r.status, 0, r.stderr);
    const checked = await Storage.validateSnapshot(proj, 's1', { mode: 'restore' });
    const full = checked.artifacts.find((a) => a.layer === 'database' && a.kind === 'sqlite-backup' && a.target === 'users.db');
    assert.ok(full, 'explicit --with-seed captures a complete consistent backup');
    assert.equal(full.privacy, 'private');
    assert.equal(full.restore, 'sqlite-create-missing');
    assert.ok(checked.manifest.artifacts.every((a) => a.layer !== 'database'), 'sensitive schema and row metadata remain out of public manifest');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('db: no sqlite files -> same skipped behavior as v1.1 (contract intact)', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-db-none-'));
  try {
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    const env = { ...envWithSqlite(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const r = await cli(proj, ['snapshot', 's1'], env);
    assert.strictEqual(r.status, 0);
    assert.ok(/database\s+skipped/.test(r.stdout), 'still skipped without sqlite files');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

(HAS_SQLITE ? test : test.skip)('db: restore refuses an existing database without changing it', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-db-rollback-'));
  try {
    fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n');
    await git(proj, ['init']);
    excludeLocalFiles(proj, ['app.db']);
    await makeDb(proj);
    await git(proj, ['add', 'app.js']);
    await git(proj, ['commit', '-m', 'init']);
    const s = await cli(proj, ['snapshot', 'good', '--with-seed'], envWithSqlite());
    assert.strictEqual(s.status, 0, s.stderr);

    await sql(proj, 'app.db', "UPDATE items SET name='DAMAGED';");
    const beforeBytes = fs.readFileSync(path.join(proj, 'app.db'));
    const beforeHead = (await git(proj, ['rev-parse', 'HEAD'])).trim();
    fs.writeFileSync(path.join(proj, 'app.js'), 'drift();\n');
    await git(proj, ['add', 'app.js']);
    await git(proj, ['commit', '-m', 'oops']);
    const driftHead = (await git(proj, ['rev-parse', 'HEAD'])).trim();

    const r = await cli(proj, ['restore', 'good', '--yes'], envWithSqlite());
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /existing database|target must be missing|refus/i);
    assert.deepEqual(fs.readFileSync(path.join(proj, 'app.db')), beforeBytes, 'existing DB bytes are untouched');
    assert.equal((await git(proj, ['rev-parse', 'HEAD'])).trim(), driftHead, 'Git state is unchanged by preflight refusal');
    assert.notEqual(driftHead, beforeHead, 'fixture contains a real Git transition target');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

(HAS_SQLITE ? test : test.skip)('db: restore refuses an existing database while a real WAL writer transaction is open', async () => {
  const proj = await restorableProject('pss-db-live-lock-');
  let writer;
  try {
    const target = path.join(proj, 'app.db');
    writer = spawn(SQLITE, [target], { cwd: proj, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    writer.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    writer.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    writer.stdin.write([
      '.bail on',
      'PRAGMA journal_mode=WAL;',
      'PRAGMA wal_autocheckpoint=0;',
      "INSERT INTO items(name) VALUES ('live-committed-marker');",
      "SELECT name FROM items WHERE name='live-committed-marker';",
      '',
    ].join('\n'));
    await waitForOutput(writer, () => stdout, 'live-committed-marker', () => stderr);
    writer.stdin.write([
      'BEGIN IMMEDIATE;',
      "UPDATE items SET name='live-uncommitted-marker' WHERE id=1;",
      'SELECT name FROM items WHERE id=1;',
      '',
    ].join('\n'));
    await waitForOutput(writer, () => stdout, 'live-uncommitted-marker', () => stderr);
    const wal = `${target}-wal`;
    const shm = `${target}-shm`;
    assert.ok(fs.existsSync(wal) && fs.statSync(wal).size > 0, 'SQLite itself created a non-empty WAL');
    assert.ok(fs.existsSync(shm) && fs.statSync(shm).size > 0, 'SQLite itself created the shared-memory sidecar');
    const mainBefore = fs.readFileSync(target);
    const walBefore = fs.readFileSync(wal);
    const headBefore = (await git(proj, ['rev-parse', 'HEAD'])).trim();
    const indexBefore = (await git(proj, ['write-tree'])).trim();

    const refused = await cli(proj, ['restore', 'good', '--yes'], envWithSqlite());
    assert.equal(refused.status, 1, `${refused.stdout}\n${refused.stderr}`);
    assert.match(`${refused.stdout}\n${refused.stderr}`, /target or sidecar already exists/i);
    assert.deepEqual(fs.readFileSync(target), mainBefore, 'existing main database remains byte-identical during refusal');
    assert.deepEqual(fs.readFileSync(wal), walBefore, 'active writer WAL bytes remain unchanged during refusal');
    assert.ok(fs.existsSync(shm), 'live SQLite shared-memory sidecar remains present');
    assert.equal((await git(proj, ['rev-parse', 'HEAD'])).trim(), headBefore, 'HEAD is unchanged');
    assert.equal((await git(proj, ['write-tree'])).trim(), indexBefore, 'index is unchanged');

    writer.stdin.write("COMMIT;\nSELECT name FROM items WHERE id=1;\nPRAGMA integrity_check;\n");
    await waitForOutput(writer, () => stdout.slice(stdout.lastIndexOf('live-uncommitted-marker') + 'live-uncommitted-marker'.length), 'ok', () => stderr);
    assert.match(stdout, /live-committed-marker[\s\S]*live-uncommitted-marker[\s\S]*live-uncommitted-marker[\s\S]*ok/, 'writer can commit after the restore refusal');
    writer.stdin.write('.quit\n');
    writer.stdin.end();
    await new Promise((resolve) => writer.once('close', resolve));
    writer = null;
    assert.equal(await sql(proj, 'app.db', "SELECT name FROM items WHERE id=1;"), 'live-uncommitted-marker', 'committed live transaction is intact after refusal');
    assert.equal(await sql(proj, 'app.db', 'PRAGMA integrity_check;'), 'ok', 'existing database remains valid after refusal');
  } finally {
    if (writer && writer.exitCode === null) {
      writer.stdin.write('ROLLBACK;\n.quit\n');
      writer.stdin.end();
      await new Promise((resolve) => writer.once('close', resolve));
    }
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

for (const suffix of ['-wal', '-shm', '-journal']) {
  (HAS_SQLITE ? test : test.skip)(`db: refuses missing target with controlled ${suffix} sidecar and preserves it`, async () => {
    const proj = await restorableProject(`pss-db-sidecar-${suffix.slice(1)}-`);
    try {
      const target = path.join(proj, 'app.db');
      fs.unlinkSync(target);
      assert.equal(fs.existsSync(target), false, 'main target is absent before controlled sidecar creation');
      const marker = Buffer.from(`CONTROLLED-SIDECAR-${suffix}`);
      fs.writeFileSync(`${target}${suffix}`, marker, { flag: 'wx' });
      const sidecarsBefore = Object.fromEntries(['-wal', '-shm', '-journal'].map((item) => [item, fs.existsSync(`${target}${item}`)]));
      const headBefore = (await git(proj, ['rev-parse', 'HEAD'])).trim();
      const indexBefore = (await git(proj, ['write-tree'])).trim();

      const refused = await cli(proj, ['restore', 'good', '--yes'], envWithSqlite());
      assert.equal(refused.status, 1, `${refused.stdout}\n${refused.stderr}`);
      assert.match(`${refused.stdout}\n${refused.stderr}`, /target or sidecar already exists/i);
      assert.equal(fs.existsSync(target), false, 'restore does not publish a main file beside an untrusted sidecar');
      assert.deepEqual(fs.readFileSync(`${target}${suffix}`), marker, 'controlled sidecar bytes remain unchanged');
      assert.deepEqual(Object.fromEntries(['-wal', '-shm', '-journal'].map((item) => [item, fs.existsSync(`${target}${item}`)])), sidecarsBefore, 'restore does not remove or add sidecars');
      assert.equal((await git(proj, ['rev-parse', 'HEAD'])).trim(), headBefore, 'HEAD remains unchanged');
      assert.equal((await git(proj, ['write-tree'])).trim(), indexBefore, 'index remains unchanged');
      const snapshot = await Storage.validateSnapshot(proj, 'good', { mode: 'restore' });
      assert.ok(snapshot.artifacts.some((item) => item.kind === 'sqlite-backup' && item.target === 'app.db'), 'the original private backup remains available');
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
}

(HAS_SQLITE ? test : test.skip)('db: an external SQLite target created after preflight wins the exclusive publish race', async () => {
  const proj = await restorableProject('pss-db-race-target-');
  try {
    const target = path.join(proj, 'app.db');
    fs.unlinkSync(target);
    const validated = await Storage.validateSnapshot(proj, 'good', { mode: 'restore' });
    const plan = await RestoreDb.planDatabaseRestore(proj, validated, { operationId: 'race-target-123456789012345678901234' });
    const token = await RestoreDb.preflightDatabaseRestore(proj, plan);
    const code = "require('child_process').execFileSync(process.argv[2],[process.argv[1],\"CREATE TABLE external_data(v TEXT); INSERT INTO external_data VALUES ('outside-won');\"],{stdio:'ignore'});";
    execFileSync(process.execPath, ['-e', code, path.join(proj, 'app.db'), SQLITE], { cwd: proj, env: envWithSqlite() });
    const outsideBytes = fs.readFileSync(target);
    await assert.rejects(RestoreDb.applyDatabaseRestore(proj, plan, token), /target or sidecar already exists/i);
    assert.deepEqual(fs.readFileSync(target), outsideBytes, 'apply refuses to replace the externally created database');
    assert.equal(await sql(proj, 'app.db', 'SELECT v FROM external_data;'), 'outside-won', 'external database contents survive unchanged');
    assert.equal(await sql(proj, 'app.db', 'PRAGMA integrity_check;'), 'ok', 'external database remains valid');
    const final = await Storage.validateSnapshot(proj, 'good', { mode: 'restore' });
    assert.ok(final.artifacts.some((item) => item.kind === 'sqlite-backup' && item.target === 'app.db'), 'source safety generation remains valid');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

(HAS_SQLITE ? test : test.skip)('db: an external sidecar created after preflight blocks database publication', async () => {
  const proj = await restorableProject('pss-db-race-sidecar-');
  try {
    const target = path.join(proj, 'app.db');
    const wal = `${target}-wal`;
    fs.unlinkSync(target);
    const validated = await Storage.validateSnapshot(proj, 'good', { mode: 'restore' });
    const plan = await RestoreDb.planDatabaseRestore(proj, validated, { operationId: 'race-sidecar-123456789012345678901234' });
    const token = await RestoreDb.preflightDatabaseRestore(proj, plan);
    const marker = Buffer.from('EXTERNAL-WAL-CREATED-AFTER-PREFLIGHT');
    const headBefore = (await git(proj, ['rev-parse', 'HEAD'])).trim();
    const indexBefore = (await git(proj, ['write-tree'])).trim();
    const code = "require('fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'), {flag:'wx'});";
    execFileSync(process.execPath, ['-e', code, wal, marker.toString('base64')], { cwd: proj, env: envWithSqlite() });
    const observed = fs.readFileSync(wal);
    await assert.rejects(RestoreDb.applyDatabaseRestore(proj, plan, token), /target or sidecar already exists/i);
    assert.equal(fs.existsSync(target), false, 'external sidecar is detected before the restore publishes a database');
    assert.deepEqual(fs.readFileSync(wal), observed, 'external process sidecar remains byte-identical');
    assert.equal((await git(proj, ['rev-parse', 'HEAD'])).trim(), headBefore, 'Git HEAD remains unchanged');
    assert.equal((await git(proj, ['write-tree'])).trim(), indexBefore, 'Git index remains unchanged');
    assert.equal((await Storage.validateSnapshot(proj, 'good', { mode: 'restore' })).generation, plan.generation, 'validated source generation remains available');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
