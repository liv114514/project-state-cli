'use strict';

// Immutable public/private generations with one current-pointer publication.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const U = require('./utils');
const Store = require('./storage');
const { COLLECTORS } = require('./collectors');

function checkName(name, kind) {
  Store.assertName(name);
  if (!['named', 'auto', 'hook'].includes(kind)) throw Store.coded('EUNSAFE_PATH', `invalid snapshot kind: ${kind}`);
  if (kind === 'named' && /^(?:auto|hook)-/i.test(name)) throw Store.coded('EUNSAFE_PATH', 'auto- and hook- name prefixes are reserved');
  if (kind === 'auto' && !/^auto-\d{8}-\d{6}(?:-\d+)?$/.test(name)) throw Store.coded('EUNSAFE_PATH', 'auto snapshot name does not match the reserved format');
  if (kind === 'hook' && !/^hook-\d{8}-\d{6}(?:-\d+)?$/.test(name)) throw Store.coded('EUNSAFE_PATH', 'hook snapshot name does not match the reserved format');
}

async function readStableSource(root, sourcePath) {
  const rootAbs = path.resolve(root); const source = path.resolve(sourcePath);
  const relative = path.relative(rootAbs, source);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Store.coded('EUNSAFE_PATH', 'artifact source escapes the project root');
  await Store.assertNoLinks(source, { allowMissing: false, hardlinks: true });
  const beforePath = await fsp.lstat(source);
  if (!beforePath.isFile()) throw Store.coded('EUNSAFE_PATH', 'artifact source must be a regular file');
  const handle = await fsp.open(source, fs.constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink > 1 || (before.ino && beforePath.ino && before.ino !== beforePath.ino)) throw Store.coded('EUNSAFE_PATH', 'artifact source identity changed or is hardlinked');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || (before.ino && after.ino && before.ino !== after.ino)) throw Store.coded('ESOURCE_CHANGED', 'artifact source changed while it was read');
    return bytes;
  } finally { await handle.close(); }
}

function collectorFileSpec(file) {
  const rawPath = file.path || file.destName || file.name || file.target;
  if (typeof rawPath !== 'string') throw Store.coded('EARTIFACT_INVALID', 'collector artifact lacks a path');
  let layer = file.layer;
  if (!layer) {
    if (rawPath === '.env' || rawPath === '.env.local') layer = 'config';
    else if (rawPath === '.nvmrc' || rawPath === '.node-version') layer = 'runtime';
    else if (rawPath.startsWith('database/')) layer = 'database';
    else if (/^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(rawPath)) layer = 'deps';
    else throw Store.coded('EARTIFACT_INVALID', `no layer classifier for artifact ${rawPath}`);
  }
  let target = file.target;
  let kind = file.kind;
  if (layer === 'database') {
    const leaf = path.posix.basename(rawPath.replace(/^database\//, ''));
    if (!target) target = leaf.replace(/\.(?:schema|dump)\.sql$/i, '');
    if (!kind) kind = /\.schema\.sql$/i.test(rawPath) ? 'sqlite-schema' : /\.dump\.sql$/i.test(rawPath) ? 'sqlite-dump' : 'sqlite-backup';
  } else {
    if (!target) target = rawPath;
    kind = kind || 'file';
  }
  if (kind === 'file') Store.assertTarget(layer, target);
  else Store.assertTarget('database', target);
  if (!Store.ARTIFACT_KINDS?.has?.(kind) && !['file', 'sqlite-schema', 'sqlite-dump', 'sqlite-backup'].includes(kind)) throw Store.coded('EARTIFACT_INVALID', `unsupported artifact kind: ${kind}`);
  const privacy = (file.secret || layer === 'database' || file.privacy === 'private') ? 'private' : 'private';
  const restore = kind === 'sqlite-backup' ? 'sqlite-create-missing' : kind === 'file' && layer !== 'database' ? 'restore-file' : 'record-only';
  return { id: file.id || `${layer}:${target}:${kind}`, layer, kind, privacy, required: file.required !== false, restore, target };
}

async function writeFileExclusive(root, base, relative, bytes) {
  Store.assertSafeRelative(relative);
  const destination = path.join(base, 'files', ...relative.split('/'));
  const filesRoot = path.join(base, 'files');
  await Store.ensureRealDirectory(root, filesRoot);
  await Store.ensureRealDirectory(root, path.dirname(destination));
  await Store.assertNoLinks(destination, { hardlinks: true });
  await fsp.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  return destination;
}

function manifestIdentity(name, generation, kind, layers) {
  return {
    schemaVersion: 2,
    state: 'complete',
    generation,
    kind,
    name,
    createdAt: new Date().toISOString(),
    toolVersion: U.TOOL_VERSION,
    host: { platform: process.platform, arch: process.arch, node: process.version },
    layers,
  };
}

async function snapshotInternal(root, name, opts = {}) {
  const kind = opts.kind || 'named'; checkName(name, kind);
  if (!Array.isArray(opts.extraArtifacts || [])) throw Store.coded('EARTIFACT_INVALID', 'extraArtifacts must be an array');
  if ((opts.extraArtifacts || []).length && kind !== 'auto') throw Store.coded('EARTIFACT_INVALID', 'rollback artifacts are accepted only for auto snapshots');
  const rootInfo = await Store.assertRealProject(root, { createState: true });
  const ownedLock = !opts.lock;
  const lock = opts.lock || await Store.acquireOperationLock(rootInfo.root, { operation: 'snapshot' });
  await Store.assertLock(rootInfo.root, lock);
  const generation = Store.randomId();
  const stageRoot = path.join(rootInfo.state, 'staging', lock.operationId);
  const stagePublic = path.join(stageRoot, 'public'); const stagePrivate = path.join(stageRoot, 'private');
  const paths = Store.snapshotPaths(rootInfo.root, name, generation);
  let result;
  try {
    await Store.recoverSnapshotTransactions(rootInfo.root, lock);
    const existingPointer = await fsp.lstat(paths.currentFile).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error));
    const legacyManifest = await fsp.lstat(path.join(paths.snapDir, 'manifest.json')).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error));
    if ((existingPointer || legacyManifest) && !opts.overwrite) throw Store.coded('EEXISTS', `snapshot already exists: ${name}`);
    if (legacyManifest) throw Store.coded('ELEGACY_RESTORE', 'legacy v1 snapshot is diagnostic-only and cannot be overwritten or migrated automatically');
    let previousGeneration = null;
    if (existingPointer) previousGeneration = (await Store.validateSnapshot(rootInfo.root, name, { mode: 'restore' })).generation;
    await Store.beginSnapshotTransaction(rootInfo.root, lock, { name, generation, previousGeneration });
    await Store.ensureRealDirectory(rootInfo.state, path.join(rootInfo.state, 'staging'));
    await Store.assertNoLinks(stageRoot);
    await fsp.mkdir(stageRoot);
    await fsp.mkdir(stagePublic); await fsp.mkdir(stagePrivate);

    const ctx = { root: rootInfo.root, results: {}, files: [], withSeed: !!opts.withSeed, operationId: lock.operationId, lock };
    const layers = {}; const publicArtifacts = []; const privateArtifacts = [];
    let privateAllowed = true; let privateBlockReason = null;
    if (U.existsSync(path.join(rootInfo.root, '.git'))) {
      try { await U.ensureLocalExclude(rootInfo.root, '.project-state/'); }
      catch (error) { privateAllowed = false; privateBlockReason = 'Git local exclusion could not be verified'; }
      const trackedState = await U.runTrusted('git', ['ls-files', '-z', '--', '.project-state/'], { cwd: rootInfo.root });
      if (!trackedState.ok || trackedState.stdout.length > 0) { privateAllowed = false; privateBlockReason = 'project-state storage is tracked or its tracked status is unknown'; }
      const trackedEnv = await U.runTrusted('git', ['ls-files', '-z', '--', '.env', '.env.local'], { cwd: rootInfo.root });
      if (!trackedEnv.ok || trackedEnv.stdout.length > 0) { privateAllowed = false; privateBlockReason = 'an environment file is tracked or its tracked status is unknown'; }
    }

    for (const collector of COLLECTORS) {
      const filesBefore = ctx.files.length;
      let collected;
      try { collected = await collector.fn(ctx); }
      catch (error) { collected = U.skip(`collector failed: ${String(error.message || 'unknown error').split(/\r?\n/)[0]}`); }
      if (!collected || collected.status !== 'collected') {
        ctx.files.length = filesBefore;
        layers[collector.id] = { status: 'skipped', reason: String(collected?.reason || 'collector did not return data').slice(0, 240) };
        continue;
      }
      const collectorFiles = [...ctx.files.slice(filesBefore), ...(Array.isArray(collected.files) ? collected.files : [])];
      if (!privateAllowed && collectorFiles.some((file) => file.required !== false)) {
        ctx.files.length = filesBefore;
        layers[collector.id] = { status: 'skipped', reason: 'private storage could not be verified; required source copies omitted' };
        continue;
      }
      layers[collector.id] = { status: 'collected', file: `${collector.id}.json` };
      ctx.results[collector.id] = collected.data;
      if (Array.isArray(collected.files)) ctx.files.push(...collected.files);
      // Runtime pin contents may be low-entropy/private. Public metadata records
      // only pin names; raw bytes remain private artifacts.
      let publicData = collected.data;
      if (collector.id === 'runtime') publicData = { ...collected.data, versionPins: (collected.data.versionPins || []).map((pin) => ({ name: pin.name })) };
      const dataBytes = Buffer.from(JSON.stringify(publicData, null, 2) + '\n');
      const privacy = collector.id === 'database' ? 'private' : 'public';
      if (privacy === 'private' && !privateAllowed) {
        layers[collector.id] = { status: 'skipped', reason: 'private storage could not be verified; sensitive database metadata omitted' };
        delete ctx.results[collector.id];
        ctx.files.length = filesBefore;
        continue;
      }
      const relative = `${collector.id}.json`;
      const destination = await writeFileExclusive(rootInfo.root, privacy === 'private' ? stagePrivate : stagePublic, relative, dataBytes);
      const artifact = { id: `layer:${collector.id}`, layer: collector.id, kind: 'layer-json', privacy, required: true, restore: 'record-only', path: relative, sha256: Store.hash(dataBytes), size: dataBytes.length };
      (privacy === 'private' ? privateArtifacts : publicArtifacts).push(artifact);
      void destination;
    }

    const allFiles = [...ctx.files];
    for (let index = 0; index < (opts.extraArtifacts || []).length; index++) {
      const extra = opts.extraArtifacts[index];
      if (!extra || extra.layer !== 'rollback' || !['file', 'absent'].includes(extra.kind)) throw Store.coded('EARTIFACT_INVALID', 'extraArtifacts entries must be rollback file or absent markers');
      Store.assertTarget('rollback', extra.target);
      if (extra.kind === 'absent') {
        privateArtifacts.push({ id: extra.id || `rollback:${extra.target}:absent`, layer: 'rollback', kind: 'absent', privacy: 'private', required: true, restore: 'record-only', path: null, sha256: null, size: 0, target: extra.target });
      } else {
        allFiles.push({ ...extra, layer: 'rollback', path: `rollback/${String(index).padStart(4, '0')}`, target: extra.target, privacy: 'private', kind: 'file' });
      }
    }

    for (const file of allFiles) {
      const spec = file.layer === 'rollback' ? {
        id: file.id || `rollback:${file.target}:file`, layer: 'rollback', kind: 'file', privacy: 'private', required: true, restore: 'restore-file', target: Store.assertTarget('rollback', file.target),
      } : collectorFileSpec(file);
      if (spec.privacy === 'private' && !privateAllowed) {
        if (file.required !== false || file.layer === 'rollback') throw Store.coded('EPRIVATE_STORAGE_UNSAFE', `${spec.layer} artifact cannot be stored privately: ${privateBlockReason || 'storage boundary unavailable'}`);
        continue;
      }
      const relative = Store.assertSafeRelative(file.layer === 'rollback' ? file.path : path.posix.basename(file.path || file.destName || file.name || spec.target));
      const bytes = file.virtual || file.content !== undefined
        ? (Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content ?? ''))
        : await readStableSource(rootInfo.root, file.srcPath);
      await writeFileExclusive(rootInfo.root, stagePrivate, relative, bytes);
      privateArtifacts.push({ ...spec, path: relative, sha256: Store.hash(bytes), size: bytes.length });
    }

    const identity = manifestIdentity(name, generation, kind, layers);
    const publicManifest = { ...identity, artifacts: publicArtifacts };
    const privateManifest = { ...identity, artifacts: privateArtifacts };
    await fsp.writeFile(path.join(stagePublic, 'manifest.json'), JSON.stringify(publicManifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fsp.writeFile(path.join(stagePrivate, 'manifest.json'), JSON.stringify(privateManifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const verifiedStage = await Store.validateGenerationPair(rootInfo.root, name, generation, stagePublic, stagePrivate);
    await Store.assertLock(rootInfo.root, lock);
    const committed = await Store.commitSnapshotGeneration(rootInfo.root, lock, { name, generation, stagePublic, stagePrivate, overwrite: !!opts.overwrite });
    result = {
      manifest: committed.verified.manifest,
      privateManifest: committed.verified.privateManifest,
      layers,
      artifacts: committed.verified.artifacts,
      paths: committed.verified.paths,
      generation,
      committed: true,
      cleanupPending: committed.cleanupPending,
      ctx,
      secretFiles: committed.verified.artifacts.filter((a) => a.privacy === 'private' && a.kind !== 'layer-json').map((a) => a.path),
    };
    void verifiedStage;
    return result;
  } catch (error) {
    try { await Store.recoverSnapshotTransactions(rootInfo.root, lock, lock.operationId); }
    catch (recoveryError) {
      error.message = `${error.message}; snapshot transaction remains unresolved (${recoveryError.code || recoveryError.message}); retain its operation journal and generations`;
    }
    throw error;
  } finally {
    // On ordinary exceptions, staging is not a recovery point. Process death
    // skips this block; orphan staging is retained until explicitly inspected.
    if (await fsp.lstat(stageRoot).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error))) await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    if (ownedLock) await lock.release();
  }
}

async function snapshotCmd(root, name, opts = {}) {
  let saved;
  try { saved = await snapshotInternal(root, name, opts); }
  catch (error) {
    U.printError(`Failed to write snapshot "${name}".`, error.message, error.code === 'EEXISTS' ? 'Choose another name or explicitly pass --overwrite.' : 'Inspect the storage boundary and retry; prior generations are retained.');
    return error.code === 'EEXISTS' || error.code === 'EUNSAFE_PATH' ? 1 : 2;
  }
  console.log(`Snapshot "${name}" generation ${saved.generation} saved.`);
  for (const collector of COLLECTORS) {
    const layer = saved.layers[collector.id];
    console.log(`  ${collector.id.padEnd(9)} ${layer.status.padEnd(9)} ${layer.status === 'collected' ? collector.summarize(saved.ctx.results[collector.id]) : layer.reason}`);
  }
  if (saved.secretFiles.length) console.log(`  private : ${saved.secretFiles.join(', ')} -> ${path.relative(root, saved.paths.privateGenerationDir)}`);
  if (saved.cleanupPending) console.error('  [!] Snapshot is committed and verified; old-generation cleanup remains pending.');
  console.log('  Private artifacts are local plaintext; Git exclusion is not encryption or access control.');
  return 0;
}

module.exports = { snapshotCmd, snapshotInternal };
