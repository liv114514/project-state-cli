'use strict';

const fs = require('fs').promises;
const U = require('./utils');
const Store = require('./storage');
const { COLLECTORS, parseEnv } = require('./collectors');

async function loadCurrent(root) {
  const ctx = { root, results: {}, files: [] };
  const layers = {};
  for (const c of COLLECTORS) {
    let res;
    try { res = await c.fn(ctx); }
    catch (e) { res = U.skip(`collector failed: ${e.message}`); }
    if (res?.status === 'collected') {
      layers[c.id] = res.data;
      ctx.results[c.id] = res.data;
      if (Array.isArray(res.files)) ctx.files.push(...res.files);
    } else layers[c.id] = { __skipped: res?.reason || 'collector returned no result' };
  }
  return {
    name: 'current (live)',
    manifest: { schemaVersion: 2, state: 'complete', createdAt: new Date().toISOString() },
    layers,
    artifacts: ctx.files.map((file) => {
      const artifact = { ...file, absolutePath: file.srcPath };
      // A live schema is an observation created in memory, so bind its digest
      // to these exact bytes. Snapshot artifacts still use the digest recorded
      // in their validated manifest and are never re-trusted by recomputing it.
      if (file.kind === 'sqlite-schema' && file.content !== undefined) {
        const bytes = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
        artifact.size = bytes.length;
        artifact.sha256 = U.sha256(bytes);
      }
      return artifact;
    }),
  };
}

async function loadSnapshot(root, name) {
  const checked = await Store.validateSnapshot(root, name, { mode: 'diagnostic' });
  for (const [id, meta] of Object.entries(checked.manifest.layers || {})) {
    if (meta.status === 'skipped') checked.layers[id] = { __skipped: meta.reason };
  }
  return checked;
}

function dbRows(data) {
  return Array.isArray(data?.databases) ? data.databases : null;
}

function schemaArtifact(snapshot, target) {
  return (snapshot.artifacts || []).find((artifact) =>
    artifact.layer === 'database' && artifact.target === target &&
    artifact.kind === 'sqlite-schema' && artifact.privacy === 'private' &&
    (typeof artifact.absolutePath === 'string' || artifact.content !== undefined));
}

function createObservation() {
  return { byteReads: new WeakMap(), digests: new WeakMap(), jsonValues: new WeakMap() };
}

async function artifactBytes(artifact, observation) {
  if (observation?.byteReads.has(artifact)) return observation.byteReads.get(artifact);
  const read = Promise.resolve().then(() => {
    if (artifact.content !== undefined) return Buffer.isBuffer(artifact.content) ? artifact.content : Buffer.from(artifact.content);
    return fs.readFile(artifact.absolutePath);
  });
  if (observation) observation.byteReads.set(artifact, read);
  return read;
}

async function artifactDigest(artifact, observation) {
  if (observation?.digests.has(artifact)) return observation.digests.get(artifact);
  const digest = artifactBytes(artifact, observation).then((bytes) => U.sha256(bytes));
  if (observation) observation.digests.set(artifact, digest);
  return digest;
}

async function artifactJson(artifact, observation) {
  if (observation?.jsonValues.has(artifact)) return observation.jsonValues.get(artifact);
  const parsed = artifactBytes(artifact, observation).then((bytes) => JSON.parse(bytes.toString('utf8')));
  if (observation) observation.jsonValues.set(artifact, parsed);
  return parsed;
}

async function schemaState(a, b, target, observation) {
  const aa = schemaArtifact(a, target);
  const bb = schemaArtifact(b, target);
  if (!aa || !bb) return 'unknown';
  try {
    const [left, right] = await Promise.all([artifactBytes(aa, observation), artifactBytes(bb, observation)]);
    if (typeof aa.sha256 !== 'string' || U.sha256(left) !== aa.sha256 || typeof bb.sha256 !== 'string' || U.sha256(right) !== bb.sha256) return 'unknown';
    return left.equals(right) ? 'same' : 'changed';
  } catch { return 'unknown'; }
}

async function diffDatabase(a, b, out, line, observation, artifactsA = [], artifactsB = []) {
  const da = dbRows(a);
  const db = dbRows(b);
  if (da === null || db === null) {
    out.push('  ? database metadata 未比较 (one or both snapshots do not contain validated database metadata)');
    out.push('  ? database row contents 未比较');
    return;
  }
  const ma = new Map(da.filter((x) => x && typeof x.file === 'string').map((x) => [x.file, x]));
  const mb = new Map(db.filter((x) => x && typeof x.file === 'string').map((x) => [x.file, x]));
  for (const file of [...new Set([...ma.keys(), ...mb.keys()])].sort()) {
    const before = ma.get(file), after = mb.get(file);
    if (!before) line(`+ database ${file}: present in B only`);
    else if (!after) line(`- database ${file}: present in A only`);
    else {
      if ((before.mode ?? null) !== (after.mode ?? null)) line(`~ database ${file}: mode changed`);
      if ((before.totalRows ?? null) !== (after.totalRows ?? null)) line(`~ database ${file}: recorded row count changed`);
      const ta = Array.isArray(before.tables) ? [...before.tables].sort() : null;
      const tb = Array.isArray(after.tables) ? [...after.tables].sort() : null;
      if (ta === null || tb === null) out.push(`  ? database ${file}: table list 未比较`);
      else if (ta.join('\n') !== tb.join('\n')) line(`~ database ${file}: table list changed`);
      const schema = await schemaState({ artifacts: artifactsA }, { artifacts: artifactsB }, file, observation);
      if (schema === 'same') out.push(`  = database ${file}: schema matches`);
      else if (schema === 'changed') line(`~ database ${file}: schema changed`);
      else out.push(`  ? database ${file}: schema 未比较`);
    }
    // Metadata and schema cannot establish row equality. Never print private
    // SQL, database bytes, or a digest of either.
    out.push(`  ? database ${file}: row contents 未比较`);
  }
  if (!ma.size && !mb.size) out.push('  = no recorded databases');
}

function diffVersions(a, b, out) {
  const ra = a.resolved || {}, rb = b.resolved || {};
  let count = 0;
  for (const name of [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort()) {
    if (ra[name] && rb[name] && ra[name] !== rb[name]) { out.push(`  ~ ${name}: ${ra[name]} -> ${rb[name]}`); count++; }
    else if (!ra[name] && rb[name]) { out.push(`  + ${name}: ${rb[name]} (added)`); count++; }
    else if (ra[name] && !rb[name]) { out.push(`  - ${name}: was ${ra[name]} (removed)`); count++; }
  }
  return count;
}

function runtimePinNames(snapshot) {
  const metadata = snapshot?.layers?.runtime?.versionPins;
  if (!Array.isArray(metadata)) return null;
  const names = new Set(metadata.filter((pin) => pin && typeof pin.name === 'string').map((pin) => pin.name));
  for (const artifact of snapshot.artifacts || []) {
    const name = artifact?.target || artifact?.destName || (typeof artifact?.srcPath === 'string' ? artifact.srcPath.split(/[\\/]/).pop() : null);
    if ((artifact?.layer === 'runtime' || artifact?.layer === undefined) && (artifact?.kind === 'file' || artifact?.kind === undefined) && ['.nvmrc', '.node-version'].includes(name)) names.add(name);
  }
  return names;
}

async function runtimePinState(snapshot, name, observation) {
  const metadata = snapshot?.layers?.runtime?.versionPins;
  if (!Array.isArray(metadata)) return { status: 'unknown' };
  const declared = metadata.some((pin) => pin?.name === name);
  const artifacts = (snapshot.artifacts || []).filter((artifact) =>
    (artifact?.layer === 'runtime' || artifact?.layer === undefined) &&
    (artifact?.kind === 'file' || artifact?.kind === undefined) &&
    (artifact.target || artifact.destName || (typeof artifact.srcPath === 'string' ? artifact.srcPath.split(/[\\/]/).pop() : null)) === name);
  if (!declared && artifacts.length === 0) return { status: 'absent' };
  if (!declared || artifacts.length !== 1) return { status: 'unknown' };
  try {
    const artifact = artifacts[0];
    const liveCollectorFile = artifact.layer === undefined && artifact.srcPath && artifact.destName === name;
    if ((!liveCollectorFile && artifact.privacy !== 'private') || (artifact.restore !== undefined && artifact.restore !== 'restore-file')) return { status: 'unknown' };
    const digest = await artifactDigest(artifact, observation);
    if (artifact.sha256 && digest !== artifact.sha256) return { status: 'unknown' };
    return { status: 'present', digest };
  } catch { return { status: 'unknown' }; }
}

async function diffRuntimePins(a, b, out, line, observation) {
  const namesA = runtimePinNames(a), namesB = runtimePinNames(b);
  if (!namesA || !namesB) {
    out.push('  ? runtime version pin files 未比较 (private artifact evidence unavailable)');
    return;
  }
  for (const name of [...new Set([...namesA, ...namesB])].sort()) {
    const [before, after] = await Promise.all([runtimePinState(a, name, observation), runtimePinState(b, name, observation)]);
    if (before.status === 'unknown' || after.status === 'unknown') {
      out.push(`  ? runtime pin ${name}: contents 未比较 (validated private file evidence unavailable)`);
    } else if (before.status === 'absent' && after.status === 'present') {
      line(`+ runtime pin ${name} present in B only (contents withheld)`);
    } else if (before.status === 'present' && after.status === 'absent') {
      line(`- runtime pin ${name} present in A only (contents withheld)`);
    } else if (before.status === 'present' && after.status === 'present' && before.digest !== after.digest) {
      line(`~ runtime pin ${name} changed (contents withheld)`);
    } else if (before.status === 'present' && after.status === 'present') {
      out.push(`  = runtime pin ${name} contents match (contents withheld)`);
    }
  }
}

async function configFileState(artifacts, file, expectedKeys, observation) {
  const matching = (artifacts || []).filter((artifact) => {
    const snapshotArtifact = artifact?.layer === 'config' && artifact?.kind === 'file' &&
      artifact?.privacy === 'private' && artifact?.restore === 'restore-file' && artifact?.target === file;
    const liveCollectorFile = artifact?.layer === undefined && artifact?.secret === true &&
      artifact?.destName === file && typeof artifact?.srcPath === 'string';
    return snapshotArtifact || liveCollectorFile;
  });
  if (matching.length !== 1) return { status: 'unknown' };
  try {
    const artifact = matching[0];
    const bytes = await artifactBytes(artifact, observation);
    const digest = await artifactDigest(artifact, observation);
    if (artifact.layer === 'config' && (typeof artifact.sha256 !== 'string' || digest !== artifact.sha256)) return { status: 'unknown' };
    const parsedKeys = parseEnv(bytes.toString('utf8'));
    const canonical = (keys) => JSON.stringify(Object.fromEntries(Object.entries(keys || {}).sort(([a], [b]) => a.localeCompare(b))));
    if (canonical(parsedKeys) !== canonical(expectedKeys)) return { status: 'unknown' };
    return { status: 'present', digest };
  } catch { return { status: 'unknown' }; }
}

async function dependencyDeclarationState(snapshot, observation) {
  const artifacts = (snapshot?.artifacts || []).filter((artifact) =>
    artifact?.layer === 'deps' && artifact?.target === 'package.json' &&
    (artifact?.kind === 'file' || artifact?.kind === undefined) &&
    (artifact?.restore === 'restore-file' || (artifact?.restore === undefined && artifact?.srcPath)) &&
    (['public', 'private'].includes(artifact?.privacy) || (artifact?.privacy === undefined && artifact?.srcPath)));
  if (artifacts.length !== 1) return { status: 'unknown' };
  try {
    const artifact = artifacts[0];
    const [bytes, pkg, digest] = await Promise.all([
      artifactBytes(artifact, observation), artifactJson(artifact, observation), artifactDigest(artifact, observation),
    ]);
    if (artifact.sha256 && digest !== artifact.sha256) return { status: 'unknown' };
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return { status: 'unknown' };
    const groups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'];
    const declarations = {};
    for (const group of groups) {
      if (pkg[group] === undefined) continue;
      if (!pkg[group] || typeof pkg[group] !== 'object' || Array.isArray(pkg[group])) return { status: 'unknown' };
      declarations[group] = Object.fromEntries(Object.entries(pkg[group]).sort(([a], [b]) => a.localeCompare(b)));
    }
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(declarations).sort(([a], [b]) => a.localeCompare(b))));
    return { status: 'present', digest: U.sha256(Buffer.from(canonical)) };
  } catch { return { status: 'unknown' }; }
}

async function dependencyPairingState(snapshot, layer, observation) {
  const lockName = layer?.lockFile;
  if (!lockName) return { status: 'not-applicable' };
  if (lockName !== 'package-lock.json') return { status: 'unknown' };
  const artifacts = (snapshot?.artifacts || []).filter((artifact) =>
    (artifact?.layer === 'deps' || artifact?.layer === undefined) &&
    (artifact?.target || artifact?.destName) === lockName &&
    (artifact?.kind === 'file' || artifact?.kind === undefined) &&
    (artifact?.restore === 'restore-file' || (artifact?.restore === undefined && artifact?.srcPath)) &&
    (['public', 'private'].includes(artifact?.privacy) || (artifact?.privacy === undefined && artifact?.srcPath)));
  if (artifacts.length !== 1) return { status: 'unknown' };
  const manifest = (snapshot?.artifacts || []).filter((artifact) =>
    artifact?.layer === 'deps' && artifact?.target === 'package.json' &&
    (artifact?.kind === 'file' || artifact?.kind === undefined) &&
    (artifact?.restore === 'restore-file' || (artifact?.restore === undefined && artifact?.srcPath)));
  if (manifest.length !== 1) return { status: 'unknown' };
  try {
    const [lock, pkg, lockDigest, manifestDigest] = await Promise.all([
      artifactJson(artifacts[0], observation), artifactJson(manifest[0], observation),
      artifactDigest(artifacts[0], observation), artifactDigest(manifest[0], observation),
    ]);
    for (const [artifact, digest] of [[artifacts[0], lockDigest], [manifest[0], manifestDigest]]) {
      if (artifact.sha256 && digest !== artifact.sha256) return { status: 'unknown' };
    }
    const root = lock?.packages?.[''];
    if (!pkg || typeof pkg !== 'object' || !root || typeof root !== 'object') return { status: 'unknown' };
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const declared = pkg[group] ?? {};
      const locked = root[group] ?? {};
      if (!declared || typeof declared !== 'object' || Array.isArray(declared) || !locked || typeof locked !== 'object' || Array.isArray(locked)) return { status: 'unknown' };
      const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
      if (canonical(declared) !== canonical(locked)) return { status: 'mismatch' };
    }
    return { status: 'consistent' };
  } catch { return { status: 'unknown' }; }
}

async function diffLayer(id, a, b, out, artifactsA = [], artifactsB = [], observation) {
  out.push(`[${id}]`);
  let count = 0;
  const line = (s) => { out.push(`  ${s}`); count++; };
  const sa = a && a.__skipped, sb = b && b.__skipped;
  if (a?.__unreadable || b?.__unreadable) { line(`? layer integrity unavailable (${a?.__unreadable || b?.__unreadable})`); return count; }
  if (id === 'database' && (sa || sb || !a || !b)) {
    if (sa && sb && sa === sb) out.push(`  = database collection skipped in both (${sa})`);
    else if (sa || sb || !a || !b) line(`~ database availability: ${sa ? `skipped in A (${sa})` : a ? 'collected in A' : 'layer absent in A'} -> ${sb ? `skipped in B (${sb})` : b ? 'collected in B' : 'layer absent in B'}`);
    out.push('  ? database metadata/schema 未比较');
    out.push('  ? database row contents 未比较');
    return count;
  }
  if (sa && sb) {
    if (sa === sb) out.push(`  = skipped in both (${sa})`);
    else line(`~ availability: skipped in A (${sa}) -> skipped in B (${sb})`);
    return count;
  }
  if (sa || sb) { line(`~ availability: ${sa ? `skipped in A (${sa})` : 'collected in A'} -> ${sb ? `skipped in B (${sb})` : 'collected in B'}`); return count; }
  if (!a || !b) { line('~ availability: layer absent on one side'); return count; }

  if (id === 'git') {
    if (a.commit !== b.commit) line(`~ commit: ${String(a.commit || 'unknown').slice(0, 7)} -> ${String(b.commit || 'unknown').slice(0, 7)}`);
    else out.push('  = commit (same)');
    if ((a.branch || 'detached') !== (b.branch || 'detached')) line(`~ branch: ${a.branch || 'detached'} -> ${b.branch || 'detached'}`);
    if (a.dirty !== b.dirty || a.dirtyCount !== b.dirtyCount) line(`~ working tree: ${a.dirty ? `${a.dirtyCount} changes` : 'clean'} -> ${b.dirty ? `${b.dirtyCount} changes` : 'clean'}`);
  } else if (id === 'deps') {
    if (a.lockFile !== b.lockFile) line(`~ lockfile: ${a.lockFile || '(none)'} -> ${b.lockFile || '(none)'}`);
    else if (a.lockFingerprint !== b.lockFingerprint) line('~ lockfile fingerprint changed');
    else if (a.lockFile) out.push(`  = lockfile: ${a.lockFile} (same fingerprint)`);
    const before = out.length;
    count += diffVersions(a, b, out);
    if (out.length === before && a.resolved && b.resolved) out.splice(before);
    const [declaredA, declaredB] = await Promise.all([
      dependencyDeclarationState({ artifacts: artifactsA }, observation),
      dependencyDeclarationState({ artifacts: artifactsB }, observation),
    ]);
    if (declaredA.status !== 'present' || declaredB.status !== 'present') {
      out.push('  ? package.json dependency declarations 未比较 (validated manifest unavailable)');
    } else if (declaredA.digest !== declaredB.digest) {
      line('~ package.json dependency declarations changed (values withheld)');
    } else {
      out.push('  = package.json dependency declarations match (values withheld)');
    }
    const [pairA, pairB] = await Promise.all([dependencyPairingState({ artifacts: artifactsA }, a, observation), dependencyPairingState({ artifacts: artifactsB }, b, observation)]);
    if (pairA.status === 'mismatch') line('! package.json and package-lock.json declarations disagree in A (values withheld)');
    if (pairB.status === 'mismatch') line('! package.json and package-lock.json declarations disagree in B (values withheld)');
    if (pairA.status === 'unknown' || pairB.status === 'unknown') out.push('  ? package.json/lockfile pairing 未比较 (format or validated inputs unsupported)');
    else if (pairA.status === 'consistent' && pairB.status === 'consistent') out.push('  = package.json and package-lock.json declarations match in both snapshots');
    if ((a.note || '') !== (b.note || '')) line('~ dependency collection note changed');
  } else if (id === 'runtime') {
    for (const key of ['node', 'npm', 'python']) {
      if ((a[key] || null) !== (b[key] || null)) line(`~ ${key}: ${a[key] || '(absent)'} -> ${b[key] || '(absent)'}`);
      else if (a[key]) out.push(`  = ${key}: ${a[key]}`);
    }
    await diffRuntimePins({ layers: { runtime: a }, artifacts: artifactsA }, { layers: { runtime: b }, artifacts: artifactsB }, out, line, observation);
  } else if (id === 'config') {
    const files = [...new Set([...Object.keys(a.envFiles || {}), ...Object.keys(b.envFiles || {})])].sort();
    for (const file of files) {
      const fa = a.envFiles?.[file], fb = b.envFiles?.[file];
      if (!fa) {
        line(`+ env file ${file}: present in B only`);
        for (const key of Object.keys(fb.keys || {}).sort()) line(`+ key ${key} added in ${file} (${fb.keys[key].nonEmpty ? 'non-empty' : 'empty'})`);
        continue;
      }
      if (!fb) {
        line(`- env file ${file}: present in A only`);
        for (const key of Object.keys(fa.keys || {}).sort()) line(`- key ${key} removed with ${file}`);
        continue;
      }
      const [contentA, contentB] = await Promise.all([
        configFileState(artifactsA, file, fa.keys, observation),
        configFileState(artifactsB, file, fb.keys, observation),
      ]);
      if (contentA.status !== 'present' || contentB.status !== 'present') {
        out.push(`  ? env file ${file} contents 未比较 (validated private artifact evidence unavailable)`);
      } else if (contentA.digest !== contentB.digest) {
        line(`~ env file ${file} contents changed (values withheld)`);
      } else {
        out.push(`  = env file ${file} contents match (values withheld)`);
      }
      const keys = [...new Set([...Object.keys(fa.keys || {}), ...Object.keys(fb.keys || {})])].sort();
      for (const key of keys) {
        const ka = fa.keys?.[key], kb = fb.keys?.[key];
        if (!ka) line(`+ key ${key} added (${kb.nonEmpty ? 'non-empty' : 'empty'})`);
        else if (!kb) line(`- key ${key} removed`);
        else if (ka.nonEmpty !== kb.nonEmpty) line(`~ key ${key}: ${ka.nonEmpty ? 'non-empty' : 'empty'} -> ${kb.nonEmpty ? 'non-empty' : 'empty'}`);
      }
    }
  } else if (id === 'docker') {
    const ma = new Map((a.services || []).map((s) => [s.name, s.state]));
    const mb = new Map((b.services || []).map((s) => [s.name, s.state]));
    for (const [name, va] of ma) {
      if (!mb.has(name)) line(`- service ${name}: removed (was ${va})`);
      else if (mb.get(name) !== va) line(`~ service ${name}: ${va} -> ${mb.get(name)}`);
    }
    for (const [name, vb] of mb) if (!ma.has(name)) line(`+ service ${name}: added (${vb})`);
  } else if (id === 'database') {
    await diffDatabase(a, b, out, line, observation, artifactsA, artifactsB);
  }
  else out.push('  ? layer type is not compared');
  return count;
}

async function compareCmd(root, nameA, nameB) {
  for (const name of [nameA, nameB]) {
    if (name !== undefined && !U.NAME_RE.test(name)) {
      U.printError(`Invalid snapshot name "${name}".`, 'Names may contain letters, digits, dot, underscore, and hyphen (max 64 chars).', U.cliNext(['list'], 'Run "project-state list" to see valid snapshot names.'));
      return 1;
    }
  }
  let A, B;
  try {
    A = await loadSnapshot(root, nameA);
    if (nameB === undefined) B = await loadCurrent(root);
    else B = await loadSnapshot(root, nameB);
  } catch (e) {
    if (e.code === 'ESNAPSHOT_MISSING') {
      const available = await Store.listSnapshots(root, { includeLegacy: true }).catch(() => []);
      const missing = e.message.match(/snapshot not found: (.+)$/)?.[1] || nameA;
      U.printError(`Snapshot "${missing}" not found.`, 'No validated generation is available under that name.', available.length ? `Available snapshots: ${available.join(', ')}` : `No snapshots exist yet - create one with: ${U.cliNext(['snapshot', 'before-change'], 'project-state snapshot before-change')}`);
      return 1;
    }
    U.printError('Cannot compare snapshot state.', e.message, U.cliNext(['list'], 'Run "project-state list" to inspect snapshot integrity and legacy status.'));
    return 1;
  }
  if (!A || !B) {
    const missing = !A ? nameA : nameB;
    U.printError(`Snapshot "${missing}" not found or not diagnostically readable.`, 'No validated v2 generation is available for this comparison.', U.cliNext(['list'], 'Run "project-state list" to inspect the snapshot.'));
    return 1;
  }
  if (A.manifest?.schemaVersion !== 2 || B.manifest?.schemaVersion !== 2) {
    U.printError('Cannot compare this snapshot generation.', 'The generation is diagnostic-only or lacks required validated artifacts.', 'Legacy v1 snapshots are not migrated or restored automatically.');
    return 1;
  }
  const bLabel = nameB === undefined ? 'current (live)' : `"${nameB}"`;
  console.log(`Comparing "${nameA}" (${A.manifest.createdAt}) -> ${bLabel} (${B.manifest.createdAt})\n`);
  const ids = [...new Set([...Object.keys(A.layers || {}), ...Object.keys(B.layers || {}), 'database'])].sort();
  let total = 0, unknown = 0;
  const observation = createObservation();
  for (const id of ids) {
    const out = [];
    total += await diffLayer(id, A.layers?.[id], B.layers?.[id], out, A.artifacts || [], B.artifacts || [], observation);
    unknown += out.filter((line) => line.startsWith('  ?')).length;
    console.log(out.join('\n'));
  }
  console.log('');
  if (unknown > 0) console.log(`${total} difference(s) found; ${unknown} check(s) not compared. Equality is unknown for those checks.`);
  else if (total === 0) console.log('No differences found across compared metadata. This does not establish application health.');
  else console.log(`${total} difference(s) found.`);
  if (unknown > 0) console.log('Not compared means equality cannot be concluded for those checks.');
  if (total > 0) {
    const preview = U.cliCommandLines(['restore', nameA, '--dry-run']);
    if (preview.length) {
      console.log(`Next: preview restoring the first snapshot ("${nameA}"); review the plan before authorizing writes:`);
      for (const line of preview) console.log(`  ${line}`);
    }
  }
  return 0;
}

module.exports = { compareCmd, diffDatabase, loadCurrent, loadSnapshot, diffRuntimePins, configFileState, dependencyDeclarationState, dependencyPairingState, createObservation, artifactBytes, artifactDigest, artifactJson };
