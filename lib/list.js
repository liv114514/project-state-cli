'use strict';

const fs = require('fs').promises;
const path = require('path');
const U = require('./utils');
const Store = require('./storage');

const RESULT_SCHEMA_VERSION = 2;
const ERROR_STATES = new Map([
  ['ESCHEMA_UNSUPPORTED', ['unknown', 'SNAPSHOT_SCHEMA_UNSUPPORTED']],
  ['EARTIFACT_MISSING', ['incomplete', 'SNAPSHOT_REQUIRED_ARTIFACT_MISSING']],
  ['EARTIFACT_INTEGRITY', ['invalid', 'SNAPSHOT_INTEGRITY_FAILED']],
  ['EMANIFEST_INVALID', ['invalid', 'SNAPSHOT_METADATA_INVALID']],
  ['EUNSAFE_PATH', ['unknown', 'SNAPSHOT_PATH_UNSAFE']],
  ['EACCES', ['unknown', 'SNAPSHOT_ACCESS_DENIED']],
  ['EPERM', ['unknown', 'SNAPSHOT_ACCESS_DENIED']],
  ['ENOENT', ['incomplete', 'SNAPSHOT_REQUIRED_ARTIFACT_MISSING']],
  ['ENOTDIR', ['unknown', 'SNAPSHOT_PATH_TYPE_INVALID']],
  ['EIO', ['unknown', 'SNAPSHOT_READ_FAILED']],
]);

function safeReason(error) {
  if (error instanceof SyntaxError) return { state: 'invalid', reasonCode: 'SNAPSHOT_METADATA_INVALID' };
  if (error?.code === 'ELEGACY_RESTORE') return { state: 'diagnostic-only', reasonCode: 'LEGACY_V1_DIAGNOSTIC_ONLY' };
  if (error?.code === 'ESNAPSHOT_MISSING') return { state: 'incomplete', reasonCode: 'SNAPSHOT_METADATA_MISSING' };
  const mapped = ERROR_STATES.get(error?.code);
  return mapped ? { state: mapped[0], reasonCode: mapped[1] } : { state: 'unknown', reasonCode: 'SNAPSHOT_INSPECTION_UNAVAILABLE' };
}

function validTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function projectArtifact(artifact, index) {
  const restoreClass = artifact.kind === 'absent' ? 'absent'
    : artifact.restore && artifact.restore !== 'record-only' ? 'supported' : 'record-only';
  return {
    id: artifact.kind === 'layer-json' && ['git', 'deps', 'runtime', 'config', 'docker', 'database'].includes(artifact.layer)
      ? `layer:${artifact.layer}` : `artifact-${index + 1}`,
    layer: ['git', 'deps', 'runtime', 'config', 'docker', 'database', 'rollback'].includes(artifact.layer) ? artifact.layer : 'unknown',
    kind: ['layer-json', 'file', 'absent', 'sqlite-schema', 'sqlite-dump', 'sqlite-backup'].includes(artifact.kind) ? artifact.kind : 'unknown',
    required: artifact.required === true,
    privacy: ['public', 'private'].includes(artifact.privacy) ? artifact.privacy : 'unknown',
    restoreClass,
    target: typeof artifact.target === 'string' ? artifact.target : null,
    integrity: artifact.kind === 'absent' ? 'not-applicable' : artifact.absolutePath ? 'verified' : 'missing',
  };
}

function makeSnapshotRecord(name, checked) {
  const manifest = checked.manifest || {};
  const artifacts = (checked.artifacts || []).map(projectArtifact);
  const layers = Object.entries(manifest.layers || {}).map(([id, layer]) => {
    const safeId = ['git', 'deps', 'runtime', 'config', 'docker', 'database', 'rollback'].includes(id) ? id : 'unknown';
    const layerArtifacts = artifacts.filter((artifact) => artifact.layer === safeId);
    const status = ['collected', 'skipped'].includes(layer?.status) ? layer.status : 'unknown';
    return {
      id: safeId,
      status,
      artifactCount: layerArtifacts.length,
      supportedArtifactCount: layerArtifacts.filter((artifact) => artifact.restoreClass === 'supported').length,
      recordOnlyArtifactCount: layerArtifacts.filter((artifact) => artifact.restoreClass === 'record-only').length,
      privateArtifactCount: layerArtifacts.filter((artifact) => artifact.privacy === 'private').length,
    };
  });
  const requiredCount = artifacts.filter((artifact) => artifact.required).length;
  const requiredPresent = artifacts.filter((artifact) => artifact.required && (artifact.integrity === 'verified' || artifact.integrity === 'not-applicable')).length;
  const schemaVersion = Number.isSafeInteger(manifest.schemaVersion) ? manifest.schemaVersion : null;
  const missingCount = artifacts.filter((artifact) => artifact.integrity === 'missing').length;
  const integrityState = schemaVersion === 1 ? 'not-checked' : requiredCount === requiredPresent ? 'verified' : 'incomplete';
  const state = schemaVersion === 1 ? 'diagnostic-only' : integrityState === 'verified' && missingCount === 0 ? 'verified' : 'incomplete';
  const supportedLayers = [...new Set(artifacts.filter((artifact) => artifact.restoreClass === 'supported').map((artifact) => artifact.layer).filter((layer) => ['config', 'deps', 'runtime', 'database'].includes(layer)))];
  const nextStep = state === 'verified' && supportedLayers.length
    ? { action: 'preview-supported-restore', command: 'restore', args: [name, '--dry-run'], cwd: 'current-working-directory', confirmation: 'none-for-preview', effects: 'may-create-and-release-lock-pin-metadata', revalidates: true }
    : { action: 'preserve-and-review', command: null, args: [], cwd: 'current-working-directory', confirmation: 'none', effects: 'none', revalidates: true };
  return {
    name,
    generation: typeof checked.generation === 'string' ? checked.generation : typeof manifest.generation === 'string' ? manifest.generation : null,
    createdAt: validTimestamp(manifest.createdAt) ? manifest.createdAt : null,
    kind: ['named', 'auto', 'hook'].includes(manifest.kind) ? manifest.kind : 'unknown',
    schemaVersion,
    state,
    checks: [
      { id: 'snapshot.metadata', state: schemaVersion === 1 ? 'not-applicable' : 'ok', required: true, reasonCode: schemaVersion === 1 ? 'LEGACY_V1_DIAGNOSTIC_ONLY' : 'SNAPSHOT_METADATA_VALIDATED' },
      { id: 'snapshot.artifacts', state: integrityState === 'verified' ? 'ok' : schemaVersion === 1 ? 'not-applicable' : 'issue', required: true, reasonCode: schemaVersion === 1 ? 'LEGACY_ARTIFACTS_NOT_VALIDATED' : integrityState === 'verified' ? 'REQUIRED_ARTIFACTS_VERIFIED' : 'REQUIRED_ARTIFACTS_INCOMPLETE' },
    ],
    integrity: { state: integrityState, requiredArtifacts: requiredCount, requiredVerified: requiredPresent, missingArtifacts: missingCount, totalArtifacts: artifacts.length },
    inputCompleteness: schemaVersion === 1 ? 'unknown' : layers.some((layer) => layer.status === 'skipped') || missingCount ? 'partial' : 'complete',
    layers,
    artifacts,
    environment: { restorePrerequisites: 'not-checked', applicationHealth: 'not-tested' },
    nextStep,
    limitations: [
      'Stored input integrity does not establish that the current environment can restore it.',
      'Application health and runtime behavior were not tested.',
      'Database row contents are not included in this inspection result.',
    ],
  };
}

async function inspectSnapshot(root, name, { missingIsMissing = false } = {}) {
  try { Store.assertName(name); }
  catch { return { name: 'invalid', state: 'invalid', reasonCode: 'SNAPSHOT_NAME_INVALID' }; }
  if (missingIsMissing) {
    const paths = U.snapshotPaths(root, name);
    try { await Store.assertNoLinks(paths.snapDir, { allowMissing: false }); }
    catch (error) {
      if (error.code === 'ENOENT') return { name, state: 'missing', reasonCode: 'SNAPSHOT_NOT_FOUND', checks: [{ id: 'snapshot.presence', state: 'issue', required: true, reasonCode: 'SNAPSHOT_NOT_FOUND' }] };
      return failedSnapshot(name, error);
    }
  }
  try {
    const checked = await Store.validateSnapshot(root, name, { mode: 'diagnostic' });
    return makeSnapshotRecord(name, checked);
  } catch (error) {
    return failedSnapshot(name, error);
  }
}

function failedSnapshot(name, error) {
  const failure = safeReason(error);
  return {
    name, state: failure.state, reasonCode: failure.reasonCode,
    ...(failure.state === 'incomplete' ? { integrity: { state: 'incomplete', requiredArtifacts: null, requiredVerified: null, missingArtifacts: null, totalArtifacts: null } } : {}),
    checks: [{ id: 'snapshot.inspection', state: ['invalid', 'incomplete'].includes(failure.state) ? 'issue' : 'unknown', required: true, reasonCode: failure.reasonCode }],
  };
}

function errorRecord(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const mapped = ERROR_STATES.get(code);
  const allowedSystemCode = ['EACCES', 'EPERM', 'ENOTDIR', 'ELOOP', 'EIO'].includes(code) ? code : null;
  return { state: 'unreadable', reasonCode: mapped?.[1] || 'SNAPSHOT_INVENTORY_UNREADABLE', systemCode: allowedSystemCode };
}

async function findLegacyDatabaseBackups(root, snapshotNames) {
  const found = [], errors = [];
  const base = path.join(root, U.SNAPSHOTS_DIR);
  let names;
  try {
    if (snapshotNames) names = snapshotNames;
    else { await Store.assertNoLinks(base, { allowMissing: true }); names = await fs.readdir(base); }
  } catch (error) { return error.code === 'ENOENT' ? { found, errors } : { found, errors: [{ reasonCode: 'LEGACY_SCAN_UNAVAILABLE' }] }; }
  for (const name of names) {
    if (!U.NAME_RE.test(name)) continue;
    const snap = path.join(base, name);
    try {
      const snapStat = await fs.lstat(snap);
      if (!snapStat.isDirectory() || snapStat.isSymbolicLink()) continue;
      const files = path.join(snap, 'files');
      const filesStat = await fs.lstat(files);
      if (!filesStat.isDirectory() || filesStat.isSymbolicLink()) continue;
      const legacy = path.join(files, 'db-original');
      try {
        const st = await fs.lstat(legacy);
        if (st.isDirectory() || st.isSymbolicLink()) found.push({ name, symlink: st.isSymbolicLink() });
      } catch (error) { if (error.code !== 'ENOENT') errors.push({ name, reasonCode: 'LEGACY_SCAN_UNAVAILABLE' }); }
    } catch (error) { if (error.code !== 'ENOENT') errors.push({ name, reasonCode: 'LEGACY_SCAN_UNAVAILABLE' }); }
  }
  return { found, errors };
}

async function inspectInventory(root) {
  const base = path.join(root, U.SNAPSHOTS_DIR);
  let names = [];
  let inventoryState;
  try {
    await Store.assertNoLinks(base, { allowMissing: true });
    names = await fs.readdir(base);
    inventoryState = names.length ? 'available' : 'empty';
  } catch (error) {
    if (error.code === 'ENOENT') inventoryState = 'missing';
    else return {
      resultSchemaVersion: RESULT_SCHEMA_VERSION,
      toolVersion: U.TOOL_VERSION,
      command: 'list',
      inventory: { state: 'unreadable', snapshotCount: 0, diagnosticCount: 1, unrecognizedEntryCount: 0, reasonCode: errorRecord(error).reasonCode, systemCode: errorRecord(error).systemCode },
      snapshots: [],
      diagnostics: [{ reasonCode: errorRecord(error).reasonCode }],
      legacy: { privateDatabasePathCount: 0, diagnosticCount: 0 },
    };
  }

  const unrecognized = names.filter((name) => !U.NAME_RE.test(name));
  const candidates = names.filter((name) => U.NAME_RE.test(name)).sort();
  const snapshots = [];
  for (const name of candidates) snapshots.push(await inspectSnapshot(root, name));
  snapshots.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || a.name.localeCompare(b.name) || String(a.generation || '').localeCompare(String(b.generation || '')));
  const legacy = await findLegacyDatabaseBackups(root, names);
  const diagnostics = [];
  for (const row of snapshots) {
    if (row.state !== 'verified' && row.state !== 'diagnostic-only') diagnostics.push({ name: row.name, state: row.state, reasonCode: row.reasonCode || (row.state === 'incomplete' ? 'SNAPSHOT_REQUIRED_ARTIFACT_MISSING' : 'SNAPSHOT_INSPECTION_UNAVAILABLE') });
  }
  if (unrecognized.length) diagnostics.push({ reasonCode: 'UNRECOGNIZED_INVENTORY_ENTRIES', count: unrecognized.length });
  if (legacy.found.length) diagnostics.push({ reasonCode: 'LEGACY_PRIVATE_DATABASE_PATH_PRESENT', count: legacy.found.length });
  diagnostics.push(...legacy.errors);
  const diagnosticCount = diagnostics.length;
  if (inventoryState !== 'missing' && inventoryState !== 'empty' && diagnosticCount) inventoryState = 'incomplete';
  if (inventoryState === 'empty' && diagnosticCount) inventoryState = 'incomplete';
  return {
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    toolVersion: U.TOOL_VERSION,
    command: 'list',
    inventory: { state: inventoryState, snapshotCount: snapshots.length, diagnosticCount, unrecognizedEntryCount: unrecognized.length },
    snapshots,
    diagnostics,
    legacy: { privateDatabasePathCount: legacy.found.length, diagnosticCount: legacy.errors.length },
  };
}

function printJson(value) { console.log(JSON.stringify(value)); }

function printInventoryText(result) {
  const { state, snapshotCount } = result.inventory;
  if (state === 'unreadable') {
    const detail = result.inventory.systemCode || result.inventory.reasonCode;
    U.printError('Snapshot inventory could not be read.', `The inventory state is unknown (${detail}); no snapshot was created or repaired.`, 'Preserve .project-state and resolve the path or permission problem before listing or writing snapshots again.');
    return 2;
  }
  if (!snapshotCount) {
    console.log(state === 'empty' ? `Snapshot inventory is empty in ${U.SNAPSHOTS_DIR}/.` : `No snapshot inventory exists yet at ${U.SNAPSHOTS_DIR}/.`);
    if (!result.inventory.diagnosticCount) console.log(`Create one with: ${U.cliNext(['snapshot', 'before-change'], 'project-state snapshot before-change')}`);
    const legacy = result.diagnostics.filter((item) => item.reasonCode === 'LEGACY_PRIVATE_DATABASE_PATH_PRESENT');
    if (legacy.length) U.warn(`PRIVACY WARNING: legacy v1 files/db-original path(s) found; path presence only was checked. Contents were not read, executed, migrated, or deleted. v1 is diagnostic-only.`);
    return 0;
  }
  console.log(`Snapshots in ${U.SNAPSHOTS_DIR}/ (newest first):\n`);
  const rows = [...result.snapshots].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || a.name.localeCompare(b.name) || String(a.generation || '').localeCompare(String(b.generation || '')));
  for (const row of rows.filter((item) => ['verified', 'diagnostic-only'].includes(item.state))) {
    const tag = row.state === 'diagnostic-only' ? '[legacy]' : row.kind === 'auto' ? '[auto]' : row.kind === 'hook' ? '[hook]' : '[named]';
    const integrity = row.state === 'diagnostic-only' ? `diagnostic-only (schema v${row.schemaVersion})` : row.integrity.state === 'verified' ? `schema v${row.schemaVersion} artifacts validated` : 'incomplete or unavailable';
    console.log(`  ${row.name.padEnd(24)} ${U.formatTime(row.createdAt)} ${tag.padEnd(9)} generation ${row.generation || '(unknown)'}`);
    console.log(`    Integrity: ${integrity}; ${row.integrity.requiredVerified} required artifact(s) verified (${row.integrity.totalArtifacts} total); application health not tested.`);
    console.log(`    Collection: ${row.layers.length} layer(s), ${row.layers.filter((layer) => layer.status === 'collected').length} collected.`);
    console.log(`    Layer scope: ${row.layers.map((layer) => `${layer.id}=${layer.status} (${layer.supportedArtifactCount} supported, ${layer.recordOnlyArtifactCount} record-only, ${layer.privateArtifactCount} private)`).join('; ') || 'none recorded'}`);
  }
  const damaged = result.snapshots.filter((row) => !['verified', 'diagnostic-only'].includes(row.state));
  if (damaged.length) U.warn(`Excluded ${damaged.length} incomplete, unsupported, or damaged snapshot(s): ${damaged.map((row) => `${row.name} (${row.reasonCode || row.state})`).join('; ')}; inventory is not declared complete.`);
  if (result.inventory.unrecognizedEntryCount) U.warn(`Inventory contains ${result.inventory.unrecognizedEntryCount} unrecognized entr${result.inventory.unrecognizedEntryCount === 1 ? 'y' : 'ies'}; inventory is not declared complete.`);
  if (result.legacy.privateDatabasePathCount) U.warn(`PRIVACY WARNING: legacy v1 files/db-original path(s) may contain private database bytes in the public snapshot tree. Path presence only was checked; contents were not read, executed, migrated, or deleted. v1 is diagnostic-only.`);
  if (result.legacy.diagnosticCount) U.warn(`Could not fully inspect ${result.legacy.diagnosticCount} legacy database path candidate(s); inventory is not declared complete.`);
  console.log('Artifact validity describes stored inputs only; environment prerequisites were not checked and application health was not tested.');
  console.log('Use "project-state restore <name>" only for supported, validated v2 artifacts.');
  return 0;
}

async function listCmd(root, { json = false } = {}) {
  const result = await inspectInventory(root);
  if (json) { printJson(result); return result.inventory.state === 'unreadable' ? 2 : 0; }
  return printInventoryText(result);
}

async function showCmd(root, name, { json = false } = {}) {
  const result = {
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    toolVersion: U.TOOL_VERSION,
    command: 'show',
    snapshot: await inspectSnapshot(root, name, { missingIsMissing: true }),
  };
  if (json) printJson(result);
  else {
    const row = result.snapshot;
    if (row.state === 'missing') { U.printError('Snapshot was not found.', 'No snapshot with that name exists in the current project.', 'Run project-state list to inspect the current inventory.'); return 1; }
    if (row.state === 'unknown' || row.state === 'invalid' || row.state === 'incomplete') { U.printError('Snapshot details could not be fully verified.', `Inspection result: ${row.reasonCode || row.state}.`, 'Preserve the snapshot and private state; do not restore it until the reported condition is resolved.'); return 2; }
    console.log(`${row.name} (generation ${row.generation || '(unknown)'})`);
    console.log(`Created: ${row.createdAt || '(unknown)'}; kind=${row.kind}; schema=v${row.schemaVersion}; state=${row.state}`);
    for (const layer of row.layers) console.log(`Layer ${layer.id}: ${layer.status}; ${layer.artifactCount} artifact(s), ${layer.supportedArtifactCount} supported, ${layer.recordOnlyArtifactCount} record-only, ${layer.privateArtifactCount} private.`);
    for (const artifact of row.artifacts) console.log(`Artifact ${artifact.id}: ${artifact.layer}/${artifact.kind}; ${artifact.restoreClass}; ${artifact.integrity}; ${artifact.privacy}${artifact.target ? `; target=${artifact.target}` : ''}`);
    console.log('Current environment prerequisites were not checked; application health was not tested.');
    for (const limitation of row.limitations) console.log(`Limit: ${limitation}`);
  }
  if (result.snapshot.state === 'missing') return 1;
  if (result.snapshot.state === 'unknown' || result.snapshot.state === 'invalid' || result.snapshot.state === 'incomplete') return 2;
  return 0;
}

module.exports = { listCmd, showCmd, inspectInventory, inspectSnapshot, findLegacyDatabaseBackups };
