'use strict';

// Storage boundary for project-state schema v2. Hashes detect changed bytes;
// they do not authenticate the source of a snapshot.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const STATE_DIR = '.project-state';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_RE = /^[a-f0-9]{32}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const LAYERS = new Set(['git', 'deps', 'runtime', 'config', 'docker', 'database', 'rollback']);
const SNAPSHOT_LAYERS = new Set(['git', 'deps', 'runtime', 'config', 'docker', 'database']);
const KINDS = new Set(['named', 'auto', 'hook']);
const RESTORE = new Set(['record-only', 'restore-file', 'sqlite-create-missing']);
const ARTIFACT_KINDS = new Set(['layer-json', 'file', 'absent', 'sqlite-schema', 'sqlite-dump', 'sqlite-backup']);
const RESERVED = new Set(['.git', '.project-state', '.hg', '.svn', '.codex', '.agents', '.workbuddy']);
const FILE_TARGETS = {
  config: new Set(['.env', '.env.local']),
  runtime: new Set(['.nvmrc', '.node-version']),
  deps: new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']),
};

const locks = new Map();
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const randomId = () => crypto.randomBytes(16).toString('hex');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function coded(code, message) { const error = new Error(message); error.code = code; return error; }

function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw coded('EUNSAFE_PATH', 'invalid snapshot name');
  return name;
}
function assertId(id, what = 'id') {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw coded('EMANIFEST_INVALID', `invalid ${what}`);
  return id;
}
function snapshotPaths(root, name, generation) {
  assertName(name);
  const rootAbs = path.resolve(root);
  const snapDir = path.join(rootAbs, STATE_DIR, 'snapshots', name);
  const secretsDir = path.join(rootAbs, STATE_DIR, 'secrets', name);
  let gen = generation;
  if (!gen) {
    try {
      const pointer = JSON.parse(fs.readFileSync(path.join(snapDir, 'current.json'), 'utf8'));
      if (pointer && ID_RE.test(pointer.generation || '')) gen = pointer.generation;
    } catch { /* no current v2 pointer; caller may be diagnosing v1 */ }
  }
  const publicGenerationDir = gen ? path.join(snapDir, 'generations', gen) : null;
  const privateGenerationDir = gen ? path.join(secretsDir, 'generations', gen) : null;
  return {
    snapDir,
    currentFile: path.join(snapDir, 'current.json'),
    publicGenerationDir,
    privateGenerationDir,
    manifestFile: publicGenerationDir ? path.join(publicGenerationDir, 'manifest.json') : path.join(snapDir, 'manifest.json'),
    privateManifestFile: privateGenerationDir ? path.join(privateGenerationDir, 'manifest.json') : null,
    filesDir: publicGenerationDir ? path.join(publicGenerationDir, 'files') : path.join(snapDir, 'files'),
    secretsDir: privateGenerationDir || secretsDir,
    legacySecretsDir: secretsDir,
    generation: gen || null,
  };
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || /[\x00-\x1f\x7f:]/.test(value)) return false;
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /[<>"|?*]/.test(part))) return false;
  if (parts.some((part) => RESERVED.has(part.toLowerCase()))) return false;
  if (parts.some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return false;
  return true;
}
function assertSafeRelative(value) {
  if (!safeRelative(value)) throw coded('EUNSAFE_PATH', `unsafe or reserved relative path: ${String(value)}`);
  return value;
}

function assertTarget(layer, target) {
  assertSafeRelative(target);
  const basename = path.posix.basename(target);
  if (layer === 'rollback') {
    const ordinary = Object.values(FILE_TARGETS).some((set) => set.has(target));
    const db = !target.includes('/') && /\.(?:db|sqlite|sqlite3)$/i.test(target);
    if (!ordinary && !db) throw coded('EUNSAFE_PATH', `unsupported rollback target: ${target}`);
  } else if (layer === 'database') {
    if (target.includes('/') || !/^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))[^.].*\.(?:db|sqlite|sqlite3)$/i.test(basename)) {
      throw coded('EUNSAFE_PATH', `unsupported SQLite target: ${target}`);
    }
  } else if (!FILE_TARGETS[layer] || target.includes('/') || !FILE_TARGETS[layer].has(target)) {
    throw coded('EUNSAFE_PATH', `unsupported ${layer} target: ${target}`);
  }
  return target;
}
async function validateRestoreTarget(root, target, layer = 'rollback') {
  assertTarget(layer, target);
  const rootAbs = path.resolve(root);
  const absolutePath = path.resolve(rootAbs, ...target.split('/'));
  const relative = path.relative(rootAbs, absolutePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw coded('EUNSAFE_PATH', 'restore target escapes project root');
  await assertNoLinks(absolutePath, { hardlinks: true });
  return absolutePath;
}

// lstat every component from the volume root. This detects ordinary symlinks
// and Windows junctions reported as reparse points by Node. A same-user process
// can still replace a component after this check; this is not a race-proof OS
// handle walk and does not protect against an administrator.
async function assertNoLinks(absolute, { allowMissing = true, hardlinks = false } = {}) {
  const resolved = path.resolve(absolute);
  const volume = path.parse(resolved).root;
  const parts = path.relative(volume, resolved).split(path.sep).filter(Boolean);
  let current = volume;
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i]);
    let st;
    try { st = await fsp.lstat(current); }
    catch (error) {
      if (error.code === 'ENOENT' && allowMissing) return;
      throw error;
    }
    if (st.isSymbolicLink()) throw coded('EUNSAFE_PATH', `symlink/reparse point in path: ${current}`);
    if (i < parts.length - 1 && !st.isDirectory()) throw coded('EUNSAFE_PATH', `path ancestor is not a directory: ${current}`);
    if (hardlinks && st.isFile() && st.nlink > 1) throw coded('EUNSAFE_PATH', `hardlinked file is unsupported: ${current}`);
  }
}

async function assertRealProject(root, { createState = false } = {}) {
  const rootAbs = path.resolve(root);
  await assertNoLinks(rootAbs, { allowMissing: false });
  const rootStat = await fsp.lstat(rootAbs);
  if (!rootStat.isDirectory()) throw coded('EUNSAFE_PATH', 'project root must be a real directory');
  const state = path.join(rootAbs, STATE_DIR);
  try {
    await assertNoLinks(state, { allowMissing: true });
    const st = await fsp.lstat(state);
    if (!st.isDirectory()) throw coded('EUNSAFE_PATH', '.project-state must be a real directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (createState) await fsp.mkdir(state);
  }
  return { root: rootAbs, state };
}

async function ensureRealDirectory(root, target) {
  const rootAbs = path.resolve(root); const targetAbs = path.resolve(target);
  const relative = path.relative(rootAbs, targetAbs);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw coded('EUNSAFE_PATH', 'storage directory escapes .project-state');
  await assertNoLinks(rootAbs, { allowMissing: false });
  let current = rootAbs;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    try {
      const st = await fsp.lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) throw coded('EUNSAFE_PATH', `unsafe storage component: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fsp.mkdir(current);
    }
  }
}

function artifactKindValid(a, manifestKind) {
  if (a.kind === 'layer-json') return SNAPSHOT_LAYERS.has(a.layer) && a.path === `${a.layer}.json` && a.restore === 'record-only';
  if (a.kind === 'absent') return manifestKind === 'auto' && a.layer === 'rollback' && a.privacy === 'private' && a.restore === 'record-only';
  if (a.kind === 'file') return ['runtime', 'deps', 'config', 'rollback'].includes(a.layer) && a.privacy === 'private' && a.restore === 'restore-file';
  if (['sqlite-schema', 'sqlite-dump'].includes(a.kind)) return a.layer === 'database' && a.privacy === 'private' && a.restore === 'record-only';
  if (a.kind === 'sqlite-backup') return a.layer === 'database' && a.privacy === 'private' && a.restore === 'sqlite-create-missing';
  return false;
}

function validateLayer(layer, data) {
  if (!object(data)) throw coded('EMANIFEST_INVALID', `invalid ${layer} layer JSON`);
  const exact = (value, required, optional = []) => object(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  const nullableString = (value) => value === null || typeof value === 'string';
  if (layer === 'git') {
    if (!exact(data, ['commit', 'branch', 'detached', 'dirty', 'dirtyCount', 'statusSample']) || !/^[a-f0-9]{40,64}$/.test(data.commit) || !nullableString(data.branch) || typeof data.detached !== 'boolean' || typeof data.dirty !== 'boolean' || !Number.isSafeInteger(data.dirtyCount) || data.dirtyCount < 0 || !Array.isArray(data.statusSample) || data.statusSample.length > 50 || data.statusSample.some((s) => typeof s !== 'string') || data.dirty !== (data.dirtyCount > 0) || data.dirtyCount < data.statusSample.length || data.detached !== (data.branch === null)) throw coded('EMANIFEST_INVALID', 'invalid git layer fields');
  }
  if (layer === 'deps') {
    if (!exact(data, ['packageJson', 'lockFile', 'lockFingerprint', 'resolved', 'note']) || !exact(data.packageJson, ['name', 'version']) || !nullableString(data.packageJson.name) || !nullableString(data.packageJson.version) || !(data.lockFile === null || FILE_TARGETS.deps.has(data.lockFile)) || !nullableString(data.lockFingerprint) || (data.lockFingerprint !== null && !/^[a-f0-9]{12}$/.test(data.lockFingerprint)) || !(data.resolved === null || object(data.resolved)) || (data.resolved && Object.values(data.resolved).some((v) => typeof v !== 'string')) || !nullableString(data.note) || (data.lockFile === null) !== (data.lockFingerprint === null)) throw coded('EMANIFEST_INVALID', 'invalid deps layer fields');
  }
  if (layer === 'runtime' && (!exact(data, ['node', 'npm', 'python', 'versionPins']) || typeof data.node !== 'string' || !nullableString(data.npm) || !nullableString(data.python) || !Array.isArray(data.versionPins) || data.versionPins.some((p) => !exact(p, ['name']) || !FILE_TARGETS.runtime.has(p.name)) || new Set(data.versionPins.map((p) => p.name)).size !== data.versionPins.length)) throw coded('EMANIFEST_INVALID', 'invalid runtime layer fields');
  if (layer === 'config') {
    if (!exact(data, ['envFiles']) || !object(data.envFiles)) throw coded('EMANIFEST_INVALID', 'invalid config layer fields');
    for (const [name, item] of Object.entries(data.envFiles)) {
      if (!FILE_TARGETS.config.has(name) || !exact(item, ['keyCount', 'keys']) || !object(item.keys) || !Number.isSafeInteger(item.keyCount) || item.keyCount !== Object.keys(item.keys).length) throw coded('EMANIFEST_INVALID', 'invalid config entry');
      if (Object.entries(item.keys).some(([key, val]) => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key) || !exact(val, ['nonEmpty']) || typeof val.nonEmpty !== 'boolean')) throw coded('EMANIFEST_INVALID', 'invalid config key metadata');
    }
  }
  if (layer === 'docker' && (!exact(data, ['services']) || !Array.isArray(data.services) || data.services.some((s) => !exact(s, ['name', 'state']) || typeof s.name !== 'string' || typeof s.state !== 'string'))) throw coded('EMANIFEST_INVALID', 'invalid docker layer fields');
  if (layer === 'database') {
    if (!exact(data, ['databases', 'engine', 'withSeed', 'comparison']) || !Array.isArray(data.databases) || data.engine !== 'sqlite3 online backup API' || typeof data.withSeed !== 'boolean' || data.comparison !== 'schema and row counts recorded; row contents not compared') throw coded('EMANIFEST_INVALID', 'invalid database layer fields');
    const seen = new Set();
    for (const db of data.databases) {
      if (!exact(db, ['file', 'mode', 'restore', 'artifactId', 'schemaFingerprint', 'tables', 'totalRows', 'integrity', 'rowContentsCompared']) || typeof db.file !== 'string' || typeof db.restore !== 'string' || typeof db.artifactId !== 'string' || !/^[a-f0-9]{64}$/.test(db.schemaFingerprint || '') || !Array.isArray(db.tables) || db.tables.some((t) => typeof t !== 'string') || !Number.isSafeInteger(db.totalRows) || db.totalRows < 0 || db.integrity !== 'ok' || db.rowContentsCompared !== false) throw coded('EMANIFEST_INVALID', 'invalid database entry');
      assertTarget('database', db.file);
      const backup = db.mode === 'backup' && db.restore === 'sqlite-create-missing' && db.artifactId === `database-backup:${db.file}` && data.withSeed;
      const schema = db.mode === 'schema' && db.restore === 'record-only' && db.artifactId === `database-schema:${db.file}` && !data.withSeed;
      if (seen.has(db.file.toLowerCase()) || !(backup || schema)) throw coded('EMANIFEST_INVALID', 'duplicate or unsupported database entry');
      seen.add(db.file.toLowerCase());
    }
  }
}

function validateManifestShape(m, { name, generation, privacy } = {}) {
  if (!object(m)) throw coded('EMANIFEST_INVALID', 'manifest must be a JSON object');
  if (m.schemaVersion === 1) throw coded('ELEGACY_RESTORE', 'legacy v1 snapshots are diagnostic-only; collect a v2 snapshot before restore');
  if (m.schemaVersion !== 2) throw coded('ESCHEMA_UNSUPPORTED', `unsupported snapshot schemaVersion ${m.schemaVersion}`);
  const manifestKeys = new Set(['schemaVersion', 'state', 'generation', 'kind', 'name', 'createdAt', 'toolVersion', 'host', 'layers', 'artifacts']);
  if (Object.keys(m).some((key) => !manifestKeys.has(key))) throw coded('EMANIFEST_INVALID', 'manifest contains an unsupported field');
  if (m.state !== 'complete' || !ID_RE.test(m.generation || '') || !KINDS.has(m.kind) || !NAME_RE.test(m.name || '') || (name && m.name !== name) || (generation && m.generation !== generation)) throw coded('EMANIFEST_INVALID', 'manifest identity or completion state is invalid');
  if (typeof m.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(m.createdAt) || !Number.isFinite(Date.parse(m.createdAt))) throw coded('EMANIFEST_INVALID', 'createdAt must be a valid UTC ISO timestamp');
  if (typeof m.toolVersion !== 'string' || !object(m.host) || Object.keys(m.host).some((key) => !['platform', 'arch', 'node'].includes(key)) || typeof m.host.platform !== 'string' || typeof m.host.arch !== 'string' || typeof m.host.node !== 'string') throw coded('EMANIFEST_INVALID', 'manifest host/toolVersion is invalid');
  if (!object(m.layers) || !Array.isArray(m.artifacts)) throw coded('EMANIFEST_INVALID', 'manifest layers/artifacts are invalid');
  for (const [id, layer] of Object.entries(m.layers)) {
    if (!SNAPSHOT_LAYERS.has(id) || !object(layer) || !['collected', 'skipped'].includes(layer.status)) throw coded('EMANIFEST_INVALID', `invalid layer status: ${id}`);
    const layerKeys = layer.status === 'collected' ? ['status', 'file'] : ['status', 'reason'];
    if (Object.keys(layer).some((key) => !layerKeys.includes(key))) throw coded('EMANIFEST_INVALID', `layer ${id} contains an unsupported field`);
    if (layer.status === 'collected' && layer.file !== `${id}.json`) throw coded('EMANIFEST_INVALID', `collected layer ${id} must declare ${id}.json`);
    if (layer.status === 'skipped' && typeof layer.reason !== 'string') throw coded('EMANIFEST_INVALID', `skipped layer ${id} needs a reason`);
  }
  const ids = new Set(); const locations = new Set();
  for (const a of m.artifacts) {
    if (!object(a) || typeof a.id !== 'string' || !a.id || ids.has(a.id)) throw coded('EMANIFEST_INVALID', 'artifact id is invalid or duplicated');
    const artifactKeys = new Set(['id', 'layer', 'kind', 'privacy', 'required', 'restore', 'path', 'sha256', 'size', 'target']);
    if (Object.keys(a).some((key) => !artifactKeys.has(key))) throw coded('EMANIFEST_INVALID', `artifact contains an unsupported field: ${a.id}`);
    ids.add(a.id);
    if (!LAYERS.has(a.layer) || !['public', 'private'].includes(a.privacy) || typeof a.required !== 'boolean' || !RESTORE.has(a.restore)) throw coded('EMANIFEST_INVALID', `artifact classification is invalid: ${a.id}`);
    if (!ARTIFACT_KINDS.has(a.kind) || !artifactKindValid(a, m.kind)) throw coded('EMANIFEST_INVALID', `artifact kind/layer/privacy/restore policy is invalid: ${a.id}`);
    if (a.kind === 'absent') {
      if (a.path !== null || a.sha256 !== null || a.size !== 0 || a.target === undefined || a.privacy !== 'private') throw coded('EMANIFEST_INVALID', `absent artifact is malformed: ${a.id}`);
      assertTarget('rollback', a.target);
      continue;
    }
    assertSafeRelative(a.path);
    const location = `${a.privacy}:${a.path.toLowerCase()}`;
    if (locations.has(location)) throw coded('EMANIFEST_INVALID', `duplicate/case-aliased artifact path: ${a.path}`);
    locations.add(location);
    if (!HASH_RE.test(a.sha256 || '') || !Number.isSafeInteger(a.size) || a.size < 0) throw coded('EMANIFEST_INVALID', `artifact size/hash is invalid: ${a.id}`);
    if (a.kind === 'layer-json') {
      if (a.privacy !== 'public' && a.layer !== 'database') throw coded('EMANIFEST_INVALID', `non-database layer JSON must be public: ${a.id}`);
      if (a.target !== undefined) throw coded('EMANIFEST_INVALID', 'layer-json cannot declare a restore target');
    } else {
      if (a.privacy !== 'private' || typeof a.target !== 'string') throw coded('EMANIFEST_INVALID', `raw artifact must be private and target-bound: ${a.id}`);
      if (a.layer === 'rollback') assertTarget('rollback', a.target);
      else if (a.layer === 'database') assertTarget('database', a.target);
      else assertTarget(a.layer, a.target);
    }
    if (privacy && a.privacy !== privacy) throw coded('EMANIFEST_INVALID', `artifact appears in the wrong privacy manifest: ${a.id}`);
  }
  return true;
}

function checkLayerArtifactCoverage(manifest) {
  for (const [id, layer] of Object.entries(manifest.layers)) {
    if (layer.status !== 'collected') continue;
    if (!manifest.artifacts.some((a) => a.layer === id && a.kind === 'layer-json' && a.path === `${id}.json`)) {
      throw coded('EMANIFEST_INVALID', `collected layer ${id} lacks its layer-json artifact`);
    }
  }
}

async function walkFiles(dir) {
  await assertNoLinks(dir, { allowMissing: false });
  const files = [];
  const visit = async (current, prefix) => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const st = await fsp.lstat(absolute);
      if (st.isSymbolicLink()) throw coded('EUNSAFE_PATH', `link/reparse point inside generation: ${rel}`);
      if (st.isDirectory()) {
        if (!(await fsp.readdir(absolute)).length) throw coded('EARTIFACT_UNDECLARED', `empty undeclared directory in generation: ${rel}`);
        await visit(absolute, rel);
      }
      else if (st.isFile()) {
        if (st.nlink > 1) throw coded('EUNSAFE_PATH', `hardlink inside generation: ${rel}`);
        files.push(rel);
      } else throw coded('EUNSAFE_PATH', `unsupported filesystem entry: ${rel}`);
    }
  };
  await visit(dir, '');
  return files;
}

async function validateGenerationPair(root, name, generation, publicDir, privateDir) {
  assertId(generation, 'generation');
  await assertNoLinks(publicDir, { allowMissing: false });
  await assertNoLinks(privateDir, { allowMissing: false });
  const publicManifestFile = path.join(publicDir, 'manifest.json');
  const privateManifestFile = path.join(privateDir, 'manifest.json');
  await assertNoLinks(publicManifestFile, { allowMissing: false, hardlinks: true });
  await assertNoLinks(privateManifestFile, { allowMissing: false, hardlinks: true });
  const publicBytes = await fsp.readFile(publicManifestFile);
  const privateBytes = await fsp.readFile(privateManifestFile);
  let publicManifest; let privateManifest;
  try { publicManifest = JSON.parse(publicBytes.toString('utf8')); privateManifest = JSON.parse(privateBytes.toString('utf8')); }
  catch { throw coded('EMANIFEST_INVALID', 'generation manifest JSON is malformed'); }
  validateManifestShape(publicManifest, { name, generation, privacy: 'public' });
  validateManifestShape(privateManifest, { name, generation, privacy: 'private' });
  for (const key of ['schemaVersion', 'state', 'generation', 'kind', 'name', 'createdAt', 'toolVersion']) {
    if (publicManifest[key] !== privateManifest[key]) throw coded('EMANIFEST_INVALID', `public/private identity mismatch at ${key}`);
  }
  if (JSON.stringify(publicManifest.host) !== JSON.stringify(privateManifest.host) || JSON.stringify(publicManifest.layers) !== JSON.stringify(privateManifest.layers)) throw coded('EMANIFEST_INVALID', 'public/private host or layer metadata mismatch');
  const merged = [...publicManifest.artifacts, ...privateManifest.artifacts];
  const allIds = new Set();
  for (const artifact of merged) { if (allIds.has(artifact.id)) throw coded('EMANIFEST_INVALID', `duplicate artifact id across manifests: ${artifact.id}`); allIds.add(artifact.id); }
  const resolved = [];
  const parsedLayerData = new Map();
  for (const [manifest, base] of [[publicManifest, publicDir], [privateManifest, privateDir]]) {
    for (const artifact of manifest.artifacts) {
      if (artifact.kind === 'absent') { resolved.push({ ...artifact, absolutePath: null }); continue; }
      const absolutePath = path.join(base, 'files', ...artifact.path.split('/'));
      await assertNoLinks(absolutePath, { allowMissing: false, hardlinks: true });
      const st = await fsp.lstat(absolutePath);
      if (!st.isFile()) throw coded('EUNSAFE_PATH', `artifact is not a regular file: ${artifact.path}`);
      const bytes = await fsp.readFile(absolutePath);
      if (bytes.length !== artifact.size || hash(bytes) !== artifact.sha256) throw coded('EARTIFACT_INTEGRITY', `artifact size/hash mismatch: ${artifact.id}`);
      if (artifact.kind === 'layer-json') {
        let data; try { data = JSON.parse(bytes.toString('utf8')); } catch { throw coded('EMANIFEST_INVALID', `layer JSON is malformed: ${artifact.layer}`); }
        validateLayer(artifact.layer, data);
        parsedLayerData.set(artifact.id, data);
      }
      resolved.push({ ...artifact, absolutePath });
    }
    const files = await walkFiles(base);
    const expected = new Set(['manifest.json', ...manifest.artifacts.filter((a) => a.kind !== 'absent').map((a) => `files/${a.path}`)]);
    const fileSet = new Set(files);
    for (const file of files) if (!expected.has(file)) throw coded('EARTIFACT_UNDECLARED', `undeclared file in generation: ${file}`);
    for (const file of expected) if (!fileSet.has(file)) throw coded('EARTIFACT_MISSING', `required generation file is missing: ${file}`);
  }
  checkLayerArtifactCoverage({ layers: publicManifest.layers, artifacts: merged });
  const layers = {};
  for (const artifact of resolved) if (artifact.kind === 'layer-json') layers[artifact.layer] = parsedLayerData.get(artifact.id);
  for (const pin of (layers.runtime && layers.runtime.versionPins) || []) {
    const file = resolved.find((a) => a.layer === 'runtime' && a.kind === 'file' && a.target === pin.name);
    if (!file) throw coded('EMANIFEST_INVALID', `runtime pin lacks its private artifact: ${pin.name}`);
  }
  for (const env of Object.keys((layers.config && layers.config.envFiles) || {})) {
    if (!resolved.some((a) => a.layer === 'config' && a.kind === 'file' && a.target === env)) throw coded('EMANIFEST_INVALID', `config metadata lacks private artifact: ${env}`);
  }
  for (const db of (layers.database && layers.database.databases) || []) {
    if (!resolved.some((a) => a.layer === 'database' && a.target === db.file && ['sqlite-schema', 'sqlite-dump', 'sqlite-backup'].includes(a.kind))) throw coded('EMANIFEST_INVALID', `database metadata lacks artifact: ${db.file}`);
  }
  return { publicManifest, privateManifest, layers, artifacts: resolved, publicBytes, paths: snapshotPaths(root, name, generation) };
}

async function canonicalRoot(root) {
  const { root: rootAbs, state } = await assertRealProject(root, { createState: true });
  const real = await fsp.realpath(rootAbs);
  if (path.resolve(real) !== rootAbs) throw coded('EUNSAFE_PATH', 'project root contains an uncanonical path alias');
  return { root: rootAbs, state };
}

async function assertNoLockClaim(lockRoot) {
  const claimDir = path.join(lockRoot, 'operation.claim');
  try {
    await assertNoLinks(claimDir, { allowMissing: false });
    throw coded('ELOCKED', 'an operation lock claim is in progress; retry after it completes');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function claimBinding(rootAbs, operation, operationId, inspected, { resolverOperationId = operationId, allowMissingOriginalLock = false } = {}) {
  const journalBytes = inspected.temp?.bytes || await fsp.readFile(operationJournalPath(rootAbs, operationId)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return Buffer.from(JSON.stringify(inspected.journal));
  });
  const journalDigest = hash(journalBytes);
  const origin = await claimOrigin(rootAbs, operation, operationId, inspected, { allowMissingOriginalLock });
  return {
    operation, targetOperationId: operationId, journalDigest,
    resolverOperationId,
    allowMissingOriginalLock: origin.allowMissingOriginalLock,
    originalLockToken: origin.originalLockToken,
    originalLockDigest: origin.originalLockDigest,
  };
}

async function assertClaimBinding(claim, rootAbs, operation, operationId, inspected) {
  const current = await claimBinding(rootAbs, operation, operationId, inspected, {
    resolverOperationId: claim.resolverOperationId,
    allowMissingOriginalLock: claim.allowMissingOriginalLock,
  });
  for (const key of ['operation', 'targetOperationId', 'journalDigest', 'originalLockToken', 'originalLockDigest', 'resolverOperationId', 'allowMissingOriginalLock']) {
    if (current[key] !== claim[key]) throw coded('ELOCK_OWNER', `claim-bound ${key} changed before lock takeover; preserve all operation evidence`);
  }
  return true;
}

function localProcessIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

function claimOwnerToken(owner) {
  const identity = { schemaVersion: owner.schemaVersion, root: owner.root, host: owner.host, pid: owner.pid,
    operation: owner.operation, targetOperationId: owner.targetOperationId,
    originalLockToken: owner.originalLockToken, originalLockDigest: owner.originalLockDigest,
    journalDigest: owner.journalDigest, resolverOperationId: owner.resolverOperationId,
    allowMissingOriginalLock: owner.allowMissingOriginalLock, createdAt: owner.createdAt };
  return hash(Buffer.from(JSON.stringify(identity))).slice(0, 32);
}

async function readClaimOwnerForToken(lockRoot, token) {
  if (!ID_RE.test(token || '')) throw coded('ELOCK_OWNER', 'claimed operation references an invalid claim token');
  const candidates = [path.join(lockRoot, 'operation.claim'), path.join(lockRoot, `operation.claim.retired-${token}`)];
  for (const directory of candidates) {
    const ownerFile = path.join(directory, 'owner.json');
    try {
      await assertNoLinks(directory, { allowMissing: false });
      const entries = await fsp.readdir(directory);
      if (entries.length !== 1 || entries[0] !== 'owner.json') throw coded('ELOCK_OWNER', 'retained claim has unexpected entries; preserve it for manual inspection');
      await assertNoLinks(ownerFile, { allowMissing: false, hardlinks: true });
      const bytes = await fsp.readFile(ownerFile);
      const owner = JSON.parse(bytes.toString('utf8'));
      if (owner.token === token && owner.token === claimOwnerToken(owner)) return { owner, bytes, directory };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw coded('ELOCK_OWNER', 'claimed operation has no exact retained claim owner; preserve lock and journal');
}

async function assertClaimOwnerReference(rootAbs, owner, operationId) {
  if (!owner?.claimToken) return true;
  const lockRoot = path.join(rootAbs, STATE_DIR, 'locks');
  const record = await readClaimOwnerForToken(lockRoot, owner.claimToken);
  const claim = record.owner;
  if (claim.root !== rootAbs || claim.host !== owner.host || claim.operation !== owner.operation ||
      claim.targetOperationId !== owner.claimedOperationId || claim.resolverOperationId !== operationId ||
      owner.resolverOperationId !== operationId ||
      claim.originalLockToken !== owner.originalLockToken || claim.originalLockDigest !== owner.originalLockDigest ||
      typeof claim.allowMissingOriginalLock !== 'boolean' ||
      (claim.allowMissingOriginalLock && (claim.originalLockToken !== null || claim.originalLockDigest !== null)) ||
      (!claim.allowMissingOriginalLock && (!ID_RE.test(claim.originalLockToken || '') || !/^[a-f0-9]{64}$/.test(claim.originalLockDigest || '')))) {
    throw coded('ELOCK_OWNER', 'operation lock resolver identity is not bound to its exact retained claim');
  }
  return true;
}

function claimJournalTransitionPath(rootAbs, token) {
  if (!ID_RE.test(token || '')) throw coded('ELOCK_OWNER', 'journal transition references an invalid claim token');
  return path.join(rootAbs, STATE_DIR, 'locks', `operation.claim-journal-${token}.json`);
}

// A claim may outlive the exact journal bytes it initially inspected only
// when the resolver durably records the exact validated temp-to-journal rename
// before doing it. This record is a one-step transition link, not an
// authorization inferred from matching operation IDs or timestamps.
async function claimJournalTransitionMatches(rootAbs, claim, journalBytes) {
  if (!object(claim) || !ID_RE.test(claim.token || '') || !/^[a-f0-9]{64}$/.test(claim.journalDigest || '')) return false;
  const file = claimJournalTransitionPath(rootAbs, claim.token);
  let bytes;
  try {
    await assertNoLinks(file, { allowMissing: false, hardlinks: true });
    const before = await fsp.lstat(file, { bigint: true });
    if (!before.isFile() || before.nlink > 1n) return false;
    bytes = await fsp.readFile(file);
    const after = await fsp.lstat(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || after.nlink > 1n) return false;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let transition;
  try { transition = JSON.parse(bytes.toString('utf8')); } catch { return false; }
  if (!object(transition) || transition.schemaVersion !== 1 || transition.claimToken !== claim.token ||
      transition.root !== rootAbs || transition.host !== claim.host || transition.creatorPid !== claim.pid ||
      transition.operation !== claim.operation || transition.targetOperationId !== claim.targetOperationId ||
      transition.resolverOperationId !== claim.resolverOperationId ||
      transition.originalLockToken !== claim.originalLockToken || transition.originalLockDigest !== claim.originalLockDigest ||
      transition.allowMissingOriginalLock !== claim.allowMissingOriginalLock ||
      transition.fromJournalDigest !== claim.journalDigest || transition.toJournalDigest !== hash(journalBytes) ||
      transition.temporaryDigest !== transition.toJournalDigest ||
      !/^[a-f0-9]{64}$/.test(transition.fromTransactionDigest || '') ||
      !new RegExp(`^${claim.targetOperationId}\\.json\\.[a-f0-9]{32}\\.tmp$`).test(transition.temporaryName || '')) return false;
  let next;
  try { next = validateJournal(JSON.parse(journalBytes.toString('utf8')), claim.targetOperationId); } catch { return false; }
  if (next.operation !== claim.operation || transition.transactionDigest !== journalTransactionDigest(next) ||
      transition.fromTransactionDigest !== transition.transactionDigest) return false;
  return true;
}

function journalTransactionDigest(journal) {
  const identity = journal.operation === 'restore'
    ? { operationId: journal.operationId, operation: journal.operation, safety: journal.safety || null,
      resolvesOperationId: journal.resolvesOperationId || null }
    : journal.operation === 'snapshot'
      ? { operationId: journal.operationId, operation: journal.operation,
        snapshotTransaction: journal.snapshotTransaction ? {
          name: journal.snapshotTransaction.name,
          generation: journal.snapshotTransaction.generation,
          previousGeneration: journal.snapshotTransaction.previousGeneration || null,
        } : null }
      : { operationId: journal.operationId, operation: journal.operation };
  return hash(Buffer.from(JSON.stringify(identity)));
}

async function persistClaimJournalTransition(rootAbs, operationId, lock, fromBytes, toBytes, temporaryName, nextJournal) {
  const ownerFile = path.join(rootAbs, STATE_DIR, 'locks', 'operation.lock', 'owner.json');
  const ownerBytes = await fsp.readFile(ownerFile);
  const owner = JSON.parse(ownerBytes.toString('utf8'));
  if (!owner.claimToken || owner.operationId !== lock.operationId || owner.claimedOperationId !== operationId ||
      owner.resolverOperationId !== lock.operationId) return;
  await assertLock(rootAbs, lock);
  const retained = await readClaimOwnerForToken(path.join(rootAbs, STATE_DIR, 'locks'), owner.claimToken);
  const claim = retained.owner;
  if (claim.targetOperationId !== operationId || claim.resolverOperationId !== lock.operationId ||
      claim.journalDigest !== hash(fromBytes) || claim.operation !== nextJournal.operation) {
    throw coded('ELOCK_OWNER', 'journal transition does not match the exact resolver claim origin');
  }
  let previous;
  try { previous = validateJournal(JSON.parse(fromBytes.toString('utf8')), operationId); }
  catch { throw coded('EJOURNAL_INVALID', 'journal transition source is not a valid operation journal'); }
  if (previous.operation !== nextJournal.operation || journalTransactionDigest(previous) !== journalTransactionDigest(nextJournal)) {
    throw coded('EJOURNAL_INVALID', 'journal transition changes immutable operation identity');
  }
  const transactionDigest = journalTransactionDigest(nextJournal);
  const transition = {
    schemaVersion: 1, claimToken: claim.token, root: rootAbs, host: claim.host, creatorPid: claim.pid,
    operation: claim.operation, targetOperationId: claim.targetOperationId,
    resolverOperationId: claim.resolverOperationId, originalLockToken: claim.originalLockToken,
    originalLockDigest: claim.originalLockDigest, allowMissingOriginalLock: claim.allowMissingOriginalLock,
    fromJournalDigest: hash(fromBytes), toJournalDigest: hash(toBytes), temporaryName,
    temporaryDigest: hash(toBytes), fromTransactionDigest: journalTransactionDigest(previous), transactionDigest,
  };
  const transitionFile = claimJournalTransitionPath(rootAbs, claim.token);
  const transitionBytes = Buffer.from(JSON.stringify(transition));
  const transitionDir = path.dirname(transitionFile);
  const transitionPrefix = `${path.basename(transitionFile)}.`;
  const pending = (await fsp.readdir(transitionDir)).filter((name) => name.startsWith(transitionPrefix) && name.endsWith('.tmp'));
  if (pending.length) throw coded('ELOCK_OWNER', 'claim has an unpublished journal-transition temp; preserve it and the operation evidence');
  try {
    await assertNoLinks(transitionFile, { hardlinks: true });
    await fsp.lstat(transitionFile);
    const existing = await fsp.readFile(transitionFile);
    if (!existing.equals(transitionBytes)) throw coded('ELOCK_OWNER', 'claim already has a different journal transition; preserve all evidence');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const transitionTemp = `${transitionFile}.${randomId()}.tmp`;
    await fsp.writeFile(transitionTemp, transitionBytes, { flag: 'wx', mode: 0o600 });
    await assertNoLinks(transitionTemp, { allowMissing: false, hardlinks: true });
    const written = await fsp.readFile(transitionTemp);
    if (!written.equals(transitionBytes)) throw coded('ELOCK_OWNER', 'journal-transition temp failed byte verification; preserve it');
    await fsp.rename(transitionTemp, transitionFile);
    await assertNoLinks(transitionFile, { allowMissing: false, hardlinks: true });
    if (!(await fsp.readFile(transitionFile)).equals(transitionBytes)) throw coded('ELOCK_OWNER', 'published journal transition failed byte verification; preserve it');
  }
  if (!(await fsp.readFile(ownerFile)).equals(ownerBytes)) throw coded('ELOCK_OWNER', 'resolver owner changed while recording journal transition');
}

// The missing-original-lock flag is historical provenance. Once a resolver
// publishes its own operation.lock, current lock presence no longer describes
// whether an original lock existed when the claim was created. Recover that
// fact only through the exact claim token carried by the current lock owner.
async function claimOrigin(rootAbs, operation, operationId, inspected, { allowMissingOriginalLock = false } = {}) {
  const current = inspected.owner;
  if (current?.claimToken) {
    await assertClaimOwnerReference(rootAbs, current, current.operationId);
    const retained = await readClaimOwnerForToken(path.join(rootAbs, STATE_DIR, 'locks'), current.claimToken);
    const origin = retained.owner;
    if (origin.operation !== operation || origin.targetOperationId !== operationId ||
        origin.resolverOperationId !== current.operationId || current.claimedOperationId !== operationId ||
        origin.originalLockToken !== current.originalLockToken || origin.originalLockDigest !== current.originalLockDigest) {
      throw coded('ELOCK_OWNER', 'current resolver lock does not preserve the exact historical claim origin');
    }
    if (origin.allowMissingOriginalLock && (origin.originalLockToken !== null || origin.originalLockDigest !== null)) {
      throw coded('ELOCK_OWNER', 'no-original-lock claim has inconsistent original lock identity fields');
    }
    if (origin.allowMissingOriginalLock && !allowMissingOriginalLock) {
      throw coded('ELOCK_OWNER', 'this recovery path does not permit a claim created without an original lock');
    }
    return { originalLockToken: origin.originalLockToken, originalLockDigest: origin.originalLockDigest,
      allowMissingOriginalLock: origin.allowMissingOriginalLock };
  }
  if (current) {
    return {
      originalLockToken: Object.hasOwn(current, 'originalLockToken')
        ? current.originalLockToken : (current.claimedOperationToken || current.token || null),
      originalLockDigest: Object.hasOwn(current, 'originalLockDigest')
        ? current.originalLockDigest : (inspected.ownerBytes ? hash(inspected.ownerBytes) : null),
      allowMissingOriginalLock: false,
    };
  }
  return { originalLockToken: null, originalLockDigest: null,
    allowMissingOriginalLock: allowMissingOriginalLock === true };
}

async function existingClaimResolverId(rootAbs, operation, operationId, inspected) {
  const directory = path.join(rootAbs, STATE_DIR, 'locks', 'operation.claim');
  const ownerFile = path.join(directory, 'owner.json');
  try {
    await assertNoLinks(directory, { allowMissing: false });
    const entries = await fsp.readdir(directory);
    if (entries.length !== 1 || entries[0] !== 'owner.json') throw coded('ELOCK_OWNER', 'active claim has unexpected entries; preserve it for manual inspection');
    await assertNoLinks(ownerFile, { allowMissing: false, hardlinks: true });
    const before = await fsp.lstat(ownerFile, { bigint: true });
    const bytes = await fsp.readFile(ownerFile);
    const after = await fsp.lstat(ownerFile, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) throw coded('ELOCK_OWNER', 'active claim owner identity changed while inspected');
    let owner;
    try { owner = JSON.parse(bytes.toString('utf8')); } catch { throw coded('ELOCK_OWNER', 'active claim owner is malformed; preserve it'); }
    const journalBytes = inspected.temp?.bytes || await fsp.readFile(operationJournalPath(rootAbs, operationId));
    const journalMatches = owner.journalDigest === hash(journalBytes) ||
      await claimJournalTransitionMatches(rootAbs, owner, journalBytes);
    if (!object(owner) || owner.schemaVersion !== 2 || owner.root !== rootAbs || owner.host !== os.hostname() ||
        owner.operation !== operation || owner.targetOperationId !== operationId || owner.token !== claimOwnerToken(owner) ||
        !ID_RE.test(owner.resolverOperationId || '') || owner.phase !== 'claimed' ||
        !journalMatches) {
      throw coded('ELOCK_OWNER', 'active claim is not exactly bound to the inspected operation journal');
    }
    const origin = await claimOrigin(rootAbs, operation, operationId, inspected, {
      allowMissingOriginalLock: operation === 'snapshot' || inspected.journal.status === 'completed',
    });
    if (owner.originalLockToken !== origin.originalLockToken || owner.originalLockDigest !== origin.originalLockDigest ||
        owner.allowMissingOriginalLock !== origin.allowMissingOriginalLock) {
      throw coded('ELOCK_OWNER', 'active claim original-lock association differs from the inspected state');
    }
    return owner.resolverOperationId;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function assertCurrentClaim(rootAbs, claim) {
  const claimDir = path.join(rootAbs, STATE_DIR, 'locks', 'operation.claim');
  const ownerFile = path.join(claimDir, 'owner.json');
  await assertNoLinks(claimDir, { allowMissing: false });
  const entries = await fsp.readdir(claimDir);
  if (entries.length !== 1 || entries[0] !== 'owner.json') throw coded('ELOCK_OWNER', 'current claim has unexpected entries; preserve it for manual inspection');
  const dirBefore = await fsp.lstat(claimDir, { bigint: true });
  await assertNoLinks(ownerFile, { allowMissing: false, hardlinks: true });
  const before = await fsp.lstat(ownerFile, { bigint: true });
  const bytes = await fsp.readFile(ownerFile);
  let owner;
  try { owner = JSON.parse(bytes.toString('utf8')); } catch { throw coded('ELOCK_OWNER', 'claim owner is malformed; preserve it'); }
  const after = await fsp.lstat(ownerFile, { bigint: true });
  const dirAfter = await fsp.lstat(claimDir, { bigint: true });
  if (dirBefore.dev !== dirAfter.dev || dirBefore.ino !== dirAfter.ino ||
      !bytes.equals(claim.ownerBytes) || before.dev !== after.dev || before.ino !== after.ino ||
      owner.token !== claim.token || owner.token !== claimOwnerToken(owner) || owner.pid !== process.pid ||
      owner.root !== rootAbs || owner.phase !== 'claimed') throw coded('ELOCK_OWNER', 'current process no longer owns the operation claim');
  return true;
}

async function acquireLockClaim(rootAbs, state, binding) {
  const lockRoot = path.join(state, 'locks');
  await ensureRealDirectory(state, lockRoot);
  const claimDir = path.join(lockRoot, 'operation.claim');
  const ownerFile = path.join(claimDir, 'owner.json');
  const owner = { schemaVersion: 2, root: rootAbs, pid: process.pid, host: os.hostname(),
    operation: binding.operation, targetOperationId: binding.targetOperationId,
    originalLockToken: binding.originalLockToken, originalLockDigest: binding.originalLockDigest,
    journalDigest: binding.journalDigest, resolverOperationId: binding.resolverOperationId,
    allowMissingOriginalLock: binding.allowMissingOriginalLock === true,
    phase: 'claimed', createdAt: new Date().toISOString() };
  owner.token = claimOwnerToken(owner);
  const token = owner.token;
  try { await fsp.mkdir(claimDir); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A complete claim can be taken over only when the current caller has
    // independently re-inspected the same operation and the previous local
    // owner is dead. Age alone and PID alone never authorize removal.
    await assertNoLinks(claimDir, { allowMissing: false });
    const claimEntries = await fsp.readdir(claimDir);
    if (claimEntries.length !== 1 || claimEntries[0] !== 'owner.json') throw coded('ELOCK_OWNER', 'stale claim has unexpected entries; preserve it for manual inspection');
    await assertNoLinks(ownerFile, { allowMissing: false, hardlinks: true });
    const oldBytes = await fsp.readFile(ownerFile);
    let old;
    try { old = JSON.parse(oldBytes.toString('utf8')); } catch { throw coded('ELOCK_OWNER', 'lock claim owner is malformed; preserve it for manual inspection'); }
    const journalMatches = object(old) && (old.journalDigest === binding.journalDigest ||
      await claimJournalTransitionMatches(rootAbs, old, await fsp.readFile(operationJournalPath(rootAbs, binding.targetOperationId))));
    const sameBinding = object(old) && old.schemaVersion === 2 && old.root === rootAbs && old.host === os.hostname() &&
      old.operation === binding.operation && old.targetOperationId === binding.targetOperationId &&
      old.originalLockToken === binding.originalLockToken && old.originalLockDigest === binding.originalLockDigest &&
      journalMatches && ID_RE.test(old.resolverOperationId || '') &&
      old.allowMissingOriginalLock === (binding.allowMissingOriginalLock === true) && old.phase === 'claimed' && ID_RE.test(old.token || '') &&
      old.token === claimOwnerToken(old) && Number.isSafeInteger(old.pid) && old.pid > 0;
    if (!sameBinding) throw coded('ELOCK_OWNER', 'claim identity or bound journal changed; preserve the claim and operation evidence');
    if (localProcessIsAlive(old.pid)) throw coded('ELOCKED', `claim owner process ${old.pid} is still active`);
    // A persistent per-old-token mkdir is the exclusive arbitration point.
    // It is never removed: contenders that observed the same dead owner can
    // therefore never rename a later winner's claim from the fixed path.
    const takeoverFence = path.join(lockRoot, `operation.claim.takeover-${old.token}`);
    try { await fsp.mkdir(takeoverFence); }
    catch (error) {
      if (error.code === 'EEXIST') throw coded('ELOCKED', 'another recovery process already won or began takeover of this exact stale claim');
      throw error;
    }
    const takeoverOwner = {
      schemaVersion: 1, root: rootAbs, host: os.hostname(), pid: process.pid,
      operation: binding.operation, targetOperationId: binding.targetOperationId,
      oldClaimToken: old.token, oldOwnerDigest: hash(oldBytes),
      journalDigest: binding.journalDigest, resolverOperationId: binding.resolverOperationId,
      createdAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(takeoverFence, 'owner.json'), JSON.stringify(takeoverOwner), { flag: 'wx', mode: 0o600 });
    const lockDir = path.join(lockRoot, 'operation.lock');
    const lockStat = await fsp.lstat(lockDir, { bigint: true }).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!lockStat) {
      if (!old.allowMissingOriginalLock || !binding.allowMissingOriginalLock || old.originalLockToken !== null || old.originalLockDigest !== null) {
        throw coded('ELOCK_OWNER', 'operation lock is missing without an explicit no-original-lock recovery binding; preserve claim and journal');
      }
    } else {
    await assertNoLinks(lockDir, { allowMissing: false });
    const liveOwnerFile = path.join(lockDir, 'owner.json');
    await assertNoLinks(liveOwnerFile, { allowMissing: false, hardlinks: true });
    const liveBytes = await fsp.readFile(liveOwnerFile);
    let live;
    try { live = JSON.parse(liveBytes.toString('utf8')); } catch { throw coded('ELOCK_OWNER', 'operation lock owner is malformed; preserve it with the claim'); }
    if (!object(live) || live.root !== rootAbs || live.host !== os.hostname() || !ID_RE.test(live.token || '') ||
        !Number.isSafeInteger(live.pid) || live.pid < 1 || live.operation !== binding.operation ||
        (live.operationId !== binding.targetOperationId && live.claimedOperationId !== binding.targetOperationId)) {
      throw coded('ELOCK_OWNER', 'current operation lock is foreign or malformed; preserve it with the claim');
    }
    if (localProcessIsAlive(live.pid)) throw coded('ELOCKED', `operation lock owner process ${live.pid} is still active`);
    const originalLockStillPresent = old.originalLockDigest && hash(liveBytes) === old.originalLockDigest;
    const claimedLockPresent = live.claimToken === old.token && live.operation === old.operation &&
      live.claimedOperationId === old.targetOperationId && live.operationId === old.resolverOperationId &&
      live.originalLockToken === old.originalLockToken && live.originalLockDigest === old.originalLockDigest;
    if (!originalLockStillPresent && !claimedLockPresent) throw coded('ELOCK_OWNER', 'claim is not bound to the current original or claimed operation lock');
    const ownerTemps = (await fsp.readdir(lockDir)).filter((name) => name.startsWith('.owner-') && name.endsWith('.tmp'));
    if (ownerTemps.length) {
      const expected = `.owner-${old.token}.tmp`;
      if (ownerTemps.length !== 1 || ownerTemps[0] !== expected) throw coded('ELOCK_OWNER', 'operation lock has ambiguous owner temporary files; preserve claim and lock');
      const tempPath = path.join(lockDir, expected);
      await assertNoLinks(tempPath, { allowMissing: false, hardlinks: true });
      const tempBytes = await fsp.readFile(tempPath);
      let tempOwner;
      try { tempOwner = JSON.parse(tempBytes.toString('utf8')); } catch { throw coded('ELOCK_OWNER', 'operation lock owner temporary is malformed; preserve all evidence'); }
      if (tempOwner.root !== rootAbs || tempOwner.host !== old.host || tempOwner.claimToken !== old.token ||
          tempOwner.claimedOperationId !== old.targetOperationId || tempOwner.claimedOperationToken !== old.originalLockToken ||
          tempOwner.operation !== old.operation || tempOwner.operationId !== old.resolverOperationId || localProcessIsAlive(tempOwner.pid)) {
        throw coded('ELOCK_OWNER', 'operation lock owner temporary is not proven to belong to the interrupted claim');
      }
      if (!(await fsp.readFile(tempPath)).equals(tempBytes)) throw coded('ELOCK_OWNER', 'operation lock owner temporary changed during inspection');
      await fsp.unlink(tempPath);
    }
    }
    const afterBytes = await fsp.readFile(ownerFile);
    if (!afterBytes.equals(oldBytes)) throw coded('ELOCK_OWNER', 'claim owner changed during takeover; preserve all evidence');
    const observedDir = await fsp.lstat(claimDir, { bigint: true });
    const retired = `${claimDir}.retired-${old.token}`;
    try { await fsp.rename(claimDir, retired); }
    catch (error) {
      if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'ENOENT'].includes(error.code)) throw coded('ELOCKED', 'another recovery process won or completed claim takeover; retry inspection');
      throw error;
    }
    const retiredDir = await fsp.lstat(retired, { bigint: true });
    if (retiredDir.dev !== observedDir.dev || retiredDir.ino !== observedDir.ino ||
        !(await fsp.readFile(path.join(retired, 'owner.json'))).equals(oldBytes)) {
      throw coded('ELOCK_OWNER', 'retired claim did not match the observed stale owner; preserve all claim evidence');
    }
    try { await fsp.mkdir(claimDir); }
    catch (error) { if (error.code === 'EEXIST') throw coded('ELOCKED', 'another recovery process won claim publication'); throw error; }
  }
  const ownerBytes = Buffer.from(JSON.stringify(owner));
  try { await fsp.writeFile(ownerFile, ownerBytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { throw error; }
  return {
    ...binding, token, ownerBytes,
    async release() {
      await assertNoLinks(claimDir, { allowMissing: false });
      await assertNoLinks(ownerFile, { allowMissing: false, hardlinks: true });
      const dirBefore = await fsp.lstat(claimDir, { bigint: true });
      const ownerBefore = await fsp.lstat(ownerFile, { bigint: true });
      const currentBytes = await fsp.readFile(ownerFile);
      let current;
      try { current = JSON.parse(currentBytes.toString('utf8')); }
      catch { throw coded('ELOCK_OWNER', 'lock claim owner is malformed; preserve it for manual inspection'); }
      if (!currentBytes.equals(ownerBytes) || !object(current) || current.token !== token || current.token !== claimOwnerToken(current) ||
          current.root !== rootAbs || current.pid !== process.pid || current.host !== os.hostname() || current.phase !== 'claimed' ||
          current.operation !== binding.operation || current.targetOperationId !== binding.targetOperationId ||
          current.originalLockToken !== binding.originalLockToken || current.originalLockDigest !== binding.originalLockDigest ||
          current.journalDigest !== binding.journalDigest || current.resolverOperationId !== binding.resolverOperationId ||
          current.allowMissingOriginalLock !== (binding.allowMissingOriginalLock === true)) {
        throw coded('ELOCK_OWNER', 'lock claim ownership changed; preserve it for manual inspection');
      }
      const dirAfter = await fsp.lstat(claimDir, { bigint: true });
      const ownerAfter = await fsp.lstat(ownerFile, { bigint: true });
      if (dirAfter.dev !== dirBefore.dev || dirAfter.ino !== dirBefore.ino || ownerAfter.dev !== ownerBefore.dev ||
          ownerAfter.ino !== ownerBefore.ino || !(await fsp.readFile(ownerFile)).equals(ownerBytes)) {
        throw coded('ELOCK_OWNER', 'lock claim identity changed during release; preserve it for manual inspection');
      }
      // Atomically move the complete owner record out of the blocking name.
      // A kill during directory cleanup leaves non-blocking evidence rather
      // than an ownerless operation.claim directory.
      const released = `${claimDir}.retired-${token}`;
      try { await fsp.rename(claimDir, released); }
      catch (error) { if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw coded('ELOCK_OWNER', 'claim retirement already exists; preserve all evidence'); throw error; }
      const movedDir = await fsp.lstat(released, { bigint: true });
      if (movedDir.dev !== dirBefore.dev || movedDir.ino !== dirBefore.ino ||
          !(await fsp.readFile(path.join(released, 'owner.json'))).equals(ownerBytes)) {
        throw coded('ELOCK_OWNER', 'released claim identity changed during move; preserve the released directory');
      }
      // Retain this non-blocking tombstone as a durable fence for stale readers.
    },
  };
}

async function createOperationLock(rootAbs, state, { operation, operationId, claim } = {}) {
  const lockRoot = path.join(state, 'locks');
  await ensureRealDirectory(state, lockRoot);
  const claimDir = path.join(lockRoot, 'operation.claim');
  if (claim) {
    if (operationId !== claim.resolverOperationId) throw coded('ELOCK_OWNER', 'new lock operationId does not match its claim-bound resolver id');
    await assertCurrentClaim(rootAbs, claim);
  } else {
    await assertNoLockClaim(lockRoot);
  }
  const lockDir = path.join(lockRoot, 'operation.lock');
  try { await fsp.mkdir(lockDir); }
  catch (error) { if (error.code === 'EEXIST') throw coded('ELOCKED', 'project-state operation lock exists; stale locks require explicit inspection'); throw error; }
  const token = randomId();
  const owner = { token, root: rootAbs, operation, operationId, pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(),
    ...(claim ? { claimToken: claim.token, claimedOperationId: claim.targetOperationId,
      resolverOperationId: operationId, originalLockToken: claim.originalLockToken,
      originalLockDigest: claim.originalLockDigest } : {}),
    ...(claim?.claimedOperationToken ? { claimedOperationToken: claim.claimedOperationToken } : {}) };
  const ownerFile = path.join(lockDir, 'owner.json');
  try {
    await fsp.writeFile(ownerFile, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    if (claim) {
      await assertCurrentClaim(rootAbs, claim);
    } else {
      await assertNoLockClaim(lockRoot);
    }
  } catch (error) {
    try {
      const created = JSON.parse(await fsp.readFile(ownerFile, 'utf8'));
      if (created.token === token) { await fsp.unlink(ownerFile); await fsp.rmdir(lockDir); }
    } catch { /* preserve any directory whose ownership cannot be proved */ }
    throw error;
  }
  let released = false;
  const handle = {
    root: rootAbs, operation, operationId, token,
    async release() {
      if (released) return false;
      await assertLock(rootAbs, handle);
      const currentOwnerFile = path.join(lockDir, 'owner.json');
      const currentBytes = await fsp.readFile(currentOwnerFile);
      const currentOwner = JSON.parse(currentBytes.toString('utf8'));
      if (currentOwner.token !== token || currentOwner.operationId !== operationId) throw coded('ELOCK_OWNER', 'operation lock ownership changed; preserve it for inspection');
      await removeExactOwnerTemporary(lockDir, currentBytes, currentOwner);
      // Retire the whole owner-bearing directory atomically. An interrupted
      // cleanup can leave a uniquely named, non-active directory, but cannot
      // leave an ownerless operation.lock that blocks every later operation.
      const retiredDir = path.join(path.dirname(lockDir), `operation.retired-${token}-${randomId()}`);
      await assertNoLinks(lockDir, { allowMissing: false });
      if (!(await fsp.readFile(currentOwnerFile)).equals(currentBytes)) throw coded('ELOCK_OWNER', 'operation lock changed before retirement');
      await fsp.rename(lockDir, retiredDir);
      released = true;
      locks.delete(token);
      // The renamed directory is no longer an active lock. Best-effort cleanup
      // is intentionally post-retirement; a failure only leaves inert evidence.
      await fsp.rm(retiredDir, { recursive: true, force: false }).catch(() => {});
      return true;
    },
  };
  locks.set(token, handle);
  return handle;
}

async function takeOverOperationLock(rootAbs, state, { inspected, claim, operation, operationId, claimedOperationToken } = {}) {
  const lockDir = path.join(state, 'locks', 'operation.lock');
  const ownerFile = path.join(lockDir, 'owner.json');
  if (operationId !== claim.resolverOperationId) throw coded('ELOCK_OWNER', 'takeover operationId does not match its claim-bound resolver id');
  await assertNoLinks(lockDir, { allowMissing: false });
  await assertNoLinks(ownerFile, { allowMissing: false, hardlinks: true });
  if (inspected.owner && localProcessIsAlive(inspected.owner.pid)) throw coded('ELOCKED', `operation lock owner process ${inspected.owner.pid} became active before takeover`);
  if (!inspected.ownerBytes || !(await fsp.readFile(ownerFile)).equals(inspected.ownerBytes)) throw coded('ELOCK_OWNER', 'original operation lock changed before takeover');
  const token = randomId();
  const owner = { token, root: rootAbs, operation, operationId, pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(),
    claimToken: claim.token, claimedOperationId: claim.targetOperationId,
    resolverOperationId: operationId,
    originalLockToken: claim.originalLockToken,
    originalLockDigest: claim.originalLockDigest,
    ...(claimedOperationToken ? { claimedOperationToken } : {}) };
  const temporary = path.join(lockDir, `.owner-${claim.token}.tmp`);
  await assertCurrentClaim(rootAbs, claim);
  const priorTemps = (await fsp.readdir(lockDir)).filter((name) => name.startsWith('.owner-') && name.endsWith('.tmp'));
  if (priorTemps.length) throw coded('ELOCK_OWNER', 'operation lock contains an unresolved owner temporary; preserve lock and claim for inspection');
  await fsp.writeFile(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  await assertCurrentClaim(rootAbs, claim);
  if (inspected.owner && localProcessIsAlive(inspected.owner.pid)) {
    await fsp.unlink(temporary).catch(() => {});
    throw coded('ELOCKED', `operation lock owner process ${inspected.owner.pid} became active during takeover`);
  }
  if (!(await fsp.readFile(ownerFile)).equals(inspected.ownerBytes)) {
    await fsp.unlink(temporary).catch(() => {});
    throw coded('ELOCK_OWNER', 'original operation lock changed during takeover; temporary owner retained for diagnosis');
  }
  await assertCurrentClaim(rootAbs, claim);
  await fsp.rename(temporary, ownerFile);
  const published = await fsp.readFile(ownerFile);
  if (!published.equals(Buffer.from(JSON.stringify(owner)))) throw coded('ELOCK_OWNER', 'claimed operation lock publication could not be verified');
  await assertCurrentClaim(rootAbs, claim);
  const handle = { root: rootAbs, operation, operationId, token,
    async release() {
      if (!locks.has(token) || locks.get(token) !== handle) throw coded('ELOCK_OWNER', 'operation lock handle is foreign or released');
      const actual = await fsp.readFile(ownerFile);
      if (!actual.equals(published)) throw coded('ELOCK_OWNER', 'operation lock owner changed; preserve it for manual inspection');
      await removeExactOwnerTemporary(lockDir, published, owner);
      const retiredDir = path.join(path.dirname(lockDir), `operation.retired-${token}-${randomId()}`);
      await assertNoLinks(lockDir, { allowMissing: false });
      if (!(await fsp.readFile(ownerFile)).equals(published)) throw coded('ELOCK_OWNER', 'operation lock changed before retirement');
      await fsp.rename(lockDir, retiredDir);
      locks.delete(token);
      await fsp.rm(retiredDir, { recursive: true, force: false }).catch(() => {});
      return true;
    } };
  locks.set(token, handle);
  return handle;
}

async function acquireOperationLock(root, { operation = 'operation', operationId = randomId() } = {}) {
  const { root: rootAbs, state } = await canonicalRoot(root);
  assertId(operationId, 'operationId');
  if (typeof operation !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/i.test(operation)) throw coded('ELOCK_OWNER', 'invalid lock operation');
  return createOperationLock(rootAbs, state, { operation, operationId });
}

async function assertLock(root, lock) {
  const rootAbs = path.resolve(root);
  if (!lock || !ID_RE.test(lock.token || '') || !locks.has(lock.token) || locks.get(lock.token) !== lock || path.resolve(lock.root || '') !== rootAbs) throw coded('ELOCK_OWNER', 'operation lock is foreign, forged, released or belongs to another project');
  const ownerFile = path.join(rootAbs, STATE_DIR, 'locks', 'operation.lock', 'owner.json');
  await assertNoLinks(ownerFile, { allowMissing: false, hardlinks: true });
  let owner;
  try { owner = JSON.parse(await fsp.readFile(ownerFile, 'utf8')); } catch { throw coded('ELOCK_OWNER', 'operation lock owner record is malformed'); }
  if (!object(owner) || owner.token !== lock.token || owner.root !== rootAbs || owner.operationId !== lock.operationId || owner.operation !== lock.operation) throw coded('ELOCK_OWNER', 'operation lock ownership changed');
  return true;
}

async function removeExactOwnerTemporary(lockDir, ownerBytes, owner) {
  const entries = await fsp.readdir(lockDir);
  const extras = entries.filter((name) => name !== 'owner.json');
  if (!extras.length) return;
  const expected = owner.claimToken ? `.owner-${owner.claimToken}.tmp` : null;
  if (extras.length !== 1 || !expected || extras[0] !== expected) throw coded('ELOCK_OWNER', 'operation lock contains unrecognized entries; preserve them for manual inspection');
  const temporary = path.join(lockDir, expected);
  await assertNoLinks(temporary, { allowMissing: false, hardlinks: true });
  const stat = await fsp.lstat(temporary, { bigint: true });
  const bytes = await fsp.readFile(temporary);
  if (!stat.isFile() || stat.nlink > 1n || !bytes.equals(ownerBytes)) throw coded('ELOCK_OWNER', 'operation lock temporary is not an exact duplicate of its authenticated owner');
  await fsp.unlink(temporary);
}

async function inspectInterruptedRestore(root, operationId, { requireDead = false, cleanup = false, terminalCleanup = false } = {}) {
  assertId(operationId, 'operationId');
  const rootAbs = path.resolve(root);
  const lockDir = path.join(rootAbs, STATE_DIR, 'locks', 'operation.lock');
  let alive = true;
  let owner = null; let ownerBytes = null; let ownerFile = path.join(lockDir, 'owner.json');
  const lockPresent = await fsp.lstat(lockDir).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error));
  if (lockPresent) {
    await assertNoLinks(lockDir, { allowMissing: false });
    try { await assertNoLinks(ownerFile, { allowMissing: false, hardlinks: true }); }
    catch (error) { if (error.code === 'ENOENT') throw coded('ELOCK_OWNER', 'operation lock directory exists without its owner record; preserve the incomplete lock'); throw error; }
    try { ownerBytes = await fsp.readFile(ownerFile); owner = JSON.parse(ownerBytes.toString('utf8')); } catch { throw coded('ELOCK_OWNER', 'stale lock owner record is malformed; preserve it for manual inspection'); }
    if (!object(owner) || owner.root !== rootAbs || owner.operation !== 'restore' || (owner.operationId !== operationId && owner.claimedOperationId !== operationId) || !ID_RE.test(owner.token || '') || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.host !== os.hostname()) throw coded('ELOCK_OWNER', 'lock identity does not match this local restore; automatic recovery is refused');
    await assertClaimOwnerReference(rootAbs, owner, owner.operationId);
    if (owner.claimToken && owner.operationId !== operationId) {
      const resolverFile = operationJournalPath(rootAbs, owner.operationId);
      const resolverStat = await fsp.lstat(resolverFile).then((stat) => stat, (error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (resolverStat) {
        const resolverJournal = await readJournal(rootAbs, resolverFile);
        if (resolverJournal.operation !== 'restore' || resolverJournal.operationId !== owner.operationId ||
            resolverJournal.resolvesOperationId !== operationId) {
          throw coded('ELOCK_OWNER', 'resolver journal does not prove the exact original-operation association; preserve both journals and the pin');
        }
        throw coded('ELOCKED', `resolver operation ${owner.operationId} already has a journal; inspect and resolve that exact operation before retrying the original`);
      }
    }
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else if (error.code !== 'EPERM') throw error; }
    if (alive && requireDead) throw coded('ELOCKED', `restore process ${owner.pid} is still active; do not recover concurrently`);
  } else { alive = false; }
  const journal = await readJournal(rootAbs, operationJournalPath(rootAbs, operationId));
  const active = journal.operation === 'restore' && journal.status === 'in-progress';
  const pendingCleanup = cleanup && journal.operation === 'restore' && journal.status === 'completed' && journal.terminalOutcome === 'verified-complete' && Array.isArray(journal.cleanupPending) && journal.cleanupPending.length > 0;
  const terminalCleanupReady = terminalCleanup && cleanup && lockPresent && journal.operation === 'restore' &&
    journal.status === 'completed' && journal.terminalOutcome === 'verified-complete' && Array.isArray(journal.cleanupPending) && journal.cleanupPending.length === 0 &&
    owner?.claimToken && owner.claimedOperationId === operationId && owner.resolverOperationId === owner.operationId;
  if (!(active || pendingCleanup || terminalCleanupReady) || !journal.safety?.pinId) throw coded('EJOURNAL_INVALID', cleanup ? 'restore cleanup requires an in-progress operation, durable cleanup actions, or an owner-bound terminal cleanup lock' : 'interrupted restore has no in-progress journal and exact safety pin reference');
  const safety = journal.safety;
  const checked = await validateGenerationById(rootAbs, safety.name, safety.generation);
  if (checked.publicManifest.kind !== 'auto') throw coded('EPIN_INVALID', 'restore safety generation is not an auto snapshot');
  const pin = await readPinFile(path.join(rootAbs, STATE_DIR, 'pins', safety.name, safety.generation, `${safety.pinId}.json`), safety.name, safety.generation);
  if (pin.operationId !== operationId || pin.reason !== 'rollback-needed') throw coded('EPIN_INVALID', 'interrupted restore safety pin ownership does not match');
  return { owner, ownerBytes, journal, safety, lockDir, ownerFile, lockPresent, alive };
}

// A process can stop after atomically writing the journal's sibling temporary
// file but before renaming it over <operationId>.json. Reconcile only that
// exact, schema-valid file while holding the exclusive lock claim. Unknown or
// ambiguous files are retained for manual inspection.
async function reconcileOperationJournalTemp(root, operationId, lock, current) {
  const directory = path.join(path.resolve(root), STATE_DIR, 'operations');
  const prefix = `${operationId}.json.`;
  const candidates = (await fsp.readdir(directory)).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'));
  if (candidates.length === 0) return current;
  if (candidates.length !== 1 || !new RegExp(`^${operationId}\\.json\\.[a-f0-9]{32}\\.tmp$`).test(candidates[0])) {
    throw coded('EJOURNAL_INVALID', 'restore has ambiguous journal temporary files; retain them and the safety pin for manual inspection');
  }
  const temporary = path.join(directory, candidates[0]);
  await assertNoLinks(temporary, { allowMissing: false, hardlinks: true });
  const before = await fsp.lstat(temporary, { bigint: true });
  if (!before.isFile() || before.nlink > 1n) throw coded('EJOURNAL_INVALID', 'restore journal temporary is not a private regular file');
  const bytes = await fsp.readFile(temporary);
  let candidate;
  try { candidate = validateJournal(JSON.parse(bytes.toString('utf8')), operationId); }
  catch (error) { throw coded('EJOURNAL_INVALID', `restore journal temporary is malformed; retain it for manual inspection (${error.code || 'invalid'})`); }
  let matchesTransaction = false;
  if (candidate.operation === 'restore') {
    matchesTransaction = !!candidate.safety && candidate.safety.name === current.safety?.name && candidate.safety.generation === current.safety?.generation && candidate.safety.pinId === current.safety?.pinId;
  } else if (candidate.operation === 'snapshot') {
    const before = current.snapshotTransaction; const next = candidate.snapshotTransaction;
    matchesTransaction = !!before && !!next && before.name === next.name && before.generation === next.generation && before.previousGeneration === next.previousGeneration;
  }
  if (candidate.operation !== current.operation || !matchesTransaction) {
    throw coded('EJOURNAL_INVALID', 'operation journal temporary does not match the inspected operation and protected transaction identity');
  }
  const priorTime = Date.parse(current.updatedAt);
  const candidateTime = Date.parse(candidate.updatedAt);
  const latest = candidateTime > priorTime;
  const after = await fsp.lstat(temporary, { bigint: true });
  const latestBytes = await fsp.readFile(temporary);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || !latestBytes.equals(bytes)) {
    throw coded('EJOURNAL_INVALID', 'restore journal temporary changed while being inspected');
  }
  await assertLock(root, lock);
  const destination = operationJournalPath(root, operationId);
  if (latest) {
    const currentBytes = await fsp.readFile(destination);
    if (hash(currentBytes) !== hash(Buffer.from(JSON.stringify(current)))) {
      // Journals are atomically serialized; compare against the inspected
      // bytes through the claim binding instead of accepting a changed file.
      const parsedCurrent = validateJournal(JSON.parse(currentBytes.toString('utf8')), operationId);
      if (JSON.stringify(parsedCurrent) !== JSON.stringify(current)) throw coded('EJOURNAL_INVALID', 'operation journal changed before temporary publication');
    }
    await persistClaimJournalTransition(path.resolve(root), operationId, lock, currentBytes, bytes, candidates[0], candidate);
    await fsp.rename(temporary, destination);
    return readJournal(root, destination);
  }
  // A valid but older intent is superseded by the current journal. Remove only
  // the exact, unchanged temporary file after verifying the current journal.
  const live = await readJournal(root, destination);
  if (live.updatedAt !== current.updatedAt || live.safety?.pinId !== current.safety?.pinId) {
    throw coded('EJOURNAL_INVALID', 'restore journal changed during temporary cleanup');
  }
  await fsp.unlink(temporary);
  return live;
}

async function reconcileRestoreJournalTemp(root, operationId, lock, current) {
  if (current.operation !== 'restore') throw coded('EJOURNAL_INVALID', 'restore journal reconciliation requires a restore operation');
  return reconcileOperationJournalTemp(root, operationId, lock, current);
}

async function claimInterruptedRestore(root, operationId, { cleanup = false, terminalCleanup = false } = {}) {
  const { root: rootAbs, state } = await canonicalRoot(root);
  const initial = await inspectInterruptedRestore(rootAbs, operationId, { requireDead: true, cleanup, terminalCleanup });
  if (terminalCleanup) {
    if (!cleanup || !initial.owner?.claimToken) throw coded('ELOCK_OWNER', 'terminal cleanup lock has no resolver claim provenance; preserve lock and journal');
    const prior = await readClaimOwnerForToken(path.join(rootAbs, STATE_DIR, 'locks'), initial.owner.claimToken);
    const claim = prior.owner;
    const resolver = initial.owner;
    const noOriginalLockOrigin = claim.allowMissingOriginalLock === true &&
      claim.originalLockToken === null && claim.originalLockDigest === null &&
      !Object.hasOwn(resolver, 'claimedOperationToken');
    const exactOriginalLockOrigin = claim.allowMissingOriginalLock === false &&
      ID_RE.test(claim.originalLockToken || '') && HASH_RE.test(claim.originalLockDigest || '') &&
      resolver.claimedOperationToken === claim.originalLockToken;
    if (claim.schemaVersion !== 2 || claim.root !== rootAbs || claim.host !== os.hostname() ||
        !Number.isSafeInteger(claim.pid) || claim.pid < 1 || claim.phase !== 'claimed' ||
        claim.operation !== 'restore' || claim.targetOperationId !== operationId ||
        claim.resolverOperationId !== resolver.operationId || claim.pid !== resolver.pid ||
        resolver.operation !== 'restore' || resolver.claimedOperationId !== operationId ||
        resolver.resolverOperationId !== resolver.operationId ||
        resolver.originalLockToken !== claim.originalLockToken || resolver.originalLockDigest !== claim.originalLockDigest ||
        !(noOriginalLockOrigin || exactOriginalLockOrigin)) {
      throw coded('ELOCK_OWNER', 'terminal cleanup lock is not bound to an exact supported original-lock claim; preserve lock and journal');
    }
  }
  if (!initial.owner && (!cleanup || initial.lockPresent)) {
    throw coded('ELOCK_OWNER', 'restore recovery requires its exact original lock owner; a missing or incomplete lock is allowed only for verified cleanup with a genuinely absent lock directory');
  }
  const priorResolverOperationId = await existingClaimResolverId(rootAbs, 'restore', operationId, initial);
  const resolverOperationId = cleanup ? operationId
    : (initial.owner?.claimedOperationId === operationId ? initial.owner.operationId : (priorResolverOperationId || randomId()));
  const binding = await claimBinding(rootAbs, 'restore', operationId, initial, {
    resolverOperationId,
    allowMissingOriginalLock: cleanup && (initial.owner === null || !!initial.owner.claimToken),
  });
  const claim = await acquireLockClaim(rootAbs, state, binding);
  let lock = null;
  try {
    const inspected = await inspectInterruptedRestore(rootAbs, operationId, { requireDead: true, cleanup, terminalCleanup });
    const fresh = await inspectInterruptedRestore(rootAbs, operationId, { requireDead: true, cleanup, terminalCleanup });
    if (inspected.lockPresent !== fresh.lockPresent || !((inspected.ownerBytes === null && fresh.ownerBytes === null) || inspected.ownerBytes?.equals(fresh.ownerBytes)) || JSON.stringify(inspected.journal) !== JSON.stringify(fresh.journal) ||
        inspected.safety.name !== fresh.safety.name || inspected.safety.generation !== fresh.safety.generation || inspected.safety.pinId !== fresh.safety.pinId) {
      throw coded('ELOCK_OWNER', 'stale restore identity or journal changed during exclusive claim');
    }
    await assertClaimBinding(claim, rootAbs, 'restore', operationId, fresh);
    lock = inspected.owner
      ? await takeOverOperationLock(rootAbs, state, { inspected, claim, operation: 'restore', operationId: resolverOperationId, claimedOperationToken: claim.originalLockToken })
      : await createOperationLock(rootAbs, state, { operation: 'restore', operationId: resolverOperationId, claim });
    const journal = await reconcileRestoreJournalTemp(rootAbs, operationId, lock, inspected.journal);
    return { lock, journal, safety: inspected.safety };
  } catch (error) {
    // Preserve the claim and claimed owner when journal reconciliation fails;
    // the next process must inspect these identities before it can proceed.
    throw error;
  } finally { await claim.release(); }
}

async function finalizeCompletedRestoreCleanup(root, operationId) {
  assertId(operationId, 'operationId');
  const lockDir = path.join(path.resolve(root), STATE_DIR, 'locks', 'operation.lock');
  const stat = await fsp.lstat(lockDir).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return { closed: false, reason: 'no-lock' };
  const claimed = await claimInterruptedRestore(root, operationId, { cleanup: true, terminalCleanup: true });
  try {
    const journal = await readJournal(root, operationJournalPath(root, operationId));
    if (journal.operation !== 'restore' || journal.status !== 'completed' || journal.terminalOutcome !== 'verified-complete' ||
        !Array.isArray(journal.cleanupPending) || journal.cleanupPending.length !== 0) {
      throw coded('EJOURNAL_INVALID', 'terminal cleanup state changed after claim; preserve lock, journal and pins');
    }
    await claimed.lock.release();
    return { closed: true, operationId };
  } catch (error) {
    // The lock and retained claim are evidence. Do not remove either on an
    // uncertain terminal-cleanup result.
    throw error;
  }
}

async function inspectInterruptedSnapshot(root, operationId) {
  assertId(operationId, 'operationId');
  const rootAbs = path.resolve(root);
  await assertRealProject(rootAbs);
  const realRoot = await fsp.realpath(rootAbs);
  if (path.resolve(realRoot) !== rootAbs) throw coded('EUNSAFE_PATH', 'project root contains an uncanonical path alias');
  const lockDir = path.join(rootAbs, STATE_DIR, 'locks', 'operation.lock');
  const ownerFile = path.join(lockDir, 'owner.json');
  let owner = null;
  let ownerBytes = null;
  const lockPresent = await fsp.lstat(lockDir).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error));
  if (lockPresent) {
    await assertNoLinks(lockDir, { allowMissing: false });
    await assertNoLinks(ownerFile, { allowMissing: false, hardlinks: true });
    try { ownerBytes = await fsp.readFile(ownerFile); owner = JSON.parse(ownerBytes.toString('utf8')); }
    catch { throw coded('ELOCK_OWNER', 'snapshot lock owner record is malformed; preserve it for manual inspection'); }
    if (!object(owner) || owner.root !== rootAbs || owner.operation !== 'snapshot' || owner.operationId !== operationId ||
        !ID_RE.test(owner.token || '') || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.host !== os.hostname()) {
      throw coded('ELOCK_OWNER', 'lock identity does not match this local snapshot; automatic recovery is refused');
    }
    await assertClaimOwnerReference(rootAbs, owner, owner.operationId);
  }

  const journal = await readJournal(rootAbs, operationJournalPath(rootAbs, operationId));
  const txn = journal.snapshotTransaction;
  const unresolvedSnapshot = journal.operation === 'snapshot' && journal.operationId === operationId && journal.status === 'in-progress' &&
    !journal.terminalOutcome && txn && ['staging', 'prepared', 'private-ready', 'public-ready', 'publish-intent', 'published', 'verified'].includes(txn.phase);
  const terminalSnapshot = journal.operation === 'snapshot' && journal.operationId === operationId && ['in-progress', 'completed'].includes(journal.status) &&
    journal.terminalOutcome === 'verified-complete' && txn?.phase === 'committed';
  if (!(unresolvedSnapshot || terminalSnapshot)) {
    throw coded('EJOURNAL_INVALID', 'snapshot transaction is not an unresolved operation or a claim-bound committed generation');
  }
  if (owner && owner.operationId !== journal.operationId) throw coded('ELOCK_OWNER', 'snapshot lock and journal operation identities do not match');
  if (terminalSnapshot && (!owner?.claimToken || owner.claimedOperationId !== operationId || owner.resolverOperationId !== owner.operationId)) {
    throw coded('ELOCK_OWNER', 'terminal snapshot journal cannot authorize recovery without its exact resolver claim owner');
  }
  let alive = false;
  if (owner) {
    try { process.kill(owner.pid, 0); alive = true; }
    catch (error) { if (error.code === 'ESRCH') alive = false; else if (error.code === 'EPERM') alive = true; else throw error; }
  }

  const transaction = { ...txn };
  const current = await currentPointer(rootAbs, txn.name);
  const currentGeneration = current?.pointer.generation || null;
  let action;
  if (currentGeneration === txn.generation) {
    const checked = await validateSnapshot(rootAbs, txn.name, { mode: 'restore' });
    if (checked.generation !== txn.generation) throw coded('EFAILED_ROLLBACK_INCOMPLETE', 'published snapshot pointer does not resolve to the journal generation');
    action = 'published';
  } else if (currentGeneration === (txn.previousGeneration || null)) {
    if (txn.previousGeneration) await validateGenerationById(rootAbs, txn.name, txn.previousGeneration);
    action = 'not-published';
  } else if (!current && txn.previousGeneration) {
    await validateGenerationById(rootAbs, txn.name, txn.previousGeneration);
    action = 'restore-previous-pointer';
  } else if (!current && !txn.previousGeneration) {
    action = 'not-published';
  } else {
    throw coded('EFAILED_ROLLBACK_INCOMPLETE', `snapshot ${txn.name} pointer does not match either journal generation; retain all data for manual resolution`);
  }
  return { owner, ownerBytes, journal, transaction, currentGeneration, alive, action, lockDir, ownerFile };
}

async function claimInterruptedSnapshot(root, operationId) {
  const { root: rootAbs, state } = await canonicalRoot(root);
  const initial = await inspectInterruptedSnapshot(rootAbs, operationId);
  if (initial.alive) throw coded('ELOCKED', `snapshot process ${initial.owner.pid} is still active; do not recover concurrently`);
  const claim = await acquireLockClaim(rootAbs, state, await claimBinding(rootAbs, 'snapshot', operationId, initial, {
    resolverOperationId: operationId,
    allowMissingOriginalLock: initial.owner === null || !!initial.owner.claimToken,
  }));
  let lock = null;
  try {
    const inspected = await inspectInterruptedSnapshot(rootAbs, operationId);
    if (inspected.alive) throw coded('ELOCKED', `snapshot process ${inspected.owner.pid} is still active; do not recover concurrently`);
    const journalFile = operationJournalPath(rootAbs, operationId);
    const journalBytes = await fsp.readFile(journalFile);
    const fresh = await inspectInterruptedSnapshot(rootAbs, operationId);
    if (fresh.alive || JSON.stringify(fresh.journal) !== JSON.stringify(inspected.journal) || fresh.action !== inspected.action ||
        !((fresh.ownerBytes === null && inspected.ownerBytes === null) || fresh.ownerBytes?.equals(inspected.ownerBytes))) {
      throw coded('ELOCK_OWNER', 'snapshot journal, owner or process state changed during exclusive claim');
    }
    if (!(await fsp.readFile(journalFile)).equals(journalBytes)) throw coded('EJOURNAL_INVALID', 'snapshot journal bytes changed during exclusive claim');
    await assertClaimBinding(claim, rootAbs, 'snapshot', operationId, fresh);

    lock = inspected.owner
      ? await takeOverOperationLock(rootAbs, state, { inspected, claim, operation: 'snapshot', operationId, claimedOperationToken: claim.originalLockToken })
      : await createOperationLock(rootAbs, state, { operation: 'snapshot', operationId, claim });
    const reconciledJournal = await reconcileOperationJournalTemp(rootAbs, operationId, lock, inspected.journal);
    return { lock, journal: reconciledJournal, transaction: reconciledJournal.snapshotTransaction || inspected.transaction };
  } catch (error) {
    // Leave a completed owner takeover in place so a later process can prove
    // whether journal reconciliation completed before taking another action.
    throw error;
  } finally { await claim.release(); }
}

function operationJournalPath(root, operationId) {
  assertId(operationId, 'operationId');
  return path.join(path.resolve(root), STATE_DIR, 'operations', `${operationId}.json`);
}
function validateJournal(data, operationId) {
  if (!object(data) || data.schemaVersion !== 1 || data.operationId !== operationId || typeof data.operation !== 'string' || typeof data.phase !== 'string' || !Number.isFinite(Date.parse(data.updatedAt || ''))) throw coded('EJOURNAL_INVALID', 'operation journal is malformed');
  if (data.snapshot !== undefined && (!object(data.snapshot) || !NAME_RE.test(data.snapshot.name || '') || !ID_RE.test(data.snapshot.generation || ''))) throw coded('EJOURNAL_INVALID', 'operation journal snapshot reference is invalid');
  if (data.previousGeneration !== undefined && !ID_RE.test(data.previousGeneration || '')) throw coded('EJOURNAL_INVALID', 'operation journal previous generation is invalid');
  if (data.safetyPins !== undefined && (!Array.isArray(data.safetyPins) || data.safetyPins.some((p) => !object(p) || !NAME_RE.test(p.name || '') || !ID_RE.test(p.generation || '') || !ID_RE.test(p.pinId || '')))) throw coded('EJOURNAL_INVALID', 'operation journal pin references are invalid');
  if (data.safety !== undefined && (!object(data.safety) || !NAME_RE.test(data.safety.name || '') || !ID_RE.test(data.safety.generation || '') || !ID_RE.test(data.safety.pinId || ''))) throw coded('EJOURNAL_INVALID', 'operation journal safety reference is invalid');
  const gitHash = (value) => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
  const gitState = (value) => value === undefined || (object(value) && (value.head === null || gitHash(value.head)) && (value.branchRef === null || typeof value.branchRef === 'string') && (value.indexTree === null || gitHash(value.indexTree)) && object(value.refs) && Object.entries(value.refs).every(([ref, sha]) => ref.startsWith('refs/') && (sha === null || gitHash(sha))) && typeof value.clean === 'boolean');
  if (!gitState(data.preGit) || !gitState(data.postGit)) throw coded('EJOURNAL_INVALID', 'operation journal Git state is invalid');
  if (data.gitIntent !== undefined && (!object(data.gitIntent) || Object.keys(data.gitIntent).length !== 3 || Object.keys(data.gitIntent).some((key) => !['preGit', 'expectedGit', 'targets'].includes(key)) || !object(data.gitIntent.preGit) || !object(data.gitIntent.expectedGit) || !Array.isArray(data.gitIntent.targets) || data.gitIntent.targets.some((target) => typeof target !== 'string' || !safeRelative(target)) || new Set(data.gitIntent.targets).size !== data.gitIntent.targets.length || !gitState(data.gitIntent.preGit) || !gitState(data.gitIntent.expectedGit))) throw coded('EJOURNAL_INVALID', 'operation journal Git intent is invalid');
  const validSize = (value) => value === undefined || value === null || (Number.isSafeInteger(value) && value >= 0);
  const validFileIdPart = (part) => (typeof part === 'string' && /^(?:0|[1-9][0-9]*)$/.test(part)) || (Number.isSafeInteger(part) && part >= 0);
  const validFileId = (value) => value === undefined || value === null || (object(value) && validFileIdPart(value.dev) && validFileIdPart(value.ino) && Object.keys(value).every((key) => ['dev', 'ino'].includes(key)));
  if (data.appliedTargets !== undefined && (!Array.isArray(data.appliedTargets) || data.appliedTargets.some((item) => !object(item) || typeof item.target !== 'string' || !safeRelative(item.target) || typeof item.preExists !== 'boolean' || typeof item.postExists !== 'boolean' || !(item.preSha256 === null || HASH_RE.test(item.preSha256 || '')) || !(item.postSha256 === null || HASH_RE.test(item.postSha256 || '')) || !validSize(item.preSize) || !validSize(item.postSize) || !validFileId(item.preFileId) || !validFileId(item.postFileId) || Object.keys(item).some((key) => !['target', 'preExists', 'preSha256', 'preSize', 'preFileId', 'postExists', 'postSha256', 'postSize', 'postFileId'].includes(key))))) throw coded('EJOURNAL_INVALID', 'operation journal appliedTargets are invalid');
  if (data.pendingTarget !== undefined && data.pendingTarget !== null) {
    const item = data.pendingTarget;
    if (!object(item) || typeof item.target !== 'string' || !safeRelative(item.target)) throw coded('EJOURNAL_INVALID', `operation journal pendingTarget target is invalid (${JSON.stringify(item)})`);
    const pendingKeys = ['target', 'preExists', 'preSha256', 'preSize', 'preFileId', 'postExists', 'postSha256', 'postSize', 'postFileId'];
    if (Object.keys(item).some((key) => !pendingKeys.includes(key)) ||
        !['target', 'preExists', 'preSha256', 'preSize', 'postExists', 'postSha256', 'postSize'].every((key) => Object.hasOwn(item, key))) {
      throw coded('EJOURNAL_INVALID', 'operation journal pendingTarget has missing or unsupported fields');
    }
    if (typeof item.preExists !== 'boolean' || typeof item.postExists !== 'boolean') throw coded('EJOURNAL_INVALID', 'operation journal pendingTarget existence flags are invalid');
    if (!(item.preSha256 === null || HASH_RE.test(item.preSha256 || '')) || !validSize(item.preSize) || !validFileId(item.preFileId) ||
        !(item.postSha256 === null || HASH_RE.test(item.postSha256 || '')) || !validSize(item.postSize) || !validFileId(item.postFileId)) {
      throw coded('EJOURNAL_INVALID', 'operation journal pendingTarget pre/post-state is invalid');
    }
    if ((item.preExists && !HASH_RE.test(item.preSha256 || '')) || (!item.preExists && item.preSha256 !== null) ||
        (item.postExists && (!HASH_RE.test(item.postSha256 || '') || !item.postFileId)) || (!item.postExists && (item.postSha256 !== null || item.postFileId != null))) {
      throw coded('EJOURNAL_INVALID', 'operation journal pendingTarget state and proof fields conflict');
    }
  }
  if (data.pendingTemp !== undefined && data.pendingTemp !== null) {
    const item = data.pendingTemp;
    const keys = ['path', 'target', 'dev', 'ino', 'size', 'sha256', 'phase', 'previous', 'action'];
    const idPart = (value) => (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) || (Number.isSafeInteger(value) && value >= 0);
    const parts = object(item) && typeof item.path === 'string' ? item.path.split('/') : [];
    const requiredKeys = keys.filter((key) => key !== 'previous' && key !== 'action');
    const previousValid = item?.previous === undefined || (object(item.previous) && Object.keys(item.previous).length === 5 &&
      ['path', 'dev', 'ino', 'size', 'sha256'].every((key) => Object.hasOwn(item.previous, key)) && safeRelative(item.previous.path) &&
      item.previous.path.startsWith(`staging/${operationId}/private/`) && idPart(item.previous.dev) && idPart(item.previous.ino) &&
      Number.isSafeInteger(item.previous.size) && item.previous.size >= 0 && HASH_RE.test(item.previous.sha256 || ''));
    if (!object(item) || requiredKeys.some((key) => !Object.hasOwn(item, key)) || Object.keys(item).some((key) => !keys.includes(key)) || !previousValid || !safeRelative(item.path) ||
        !item.path.startsWith(`staging/${operationId}/private/`) || parts.length < 4 ||
        typeof item.target !== 'string' || !safeRelative(item.target) || !idPart(item.dev) || !idPart(item.ino) ||
        !Number.isSafeInteger(item.size) || item.size < 0 || !HASH_RE.test(item.sha256 || '') ||
        !['prepared', 'published'].includes(item.phase) || (item.action !== undefined && item.action !== 'retire-target')) {
      throw coded('EJOURNAL_INVALID', 'operation journal pendingTemp must identify one private staged file and its exact target, identity, digest, size and phase');
    }
  }
  if (data.resolvesOperationId !== undefined && !ID_RE.test(data.resolvesOperationId || '')) throw coded('EJOURNAL_INVALID', 'operation journal resolvesOperationId is invalid');
  if (data.resolvedBy !== undefined && !ID_RE.test(data.resolvedBy || '')) throw coded('EJOURNAL_INVALID', 'operation journal resolvedBy is invalid');
  const allowedStageOwners = new Set([operationId, data.resolvesOperationId].filter((value) => typeof value === 'string' && ID_RE.test(value)));
  if (data.cleanupPending !== undefined && (!Array.isArray(data.cleanupPending) || data.cleanupPending.some((item) => {
    if (!object(item) || typeof item.kind !== 'string' || typeof item.reason !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.reason)) return true;
    if (item.kind === 'release-restore-target-pin') return Object.keys(item).length !== 5 || !NAME_RE.test(item.name || '') || !ID_RE.test(item.generation || '') || !ID_RE.test(item.pinId || '');
    if (item.kind === 'resolve-original-safety-pin') return Object.keys(item).length !== 6 || !ID_RE.test(item.operationId || '') || !NAME_RE.test(item.name || '') || !ID_RE.test(item.generation || '') || !ID_RE.test(item.pinId || '');
    if (item.kind === 'remove-private-restore-staging') {
      const owner = typeof item.path === 'string' ? item.path.split('/')[1] : '';
      return Object.keys(item).some((key) => !['kind', 'path', 'target', 'dev', 'ino', 'size', 'sha256', 'reason', 'previous', 'action'].includes(key)) || ![8, 9, 10].includes(Object.keys(item).length) || !safeRelative(item.path) || !allowedStageOwners.has(owner) || !new RegExp(`^staging/${owner}/private/(?:restore|retire)-[a-f0-9]{32}\\.tmp$`).test(item.path) || typeof item.target !== 'string' || !safeRelative(item.target) || !validFileIdPart(item.dev) || !validFileIdPart(item.ino) || !validSize(item.size) || !HASH_RE.test(item.sha256 || '') || (item.action !== undefined && item.action !== 'retire-target') || (item.previous !== undefined && (!object(item.previous) || Object.keys(item.previous).length !== 5 || item.previous.path !== `${item.path}.previous` || !validFileIdPart(item.previous.dev) || !validFileIdPart(item.previous.ino) || !validSize(item.previous.size) || !HASH_RE.test(item.previous.sha256 || '')));
    }
    return true;
  }))) throw coded('EJOURNAL_INVALID', 'operation journal cleanupPending contains an invalid action');
  if (data.status !== undefined && !['in-progress', 'completed', 'failed-rolled-back', 'failed-rollback-incomplete', 'retired', 'resolved'].includes(data.status)) throw coded('EJOURNAL_INVALID', 'operation journal status is invalid');
  if (data.pruneTransaction !== undefined) {
    const txn = data.pruneTransaction;
    const fileId = (value) => object(value) && Object.keys(value).length === 2 &&
      ['dev', 'ino'].every((key) => (typeof value[key] === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value[key])) || (Number.isSafeInteger(value[key]) && value[key] >= 0));
    const rowKeys = ['name', 'generation', 'kind', 'createdAt', 'pointerSha256', 'pointerSize', 'pointerFileId', 'publicDirId', 'privateDirId', 'phase', 'retiredDirId'];
    const validRow = (row) => object(row) && Object.keys(row).every((key) => rowKeys.includes(key)) &&
      ['name', 'generation', 'kind', 'createdAt', 'pointerSha256', 'pointerSize', 'pointerFileId', 'publicDirId', 'privateDirId', 'phase'].every((key) => Object.hasOwn(row, key)) &&
      NAME_RE.test(row.name || '') && ID_RE.test(row.generation || '') && ['auto', 'hook'].includes(row.kind) &&
      typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt)) && HASH_RE.test(row.pointerSha256 || '') &&
      Number.isSafeInteger(row.pointerSize) && row.pointerSize >= 0 && fileId(row.pointerFileId) && fileId(row.publicDirId) && fileId(row.privateDirId) &&
      ['planned', 'retiring', 'committed', 'retired'].includes(row.phase) && (row.retiredDirId === undefined || fileId(row.retiredDirId));
    const refs = Array.isArray(txn?.completed) ? txn.completed : [];
    const retiredKeys = Array.isArray(txn?.planned) ? txn.planned.filter((row) => row?.phase === 'retired').map((row) => `${row.name}\0${row.generation}`) : [];
    const completedKeys = refs.map((ref) => object(ref) && typeof ref.name === 'string' && typeof ref.generation === 'string' ? `${ref.name}\0${ref.generation}` : '');
    const plannedByKey = new Map(Array.isArray(txn?.planned) ? txn.planned.map((row) => [`${row?.name}\0${row?.generation}`, row]) : []);
    const completedKeySet = new Set(completedKeys);
    if (!object(txn) || Object.keys(txn).some((key) => !['phase', 'originalLockToken', 'planned', 'completed'].includes(key)) ||
        !['phase', 'originalLockToken', 'planned', 'completed'].every((key) => Object.hasOwn(txn, key)) ||
        !['planned', 'committed', 'cleanup-pending', 'completed', 'aborted'].includes(txn.phase) || !ID_RE.test(txn.originalLockToken || '') ||
        !Array.isArray(txn.planned) || txn.planned.some((row) => !validRow(row)) ||
        plannedByKey.size !== txn.planned.length ||
        !Array.isArray(txn.completed) || refs.some((ref) => !object(ref) || Object.keys(ref).length !== 2 || !NAME_RE.test(ref.name || '') || !ID_RE.test(ref.generation || '') ||
          plannedByKey.get(`${ref.name}\0${ref.generation}`)?.phase !== 'retired') ||
        completedKeySet.size !== completedKeys.length || completedKeys.length !== retiredKeys.length ||
        retiredKeys.some((key) => !completedKeySet.has(key)) ||
        (data.operation !== 'prune') ||
        (txn.phase === 'completed' && (data.status !== 'completed' || data.terminalOutcome !== 'verified-complete' || txn.planned.some((row) => row.phase !== 'retired') || txn.completed.length !== txn.planned.length)) ||
        (data.status === 'completed' && (txn.phase !== 'completed' || data.terminalOutcome !== 'verified-complete')) ||
        (data.status === 'in-progress' && (txn.phase === 'completed' || data.terminalOutcome === 'verified-complete'))) throw coded('EJOURNAL_INVALID', 'prune transaction journal is malformed');
  }
  if (data.snapshotTransaction !== undefined && (!object(data.snapshotTransaction) || Object.keys(data.snapshotTransaction).some((key) => !['name', 'generation', 'previousGeneration', 'phase'].includes(key)) || !NAME_RE.test(data.snapshotTransaction.name || '') || !ID_RE.test(data.snapshotTransaction.generation || '') || !(data.snapshotTransaction.previousGeneration === null || ID_RE.test(data.snapshotTransaction.previousGeneration || '')) || !['staging', 'prepared', 'private-ready', 'public-ready', 'publish-intent', 'published', 'verified', 'committed', 'failed-rolled-back', 'failed-rollback-incomplete'].includes(data.snapshotTransaction.phase))) throw coded('EJOURNAL_INVALID', 'snapshot transaction journal is invalid');
  return data;
}

function prunePlanIdentity(rows) {
  const immutable = ['name', 'generation', 'kind', 'createdAt', 'pointerSha256', 'pointerSize', 'pointerFileId', 'publicDirId', 'privateDirId'];
  return rows.map((row) => Object.fromEntries(immutable.map((key) => [key, row[key]])));
}

function validatePruneProgression(previous, candidate) {
  const before = previous?.pruneTransaction;
  const after = candidate?.pruneTransaction;
  if (!before || !after || previous.operationId !== candidate.operationId || previous.operation !== 'prune' || candidate.operation !== 'prune' ||
      before.originalLockToken !== after.originalLockToken || JSON.stringify(prunePlanIdentity(before.planned)) !== JSON.stringify(prunePlanIdentity(after.planned))) {
    throw coded('EJOURNAL_INVALID', 'prune journal update changes its immutable operation owner or generation plan');
  }
  const rowRank = { planned: 0, retiring: 1, committed: 2, retired: 3 };
  const txnRank = { planned: 0, committed: 1, 'cleanup-pending': 2, completed: 3, aborted: 3 };
  let advanced = (txnRank[after.phase] ?? -1) > (txnRank[before.phase] ?? -1);
  if ((txnRank[after.phase] ?? -1) < (txnRank[before.phase] ?? -1)) throw coded('EJOURNAL_INVALID', 'prune transaction phase regressed');
  for (let index = 0; index < before.planned.length; index += 1) {
    const oldRow = before.planned[index];
    const newRow = after.planned[index];
    const oldRank = rowRank[oldRow.phase] ?? -1;
    const newRank = rowRank[newRow.phase] ?? -1;
    if (newRank < oldRank || newRank > oldRank + 1) throw coded('EJOURNAL_INVALID', `prune target ${oldRow.name} has a skipped or regressing phase`);
    if (oldRow.retiredDirId && JSON.stringify(oldRow.retiredDirId) !== JSON.stringify(newRow.retiredDirId)) throw coded('EJOURNAL_INVALID', `prune target ${oldRow.name} changed its retired-directory identity`);
    if (newRank > oldRank) advanced = true;
  }
  const beforeCompleted = new Set(before.completed.map((row) => `${row.name}\0${row.generation}`));
  const afterCompleted = new Set(after.completed.map((row) => `${row.name}\0${row.generation}`));
  if ([...beforeCompleted].some((key) => !afterCompleted.has(key))) throw coded('EJOURNAL_INVALID', 'prune completion set regressed');
  if (afterCompleted.size > beforeCompleted.size) advanced = true;
  if (!advanced) throw coded('EJOURNAL_INVALID', 'prune journal temporary does not prove a new legal progress transition');
  return true;
}

async function writeOperationJournal(root, lock, data) {
  await assertLock(root, lock);
  if (!object(data) || data.operationId !== lock.operationId) throw coded('EJOURNAL_INVALID', 'journal operationId must match the lock');
  const allowed = new Set(['operationId', 'operation', 'phase', 'snapshot', 'previousGeneration', 'safetyPins', 'safety', 'appliedTargets', 'pendingTarget', 'pendingTemp', 'preGit', 'postGit', 'gitIntent', 'status', 'terminalOutcome', 'compensationOutcome', 'cleanupPending', 'retirements', 'snapshotTransaction', 'pruneTransaction', 'resolvesOperationId', 'resolvedBy']);
  for (const key of Object.keys(data)) if (!allowed.has(key)) throw coded('EJOURNAL_INVALID', `unsupported journal field: ${key}`);
  const journalFile = operationJournalPath(root, lock.operationId);
  const prior = await fsp.lstat(journalFile).then(() => readJournal(root, journalFile), (error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const nextTimestamp = Math.max(Date.now(), Date.parse(prior?.updatedAt || '') + 1 || 0);
  const clean = { ...(prior || {}), ...data, schemaVersion: 1, updatedAt: new Date(nextTimestamp).toISOString() };
  validateJournal(clean, lock.operationId);
  if (prior?.operation === 'prune' && prior.pruneTransaction && clean.pruneTransaction) validatePruneProgression(prior, clean);
  const dir = path.join(path.resolve(root), STATE_DIR, 'operations');
  await ensureRealDirectory(path.join(path.resolve(root), STATE_DIR), dir);
  const file = operationJournalPath(root, lock.operationId);
  await assertNoLinks(file, { hardlinks: true });
  const tmp = `${file}.${randomId()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(clean, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { await fsp.rename(tmp, file); } catch (error) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw error; }
  return file;
}

async function readJournal(root, file) {
  await assertNoLinks(file, { allowMissing: false, hardlinks: true });
  let data; try { data = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { throw coded('EJOURNAL_INVALID', `operation journal is malformed: ${path.basename(file)}`); }
  return validateJournal(data, path.basename(file, '.json'));
}

async function pinSnapshot(root, { name, generation, operationId, reason = 'rollback-needed' }) {
  assertName(name); assertId(generation, 'generation'); assertId(operationId, 'operationId');
  if (!['restore-target', 'rollback-needed', 'unresolved-operation', 'manual'].includes(reason)) throw coded('EPIN_INVALID', 'pin reason is not supported');
  const checked = await validateGenerationById(root, name, generation);
  const pinId = randomId();
  const base = path.join(path.resolve(root), STATE_DIR, 'pins', name, generation);
  await ensureRealDirectory(path.join(path.resolve(root), STATE_DIR), base);
  const file = path.join(base, `${pinId}.json`);
  await fsp.writeFile(file, JSON.stringify({ schemaVersion: 1, name, generation, pinId, operationId, reason, createdAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  return { name, generation, pinId, path: file, manifest: checked.manifest };
}

async function validateGenerationById(root, name, generation) {
  const P = snapshotPaths(root, name, generation);
  return validateGenerationPair(root, name, generation, P.publicGenerationDir, P.privateGenerationDir);
}

async function readPinFile(file, name, generation) {
  await assertNoLinks(file, { allowMissing: false, hardlinks: true });
  let pin; try { pin = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { throw coded('EPIN_INVALID', `pin record is malformed: ${path.basename(file)}`); }
  if (!object(pin) || pin.schemaVersion !== 1 || pin.name !== name || pin.generation !== generation || !ID_RE.test(pin.pinId || '') || !ID_RE.test(pin.operationId || '') || path.basename(file) !== `${pin.pinId}.json`) throw coded('EPIN_INVALID', `pin record does not match its path: ${path.basename(file)}`);
  return pin;
}
async function listPins(root) {
  const base = path.join(path.resolve(root), STATE_DIR, 'pins');
  try { await assertNoLinks(base, { allowMissing: false }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const out = [];
  for (const name of await fsp.readdir(base)) {
    assertName(name);
    const nameDir = path.join(base, name); await assertNoLinks(nameDir, { allowMissing: false });
    for (const generation of await fsp.readdir(nameDir)) {
      assertId(generation, 'pin generation');
      const generationDir = path.join(nameDir, generation); await assertNoLinks(generationDir, { allowMissing: false });
      for (const fileName of await fsp.readdir(generationDir)) {
        if (!fileName.endsWith('.json')) throw coded('EPIN_INVALID', `unexpected file in pin directory: ${fileName}`);
        out.push(await readPinFile(path.join(generationDir, fileName), name, generation));
      }
    }
  }
  return out;
}
async function unpinSnapshot(root, { name, generation, pinId, lock, terminalOutcome }) {
  await assertLock(root, lock);
  assertName(name); assertId(generation, 'generation'); assertId(pinId, 'pinId');
  if (!['verified-complete', 'explicit-resolution'].includes(terminalOutcome)) throw coded('EPIN_HELD', 'pin release requires verified completion or explicit resolution');
  const file = path.join(path.resolve(root), STATE_DIR, 'pins', name, generation, `${pinId}.json`);
  const journalFile = operationJournalPath(root, lock.operationId);
  const journal = await fsp.lstat(journalFile).then(() => readJournal(root, journalFile), (error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const verified = journal && ['verified-complete', 'completed', 'failed-rolled-back'].includes(journal.terminalOutcome || journal.status || journal.phase);
  if (!verified && terminalOutcome !== 'explicit-resolution') throw coded('EPIN_HELD', 'operation journal does not prove a terminal verified result');
  const referenced = (journal?.safetyPins || []).some((item) => item.name === name && item.generation === generation && item.pinId === pinId) ||
    (journal?.safety?.name === name && journal.safety.generation === generation && journal.safety.pinId === pinId);
  let pin;
  try { pin = await readPinFile(file, name, generation); }
  catch (error) {
    if (error.code === 'ENOENT' && referenced && terminalOutcome === 'verified-complete') return { released: false, alreadyReleased: true };
    throw error;
  }
  if (pin.operationId !== lock.operationId) throw coded('EPIN_INVALID', 'pin ownership does not match this operation');
  await fsp.unlink(file);
  try { await fsp.rmdir(path.dirname(file)); await fsp.rmdir(path.dirname(path.dirname(file))); } catch { /* other pins or generations remain */ }
  return true;
}

// Resolve a different restore's rollback-needed pin only after the current,
// authenticated lock owns a terminal verified rollback journal that names it.
// The old journal is marked first; a retry after a crash can safely finish the
// exact pin deletion. No other pin or generation is touched.
async function resolveRollbackPin(root, { operationId, safety, lock }) {
  await assertLock(root, lock);
  assertId(operationId, 'operationId');
  if (!object(safety) || !NAME_RE.test(safety.name || '') || !ID_RE.test(safety.generation || '') || !ID_RE.test(safety.pinId || '')) throw coded('EPIN_INVALID', 'rollback safety reference is incomplete');
  const resolver = await fsp.lstat(operationJournalPath(root, lock.operationId)).then(() => readJournal(root, operationJournalPath(root, lock.operationId)), (error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!resolver || resolver.operation !== 'restore' || resolver.resolvesOperationId !== operationId || !['verified-complete', 'resolved-by-rollback'].includes(resolver.terminalOutcome)) throw coded('EPIN_HELD', 'current rollback journal does not prove verified resolution');
  const originalFile = operationJournalPath(root, operationId);
  const original = await fsp.lstat(originalFile).then(() => readJournal(root, originalFile), (error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!original || original.operation !== 'restore' || original.operationId !== operationId || original.safety?.name !== safety.name || original.safety?.generation !== safety.generation || original.safety?.pinId !== safety.pinId) throw coded('EPIN_INVALID', 'original journal does not own the exact safety pin');
  const pinFile = path.join(path.resolve(root), STATE_DIR, 'pins', safety.name, safety.generation, `${safety.pinId}.json`);
  let pin;
  try { pin = await readPinFile(pinFile, safety.name, safety.generation); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (original.terminalOutcome === 'resolved-by-rollback' && original.resolvedBy === lock.operationId) return { released: false, alreadyResolved: true };
    throw coded('EPIN_INVALID', 'the exact original safety pin is missing before resolution');
  }
  if (pin.operationId !== operationId || pin.reason !== 'rollback-needed') throw coded('EPIN_INVALID', 'safety pin ownership or reason does not match the original operation');
  if (original.terminalOutcome && original.terminalOutcome !== 'verified-complete' && original.terminalOutcome !== 'resolved-by-rollback') throw coded('EPIN_HELD', 'original operation is already in a non-resolvable terminal state');
  const updated = { ...original, status: 'resolved', phase: 'resolved', terminalOutcome: 'resolved-by-rollback', resolvedBy: lock.operationId, pendingTarget: null, pendingTemp: null, updatedAt: new Date().toISOString() };
  validateJournal(updated, operationId);
  const tmp = `${originalFile}.${randomId()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { await fsp.rename(tmp, originalFile); } catch (error) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw error; }
  await assertLock(root, lock);
  const still = await readPinFile(pinFile, safety.name, safety.generation);
  if (still.operationId !== operationId) throw coded('EPIN_INVALID', 'safety pin ownership changed during resolution');
  await fsp.unlink(pinFile);
  try { await fsp.rmdir(path.dirname(pinFile)); await fsp.rmdir(path.dirname(path.dirname(pinFile))); } catch { /* retain shared pin directories */ }
  return { released: true, alreadyResolved: false };
}

async function completeCleanupAction(root, { lock, operationId, action }) {
  await assertLock(root, lock);
  assertId(operationId, 'operationId');
  if (!object(action)) throw coded('EJOURNAL_INVALID', 'cleanup action must be an object');
  const journal = await readJournal(root, operationJournalPath(root, operationId));
  if (lock.operationId !== operationId || journal.operation !== 'restore' || journal.status !== 'completed' || journal.terminalOutcome !== 'verified-complete' || !(journal.cleanupPending || []).some((item) => JSON.stringify(item) === JSON.stringify(action))) {
    throw coded('EPIN_HELD', 'cleanup action is not authorized by this completed operation journal');
  }
  if (action.kind === 'release-restore-target-pin') {
    await unpinSnapshot(root, { name: action.name, generation: action.generation, pinId: action.pinId, lock, terminalOutcome: 'verified-complete' });
    return { completed: true, alreadyCompleted: false };
  }
  if (action.kind === 'resolve-original-safety-pin') {
    const originalPath = operationJournalPath(root, action.operationId);
    const originalJournal = await readJournal(root, originalPath);
    // Resolving a rollback writes a second journal (the original operation's).
    // If the process stops between its temp write and rename, reconcile that
    // exact sibling before attempting the idempotent pin action again.
    await reconcileRestoreJournalTemp(root, action.operationId, lock, originalJournal);
    return { completed: true, ...(await resolveRollbackPin(root, { operationId: action.operationId, safety: action, lock })) };
  }
  if (action.kind === 'remove-private-restore-staging') {
    const base = path.resolve(root, STATE_DIR, 'staging') + path.sep;
    const removeExact = async (record) => {
      const absolute = path.resolve(root, STATE_DIR, ...record.path.split('/'));
      if (!absolute.startsWith(base)) throw coded('EUNSAFE_PATH', 'cleanup staging path escaped the private staging root');
      await assertNoLinks(absolute, { allowMissing: true, hardlinks: true });
      let stat;
      try { stat = await fsp.lstat(absolute, { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      if (!stat.isFile() || stat.nlink > 1n || stat.dev.toString() !== String(record.dev) || stat.ino.toString() !== String(record.ino) || stat.size !== BigInt(record.size)) throw coded('EROLLBACK_PROOF', 'private restore staging identity changed; retained for manual resolution');
      const bytes = await fsp.readFile(absolute);
      if (hash(bytes) !== record.sha256) throw coded('EROLLBACK_PROOF', 'private restore staging digest changed; retained for manual resolution');
      await fsp.unlink(absolute);
      return true;
    };
    const primary = await removeExact(action);
    const previous = action.previous ? await removeExact(action.previous) : false;
    return { completed: true, alreadyCompleted: !primary && !previous };
  }
  throw coded('EJOURNAL_INVALID', `unsupported cleanup action: ${action.kind}`);
}

function generationKey(name, generation) { return `${name}\0${generation}`; }
async function generationProtectionIndex(root, { ignorePruneOperationId = null } = {}) {
  const protectedSet = new Set();
  const addJournalProtections = (journal) => {
    const terminal = ['verified-complete', 'completed', 'failed-rolled-back', 'resolved-by-rollback'].includes(journal.terminalOutcome || journal.status || journal.phase);
    const tx = journal.snapshotTransaction;
    const unresolvedTx = tx && !['committed', 'failed-rolled-back'].includes(tx.phase);
    for (const action of journal.cleanupPending || []) {
      if (['release-restore-target-pin', 'resolve-original-safety-pin'].includes(action.kind)) protectedSet.add(generationKey(action.name, action.generation));
    }
    if (journal.operation === 'prune' && journal.pruneTransaction && journal.status === 'in-progress' && journal.operationId !== ignorePruneOperationId) {
      for (const row of journal.pruneTransaction.planned) protectedSet.add(generationKey(row.name, row.generation));
    }
    if (!terminal) {
      if (journal.snapshot?.name && journal.snapshot?.generation) protectedSet.add(generationKey(journal.snapshot.name, journal.snapshot.generation));
      if (journal.snapshot?.name && journal.previousGeneration) protectedSet.add(generationKey(journal.snapshot.name, journal.previousGeneration));
      if (journal.safety?.name && journal.safety?.generation) protectedSet.add(generationKey(journal.safety.name, journal.safety.generation));
      for (const pin of journal.safetyPins || []) protectedSet.add(generationKey(pin.name, pin.generation));
    }
    if (unresolvedTx) {
      if (tx.name && tx.generation) protectedSet.add(generationKey(tx.name, tx.generation));
      if (tx.name && tx.previousGeneration) protectedSet.add(generationKey(tx.name, tx.previousGeneration));
    }
  };
  const pins = await listPins(root);
  for (const pin of pins) protectedSet.add(generationKey(pin.name, pin.generation));
  const operations = path.join(path.resolve(root), STATE_DIR, 'operations');
  try {
    await assertNoLinks(operations, { allowMissing: false });
    for (const file of await fsp.readdir(operations)) {
      if (!file.endsWith('.json')) {
        if (ignorePruneOperationId && new RegExp(`^${ignorePruneOperationId}\\.json\\.[a-f0-9]{32}\\.tmp$`).test(file)) continue;
        const pendingMatch = /^([a-f0-9]{32})\.json\.[a-f0-9]{32}\.tmp$/.exec(file);
        if (!pendingMatch) throw coded('EJOURNAL_INVALID', `unexpected operation file: ${file}`);
        const pendingPath = path.join(operations, file);
        await assertNoLinks(pendingPath, { allowMissing: false, hardlinks: true });
        let pending;
        try { pending = validateJournal(JSON.parse(await fsp.readFile(pendingPath, 'utf8')), pendingMatch[1]); }
        catch (error) { throw coded('EJOURNAL_INVALID', `invalid pending operation journal ${file}: ${error.message}`); }
        addJournalProtections(pending);
        continue;
      }
      const journal = await readJournal(root, path.join(operations, file));
      addJournalProtections(journal);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return protectedSet;
}
async function isGenerationProtected(root, name, generation, options = {}) {
  assertName(name); assertId(generation, 'generation');
  return (await generationProtectionIndex(root, options)).has(generationKey(name, generation));
}

async function currentPointer(root, name) {
  const P = snapshotPaths(root, name);
  try {
    await assertNoLinks(P.currentFile, { allowMissing: false, hardlinks: true });
    const bytes = await fsp.readFile(P.currentFile);
    let pointer; try { pointer = JSON.parse(bytes.toString('utf8')); } catch { throw coded('EMANIFEST_INVALID', 'current pointer is malformed'); }
    if (!object(pointer) || Object.keys(pointer).some((key) => !['schemaVersion', 'name', 'generation', 'publicManifestSha256'].includes(key)) || pointer.schemaVersion !== 1 || pointer.name !== name || !ID_RE.test(pointer.generation || '') || !HASH_RE.test(pointer.publicManifestSha256 || '')) throw coded('EMANIFEST_INVALID', 'current pointer identity is invalid');
    return { pointer, bytes, paths: P };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function publishPointer(root, name, generation, publicManifestSha256, operationId) {
  const P = snapshotPaths(root, name, generation);
  const parent = path.dirname(P.currentFile);
  await ensureRealDirectory(path.join(path.resolve(root), STATE_DIR), parent);
  const pointer = { schemaVersion: 1, name, generation, publicManifestSha256 };
  const tmp = path.join(parent, `.current-${operationId}-${randomId()}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(pointer, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await assertNoLinks(P.currentFile, { hardlinks: true });
  try { await fsp.rename(tmp, P.currentFile); }
  catch (error) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw error; }
  return pointer;
}

async function writeJournalForLock(root, lock, fields) {
  return writeOperationJournal(root, lock, { operationId: lock.operationId, operation: lock.operation, ...fields });
}

async function writeSnapshotTransaction(root, lock, base, phase, extra = {}) {
  const priorFile = operationJournalPath(root, lock.operationId);
  const prior = await fsp.lstat(priorFile).then(() => readJournal(root, priorFile), (error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const { terminalOutcome, compensationOutcome, ...transactionFields } = extra;
  const txn = { ...base, phase, ...transactionFields };
  const data = {
    operationId: lock.operationId,
    operation: prior?.operation || lock.operation,
    phase: prior?.phase || 'snapshotting',
    snapshotTransaction: txn,
  };
  if (!prior) data.status = 'in-progress';
  if (lock.operation === 'snapshot') {
    data.phase = phase;
    if (terminalOutcome) data.terminalOutcome = terminalOutcome;
    if (compensationOutcome) data.compensationOutcome = compensationOutcome;
  }
  return writeOperationJournal(root, lock, data);
}

async function beginSnapshotTransaction(root, lock, { name, generation, previousGeneration = null }) {
  await assertLock(root, lock);
  assertName(name); assertId(generation, 'generation');
  if (previousGeneration !== null) {
    assertId(previousGeneration, 'previousGeneration');
    await validateGenerationById(root, name, previousGeneration);
  }
  const journalPath = operationJournalPath(root, lock.operationId);
  const exists = await fsp.lstat(journalPath).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error));
  if (exists) throw coded('EJOURNAL_INVALID', 'new snapshot transaction cannot reuse an existing operation journal');
  return writeSnapshotTransaction(root, lock, { name, generation, previousGeneration }, 'staging');
}

async function commitSnapshotGeneration(root, lock, { name, generation, stagePublic, stagePrivate, overwrite = false }) {
  assertName(name); assertId(generation, 'generation'); await assertLock(root, lock);
  const P = snapshotPaths(root, name, generation);
  const snapshotParent = path.dirname(P.snapDir);
  const privateParent = path.dirname(P.legacySecretsDir);
  await ensureRealDirectory(path.join(path.resolve(root), STATE_DIR), snapshotParent);
  await ensureRealDirectory(path.join(path.resolve(root), STATE_DIR), privateParent);
  const existing = await currentPointer(root, name);
  if (existing && !overwrite) throw coded('EEXISTS', `snapshot already exists: ${name}`);
  if (!existing) {
    const legacyManifest = path.join(P.snapDir, 'manifest.json');
    try { await fsp.lstat(legacyManifest); throw coded('EEXISTS', `legacy snapshot occupies this name and is not overwritten: ${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (existing) await validateSnapshot(root, name, { mode: 'restore' });
  for (const dest of [P.publicGenerationDir, P.privateGenerationDir]) {
    await assertNoLinks(dest);
    try { await fsp.lstat(dest); throw coded('EEXISTS', `generation already exists: ${generation}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const oldGeneration = existing?.pointer.generation || null;
  const journalBase = { name, generation, previousGeneration: oldGeneration };
  await writeSnapshotTransaction(root, lock, journalBase, 'prepared');
  const pubGenParent = path.dirname(P.publicGenerationDir);
  const privGenParent = path.dirname(P.privateGenerationDir);
  await ensureRealDirectory(path.join(path.resolve(root), STATE_DIR), pubGenParent);
  await ensureRealDirectory(path.join(path.resolve(root), STATE_DIR), privGenParent);
  let privateInstalled = false; let publicInstalled = false; let pointerPublished = false;
  try {
    await fsp.rename(stagePrivate, P.privateGenerationDir); privateInstalled = true;
    await writeSnapshotTransaction(root, lock, journalBase, 'private-ready');
    await fsp.rename(stagePublic, P.publicGenerationDir); publicInstalled = true;
    const stagedPair = await validateGenerationPair(root, name, generation, P.publicGenerationDir, P.privateGenerationDir);
    await writeSnapshotTransaction(root, lock, journalBase, 'public-ready');
    await writeSnapshotTransaction(root, lock, journalBase, 'publish-intent');
    await publishPointer(root, name, generation, hash(stagedPair.publicBytes), lock.operationId);
    pointerPublished = true;
    await writeSnapshotTransaction(root, lock, journalBase, 'published');
    const verified = await validateSnapshot(root, name, { mode: 'restore' });
    if (verified.generation !== generation) throw coded('EARTIFACT_INTEGRITY', 'published generation does not resolve as current');
    await writeSnapshotTransaction(root, lock, journalBase, 'verified');
    await writeSnapshotTransaction(root, lock, journalBase, 'committed', { terminalOutcome: 'verified-complete' });
    return { verified, previousGeneration: oldGeneration, cleanupPending: false };
  } catch (error) {
    let rollbackVerified = false;
    try {
      const now = await currentPointer(root, name);
      if (!pointerPublished && (!now || now.pointer.generation === oldGeneration)) {
        rollbackVerified = oldGeneration ? (await validateGenerationById(root, name, oldGeneration)).publicManifest.generation === oldGeneration : !now;
      } else if (pointerPublished && now?.pointer.generation === generation) {
        if (oldGeneration) {
          const old = await validateGenerationById(root, name, oldGeneration);
          await publishPointer(root, name, oldGeneration, hash(old.publicBytes), lock.operationId);
          const checkedOld = await validateSnapshot(root, name, { mode: 'restore' });
          rollbackVerified = checkedOld.generation === oldGeneration;
        } else {
          await fsp.unlink(P.currentFile);
          rollbackVerified = !(await currentPointer(root, name));
        }
      }
    } catch { rollbackVerified = false; }
    if (rollbackVerified) {
      await writeSnapshotTransaction(root, lock, journalBase, 'failed-rolled-back', { terminalOutcome: 'failed-rolled-back', compensationOutcome: 'verified' }).catch(() => {});
      // New files are unreachable and validated by exact generation identity.
      // Cleanup is best effort; any residue is retained for later inspection.
      if (publicInstalled) await fsp.rm(P.publicGenerationDir, { recursive: true, force: true }).catch(() => {});
      if (privateInstalled) await fsp.rm(P.privateGenerationDir, { recursive: true, force: true }).catch(() => {});
      error.rollback = 'verified';
    } else {
      await writeSnapshotTransaction(root, lock, journalBase, 'failed-rollback-incomplete', { compensationOutcome: 'unverified' }).catch(() => {});
      if (oldGeneration) await persistPin(root, name, oldGeneration, lock.operationId, 'unresolved-operation').catch(() => {});
      error.code = 'EFAILED_ROLLBACK_INCOMPLETE';
      error.message = `${error.message}; generation commit compensation could not be verified; operation journal and generations were retained`;
    }
    throw error;
  }
}

async function persistPin(root, name, generation, operationId, reason) {
  const pinId = randomId();
  const base = path.join(path.resolve(root), STATE_DIR, 'pins', name, generation);
  await ensureRealDirectory(path.join(path.resolve(root), STATE_DIR), base);
  const file = path.join(base, `${pinId}.json`);
  await fsp.writeFile(file, JSON.stringify({ schemaVersion: 1, name, generation, pinId, operationId, reason, createdAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  return { name, generation, pinId, path: file };
}

async function recoverSnapshotTransactions(root, lock, operationId) {
  await assertLock(root, lock);
  if (operationId !== undefined) {
    assertId(operationId, 'operationId');
    if (lock.operationId !== operationId || lock.operation !== 'snapshot') throw coded('ELOCK_OWNER', 'snapshot recovery lock must own the requested snapshot operation id');
  }
  const dir = path.join(path.resolve(root), STATE_DIR, 'operations');
  try { await assertNoLinks(dir, { allowMissing: false }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  let candidates;
  if (operationId) candidates = [`${operationId}.json`];
  else {
    candidates = [];
    for (const fileName of await fsp.readdir(dir)) {
      if (!fileName.endsWith('.json')) throw coded('EJOURNAL_INVALID', `unexpected operation entry: ${fileName}`);
      const journal = await readJournal(root, path.join(dir, fileName));
      const txn = journal.snapshotTransaction;
      const unresolved = txn && !['committed', 'failed-rolled-back'].includes(txn.phase) && !txn.terminalOutcome;
      if (!unresolved) continue;
      if (journal.operation !== 'snapshot' || journal.status !== 'in-progress') throw coded('EJOURNAL_INVALID', `unresolved snapshot transaction has an invalid owner/status: ${fileName}`);
      if (journal.operationId !== lock.operationId) {
        throw coded('ELOCKED', `unresolved snapshot operation ${journal.operationId} is not owned by this lock; inspect and explicitly recover it with its operation id`);
      }
      candidates.push(fileName);
    }
  }
  const recovered = [];
  for (const fileName of candidates) {
    if (operationId && !(await fsp.lstat(path.join(dir, fileName)).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error)))) throw coded('EJOURNAL_INVALID', `snapshot journal not found: ${operationId}`);
    if (!fileName.endsWith('.json')) throw coded('EJOURNAL_INVALID', `unexpected operation entry: ${fileName}`);
    const file = path.join(dir, fileName); const journal = await readJournal(root, file);
    const txn = journal.snapshotTransaction;
    if (operationId && (journal.operation !== 'snapshot' || !txn)) throw coded('EJOURNAL_INVALID', `requested operation is not a snapshot transaction: ${operationId}`);
    if (operationId && journal.operation === 'snapshot' && journal.terminalOutcome === 'verified-complete' && txn?.phase === 'committed') {
      const current = await currentPointer(root, txn.name);
      if (current?.pointer.generation !== txn.generation) throw coded('EFAILED_ROLLBACK_INCOMPLETE', 'terminal snapshot journal does not match the current committed pointer');
      const checked = await validateSnapshot(root, txn.name, { mode: 'restore' });
      if (checked.generation !== txn.generation) throw coded('EFAILED_ROLLBACK_INCOMPLETE', 'terminal snapshot generation failed validation');
      recovered.push({ operationId: journal.operationId, action: 'already-committed', generation: txn.generation });
      continue;
    }
    if (operationId && journal.operation === 'snapshot' && journal.terminalOutcome === 'failed-rolled-back' && txn?.phase === 'failed-rolled-back') {
      const current = await currentPointer(root, txn.name);
      if ((current?.pointer.generation || null) !== (txn.previousGeneration || null)) throw coded('EFAILED_ROLLBACK_INCOMPLETE', 'terminal failed snapshot journal does not match the preserved pointer');
      if (txn.previousGeneration) await validateGenerationById(root, txn.name, txn.previousGeneration);
      recovered.push({ operationId: journal.operationId, action: 'already-rolled-back', generation: txn.previousGeneration });
      continue;
    }
    if (!txn || ['committed', 'failed-rolled-back'].includes(txn.phase) || txn.terminalOutcome) continue;
    if (journal.operation !== 'snapshot' || journal.status !== 'in-progress') throw coded('EJOURNAL_INVALID', `unresolved snapshot transaction has an invalid owner/status: ${fileName}`);
    const now = await currentPointer(root, txn.name);
    if (now?.pointer.generation === txn.generation) {
      const checked = await validateSnapshot(root, txn.name, { mode: 'restore' });
      if (checked.generation !== txn.generation) throw coded('EFAILED_ROLLBACK_INCOMPLETE', 'published generation does not match snapshot journal');
      await writeSnapshotTransaction(root, lock, txn, 'committed', { terminalOutcome: 'verified-complete' });
      recovered.push({ operationId: journal.operationId, action: 'completed', generation: txn.generation });
      continue;
    }
    const previous = txn.previousGeneration || null;
    if ((now?.pointer.generation || null) === previous) {
      await writeSnapshotTransaction(root, lock, txn, 'failed-rolled-back', { terminalOutcome: 'failed-rolled-back', compensationOutcome: 'verified' });
      recovered.push({ operationId: journal.operationId, action: 'preserved-current', generation: previous });
      continue;
    }
    if (!now && previous) {
      const old = await validateGenerationById(root, txn.name, previous);
      await publishPointer(root, txn.name, previous, hash(old.publicBytes), lock.operationId);
      const checked = await validateSnapshot(root, txn.name, { mode: 'restore' });
      if (checked.generation !== previous) throw coded('EFAILED_ROLLBACK_INCOMPLETE', 'previous snapshot pointer recovery could not be verified');
      await writeSnapshotTransaction(root, lock, txn, 'failed-rolled-back', { terminalOutcome: 'failed-rolled-back', compensationOutcome: 'verified' });
      recovered.push({ operationId: journal.operationId, action: 'restored-previous', generation: previous });
      continue;
    }
    if (!now && !previous) {
      await writeSnapshotTransaction(root, lock, txn, 'failed-rolled-back', { terminalOutcome: 'failed-rolled-back', compensationOutcome: 'verified' });
      recovered.push({ operationId: journal.operationId, action: 'kept-absent', generation: null });
      continue;
    }
    throw coded('EFAILED_ROLLBACK_INCOMPLETE', `unresolved snapshot transaction ${journal.operationId}; all referenced generations are retained`);
  }
  return recovered;
}

async function writeJournalDirect(root, lock, target, data) {
  await assertLock(root, lock);
  validateJournal(data, data.operationId);
  const temp = `${target}.${randomId()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { await fsp.rename(temp, target); } catch (error) { await fsp.rm(temp, { force: true }).catch(() => {}); throw error; }
}

function serialFileId(stat) { return { dev: stat.dev.toString(), ino: stat.ino.toString() }; }
function sameFileId(stat, expected) { return !!expected && stat.dev.toString() === String(expected.dev) && stat.ino.toString() === String(expected.ino); }
function pruneRetiredRoot(root, operationId, row) {
  return path.join(path.resolve(root), STATE_DIR, 'secrets', '.retired', `${operationId}-${row.name}-${row.generation}`);
}
function prunePointerBackup(root, operationId, row) { return path.join(pruneRetiredRoot(root, operationId, row), 'current.json'); }

async function beginPruneTransaction(root, lock, rows) {
  await assertLock(root, lock);
  if (lock.operation !== 'prune' || !Array.isArray(rows) || !rows.length) throw coded('EJOURNAL_INVALID', 'prune transaction requires a prune lock and at least one target');
  const planned = [];
  for (const item of rows) {
    assertName(item.name); assertId(item.generation, 'generation');
    if (!['auto', 'hook'].includes(item.kind)) throw coded('ERETIRE_REFUSED', 'only auto or hook snapshots can be retired');
    const checked = await validateSnapshot(root, item.name, { mode: 'restore' });
    if (checked.generation !== item.generation || checked.manifest.kind !== item.kind || checked.manifest.createdAt !== item.createdAt) throw coded('ERETIRE_REFUSED', `snapshot ${item.name} changed while the prune plan was being frozen`);
    if (await isGenerationProtected(root, item.name, item.generation)) throw coded('ERETIRE_REFUSED', `snapshot ${item.name} became protected before the prune transaction was recorded`);
    const pointer = await currentPointer(root, item.name);
    const pointerStat = await fsp.lstat(checked.paths.currentFile, { bigint: true });
    const publicStat = await fsp.lstat(checked.paths.publicGenerationDir, { bigint: true });
    const privateStat = await fsp.lstat(checked.paths.privateGenerationDir, { bigint: true });
    if (!pointer || pointer.pointer.generation !== item.generation || !pointerStat.isFile() || pointerStat.nlink > 1n ||
        !publicStat.isDirectory() || privateStat.isSymbolicLink() || !privateStat.isDirectory()) throw coded('ERETIRE_REFUSED', `snapshot ${item.name} has an unsafe current pointer or generation pair`);
    planned.push({ name: item.name, generation: item.generation, kind: item.kind, createdAt: item.createdAt,
      pointerSha256: hash(pointer.bytes), pointerSize: pointer.bytes.length, pointerFileId: serialFileId(pointerStat),
      publicDirId: serialFileId(publicStat), privateDirId: serialFileId(privateStat), phase: 'planned' });
  }
  if (planned.length !== rows.length || new Set(planned.map((row) => `${row.name}\0${row.generation}`)).size !== planned.length) throw coded('EJOURNAL_INVALID', 'prune plan contains duplicate or missing generation identities');
  try {
    await writeOperationJournal(root, lock, { operationId: lock.operationId, operation: 'prune', phase: 'planned', status: 'in-progress',
      pruneTransaction: { phase: 'planned', originalLockToken: lock.token, planned, completed: [] }, retirements: [], safetyPins: [] });
  } catch (error) {
    const dir = path.join(path.resolve(root), STATE_DIR, 'operations');
    const prefix = `${lock.operationId}.json`;
    const entries = await fsp.readdir(dir).catch(() => []);
    error.pruneIntentMayExist = entries.some((entry) => entry === `${prefix}` || entry.startsWith(`${prefix}.`));
    throw error;
  }
  return readJournal(root, operationJournalPath(root, lock.operationId));
}

async function pruneJournalCandidate(root, operationId, owner, current = null) {
  const dir = path.join(path.resolve(root), STATE_DIR, 'operations');
  const prefix = `${operationId}.json.`;
  const names = (await fsp.readdir(dir)).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'));
  if (!names.length) return { journal: current, temp: null };
  if (names.length !== 1 || !new RegExp(`^${operationId}\\.json\\.[a-f0-9]{32}\\.tmp$`).test(names[0])) throw coded('EJOURNAL_INVALID', 'prune journal has ambiguous temporary files; preserve all entries for manual inspection');
  const temp = path.join(dir, names[0]);
  await assertNoLinks(temp, { allowMissing: false, hardlinks: true });
  const before = await fsp.lstat(temp, { bigint: true });
  if (!before.isFile() || before.nlink > 1n) throw coded('EJOURNAL_INVALID', 'prune journal temporary is not a private regular file');
  const bytes = await fsp.readFile(temp);
  let candidate;
  try { candidate = validateJournal(JSON.parse(bytes.toString('utf8')), operationId); }
  catch (error) { throw coded('EJOURNAL_INVALID', `prune journal temporary is incomplete or invalid; preserve it and all generations (${error.code || 'invalid'})`); }
  if (candidate.operation !== 'prune' || !(candidate.pruneTransaction?.originalLockToken === owner.token || owner.claimedOperationToken === candidate.pruneTransaction?.originalLockToken)) {
    throw coded('EJOURNAL_INVALID', 'prune temporary is not bound to the exact dead lock owner and planned generation set');
  }
  if (current) validatePruneProgression(current, candidate);
  const after = await fsp.lstat(temp, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || !(await fsp.readFile(temp)).equals(bytes)) throw coded('EJOURNAL_INVALID', 'prune temporary changed during inspection');
  if (current && Date.parse(candidate.updatedAt) <= Date.parse(current.updatedAt)) throw coded('EJOURNAL_INVALID', 'prune journal temporary is stale or conflicts with the committed journal');
  return { journal: candidate, temp: { path: temp, bytes, stat: before } };
}

async function inspectInterruptedPrune(root, operationId) {
  assertId(operationId, 'operationId');
  const rootAbs = path.resolve(root); await assertRealProject(rootAbs);
  const lockDir = path.join(rootAbs, STATE_DIR, 'locks', 'operation.lock');
  const ownerFile = path.join(lockDir, 'owner.json');
  await assertNoLinks(lockDir, { allowMissing: false }); await assertNoLinks(ownerFile, { allowMissing: false, hardlinks: true });
  const ownerBytes = await fsp.readFile(ownerFile);
  let owner; try { owner = JSON.parse(ownerBytes.toString('utf8')); } catch { throw coded('ELOCK_OWNER', 'prune owner is malformed; preserve the lock and journal'); }
  if (!object(owner) || owner.root !== rootAbs || owner.operation !== 'prune' || owner.operationId !== operationId || !ID_RE.test(owner.token || '') || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.host !== os.hostname()) throw coded('ELOCK_OWNER', 'prune owner identity does not match this local operation');
  await assertClaimOwnerReference(rootAbs, owner, owner.operationId);
  let alive = true;
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else if (error.code !== 'EPERM') throw error; }
  const journalFile = operationJournalPath(rootAbs, operationId);
  let current = null;
  try { current = await readJournal(rootAbs, journalFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const candidate = await pruneJournalCandidate(rootAbs, operationId, owner, current);
  const journal = candidate.journal;
  if (!journal || journal.operation !== 'prune' || journal.operationId !== operationId ||
      !(journal.pruneTransaction?.originalLockToken === owner.token || owner.claimedOperationToken === journal.pruneTransaction?.originalLockToken) ||
      !['in-progress', 'completed'].includes(journal.status)) throw coded('EJOURNAL_INVALID', 'prune operation has no owner-bound durable plan; retain lock, temp and generations');
  if (alive && journal.status !== 'completed') throw coded('ELOCKED', `prune process ${owner.pid} is still active`);
  if (journal.status === 'in-progress') {
    for (const row of journal.pruneTransaction.planned) await inspectPruneTargetState(rootAbs, operationId, row, journal);
  } else {
    for (const row of journal.pruneTransaction.planned) await verifyCommittedPruneTargetAbsent(rootAbs, operationId, row);
  }
  return { owner, ownerBytes, journal, alive, lockDir, ownerFile, temp: candidate.temp, action: journal.status === 'completed' ? 'already-completed' : 'continue-prune' };
}

async function verifyCommittedPruneTargetAbsent(root, operationId, row) {
  if (row.phase !== 'retired') throw coded('EJOURNAL_INVALID', `terminal prune target ${row.name} is not marked retired`);
  const P = snapshotPaths(root, row.name, row.generation);
  const retiredRoot = pruneRetiredRoot(root, operationId, row);
  const paths = [P.publicGenerationDir, P.privateGenerationDir, retiredRoot, prunePointerBackup(root, operationId, row)];
  for (const absolute of paths) {
    await assertNoLinks(absolute, { allowMissing: true, hardlinks: true });
    try { await fsp.lstat(absolute); throw coded('EJOURNAL_INVALID', `terminal prune target ${row.name} still has generation or retirement data`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const current = await currentPointer(root, row.name);
  if (current?.pointer.generation === row.generation) throw coded('EJOURNAL_INVALID', `terminal prune pointer for ${row.name} still names the retired generation`);
  if (current) {
    const checked = await validateSnapshot(root, row.name, { mode: 'restore' });
    if (checked.generation !== current.pointer.generation) throw coded('EJOURNAL_INVALID', `replacement snapshot pointer for ${row.name} did not validate`);
  }
  if ((await listPins(root)).some((pin) => pin.name === row.name && pin.generation === row.generation)) throw coded('EPIN_INVALID', `terminal prune target ${row.name} unexpectedly has a persistent pin`);
}

async function verifyCompletedPruneTransaction(root, operationId, { cleanupStaleLock = false } = {}) {
  assertId(operationId, 'operationId');
  const rootAbs = path.resolve(root); await assertRealProject(rootAbs);
  const journal = await readJournal(rootAbs, operationJournalPath(rootAbs, operationId));
  if (journal.operation !== 'prune' || journal.status !== 'completed' || journal.terminalOutcome !== 'verified-complete' ||
      journal.pruneTransaction?.phase !== 'completed') throw coded('EJOURNAL_INVALID', 'prune journal has no verified terminal outcome');
  for (const row of journal.pruneTransaction.planned) await verifyCommittedPruneTargetAbsent(rootAbs, operationId, row);

  const operations = path.join(rootAbs, STATE_DIR, 'operations');
  await assertNoLinks(operations, { allowMissing: false });
  const prefix = `${operationId}.json.`;
  const temps = (await fsp.readdir(operations)).filter((name) => name.startsWith(prefix));
  if (temps.length) throw coded('EJOURNAL_INVALID', 'completed prune still has an operation temporary; preserve it for manual inspection');

  const lockDir = path.join(rootAbs, STATE_DIR, 'locks', 'operation.lock');
  let lockStat = await fsp.lstat(lockDir).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  let inspected = null;
  if (lockStat) {
    try { inspected = await inspectInterruptedPrune(rootAbs, operationId); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      lockStat = await fsp.lstat(lockDir).catch((cause) => cause.code === 'ENOENT' ? null : Promise.reject(cause));
      if (lockStat) throw error;
    }
  }
  if (cleanupStaleLock && inspected && !inspected.alive) {
    const claimed = await claimInterruptedPrune(rootAbs, operationId);
    await claimed.lock.release();
  }
  return { journal, lock: inspected };
}

async function inspectPruneTargetState(root, operationId, row, journal) {
  const P = snapshotPaths(root, row.name, row.generation);
  const retiredRoot = pruneRetiredRoot(root, operationId, row);
  const pointerBackup = prunePointerBackup(root, operationId, row);
  const statMaybe = async (file) => fsp.lstat(file, { bigint: true }).then((stat) => stat, (error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const currentStat = await statMaybe(P.currentFile), backupStat = await statMaybe(pointerBackup);
  const publicStat = await statMaybe(P.publicGenerationDir), privateStat = await statMaybe(P.privateGenerationDir);
  const retiredPublicStat = await statMaybe(path.join(retiredRoot, 'public'));
  const retiredPrivateStat = await statMaybe(path.join(retiredRoot, 'private'));
  const rootStat = await statMaybe(retiredRoot);
  if (currentStat && (!currentStat.isFile() || currentStat.nlink > 1n)) throw coded('EJOURNAL_INVALID', `current pointer for ${row.name} became a link or non-file`);
  if (backupStat && (!backupStat.isFile() || backupStat.nlink > 1n || !sameFileId(backupStat, row.pointerFileId))) throw coded('EJOURNAL_INVALID', `prune pointer backup for ${row.name} was replaced`);
  const ptr = currentStat ? await fsp.readFile(P.currentFile) : backupStat ? await fsp.readFile(pointerBackup) : null;
  if (ptr && (hash(ptr) !== row.pointerSha256 || ptr.length !== row.pointerSize || JSON.parse(ptr.toString('utf8')).generation !== row.generation)) throw coded('EJOURNAL_INVALID', `prune pointer bytes for ${row.name} no longer match the recorded generation`);
  for (const [stat, expected, label] of [[publicStat, row.publicDirId, 'public'], [privateStat, row.privateDirId, 'private'], [retiredPublicStat, row.publicDirId, 'retired public'], [retiredPrivateStat, row.privateDirId, 'retired private']]) {
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || !sameFileId(stat, expected))) throw coded('EJOURNAL_INVALID', `${label} generation for ${row.name} changed identity`);
  }
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (row.retiredDirId && !sameFileId(rootStat, row.retiredDirId)))) throw coded('EJOURNAL_INVALID', `retired root for ${row.name} changed identity`);
  if (rootStat) {
    const entries = await fsp.readdir(retiredRoot);
    if (entries.some((entry) => !['current.json', 'public', 'private'].includes(entry))) throw coded('EJOURNAL_INVALID', `retired root for ${row.name} contains an undeclared entry`);
  }
  if (row.phase === 'committed' || row.phase === 'retired') {
    if (currentStat || publicStat || privateStat || (!backupStat && rootStat === null)) {
      if (!(['committed', 'retired'].includes(row.phase) && !currentStat && !publicStat && !privateStat && !backupStat && !rootStat)) {
        throw coded('EJOURNAL_INVALID', `committed prune target ${row.name} has unexpected live state`);
      }
    }
    if (rootStat && !sameFileId(rootStat, row.retiredDirId)) throw coded('EJOURNAL_INVALID', `committed prune target ${row.name} has an unproved cleanup directory`);
    if (await isGenerationProtected(root, row.name, row.generation, { ignorePruneOperationId: operationId })) throw coded('EPIN_INVALID', `committed prune target ${row.name} gained a foreign pin or unresolved reference; preserve retired data`);
  } else {
    if (!currentStat && !backupStat) throw coded('EJOURNAL_INVALID', `prune target ${row.name} has no current pointer or transaction-bound backup`);
    if (!publicStat && !retiredPublicStat) throw coded('EJOURNAL_INVALID', `prune target ${row.name} has no proved public generation`);
    if (!privateStat && !retiredPrivateStat) throw coded('EJOURNAL_INVALID', `prune target ${row.name} has no proved private generation`);
    const publicDir = publicStat ? P.publicGenerationDir : path.join(retiredRoot, 'public');
    const privateDir = privateStat ? P.privateGenerationDir : path.join(retiredRoot, 'private');
    await validateGenerationPair(root, row.name, row.generation, publicDir, privateDir);
    if (currentStat && !backupStat) {
      const stat = await fsp.lstat(P.currentFile, { bigint: true });
      if (!sameFileId(stat, row.pointerFileId)) throw coded('EJOURNAL_INVALID', `prune target ${row.name} current pointer was replaced`);
    }
    if (await isGenerationProtected(root, row.name, row.generation, { ignorePruneOperationId: operationId })) throw coded('EPIN_INVALID', `prune target ${row.name} gained a foreign pin or unresolved reference`);
  }
  return { currentStat, backupStat, publicStat, privateStat, retiredPublicStat, retiredPrivateStat, rootStat, P, retiredRoot, pointerBackup };
}

async function claimInterruptedPrune(root, operationId) {
  const { root: rootAbs, state } = await canonicalRoot(root);
  const initial = await inspectInterruptedPrune(rootAbs, operationId);
  if (initial.alive) throw coded('ELOCKED', 'prune process is still active; do not recover concurrently');
  const claim = await acquireLockClaim(rootAbs, state, await claimBinding(rootAbs, 'prune', operationId, initial));
  let lock = null;
  try {
    const inspected = await inspectInterruptedPrune(rootAbs, operationId);
    if (inspected.alive) throw coded('ELOCKED', 'prune process is still active; do not recover concurrently');
    const fresh = await inspectInterruptedPrune(rootAbs, operationId);
    if (fresh.alive || !fresh.ownerBytes.equals(inspected.ownerBytes) || JSON.stringify(fresh.journal) !== JSON.stringify(inspected.journal) ||
        (fresh.temp?.path !== inspected.temp?.path) || (fresh.temp && !fresh.temp.bytes.equals(inspected.temp.bytes))) throw coded('ELOCK_OWNER', 'prune lock, journal or temporary changed during exclusive claim');
    await assertClaimBinding(claim, rootAbs, 'prune', operationId, fresh);
    await assertNoLinks(inspected.ownerFile, { allowMissing: false, hardlinks: true });
    if (!(await fsp.readFile(inspected.ownerFile)).equals(inspected.ownerBytes)) throw coded('ELOCK_OWNER', 'prune owner changed before lock takeover');
    lock = await takeOverOperationLock(rootAbs, state, { inspected, claim, operation: 'prune', operationId, claimedOperationToken: inspected.journal.pruneTransaction.originalLockToken });
    if (inspected.temp) {
      const currentPath = operationJournalPath(rootAbs, operationId);
      const current = await fsp.lstat(currentPath).then(() => readJournal(rootAbs, currentPath), (error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (current) validatePruneProgression(current, inspected.journal);
      await assertNoLinks(inspected.temp.path, { allowMissing: false, hardlinks: true });
      const latest = await fsp.readFile(inspected.temp.path);
      if (!latest.equals(inspected.temp.bytes)) throw coded('EJOURNAL_INVALID', 'prune temp changed during lock takeover');
      await fsp.rename(inspected.temp.path, currentPath);
    }
    const journal = await readJournal(rootAbs, operationJournalPath(rootAbs, operationId));
    return { lock, journal };
  } catch (error) {
    // Do not remove a lock after takeover if reconciliation fails. Its claim
    // token and journal binding let a fresh process diagnose the exact stage.
    throw error;
  } finally { await claim.release(); }
}

async function retireSnapshot(root, lock, { name, generation, expectedKind }) {
  await assertLock(root, lock); assertName(name); assertId(generation, 'generation');
  if (lock.operation !== 'prune' || !['auto', 'hook'].includes(expectedKind)) throw coded('ERETIRE_REFUSED', 'only a planned auto/hook retirement under a prune lock is supported');
  const journalFile = operationJournalPath(root, lock.operationId);
  const journal = await readJournal(root, journalFile);
  const txn = journal.pruneTransaction;
  const liveOwnerFile = path.join(path.resolve(root), STATE_DIR, 'locks', 'operation.lock', 'owner.json');
  let liveOwner; try { liveOwner = JSON.parse(await fsp.readFile(liveOwnerFile, 'utf8')); } catch { throw coded('ELOCK_OWNER', 'prune lock owner could not be checked'); }
  if (journal.operation !== 'prune' || journal.status !== 'in-progress' || !txn ||
      !(txn.originalLockToken === lock.token || liveOwner.claimedOperationToken === txn.originalLockToken)) throw coded('EJOURNAL_INVALID', 'retirement has no owner-bound prune intent');
  let row = txn.planned.find((item) => item.name === name && item.generation === generation);
  if (!row || row.kind !== expectedKind) throw coded('ERETIRE_REFUSED', 'generation is not in the durable prune plan');
  if (row.phase === 'retired') return { retired: true, cleanupPending: false, generation, alreadyRetired: true };
  await assertLock(root, lock);
  let state = await inspectPruneTargetState(root, lock.operationId, row, journal);
  const retiredRoot = state.retiredRoot;
  if (!row.retiredDirId) {
    if (state.rootStat) {
      const entries = await fsp.readdir(retiredRoot);
      if (entries.length) throw coded('EJOURNAL_INVALID', 'unidentified prune staging directory is not empty; preserve it for manual inspection');
      row = { ...row, retiredDirId: serialFileId(state.rootStat), phase: 'retiring' };
    } else {
      await ensureRealDirectory(path.join(path.resolve(root), STATE_DIR), path.dirname(retiredRoot));
      await fsp.mkdir(retiredRoot);
      const rootStat = await fsp.lstat(retiredRoot, { bigint: true });
      row = { ...row, retiredDirId: serialFileId(rootStat), phase: 'retiring' };
    }
    const planned = txn.planned.map((item) => item.name === name && item.generation === generation ? row : item);
    await writeOperationJournal(root, lock, { operationId: lock.operationId, operation: 'prune', phase: 'retiring', status: 'in-progress',
      pruneTransaction: { ...txn, phase: txn.phase, planned } });
    state = await inspectPruneTargetState(root, lock.operationId, row, journal);
  } else if (row.phase === 'planned') {
    row = { ...row, phase: 'retiring' };
    await writeOperationJournal(root, lock, { operationId: lock.operationId, operation: 'prune', phase: 'retiring', status: 'in-progress',
      pruneTransaction: { ...txn, planned: txn.planned.map((item) => item.name === name && item.generation === generation ? row : item) } });
    state = await inspectPruneTargetState(root, lock.operationId, row, journal);
  }

  const P = state.P, publicRetired = path.join(retiredRoot, 'public'), privateRetired = path.join(retiredRoot, 'private'), pointerBackup = state.pointerBackup;
  if (row.phase !== 'committed') {
    await assertLock(root, lock);
    state = await inspectPruneTargetState(root, lock.operationId, row, journal);
    if (state.currentStat && !state.backupStat) await fsp.rename(P.currentFile, pointerBackup);
    await assertLock(root, lock);
    state = await inspectPruneTargetState(root, lock.operationId, row, journal);
    if (state.publicStat && !state.retiredPublicStat) await fsp.rename(P.publicGenerationDir, publicRetired);
    await assertLock(root, lock);
    state = await inspectPruneTargetState(root, lock.operationId, row, journal);
    if (state.privateStat && !state.retiredPrivateStat) await fsp.rename(P.privateGenerationDir, privateRetired);
    await assertLock(root, lock);
    state = await inspectPruneTargetState(root, lock.operationId, row, journal);
    if (!state.backupStat || !state.retiredPublicStat || !state.retiredPrivateStat) throw coded('EJOURNAL_INVALID', 'retirement staging is incomplete; keep all data and retry inspection');
    row = { ...row, phase: 'committed' };
    const planned = txn.planned.map((item) => item.name === name && item.generation === generation ? row : item);
    await writeOperationJournal(root, lock, { operationId: lock.operationId, operation: 'prune', phase: 'committed', status: 'in-progress',
      pruneTransaction: { ...txn, phase: txn.phase === 'planned' ? 'committed' : txn.phase, planned } });
  }

  await assertLock(root, lock);
  state = await inspectPruneTargetState(root, lock.operationId, row, journal);
  if (state.rootStat) {
    await assertNoLinks(retiredRoot, { allowMissing: false });
    const rootStat = await fsp.lstat(retiredRoot, { bigint: true });
    if (!sameFileId(rootStat, row.retiredDirId)) throw coded('EJOURNAL_INVALID', 'committed prune cleanup directory changed identity');
    await fsp.rm(retiredRoot, { recursive: true, force: false });
  }
  row = { ...row, phase: 'retired' };
  const planned = txn.planned.map((item) => item.name === name && item.generation === generation ? row : item);
  const completed = [...txn.completed.filter((ref) => !(ref.name === name && ref.generation === generation)), { name, generation }];
  await writeOperationJournal(root, lock, { operationId: lock.operationId, operation: 'prune', phase: 'retiring', status: 'in-progress',
    pruneTransaction: { ...txn, phase: 'cleanup-pending', planned, completed } });
  return { retired: true, cleanupPending: false, generation };
}

async function continuePruneTransaction(root, lock) {
  await assertLock(root, lock);
  if (lock.operation !== 'prune') throw coded('ELOCK_OWNER', 'prune recovery requires a prune operation lock');
  let journal = await readJournal(root, operationJournalPath(root, lock.operationId));
  if (journal.operation !== 'prune' || journal.status !== 'in-progress' || !journal.pruneTransaction) throw coded('EJOURNAL_INVALID', 'prune journal is not recoverable');
  for (const row of journal.pruneTransaction.planned) {
    if (row.phase === 'retired') continue;
    await retireSnapshot(root, lock, { name: row.name, generation: row.generation, expectedKind: row.kind });
    journal = await readJournal(root, operationJournalPath(root, lock.operationId));
  }
  if (journal.pruneTransaction.planned.some((row) => row.phase !== 'retired')) throw coded('EJOURNAL_INVALID', 'prune finished without proving every planned target retired');
  const txn = { ...journal.pruneTransaction, phase: 'completed' };
  await writeOperationJournal(root, lock, { operationId: lock.operationId, operation: 'prune', phase: 'completed', status: 'completed', terminalOutcome: 'verified-complete', pruneTransaction: txn });
  return { retired: txn.completed.length, generations: txn.completed };
}

async function validateSnapshot(root, name, { mode = 'restore' } = {}) {
  assertName(name);
  if (!['restore', 'diagnostic'].includes(mode)) throw coded('EMANIFEST_INVALID', 'validation mode must be restore or diagnostic');
  const rootInfo = await assertRealProject(root);
  const P = snapshotPaths(rootInfo.root, name);
  try { await assertNoLinks(P.currentFile, { allowMissing: false, hardlinks: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const legacyFile = path.join(P.snapDir, 'manifest.json');
    try {
      await assertNoLinks(legacyFile, { allowMissing: false, hardlinks: true });
      const legacy = JSON.parse(await fsp.readFile(legacyFile, 'utf8'));
      if (!object(legacy) || legacy.schemaVersion !== 1 || legacy.name !== name) throw coded('EMANIFEST_INVALID', 'legacy v1 manifest is malformed');
      if (mode === 'restore') throw coded('ELEGACY_RESTORE', 'legacy v1 snapshots are diagnostic-only; collect a v2 snapshot before restore');
      return { manifest: legacy, layers: legacy.layers || {}, artifacts: [], paths: { ...P, manifestFile: legacyFile }, generation: null, restorable: false, warnings: ['legacy v1 is diagnostic-only; it may contain private data in the public snapshot directory'] };
    } catch (legacyError) {
      if (legacyError.code !== 'ENOENT') throw legacyError;
      throw coded('ESNAPSHOT_MISSING', `snapshot not found: ${name}`);
    }
  }
  let pointer;
  try { pointer = JSON.parse(await fsp.readFile(P.currentFile, 'utf8')); } catch { throw coded('EMANIFEST_INVALID', 'current pointer is malformed'); }
  if (!object(pointer) || Object.keys(pointer).some((key) => !['schemaVersion', 'name', 'generation', 'publicManifestSha256'].includes(key)) || pointer.schemaVersion !== 1 || pointer.name !== name || !ID_RE.test(pointer.generation || '') || !HASH_RE.test(pointer.publicManifestSha256 || '')) throw coded('EMANIFEST_INVALID', 'current pointer identity is invalid');
  const pair = await validateGenerationById(rootInfo.root, name, pointer.generation);
  if (hash(pair.publicBytes) !== pointer.publicManifestSha256) throw coded('EARTIFACT_INTEGRITY', 'current pointer manifest digest does not match');
  const artifacts = pair.artifacts;
  const requiredMissing = artifacts.some((a) => a.required && (a.kind === 'absent' ? false : !a.absolutePath));
  if (mode === 'restore' && requiredMissing) throw coded('EARTIFACT_MISSING', 'required snapshot artifact is missing');
  return { manifest: pair.publicManifest, privateManifest: pair.privateManifest, layers: pair.layers, artifacts, paths: pair.paths, generation: pointer.generation, restorable: !requiredMissing, warnings: [] };
}

async function snapshotPathsForCommit(root, name, generation) {
  return snapshotPaths(root, name, generation);
}

async function listSnapshots(root, { includeLegacy = true } = {}) {
  const base = path.join(path.resolve(root), STATE_DIR, 'snapshots');
  try { await assertNoLinks(base, { allowMissing: false }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const names = [];
  for (const name of await fsp.readdir(base)) {
    if (!NAME_RE.test(name)) continue;
    try {
      const checked = await validateSnapshot(root, name, { mode: 'diagnostic' });
      if (checked.generation || includeLegacy) names.push(name);
    } catch { /* invalid/incomplete snapshots are not advertised as valid */ }
  }
  return names.sort();
}

module.exports = {
  STATE_DIR, NAME_RE, ID_RE, HASH_RE, randomId, hash, coded, assertName, assertId,
  snapshotPaths, safeRelative, assertSafeRelative, assertTarget, validateRestoreTarget, assertNoLinks,
  ensureRealDirectory, assertRealProject, validateLayer, validateManifestShape,
  validateGenerationPair, validateGenerationById, validateSnapshot, listSnapshots,
  acquireOperationLock, assertLock, inspectInterruptedRestore, claimInterruptedRestore, finalizeCompletedRestoreCleanup,
  inspectInterruptedSnapshot, claimInterruptedSnapshot, operationJournalPath, writeOperationJournal,
  readJournal, pinSnapshot, unpinSnapshot, resolveRollbackPin, listPins, isGenerationProtected, generationProtectionIndex,
  completeCleanupAction,
  beginSnapshotTransaction, commitSnapshotGeneration, recoverSnapshotTransactions, retireSnapshot,
  beginPruneTransaction, inspectInterruptedPrune, claimInterruptedPrune, continuePruneTransaction, verifyCompletedPruneTransaction, validatePruneProgression,
  walkFiles, snapshotPathsForCommit,
};
