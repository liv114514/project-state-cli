'use strict';

const fs = require('fs').promises;
const path = require('path');
const U = require('./utils');
const Store = require('./storage');

// Inspect only the old v1 path convention. No file contents are read and no
// legacy artifact is parsed, executed, migrated, or deleted.
async function findLegacyDatabaseBackups(root, snapshotNames) {
  const found = [], errors = [];
  const base = path.join(root, U.SNAPSHOTS_DIR);
  let names;
  try {
    if (snapshotNames) names = snapshotNames;
    else { await Store.assertNoLinks(base, { allowMissing: true }); names = await fs.readdir(base); }
  }
  catch (e) { return e.code === 'ENOENT' ? { found, errors } : { found, errors: [`${base}: ${e.message}`] }; }
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
        if (st.isDirectory() || st.isSymbolicLink()) found.push({ name, path: legacy, symlink: st.isSymbolicLink() });
      } catch (e) { if (e.code !== 'ENOENT') errors.push(`${legacy}: ${e.message}`); }
    } catch (e) { if (e.code !== 'ENOENT') errors.push(`${snap}: ${e.message}`); }
  }
  return { found, errors };
}

async function listCmd(root) {
  const base = path.join(root, U.SNAPSHOTS_DIR);
  let names = [];
  let inventoryExists = true;
  try { await Store.assertNoLinks(base, { allowMissing: true }); names = await fs.readdir(base); }
  catch (e) {
    if (e.code === 'ENOENT') inventoryExists = false;
    else {
      U.printError('Snapshot inventory could not be read.', `The inventory state is unknown (${e.code || 'filesystem error'}); no snapshot was created or repaired.`, 'Preserve .project-state and resolve the path or permission problem before listing or writing snapshots again.');
      return 2;
    }
  }
  const legacy = await findLegacyDatabaseBackups(root, names);
  names = names.filter((name) => U.NAME_RE.test(name)).sort();
  if (!names.length) {
    if (legacy.errors.length) {
      U.printError('Snapshot inventory is not verifiably empty.', 'No complete snapshots were found, but legacy snapshot paths could not be fully inspected.', 'Preserve the existing state directory and resolve the reported inspection errors before creating or restoring snapshots.');
      reportLegacyBackups(legacy);
      return 2;
    }
    if (inventoryExists) console.log(`Snapshot inventory is empty in ${U.SNAPSHOTS_DIR}/.`);
    else console.log(`No snapshot inventory exists yet at ${U.SNAPSHOTS_DIR}/.`);
    console.log(`Create one with: ${U.cliNext(['snapshot', 'before-change'], 'project-state snapshot before-change')}`);
    reportLegacyBackups(legacy);
    return 0;
  }

  const rows = [], damaged = [];
  for (const name of names) {
    try {
      const checked = await Store.validateSnapshot(root, name, { mode: 'diagnostic' });
      const m = checked.manifest;
      const layers = Object.values(m.layers || {});
      const collected = layers.filter((layer) => layer && layer.status === 'collected').length;
      const layerDetails = Object.entries(m.layers || {}).map(([id, layer]) => {
        const artifacts = (checked.artifacts || []).filter((artifact) => artifact.layer === id);
        const restorable = artifacts.filter((artifact) => artifact.restore && artifact.restore !== 'record-only').length;
        const recordOnly = artifacts.length - restorable;
        const privateCount = artifacts.filter((artifact) => artifact.privacy === 'private').length;
        return { id, status: layer?.status || 'unknown', restorable, recordOnly, privateCount };
      });
      rows.push({
        name, generation: checked.generation || m.generation || '',
        createdAt: m.createdAt, kind: m.kind, collected, total: layers.length,
        artifacts: (checked.artifacts || []).length,
        requiredArtifacts: (checked.artifacts || []).filter((artifact) => artifact.required === true).length,
        layerDetails,
        restorable: checked.restorable === true,
        schemaVersion: m.schemaVersion,
        warnings: Array.isArray(checked.warnings) ? checked.warnings : [],
        legacy: m.schemaVersion !== 2,
      });
    } catch (e) { damaged.push(`${name} (${e.code || e.message})`); }
  }
  rows.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || a.name.localeCompare(b.name) || a.generation.localeCompare(b.generation));
  console.log(`Snapshots in ${U.SNAPSHOTS_DIR}/ (newest first):\n`);
  for (const row of rows) {
    const tag = row.legacy ? '[legacy]' : row.kind === 'auto' ? '[auto]' : row.kind === 'hook' ? '[hook]' : '[named]';
    const integrity = row.legacy ? `diagnostic-only (schema v${row.schemaVersion})` : row.restorable ? 'schema v2 artifacts validated' : 'diagnostic-only or incomplete';
    const capability = row.restorable ? 'application health not tested' : 'no supported restore claim';
    console.log(`  ${row.name.padEnd(24)} ${U.formatTime(row.createdAt)} ${tag.padEnd(9)} generation ${row.generation || '(unknown)'}`);
    console.log(`    Integrity: ${integrity}; ${row.requiredArtifacts} required artifact(s) verified (${row.artifacts} total); ${capability}.`);
    console.log(`    Collection: ${row.total} layer(s), ${row.collected} collected.`);
    console.log(`    Layer scope: ${row.layerDetails.map((layer) => layer.status === 'skipped'
      ? `${layer.id}=skipped`
      : `${layer.id}=collected (${layer.restorable} restorable, ${layer.recordOnly} record-only, ${layer.privateCount} private)`).join('; ') || 'none recorded'}`);
    for (const warning of row.warnings) console.log(`    warning: ${warning}`);
  }
  if (rows.length) console.log('\nArtifact validity describes stored inputs only; it does not mean the environment or application is healthy.');
  console.log('Use "project-state restore <name>" only for supported, validated v2 artifacts.');
  if (damaged.length) U.warn(`Excluded ${damaged.length} incomplete, unsupported, or damaged snapshot(s): ${damaged.join('; ')}`);
  reportLegacyBackups(legacy);
  return 0;
}

function reportLegacyBackups(scan) {
  if (scan.found.length) {
    const items = scan.found.map((x) => `${x.name}: ${x.path}${x.symlink ? ' (link, not traversed)' : ''}`);
    U.warn(`PRIVACY WARNING: legacy v1 files/db-original path(s) found: ${items.join('; ')}. They may contain private database bytes in the public snapshot tree. Path presence only was checked; contents were not read, executed, migrated, or deleted. v1 is diagnostic-only.`);
  }
  if (scan.errors.length) U.warn(`Could not fully inspect legacy database paths: ${scan.errors.join('; ')}`);
}

module.exports = { listCmd, findLegacyDatabaseBackups };
