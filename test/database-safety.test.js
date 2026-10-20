'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const U = require('../lib/utils');
const DB = require('../lib/database');
const RestoreDb = require('../lib/restore-database');
const Collectors = require('../lib/collectors');
const Snapshot = require('../lib/snapshot');
const Store = require('../lib/storage');
const { removeTemporaryTree } = require('./helpers');

const generation = 'a'.repeat(32);
const schema = { fingerprint: 'f'.repeat(64), tables: ['items'] };
const rows = 2;
const record = {
  file: 'app.db', mode: 'backup', restore: 'sqlite-create-missing',
  artifactId: 'database-backup:app.db', schemaFingerprint: schema.fingerprint,
  tables: schema.tables, totalRows: rows, integrity: 'ok', rowContentsCompared: false,
};

async function tempProject() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pss-db-contract-'));
  return { root, dispose: () => removeTemporaryTree(root) };
}

test('temporary project disposal retries a transient Windows directory race and verifies removal', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pss-db-cleanup-'));
  t.after(() => removeTemporaryTree(root));
  await fsp.mkdir(path.join(root, '.project-state', 'operations'), { recursive: true });
  let attempts = 0;
  const remove = async (target, options) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('injected transient ENOTEMPTY while removing empty operations directory');
      error.code = 'ENOTEMPTY';
      throw error;
    }
    return fsp.rm(target, options);
  };

  await removeTemporaryTree(root, remove);
  assert.equal(attempts, 2);
  await assert.rejects(() => fsp.lstat(root), (error) => error.code === 'ENOENT');
});

test('temporary project disposal reports persistent cleanup failures', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pss-db-cleanup-fail-'));
  t.after(() => removeTemporaryTree(root));
  const failure = new Error('persistent transient-class cleanup failure');
  failure.code = 'ENOTEMPTY';
  let attempts = 0;

  await assert.rejects(() => removeTemporaryTree(root, async () => {
    attempts += 1;
    throw failure;
  }), (error) => error === failure);
  assert.equal(attempts, 6);
  await fsp.access(root);
});

async function privateSnapshot(root, options = {}) {
  const name = 'candidate';
  const bytes = options.bytes || Buffer.from('CONSISTENT_SQLITE_BACKUP');
  const selectedRecord = options.record || { ...record };
  if (options.schemaVersion === 1) {
    // Legacy behavior is tested with a deliberately minimal diagnostic value;
    // all current-format database plans below use a real snapshotInternal output.
    const generationRoot = path.join(root, '.project-state', 'secrets', name, 'generations', generation);
    const relativePath = 'db/app.db';
    const sourcePath = path.join(generationRoot, 'files', ...relativePath.split('/'));
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(sourcePath, bytes);
    return { bytes, sourcePath, value: { manifest: { schemaVersion: 1, state: 'complete', generation, name, kind: 'named' }, layers: { database: { databases: [selectedRecord] } }, artifacts: [{ id: 'database-backup:app.db', layer: 'database', kind: 'sqlite-backup', privacy: 'private', required: true, restore: 'sqlite-create-missing', target: 'app.db', path: relativePath, absolutePath: sourcePath, size: bytes.length, sha256: U.sha256(bytes) }], paths: { privateGeneration: generationRoot } } };
  }
  const dbCollector = Collectors.COLLECTORS.find((collector) => collector.id === 'database');
  const originalCollector = dbCollector.fn;
  dbCollector.fn = async (ctx) => {
    const withSeed = selectedRecord.mode === 'backup';
    const normalized = { ...selectedRecord, restore: withSeed ? 'sqlite-create-missing' : 'record-only', artifactId: `database-${withSeed ? 'backup' : 'schema'}:app.db` };
    ctx.files.push({ id: normalized.artifactId, layer: 'database', kind: withSeed ? 'sqlite-backup' : 'sqlite-schema', target: 'app.db', content: bytes });
    return U.ok({ databases: [normalized], engine: 'sqlite3 online backup API', withSeed, comparison: 'schema and row counts recorded; row contents not compared' });
  };
  let saved;
  try { saved = await Snapshot.snapshotInternal(root, name, { withSeed: true, overwrite: true }); }
  finally { dbCollector.fn = originalCollector; }
  const value = await Store.validateSnapshot(root, name, { mode: 'restore' });
  const artifact = value.artifacts.find((item) => item.id === `database-${selectedRecord.mode === 'backup' ? 'backup' : 'schema'}:app.db`);
  return { bytes, sourcePath: artifact.absolutePath, value };
}

function mockInspect(t) {
  const original = DB.inspectBackup;
  DB.inspectBackup = async () => ({ integrity: 'ok', schemaFingerprint: schema.fingerprint, tables: schema.tables, totalRows: rows });
  t.after(() => { DB.inspectBackup = original; });
}

test('database filename validation rejects reserved, unsafe, and case-fold duplicate targets', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  for (const name of ['../app.db', 'NUL.db', 'bad:name.db', 'app.sqlite-wal']) {
    assert.throws(() => DB.assertDatabaseName(name), /unsupported SQLite database filename/);
  }
  await assert.rejects(() => DB.collectSqliteFiles({ root: project.root, files: [] }, ['app.db', 'APP.DB']), /collide on case-insensitive filesystems/);
});

test('Git status probe failure is not recorded as a clean collector result', async (t) => {
  const original = U.runTrusted;
  U.runTrusted = async (_command, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { ok: true, stdout: 'true\n' };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { ok: true, stdout: 'a'.repeat(40) };
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { ok: true, stdout: 'main\n' };
    return { ok: false, stderr: 'injected git status failure' };
  };
  t.after(() => { U.runTrusted = original; });
  const result = await Collectors.collectGit({ root: process.cwd() });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /clean working state cannot be established/);
});

test('collector stores SQL as private record-only and creates binary backup only with explicit seed consent', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  const oldResolve = U.resolveTrustedBinary;
  const oldRun = U.run;
  U.resolveTrustedBinary = () => ({ path: 'sqlite3', isScript: false });
  U.run = async (_binary, args, options) => {
    const command = args.join(' ');
    if (command.includes('.backup ')) {
      const match = command.match(/\.backup \"([^\"]+)\"/);
      assert.ok(match, 'backup command uses a generated, quoted staging basename');
      await fsp.writeFile(path.join(options.cwd, match[1]), 'sqlite-binary', { flag: 'wx' });
      return { ok: true, stdout: '', stderr: '' };
    }
    if (command.includes('journal_mode=DELETE')) return { ok: true, stdout: 'delete\n', stderr: '' };
    if (command.includes('integrity_check')) return { ok: true, stdout: 'ok\n', stderr: '' };
    if (command.includes('sqlite_schema') && command.includes('type,name,tbl_name,sql')) {
      return { ok: true, stdout: JSON.stringify([{ type: 'table', name: 'items', tbl_name: 'items', sql: 'CREATE TABLE items(id)' }]), stderr: '' };
    }
    if (command.includes('count(*)')) return { ok: true, stdout: JSON.stringify([{ name: 'items', n: rows }]), stderr: '' };
    throw new Error(`unexpected generated SQLite invocation: ${command}`);
  };
  t.after(() => { U.resolveTrustedBinary = oldResolve; U.run = oldRun; });

  await fsp.writeFile(path.join(project.root, 'app.db'), 'source-db');
  const ordinary = { root: project.root, files: [], results: {}, withSeed: false };
  const first = await Collectors.collectDatabase(ordinary);
  assert.equal(first.status, 'collected');
  assert.equal(first.data.databases[0].mode, 'schema');
  assert.equal(ordinary.files.length, 1);
  assert.equal(ordinary.files[0].id, 'database-schema:app.db');
  assert.equal(ordinary.files[0].kind, 'sqlite-schema');
  assert.equal(ordinary.files[0].privacy, 'private');
  assert.equal(ordinary.files[0].restore, 'record-only');
  assert.equal(ordinary.files[0].target, 'app.db');
  assert.equal(ordinary.files[0].path, 'app.db.schema.sql');
  assert.match(ordinary.files[0].content.toString('utf8'), /CREATE TABLE items/);

  const optedIn = { root: project.root, files: [], results: {}, withSeed: true };
  const second = await Collectors.collectDatabase(optedIn);
  assert.equal(second.status, 'collected');
  assert.equal(second.data.databases[0].mode, 'backup');
  assert.deepEqual(optedIn.files.map((entry) => entry.kind).sort(), ['sqlite-backup', 'sqlite-schema']);
  const schemaArtifact = optedIn.files.find((entry) => entry.kind === 'sqlite-schema');
  const backup = optedIn.files.find((entry) => entry.kind === 'sqlite-backup');
  assert.equal(schemaArtifact.path, 'app.db.schema.sql');
  assert.equal(backup.path, 'app.db.sqlite');
  assert.notEqual(schemaArtifact.path, backup.path, 'schema and binary use different paths relative to generation/files');
  assert.equal(backup.privacy, 'private');
  assert.equal(backup.restore, 'sqlite-create-missing');
  assert.equal(backup.target, 'app.db');
  assert.ok(Buffer.isBuffer(backup.content));
  assert.deepEqual(Object.keys(backup).sort(), ['content', 'id', 'kind', 'layer', 'path', 'privacy', 'required', 'restore', 'target'].sort());

  // Exercise the actual collector registry and snapshot writer with the full
  // two-artifact result. The fake SQLite process isolates path assembly from
  // the separately gated SQLite engine behavior.
  const assembled = await Snapshot.snapshotInternal(project.root, 'with-seed', { withSeed: true });
  const checked = await Store.validateSnapshot(project.root, 'with-seed', { mode: 'restore' });
  const storedSchema = checked.artifacts.find((entry) => entry.id === 'database-schema:app.db');
  const storedBackup = checked.artifacts.find((entry) => entry.id === 'database-backup:app.db');
  assert.equal(assembled.committed, true);
  assert.equal(storedSchema.path, 'app.db.schema.sql');
  assert.equal(storedBackup.path, 'app.db.sqlite');
  assert.notEqual(storedSchema.absolutePath, storedBackup.absolutePath);
  assert.match(storedSchema.absolutePath.replace(/\\/g, '/'), /\/files\/app\.db\.schema\.sql$/);
  assert.match(storedBackup.absolutePath.replace(/\\/g, '/'), /\/files\/app\.db\.sqlite$/);
  assert.deepEqual(await fsp.readdir(path.join(project.root, '.project-state', 'staging')), [], 'collector removes its private temporary generation');
});

test('database collection failures keep private engine details out of public snapshot metadata', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  const marker = 'PRIVATE_TABLE_MARKER SQL=PRIVATE_SQL path=C:\\private\\source.db';
  const originalResolve = U.resolveTrustedBinary;
  const originalCollect = DB.collectSqliteFiles;
  U.resolveTrustedBinary = (name) => name === 'sqlite3' ? { path: 'sqlite3', isScript: false } : null;
  DB.collectSqliteFiles = async () => { throw new Error(marker); };
  t.after(() => { U.resolveTrustedBinary = originalResolve; DB.collectSqliteFiles = originalCollect; });

  await fsp.writeFile(path.join(project.root, 'app.db'), 'database marker source');
  const saved = await Snapshot.snapshotInternal(project.root, 'redacted-db-error');
  const checked = await Store.validateSnapshot(project.root, 'redacted-db-error', { mode: 'diagnostic' });
  const publicManifest = await fsp.readFile(path.join(checked.paths.publicGenerationDir, 'manifest.json'), 'utf8');
  const publicReason = checked.manifest.layers.database.reason;
  assert.equal(saved.committed, true);
  assert.equal(publicReason, 'consistent SQLite snapshot failed; database layer omitted (details withheld)');
  assert.doesNotMatch(publicReason, /PRIVATE_TABLE_MARKER|PRIVATE_SQL|C:\\\\private/);
  assert.doesNotMatch(publicManifest, /PRIVATE_TABLE_MARKER|PRIVATE_SQL|C:\\\\private/);
  assert.doesNotMatch(JSON.stringify(saved.manifest), /PRIVATE_TABLE_MARKER|PRIVATE_SQL|C:\\\\private/);
});

test('plan accepts only private v2 binary backup and validates bytes plus database metadata', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  mockInspect(t);
  const snapshot = await privateSnapshot(project.root);
  const plan = await RestoreDb.planDatabaseRestore(project.root, snapshot.value);
  assert.deepEqual(plan.steps.map((step) => [step.target, step.mode, step.expectedRows]), [['app.db', 'sqlite-create-missing', rows]]);
  assert.equal(plan.steps[0].sourceSha256, U.sha256(snapshot.bytes));
  assert.deepEqual(plan.refusals, []);

  snapshot.value.artifacts.find((artifact) => artifact.id === 'database-backup:app.db').privacy = 'public';
  await assert.rejects(() => RestoreDb.planDatabaseRestore(project.root, snapshot.value), /unsupported privacy or restore policy/);
});

test('database restore plan resolves a real snapshotInternal artifact under generation/files', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  mockInspect(t);
  const snapshot = await privateSnapshot(project.root);
  const artifact = snapshot.value.artifacts.find((item) => item.id === 'database-backup:app.db');
  assert.equal(artifact.path, 'app.db', 'artifact.path is relative to generation/files');
  assert.match(artifact.absolutePath.replace(/\\/g, '/'), /\/generations\/[a-f0-9]{32}\/files\/app\.db$/);
  const plan = await RestoreDb.planDatabaseRestore(project.root, snapshot.value);
  assert.equal(plan.steps[0].sourcePath, artifact.absolutePath);
  assert.deepEqual(await fsp.readFile(plan.steps[0].sourcePath), snapshot.bytes);
});

test('plan rejects legacy SQL restore and corrupted or mismatched private artifacts before writes', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  mockInspect(t);
  const legacy = await privateSnapshot(project.root, { schemaVersion: 1 });
  await assert.rejects(() => RestoreDb.planDatabaseRestore(project.root, legacy.value), (error) => error.code === 'ELEGACY_RESTORE');

  const damaged = await privateSnapshot(project.root, { bytes: Buffer.from('tampered') });
  damaged.value.artifacts.find((artifact) => artifact.id === 'database-backup:app.db').sha256 = '0'.repeat(64);
  await assert.rejects(() => RestoreDb.planDatabaseRestore(project.root, damaged.value), (error) => error.code === 'EARTIFACT_INTEGRITY');

  const wrongMeta = await privateSnapshot(project.root, { record: { ...record, totalRows: 999 } });
  await assert.rejects(() => RestoreDb.planDatabaseRestore(project.root, wrongMeta.value), /does not match its database metadata/);
});

test('schema-only metadata is record-only and never becomes an apply step', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  const snapshot = await privateSnapshot(project.root, { record: { ...record, mode: 'schema', restore: 'record-only' } });
  snapshot.value.artifacts = [{ id: 'schema:app.db', layer: 'database', kind: 'sqlite-schema', privacy: 'private', required: true, restore: 'record-only', target: 'app.db', path: 'app.db.schema.sql', absolutePath: path.join(path.dirname(snapshot.sourcePath), 'app.db.schema.sql'), size: 1, sha256: 'a'.repeat(64) }];
  const plan = await RestoreDb.planDatabaseRestore(project.root, snapshot.value);
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.refusals.length, 0);
});

test('schema SQL with an executable restore policy is rejected without execution', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  const snapshot = await privateSnapshot(project.root, { record: { ...record, mode: 'schema', restore: 'record-only' } });
  snapshot.value.artifacts = [{
    id: 'schema:app.db', layer: 'database', kind: 'sqlite-schema', privacy: 'private',
    required: true, restore: 'sqlite-create-missing', target: 'app.db', path: 'app.db.schema.sql',
    absolutePath: path.join(path.dirname(snapshot.sourcePath), 'app.db.schema.sql'), size: 31,
    sha256: 'a'.repeat(64),
  }];
  await assert.rejects(() => RestoreDb.planDatabaseRestore(project.root, snapshot.value), /must be private and record-only/);
});

test('preflight refuses existing databases and each SQLite sidecar without changing bytes', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  mockInspect(t);
  const snapshot = await privateSnapshot(project.root);
  const plan = await RestoreDb.planDatabaseRestore(project.root, snapshot.value);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const target = path.join(project.root, `app.db${suffix}`);
    const before = Buffer.from(`external${suffix}`);
    await fsp.writeFile(target, before);
    await assert.rejects(() => RestoreDb.preflightDatabaseRestore(project.root, plan), (error) => error.code === 'EDATABASE_TARGET_EXISTS');
    assert.deepEqual(await fsp.readFile(target), before, `${path.basename(target)} bytes unchanged`);
    await fsp.unlink(target);
  }
});

test('preflight token is bound to the exact plan, root and backup digest', async (t) => {
  const project = await tempProject();
  const other = await tempProject();
  t.after(project.dispose);
  t.after(other.dispose);
  mockInspect(t);
  const snapshot = await privateSnapshot(project.root);
  const plan = await RestoreDb.planDatabaseRestore(project.root, snapshot.value);
  const token = await RestoreDb.preflightDatabaseRestore(project.root, plan);
  await assert.rejects(() => RestoreDb.applyDatabaseRestore(other.root, plan, token), /authentic preflight token/);
  const forged = { ...token };
  await assert.rejects(() => RestoreDb.applyDatabaseRestore(project.root, plan, forged), /authentic preflight token/);
  await fsp.writeFile(snapshot.sourcePath, 'changed after preflight');
  await assert.rejects(() => RestoreDb.applyDatabaseRestore(project.root, plan, token), /target or sidecar already exists|changed before apply/);
  assert.equal(await fsp.stat(path.join(project.root, 'app.db')).then(() => true, () => false), false);
});

test('apply creates and verifies only a missing target; compensation removes only this operation’s unchanged file', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  mockInspect(t);
  const snapshot = await privateSnapshot(project.root);
  const plan = await RestoreDb.planDatabaseRestore(project.root, snapshot.value);
  const token = await RestoreDb.preflightDatabaseRestore(project.root, plan);
  const applied = await RestoreDb.applyDatabaseRestore(project.root, plan, token);
  assert.equal(applied.status, 'applied-verified');
  assert.deepEqual(await fsp.readFile(path.join(project.root, 'app.db')), snapshot.bytes);
  assert.equal((await RestoreDb.verifyDatabaseRestore(project.root, plan)).ok, true);
  assert.deepEqual(await fsp.readdir(path.join(project.root, '.project-state', 'staging', plan.operationId, 'private')), [], 'restore removes its private staging files');
  const compensated = await RestoreDb.compensateDatabaseRestore(project.root, plan, token);
  assert.equal(compensated.status, 'compensated');
  assert.equal(await fsp.stat(path.join(project.root, 'app.db')).then(() => true, () => false), false);
  assert.equal(await fsp.stat(path.join(project.root, 'app.db-wal')).then(() => true, () => false), false);
});

test('compensation refuses to delete an externally modified target or a target with a newly attached sidecar', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  mockInspect(t);
  const snapshot = await privateSnapshot(project.root);
  const plan = await RestoreDb.planDatabaseRestore(project.root, snapshot.value);
  const token = await RestoreDb.preflightDatabaseRestore(project.root, plan);
  await RestoreDb.applyDatabaseRestore(project.root, plan, token);
  const target = path.join(project.root, 'app.db');
  await fsp.writeFile(target, 'external modification');
  const modified = await RestoreDb.compensateDatabaseRestore(project.root, plan, token);
  assert.equal(modified.status, 'rollback-incomplete');
  assert.equal(await fsp.readFile(target, 'utf8'), 'external modification');

  // A fresh plan demonstrates that a sidecar also protects a target from
  // compensation even when the installed main-file bytes remain unchanged.
  await fsp.unlink(target);
  const nextSnapshot = await privateSnapshot(project.root);
  const nextPlan = await RestoreDb.planDatabaseRestore(project.root, nextSnapshot.value);
  const nextToken = await RestoreDb.preflightDatabaseRestore(project.root, nextPlan);
  await RestoreDb.applyDatabaseRestore(project.root, nextPlan, nextToken);
  await fsp.writeFile(`${target}-wal`, 'external writer marker');
  const sidecar = await RestoreDb.compensateDatabaseRestore(project.root, nextPlan, nextToken);
  assert.equal(sidecar.status, 'rollback-incomplete');
  assert.deepEqual(await fsp.readFile(target), nextSnapshot.bytes);
  assert.equal(await fsp.readFile(`${target}-wal`, 'utf8'), 'external writer marker');
});

test('exclusive publish race preserves a file created by another process', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  mockInspect(t);
  const snapshot = await privateSnapshot(project.root);
  const plan = await RestoreDb.planDatabaseRestore(project.root, snapshot.value);
  const token = await RestoreDb.preflightDatabaseRestore(project.root, plan);
  const originalLink = fsp.link;
  fsp.link = async (_from, to) => {
    await fsp.writeFile(to, 'created concurrently');
    const error = new Error('target exists'); error.code = 'EEXIST'; throw error;
  };
  try {
    await assert.rejects(() => RestoreDb.applyDatabaseRestore(project.root, plan, token), /target exists/);
  } finally { fsp.link = originalLink; }
  assert.equal(await fsp.readFile(path.join(project.root, 'app.db'), 'utf8'), 'created concurrently');
});

async function rollbackFixture(t, project) {
  mockInspect(t);
  const originalSnapshot = await privateSnapshot(project.root);
  const targetPath = path.join(project.root, 'app.db');
  await fsp.writeFile(targetPath, originalSnapshot.bytes);
  const targetStat = await fsp.stat(targetPath, { bigint: true });
  const originalOperation = 'restore-original-1';
  const safetyGeneration = 'b'.repeat(32);
  const safety = {
    manifest: { schemaVersion: 2, state: 'complete', generation: safetyGeneration, name: 'auto-safety', kind: 'auto' },
    artifacts: [{ id: 'rollback:absent:app.db', layer: 'rollback', kind: 'absent', privacy: 'private', required: true, restore: 'record-only', target: 'app.db', path: null, sha256: null, size: 0, absolutePath: null }],
  };
  const journal = {
    operationId: originalOperation, operation: 'restore', status: 'completed', terminalOutcome: 'verified-complete',
    snapshot: { name: 'candidate', generation: originalSnapshot.value.generation },
    safety: { name: safety.manifest.name, generation: safetyGeneration },
    appliedTargets: [{
      target: 'app.db', preExists: false, preSha256: null, preSize: 0, postExists: true,
      postSha256: U.sha256(originalSnapshot.bytes), postSize: originalSnapshot.bytes.length,
      postFileId: { dev: targetStat.dev.toString(), ino: targetStat.ino.toString() },
    }],
  };
  const plan = await RestoreDb.planDatabaseRollback(project.root, safety, { operationId: originalOperation, previousJournal: journal });
  return { safety, journal, originalSnapshot, plan, targetPath };
}

test('cross-process rollback requires exact journal identity, post size and private absence marker', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  const fixture = await rollbackFixture(t, project);
  assert.deepEqual(fixture.plan.steps.map((step) => [step.target, step.mode, step.postSize]), [['app.db', 'sqlite-remove-created', fixture.originalSnapshot.bytes.length]]);

  const wrongSize = structuredClone(fixture.journal);
  wrongSize.appliedTargets[0].postSize += 1;
  await assert.rejects(() => RestoreDb.planDatabaseRollback(project.root, fixture.safety, { operationId: wrongSize.operationId, previousJournal: wrongSize }), /does not match journal post-state/);

  const wrongIdentity = structuredClone(fixture.journal);
  wrongIdentity.appliedTargets[0].postFileId.ino = '0';
  await assert.rejects(() => RestoreDb.planDatabaseRollback(project.root, fixture.safety, { operationId: wrongIdentity.operationId, previousJournal: wrongIdentity }), /bytes, size, or identity changed/);
});

test('database rollback resolves the exact original generation after same-name overwrite', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  mockInspect(t);

  const originalSnapshot = await privateSnapshot(project.root, { bytes: Buffer.from('ORIGINAL_DATABASE_BACKUP') });
  const targetPath = path.join(project.root, 'app.db');
  await fsp.writeFile(targetPath, originalSnapshot.bytes);
  const targetStat = await fsp.stat(targetPath, { bigint: true });
  const overwrite = await privateSnapshot(project.root, { bytes: Buffer.from('NEW_GENERATION_BACKUP') });
  assert.notEqual(overwrite.value.generation, originalSnapshot.value.generation);

  const safetyGeneration = 'b'.repeat(32);
  const safety = {
    manifest: { schemaVersion: 2, state: 'complete', generation: safetyGeneration, name: 'auto-safety', kind: 'auto' },
    artifacts: [{ id: 'rollback:absent:app.db', layer: 'rollback', kind: 'absent', privacy: 'private', required: true, restore: 'record-only', target: 'app.db', path: null, sha256: null, size: 0, absolutePath: null }],
  };
  const operationId = 'restore-before-overwrite';
  const journal = {
    operationId, operation: 'restore', status: 'completed', terminalOutcome: 'verified-complete',
    snapshot: { name: 'candidate', generation: originalSnapshot.value.generation },
    safety: { name: safety.manifest.name, generation: safetyGeneration },
    appliedTargets: [{
      target: 'app.db', preExists: false, preSha256: null, preSize: 0, postExists: true,
      postSha256: U.sha256(originalSnapshot.bytes), postSize: originalSnapshot.bytes.length,
      postFileId: { dev: targetStat.dev.toString(), ino: targetStat.ino.toString() },
    }],
  };

  const plan = await RestoreDb.planDatabaseRollback(project.root, safety, { operationId, previousJournal: journal });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].sourceSha256, U.sha256(originalSnapshot.bytes));
  assert.equal(plan.steps[0].sourcePath, originalSnapshot.sourcePath);
});

test('database rollback with no database marker does not resolve the original snapshot generation', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  const safetyGeneration = 'c'.repeat(32);
  const safety = {
    manifest: { schemaVersion: 2, state: 'complete', generation: safetyGeneration, name: 'auto-empty-safety', kind: 'auto' },
    artifacts: [],
  };
  const operationId = 'restore-no-database-targets';
  const journal = {
    operationId, operation: 'restore', status: 'completed', terminalOutcome: 'verified-complete',
    snapshot: { name: 'missing-original-snapshot', generation: 'd'.repeat(32) },
    safety: { name: safety.manifest.name, generation: safetyGeneration },
    appliedTargets: [],
  };

  const plan = await RestoreDb.planDatabaseRollback(project.root, safety, { operationId, previousJournal: journal });
  assert.deepEqual(plan.steps, []);
});

test('cross-process rollback removes only proven unchanged database and verifies absence', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  const fixture = await rollbackFixture(t, project);
  const token = await RestoreDb.preflightDatabaseRollback(project.root, fixture.plan);
  const result = await RestoreDb.applyDatabaseRollback(project.root, fixture.plan, token);
  assert.equal(result.status, 'applied-verified');
  assert.deepEqual(result.steps, [{ target: 'app.db', absent: true, sidecarsAbsent: true }]);
  assert.equal((await RestoreDb.verifyDatabaseRollback(project.root, fixture.plan)).ok, true);
  assert.equal(await fsp.stat(fixture.targetPath).then(() => true, () => false), false);
  for (const suffix of DB.SIDECARS) assert.equal(await fsp.stat(`${fixture.targetPath}${suffix}`).then(() => true, () => false), false);
});

test('cross-process rollback detects changed bytes, replacement identity and sidecars before mutation', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  const fixture = await rollbackFixture(t, project);
  const token = await RestoreDb.preflightDatabaseRollback(project.root, fixture.plan);
  await fsp.writeFile(`${fixture.targetPath}-wal`, 'external writer');
  await assert.rejects(() => RestoreDb.applyDatabaseRollback(project.root, fixture.plan, token), /sidecars|sidecar/);
  assert.deepEqual(await fsp.readFile(fixture.targetPath), fixture.originalSnapshot.bytes);
  assert.equal(await fsp.readFile(`${fixture.targetPath}-wal`, 'utf8'), 'external writer');
  await fsp.unlink(`${fixture.targetPath}-wal`);
  await fsp.writeFile(fixture.targetPath, 'same path externally changed');
  await assert.rejects(() => RestoreDb.applyDatabaseRollback(project.root, fixture.plan, token), /bytes, size, or identity changed/);
  assert.equal(await fsp.readFile(fixture.targetPath, 'utf8'), 'same path externally changed');
});

test('cross-process rollback compensation restores removed DB only to a still-absent target', async (t) => {
  const project = await tempProject();
  t.after(project.dispose);
  const fixture = await rollbackFixture(t, project);
  const token = await RestoreDb.preflightDatabaseRollback(project.root, fixture.plan);
  await RestoreDb.applyDatabaseRollback(project.root, fixture.plan, token);
  const compensated = await RestoreDb.compensateDatabaseRollback(project.root, fixture.plan, token);
  assert.equal(compensated.status, 'compensated-and-verified');
  assert.deepEqual(await fsp.readFile(fixture.targetPath), fixture.originalSnapshot.bytes);

  const second = await rollbackFixture(t, project);
  const secondToken = await RestoreDb.preflightDatabaseRollback(project.root, second.plan);
  await RestoreDb.applyDatabaseRollback(project.root, second.plan, secondToken);
  await fsp.writeFile(second.targetPath, 'external post-rollback file');
  const refused = await RestoreDb.compensateDatabaseRollback(project.root, second.plan, secondToken);
  assert.equal(refused.status, 'rollback-incomplete');
  assert.equal(await fsp.readFile(second.targetPath, 'utf8'), 'external post-rollback file');
});
