'use strict';

const fs = require('fs').promises;
const path = require('path');
const U = require('./utils');
const Store = require('./storage');

function validCreatedAt(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now) return false;
  const canonical = new Date(time).toISOString();
  return value === canonical || value === canonical.replace('.000Z', 'Z');
}

function collisionOrdinal(name) {
  const match = /^(?:auto|hook)-\d{8}-\d{6}(?:-(\d+))?$/.exec(name);
  return match ? (match[1] ? Number(match[1]) : 0) : Number.MAX_SAFE_INTEGER;
}

function managedKindMatches(name, kind) {
  return kind === 'auto' ? U.AUTO_RE.test(name) : kind === 'hook' ? U.HOOK_RE.test(name) : false;
}

async function pruneCmd(root, opts = {}) {
  const keepRaw = opts.keep === undefined ? 10 : opts.keep;
  if (!/^\d+$/.test(String(keepRaw)) || !Number.isSafeInteger(Number(keepRaw))) {
    U.printError(`Invalid --keep value "${keepRaw}".`, 'Expected a safe whole number >= 0.', 'Example: project-state prune --keep 5');
    return 1;
  }

  let lock;
  try { lock = await Store.acquireOperationLock(root, { operation: 'prune' }); }
  catch (e) {
    U.printError('Cannot start prune.', e.message, 'Wait for the active project-state operation to finish, then retry.');
    return 2;
  }

  let preserveLock = false;
  let intentStarted = false;
  try {
    const base = path.join(root, U.SNAPSHOTS_DIR);
    let names = [];
    try { await Store.assertNoLinks(base, { allowMissing: false }); names = await fs.readdir(base); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const now = Date.now();
    const candidates = [];
    const retained = [];
    const protectionIndex = await Store.generationProtectionIndex(root);
    for (const name of names.filter((n) => U.NAME_RE.test(n)).sort()) {
      let checked;
      try { checked = await Store.validateSnapshot(root, name, { mode: 'diagnostic' }); }
      catch (e) { if (U.isAutoManaged(name)) retained.push(`${name} (unverified: ${e.code || e.message})`); continue; }
      const manifest = checked.manifest;
      if (!managedKindMatches(name, manifest.kind)) continue;
      if (manifest.state !== 'complete' || !/^[a-f0-9]{32}$/.test(checked.generation || manifest.generation || '') || !validCreatedAt(manifest.createdAt, now)) {
        retained.push(`${name} (invalid or future timestamp/generation)`);
        continue;
      }
      const generation = checked.generation || manifest.generation;
      if (protectionIndex.has(`${name}\0${generation}`)) {
        retained.push(`${name} (pinned or referenced by an unresolved operation)`);
        continue;
      }
      candidates.push({ name, kind: manifest.kind, createdAt: manifest.createdAt, time: Date.parse(manifest.createdAt), generation });
    }

    candidates.sort((a, b) => a.time - b.time || collisionOrdinal(a.name) - collisionOrdinal(b.name) || a.name.localeCompare(b.name) || a.generation.localeCompare(b.generation));
    const deleteCandidates = candidates.slice(0, Math.max(0, candidates.length - Number(keepRaw)));
    const pinnedCount = retained.filter((r) => r.includes('pinned or referenced')).length;
    console.log(`Validated auto/hook generations: ${candidates.length + pinnedCount} | keeping at least ${keepRaw} unpinned | would retire ${deleteCandidates.length}:`);
    for (const row of deleteCandidates) console.log(`  ${row.name} [${row.kind}] ${row.createdAt} generation=${row.generation}`);
    if (retained.length) U.warn(`Retained ${retained.length} unverified, invalid-time, pinned, or unresolved snapshot(s): ${retained.join('; ')}`);
    if (!opts.yes) {
      console.log('Dry run - nothing was deleted. Re-run with --yes to retire the listed generations.');
      return 0;
    }
    if (!deleteCandidates.length) {
      console.log('No eligible auto/hook generation can be retired.');
      return 0;
    }

    await Store.beginPruneTransaction(root, lock, deleteCandidates);
    intentStarted = true;
    const outcome = await Store.continuePruneTransaction(root, lock);
    console.log(`Prune completed and verified: retired ${outcome.retired} planned auto/hook generation(s).`);
    return 0;
  } catch (e) {
    if (intentStarted || e.pruneIntentMayExist) preserveLock = true;
    U.printError('Prune stopped with a durable operation record; do not retry ordinary prune until it is inspected.', e.message,
      intentStarted || e.pruneIntentMayExist ? `Run project-state recover ${lock.operationId} --inspect. If it reports a supported owner-bound prune transaction, run project-state recover ${lock.operationId} --continue --yes. Preserve every referenced generation and pin.` : 'No prune retirement began; inspect the snapshot inventory and retry after resolving the reported preflight issue.');
    return 2;
  } finally { if (!preserveLock) await lock.release().catch(() => {}); }
}

module.exports = { pruneCmd, validCreatedAt, collisionOrdinal };
