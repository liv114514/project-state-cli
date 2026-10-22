'use strict';
// Layer collectors. Each collector returns:
//   { status:'collected', data, files } | { status:'skipped', reason }
// A failing layer is NEVER fatal: it degrades to skipped with a reason, so a
// partial archive is always better than no archive.

const fsp = require('fs').promises;
const path = require('path');
const U = require('./utils');
const DB = require('./database');

// ---- helpers ----------------------------------------------------------

// Parse .env content into { KEY: { nonEmpty: bool } }. Values are NEVER kept.
function parseEnv(content) {
  const keys = {};
  for (const raw of String(content).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;
    const val = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    keys[key] = { nonEmpty: val.length > 0 };
  }
  return keys;
}

// On Windows npm/python may be .cmd shims; those need a shell to spawn.
// All arguments passed here are hardcoded constants, so shell:true has no
// injection surface.

// ---- git layer ---------------------------------------------------------

async function collectGit(ctx) {
  const inside = await U.runTrusted('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ctx.root });
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return U.skip('Not a git repository (git rev-parse failed or ran outside a work tree)');
  }
  const head = await U.runTrusted('git', ['rev-parse', 'HEAD'], { cwd: ctx.root });
  if (!head.ok) {
    const why = (head.stderr || head.message || 'unknown git error').trim().split('\n')[0];
    return U.skip(`git rev-parse HEAD failed: ${why}`);
  }
  const branch = await U.runTrusted('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.root });
  const st = await U.runTrusted('git', ['status', '--porcelain'], { cwd: ctx.root });
  if (!branch.ok || !st.ok) return U.skip('Git branch/status probe failed; clean working state cannot be established');
  const dirtyLines = st.stdout.split('\n').filter(Boolean);
  const branchName = branch.stdout.trim();
  return U.ok({
    commit: head.stdout.trim(),
    branch: branchName === 'HEAD' ? null : branchName,
    detached: branchName === 'HEAD',
    dirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    statusSample: dirtyLines.slice(0, 50),
  });
}

function summarizeGit(d) {
  const at = d.detached ? 'detached' : d.branch;
  return `${at} @ ${d.commit.slice(0, 7)} (${d.dirty ? d.dirtyCount + ' uncommitted changes' : 'clean'})`;
}

// ---- deps layer --------------------------------------------------------

const LOCK_CANDIDATES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];

async function collectDeps(ctx) {
  let pkg = null;
  try {
    pkg = JSON.parse(await fsp.readFile(path.join(ctx.root, 'package.json'), 'utf8'));
  } catch {
    return U.skip('No readable package.json in project root (npm project not detected)');
  }

  let lockFile = null;
  let lockFingerprint = null;
  let note = null;
  // Archive the package manifest as well as its fingerprinted lockfile so
  // the dependency summary can be interpreted against its declared inputs.
  ctx.files.push({ srcPath: path.join(ctx.root, 'package.json'), destName: 'package.json', layer: 'deps', target: 'package.json' });
  for (const f of LOCK_CANDIDATES) {
    try {
      const lockPath = path.join(ctx.root, f);
      // SECURITY: never follow links - a lockfile symlink could pull outside
      // content into the (shareable) snapshot.
      if ((await fsp.lstat(lockPath)).isSymbolicLink()) {
        note = `${f} is a symlink - skipped (security)`;
        continue;
      }
      const buf = await fsp.readFile(path.join(ctx.root, f));
      lockFile = f;
      lockFingerprint = U.sha256(buf).slice(0, 12);
      ctx.files.push({ srcPath: lockPath, destName: f });
      break;
    } catch {
      /* candidate not present */
    }
  }

  // Resolved versions of direct dependencies: only npm lockfile v2/v3 is parsed.
  // yarn.lock / pnpm-lock.yaml formats are deliberately NOT hand-parsed in v1
  // (full-file fingerprint is still recorded and the file itself is archived).
  let resolved = null;
  if (lockFile === 'package-lock.json') {
    try {
      const lock = JSON.parse(await fsp.readFile(path.join(ctx.root, 'package-lock.json'), 'utf8'));
      const rootEntry = lock.packages && lock.packages[''];
      if (rootEntry) {
        const declared = { ...(rootEntry.dependencies || {}), ...(rootEntry.devDependencies || {}) };
        resolved = {};
        for (const name of Object.keys(declared)) {
          const entry = lock.packages['node_modules/' + name];
          resolved[name] = entry && entry.version ? entry.version : 'missing-in-lock';
        }
      } else {
        note = 'package-lock.json has no root packages entry; fingerprint only';
      }
    } catch {
      note = 'package-lock.json parse failed; fingerprint only';
    }
  } else if (lockFile) {
    note = `${lockFile} stored as full-file fingerprint only (no version diff in v1)`;
  } else {
    note = note || 'No lockfile found; nothing to pin';
  }

  return U.ok({
    packageJson: { name: pkg.name || null, version: pkg.version || null },
    lockFile,
    lockFingerprint,
    resolved,
    note,
  });
}

function summarizeDeps(d) {
  if (!d.lockFile) return d.note;
  return `${d.lockFile} (fingerprint ${d.lockFingerprint})`;
}

// ---- runtime layer ------------------------------------------------------

async function collectRuntime(ctx) {
  const data = { node: process.version, npm: null, python: null, versionPins: [] };
  const files = [];

  const npm = await U.runTrusted('npm', ['--version'], { cwd: ctx.root, timeout: 15000 });
  if (npm.ok) data.npm = npm.stdout.trim();

  for (const py of ['python', 'python3']) {
    const r = await U.runTrusted(py, ['--version'], { cwd: ctx.root, timeout: 10000 });
    if (r.ok) {
      data.python = (r.stdout || r.stderr).trim();
      break;
    }
  }

  for (const f of ['.nvmrc', '.node-version']) {
    try {
      const content = (await fsp.readFile(path.join(ctx.root, f), 'utf8')).trim();
      data.versionPins.push({ name: f, content });
      files.push({ srcPath: path.join(ctx.root, f), destName: f });
    } catch {
      /* pin file not present */
    }
  }
  return U.ok(data, files);
}

function summarizeRuntime(d) {
  const parts = [`node ${d.node}`];
  if (d.npm) parts.push(`npm ${d.npm}`);
  if (d.python) parts.push(d.python);
  // A pin file may contain arbitrary text. The file is stored privately for
  // restoration; snapshot output only needs to say which pin was captured.
  for (const v of d.versionPins) parts.push(`${v.name} (recorded; value withheld)`);
  return parts.join(' / ');
}

// ---- config layer --------------------------------------------------------

const ENV_FILE_CANDIDATES = ['.env', '.env.local'];

async function collectConfig(ctx) {
  const envFiles = {};
  const files = [];
  for (const f of ENV_FILE_CANDIDATES) {
    try {
      const content = await fsp.readFile(path.join(ctx.root, f), 'utf8');
      const keys = parseEnv(content);
      envFiles[f] = { keyCount: Object.keys(keys).length, keys };
      // The real file goes to the secrets store, never into snapshots/.
      files.push({ srcPath: path.join(ctx.root, f), destName: f, secret: true });
    } catch {
      /* env file not present */
    }
  }
  if (Object.keys(envFiles).length === 0) {
    return U.skip('No .env / .env.local found in project root');
  }
  return U.ok({ envFiles }, files);
}

function summarizeConfig(d) {
  return Object.entries(d.envFiles)
    .map(([f, e]) => `${f}: ${e.keyCount} keys (values kept in secrets store)`)
    .join('; ');
}

// ---- docker layer --------------------------------------------------------

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

async function collectDocker(ctx) {
  const hasCompose = COMPOSE_FILES.some((f) => U.existsSync(path.join(ctx.root, f)));
  if (!hasCompose) {
    return U.skip('No docker-compose file found in project root');
  }
  const r = await U.runTrusted('docker', ['compose', 'ps', '--format', 'json'], { cwd: ctx.root, timeout: 20000 });
  if (!r.ok) {
    const why = (r.stderr || r.message || 'docker not available').trim().split('\n')[0];
    return U.skip(`docker compose ps failed: ${why}`);
  }
  // compose v2 prints JSON lines; unparsable lines are treated as data noise.
  const services = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      services.push({ name: o.Name || o.Service || '?', state: o.State || o.Status || '?' });
    } catch {
      /* ignore malformed line */
    }
  }
  return U.ok({ services });
}

function summarizeDocker(d) {
  return d.services.length === 0
    ? 'compose detected, 0 running services reported'
    : d.services.map((s) => `${s.name}=${s.state}`).join(', ');
}

// ---- database layer -------------------------------------------------------

const DB_URL_KEY_HINTS = ['DATABASE_URL', 'POSTGRES_URL', 'MYSQL_URL', 'MONGODB_URI', 'REDIS_URL'];

async function collectDatabase(ctx) {
  let files;
  const requestedSeedFailure = (reason, diagnosticCode) => {
    const error = new Error(reason);
    error.code = 'EDATABASE_SEED_REQUIRED';
    if (diagnosticCode) error.diagnosticCode = diagnosticCode;
    return error;
  };
  try { files = await DB.discoverSqliteFiles(ctx.root); }
  catch {
    if (ctx.withSeed) throw requestedSeedFailure('SQLite row data was requested but database discovery failed');
    return U.skip('SQLite database discovery failed; database layer omitted (details withheld)');
  }
  if (files.length === 0) {
    const config = ctx.results.config;
    const hints = [];
    if (config && config.envFiles) for (const envFile of Object.values(config.envFiles)) {
      for (const key of DB_URL_KEY_HINTS) if (envFile.keys[key]?.nonEmpty) hints.push(`${key} (in .env)`);
    }
    if (U.existsSync(path.join(ctx.root, 'prisma', 'schema.prisma'))) hints.push('prisma/schema.prisma');
    if (hints.length && ctx.withSeed) throw requestedSeedFailure('SQLite row data was requested but only unsupported database configurations were detected');
    if (ctx.withSeed) throw requestedSeedFailure('SQLite row data was requested but no local SQLite database was detected');
    return hints.length
      ? U.skip(`Only unsupported server database configuration hinted (${hints.join(', ')}); local SQLite data was not collected`)
      : U.skip('No local SQLite database detected');
  }
  let cli;
  try { cli = U.resolveTrustedBinary('sqlite3', ctx.root); }
  catch {
    if (ctx.withSeed) throw requestedSeedFailure('SQLite row data was requested but sqlite3 CLI detection failed');
    return U.skip('sqlite3 CLI detection failed; database layer omitted (details withheld)');
  }
  if (!cli) {
    if (ctx.withSeed) throw requestedSeedFailure('SQLite row data was requested but the trusted sqlite3 CLI is unavailable');
    return U.skip(`sqlite3 CLI not found; ${files.length} SQLite file(s) were not collected`);
  }
  if (cli.isScript) {
    if (ctx.withSeed) throw requestedSeedFailure('SQLite row data was requested but sqlite3 command shims are unsupported');
    return U.skip('sqlite3 command shim is unsupported; SQLite files were not collected');
  }
  try { return await DB.collectSqliteFiles(ctx, files); }
  catch (error) {
    if (ctx.withSeed && error.code === 'ESQLITE_PATH_LIMIT') {
      throw requestedSeedFailure('SQLite seed could not be captured because this Windows project path exceeds the SQLite staging journal limit. Retry only with a verified disposable copy under a shorter local path.', error.code);
    }
    if (ctx.withSeed) throw requestedSeedFailure('SQLite row data was requested but consistent database capture failed');
    if (error.code === 'ESQLITE_PATH_LIMIT') {
      return U.skip('Windows SQLite staging journal path limit reached; database metadata and row data were not collected. Retry only from a verified disposable copy under a shorter local path.');
    }
    if (error.code === 'EDATABASE_STAGING') return U.skip('private SQLite staging unavailable; database layer omitted (details withheld)');
    return U.skip('consistent SQLite snapshot failed; database layer omitted (details withheld)');
  }
}
function summarizeDatabase(d) {
  return d.databases
    .map((e) => `${e.file} (${e.mode}${e.totalRows ? ', ' + e.totalRows + ' rows' : ''})`)
    .join(', ');
}

// ---- registry --------------------------------------------------------------

const COLLECTORS = [
  { id: 'git', fn: collectGit, summarize: summarizeGit },
  { id: 'deps', fn: collectDeps, summarize: summarizeDeps },
  { id: 'runtime', fn: collectRuntime, summarize: summarizeRuntime },
  { id: 'config', fn: collectConfig, summarize: summarizeConfig },
  { id: 'docker', fn: collectDocker, summarize: summarizeDocker },
  { id: 'database', fn: collectDatabase, summarize: summarizeDatabase },
];

module.exports = {
  COLLECTORS,
  parseEnv,
  collectGit,
  collectDeps,
  collectRuntime,
  collectConfig,
  collectDatabase,
  discoverSqliteFiles: DB.discoverSqliteFiles,
};
