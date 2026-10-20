'use strict';
// Shared test helpers. Loaded by node --test but defines no tests; everything
// is exported for the real test files to require.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn, spawnSync } = require('child_process');

const TRANSIENT_TEMP_REMOVE_ERRORS = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES']);

async function removeTemporaryTree(root, remove = fs.promises.rm.bind(fs.promises)) {
  let lastTransientError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await remove(root, { recursive: true, force: true });
    } catch (error) {
      if (!TRANSIENT_TEMP_REMOVE_ERRORS.has(error.code)) throw error;
      lastTransientError = error;
    }

    try {
      await fs.promises.lstat(root);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    if (attempt === 5) {
      if (lastTransientError) throw lastTransientError;
      throw new Error(`temporary project directory remains after cleanup: ${root}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15 * (2 ** attempt)));
  }
}

// Acceptance may point this helper at the exact installed package entrypoint.
// The default remains the source tree for ordinary repository tests.
const CLI = path.resolve(process.env.PROJECT_STATE_CLI || path.join(__dirname, '..', 'bin', 'project-state.js'));
// Database acceptance requires the real sqlite3 CLI installed by the local
// environment or CI. Do not infer availability from an old fixture path.
const SQLITE = 'sqlite3';
function sqliteBinary() { return SQLITE; }
let HAS_SQLITE = false;
try {
  require('child_process').execFileSync(SQLITE, ['--version'], { stdio: 'ignore' });
  HAS_SQLITE = true;
} catch {
  /* no real sqlite3 CLI available - database integration tests will skip */
}
const REQUIRE_SQLITE_TESTS = process.env.REQUIRE_SQLITE_TESTS === '1';

const GITENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

// Async git helper (spawnSync is unavailable in some sandboxed environments).
function git(proj, args, env = process.env) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: proj, encoding: 'utf8', env: { ...env, ...GITENV }, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.join(' ')} failed: ${(stderr || err.message || '').trim()}`));
        else resolve(stdout);
      }
    );
  });
}

// Run the CLI as a child process; resolves { status, stdout, stderr }.
// `input` (optional) is written to stdin before the stream closes - used by
// interactive-confirmation tests.
function cli(proj, args, env = process.env, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd: proj, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', () => resolve({ status: -1, stdout, stderr }));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
    if (input !== undefined) p.stdin.write(input);
    p.stdin.end();
  });
}

function runPrintedRollback(stdout, cwd, env = process.env) {
  const label = process.platform === 'win32' ? 'Exact rollback command (PowerShell): ' : 'Exact rollback command: ';
  const line = String(stdout).split(/\r?\n/).find((entry) => entry.startsWith(label));
  if (!line) throw new Error(`restore output did not contain rollback label ${JSON.stringify(label)}`);
  const command = line.slice(label.length);
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, encoding: 'utf8', timeout: 30000, env, windowsHide: true })
    : spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', timeout: 30000, env });
  return { ...result, command, label };
}

// Init a git repo with app.js (+ optional extra files) and one commit.
async function setupGit(proj, files = {}) {
  fs.writeFileSync(path.join(proj, 'app.js'), 'x();\n', 'utf8');
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(proj, name), content, 'utf8');
  }
  await git(proj, ['init']);
  await git(proj, ['add', '-A']);
  await git(proj, ['commit', '-m', 'init']);
}

// Keep local secret files available to collectors without staging them into
// Git. This models the documented private-input workflow across later `git add -A` calls.
function excludeLocalFiles(proj, names) {
  const target = path.join(proj, '.git', 'info', 'exclude');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const missing = names.filter((name) => !existing.split(/\r?\n/).includes(name));
  if (missing.length) fs.appendFileSync(target, `${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}${missing.join('\n')}\n`, 'utf8');
}

// ---- sqlite helpers (require the real sqlite3 executable on PATH) -----------

function envWithSqlite() {
  return { ...process.env, ...GITENV };
}

// Run a SQL statement on a project-local sqlite database.
function sql(proj, db, query) {
  return new Promise((resolve, reject) => {
    const databasePath = path.isAbsolute(db) ? db : path.join(proj, db);
    execFile(sqliteBinary(), [databasePath, query], { encoding: 'utf8', cwd: proj }, (e, so, se) =>
      e ? reject(new Error(se)) : resolve(so.trim())
    );
  });
}

// Create the standard two-table demo database.
function makeDb(proj) {
  return sql(proj, 'app.db', "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('a'),('b'),('c');");
}

// Hand-write a minimal (possibly hostile) snapshot directory.
function writeSnapshot(proj, name, manifest, extraFiles = {}) {
  const snap = path.join(proj, '.project-state', 'snapshots', name);
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(path.join(snap, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  for (const [rel, content] of Object.entries(extraFiles)) {
    const p = path.join(snap, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return snap;
}

// Create a complete, integrity-valid v2 test generation. Use this for list,
// compare, and prune fixtures so those tests do not accidentally treat a
// legacy directory tree or undeclared payload as a healthy snapshot.
function writeSnapshotGeneration(root, name, { kind, createdAt = new Date().toISOString(), layerData = {}, privateFiles = [] } = {}) {
  const generation = crypto.randomBytes(16).toString('hex');
  const layers = {};
  const publicArtifacts = [];
  const privateArtifacts = [];
  const publicFiles = new Map();
  const secretFiles = new Map();
  const host = { platform: process.platform, arch: process.arch, node: process.version };
  const resolvedKind = kind || (name.startsWith('auto-') ? 'auto' : name.startsWith('hook-') ? 'hook' : 'named');

  for (const layer of ['git', 'deps', 'runtime', 'config', 'docker', 'database']) {
    if (!Object.prototype.hasOwnProperty.call(layerData, layer)) {
      layers[layer] = { status: 'skipped', reason: `fixture: ${layer} not collected` };
      continue;
    }
    layers[layer] = { status: 'collected', file: `${layer}.json` };
    const bytes = Buffer.from(JSON.stringify(layerData[layer]));
    const privacy = layer === 'database' ? 'private' : 'public';
    const artifacts = privacy === 'private' ? privateArtifacts : publicArtifacts;
    const files = privacy === 'private' ? secretFiles : publicFiles;
    files.set(`${layer}.json`, bytes);
    artifacts.push({
      id: `layer:${layer}`, layer, kind: 'layer-json', privacy, required: true,
      path: `${layer}.json`, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
      restore: 'record-only',
    });
  }

  for (const item of privateFiles) {
    const bytes = Buffer.isBuffer(item.content) ? item.content : Buffer.from(String(item.content));
    secretFiles.set(item.path, bytes);
    privateArtifacts.push({
      id: item.id, layer: item.layer, kind: item.kind || 'file', privacy: 'private', required: item.required !== false,
      path: item.path, target: item.target, restore: item.restore || 'restore-file',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
    });
  }

  const common = { schemaVersion: 2, state: 'complete', generation, kind: resolvedKind, name, createdAt, toolVersion: require('../package.json').version, host, layers };
  const publicManifest = { ...common, artifacts: publicArtifacts };
  const privateManifest = { ...common, artifacts: privateArtifacts };
  const publicBytes = Buffer.from(JSON.stringify(publicManifest));
  const snapDir = path.join(root, '.project-state', 'snapshots', name);
  const privateDir = path.join(root, '.project-state', 'secrets', name);
  const publicGeneration = path.join(snapDir, 'generations', generation);
  const privateGeneration = path.join(privateDir, 'generations', generation);
  fs.mkdirSync(publicGeneration, { recursive: true });
  fs.mkdirSync(privateGeneration, { recursive: true });
  if (publicFiles.size) fs.mkdirSync(path.join(publicGeneration, 'files'), { recursive: true });
  if (secretFiles.size) fs.mkdirSync(path.join(privateGeneration, 'files'), { recursive: true });
  fs.writeFileSync(path.join(publicGeneration, 'manifest.json'), publicBytes);
  fs.writeFileSync(path.join(privateGeneration, 'manifest.json'), JSON.stringify(privateManifest));
  for (const [relative, bytes] of publicFiles) {
    const target = path.join(publicGeneration, 'files', ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  for (const [relative, bytes] of secretFiles) {
    const target = path.join(privateGeneration, 'files', ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(path.join(snapDir, 'current.json'), JSON.stringify({
    schemaVersion: 1, name, generation,
    publicManifestSha256: crypto.createHash('sha256').update(publicBytes).digest('hex'),
  }));
  return { generation, publicManifest, privateManifest };
}

// Bind the helpers to one project directory. Accepts a value or a getter
// (for tests whose project dir is created inside each test case):
//   const { git, cli } = bindRunner(proj)        // fixed dir
//   const { git, cli } = bindRunner(() => proj)  // lazily resolved
// Second arg of cli(): an env object, or { input } for interactive tests.
function bindRunner(projOrGetter) {
  const p = () => (typeof projOrGetter === 'function' ? projOrGetter() : projOrGetter);
  return {
    git: (args, env) => git(p(), args, env),
    cli: (args, opts = {}) => {
      if (opts && opts.input !== undefined) return cli(p(), args, process.env, opts.input);
      // An empty opts object must NOT become an empty child env (that would
      // blank out PATH and make every tool probe fail on Linux/macOS).
      return cli(p(), args, opts && Object.keys(opts).length ? opts : process.env);
    },
    setupGit: (files) => setupGit(p(), files),
    sql: (db, query) => sql(p(), db, query),
    makeDb: () => makeDb(p()),
  };
}

module.exports = {
  CLI,
  SQLITE,
  HAS_SQLITE,
  REQUIRE_SQLITE_TESTS,
  GITENV,
  git,
  cli,
  runPrintedRollback,
  setupGit,
  excludeLocalFiles,
  envWithSqlite,
  sql,
  makeDb,
  writeSnapshot,
  writeSnapshotGeneration,
  sqliteBinary,
  bindRunner,
  removeTemporaryTree,
};
