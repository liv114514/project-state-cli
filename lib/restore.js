'use strict';

// Restore only a validated, explicitly supported subset. All destructive
// steps are preceded by a private, verified safety generation.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const U = require('./utils');
const Store = require('./storage');
const Git = require('./restore-git');
const DB = require('./restore-database');
const Database = require('./database');
const { snapshotInternal } = require('./snapshot');

const hash = (bytes) => Store.hash(bytes);
function shellQuote(value, shell) {
  const text = String(value);
  if (shell === 'powershell') return `'${text.replace(/'/g, "''")}'`;
  if (shell === 'cmd') return `"${text.replace(/"/g, '""')}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
function restoreCommandArgs(name, options = {}) {
  const args = ['restore', name];
  if (options.onlyLayers?.length) args.push('--only', options.onlyLayers.join(','));
  if (options.force) args.push('--force');
  args.push('--yes');
  if (options.rollbackOf) args.push('--rollback-of', options.rollbackOf);
  return args;
}
function rollbackCommands(name, operationId) {
  const cliPath = path.resolve(__dirname, '..', 'bin', 'project-state.js');
  const nodePath = process.execPath;
  const args = restoreCommandArgs(name, { rollbackOf: operationId });
  if (process.platform === 'win32') {
    const powershell = `& ${shellQuote(nodePath, 'powershell')} ${shellQuote(cliPath, 'powershell')} ${args.map((arg) => shellQuote(arg, 'powershell')).join(' ')}`;
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const powershellPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // CMD expands %VAR% even inside double quotes and can expand !VAR! when
    // delayed expansion is enabled. Use an absolute system launcher (so the
    // project cwd cannot shadow powershell.exe) and keep CMD's remaining input
    // to a safe Base64 alphabet. The final exit copies Node's result to CMD.
    const commandPrompt = `${shellQuote(powershellPath, 'cmd')} -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`${powershell}; exit $LASTEXITCODE`, 'utf16le').toString('base64')}`;
    return [
      `Exact rollback command (PowerShell): ${powershell}`,
      `Command Prompt equivalent (encoded PowerShell): ${commandPrompt}`,
    ];
  }
  const posix = [nodePath, cliPath, ...args].map((arg) => shellQuote(arg, 'posix')).join(' ');
  return [`Exact rollback command: ${posix}`];
}
const fileState = async (absolute) => {
  let handle;
  try {
    await Store.assertNoLinks(absolute, { hardlinks: true });
    const stat = await fsp.lstat(absolute, { bigint: true });
    if (!stat.isFile()) throw Store.coded('EUNSAFE_PATH', `restore target is not a regular file: ${path.basename(absolute)}`);
    handle = await fsp.open(absolute, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink > 1n || before.dev !== stat.dev || before.ino !== stat.ino) throw Store.coded('EUNSAFE_PATH', 'restore target identity changed while opening');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== after.size) throw Store.coded('ESOURCE_CHANGED', 'restore target changed while reading');
    return { exists: true, bytes, sha256: hash(bytes), size: bytes.length, dev: before.dev.toString(), ino: before.ino.toString() };
  } catch (error) { if (error.code === 'ENOENT') return { exists: false, bytes: null, sha256: null, size: 0 }; throw error; }
  finally { await handle?.close().catch(() => {}); }
};
const gitJournalState = (state) => ({ head: state?.head || null, branchRef: state?.branchRef || null, indexTree: state?.indexTree || null, refs: state?.refs || {}, clean: state?.clean ?? true });
function fileArtifacts(validated) {
  return validated.artifacts.filter((artifact) => artifact.restore === 'restore-file' && artifact.kind === 'file');
}
const SELECTABLE_LAYERS = ['config', 'deps', 'runtime'];
function normalizeLayerSelection(onlyLayers) {
  if (onlyLayers === undefined || onlyLayers === null) return null;
  if (!Array.isArray(onlyLayers) || onlyLayers.length === 0 || onlyLayers.some((layer) => !SELECTABLE_LAYERS.includes(layer)) || new Set(onlyLayers).size !== onlyLayers.length) {
    throw Store.coded('ERESTORE_SELECTION', 'restore selection must be a non-empty unique subset of config, deps, runtime');
  }
  return SELECTABLE_LAYERS.filter((layer) => onlyLayers.includes(layer));
}
async function rootFileSteps(root, validated, layers = null) {
  const out = [];
  const seen = new Set();
  for (const artifact of fileArtifacts(validated)) {
    if (layers && !layers.includes(artifact.layer)) continue;
    if (artifact.privacy !== 'private' || artifact.required !== true || !['config', 'deps', 'runtime', 'rollback'].includes(artifact.layer)) throw Store.coded('EMANIFEST_INVALID', `unsupported restorable file artifact ${artifact.id}`);
    const target = await Store.validateRestoreTarget(root, artifact.target, artifact.layer);
    const key = artifact.target.toLowerCase();
    if (seen.has(key)) throw Store.coded('EMANIFEST_INVALID', `duplicate restore target: ${artifact.target}`);
    seen.add(key);
    if (!artifact.absolutePath) throw Store.coded('EARTIFACT_MISSING', `restore artifact is missing: ${artifact.id}`);
    out.push({ artifact, target: artifact.target, absolute: target });
  }
  return out;
}
function canonicalObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Store.coded('ERESTORE_SELECTION', 'dependency declaration data has an unsupported shape');
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}
async function validateSelectedLayerInputs(validated, allFileSteps, selectedLayers) {
  if (!selectedLayers) return;
  const manifestLayers = validated.manifest.layers || {};
  for (const layer of selectedLayers) {
    if (manifestLayers[layer]?.status !== 'collected') throw Store.coded('ERESTORE_SELECTION', `selected layer ${layer} was not collected in this snapshot`);
  }
  if (selectedLayers.includes('deps')) {
    const metadata = validated.layers?.deps;
    if (metadata?.lockFile !== 'package-lock.json') throw Store.coded('ERESTORE_SELECTION', 'selective dependency restore currently requires a captured npm package-lock.json; other or missing lockfiles are unsupported');
    const pkgSteps = allFileSteps.filter((step) => step.artifact.layer === 'deps' && step.target === 'package.json');
    const lockSteps = allFileSteps.filter((step) => step.artifact.layer === 'deps' && step.target === 'package-lock.json');
    if (pkgSteps.length !== 1 || lockSteps.length !== 1) throw Store.coded('ERESTORE_SELECTION', 'selective dependency restore requires exactly one package.json and one package-lock.json artifact');
    let pkg, lock;
    try {
      pkg = JSON.parse((await fsp.readFile(pkgSteps[0].artifact.absolutePath)).toString('utf8'));
      lock = JSON.parse((await fsp.readFile(lockSteps[0].artifact.absolutePath)).toString('utf8'));
    } catch { throw Store.coded('ERESTORE_SELECTION', 'package.json or package-lock.json is not valid JSON'); }
    const root = lock?.packages?.[''];
    if (!root || typeof root !== 'object' || Array.isArray(root)) throw Store.coded('ERESTORE_SELECTION', 'package-lock.json has no supported root package entry');
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const declared = pkg?.[key] ?? {};
      const locked = root[key] ?? {};
      if (canonicalObject(declared) !== canonicalObject(locked)) throw Store.coded('ERESTORE_SELECTION', `package.json and package-lock.json disagree on ${key}; selective dependency restore refused`);
    }
  }
  const selected = new Set(selectedLayers);
  const selectedSteps = allFileSteps.filter((step) => selected.has(step.artifact.layer));
  for (const layer of selectedLayers) {
    if (!selectedSteps.some((step) => step.artifact.layer === layer)) throw Store.coded('ERESTORE_SELECTION', `selected layer ${layer} has no restorable file artifacts`);
  }
}
function sameObservedFileState(a, b) {
  return a.exists === b.exists && (!a.exists || (a.sha256 === b.sha256 && a.size === b.size && a.dev === b.dev && a.ino === b.ino));
}
function assertSelectiveGitUnchanged(before, after, allowedTargets) {
  if (before.isGit !== after.isGit) throw new Error('Git repository availability changed during selective restore');
  if (!before.isGit) return;
  if (before.head !== after.head || before.branchRef !== after.branchRef || before.indexTree !== after.indexTree || before.refsText !== after.refsText) {
    throw new Error('selective restore changed Git HEAD, branch attachment, refs, or index');
  }
  const allowed = new Set(allowedTargets.map((target) => target.toLowerCase()));
  const unexpected = after.dirty.filter((entry) => !allowed.has(entry.path.replace(/\\/g, '/').toLowerCase()));
  if (unexpected.length) throw new Error(`selective restore changed unselected Git paths: ${unexpected.map((entry) => entry.path).join(', ')}`);
}

async function bindPostCheckoutFileStates(root, steps, commit, observedGit) {
  if (!commit) return;
  const output = await Git.required(root, ['ls-tree', '-r', '-z', '--full-tree', commit], 'restore target file states');
  const tree = new Map();
  for (const record of output.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('malformed NUL-delimited Git tree record');
    const metadata = record.slice(0, tab).split(' ');
    if (metadata.length !== 3) throw new Error('malformed Git tree metadata');
    tree.set(record.slice(tab + 1), { mode: metadata[0], oid: metadata[2] });
  }
  for (const step of steps) {
    const expected = tree.get(step.target);
    const actual = await fileState(step.absolute);
    if (expected) {
      if (!['100644', '100755'].includes(expected.mode) || !actual.exists) throw new Error(`Git checkout did not produce a supported regular-file target: ${step.target}`);
      if (observedGit.dirty.some((item) => item.path.replace(/\\/g, '/') === step.target)) throw new Error(`Git checkout left a tracked restore target dirty before artifact replay: ${step.target}`);
      step.applyPre = actual;
    } else {
      if (!sameObservedFileState(step.pre, actual)) throw new Error(`Git checkout changed a target outside its selected tree: ${step.target}`);
      step.applyPre = step.pre;
    }
  }
}

async function writeFileSafely(root, target, bytes, operationId, onPrepared, expectedPre = null) {
  const absolute = await Store.validateRestoreTarget(root, target);
  const parent = path.dirname(absolute);
  await Store.assertNoLinks(parent, { allowMissing: false });
  const state = path.join(root, '.project-state');
  const stagingRoot = path.join(state, 'staging', operationId, 'private');
  await Store.ensureRealDirectory(root, stagingRoot);
  await Store.assertNoLinks(stagingRoot, { allowMissing: false });
  const parentStat = await fsp.stat(parent, { bigint: true });
  const stageStat = await fsp.stat(stagingRoot, { bigint: true });
  if (parentStat.dev !== stageStat.dev) throw Store.coded('EUNSAFE_PATH', 'private restore staging and target must be on the same filesystem');
  const tempName = `restore-${Store.randomId()}.tmp`;
  const temp = path.join(stagingRoot, tempName);
  const tempRelative = path.posix.join('staging', operationId, 'private', tempName);
  await fsp.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
  await Store.assertNoLinks(temp, { allowMissing: false, hardlinks: true });
  const handle = await fsp.open(temp, 'r');
  let staged;
  try {
    staged = await handle.stat({ bigint: true });
    const stagedBytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!staged.isFile() || staged.nlink > 1n || staged.dev !== after.dev || staged.ino !== after.ino || staged.size !== after.size || after.size !== BigInt(bytes.length) || hash(stagedBytes) !== hash(bytes)) {
      throw Store.coded('EARTIFACT_INTEGRITY', 'private restore staging file failed identity or digest verification');
    }
  } finally { await handle.close(); }
  const expected = expectedPre || await fileState(absolute);
  const beforePublish = await fileState(absolute);
  if (!sameObservedFileState(expected, beforePublish)) {
    const error = Store.coded('ESOURCE_CHANGED', `restore target changed after preflight; external state was preserved: ${target}`);
    error.preserveExternalState = true;
    throw error;
  }
  const stagedId = { dev: staged.dev.toString(), ino: staged.ino.toString() };
  const displacedPath = `${temp}.previous`;
  const displacedRelative = `${tempRelative}.previous`;
  const stagedRecord = {
    path: tempRelative, target, dev: stagedId.dev, ino: stagedId.ino,
    size: bytes.length, sha256: hash(bytes), phase: 'prepared',
    ...(expected.exists ? { previous: { path: displacedRelative, dev: expected.dev, ino: expected.ino, size: expected.size, sha256: expected.sha256 } } : {}),
  };
  const restoreDisplaced = async () => {
    if (!expected.exists) return true;
    try {
      await fsp.link(displacedPath, absolute);
      await fsp.unlink(displacedPath);
      const restored = await fileState(absolute);
      return restored.exists && restored.dev === expected.dev && restored.ino === expected.ino && restored.sha256 === expected.sha256 && restored.size === expected.size;
    } catch (error) { return error.code === 'EEXIST' ? false : false; }
  };
  try {
    if (onPrepared) await onPrepared({ ...stagedId, pendingTemp: stagedRecord, preFileId: expected.exists ? { dev: expected.dev, ino: expected.ino } : null });
    await Store.assertNoLinks(temp, { allowMissing: false, hardlinks: true });
    const latest = await fileState(absolute);
    if (!sameObservedFileState(expected, latest)) {
      const error = Store.coded('ESOURCE_CHANGED', `restore target changed after preflight; external state was preserved: ${target}`);
      error.preserveExternalState = true;
      throw error;
    }
    if (expected.exists) {
      await fsp.rename(absolute, displacedPath);
      const displaced = await fileState(displacedPath);
      if (!displaced.exists || displaced.dev !== expected.dev || displaced.ino !== expected.ino || displaced.sha256 !== expected.sha256 || displaced.size !== expected.size) {
        const restored = await restoreDisplaced();
        const error = Store.coded('ESOURCE_CHANGED', `restore target changed at the publication boundary; displaced bytes were ${restored ? 'returned to the target' : `retained at ${displacedRelative}`}`);
        error.preserveExternalState = true;
        throw error;
      }
    }
    try { await fsp.link(temp, absolute); }
    catch (error) {
      if (expected.exists && !(await restoreDisplaced())) {
        error.preserveExternalState = true;
        error.message += `; original target is retained at ${displacedRelative}`;
      }
      throw error;
    }
    await fsp.unlink(temp);
    const installed = await fileState(absolute);
    if (!installed.exists || installed.dev !== stagedId.dev || installed.ino !== stagedId.ino || installed.size !== bytes.length || installed.sha256 !== hash(bytes)) {
      const error = Store.coded('ESOURCE_CHANGED', `published target identity changed during restore: ${target}`);
      error.preserveExternalState = true;
      throw error;
    }
    const publishProof = { dev: installed.dev, ino: installed.ino, size: installed.size, sha256: installed.sha256 };
    if (expected.exists) {
      const displaced = await fileState(displacedPath);
      if (!displaced.exists || displaced.dev !== expected.dev || displaced.ino !== expected.ino || displaced.sha256 !== expected.sha256 || displaced.size !== expected.size) {
        const error = Store.coded('ESOURCE_CHANGED', `previous target changed while displaced; preserve ${displacedRelative}`);
        error.preserveExternalState = true;
        error.publishProof = publishProof;
        throw error;
      }
      await fsp.unlink(displacedPath);
    }
    if (onPrepared) {
      try { await onPrepared({ ...publishProof, pendingTemp: { ...stagedRecord, phase: 'published' } }); }
      catch (error) { error.publishProof = publishProof; throw error; }
    }
  } catch (error) {
    // Remove only the exact file created here. A replacement or ambiguous file
    // is retained for explicit recovery and diagnosis.
    try {
      await Store.assertNoLinks(temp, { allowMissing: false, hardlinks: true });
      const current = await fsp.lstat(temp, { bigint: true });
      if (current.dev === staged.dev && current.ino === staged.ino && current.size === staged.size) await fsp.unlink(temp);
    } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') error.message += `; private staging retained at ${tempRelative}`; }
    if (error.preserveExternalState && onPrepared) {
      if (!fs.existsSync(displacedPath) && !fs.existsSync(temp)) {
        await onPrepared({ pendingTarget: null, pendingTemp: null }).catch(() => {});
      }
    }
    throw error;
  }
  const checked = await fileState(absolute);
  if (!checked.exists || checked.dev !== stagedId.dev || checked.ino !== stagedId.ino || !Buffer.from(bytes).equals(checked.bytes)) {
    const error = new Error(`restored file verification failed: ${target}`);
    error.publishProof = { dev: stagedId.dev, ino: stagedId.ino, size: bytes.length, sha256: hash(bytes) };
    throw error;
  }
  return { dev: checked.dev, ino: checked.ino, size: checked.size, sha256: checked.sha256 };
}
async function applyFiles(root, steps, operationId, journalApplied, onProgress) {
  for (const step of steps) {
    const expectedPre = step.applyPre || step.pre;
    if (step.artifact.kind === 'absent') {
      const current = await fileState(step.absolute);
      if (current.exists) {
        if (!sameObservedFileState(expectedPre, current)) {
          const error = Store.coded('ESOURCE_CHANGED', `restore target changed after preflight; external state was preserved: ${step.target}`);
          error.incompleteCompensation = true;
          throw error;
        }
        const stateRoot = path.join(root, '.project-state');
        const stagingRoot = path.join(stateRoot, 'staging', operationId, 'private');
        await Store.ensureRealDirectory(root, stagingRoot);
        await Store.assertNoLinks(stagingRoot, { allowMissing: false });
        const parentStat = await fsp.stat(path.dirname(step.absolute), { bigint: true });
        const stagingStat = await fsp.stat(stagingRoot, { bigint: true });
        if (parentStat.dev !== stagingStat.dev) throw Store.coded('EUNSAFE_PATH', 'private restore staging and target must be on the same filesystem');
        const tempName = `retire-${Store.randomId()}.tmp`;
        const temp = path.join(stagingRoot, tempName);
        const tempRelative = path.posix.join('staging', operationId, 'private', tempName);
        const intent = {
          action: 'retire-target', path: tempRelative, target: step.target,
          dev: current.dev, ino: current.ino, size: current.size, sha256: current.sha256, phase: 'prepared',
        };
        if (onProgress) await onProgress({
          pendingTarget: { target: step.target, preExists: true, preSha256: current.sha256, preSize: current.size, preFileId: { dev: current.dev, ino: current.ino }, postExists: false, postSha256: null, postSize: 0 },
          pendingTemp: intent,
        });
        try {
          await Store.assertNoLinks(step.absolute, { allowMissing: false, hardlinks: true });
          const latest = await fileState(step.absolute);
          if (!sameObservedFileState(current, latest)) {
            const error = Store.coded('ESOURCE_CHANGED', `restore target changed at the retirement boundary; external state was preserved: ${step.target}`);
            error.incompleteCompensation = true;
            throw error;
          }
          await fsp.rename(step.absolute, temp);
          const moved = await fileState(temp);
          if (!sameObservedFileState(current, moved)) {
            let returned = false;
            try { await fsp.link(temp, step.absolute); await fsp.unlink(temp); returned = true; } catch { /* preserve displaced bytes at temp */ }
            const error = Store.coded('ESOURCE_CHANGED', `file identity changed at the retirement boundary; displaced data ${returned ? 'was returned' : `remains at ${tempRelative}`}`);
            error.incompleteCompensation = true;
            throw error;
          }
          // Only unlink the inode moved from the exact preflight target. If an
          // external writer creates the target now, it remains untouched.
          await fsp.unlink(temp);
          if ((await fileState(step.absolute)).exists) {
            const error = Store.coded('ESOURCE_CHANGED', `an external file appeared while retiring the target; it was preserved: ${step.target}`);
            error.incompleteCompensation = true;
            throw error;
          }
        } catch (error) {
          if (!fs.existsSync(temp)) await onProgress?.({ pendingTarget: null, pendingTemp: null }).catch(() => {});
          throw error;
        }
      }
      journalApplied.push({ target: step.target, postExists: false, postSha256: null, postSize: 0, postFileId: null, preExists: current.exists, preSha256: current.sha256, preSize: current.size, preFileId: current.exists ? { dev: current.dev, ino: current.ino } : null });
      if (onProgress) await onProgress({ appliedTargets: journalApplied, pendingTarget: null, pendingTemp: null });
      continue;
    }
    const bytes = await fsp.readFile(step.artifact.absolutePath);
    if (bytes.length !== step.artifact.size || hash(bytes) !== step.artifact.sha256) throw Store.coded('EARTIFACT_INTEGRITY', `artifact changed before apply: ${step.artifact.id}`);
    try { await writeFileSafely(root, step.target, bytes, operationId, async (postFileId) => {
      if (onProgress) await onProgress({ pendingTarget: postFileId.pendingTemp ? { target: step.target, preExists: expectedPre.exists, preSha256: expectedPre.sha256, preSize: expectedPre.size, preFileId: postFileId.preFileId || (expectedPre.exists ? { dev: expectedPre.dev, ino: expectedPre.ino } : null), postExists: true, postSha256: hash(bytes), postSize: bytes.length, postFileId: { dev: postFileId.dev, ino: postFileId.ino } } : null, pendingTemp: postFileId.pendingTemp || null });
    }, expectedPre); }
    catch (error) {
      if (error.publishProof) {
        journalApplied.push({ target: step.target, postExists: true, postSha256: error.publishProof.sha256, postSize: error.publishProof.size, postFileId: { dev: error.publishProof.dev, ino: error.publishProof.ino }, preExists: expectedPre.exists, preSha256: expectedPre.sha256, preSize: expectedPre.size, preFileId: expectedPre.exists ? { dev: expectedPre.dev, ino: expectedPre.ino } : null });
        if (onProgress) await onProgress({ appliedTargets: journalApplied, pendingTarget: null, pendingTemp: null }).catch(() => {});
      } else if (error.preserveExternalState) {
        // Do not infer ownership from matching bytes. The target remains outside
        // the compensation set unless the publisher proved this staged inode.
        error.incompleteCompensation = true;
      }
      throw error;
    }
    const installed = await fsp.stat(step.absolute, { bigint: true });
    journalApplied.push({ target: step.target, postExists: true, postSha256: hash(bytes), postSize: bytes.length, postFileId: { dev: installed.dev.toString(), ino: installed.ino.toString() }, preExists: expectedPre.exists, preSha256: expectedPre.sha256, preSize: expectedPre.size, preFileId: expectedPre.exists ? { dev: expectedPre.dev, ino: expectedPre.ino } : null });
    if (onProgress) await onProgress({ appliedTargets: journalApplied, pendingTarget: null, pendingTemp: null });
  }
}
async function removeExactRestoreTarget(root, target, expected, operationId) {
  const absolute = path.join(root, target);
  const current = await fileState(absolute);
  if (!sameObservedFileState(expected, current)) throw new Error('target changed after restore; external bytes retained');
  const stagingRoot = path.join(root, '.project-state', 'staging', operationId, 'private');
  await Store.ensureRealDirectory(root, stagingRoot);
  await Store.assertNoLinks(stagingRoot, { allowMissing: false });
  const parent = await fsp.stat(path.dirname(absolute), { bigint: true });
  const stage = await fsp.stat(stagingRoot, { bigint: true });
  if (parent.dev !== stage.dev) throw Store.coded('EUNSAFE_PATH', 'private restore staging and target must be on the same filesystem');
  const temp = path.join(stagingRoot, `retire-${Store.randomId()}.tmp`);
  await Store.assertNoLinks(absolute, { allowMissing: false, hardlinks: true });
  await fsp.rename(absolute, temp);
  const displaced = await fileState(temp);
  if (!sameObservedFileState(expected, displaced)) {
    try { await fsp.link(temp, absolute); await fsp.unlink(temp); }
    catch { /* the displaced object remains in private staging for diagnosis */ }
    throw new Error('target identity changed at compensation boundary; external file was preserved or retained in private staging');
  }
  // This removes only the exact inode previously published by this operation.
  await fsp.unlink(temp);
  if ((await fileState(absolute)).exists) throw new Error('an external target appeared during compensation and was preserved');
}
async function compensateFiles(root, journalApplied, preStates, operationId, deferGitManaged = false) {
  const outcomes = [];
  const deferred = [];
  for (const applied of [...journalApplied].reverse()) {
    const before = preStates.get(applied.target);
    try {
      const current = await fileState(path.join(root, applied.target));
      if (current.exists !== applied.postExists || (current.exists && (current.sha256 !== applied.postSha256 || (applied.postFileId && (current.dev !== applied.postFileId.dev || current.ino !== applied.postFileId.ino))))) {
        if (deferGitManaged) { deferred.push(applied.target); continue; }
        throw new Error('target changed after restore; external bytes retained');
      }
      if (before.exists) await writeFileSafely(root, applied.target, before.bytes, operationId);
      else await removeExactRestoreTarget(root, applied.target, current, operationId);
      const after = await fileState(path.join(root, applied.target));
      if (after.exists !== before.exists || (before.exists && after.sha256 !== before.sha256)) throw new Error('restored original file state did not verify');
      outcomes.push({ target: applied.target, verified: true });
    } catch (error) { outcomes.push({ target: applied.target, verified: false, reason: error.message }); }
  }
  return { ok: outcomes.every((item) => item.verified), steps: outcomes, deferred };
}
async function uniqueAutoName(root) {
  const now = new Date().toISOString();
  const base = `auto-${now.slice(0, 10).replace(/-/g, '')}-${now.slice(11, 19).replace(/:/g, '')}`;
  for (let suffix = 0; suffix < 10000; suffix += 1) {
    const name = suffix ? `${base}-${suffix}` : base;
    const exists = await fsp.lstat(path.join(root, '.project-state', 'snapshots', name)).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error));
    if (!exists) return name;
  }
  throw Store.coded('EEXISTS', 'could not allocate a unique automatic safety snapshot name');
}
async function validateRollbackProof(root, journal, operationId) {
  const completed = journal?.status === 'completed' && journal?.terminalOutcome === 'verified-complete';
  const interrupted = journal?.status === 'in-progress' && ['applying', 'verifying'].includes(journal?.phase) && journal?.safety;
  if (!journal || journal.operationId !== operationId || journal.operation !== 'restore' || (!completed && !interrupted)) throw Store.coded('EROLLBACK_PROOF', 'matching verified or safely inspectable interrupted restore journal is required for --rollback-of');
  const current = await Git.inspectGit(root);
  const sameGitState = (expected) => current.isGit === !!expected?.head && (!current.isGit || (current.head.toLowerCase() === expected.head && current.branchRef === expected.branchRef && current.indexTree === expected.indexTree && JSON.stringify(current.refs) === JSON.stringify(expected.refs)));
  const matchesGitIntent = interrupted && journal.gitIntent && sameGitState(journal.gitIntent.expectedGit);
  if (!sameGitState(journal.postGit) && !(interrupted && sameGitState(journal.preGit)) && !matchesGitIntent) throw Store.coded('EROLLBACK_PROOF', 'Git HEAD, branch, index, or refs changed since the referenced restore; it matches neither durable pre-state, post-state, nor Git intent');
  const rollbackTargets = new Set();
  // A Git intent proves the metadata transition, not that every file in the
  // planned restore was changed by this operation. Only durable file-step or
  // pending-target evidence can authorize file compensation. Git checkout is
  // compensated separately through its verified pre-state.
  for (const applied of journal.appliedTargets || []) {
    const currentFile = await fileState(path.join(root, applied.target));
    const currentStat = currentFile.exists ? await fsp.stat(path.join(root, applied.target), { bigint: true }) : null;
    const postMatches = currentFile.exists === applied.postExists && (!currentFile.exists || (currentFile.sha256 === applied.postSha256 && currentFile.size === applied.postSize && currentStat.dev.toString() === applied.postFileId?.dev && currentStat.ino.toString() === applied.postFileId?.ino));
    const preMatches = currentFile.exists === applied.preExists && (!currentFile.exists || (currentFile.sha256 === applied.preSha256 && currentFile.size === applied.preSize && (!applied.preFileId || (currentFile.dev === applied.preFileId.dev && currentFile.ino === applied.preFileId.ino))));
    if (postMatches) rollbackTargets.add(applied.target);
    else if (!interrupted || !preMatches) throw Store.coded('EROLLBACK_PROOF', `restore-created target changed since operation: ${applied.target}`);
  }
  const pendingTarget = journal.pendingTarget;
  let pendingOriginalMatches = false;
  let pendingAppliedMatches = false;
  let linkedPublishState = null;
  if (pendingTarget && journal.pendingTemp && journal.pendingTemp.action !== 'retire-target') {
    const stagePath = path.resolve(root, '.project-state', ...journal.pendingTemp.path.split('/'));
    const targetPath = path.join(root, pendingTarget.target);
    const [stageStat, targetStat] = await Promise.all([
      fsp.lstat(stagePath, { bigint: true }).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)),
      fsp.lstat(targetPath, { bigint: true }).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)),
    ]);
    const item = journal.pendingTemp;
    if (stageStat?.isFile() && targetStat?.isFile() && stageStat.nlink === 2n && targetStat.nlink === 2n &&
        stageStat.dev === targetStat.dev && stageStat.ino === targetStat.ino && stageStat.dev.toString() === String(item.dev) &&
        stageStat.ino.toString() === String(item.ino) && pendingTarget.target === item.target && pendingTarget.postFileId?.dev === String(item.dev) &&
        pendingTarget.postFileId?.ino === String(item.ino)) {
      await Store.assertNoLinks(stagePath, { allowMissing: false });
      await Store.assertNoLinks(targetPath, { allowMissing: false });
      const handle = await fsp.open(targetPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const before = await handle.stat({ bigint: true });
        const bytes = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        if (before.dev !== stageStat.dev || before.ino !== stageStat.ino || before.nlink !== 2n || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 2n ||
            bytes.length !== item.size || hash(bytes) !== item.sha256 || item.sha256 !== pendingTarget.postSha256) throw Store.coded('EROLLBACK_PROOF', 'staged/published hardlink pair is not the exact interrupted publication');
        linkedPublishState = { exists: true, bytes, sha256: hash(bytes), size: bytes.length, dev: before.dev.toString(), ino: before.ino.toString() };
      } finally { await handle.close(); }
    }
  }
  if (pendingTarget) {
    const pending = pendingTarget;
    if (!interrupted) throw Store.coded('EROLLBACK_PROOF', 'terminal restore journal has an unresolved pending target');
    const observed = linkedPublishState && pending.target === journal.pendingTemp?.target
      ? linkedPublishState : await fileState(path.join(root, pending.target));
    pendingOriginalMatches = observed.exists === pending.preExists && (!observed.exists || (observed.sha256 === pending.preSha256 && observed.size === pending.preSize && (!pending.preFileId || (observed.dev === pending.preFileId.dev && observed.ino === pending.preFileId.ino))));
    if (pending.postExists) {
      if (!pending.postFileId) throw Store.coded('EROLLBACK_PROOF', 'interrupted target has no safe staged-file identity proof');
      pendingAppliedMatches = observed.exists && observed.sha256 === pending.postSha256 && observed.size === pending.postSize && observed.dev === pending.postFileId.dev && observed.ino === pending.postFileId.ino;
    } else {
      // An absent marker authorizes rollback only when the target is still
      // absent or still exactly its pre-state. A later external replacement is
      // ambiguous and must be preserved.
      if (observed.exists && !pendingOriginalMatches) throw Store.coded('EROLLBACK_PROOF', `target changed after interrupted retirement: ${pending.target}`);
      pendingAppliedMatches = !observed.exists;
    }
    if (pendingAppliedMatches) rollbackTargets.add(pending.target);
  }
  let stagedTemp = null;
  if (journal.pendingTemp) {
    const item = journal.pendingTemp;
    const stagedPath = path.resolve(root, '.project-state', ...item.path.split('/'));
    await Store.assertNoLinks(stagedPath, { allowMissing: true });
    const staged = await fsp.lstat(stagedPath, { bigint: true }).then(async (stat) => {
      if (!stat.isFile() || stat.dev.toString() !== String(item.dev) || stat.ino.toString() !== String(item.ino) || stat.size !== BigInt(item.size) ||
          (stat.nlink > 1n && !(linkedPublishState && stat.nlink === 2n && stat.dev.toString() === linkedPublishState.dev && stat.ino.toString() === linkedPublishState.ino))) throw Store.coded('EROLLBACK_PROOF', 'private staged restore file identity changed');
      if (linkedPublishState) return { exists: true, dev: stat.dev.toString(), ino: stat.ino.toString(), linkedPublished: true };
      const bytes = await fsp.readFile(stagedPath);
      if (hash(bytes) !== item.sha256) throw Store.coded('EROLLBACK_PROOF', 'private staged restore file digest changed');
      return { exists: true, dev: stat.dev.toString(), ino: stat.ino.toString(), linkedPublished: false };
    }, (error) => error.code === 'ENOENT' ? { exists: false } : Promise.reject(error));
    const target = linkedPublishState && item.target === pendingTarget?.target ? linkedPublishState : await fileState(path.join(root, item.target));
    if (item.action === 'retire-target') {
      if (!pendingTarget || pendingTarget.target !== item.target || !pendingTarget.preExists ||
          pendingTarget.preFileId?.dev !== String(item.dev) || pendingTarget.preFileId?.ino !== String(item.ino) ||
          pendingTarget.preSha256 !== item.sha256 || pendingTarget.preSize !== item.size) {
        throw Store.coded('EROLLBACK_PROOF', 'retirement staging is not bound to the durable original target identity');
      }
      if (staged.exists && (String(item.dev) !== String(staged.dev) || String(item.ino) !== String(staged.ino))) throw Store.coded('EROLLBACK_PROOF', 'retired target staging identity changed');
      if (target.exists && !pendingOriginalMatches) throw Store.coded('EROLLBACK_PROOF', 'an external target appeared during interrupted retirement; preserve both states');
      if (staged.exists || pendingAppliedMatches) rollbackTargets.add(item.target);
      stagedTemp = staged.exists ? { ...item, path: stagedPath } : null;
    } else {
    let previous = { exists: false };
    if (item.previous) {
      const previousPath = path.resolve(root, '.project-state', ...item.previous.path.split('/'));
      await Store.assertNoLinks(previousPath, { allowMissing: true, hardlinks: true });
      previous = await fsp.lstat(previousPath, { bigint: true }).then(async (stat) => {
        if (!stat.isFile() || stat.nlink > 1n || stat.dev.toString() !== String(item.previous.dev) || stat.ino.toString() !== String(item.previous.ino) || stat.size !== BigInt(item.previous.size)) throw Store.coded('EROLLBACK_PROOF', 'displaced target identity changed');
        const bytes = await fsp.readFile(previousPath);
        if (hash(bytes) !== item.previous.sha256) throw Store.coded('EROLLBACK_PROOF', 'displaced target digest changed');
        if (!pendingTarget?.preExists || pendingTarget.target !== item.target || pendingTarget.preFileId?.dev !== String(item.previous.dev) || pendingTarget.preFileId?.ino !== String(item.previous.ino) || pendingTarget.preSha256 !== item.previous.sha256 || pendingTarget.preSize !== item.previous.size) throw Store.coded('EROLLBACK_PROOF', 'displaced target does not match the durable original-state intent');
        return { exists: true, path: previousPath, ...item.previous };
      }, (error) => error.code === 'ENOENT' ? { exists: false } : Promise.reject(error));
    }
    if (!pendingTarget || pendingTarget.target !== item.target) throw Store.coded('EROLLBACK_PROOF', 'staging record is not bound to the pending target');
    const postMatches = target.exists && target.sha256 === item.sha256 && target.size === item.size && target.dev === String(item.dev) && target.ino === String(item.ino);
    const originalTargetMatches = target.exists === pendingTarget.preExists && (!target.exists || (target.sha256 === pendingTarget.preSha256 && target.size === pendingTarget.preSize && (!pendingTarget.preFileId || (target.dev === pendingTarget.preFileId.dev && target.ino === pendingTarget.preFileId.ino))));
    const displacedOriginalMatches = previous.exists && !target.exists;
    const originalStatePresent = originalTargetMatches || displacedOriginalMatches || pendingOriginalMatches;
    const appliedMatches = pendingAppliedMatches || postMatches;
    if (!appliedMatches && !originalStatePresent) throw Store.coded('EROLLBACK_PROOF', `interrupted target is neither its recorded original nor staged output: ${item.target}`);
    if (item.phase === 'published' && (!postMatches || staged.exists || previous.exists)) throw Store.coded('EROLLBACK_PROOF', 'published private staging record does not match the target');
    if (staged.exists && postMatches && !staged.linkedPublished) throw Store.coded('EROLLBACK_PROOF', 'both staged and published restore files exist; preserve both for manual resolution');
    if (!staged.exists && !postMatches && !originalStatePresent) throw Store.coded('EROLLBACK_PROOF', 'staged restore file and target state cannot be reconciled');
    if (postMatches || previous.exists) rollbackTargets.add(item.target);
    stagedTemp = staged.exists || previous.exists ? { ...item, path: stagedPath, previous: previous.exists ? previous : null, linkedPublished: !!staged.linkedPublished, ...(staged.linkedPublished ? { publishedState: linkedPublishState } : {}) } : null;
    }
  }
  if (current.isGit && !current.clean) {
    const allowed = new Set([...rollbackTargets].map((target) => target.toLowerCase()));
    const unexpected = current.dirty.filter((item) => !allowed.has(item.path.replace(/\\/g, '/').toLowerCase()));
    if (unexpected.length) throw Store.coded('EROLLBACK_PROOF', 'unrelated Git changes prevent exact rollback');
  }
  return { git: current, targets: rollbackTargets, stagedTemp };
}

async function restoreInternal(root, name, opts = {}) {
  const rootAbs = path.resolve(root);
  const selectedLayers = normalizeLayerSelection(opts.onlyLayers);
  if (selectedLayers && opts.rollbackOf) throw Store.coded('ERESTORE_SELECTION', 'selective restore cannot be combined with --rollback-of; use the exact rollback command as printed');
  const lock = opts.lock || await Store.acquireOperationLock(rootAbs, { operation: 'restore', operationId: opts.operationId });
  let pin; let safety; let dbPlan; let dbToken; let dbApplied = false; let dbApplyAttempted = false;
  let dbRollbackPlan; let dbRollbackToken; let dbRollbackApplied = false; let dbRollbackAttempted = false;
  const preStates = new Map();
  const untouchedPreStates = new Map();
  let preGit; let gitStep; let gitAttempted = false; let gitApplied = false; let expectedGitState = null; let journalStarted = false;
  let validated; let previousJournal; let rollbackTargetProof = null;
  let businessCommitted = false;
  let committedCleanupPending = null;
  const appliedTargetsJournal = [];
  const result = { status: 'refused', operationId: lock.operationId, snapshot: { name, generation: null }, applied: [], verified: [], safetyPins: [], healthStatus: 'not-tested' };
  try {
    await Store.recoverSnapshotTransactions(rootAbs, lock);
    validated = await Store.validateSnapshot(rootAbs, name, { mode: 'restore' });
    result.snapshot.generation = validated.generation;
    if (opts.rollbackOf) {
      const journalFile = Store.operationJournalPath(rootAbs, opts.rollbackOf);
      previousJournal = await Store.readJournal(rootAbs, journalFile);
      rollbackTargetProof = await validateRollbackProof(rootAbs, previousJournal, opts.rollbackOf);
    }
    preGit = await Git.inspectGit(rootAbs);
    if (!opts.rollbackOf) Git.requireClean(preGit);
    const gitArtifact = validated.artifacts.find((item) => item.id === 'layer:git' && item.kind === 'layer-json');
    gitStep = selectedLayers ? null : await Git.planGit(rootAbs, preGit, gitArtifact ? { status: 'collected', data: JSON.parse(await fsp.readFile(gitArtifact.absolutePath, 'utf8')) } : null);
    if (!opts.rollbackOf) Git.requireClean(preGit);
    const selectableFileSteps = opts.rollbackOf ? [] : selectedLayers
      ? await rootFileSteps(rootAbs, validated, SELECTABLE_LAYERS)
      : await rootFileSteps(rootAbs, validated);
    let steps = opts.rollbackOf ? [] : selectedLayers
      ? selectableFileSteps.filter((step) => selectedLayers.includes(step.artifact.layer))
      : selectableFileSteps;
    await validateSelectedLayerInputs(validated, selectableFileSteps, selectedLayers);
    result.selection = selectedLayers
      ? { mode: 'only', layers: [...selectedLayers], targets: steps.map((step) => step.target) }
      : { mode: 'all', layers: ['git', 'config', 'deps', 'runtime', 'docker', 'database'], targets: steps.map((step) => step.target) };
    const plannedCommit = selectedLayers ? preGit.head : gitStep?.commit || (gitArtifact && JSON.parse(await fsp.readFile(gitArtifact.absolutePath, 'utf8')).commit);
    if (plannedCommit) {
      for (const step of steps.filter((item) => item.artifact.layer === 'config')) {
        const tracked = await U.runTrusted('git', ['ls-tree', '-r', '--name-only', plannedCommit, '--', step.target], { cwd: rootAbs });
        if (!tracked.ok) throw new Error(`cannot determine whether Git target commit tracks private config destination ${step.target}`);
        if (tracked.stdout.split(/\r?\n/).includes(step.target)) throw Store.coded('EUNSAFE_PATH', `private configuration target ${step.target} is tracked by the target Git commit`);
      }
    }
    for (const step of steps) {
      step.pre = await fileState(step.absolute);
      preStates.set(step.target, step.pre);
    }
    if (selectedLayers) {
      const selectedTargets = new Set(steps.map((step) => step.target.toLowerCase()));
      for (const step of selectableFileSteps) if (!selectedTargets.has(step.target.toLowerCase())) untouchedPreStates.set(step.target, await fileState(step.absolute));
    } else {
      dbPlan = await DB.planDatabaseRestore(rootAbs, validated, { operationId: lock.operationId });
      dbToken = await DB.preflightDatabaseRestore(rootAbs, dbPlan);
    }
    if (opts.rollbackOf) {
      if (!previousJournal.safety) throw Store.coded('EROLLBACK_PROOF', 'referenced operation has no verified safety point');
      const safetyPair = await Store.validateGenerationById(rootAbs, previousJournal.safety.name, previousJournal.safety.generation);
      const safetyValidated = { manifest: safetyPair.publicManifest, layers: safetyPair.layers, artifacts: safetyPair.artifacts, paths: safetyPair.paths, generation: safetyPair.generation };
      steps = [];
      const source = safetyValidated.artifacts.filter((item) => item.layer === 'rollback');
      const isDatabaseTarget = (target) => typeof target === 'string' && Database.DB_FILE_RE.test(target);
      const provenTargets = rollbackTargetProof?.targets || new Set();
      const wanted = new Map(source.filter((item) => item.kind === 'file' && !isDatabaseTarget(item.target) && provenTargets.has(item.target)).map((item) => [item.target, item]));
      for (const marker of source.filter((item) => item.kind === 'absent' && !isDatabaseTarget(item.target) && provenTargets.has(item.target))) {
        const linked = rollbackTargetProof?.stagedTemp?.linkedPublished && rollbackTargetProof.stagedTemp.target === marker.target;
        const pre = linked ? rollbackTargetProof.stagedTemp.publishedState : await fileState(path.join(rootAbs, marker.target));
        steps.push({ artifact: marker, target: marker.target, absolute: path.join(rootAbs, marker.target), pre });
        preStates.set(marker.target, pre);
      }
      for (const [target, artifact] of wanted) {
        const linked = rollbackTargetProof?.stagedTemp?.linkedPublished && rollbackTargetProof.stagedTemp.target === target;
        const pre = linked ? rollbackTargetProof.stagedTemp.publishedState : await fileState(path.join(rootAbs, target));
        steps.push({ artifact, target, absolute: path.join(rootAbs, target), pre });
        preStates.set(target, pre);
      }
      // Rollback is limited to exact file states captured by the safety generation.
      for (const step of steps) if (step.artifact.kind === 'file') {
        if (!step.artifact.absolutePath || hash(await fsp.readFile(step.artifact.absolutePath)) !== step.artifact.sha256) throw Store.coded('EARTIFACT_INTEGRITY', `rollback safety artifact changed: ${step.target}`);
      }
      dbRollbackPlan = await DB.planDatabaseRollback(rootAbs, safetyValidated, { operationId: opts.rollbackOf, previousJournal });
      dbRollbackToken = await DB.preflightDatabaseRollback(rootAbs, dbRollbackPlan);
      gitStep = previousJournal.preGit?.head ? { kind: 'git', commit: previousJournal.preGit.head, branchRef: previousJournal.preGit.branchRef, force: true, detail: 'verified rollback to pre-restore Git state' } : null;
      dbPlan = null;
    }

    // Pin the requested immutable generation before any user confirmation or mutation.
    pin = await Store.pinSnapshot(rootAbs, { name, generation: validated.generation, operationId: lock.operationId, reason: 'restore-target' });
    result.safetyPins.push({ name, generation: validated.generation, pinId: pin.pinId });
    if (opts.dryRun) {
      result.status = 'refused';
      result.plan = {
        selection: result.selection,
        git: selectedLayers ? 'unchanged (selective restore)' : gitStep?.detail || 'unchanged',
        files: steps.map((item) => ({ target: item.target, preExists: item.pre.exists })),
        database: dbPlan?.steps.map((item) => ({ target: item.target, mode: item.mode })) || [],
        ...(selectedLayers ? { untouchedLayers: ['git', 'database', 'docker', ...SELECTABLE_LAYERS.filter((layer) => !selectedLayers.includes(layer))] } : {}),
      };
      await Store.unpinSnapshot(rootAbs, { name, generation: validated.generation, pinId: pin.pinId, lock, terminalOutcome: 'explicit-resolution' });
      pin = null;
      return result;
    }
    if (!opts.yes) throw Store.coded('EUSER_CONFIRMATION', 'restore requires --yes to explicitly authorize writes; no interactive confirmation is available');

    if (rollbackTargetProof?.stagedTemp?.linkedPublished) {
      // A process may have stopped after link(2) published the target but
      // before unlinking the private staging name. Remove only that exact
      // second link so subsequent file reads and compensation see a single
      // target inode. The durable target identity remains in the original
      // journal, so a retry can verify this idempotently if interrupted here.
      const staged = rollbackTargetProof.stagedTemp;
      const stagePath = staged.path;
      const targetPath = path.join(rootAbs, staged.target);
      await Store.assertNoLinks(stagePath, { allowMissing: false });
      await Store.assertNoLinks(targetPath, { allowMissing: false });
      const [stageStat, targetStat] = await Promise.all([fsp.lstat(stagePath, { bigint: true }), fsp.lstat(targetPath, { bigint: true })]);
      if (!stageStat.isFile() || !targetStat.isFile() || stageStat.nlink !== 2n || targetStat.nlink !== 2n || stageStat.dev !== targetStat.dev || stageStat.ino !== targetStat.ino ||
          stageStat.dev.toString() !== String(staged.dev) || stageStat.ino.toString() !== String(staged.ino)) throw Store.coded('EROLLBACK_PROOF', 'staged/published link identity changed before rollback');
      await fsp.unlink(stagePath);
      const after = await fileState(targetPath);
      if (!after.exists || after.dev !== String(staged.dev) || after.ino !== String(staged.ino) || after.sha256 !== staged.sha256) throw Store.coded('EROLLBACK_PROOF', 'published target changed while removing its private staging link');
      rollbackTargetProof.stagedTemp = null;
    }

    // Build the safety point from exact bytes/absence of every file and DB target
    // that this operation may create or overwrite. Git checkout is permitted only
    // from a clean state, so the source commit and index can be reconstructed.
    const extras = [];
    for (const step of steps) {
      if (step.pre.exists) extras.push({ layer: 'rollback', kind: 'file', target: step.target, content: step.pre.bytes });
      else extras.push({ layer: 'rollback', kind: 'absent', target: step.target });
    }
    for (const step of dbPlan?.steps || []) extras.push({ layer: 'rollback', kind: 'absent', target: step.target });
    for (const step of dbRollbackPlan?.steps || []) {
      const bytes = await fsp.readFile(path.join(rootAbs, step.target));
      extras.push({ layer: 'rollback', kind: 'file', target: step.target, content: bytes });
    }
    const safetyName = await uniqueAutoName(rootAbs);
    safety = await snapshotInternal(rootAbs, safetyName, { kind: 'auto', lock, extraArtifacts: extras });
    const safetyPin = await Store.pinSnapshot(rootAbs, { name: safetyName, generation: safety.generation, operationId: lock.operationId, reason: 'rollback-needed' });
    result.safetyPins.push({ name: safetyName, generation: safety.generation, pinId: safetyPin.pinId });
    await Store.writeOperationJournal(rootAbs, lock, {
      operationId: lock.operationId, operation: 'restore', phase: 'safety-point',
      snapshot: { name, generation: validated.generation }, safety: { name: safetyName, generation: safety.generation, pinId: safetyPin.pinId },
      safetyPins: result.safetyPins, appliedTargets: [], preGit: gitJournalState(preGit), postGit: gitJournalState(preGit), status: 'in-progress',
    });
    journalStarted = true;
    await Store.writeOperationJournal(rootAbs, lock, { operationId: lock.operationId, operation: 'restore', phase: 'applying' });
    if (gitStep) {
      const targetTree = (await Git.required(rootAbs, ['rev-parse', '--verify', `${gitStep.commit}^{tree}`], 'planned Git target tree')).trim().toLowerCase();
      expectedGitState = gitJournalState({
        isGit: true, head: gitStep.commit.toLowerCase(), branchRef: gitStep.branchRef || null,
        indexTree: targetTree, refs: preGit.refs, clean: true,
      });
      await Store.writeOperationJournal(rootAbs, lock, {
        operationId: lock.operationId, operation: 'restore', phase: 'applying', status: 'in-progress',
        gitIntent: { preGit: gitJournalState(preGit), expectedGit: expectedGitState, targets: steps.map((step) => step.target) },
      });
      gitAttempted = true;
      await Git.applyGit(rootAbs, gitStep); gitApplied = true;
      const observedGit = await Git.verifyGit(rootAbs, gitStep, preGit.refsText, steps.map((step) => step.target));
      await bindPostCheckoutFileStates(rootAbs, steps, gitStep.commit, observedGit);
      await Store.writeOperationJournal(rootAbs, lock, { operationId: lock.operationId, operation: 'restore', phase: 'applying', status: 'in-progress', postGit: gitJournalState(observedGit) });
    }
    await applyFiles(rootAbs, steps, lock.operationId, appliedTargetsJournal, (progress) => Store.writeOperationJournal(rootAbs, lock, { operationId: lock.operationId, operation: 'restore', phase: 'applying', status: 'in-progress', ...progress }));
    if (dbPlan?.steps.length) {
      dbApplyAttempted = true;
      await DB.applyDatabaseRestore(rootAbs, dbPlan, dbToken);
      dbApplied = true;
      for (const step of dbPlan.steps) {
        const stat = await fsp.stat(path.join(rootAbs, step.target), { bigint: true });
        appliedTargetsJournal.push({ target: step.target, postExists: true, postSha256: step.sourceSha256, postSize: step.sourceSize, postFileId: { dev: stat.dev.toString(), ino: stat.ino.toString() }, preExists: false, preSha256: null, preSize: 0 });
      }
    }
    if (dbRollbackPlan?.steps.length) {
      dbRollbackAttempted = true;
      const rolled = await DB.applyDatabaseRollback(rootAbs, dbRollbackPlan, dbRollbackToken);
      if (!rolled.ok) throw new Error(rolled.message || 'SQLite rollback failed');
      dbRollbackApplied = true;
      for (const step of dbRollbackPlan.steps) appliedTargetsJournal.push({ target: step.target, postExists: false, postSha256: null, postSize: 0, preExists: true, preSha256: step.postSha256, preSize: step.postSize });
    }
    await Store.writeOperationJournal(rootAbs, lock, { operationId: lock.operationId, operation: 'restore', phase: 'verifying', appliedTargets: appliedTargetsJournal });
    for (const step of steps) {
      if (step.artifact.kind === 'absent') {
        if (await fileState(step.absolute).then((state) => state.exists)) throw new Error(`rollback target should be absent: ${step.target}`);
        result.verified.push({ target: step.target, existenceMatches: true, bytesMatch: null, scope: selectedLayers ? 'selected' : 'full-supported-restore' });
      } else {
        const bytes = await fsp.readFile(step.artifact.absolutePath);
        const final = await fileState(step.absolute);
        if (!final.exists || final.size !== step.artifact.size || final.sha256 !== step.artifact.sha256 || !bytes.equals(final.bytes)) throw new Error(`final file bytes differ from validated artifact: ${step.target}`);
        result.verified.push({ target: step.target, existenceMatches: true, bytesMatch: true, scope: selectedLayers ? 'selected' : 'full-supported-restore' });
      }
    }
    if (dbPlan?.steps.length) {
      const verifiedDb = await DB.verifyDatabaseRestore(rootAbs, dbPlan);
      if (!verifiedDb.ok) throw new Error(verifiedDb.message || 'SQLite final verification failed');
      result.verified.push(...verifiedDb.steps);
    }
    if (dbRollbackPlan?.steps.length) {
      const verifiedRollback = await DB.verifyDatabaseRollback(rootAbs, dbRollbackPlan);
      if (!verifiedRollback.ok) throw new Error(verifiedRollback.message || 'SQLite rollback absence verification failed');
      result.verified.push(...verifiedRollback.steps);
    }
    let finalGit = preGit;
    if (gitStep) finalGit = await Git.verifyGit(rootAbs, gitStep, preGit.refsText, steps.map((x) => x.target));
    if (selectedLayers) {
      finalGit = await Git.inspectGit(rootAbs);
      assertSelectiveGitUnchanged(preGit, finalGit, steps.map((step) => step.target));
      for (const [target, before] of untouchedPreStates) {
        const after = await fileState(path.join(rootAbs, target));
        if (!sameObservedFileState(before, after)) throw new Error(`unselected target changed during selective restore: ${target}`);
      }
    }
    const postGit = gitJournalState(finalGit);
    result.gitAttachment = finalGit.isGit ? (finalGit.branchRef ? { mode: 'attached', ref: finalGit.branchRef } : { mode: 'detached', ref: null }) : { mode: 'not-a-git-repository', ref: null };
    if (dbPlan) result.verified.push(...dbPlan.steps.map((step) => ({ target: step.target, bytesMatch: true, integrity: 'ok', schemaMatch: true, rowsMatch: true })));
    const cleanupPending = [{ kind: 'release-restore-target-pin', name, generation: validated.generation, pinId: pin.pinId, reason: 'pending' }];
    if (opts.rollbackOf && previousJournal.safety) cleanupPending.push({ kind: 'resolve-original-safety-pin', operationId: opts.rollbackOf, ...previousJournal.safety, reason: 'pending' });
    if (rollbackTargetProof?.stagedTemp) {
      const staged = rollbackTargetProof.stagedTemp;
      cleanupPending.push({
        kind: 'remove-private-restore-staging',
        path: path.relative(path.join(rootAbs, '.project-state'), staged.path).replace(/\\/g, '/'),
        target: staged.target, dev: String(staged.dev), ino: String(staged.ino), size: staged.size,
        sha256: staged.sha256, reason: 'pending',
        ...(staged.action ? { action: staged.action } : {}),
        ...(staged.previous ? { previous: { path: staged.previous.path, dev: String(staged.previous.dev), ino: String(staged.previous.ino), size: staged.previous.size, sha256: staged.previous.sha256 } } : {}),
      });
    }
    const finalJournal = { operationId: lock.operationId, operation: 'restore', phase: 'completed', appliedTargets: appliedTargetsJournal, pendingTarget: null, pendingTemp: null, preGit: gitJournalState(preGit), postGit, status: 'completed', terminalOutcome: 'verified-complete', compensationOutcome: 'not-needed', cleanupPending, ...(opts.rollbackOf ? { resolvesOperationId: opts.rollbackOf } : {}) };
    await Store.writeOperationJournal(rootAbs, lock, finalJournal);
    businessCommitted = true;
    result.status = 'restored-verified'; result.applied = appliedTargetsJournal; result.safety = { name: safetyName, generation: safety.generation, pinId: safetyPin.pinId };
    const remaining = [...cleanupPending];
    committedCleanupPending = remaining;
    for (const action of cleanupPending) {
      try {
        const completed = await Store.completeCleanupAction(rootAbs, { lock, operationId: lock.operationId, action });
        if (action.kind === 'resolve-original-safety-pin') {
          result.releasedOriginalSafetyPin = !!completed.released;
          result.rolledBackOperation = action.operationId;
        }
        const index = remaining.findIndex((item) => JSON.stringify(item) === JSON.stringify(action));
        if (index >= 0) remaining.splice(index, 1);
        await Store.writeOperationJournal(rootAbs, lock, { ...finalJournal, cleanupPending: remaining });
      } catch (cleanupError) {
        const index = remaining.findIndex((item) => JSON.stringify(item) === JSON.stringify(action));
        if (index >= 0) remaining[index] = { ...action, reason: /^[A-Za-z0-9_-]{1,64}$/.test(cleanupError.code || '') ? cleanupError.code : 'cleanup-failed' };
        else remaining.push({ ...action, reason: /^[A-Za-z0-9_-]{1,64}$/.test(cleanupError.code || '') ? cleanupError.code : 'cleanup-journal-failed' });
        try { await Store.writeOperationJournal(rootAbs, lock, { ...finalJournal, cleanupPending: remaining }); } catch { /* prior durable list still authorizes idempotent retry */ }
      }
    }
    result.selection.targets = [...new Set(steps.map((step) => step.target))];
    if (remaining.length) result.cleanupPending = remaining;
    return result;
  } catch (error) {
    result.error = error.message;
    if (businessCommitted) {
      // The terminal journal is the business commit point. Never compensate a
      // verified restore because later cleanup/reporting failed; retain the
      // durable cleanup list and let the operation-specific retry path handle it.
      result.status = 'restored-verified';
      result.postCommitWarning = 'restore was committed and verified; post-commit reporting needs attention';
      if (committedCleanupPending?.length) result.cleanupPending = committedCleanupPending;
      return result;
    }
    if (!journalStarted || opts.dryRun) {
      if (pin) await Store.unpinSnapshot(rootAbs, { name, generation: validated.generation, pinId: pin.pinId, lock, terminalOutcome: 'explicit-resolution' }).catch(() => {});
      result.status = 'refused';
      throw Object.assign(error, { restoreResult: result });
    }
    await Store.writeOperationJournal(rootAbs, lock, { operationId: lock.operationId, operation: 'restore', phase: 'compensating', status: 'in-progress', appliedTargets: appliedTargetsJournal }).catch(() => {});
    let dbComp = { ok: true, status: 'not-applied' };
    if ((dbApplyAttempted || dbApplied) && dbPlan) dbComp = await DB.compensateDatabaseRestore(rootAbs, dbPlan, dbToken).catch((cause) => ({ ok: false, status: 'rollback-incomplete', message: cause.message }));
    if ((dbRollbackAttempted || dbRollbackApplied) && dbRollbackPlan) dbComp = await DB.compensateDatabaseRollback(rootAbs, dbRollbackPlan, dbRollbackToken).catch((cause) => ({ ok: false, status: 'rollback-incomplete', message: cause.message }));
    const fileComp = await compensateFiles(rootAbs, appliedTargetsJournal.filter((item) => preStates.has(item.target)), preStates, lock.operationId, gitAttempted);
    let gitComp = { ok: true, status: 'unchanged' };
    if (gitAttempted && preGit?.head) {
      try {
        const observed = await Git.inspectGit(rootAbs);
        const stateOf = (state) => JSON.stringify(gitJournalState(state));
        if (stateOf(observed) === stateOf(preGit)) {
          gitComp = { ok: true, status: 'unchanged-verified' };
        } else if (expectedGitState && stateOf(observed) === JSON.stringify(expectedGitState)) {
          const ref = preGit.branchRef;
          await Git.applyGit(rootAbs, { commit: preGit.head, branchRef: ref });
          const checked = await Git.inspectGit(rootAbs);
          if (stateOf(checked) !== stateOf(preGit) || !checked.clean) throw new Error('Git state did not match the durable pre-restore HEAD, attachment, refs, index, and worktree state');
          gitComp = { ok: true, status: 'verified' };
        } else {
          throw new Error('Git state after the attempted checkout matches neither durable pre-state nor expected checkout state');
        }
      } catch (cause) { gitComp = { ok: false, status: 'rollback-incomplete', message: cause.message }; }
    }
    if (gitComp.ok) {
      for (const [target, before] of preStates) {
        const after = await fileState(path.join(rootAbs, target)).catch(() => ({ exists: false }));
        if (after.exists !== before.exists || (before.exists && after.sha256 !== before.sha256)) {
          fileComp.ok = false;
          fileComp.steps.push({ target, verified: false, reason: 'final pre-restore bytes or absence did not verify after Git compensation' });
        }
      }
    }
    const complete = dbComp.ok && fileComp.ok && gitComp.ok && error.incompleteCompensation !== true;
    result.status = complete ? 'failed-rolled-back' : 'failed-rollback-incomplete';
    result.compensation = { database: dbComp, files: fileComp, git: gitComp };
    await Store.writeOperationJournal(rootAbs, lock, { operationId: lock.operationId, operation: 'restore', phase: complete ? 'failed-rolled-back' : 'failed-rollback-incomplete', status: complete ? 'failed-rolled-back' : 'failed-rollback-incomplete', terminalOutcome: complete ? 'failed-rolled-back' : 'failed-rollback-incomplete', compensationOutcome: result.compensation, safetyPins: result.safetyPins, appliedTargets: appliedTargetsJournal }).catch(() => {});
    if (complete && pin) await Store.unpinSnapshot(rootAbs, { name, generation: validated.generation, pinId: pin.pinId, lock, terminalOutcome: 'verified-complete' }).catch(() => {});
    error.restoreResult = result;
    throw error;
  } finally { await lock.release().catch(() => {}); }
}

async function restoreCmd(root, name, opts = {}) {
  try {
    const result = await restoreInternal(root, name, opts);
    if (opts.dryRun) {
      console.log(`PREVIEW ONLY: restore plan for "${name}"; project state was not reserved or frozen.`);
      console.log(`Validated target generation now: ${result.snapshot.generation}; actual restore will validate again.`);
      console.log(`Layers: ${result.selection?.layers?.join(', ') || 'all supported layers'}; files: ${result.plan.files.length}; database targets: ${result.plan.database.length}.`);
      console.log(`Git behavior: ${result.plan.git}.`);
      if (result.plan.untouchedLayers?.length) console.log(`Not restored by this plan: ${result.plan.untouchedLayers.join(', ')}.`);
      console.log('This preview may create and release lock/pin metadata; no business targets were changed.');
      const applyArgs = restoreCommandArgs(name, opts);
      const commands = U.cliCommandLines(applyArgs);
      if (commands.length) {
        console.log('To apply later, rerun the exact command for your shell; the plan will be revalidated:');
        for (const command of commands) console.log(`  ${command}`);
      }
      console.log('Plan details:');
      console.log(JSON.stringify(result.plan, null, 2));
      return 0;
    }
    console.log(`Restore verified for "${name}" (${result.snapshot.generation}).`);
    if (result.selection?.mode === 'only') {
      console.log(`Selected layers: ${result.selection.layers.join(', ')}.`);
      console.log('Git HEAD, branch attachment, refs, and index were unchanged and verified; database and Docker state were not restored.');
      const untouched = ['config', 'deps', 'runtime'].filter((layer) => !result.selection.layers.includes(layer));
      if (untouched.length) console.log(`Unselected file layers were left unchanged: ${untouched.join(', ')}.`);
    } else {
      console.log('Verified final files, Git HEAD attachment, refs, and index.');
      if (result.gitAttachment?.mode === 'attached') console.log(`Git HEAD mode: attached to ${result.gitAttachment.ref}.`);
      else if (result.gitAttachment?.mode === 'detached') console.log('Git HEAD mode: detached; existing branch refs were preserved.');
    }
    const targets = [...new Set((result.applied || []).map((item) => item.target).filter((target) => typeof target === 'string'))].sort();
    console.log(`Verified artifact targets: ${targets.length ? targets.join(', ') : '(no file artifacts applied)'}.`);
    console.log(`Verified safety point: ${result.safety.name} generation ${result.safety.generation}.`);
    if (result.cleanupPending?.length) console.log(`Restore result is verified; ${result.cleanupPending.length} cleanup action(s) remain pending. The referenced safety pin and data are retained for manual resolution.`);
    if (result.postCommitWarning) console.log(`Restore result is verified; ${result.postCommitWarning}. Keep the operation journal and retry only its recorded cleanup.`);
    if (result.rolledBackOperation) console.log(`Verified rollback of operation ${result.rolledBackOperation}.`);
    else for (const command of rollbackCommands(result.safety.name, result.operationId)) console.log(command);
    console.log('Application health: not tested. Next: review the restored project, reconcile dependencies manually if needed, then run your normal validation.');
    return 0;
  } catch (error) {
    const result = error.restoreResult;
    let why = error.message;
    if (/^(?:EARTIFACT|EMANIFEST|EUNSAFE_PATH)/.test(error.code || '')) why = `refusing to restore snapshot: ${why}`;
    if (error.code === 'ESNAPSHOT_MISSING') {
      const available = await Store.listSnapshots(root, { includeLegacy: false }).catch(() => []);
      why += available.length ? `; available complete snapshots: ${available.join(', ')}` : '; no complete schemaVersion 2 snapshots are available';
    }
    const journal = result?.operationId
      ? await Store.readJournal(root, Store.operationJournalPath(root, result.operationId)).catch(() => null)
      : null;
    const hasDurableJournal = journal?.operationId === result?.operationId && journal?.operation === 'restore';
    const next = result?.status === 'failed-rollback-incomplete' && hasDurableJournal
      ? `A persistent safety point is retained. Inspect it before further changes: ${U.cliNext(['recover', result.operationId, '--inspect'], 'use the operation ID printed above with recover --inspect')}`
      : result?.status === 'failed-rolled-back'
        ? 'local compensation verified; the pre-restore Git and file state was restored.'
        : hasDurableJournal
          ? `No unverified success is reported. Inspect the operation before retrying: ${U.cliNext(['recover', result.operationId, '--inspect'], 'use the operation ID printed above with recover --inspect')}`
          : result?.status === 'failed-rollback-incomplete'
            ? 'The result is unresolved and no valid recovery journal could be confirmed. Preserve the lock, files, pins, and snapshot generations; do not retry or delete state. Arrange manual inspection.'
            : `No recovery operation was recorded. Check project state with: ${U.cliNext(['doctor'], 'run project-state doctor; then correct the reported precondition and preview the restore again')}`;
    U.printError('Restore did not complete.', why, next);
    return ['failed-rollback-incomplete', 'failed-rolled-back'].includes(result?.status) ? 2 : 1;
  }
}

module.exports = { restoreCmd, restoreInternal, validateRollbackProof, restoreCommandArgs };
