'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const Store = require(process.env.PROJECT_STATE_STORAGE || '../lib/storage');
const { snapshotInternal } = require('../lib/snapshot');
const { COLLECTORS } = require('../lib/collectors');

async function project(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-state-storage-'));
  t.after(() => removeTemporaryTree(root));
  return root;
}

async function removeTemporaryTree(root) {
  const transient = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES']);
  let lastTransient = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await fsp.rm(root, { recursive: true, force: true }); }
    catch (error) { if (!transient.has(error.code)) throw error; lastTransient = error; }
    try { await fsp.lstat(root); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (attempt === 5) throw lastTransient || new Error(`temporary project remains after cleanup: ${root}`);
    await new Promise((resolve) => setTimeout(resolve, 15 * (2 ** attempt)));
  }
}

test('commits a v2 generation with pointer, exact artifact inventory and private bytes', async (t) => {
  const root = await project(t);
  const result = await snapshotInternal(root, 'auto-20261017-000001', { kind: 'auto',
    extraArtifacts: [{ layer: 'rollback', kind: 'file', target: '.env', content: Buffer.from('PRIVATE_MARKER') }],
  });
  const checked = await Store.validateSnapshot(root, 'auto-20261017-000001', { mode: 'restore' });
  assert.equal(result.generation, checked.generation);
  assert.equal(checked.manifest.schemaVersion, 2);
  assert.equal(checked.manifest.state, 'complete');
  assert.equal(checked.manifest.kind, 'auto');
  const pointer = JSON.parse(await fsp.readFile(checked.paths.currentFile, 'utf8'));
  assert.equal(pointer.generation, result.generation);
  const artifact = checked.artifacts.find((item) => item.target === '.env');
  assert.ok(artifact);
  assert.equal(artifact.privacy, 'private');
  assert.equal(artifact.size, Buffer.byteLength('PRIVATE_MARKER'));
  assert.equal(await fsp.readFile(artifact.absolutePath, 'utf8'), 'PRIVATE_MARKER');
  assert.equal(artifact.absolutePath.startsWith(checked.paths.privateGenerationDir), true);
});

test('generation validation rejects undeclared and empty directories before restore', async (t) => {
  const root = await project(t);
  const name = 'auto-20261017-000004';
  const saved = await snapshotInternal(root, name, { kind: 'auto',
    extraArtifacts: [{ layer: 'rollback', kind: 'file', target: '.env', content: Buffer.from('SAFE') }],
  });
  const P = Store.snapshotPaths(root, name, saved.generation);
  await fsp.mkdir(path.join(P.publicGenerationDir, 'extra'), { recursive: true });
  await fsp.writeFile(path.join(P.publicGenerationDir, 'extra', 'intruder'), 'marker');
  await assert.rejects(Store.validateSnapshot(root, name), (error) => error.code === 'EARTIFACT_UNDECLARED');
  await fsp.rm(path.join(P.publicGenerationDir, 'extra'), { recursive: true });
  await fsp.mkdir(path.join(P.publicGenerationDir, 'files'), { recursive: true });
  await fsp.writeFile(path.join(P.publicGenerationDir, 'files', 'rogue'), 'marker');
  await assert.rejects(Store.validateSnapshot(root, name), (error) => error.code === 'EARTIFACT_UNDECLARED');
  await fsp.unlink(path.join(P.publicGenerationDir, 'files', 'rogue'));
  const privateFile = path.join(P.privateGenerationDir, 'files', 'rollback', '0000');
  await fsp.link(privateFile, path.join(P.privateGenerationDir, 'files', 'rollback', 'alias'));
  await assert.rejects(Store.validateSnapshot(root, name), (error) => error.code === 'EUNSAFE_PATH');
});

test('v1 snapshot is diagnostic-only and is neither migrated nor deleted', async (t) => {
  const root = await project(t);
  const dir = path.join(root, '.project-state', 'snapshots', 'legacy');
  await fsp.mkdir(dir, { recursive: true });
  const bytes = JSON.stringify({ schemaVersion: 1, name: 'legacy', layers: {} });
  await fsp.writeFile(path.join(dir, 'manifest.json'), bytes);
  const diagnostic = await Store.validateSnapshot(root, 'legacy', { mode: 'diagnostic' });
  assert.equal(diagnostic.restorable, false);
  await assert.rejects(Store.validateSnapshot(root, 'legacy', { mode: 'restore' }), (error) => error.code === 'ELEGACY_RESTORE');
  assert.equal(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'), bytes);
  await assert.rejects(snapshotInternal(root, 'legacy', { overwrite: true }), (error) => error.code === 'ELEGACY_RESTORE');
});

test('public layer metadata and secret-bearing source copies are split by privacy', async (t) => {
  const root = await project(t);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  await fsp.writeFile(path.join(root, '.env'), 'API_TOKEN=PRIVATE_MARKER\n');
  const saved = await snapshotInternal(root, 'privacy-split');
  const checked = await Store.validateSnapshot(root, 'privacy-split', { mode: 'restore' });
  const publicText = await fsp.readFile(checked.paths.manifestFile, 'utf8');
  const privateText = await fsp.readFile(checked.paths.privateManifestFile, 'utf8');
  assert.equal(publicText.includes('PRIVATE_MARKER'), false);
  assert.equal(publicText.includes('API_TOKEN'), false);
  assert.equal(privateText.includes('PRIVATE_MARKER'), false);
  const env = checked.artifacts.find((artifact) => artifact.target === '.env');
  assert.ok(env);
  assert.equal(env.privacy, 'private');
  assert.equal(await fsp.readFile(env.absolutePath, 'utf8'), 'API_TOKEN=PRIVATE_MARKER\n');
  assert.ok(checked.artifacts.some((artifact) => artifact.layer === 'deps' && artifact.kind === 'layer-json' && artifact.privacy === 'public'));
  assert.equal(saved.manifest.artifacts.some((artifact) => artifact.target === '.env'), false);
});

test('database collector inputs with target-bound virtual bytes become private artifacts', async (t) => {
  const root = await project(t);
  const database = COLLECTORS.find((collector) => collector.id === 'database');
  const original = database.fn;
  database.fn = async (ctx) => {
    ctx.files.push({
      id: 'database-schema:app.db', layer: 'database', kind: 'sqlite-schema',
      privacy: 'private', required: true, restore: 'record-only', target: 'app.db',
      content: Buffer.from('CREATE TABLE marker(id INTEGER);'),
    });
    return { status: 'collected', data: { databases: [{ file: 'app.db', mode: 'schema', restore: 'record-only', artifactId: 'database-schema:app.db', schemaFingerprint: 'f'.repeat(64), tables: ['marker'], totalRows: 0, integrity: 'ok', rowContentsCompared: false }], engine: 'sqlite3 online backup API', withSeed: false, comparison: 'schema and row counts recorded; row contents not compared' } };
  };
  try {
    const saved = await snapshotInternal(root, 'db-private');
    const checked = await Store.validateSnapshot(root, 'db-private', { mode: 'restore' });
    assert.equal(saved.manifest.artifacts.some((artifact) => artifact.layer === 'database'), false);
    const schema = checked.artifacts.find((artifact) => artifact.id === 'database-schema:app.db');
    assert.ok(schema);
    assert.equal(schema.privacy, 'private');
    assert.equal(await fsp.readFile(schema.absolutePath, 'utf8'), 'CREATE TABLE marker(id INTEGER);');
  } finally { database.fn = original; }
});

test('layer schemas accept collector shapes and reject extra fields and wrong nested types', () => {
  const validConfig = { envFiles: { '.env': { keyCount: 1, keys: { API_TOKEN: { nonEmpty: true } } } } };
  const validRuntime = { node: 'v22.0.0', npm: null, python: null, versionPins: [{ name: '.nvmrc' }] };
  assert.doesNotThrow(() => Store.validateLayer('config', validConfig));
  assert.doesNotThrow(() => Store.validateLayer('runtime', validRuntime));
  assert.throws(() => Store.validateLayer('config', { envFiles: { '.env': { keyCount: 1, keys: { API_TOKEN: { nonEmpty: true, value: 'PRIVATE_MARKER' } } } } }), /config key metadata/);
  assert.throws(() => Store.validateLayer('config', { ...validConfig, extra: true }), /config layer fields/);
  assert.throws(() => Store.validateLayer('runtime', { ...validRuntime, versionPins: [{ name: '.nvmrc', content: 'secret' }] }), /runtime layer fields/);
  assert.throws(() => Store.validateLayer('docker', { services: [{ name: 'web', state: 'running', command: 'unexpected' }] }), /docker layer fields/);
  assert.throws(() => Store.validateLayer('git', { commit: 'a'.repeat(40), branch: 'main', detached: false, dirty: false, dirtyCount: '0', statusSample: [] }), /git layer fields/);
});

test('lock handles are authenticated and generation pins survive lock release', async (t) => {
  const root = await project(t);
  const result = await snapshotInternal(root, 'pinned');
  const lock = await Store.acquireOperationLock(root, { operation: 'restore' });
  try {
    await assert.rejects(Store.acquireOperationLock(root, { operation: 'other' }), (error) => error.code === 'ELOCKED');
    await assert.rejects(Store.assertLock(root, { ...lock }), (error) => error.code === 'ELOCK_OWNER');
    const pin = await Store.pinSnapshot(root, { name: 'pinned', generation: result.generation, operationId: lock.operationId, reason: 'rollback-needed' });
    assert.equal(await Store.isGenerationProtected(root, 'pinned', result.generation), true);
    assert.equal((await Store.listPins(root)).some((item) => item.pinId === pin.pinId), true);
    await lock.release();
    assert.equal(await Store.isGenerationProtected(root, 'pinned', result.generation), true);
  } finally {
    await lock.release().catch(() => {});
  }
});

test('operation lock release retires the owner-bearing directory before cleanup', async (t) => {
  const root = await project(t);
  const lock = await Store.acquireOperationLock(root, { operation: 'snapshot' });
  const ownerBefore = fs.readFileSync(path.join(root, '.project-state', 'locks', 'operation.lock', 'owner.json'));
  assert.equal(JSON.parse(ownerBefore).token, lock.token);
  const realRm = fsp.rm.bind(fsp);
  fsp.rm = async (target, options) => {
    if (String(target).includes(`operation.retired-${lock.token}-`)) { const error = new Error('injected retired lock cleanup failure'); error.code = 'EACCES'; throw error; }
    return realRm(target, options);
  };
  try {
  assert.equal(await lock.release(), true);
  } finally { fsp.rm = realRm; }
  assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')), false);
  const locksDir = path.join(root, '.project-state', 'locks');
  const retired = (await fsp.readdir(locksDir)).find((name) => name.startsWith(`operation.retired-${lock.token}-`));
  assert.ok(retired, 'failed cleanup leaves the owner-bearing retired directory as inert evidence');
  assert.deepEqual(fs.readFileSync(path.join(locksDir, retired, 'owner.json')), ownerBefore);
  const next = await Store.acquireOperationLock(root, { operation: 'restore' });
  try { assert.notEqual(next.token, lock.token); }
  finally { await next.release(); }
});

test('operation journal validates target size and file identity used for rollback proof', async (t) => {
  const root = await project(t);
  const lock = await Store.acquireOperationLock(root, { operation: 'restore' });
  try {
    await Store.writeOperationJournal(root, lock, {
      operationId: lock.operationId, operation: 'restore', phase: 'applying',
      appliedTargets: [{
        target: '.env', preExists: false, preSha256: null, preSize: null,
        postExists: true, postSha256: 'a'.repeat(64), postSize: 12, postFileId: { dev: 2, ino: 3 },
      }],
    });
    const file = Store.operationJournalPath(root, lock.operationId);
    const journal = await Store.readJournal(root, file);
    assert.equal(journal.appliedTargets[0].postSize, 12);
    assert.deepEqual(journal.appliedTargets[0].postFileId, { dev: 2, ino: 3 });
    await assert.rejects(Store.writeOperationJournal(root, lock, {
      operationId: lock.operationId, operation: 'restore', phase: 'applying',
      appliedTargets: [{ target: '.env', preExists: false, preSha256: null, postExists: true, postSha256: 'a'.repeat(64), postSize: -1 }],
    }), (error) => error.code === 'EJOURNAL_INVALID');
  } finally { await lock.release(); }
});

test('operation journal preserves Windows file ids beyond JavaScript safe integer precision', async (t) => {
  const root = await project(t);
  const lock = await Store.acquireOperationLock(root, { operation: 'restore' });
  const expected = { dev: '18446744073709551615', ino: '9223372036854775809' };
  try {
    await Store.writeOperationJournal(root, lock, {
      operationId: lock.operationId, operation: 'restore', phase: 'completed',
      appliedTargets: [{
        target: '.env', preExists: false, preSha256: null, preSize: null,
        postExists: true, postSha256: 'b'.repeat(64), postSize: 1, postFileId: expected,
      }],
    });
    const journal = await Store.readJournal(root, Store.operationJournalPath(root, lock.operationId));
    assert.deepEqual(journal.appliedTargets[0].postFileId, expected);
  } finally { await lock.release(); }
});

test('operation journal rejects unknown pending-target fields before persisting them', async (t) => {
  const root = await project(t);
  const lock = await Store.acquireOperationLock(root, { operation: 'restore' });
  try {
    await assert.rejects(Store.writeOperationJournal(root, lock, {
      operationId: lock.operationId, operation: 'restore', phase: 'applying', status: 'in-progress',
      pendingTarget: {
        target: '.env', preExists: true, preSha256: 'a'.repeat(64), preSize: 1,
        postExists: true, postSha256: 'b'.repeat(64), postSize: 1,
        secretPayload: 'MUST_NOT_ENTER_JOURNAL',
      },
    }), (error) => error.code === 'EJOURNAL_INVALID');
    await assert.rejects(Store.readJournal(root, Store.operationJournalPath(root, lock.operationId)), (error) => error.code === 'ENOENT');
  } finally { await lock.release(); }
});

test('operation journal accepts only private pending-temp records bound to the operation', async (t) => {
  const root = await project(t);
  const lock = await Store.acquireOperationLock(root, { operation: 'restore' });
  const file = Store.operationJournalPath(root, lock.operationId);
  const pendingTemp = {
    path: `staging/${lock.operationId}/private/restore-temp-01`, target: '.env',
    dev: '18446744073709551615', ino: '9223372036854775809', size: 7,
    sha256: 'c'.repeat(64), phase: 'prepared',
  };
  try {
    await Store.writeOperationJournal(root, lock, {
      operationId: lock.operationId, operation: 'restore', phase: 'applying', status: 'in-progress', pendingTemp,
    });
    assert.deepEqual((await Store.readJournal(root, file)).pendingTemp, pendingTemp);
    const before = await fsp.readFile(file);
    const invalid = [
      { ...pendingTemp, path: `staging/${Store.randomId()}/private/restore-temp-01` },
      { ...pendingTemp, path: `staging/${lock.operationId}/public/restore-temp-01` },
      { ...pendingTemp, path: `staging/${lock.operationId}/private/../restore-temp-01` },
      { ...pendingTemp, phase: 'prepared', leaked: 'secret' },
      { ...pendingTemp, target: '../.git/config' },
      { ...pendingTemp, size: -1 },
      { ...pendingTemp, dev: '01' },
      { ...pendingTemp, sha256: 'not-a-digest' },
      { ...pendingTemp, phase: 'unknown' },
    ];
    for (const value of invalid) {
      await assert.rejects(Store.writeOperationJournal(root, lock, {
        operationId: lock.operationId, operation: 'restore', phase: 'applying', pendingTemp: value,
      }), (error) => error.code === 'EJOURNAL_INVALID');
      assert.deepEqual(await fsp.readFile(file), before, 'invalid temp record is rejected before journal replacement');
    }
    await Store.writeOperationJournal(root, lock, {
      operationId: lock.operationId, operation: 'restore', phase: 'applying', pendingTemp: null,
    });
    assert.equal((await Store.readJournal(root, file)).pendingTemp, null, 'the producer can clear an exact temporary-file record');
  } finally { await lock.release(); }
});

test('operation journal accepts closed cleanup actions and rejects unknown cleanup data', async (t) => {
  const root = await project(t);
  const lock = await Store.acquireOperationLock(root, { operation: 'restore' });
  try {
    const valid = [{ kind: 'resolve-original-safety-pin', operationId: Store.randomId(), name: 'auto-20261017-000001', generation: Store.randomId(), pinId: Store.randomId(), reason: 'EIO' }];
    await Store.writeOperationJournal(root, lock, { operationId: lock.operationId, operation: 'restore', phase: 'completed', terminalOutcome: 'verified-complete', cleanupPending: valid });
    assert.deepEqual((await Store.readJournal(root, Store.operationJournalPath(root, lock.operationId))).cleanupPending, valid);
    await assert.rejects(Store.writeOperationJournal(root, lock, {
      operationId: lock.operationId, operation: 'restore', phase: 'completed', terminalOutcome: 'verified-complete',
      cleanupPending: [{ ...valid[0], secret: 'MUST_NOT_ENTER_JOURNAL' }],
    }), (error) => error.code === 'EJOURNAL_INVALID');
  } finally { await lock.release(); }
});

test('unpin accepts verified-complete only when the matching operation journal proves it', async (t) => {
  const root = await project(t);
  const saved = await snapshotInternal(root, 'unpin-proof');
  const lock = await Store.acquireOperationLock(root, { operation: 'restore' });
  try {
    const pin = await Store.pinSnapshot(root, {
      name: 'unpin-proof', generation: saved.generation, operationId: lock.operationId, reason: 'restore-target',
    });
    await assert.rejects(Store.unpinSnapshot(root, {
      name: 'unpin-proof', generation: saved.generation, pinId: pin.pinId, lock, terminalOutcome: 'verified-complete',
    }), (error) => error.code === 'EPIN_HELD');
    await Store.writeOperationJournal(root, lock, {
      operationId: lock.operationId, operation: 'restore', phase: 'completed', terminalOutcome: 'verified-complete',
    });
    assert.equal(await Store.unpinSnapshot(root, {
      name: 'unpin-proof', generation: saved.generation, pinId: pin.pinId, lock, terminalOutcome: 'verified-complete',
    }), true);
    assert.equal((await Store.listPins(root)).some((item) => item.pinId === pin.pinId), false);
  } finally { await lock.release(); }
});

test('failed pre-publication overwrite leaves the previous generation current and valid', async (t) => {
  const root = await project(t);
  const first = await snapshotInternal(root, 'auto-20261017-000002', { kind: 'auto',
    extraArtifacts: [{ layer: 'rollback', kind: 'file', target: '.env', content: Buffer.from('OLD_BYTES') }],
  });
  await assert.rejects(snapshotInternal(root, 'auto-20261017-000002', { kind: 'auto',
    overwrite: true,
    extraArtifacts: [{ layer: 'rollback', kind: 'file', target: '../.git/config', content: Buffer.from('BAD') }],
  }));
  const after = await Store.validateSnapshot(root, 'auto-20261017-000002', { mode: 'restore' });
  assert.equal(after.generation, first.generation);
  assert.equal(await fsp.readFile(after.artifacts.find((item) => item.target === '.env').absolutePath, 'utf8'), 'OLD_BYTES');
});

test('post-publication integrity failure republishes and verifies the old generation', async (t) => {
  const root = await project(t);
  const name = 'auto-20261017-000003';
  const old = await snapshotInternal(root, name, { kind: 'auto',
    extraArtifacts: [{ layer: 'rollback', kind: 'file', target: '.env', content: Buffer.from('OLD_SAFE_BYTES') }],
  });
  const originalRename = fsp.rename;
  let corrupted = false;
  fsp.rename = async (from, to) => {
    const result = await originalRename(from, to);
    if (!corrupted && path.basename(to) === 'current.json') {
      const now = await Store.validateSnapshot(root, name, { mode: 'diagnostic' });
      const target = now.artifacts.find((item) => item.target === '.env');
      if (target && now.generation !== old.generation) {
        await fsp.writeFile(target.absolutePath, 'CORRUPTED_NEW_BYTES');
        corrupted = true;
      }
    }
    return result;
  };
  try {
    await assert.rejects(snapshotInternal(root, name, { kind: 'auto', overwrite: true,
      extraArtifacts: [{ layer: 'rollback', kind: 'file', target: '.env', content: Buffer.from('NEW_SAFE_BYTES') }],
    }), (error) => error.code === 'EARTIFACT_INTEGRITY');
  } finally { fsp.rename = originalRename; }
  assert.equal(corrupted, true);
  const restored = await Store.validateSnapshot(root, name, { mode: 'restore' });
  assert.equal(restored.generation, old.generation);
  assert.equal(await fsp.readFile(restored.artifacts.find((item) => item.target === '.env').absolutePath, 'utf8'), 'OLD_SAFE_BYTES');
});

test('generation install failure before publication preserves the prior private and public generation', async (t) => {
  const root = await project(t);
  const name = 'auto-20261017-000005';
  const old = await snapshotInternal(root, name, { kind: 'auto',
    extraArtifacts: [{ layer: 'rollback', kind: 'file', target: '.env', content: Buffer.from('PRIOR_BYTES') }],
  });
  const originalRename = fsp.rename;
  let injected = false;
  fsp.rename = async (from, to) => {
    if (!injected && path.basename(from) === 'public' && path.dirname(to).endsWith(path.join(name, 'generations'))) {
      injected = true;
      const error = new Error('injected public generation install failure');
      error.code = 'EACCES';
      throw error;
    }
    return originalRename(from, to);
  };
  try {
    await assert.rejects(snapshotInternal(root, name, { kind: 'auto', overwrite: true,
      extraArtifacts: [{ layer: 'rollback', kind: 'file', target: '.env', content: Buffer.from('REPLACEMENT_BYTES') }],
    }), (error) => error.code === 'EACCES' && error.rollback === 'verified');
  } finally { fsp.rename = originalRename; }
  assert.equal(injected, true);
  const current = await Store.validateSnapshot(root, name, { mode: 'restore' });
  assert.equal(current.generation, old.generation);
  assert.equal(await fsp.readFile(current.artifacts.find((item) => item.target === '.env').absolutePath, 'utf8'), 'PRIOR_BYTES');
});

test('a killed snapshot process after pointer publication leaves a readable old generation and a complete current pair', async (t) => {
  const root = await project(t);
  const name = 'auto-20261017-000006';
  const old = await snapshotInternal(root, name, { kind: 'auto',
    extraArtifacts: [{ layer: 'rollback', kind: 'file', target: '.env', content: Buffer.from('OLD_GENERATION') }],
  });
  const child = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const { snapshotInternal } = require('./lib/snapshot');
    const fsp = fs.promises;
    const rename = fsp.rename.bind(fsp);
    fsp.rename = async (from, to) => {
      const result = await rename(from, to);
      if (path.basename(to) === 'current.json') {
        process.stderr.write('KILLPOINT:pointer-published\n');
        process.kill(process.pid, 'SIGKILL');
        process.stderr.write('AFTER_KILL:process-survived\n');
        await new Promise(() => {});
      }
      return result;
    };
    snapshotInternal(process.argv[1], process.argv[2], {
      kind: 'auto', overwrite: true,
      extraArtifacts: [{ layer: 'rollback', kind: 'file', target: '.env', content: Buffer.from('NEW_GENERATION') }],
    }).catch((error) => { process.stderr.write('CHILD_ERROR:' + String(error.stack || error)); process.exitCode = 1; });
  `;
  let termination;
  try {
    execFileSync(process.execPath, ['-e', child, root, name], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000 });
  } catch (error) { termination = error; }
  assert.ok(termination, 'child must be terminated at the pointer publication killpoint');
  assert.notEqual(termination.status, 0, `child must not exit normally: ${termination.stderr || ''}`);
  assert.match(String(termination.stderr || ''), /KILLPOINT:pointer-published/);
  assert.doesNotMatch(String(termination.stderr || ''), /AFTER_KILL|CHILD_ERROR/, 'termination must happen at the killpoint rather than from a handled exception');

  const prior = await Store.validateGenerationById(root, name, old.generation);
  assert.equal(await fsp.readFile(prior.artifacts.find((item) => item.target === '.env').absolutePath, 'utf8'), 'OLD_GENERATION');
  const current = await Store.validateSnapshot(root, name, { mode: 'restore' });
  assert.equal(current.manifest.generation, current.privateManifest.generation);
  assert.equal(current.manifest.state, 'complete');
  assert.equal(current.privateManifest.state, 'complete');
  if (current.generation !== old.generation) {
    assert.equal(current.manifest.kind, 'auto');
    assert.equal(current.artifacts.find((item) => item.target === '.env')?.privacy, 'private');
    assert.equal(await fsp.readFile(current.artifacts.find((item) => item.target === '.env').absolutePath, 'utf8'), 'NEW_GENERATION');
  }
  const journalDir = path.join(root, '.project-state', 'operations');
  const journals = await fsp.readdir(journalDir);
  assert.equal(journals.length, 2, 'the interrupted attempt must retain its journal alongside the completed source journal');
  const interrupted = await Promise.all(journals.map((file) => Store.readJournal(root, path.join(journalDir, file))));
  const pending = interrupted.find((journal) => journal.snapshotTransaction && journal.status === 'in-progress' && !journal.terminalOutcome);
  assert.ok(pending, 'publication before the completion record remains explicitly diagnosable');
  assert.equal(pending.snapshotTransaction.generation, current.generation, 'published pointer references the interrupted attempt only after full pair installation');
  const staging = path.join(root, '.project-state', 'staging');
  assert.ok(await fsp.lstat(staging).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error)), 'staging residue is not promoted as a snapshot');
  const inspected = await Store.inspectInterruptedSnapshot(root, pending.operationId);
  assert.equal(inspected.action, 'published');
  assert.equal(inspected.alive, false);
  assert.equal(inspected.currentGeneration, current.generation);
  const claimed = await Store.claimInterruptedSnapshot(root, pending.operationId);
  try {
    assert.equal(claimed.lock.operation, 'snapshot');
    assert.equal(claimed.lock.operationId, pending.operationId);
    const recovered = await Store.recoverSnapshotTransactions(root, claimed.lock, pending.operationId);
    assert.deepEqual(recovered, [{ operationId: pending.operationId, action: 'completed', generation: current.generation }]);
    const resolved = await Store.readJournal(root, Store.operationJournalPath(root, pending.operationId));
    assert.equal(resolved.snapshotTransaction.phase, 'committed');
    assert.equal(resolved.terminalOutcome, 'verified-complete');
    const terminalBytes = await fsp.readFile(Store.operationJournalPath(root, pending.operationId));
    assert.deepEqual(await Store.recoverSnapshotTransactions(root, claimed.lock, pending.operationId), [
      { operationId: pending.operationId, action: 'already-committed', generation: current.generation },
    ], 'repeat resolution reports the already-verified terminal state instead of appearing to perform no check');
    assert.deepEqual(await fsp.readFile(Store.operationJournalPath(root, pending.operationId)), terminalBytes,
      'repeat resolution leaves the original terminal journal unchanged');
    assert.equal((await fsp.readdir(path.join(root, '.project-state', 'operations'))).filter((file) => file.endsWith('.json')).length, 2,
      'resolution writes neither a replacement journal identity nor duplicate terminal record');
  } finally { await claimed.lock.release(); }
  assert.equal((await Store.validateSnapshot(root, name, { mode: 'restore' })).generation, current.generation);
});

test('snapshot recovery reconciles a killed terminal operation-journal temp', async (t) => {
  const root = await project(t);
  const name = 'snapshot-journal-temp-kill';
  const marker = path.join(os.tmpdir(), `project-state-snapshot-journal-temp-${path.basename(root)}.marker`);
  const cli = process.env.PROJECT_STATE_CLI || path.resolve(__dirname, '..', 'bin', 'project-state.js');
  const childCode = `const fs=require('node:fs');const real=fs.promises.rename.bind(fs.promises);fs.promises.rename=async(from,to,...args)=>{if(String(to).endsWith('.json')&&String(from).includes('operations')&&String(from).endsWith('.tmp')){let data;try{data=JSON.parse(fs.readFileSync(from,'utf8'))}catch{}if(data?.operation==='snapshot'&&data?.terminalOutcome==='verified-complete'&&data?.snapshotTransaction?.phase==='committed'){fs.writeFileSync(${JSON.stringify(marker)},data.operationId);setInterval(()=>{},1000);await new Promise(()=>{})}}return real(from,to,...args)};process.argv=[process.execPath,${JSON.stringify(cli)},'snapshot',${JSON.stringify(name)}];require(${JSON.stringify(cli)});`;
  let child;
  try {
    child = spawn(process.execPath, ['-e', childCode], { cwd: root, stdio: 'ignore' });
    const closed = new Promise((resolve) => child.once('close', (_code, signal) => resolve(signal)));
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(marker), 'child stopped after terminal journal temp creation and pointer commit');
    const operationId = fs.readFileSync(marker, 'utf8').trim();
    child.kill();
    assert.equal(await closed, 'SIGTERM');
    const operations = path.join(root, '.project-state', 'operations');
    assert.equal((await fsp.readdir(operations)).filter((entry) => entry.startsWith(`${operationId}.json.`) && entry.endsWith('.tmp')).length, 1);
    const recovered = execFileSync(process.execPath, [cli, 'recover', operationId, '--compensate', '--yes'], { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.match(recovered, /already-committed/i);
    assert.equal((await fsp.readdir(operations)).some((entry) => entry.startsWith(`${operationId}.json.`) && entry.endsWith('.tmp')), false);
    const journal = await Store.readJournal(root, Store.operationJournalPath(root, operationId));
    assert.equal(journal.terminalOutcome, 'verified-complete');
    assert.equal((await Store.validateSnapshot(root, name, { mode: 'restore' })).generation, journal.snapshotTransaction.generation);
    assert.equal(await Store.isGenerationProtected(root, name, journal.snapshotTransaction.generation), false, 'a reconciled terminal snapshot has no orphan-temp prune barrier');
  } finally {
    if (child && child.exitCode === null) child.kill();
    try { fs.unlinkSync(marker); } catch {}
  }
});

test('a terminal snapshot journal transition survives resolver termination before claim release', async (t) => {
  const root = await project(t);
  const name = 'snapshot-terminal-transition-kill';
  const originalMarker = path.join(os.tmpdir(), `snapshot-terminal-original-${path.basename(root)}.marker`);
  const resolverMarker = path.join(os.tmpdir(), `snapshot-terminal-resolver-${path.basename(root)}.marker`);
  const cli = process.env.PROJECT_STATE_CLI || path.resolve(__dirname, '..', 'bin', 'project-state.js');
  const originalCode = `const fs=require('node:fs'),path=require('node:path'),p=fs.promises,rename=p.rename.bind(p),marker=${JSON.stringify(originalMarker)},cli=${JSON.stringify(cli)};p.rename=async(from,to,...args)=>{if(String(from).includes(path.join('.project-state','operations'))&&String(from).endsWith('.tmp')&&String(to).endsWith('.json')){let j;try{j=JSON.parse(fs.readFileSync(from,'utf8'))}catch{}if(j?.operation==='snapshot'&&j.terminalOutcome==='verified-complete'&&j.snapshotTransaction?.phase==='committed'){fs.writeFileSync(marker,j.operationId);setInterval(()=>{},1000);await new Promise(()=>{})}}return rename(from,to,...args)};process.argv=[process.execPath,cli,'snapshot',${JSON.stringify(name)}];require(cli);`;
  let original;
  let resolver;
  try {
    original = spawn(process.execPath, ['-e', originalCode], { cwd: root, stdio: 'ignore', windowsHide: true });
    const originalClosed = new Promise((resolve) => original.once('close', (code, signal) => resolve({ code, signal })));
    const firstDeadline = Date.now() + 30000;
    while (!fs.existsSync(originalMarker) && original.exitCode === null && Date.now() < firstDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(originalMarker), 'original snapshot reached the terminal journal-temp window');
    assert.equal(original.exitCode, null);
    assert.equal(original.kill('SIGTERM'), true);
    assert.equal((await Promise.race([originalClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('original process termination timed out')), 10000))])).signal, 'SIGTERM');
    const operationId = (await fsp.readFile(originalMarker, 'utf8')).trim();
    const resolverCode = `const fs=require('node:fs'),path=require('node:path'),p=fs.promises,rename=p.rename.bind(p),marker=${JSON.stringify(resolverMarker)},cli=${JSON.stringify(cli)},op=${JSON.stringify(operationId)};p.rename=async(from,to,...args)=>{const result=await rename(from,to,...args);if(String(from).startsWith(path.join(process.cwd(),'.project-state','operations',op+'.json.'))&&String(from).endsWith('.tmp')&&String(to)===path.join(process.cwd(),'.project-state','operations',op+'.json')){fs.writeFileSync(marker,op);setInterval(()=>{},1000);await new Promise(()=>{})}return result};process.argv=[process.execPath,cli,'recover',op,'--compensate','--yes'];require(cli);`;
    resolver = spawn(process.execPath, ['-e', resolverCode], { cwd: root, stdio: 'ignore', windowsHide: true });
    const resolverClosed = new Promise((resolve) => resolver.once('close', (code, signal) => resolve({ code, signal })));
    const secondDeadline = Date.now() + 30000;
    while (!fs.existsSync(resolverMarker) && resolver.exitCode === null && Date.now() < secondDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(resolverMarker), 'resolver merged the exact terminal temp before it was terminated');
    assert.equal(resolver.exitCode, null);
    assert.equal(resolver.kill('SIGTERM'), true);
    assert.equal((await Promise.race([resolverClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('resolver termination timed out')), 10000))])).signal, 'SIGTERM');
    const resumed = execFileSync(process.execPath, [cli, 'recover', operationId, '--compensate', '--yes'], { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.match(resumed, /already-committed/i);
    const journal = await Store.readJournal(root, Store.operationJournalPath(root, operationId));
    assert.equal(journal.terminalOutcome, 'verified-complete');
    assert.equal((await Store.validateSnapshot(root, name, { mode: 'restore' })).generation, journal.snapshotTransaction.generation);
    assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')), false, 'verified terminal recovery releases only its claimed lock');
    const ordinary = execFileSync(process.execPath, [cli, 'snapshot', 'after-terminal-transition'], { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.match(ordinary, /snapshot/i);
  } finally {
    for (const child of [original, resolver]) if (child && child.exitCode === null) child.kill('SIGTERM');
    for (const marker of [originalMarker, resolverMarker]) await fsp.rm(marker, { force: true });
  }
});

test('stale restore claim cannot move a replacement active lock', async (t) => {
  const root = await project(t);
  const name = 'auto-20261017-000012';
  const saved = await snapshotInternal(root, name, { kind: 'auto' });
  const operationId = Store.randomId();
  const setupLock = await Store.acquireOperationLock(root, { operation: 'restore', operationId });
  const pin = await Store.pinSnapshot(root, { name, generation: saved.generation, operationId, reason: 'rollback-needed' });
  await Store.writeOperationJournal(root, setupLock, {
    operationId, operation: 'restore', phase: 'applying', status: 'in-progress',
    safety: { name, generation: saved.generation, pinId: pin.pinId }, appliedTargets: [],
  });
  await setupLock.release();

  const lockDir = path.join(root, '.project-state', 'locks', 'operation.lock');
  await fsp.mkdir(lockDir, { recursive: true });
  const staleOwner = { token: Store.randomId(), root, operation: 'restore', operationId,
    pid: 2147483647, host: os.hostname(), createdAt: new Date().toISOString() };
  const ownerFile = path.join(lockDir, 'owner.json');
  await fsp.writeFile(ownerFile, JSON.stringify(staleOwner));

  const originalReadFile = fsp.readFile;
  let ownerReads = 0;
  let replacementLock = null;
  let replacementAttempted = false;
  fsp.readFile = async function (file, ...args) {
    if (path.resolve(String(file)) === path.resolve(ownerFile)) {
      ownerReads += 1;
      // In the old implementation the second read occurs after inspection and
      // can observe a new live owner, then the stale claimant renames it away.
      if (ownerReads === 2) {
        const displaced = `${lockDir}.stale-test-${Store.randomId()}`;
        await originalReadFile.call(this, ownerFile).then(async () => {
          await fsp.rename(lockDir, displaced);
          try {
            replacementLock = await Store.acquireOperationLock(root, { operation: 'restore' });
            replacementAttempted = true;
          } catch (error) {
            replacementAttempted = true;
            if (error.code !== 'ELOCKED') throw error;
            await fsp.rename(displaced, lockDir);
          }
        });
      }
    }
    return originalReadFile.call(this, file, ...args);
  };
  let claimed;
  try {
    claimed = await Store.claimInterruptedRestore(root, operationId);
  } finally { fsp.readFile = originalReadFile; }
  assert.equal(replacementAttempted, true, 'test reached the stale-owner replacement race window');
  assert.ok(claimed.lock, 'the original interrupted operation is claimed');
  if (replacementLock) {
    await assert.doesNotReject(Store.assertLock(root, replacementLock), 'the replacement live owner must remain authenticated');
    await replacementLock.release();
  }
  await claimed.lock.release();
});

test('only one interrupted claimant wins while an ordinary lock request remains excluded', async (t) => {
  const root = await project(t);
  const name = 'auto-20261017-000014';
  const saved = await snapshotInternal(root, name, { kind: 'auto' });
  const operationId = Store.randomId();
  const setupLock = await Store.acquireOperationLock(root, { operation: 'restore', operationId });
  const pin = await Store.pinSnapshot(root, { name, generation: saved.generation, operationId, reason: 'rollback-needed' });
  await Store.writeOperationJournal(root, setupLock, {
    operationId, operation: 'restore', phase: 'applying', status: 'in-progress',
    safety: { name, generation: saved.generation, pinId: pin.pinId }, appliedTargets: [],
  });
  await setupLock.release();
  const lockDir = path.join(root, '.project-state', 'locks', 'operation.lock');
  await fsp.mkdir(lockDir, { recursive: true });
  await fsp.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
    token: Store.randomId(), root, operation: 'restore', operationId,
    pid: 2147483647, host: os.hostname(), createdAt: new Date().toISOString(),
  }));

  const results = await Promise.allSettled([
    Store.claimInterruptedRestore(root, operationId),
    Store.claimInterruptedRestore(root, operationId),
    Store.acquireOperationLock(root, { operation: 'snapshot' }),
  ]);
  const winners = results.filter((result) => result.status === 'fulfilled');
  const losers = results.filter((result) => result.status === 'rejected');
  assert.equal(winners.length, 1, 'exactly one restore claimant or ordinary operation can own the critical section');
  assert.equal(losers.length, 2);
  assert.ok(losers.every((result) => result.reason.code === 'ELOCKED'),
    `losers are controlled conflicts, not filesystem errors: ${losers.map((result) => result.reason.code).join(', ')}`);
  const winner = winners[0].value;
  const liveLock = winner.lock || winner;
  await assert.doesNotReject(Store.assertLock(root, liveLock), 'the winning authenticated operation lock remains live');
  if (winner.lock) await winner.lock.release();
  else await winner.release();
});

test('verified-complete journals no longer protect a released generation', async (t) => {
  const root = await project(t);
  const name = 'auto-20261017-000013';
  const saved = await snapshotInternal(root, name, { kind: 'auto' });
  const lock = await Store.acquireOperationLock(root, { operation: 'restore' });
  try {
    await Store.writeOperationJournal(root, lock, {
      operationId: lock.operationId, operation: 'restore', phase: 'completed', status: 'completed',
      terminalOutcome: 'verified-complete', snapshot: { name, generation: saved.generation },
      safetyPins: [{ name, generation: saved.generation, pinId: Store.randomId() }],
    });
    assert.equal(await Store.isGenerationProtected(root, name, saved.generation), false,
      'a verified terminal reference without a persistent pin is no longer an unresolved protection');
  } finally { await lock.release(); }
});

test('a killed snapshot process during staging can be claimed and resolved without publishing partial files', async (t) => {
  const root = await project(t);
  const name = 'auto-20261017-000007';
  const old = await snapshotInternal(root, name, { kind: 'auto',
    extraArtifacts: [{ layer: 'rollback', kind: 'file', target: '.env', content: Buffer.from('STAGING_OLD') }],
  });
  const child = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const { snapshotInternal } = require('./lib/snapshot');
    const fsp = fs.promises;
    const writeFile = fsp.writeFile.bind(fsp);
    fsp.writeFile = async (file, ...args) => {
      const result = await writeFile(file, ...args);
      if (String(file).includes(path.join('.project-state', 'staging')) && String(file).includes(path.join('public', 'files'))) {
        process.stderr.write('KILLPOINT:staging-file-written\n');
        process.kill(process.pid, 'SIGKILL');
        process.stderr.write('AFTER_KILL:process-survived\n');
        await new Promise(() => {});
      }
      return result;
    };
    snapshotInternal(process.argv[1], process.argv[2], { kind: 'auto', overwrite: true })
      .catch((error) => { process.stderr.write('CHILD_ERROR:' + String(error.stack || error)); process.exitCode = 1; });
  `;
  let termination;
  try {
    execFileSync(process.execPath, ['-e', child, root, name], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000 });
  } catch (error) { termination = error; }
  assert.ok(termination, 'child must be terminated during staging');
  assert.notEqual(termination.status, 0, `child must not exit normally: ${termination.stderr || ''}`);
  assert.match(String(termination.stderr || ''), /KILLPOINT:staging-file-written/);
  assert.doesNotMatch(String(termination.stderr || ''), /AFTER_KILL|CHILD_ERROR/);
  const operations = path.join(root, '.project-state', 'operations');
  const files = await fsp.readdir(operations);
  const journals = await Promise.all(files.map((file) => Store.readJournal(root, path.join(operations, file))));
  const pending = journals.find((journal) => journal.status === 'in-progress' && !journal.terminalOutcome && journal.snapshotTransaction?.phase === 'staging');
  assert.ok(pending, `staging phase is durably journaled before collector writes begin: ${JSON.stringify(journals.map(({ operationId, status, terminalOutcome, snapshotTransaction }) => ({ operationId, status, terminalOutcome, snapshotTransaction })))}`);
  const inspected = await Store.inspectInterruptedSnapshot(root, pending.operationId);
  assert.equal(inspected.action, 'not-published');
  assert.equal(inspected.currentGeneration, old.generation);
  const claimed = await Store.claimInterruptedSnapshot(root, pending.operationId);
  try {
    const recovered = await Store.recoverSnapshotTransactions(root, claimed.lock, pending.operationId);
    assert.deepEqual(recovered, [{ operationId: pending.operationId, action: 'preserved-current', generation: old.generation }]);
    const resolved = await Store.readJournal(root, Store.operationJournalPath(root, pending.operationId));
    assert.equal(resolved.snapshotTransaction.phase, 'failed-rolled-back');
    assert.equal(resolved.terminalOutcome, 'failed-rolled-back');
  } finally { await claimed.lock.release(); }
  const current = await Store.validateSnapshot(root, name, { mode: 'restore' });
  assert.equal(current.generation, old.generation);
  assert.equal(await fsp.readFile(current.artifacts.find((item) => item.target === '.env').absolutePath, 'utf8'), 'STAGING_OLD');
  assert.deepEqual(await Store.listSnapshots(root), [name], 'partial staging is not advertised as a snapshot');
});

test('interrupted snapshot claim refuses an active owner and preserves its lock and journal', async (t) => {
  const root = await project(t);
  const operationId = Store.randomId();
  const lock = await Store.acquireOperationLock(root, { operation: 'snapshot', operationId });
  try {
    await Store.beginSnapshotTransaction(root, lock, { name: 'auto-20261017-000008', generation: Store.randomId(), previousGeneration: null });
    const beforeOwner = await fsp.readFile(path.join(root, '.project-state', 'locks', 'operation.lock', 'owner.json'));
    const inspected = await Store.inspectInterruptedSnapshot(root, operationId);
    assert.equal(inspected.alive, true);
    assert.equal(inspected.action, 'not-published');
    await assert.rejects(Store.claimInterruptedSnapshot(root, operationId), (error) => error.code === 'ELOCKED');
    const afterOwner = await fsp.readFile(path.join(root, '.project-state', 'locks', 'operation.lock', 'owner.json'));
    assert.deepEqual(afterOwner, beforeOwner, 'active lock owner record is untouched');
    const journal = await Store.readJournal(root, Store.operationJournalPath(root, operationId));
    assert.equal(journal.snapshotTransaction.phase, 'staging');
    const resolved = await Store.recoverSnapshotTransactions(root, lock);
    assert.deepEqual(resolved, [{ operationId, action: 'preserved-current', generation: null }]);
  } finally { await lock.release(); }
});

test('unscoped snapshot recovery refuses a foreign unresolved journal without rewriting either operation', async (t) => {
  const root = await project(t);
  const operationA = Store.randomId();
  const lockA = await Store.acquireOperationLock(root, { operation: 'snapshot', operationId: operationA });
  await Store.beginSnapshotTransaction(root, lockA, {
    name: 'auto-20261017-000009', generation: Store.randomId(), previousGeneration: null,
  });
  await lockA.release();
  const journalAPath = Store.operationJournalPath(root, operationA);
  const bytesA = await fsp.readFile(journalAPath);

  const lockB = await Store.acquireOperationLock(root, { operation: 'snapshot' });
  try {
    await Store.beginSnapshotTransaction(root, lockB, {
      name: 'auto-20261017-000010', generation: Store.randomId(), previousGeneration: null,
    });
    const journalBPath = Store.operationJournalPath(root, lockB.operationId);
    const bytesBBefore = await fsp.readFile(journalBPath);
    await assert.rejects(Store.recoverSnapshotTransactions(root, lockB), (error) => error.code === 'ELOCKED');
    assert.deepEqual(await fsp.readFile(journalAPath), bytesA, 'foreign operation A journal remains byte-identical');
    assert.deepEqual(await fsp.readFile(journalBPath), bytesBBefore, 'operation B journal is not replaced or falsely completed');
    const journalB = await Store.readJournal(root, journalBPath);
    assert.equal(journalB.snapshotTransaction.phase, 'staging');
    assert.equal(journalB.terminalOutcome, undefined);
  } finally { await lockB.release(); }
});

test('retire only removes unpinned current auto generations', async (t) => {
  const root = await project(t);
  const name = 'auto-20261017-123456';
  const saved = await snapshotInternal(root, name, { kind: 'auto' });
  const lock = await Store.acquireOperationLock(root, { operation: 'prune' });
  try {
    const checked = await Store.validateSnapshot(root, name, { mode: 'restore' });
    await Store.beginPruneTransaction(root, lock, [{ name, generation: saved.generation, kind: 'auto', createdAt: checked.manifest.createdAt }]);
    await assert.rejects(Store.retireSnapshot(root, lock, { name, generation: saved.generation, expectedKind: 'named' }), (error) => error.code === 'ERETIRE_REFUSED');
    const pin = await Store.pinSnapshot(root, { name, generation: saved.generation, operationId: lock.operationId, reason: 'manual' });
    await assert.rejects(Store.retireSnapshot(root, lock, { name, generation: saved.generation, expectedKind: 'auto' }), (error) => error.code === 'EPIN_INVALID');
    await fsp.unlink(pin.path);
    const retired = await Store.retireSnapshot(root, lock, { name, generation: saved.generation, expectedKind: 'auto' });
    assert.equal(retired.retired, true);
    await assert.rejects(Store.validateSnapshot(root, name, { mode: 'restore' }), (error) => error.code === 'ESNAPSHOT_MISSING');
  } finally { await lock.release(); }
});
