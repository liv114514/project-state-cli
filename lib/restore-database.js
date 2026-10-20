'use strict';

// SQLite restore is intentionally limited to creating an absent target from
// a validated private binary backup. Existing databases and sidecars are
// never replaced. Snapshot SQL is record-only and is never executed here.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const U = require('./utils');
const DB = require('./database');
const Store = require('./storage');

const SIDECARS = DB.SIDECARS;
const preflightTokens = new WeakMap();
const planState = new WeakMap();
const rollbackTokens = new WeakMap();
const rollbackState = new WeakMap();

function databaseRecords(validated) {
  if (validated.layers?.database && Array.isArray(validated.layers.database.databases)) {
    return validated.layers.database.databases;
  }
  const layerArtifacts = (validated.artifacts || []).filter((artifact) =>
    artifact && artifact.id === 'layer:database' && artifact.layer === 'database' &&
    artifact.privacy === 'private' && artifact.kind === 'layer-json' && typeof artifact.absolutePath === 'string');
  if (layerArtifacts.length > 1) throw new Error('snapshot has ambiguous private database metadata');
  if (layerArtifacts.length === 0) return [];
  return JSON.parse(fs.readFileSync(layerArtifacts[0].absolutePath, 'utf8')).databases || [];
}

function canonicalTarget(root, target) {
  DB.assertDatabaseName(target);
  const rootAbs = path.resolve(root);
  const absolute = path.resolve(rootAbs, target);
  if (path.dirname(absolute) !== rootAbs || path.basename(absolute) !== target) {
    throw new Error(`SQLite target must be an allowlisted filename in the project root: ${target}`);
  }
  return absolute;
}

function validatedArtifactPath(root, validated, artifact) {
  if (typeof artifact.absolutePath !== 'string' || !path.isAbsolute(artifact.absolutePath)) {
    throw new Error(`validated private SQLite artifact has no absolute path: ${artifact.id}`);
  }
  if (typeof artifact.path !== 'string' || !artifact.path || artifact.path.includes('\\') || artifact.path.includes(':') ||
      artifact.path.startsWith('/') || artifact.path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe private SQLite artifact path: ${String(artifact.path)}`);
  }
  const generation = validated.manifest.generation;
  const name = validated.manifest.name;
  const privateGeneration = path.resolve(root, '.project-state', 'secrets', name, 'generations', generation);
  // Artifact paths are relative to the generation's `files/` directory, as
  // defined by validateGenerationPair and the v2 manifest contract.
  const expected = path.resolve(privateGeneration, 'files', ...artifact.path.split('/'));
  if (path.resolve(artifact.absolutePath) !== expected) throw new Error(`SQLite artifact is outside its declared private generation: ${artifact.id}`);
  return expected;
}

function privateBackupArtifacts(validated, target) {
  return validated.artifacts.filter((artifact) =>
    artifact && artifact.layer === 'database' && artifact.kind === 'sqlite-backup' &&
    artifact.privacy === 'private' && artifact.restore === 'sqlite-create-missing' &&
    artifact.required === true && artifact.target === target);
}

function throwWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function planDatabaseRestore(root, validated, { operationId } = {}) {
  const rootAbs = path.resolve(root);
  if (!validated?.manifest || !Array.isArray(validated.artifacts)) throw new Error('database restore requires a validated snapshot');
  const manifest = validated.manifest;
  if (manifest.schemaVersion !== 2) throwWithCode('ELEGACY_RESTORE', 'legacy snapshots are diagnostic-only; collect a new schemaVersion 2 snapshot');
  if (manifest.state !== 'complete' || !/^[a-f0-9]{32}$/.test(manifest.generation || '') || typeof manifest.name !== 'string') {
    throw new Error('database restore requires a complete, valid schemaVersion 2 generation');
  }
  U.validateSnapshotName(manifest.name, manifest.kind);

  const records = databaseRecords(validated);
  const opId = operationId || `dbrestore-${crypto.randomUUID()}`;
  if (typeof opId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(opId)) throw new Error('invalid database restore operation id');
  const targetKeys = new Set();
  const referencedBackupIds = new Set();
  for (const artifact of validated.artifacts) {
    if (artifact?.layer !== 'database') continue;
    if (artifact.kind === 'sqlite-schema') {
      if (artifact.restore !== 'record-only' || artifact.privacy !== 'private') throw new Error(`SQLite schema artifact must be private and record-only: ${artifact.id}`);
    } else if (artifact.kind === 'sqlite-backup') {
      if (artifact.restore !== 'sqlite-create-missing' || artifact.privacy !== 'private' || artifact.required !== true || typeof artifact.target !== 'string') {
        throw new Error(`SQLite backup artifact has an unsupported privacy or restore policy: ${artifact.id}`);
      }
    } else if (artifact.kind === 'layer-json') {
      if (artifact.id !== 'layer:database' || artifact.privacy !== 'private' || artifact.required !== true || artifact.restore !== 'record-only') {
        throw new Error('database metadata layer must be a required private record-only artifact');
      }
    } else {
      throw new Error(`unsupported database artifact kind: ${String(artifact.kind)}`);
    }
  }
  const steps = [];
  for (const record of records) {
    if (!record || typeof record.file !== 'string') throw new Error('snapshot database metadata contains an invalid filename');
    const target = DB.assertDatabaseName(record.file);
    const key = target.toLowerCase();
    if (targetKeys.has(key)) throw new Error(`snapshot contains case-insensitive duplicate database target: ${target}`);
    targetKeys.add(key);
    if (record.mode === 'schema' || record.restore === 'record-only') continue;
    if (record.mode !== 'backup' || record.restore !== 'sqlite-create-missing') {
      throw new Error(`unsupported database restore policy for ${target}; schema SQL is diagnostic-only`);
    }
    const matches = privateBackupArtifacts(validated, target);
    if (matches.length !== 1) throw new Error(`snapshot must contain exactly one required private SQLite backup for ${target}`);
    const artifact = matches[0];
    if (artifact.id !== `database-backup:${target}`) throw new Error(`private SQLite backup id does not match target ${target}`);
    referencedBackupIds.add(artifact.id);
    if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
      throw new Error(`private SQLite backup has invalid size or digest metadata: ${target}`);
    }
    const sourcePath = validatedArtifactPath(rootAbs, validated, artifact);
    await U.assertNoReparseComponents(sourcePath, path.resolve(rootAbs, '.project-state', 'secrets'));
    const sourceBytes = await fsp.readFile(sourcePath);
    if (sourceBytes.length !== artifact.size || U.sha256(sourceBytes) !== artifact.sha256) {
      throwWithCode('EARTIFACT_INTEGRITY', `private SQLite backup failed size/hash validation: ${target}`);
    }
    const info = await DB.inspectBackup(rootAbs, sourcePath);
    if (info.integrity !== 'ok') throw new Error(`private SQLite backup failed integrity_check: ${target}`);
    const expectedSchema = {
      fingerprint: info.schemaFingerprint,
      tables: info.tables,
    };
    if (record.schemaFingerprint !== expectedSchema.fingerprint ||
        JSON.stringify(record.tables) !== JSON.stringify(expectedSchema.tables) ||
        record.totalRows !== info.totalRows) {
      throw new Error(`private SQLite backup does not match its database metadata: ${target}`);
    }
    steps.push({
      target,
      sourcePath,
      sourceSha256: artifact.sha256,
      sourceSize: artifact.size,
      expectedSchema,
      expectedRows: info.totalRows,
      mode: 'sqlite-create-missing',
      applied: false,
      artifactId: artifact.id,
    });
  }
  for (const artifact of validated.artifacts) {
    if (artifact?.layer === 'database' && artifact.kind === 'sqlite-backup' && !referencedBackupIds.has(artifact.id)) {
      throw new Error(`unreferenced SQLite backup artifact is not restorable: ${artifact.id}`);
    }
  }
  const plan = { root: rootAbs, name: manifest.name, generation: manifest.generation, operationId: opId, steps, refusals: [] };
  planState.set(plan, { applied: [], staging: [], verified: false });
  return plan;
}

async function pathExists(pathname) {
  try { return await fsp.lstat(pathname); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function inspectAbsentTarget(root, target) {
  const absolute = canonicalTarget(root, target);
  await U.assertNoSymlinkPath(root, absolute);
  const conflicts = [];
  for (const candidate of [absolute, ...SIDECARS.map((suffix) => `${absolute}${suffix}`)]) {
    const stat = await pathExists(candidate);
    if (stat) conflicts.push({ path: candidate, type: stat.isSymbolicLink() ? 'link' : (stat.isFile() ? 'file' : 'non-file') });
  }
  if (conflicts.length) {
    throwWithCode('EDATABASE_TARGET_EXISTS', `refusing SQLite restore to ${target}: target or sidecar already exists (${conflicts.map((item) => path.basename(item.path)).join(', ')}); existing databases are never overwritten`);
  }
  return absolute;
}

async function preflightDatabaseRestore(root, plan) {
  if (!plan || plan.root !== path.resolve(root) || !Array.isArray(plan.steps)) throw new Error('invalid database restore plan');
  if (!planState.has(plan)) throw new Error('database restore plan is not owned by this process');
  const checked = [];
  for (const step of plan.steps) {
    if (step.mode !== 'sqlite-create-missing') throw new Error(`unsupported database restore mode: ${step.mode}`);
    const targetPath = await inspectAbsentTarget(root, step.target);
    const sourceBytes = await fsp.readFile(step.sourcePath);
    if (sourceBytes.length !== step.sourceSize || U.sha256(sourceBytes) !== step.sourceSha256) {
      throwWithCode('EARTIFACT_INTEGRITY', `private SQLite backup changed before preflight: ${step.target}`);
    }
    const info = await DB.inspectBackup(root, step.sourcePath);
    if (info.integrity !== 'ok' || info.schemaFingerprint !== step.expectedSchema.fingerprint ||
        info.totalRows !== step.expectedRows || JSON.stringify(info.tables) !== JSON.stringify(step.expectedSchema.tables)) {
      throw new Error(`SQLite backup failed preflight verification: ${step.target}`);
    }
    checked.push(Object.freeze({ target: step.target, targetPath, absent: true, sidecarsAbsent: true, artifactSha256: step.sourceSha256 }));
  }
  const token = Object.freeze({
    root: path.resolve(root),
    generation: plan.generation,
    tokenId: crypto.randomBytes(16).toString('hex'),
    checkedAt: new Date().toISOString(),
    targets: Object.freeze(checked),
  });
  preflightTokens.set(token, { plan, root: path.resolve(root), targets: checked });
  return token;
}

async function ensurePrivateStage(root, requestedOperationId) {
  const rootAbs = path.resolve(root);
  const stateDir = path.join(rootAbs, '.project-state');
  const stagingDir = path.join(stateDir, 'staging');
  const ownsOperationDir = !requestedOperationId;
  const operationId = requestedOperationId || `dbrestore-${crypto.randomUUID()}`;
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new Error('invalid database restore staging operation id');
  await U.assertNoReparseComponents(stateDir, rootAbs);
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await U.assertNoReparseComponents(stagingDir, stateDir);
  await fsp.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  await U.assertNoReparseComponents(stagingDir, stateDir);
  const operationDir = path.join(stagingDir, operationId);
  await fsp.mkdir(operationDir, { recursive: !ownsOperationDir, mode: 0o700 });
  await U.assertNoReparseComponents(operationDir, stagingDir);
  const privateDir = path.join(operationDir, 'private');
  await fsp.mkdir(privateDir, { recursive: true, mode: 0o700 });
  await U.assertNoReparseComponents(privateDir, operationDir);
  const databaseDir = path.join(privateDir, `db-restore-${crypto.randomUUID()}`);
  await fsp.mkdir(databaseDir, { mode: 0o700 });
  await U.assertNoReparseComponents(databaseDir, privateDir);
  return databaseDir;
}

function tokenState(root, plan, token) {
  const state = token && preflightTokens.get(token);
  if (!state || state.plan !== plan || state.root !== path.resolve(root) || token.root !== path.resolve(root) || token.generation !== plan.generation) {
    throw new Error('database restore requires an authentic preflight token for this plan and root');
  }
  return state;
}

async function verifyDatabaseRestore(root, plan) {
  try {
    if (!plan || plan.root !== path.resolve(root) || !Array.isArray(plan.steps)) throw new Error('invalid database restore plan');
    const results = [];
    for (const step of plan.steps) {
      const targetPath = canonicalTarget(root, step.target);
      const stat = await fsp.lstat(targetPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`restored SQLite target is not a regular file: ${step.target}`);
      for (const suffix of SIDECARS) {
        if (await pathExists(`${targetPath}${suffix}`)) throw new Error(`restored SQLite target has a sidecar: ${step.target}${suffix}`);
      }
      const bytes = await fsp.readFile(targetPath);
      if (bytes.length !== step.sourceSize || U.sha256(bytes) !== step.sourceSha256) throw new Error(`restored SQLite bytes differ from private backup: ${step.target}`);
      const info = await DB.inspectBackup(root, targetPath);
      if (info.integrity !== 'ok' || info.schemaFingerprint !== step.expectedSchema.fingerprint ||
          JSON.stringify(info.tables) !== JSON.stringify(step.expectedSchema.tables) || info.totalRows !== step.expectedRows) {
        throw new Error(`restored SQLite schema, rows, or integrity differs: ${step.target}`);
      }
      results.push({ target: step.target, bytesMatch: true, integrity: 'ok', schemaMatch: true, rowsMatch: true });
    }
    return { ok: true, status: 'verified', steps: results };
  } catch (error) {
    return { ok: false, status: 'failed', message: error.message };
  }
}

async function applyDatabaseRestore(root, plan, token) {
  const checked = tokenState(root, plan, token);
  const state = planState.get(plan);
  if (state.applied.length) throw new Error('database restore plan has already been applied');
  const staging = await ensurePrivateStage(root, plan.operationId);
  state.staging.push(staging);
  try {
    for (const step of plan.steps) {
      const targetPath = await inspectAbsentTarget(root, step.target);
      const previous = checked.targets.find((item) => item.target === step.target);
      if (!previous || previous.targetPath !== targetPath || previous.artifactSha256 !== step.sourceSha256) {
        throw new Error(`database restore preflight token does not cover target ${step.target}`);
      }
      const bytes = await fsp.readFile(step.sourcePath);
      if (bytes.length !== step.sourceSize || U.sha256(bytes) !== step.sourceSha256) throw new Error(`SQLite backup changed before apply: ${step.target}`);
      const tempPath = path.join(staging, `${crypto.randomUUID()}.sqlite`);
      const handle = await fsp.open(tempPath, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      state.staging.push(tempPath);
      const stagedInfo = await DB.inspectBackup(root, tempPath);
      if (stagedInfo.integrity !== 'ok' || stagedInfo.schemaFingerprint !== step.expectedSchema.fingerprint ||
          JSON.stringify(stagedInfo.tables) !== JSON.stringify(step.expectedSchema.tables) || stagedInfo.totalRows !== step.expectedRows) {
        throw new Error(`staged SQLite backup failed validation: ${step.target}`);
      }
      // Recheck immediately before publication. link() is exclusive: EEXIST
      // never replaces an existing target. Both paths share the same volume.
      await inspectAbsentTarget(root, step.target);
      await fsp.link(tempPath, targetPath);
      const installed = await fsp.stat(targetPath);
      const applied = { target: step.target, targetPath, dev: installed.dev, ino: installed.ino, sourceSha256: step.sourceSha256, sourceSize: step.sourceSize };
      state.applied.push(applied);
      step.applied = true;
      await fsp.unlink(tempPath);
    }
    const verified = await verifyDatabaseRestore(root, plan);
    if (!verified.ok) throw new Error(verified.message || 'SQLite restore verification failed');
    state.verified = true;
    return { ok: true, status: 'applied-verified', steps: state.applied.map((entry) => ({ target: entry.target, created: true, sha256: entry.sourceSha256, size: entry.sourceSize })) };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (!plan.operationId) {
      await fsp.rm(path.dirname(path.dirname(staging)), { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function compensateDatabaseRestore(root, plan, token) {
  tokenState(root, plan, token);
  const state = planState.get(plan);
  const outcomes = [];
  let complete = true;
  for (const applied of [...state.applied].reverse()) {
    try {
      const stat = await fsp.lstat(applied.targetPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== applied.dev || stat.ino !== applied.ino) {
        throw new Error('target identity changed after publication; retained for manual recovery');
      }
      const bytes = await fsp.readFile(applied.targetPath);
      if (bytes.length !== applied.sourceSize || U.sha256(bytes) !== applied.sourceSha256) {
        throw new Error('target bytes changed after publication; retained for manual recovery');
      }
      for (const suffix of SIDECARS) {
        if (await pathExists(`${applied.targetPath}${suffix}`)) throw new Error(`sidecar appeared after publication; retained for manual recovery (${suffix})`);
      }
      await fsp.unlink(applied.targetPath);
      if (await pathExists(applied.targetPath)) throw new Error('target remains after compensation');
      for (const suffix of SIDECARS) {
        if (await pathExists(`${applied.targetPath}${suffix}`)) throw new Error(`sidecar remains after compensation (${suffix})`);
      }
      outcomes.push({ target: applied.target, status: 'removed-and-absence-verified' });
      const step = plan.steps.find((item) => item.target === applied.target);
      if (step) step.applied = false;
    } catch (error) {
      complete = false;
      outcomes.push({ target: applied.target, status: 'rollback-incomplete', reason: error.message });
    }
  }
  if (complete) state.applied.length = 0;
  return { ok: complete, status: complete ? 'compensated' : 'rollback-incomplete', steps: outcomes };
}

function validJournalFileId(value) {
  return value && typeof value.dev === 'string' && /^(0|[1-9][0-9]*)$/.test(value.dev) &&
    typeof value.ino === 'string' && /^(0|[1-9][0-9]*)$/.test(value.ino);
}

async function databaseSidecarsAbsent(targetPath) {
  for (const suffix of SIDECARS) if (await pathExists(`${targetPath}${suffix}`)) return false;
  return true;
}

async function currentDatabaseProof(root, step) {
  const targetPath = canonicalTarget(root, step.target);
  await U.assertNoSymlinkPath(root, targetPath);
  const stat = await fsp.lstat(targetPath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throwWithCode('EROLLBACK_PROOF', `database rollback target is not a regular file: ${step.target}`);
  if (!await databaseSidecarsAbsent(targetPath)) throwWithCode('EROLLBACK_PROOF', `database rollback target has sidecars: ${step.target}`);
  const bytes = await fsp.readFile(targetPath);
  const fileId = { dev: stat.dev.toString(), ino: stat.ino.toString() };
  if (bytes.length !== step.postSize || U.sha256(bytes) !== step.postSha256 ||
      fileId.dev !== step.postFileId.dev || fileId.ino !== step.postFileId.ino) {
    throwWithCode('EROLLBACK_PROOF', `database target bytes, size, or identity changed since restore: ${step.target}`);
  }
  return { targetPath, fileId, size: bytes.length, sha256: U.sha256(bytes) };
}

async function planDatabaseRollback(root, safetySnapshot, { operationId, previousJournal } = {}) {
  const rootAbs = path.resolve(root);
  if (!safetySnapshot?.manifest || !Array.isArray(safetySnapshot.artifacts)) throw new Error('database rollback requires a validated safety snapshot');
  if (safetySnapshot.manifest.schemaVersion !== 2 || safetySnapshot.manifest.state !== 'complete' || safetySnapshot.manifest.kind !== 'auto') {
    throwWithCode('EROLLBACK_PROOF', 'database rollback requires a complete schemaVersion 2 auto safety point');
  }
  const completed = previousJournal?.status === 'completed' && previousJournal?.terminalOutcome === 'verified-complete';
  const interrupted = previousJournal?.status === 'in-progress' && ['applying', 'verifying'].includes(previousJournal?.phase);
  if (!previousJournal || previousJournal.operationId !== operationId || previousJournal.operation !== 'restore' ||
      (!completed && !interrupted) ||
      !Array.isArray(previousJournal.appliedTargets) || !previousJournal.snapshot || !previousJournal.safety ||
      previousJournal.safety.name !== safetySnapshot.manifest.name || previousJournal.safety.generation !== safetySnapshot.manifest.generation) {
    throwWithCode('EROLLBACK_PROOF', 'matching completed restore journal and exact safety generation are required');
  }
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new Error('invalid database rollback operation id');

  const markers = safetySnapshot.artifacts.filter((artifact) => artifact?.layer === 'rollback' && artifact.kind === 'absent');
  const markerTargets = new Set();
  const databaseMarkers = markers.filter((marker) => {
    try { DB.assertDatabaseName(marker.target); return true; }
    catch { return false; }
  });
  // A rollback with no SQLite absence markers has no SQLite source dependency.
  // In particular, unrelated Git/file restores must remain rollbackable after
  // the named snapshot's current pointer has advanced or the source was retired.
  let sourcePlan = { steps: [] };
  if (databaseMarkers.length > 0) {
    const pair = await Store.validateGenerationById(rootAbs, previousJournal.snapshot.name, previousJournal.snapshot.generation);
    const original = {
      manifest: pair.publicManifest,
      layers: pair.layers,
      artifacts: pair.artifacts,
      paths: pair.paths,
      generation: previousJournal.snapshot.generation,
    };
    sourcePlan = await planDatabaseRestore(rootAbs, original, { operationId });
  }
  const steps = [];

  for (const marker of databaseMarkers) {
    let target;
    try { target = DB.assertDatabaseName(marker.target); } catch { continue; }
    const key = target.toLowerCase();
    if (markerTargets.has(key)) throwWithCode('EROLLBACK_PROOF', `duplicate database absence marker: ${target}`);
    markerTargets.add(key);
    if (marker.privacy !== 'private' || marker.required !== true || marker.restore !== 'record-only' || marker.path !== null || marker.sha256 !== null || marker.size !== 0 || marker.absolutePath !== null) {
      throwWithCode('EROLLBACK_PROOF', `malformed database absence marker: ${target}`);
    }
    const matches = previousJournal.appliedTargets.filter((item) => item.target === target);
    if (matches.length === 0 && interrupted) {
      const targetPath = path.join(rootAbs, target);
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const present = await fsp.lstat(`${targetPath}${suffix}`).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error));
        if (present) throwWithCode('EROLLBACK_PROOF', `interrupted database target is not journaled and must be inspected manually: ${target}${suffix}`);
      }
      continue;
    }
    if (matches.length !== 1) throwWithCode('EROLLBACK_PROOF', `restore journal does not uniquely prove database creation: ${target}`);
    const proof = matches[0];
    if (proof.preExists !== false || proof.preSha256 !== null || proof.preSize !== 0 || proof.postExists !== true ||
        !/^[a-f0-9]{64}$/.test(proof.postSha256 || '') || !Number.isSafeInteger(proof.postSize) || proof.postSize <= 0 || !validJournalFileId(proof.postFileId)) {
      throwWithCode('EROLLBACK_PROOF', `restore journal lacks exact database post-state proof: ${target}`);
    }
    const restoreStep = sourcePlan.steps.find((item) => item.target === target);
    if (!restoreStep || restoreStep.sourceSha256 !== proof.postSha256 || restoreStep.sourceSize !== proof.postSize) {
      throwWithCode('EROLLBACK_PROOF', `original private database backup does not match journal post-state: ${target}`);
    }
    const checked = await currentDatabaseProof(rootAbs, { target, postSha256: proof.postSha256, postSize: proof.postSize, postFileId: proof.postFileId });
    const sourceInfo = await DB.inspectBackup(rootAbs, restoreStep.sourcePath);
    if (sourceInfo.integrity !== 'ok' || sourceInfo.schemaFingerprint !== restoreStep.expectedSchema.fingerprint ||
        sourceInfo.totalRows !== restoreStep.expectedRows || JSON.stringify(sourceInfo.tables) !== JSON.stringify(restoreStep.expectedSchema.tables)) {
      throwWithCode('EARTIFACT_INTEGRITY', `original private database backup failed rollback compensation validation: ${target}`);
    }
    steps.push({
      target,
      postSha256: proof.postSha256,
      postSize: proof.postSize,
      postFileId: Object.freeze({ dev: proof.postFileId.dev, ino: proof.postFileId.ino }),
      targetPath: checked.targetPath,
      sourcePath: restoreStep.sourcePath,
      sourceSha256: restoreStep.sourceSha256,
      sourceSize: restoreStep.sourceSize,
      expectedSchema: restoreStep.expectedSchema,
      expectedRows: restoreStep.expectedRows,
      mode: 'sqlite-remove-created',
      applied: false,
    });
  }
  const plan = { root: rootAbs, name: safetySnapshot.manifest.name, generation: safetySnapshot.manifest.generation, operationId, steps, refusals: [] };
  rollbackState.set(plan, { applied: [], staging: [] });
  return plan;
}

async function preflightDatabaseRollback(root, plan) {
  if (!plan || plan.root !== path.resolve(root) || !Array.isArray(plan.steps) || !rollbackState.has(plan)) throw new Error('invalid or unowned database rollback plan');
  const targets = [];
  for (const step of plan.steps) {
    if (step.mode !== 'sqlite-remove-created') throw new Error(`unsupported database rollback mode: ${step.mode}`);
    const proof = await currentDatabaseProof(root, step);
    const sourceBytes = await fsp.readFile(step.sourcePath);
    if (sourceBytes.length !== step.sourceSize || U.sha256(sourceBytes) !== step.sourceSha256) throwWithCode('EARTIFACT_INTEGRITY', `private compensation backup changed: ${step.target}`);
    const info = await DB.inspectBackup(root, step.sourcePath);
    if (info.integrity !== 'ok' || info.schemaFingerprint !== step.expectedSchema.fingerprint || info.totalRows !== step.expectedRows || JSON.stringify(info.tables) !== JSON.stringify(step.expectedSchema.tables)) {
      throwWithCode('EARTIFACT_INTEGRITY', `private compensation backup failed preflight: ${step.target}`);
    }
    targets.push(Object.freeze({ target: step.target, ...proof }));
  }
  const token = Object.freeze({ root: path.resolve(root), generation: plan.generation, tokenId: crypto.randomBytes(16).toString('hex'), targets: Object.freeze(targets) });
  rollbackTokens.set(token, { plan, root: path.resolve(root), targets });
  return token;
}

function rollbackTokenState(root, plan, token) {
  const state = token && rollbackTokens.get(token);
  if (!state || state.plan !== plan || state.root !== path.resolve(root) || token.root !== path.resolve(root) || token.generation !== plan.generation) {
    throw new Error('database rollback requires an authentic preflight token for this plan and root');
  }
  return state;
}

async function verifyDatabaseRollback(root, plan) {
  try {
    if (!plan || plan.root !== path.resolve(root) || !Array.isArray(plan.steps)) throw new Error('invalid database rollback plan');
    const results = [];
    for (const step of plan.steps) {
      const targetPath = canonicalTarget(root, step.target);
      if (await pathExists(targetPath)) throw new Error(`database rollback target remains: ${step.target}`);
      if (!await databaseSidecarsAbsent(targetPath)) throw new Error(`database rollback sidecar remains: ${step.target}`);
      results.push({ target: step.target, absent: true, sidecarsAbsent: true });
    }
    return { ok: true, status: 'verified-absent', steps: results };
  } catch (error) { return { ok: false, status: 'failed', message: error.message }; }
}

async function applyDatabaseRollback(root, plan, token) {
  const checked = rollbackTokenState(root, plan, token);
  const state = rollbackState.get(plan);
  if (state.applied.length) throw new Error('database rollback plan has already been applied');
  if (!plan.steps.length) return { ok: true, status: 'applied-verified', steps: [] };
  const staging = await ensurePrivateStage(root, plan.operationId);
  state.staging.push(staging);
  let preserveStaging = false;
  try {
    for (const step of plan.steps) {
      const tokenTarget = checked.targets.find((item) => item.target === step.target);
      if (!tokenTarget) throw new Error(`database rollback preflight token does not cover ${step.target}`);
      await currentDatabaseProof(root, step);
      if (!await databaseSidecarsAbsent(step.targetPath)) throwWithCode('EROLLBACK_PROOF', `database rollback sidecar appeared: ${step.target}`);
      const quarantine = path.join(staging, `${crypto.randomUUID()}.sqlite`);
      await fsp.rename(step.targetPath, quarantine);
      preserveStaging = true;
      const movedStat = await fsp.lstat(quarantine, { bigint: true });
      const movedBytes = await fsp.readFile(quarantine);
      if (movedStat.dev.toString() !== step.postFileId.dev || movedStat.ino.toString() !== step.postFileId.ino || movedBytes.length !== step.postSize || U.sha256(movedBytes) !== step.postSha256) {
        // Never overwrite a path another process may have created. Keep the
        // quarantined bytes for manual recovery if exclusive restoration fails.
        try { await fsp.link(quarantine, step.targetPath); await fsp.unlink(quarantine); } catch { /* preserved in private staging */ }
        throwWithCode('EROLLBACK_PROOF', `database changed during rollback; quarantined bytes retained: ${step.target}`);
      }
      if (await pathExists(step.targetPath) || !await databaseSidecarsAbsent(step.targetPath)) {
        throwWithCode('EROLLBACK_PROOF', `database path or sidecar appeared during rollback; quarantined bytes retained: ${step.target}`);
      }
      state.applied.push({ step, quarantine, removedId: { dev: movedStat.dev.toString(), ino: movedStat.ino.toString() } });
      step.applied = true;
      await fsp.unlink(quarantine);
      preserveStaging = false;
      const verified = await verifyDatabaseRollback(root, { ...plan, steps: [step] });
      if (!verified.ok) throw new Error(verified.message);
    }
    const verified = await verifyDatabaseRollback(root, plan);
    if (!verified.ok) throw new Error(verified.message);
    return { ok: true, status: 'applied-verified', steps: verified.steps };
  } finally {
    // Keep any quarantined database bytes if the move could not be proven and
    // safely completed. They are private recovery material, not disposable temp.
    if (!preserveStaging) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function compensateDatabaseRollback(root, plan, token) {
  rollbackTokenState(root, plan, token);
  const state = rollbackState.get(plan);
  const outcomes = [];
  let complete = true;
  const staging = await ensurePrivateStage(root, plan.operationId);
  try {
    for (const applied of [...state.applied].reverse()) {
      const step = applied.step;
      try {
        const targetPath = canonicalTarget(root, step.target);
        if (await pathExists(targetPath) || !await databaseSidecarsAbsent(targetPath)) throw new Error('target or sidecar appeared after rollback; external data retained');
        const bytes = await fsp.readFile(step.sourcePath);
        if (bytes.length !== step.sourceSize || U.sha256(bytes) !== step.sourceSha256) throw new Error('private compensation backup changed');
        const info = await DB.inspectBackup(root, step.sourcePath);
        if (info.integrity !== 'ok' || info.schemaFingerprint !== step.expectedSchema.fingerprint || info.totalRows !== step.expectedRows || JSON.stringify(info.tables) !== JSON.stringify(step.expectedSchema.tables)) throw new Error('private compensation backup failed SQLite verification');
        const tempPath = path.join(staging, `${crypto.randomUUID()}.sqlite`);
        const handle = await fsp.open(tempPath, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        const stagedInfo = await DB.inspectBackup(root, tempPath);
        if (stagedInfo.integrity !== 'ok' || stagedInfo.schemaFingerprint !== step.expectedSchema.fingerprint || stagedInfo.totalRows !== step.expectedRows || JSON.stringify(stagedInfo.tables) !== JSON.stringify(step.expectedSchema.tables)) throw new Error('staged compensation database failed verification');
        if (await pathExists(targetPath) || !await databaseSidecarsAbsent(targetPath)) throw new Error('target or sidecar appeared before compensation publish');
        await fsp.link(tempPath, targetPath);
        const stat = await fsp.lstat(targetPath);
        const finalBytes = await fsp.readFile(targetPath);
        if (!stat.isFile() || stat.isSymbolicLink() || finalBytes.length !== step.sourceSize || U.sha256(finalBytes) !== step.sourceSha256) throw new Error('compensated database bytes failed final verification');
        const finalInfo = await DB.inspectBackup(root, targetPath);
        if (finalInfo.integrity !== 'ok' || finalInfo.schemaFingerprint !== step.expectedSchema.fingerprint || finalInfo.totalRows !== step.expectedRows || JSON.stringify(finalInfo.tables) !== JSON.stringify(step.expectedSchema.tables)) throw new Error('compensated database failed final SQLite verification');
        if (!await databaseSidecarsAbsent(targetPath)) throw new Error('compensated database has a sidecar');
        await fsp.unlink(tempPath);
        step.applied = false;
        outcomes.push({ target: step.target, status: 'restored-and-verified' });
      } catch (error) {
        complete = false;
        outcomes.push({ target: step.target, status: 'rollback-incomplete', reason: error.message, retainedQuarantine: await pathExists(applied.quarantine) ? applied.quarantine : undefined });
      }
    }
  } finally {
    const retained = await Promise.all(state.applied.map((item) => pathExists(item.quarantine)));
    if (!retained.some(Boolean)) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  if (complete) state.applied.length = 0;
  return { ok: complete, status: complete ? 'compensated-and-verified' : 'rollback-incomplete', steps: outcomes };
}

module.exports = {
  planDatabaseRestore,
  preflightDatabaseRestore,
  applyDatabaseRestore,
  verifyDatabaseRestore,
  compensateDatabaseRestore,
  planDatabaseRollback,
  preflightDatabaseRollback,
  applyDatabaseRollback,
  verifyDatabaseRollback,
  compensateDatabaseRollback,
};
