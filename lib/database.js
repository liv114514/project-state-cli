'use strict';

// SQLite collection uses only SQLite's online backup API. Snapshot SQL is
// retained as private, record-only data and is never sent to sqlite3 input.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const U = require('./utils');

const SQLITE_EXTS = new Set(['.db', '.sqlite', '.sqlite3']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.project-state', '.workbuddy']);
const DB_FILE_RE = /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))[^\\/:*?"<>|\x00-\x1f.][^\\/:*?"<>|\x00-\x1f]*\.(?:db|sqlite|sqlite3)$/i;
const SIDECARS = ['-wal', '-shm', '-journal'];

function errorLine(result) {
  return String(result.stderr || result.message || 'sqlite3 failed').trim().split(/\r?\n/)[0];
}

function assertDatabaseName(name) {
  if (typeof name !== 'string' || !DB_FILE_RE.test(name) || name.startsWith('.')) {
    throw new Error(`unsupported SQLite database filename: ${String(name)}`);
  }
  return name;
}

async function discoverSqliteFiles(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && !entry.name.startsWith('.') &&
      !SKIP_DIRS.has(entry.name) && SQLITE_EXTS.has(path.extname(entry.name).toLowerCase()) && DB_FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));
  const folded = new Set();
  for (const file of files) {
    const key = file.toLowerCase();
    if (folded.has(key)) throw new Error(`database filenames collide on case-insensitive filesystems: ${file}`);
    folded.add(key);
  }
  return files;
}

function runSqlite(root, args, options = {}) {
  const trusted = U.resolveTrustedBinary('sqlite3', root);
  if (!trusted) return Promise.resolve({ ok: false, code: 'ENOENT', stdout: '', stderr: '', message: 'trusted sqlite3 executable not found' });
  if (trusted.isScript) return Promise.resolve({ ok: false, code: 'EREFUSED', stdout: '', stderr: '', message: 'sqlite3 command shim is unsupported' });
  return U.run(trusted.path, args, {
    cwd: options.cwd || root,
    timeout: options.timeout || 30000,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    shell: false,
  });
}

async function assertRegularDatabase(file, root) {
  const absolute = path.resolve(file);
  await U.assertNoReparseComponents(absolute, path.resolve(root));
  const stat = await fsp.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`SQLite database is not a regular file: ${path.basename(absolute)}`);
  return absolute;
}

async function inspectBackup(root, filePath) {
  const absolute = await assertRegularDatabase(filePath, root);
  const integrity = await runSqlite(root, ['-batch', '-bail', '-readonly', '--safe', absolute, 'PRAGMA trusted_schema=OFF; PRAGMA integrity_check;']);
  if (!integrity.ok || integrity.stdout.trim().toLowerCase() !== 'ok') {
    throw new Error(`SQLite integrity_check failed: ${errorLine(integrity) || integrity.stdout.trim()}`);
  }

  // Read all metadata and counts from the same immutable backup. SQL is built
  // from fixed queries and quoted identifiers; no snapshot-supplied SQL runs.
  const schemaResult = await runSqlite(root, [
    '-batch', '-bail', '-readonly', '--safe', '-json', absolute,
    'PRAGMA trusted_schema=OFF;',
    "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name;",
  ]);
  if (!schemaResult.ok) throw new Error(`SQLite schema inspection failed: ${errorLine(schemaResult)}`);
  let schema;
  try { schema = schemaResult.stdout.trim() ? JSON.parse(schemaResult.stdout) : []; }
  catch { throw new Error('SQLite schema inspection returned invalid JSON'); }
  if (!Array.isArray(schema) || schema.some((row) => !row || typeof row.name !== 'string' || typeof row.sql !== 'string')) {
    throw new Error('SQLite schema inspection returned invalid rows');
  }

  const tables = schema.filter((row) => row.type === 'table' && !row.name.startsWith('sqlite_')).map((row) => row.name).sort((a, b) => a.localeCompare(b, 'en'));
  const quoteIdentifier = (name) => `"${name.replace(/"/g, '""')}"`;
  const quoteLiteral = (value) => `'${value.replace(/'/g, "''")}'`;
  let totalRows = 0;
  if (tables.length) {
    // One bounded result set replaces a table-list process plus one process
    // per table. Names come from this immutable backup and are quoted both as
    // identifiers and result labels; odd names cannot become SQL syntax.
    const statements = tables.map((table) => `SELECT ${quoteLiteral(table)} AS name, count(*) AS n FROM ${quoteIdentifier(table)}`);
    const batches = [];
    let batch = [];
    for (const statement of statements) {
      const candidate = [...batch, statement].join(' UNION ALL ');
      if (batch.length && Buffer.byteLength(candidate, 'utf8') > 12000) { batches.push(batch); batch = [statement]; }
      else batch.push(statement);
    }
    if (batch.length) batches.push(batch);
    const rows = [];
    for (const part of batches) {
      const countResult = await runSqlite(root, [
        '-batch', '-bail', '-readonly', '--safe', '-json', absolute,
        'PRAGMA trusted_schema=OFF;', part.join(' UNION ALL '),
      ], { maxBuffer: 32 * 1024 * 1024 });
      if (!countResult.ok) throw new Error(`SQLite row-count inspection failed: ${errorLine(countResult)}`);
      let parsed;
      try { parsed = JSON.parse(countResult.stdout); }
      catch { throw new Error('SQLite row-count inspection returned invalid JSON'); }
      if (!Array.isArray(parsed) || parsed.length !== part.length) throw new Error('SQLite row-count result is incomplete');
      rows.push(...parsed);
    }
    if (rows.length !== tables.length) throw new Error('SQLite row-count result is incomplete');
    const counts = new Map();
    for (const row of rows) {
      if (!row || typeof row.name !== 'string' || counts.has(row.name) || !Number.isSafeInteger(row.n) || row.n < 0) throw new Error('SQLite row-count result contains invalid or duplicate entries');
      counts.set(row.name, row.n);
    }
    for (const table of tables) {
      const count = counts.get(table);
      if (count === undefined || !Number.isSafeInteger(totalRows + count)) throw new Error(`SQLite row count is outside the safe integer range for table ${table}`);
      totalRows += count;
    }
  }

  const schemaText = schema.map((row) => `${row.sql};`).join('\n') + (schema.length ? '\n' : '');
  return {
    tables,
    totalRows,
    schemaText,
    schemaFingerprint: U.sha256(Buffer.from(JSON.stringify(schema))),
    integrity: 'ok',
  };
}

async function createConsistentBackup(root, sourcePath, destination) {
  const source = await assertRegularDatabase(sourcePath, root);
  const destinationAbs = path.resolve(destination);
  await U.assertNoReparseComponents(destinationAbs, path.resolve(root));
  const destinationDir = path.dirname(destinationAbs);
  const name = path.basename(destinationAbs);
  if (!/^backup-[a-f0-9-]+\.sqlite$/i.test(name)) throw new Error('private SQLite backup must use a generated staging filename');
  // The SQLite CLI creates a rollback journal beside the backup while the
  // online backup is written. Older Windows SQLite builds use MAX_PATH for
  // that transient file even when Node can create the same directory tree.
  // Reject before invoking SQLite if the journal path cannot be represented.
  const journalPath = `${destinationAbs}-journal`;
  if (process.platform === 'win32' && journalPath.length >= 260) {
    const error = new Error('private SQLite staging path exceeds the Windows SQLite journal path limit');
    error.code = 'ESQLITE_PATH_LIMIT';
    throw error;
  }
  try { await fsp.lstat(destinationAbs); throw new Error('SQLite backup destination already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  // The .backup dot command receives only our generated basename. The source
  // path is a normal argv item and shell execution is disabled.
  const backup = await runSqlite(root, ['-batch', '-bail', '-readonly', source, `.backup "${name}"`], {
    cwd: destinationDir,
    timeout: 120000,
  });
  if (!backup.ok) throw new Error(`SQLite online backup failed for ${path.basename(source)}: ${errorLine(backup)}`);
  const created = await fsp.lstat(destinationAbs).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!created?.isFile() || created.isSymbolicLink()) throw new Error('SQLite online backup did not produce a regular database file');

  // Normalize only the private backup so it is standalone; never mutate the
  // source database or copy its WAL/SHM files.
  const normalized = await runSqlite(root, ['-batch', '-bail', destinationAbs, 'PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE;'], { timeout: 30000 });
  if (!normalized.ok || normalized.stdout.trim().toLowerCase() !== 'delete') {
    throw new Error(`could not normalize private SQLite backup: ${errorLine(normalized)}`);
  }
  for (const suffix of SIDECARS) {
    const sidecar = await fsp.lstat(`${destinationAbs}${suffix}`).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (sidecar) throw new Error(`private SQLite backup has unexpected sidecar: ${path.basename(destinationAbs)}${suffix}`);
  }
  const info = await inspectBackup(root, destinationAbs);
  return { path: destinationAbs, ...info };
}

async function createPrivateStaging(root, requestedOperationId) {
  const rootAbs = path.resolve(root);
  const state = path.join(rootAbs, '.project-state');
  const staging = path.join(state, 'staging');
  const ownsOperationDir = !requestedOperationId;
  const operationId = requestedOperationId || `dbcollect-${crypto.randomUUID()}`;
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new Error('invalid database staging operation id');
  await U.assertNoReparseComponents(state, rootAbs);
  await fsp.mkdir(state, { recursive: true, mode: 0o700 });
  await U.assertNoReparseComponents(staging, state);
  await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
  await U.assertNoReparseComponents(staging, state);
  const operationDir = path.join(staging, operationId);
  await fsp.mkdir(operationDir, { recursive: !ownsOperationDir, mode: 0o700 });
  await U.assertNoReparseComponents(operationDir, staging);
  // Keep this directory directly under the operation staging root and use a
  // short component. The SQLite CLI resolves its temporary journal relative
  // to cwd; long names here can push that transient path past Windows MAX_PATH.
  const privateDir = path.join(operationDir, 'priv');
  await fsp.mkdir(privateDir, { recursive: true, mode: 0o700 });
  await U.assertNoReparseComponents(privateDir, operationDir);
  const databaseDir = path.join(privateDir, `db-${crypto.randomUUID()}`);
  await fsp.mkdir(databaseDir, { mode: 0o700 });
  await U.assertNoReparseComponents(databaseDir, privateDir);
  return databaseDir;
}

async function collectSqliteFiles(ctx, files) {
  const folded = new Set();
  for (const file of files) {
    assertDatabaseName(file);
    const key = file.toLowerCase();
    if (folded.has(key)) throw new Error(`database filenames collide on case-insensitive filesystems: ${file}`);
    folded.add(key);
  }

  let staging;
  try { staging = await createPrivateStaging(ctx.root, ctx.operationId || ctx.lock?.operationId); }
  catch (cause) {
    const error = new Error('private SQLite staging unavailable');
    error.code = 'EDATABASE_STAGING';
    error.cause = cause;
    throw error;
  }
  const artifactInputs = [];
  const databases = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const source = path.join(path.resolve(ctx.root), file);
      const backupPath = path.join(staging, `backup-${index}-${crypto.randomUUID()}.sqlite`);
      const info = await createConsistentBackup(ctx.root, source, backupPath);
      const withSeed = !!ctx.withSeed;
      // Schema-only collection still uses an online backup as its consistency
      // source, but does not duplicate the entire DB into a Node Buffer.
      const bytes = withSeed ? await fsp.readFile(info.path) : null;
      const backupId = `database-backup:${file}`;
      const schemaId = `database-schema:${file}`;
      const entry = {
        file,
        mode: withSeed ? 'backup' : 'schema',
        restore: withSeed ? 'sqlite-create-missing' : 'record-only',
        artifactId: withSeed ? backupId : schemaId,
        schemaFingerprint: info.schemaFingerprint,
        tables: info.tables,
        totalRows: info.totalRows,
        integrity: info.integrity,
        rowContentsCompared: false,
      };
      artifactInputs.push({
        id: schemaId,
        layer: 'database',
        kind: 'sqlite-schema',
        privacy: 'private',
        required: true,
        restore: 'record-only',
        target: file,
        path: `${file}.schema.sql`,
        content: Buffer.from(info.schemaText, 'utf8'),
      });
      if (withSeed) {
        artifactInputs.push({
          id: backupId,
          layer: 'database',
          kind: 'sqlite-backup',
          privacy: 'private',
          required: true,
          restore: 'sqlite-create-missing',
          target: file,
          path: `${file}.sqlite`,
          content: bytes,
        });
      }
      databases.push(entry);
    }
    // Do not publish a partial database layer if any discovered DB fails.
    ctx.files.push(...artifactInputs);
    return U.ok({
      databases,
      engine: 'sqlite3 online backup API',
      withSeed: !!ctx.withSeed,
      comparison: 'schema and row counts recorded; row contents not compared',
    });
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (!ctx.operationId && !ctx.lock?.operationId) {
      await fsp.rm(path.dirname(path.dirname(staging)), { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = {
  SQLITE_EXTS,
  DB_FILE_RE,
  SIDECARS,
  assertDatabaseName,
  discoverSqliteFiles,
  runSqlite,
  createConsistentBackup,
  inspectBackup,
  collectSqliteFiles,
  errorLine,
};
