'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const Store = require(process.env.PROJECT_STATE_STORAGE || '../lib/storage');
const { snapshotInternal } = require(process.env.PROJECT_STATE_SNAPSHOT || '../lib/snapshot');
const { restoreInternal } = require(process.env.PROJECT_STATE_RESTORE || '../lib/restore');
const CLI = path.resolve(__dirname, '..', 'bin', 'project-state.js');
const CLI_PATH = process.env.PROJECT_STATE_CLI || CLI;
const NODE = process.execPath;

function git(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function cli(root, args) { return spawnSync(NODE, [CLI_PATH, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 }); }
function delay(ms) { return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }); }

async function waitForFile(file, child, stdout, stderr, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !fs.existsSync(file) && child.exitCode === null) await delay(20);
  assert.ok(fs.existsSync(file), `child missed killpoint; exit=${child.exitCode}; stdout=${stdout()}; stderr=${stderr()}`);
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

async function terminateAt(handle, marker) {
  const child = handle.child;
  await waitForFile(marker, child, handle.out, handle.err);
  assert.equal(child.exitCode, null, 'process must still be alive at the registered killpoint');
  assert.equal(child.kill('SIGTERM'), true, 'test must actually terminate the child');
  const result = await Promise.race([handle.closed, delay(10000).then(() => { throw new Error('child termination timed out'); })]);
  assert.ok(result.signal || result.code !== null, 'registered close listener observed actual child termination');
  return result;
}

async function project(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-state-claim-protocol-'));
  await fsp.writeFile(path.join(root, '.gitignore'), '.project-state/\n.env.local\n');
  await fsp.writeFile(path.join(root, 'state.txt'), 'before\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'claim-test@example.invalid']);
  git(root, ['config', 'user.name', 'Claim Protocol Test']);
  git(root, ['add', '.gitignore', 'state.txt']);
  git(root, ['commit', '-qm', 'base']);
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function interruptedRestore(t, { terminalCleanup = false } = {}) {
  const root = await project(t);
  const saved = await snapshotInternal(root, terminalCleanup ? 'cleanup-source' : 'auto-20261018-000011', { kind: terminalCleanup ? 'named' : 'auto' });
  const snapshotName = saved.manifest.name;
  const operationId = Store.randomId();
  const lock = await Store.acquireOperationLock(root, { operation: 'restore', operationId });
  const ownerFile = path.join(root, '.project-state', 'locks', 'operation.lock', 'owner.json');
  const owner = JSON.parse(await fsp.readFile(ownerFile, 'utf8'));
  const pin = await Store.pinSnapshot(root, { name: snapshotName, generation: saved.generation, operationId, reason: 'rollback-needed' });
  await Store.writeOperationJournal(root, lock, {
    operationId, operation: 'restore', phase: terminalCleanup ? 'completed' : 'applying',
    status: terminalCleanup ? 'completed' : 'in-progress',
    ...(terminalCleanup ? { terminalOutcome: 'verified-complete', cleanupPending: [
      { kind: 'release-restore-target-pin', name: snapshotName, generation: saved.generation, pinId: pin.pinId, reason: 'pending' },
    ] } : { safety: { name: snapshotName, generation: saved.generation, pinId: pin.pinId }, appliedTargets: [] }),
  });
  await lock.release();
  const lockDir = path.dirname(ownerFile);
  await fsp.mkdir(lockDir, { recursive: true });
  owner.pid = 2147483647;
  await fsp.writeFile(ownerFile, JSON.stringify(owner));
  if (terminalCleanup) await fsp.rm(ownerFile, { force: true });
  return { root, operationId, saved, pin };
}

async function realInterruptedRestore(t) {
  const root = await project(t);
  await fsp.writeFile(path.join(root, '.env.local'), 'TOKEN=before\n');
  const saved = await snapshotInternal(root, 'restore-source', { kind: 'named' });
  await fsp.writeFile(path.join(root, '.env.local'), 'TOKEN=after\n');
  await fsp.writeFile(path.join(root, 'state.txt'), 'after\n');
  git(root, ['add', 'state.txt']); git(root, ['commit', '-qm', 'advance before restore']);
  const preRestore = {
    head: git(root, ['rev-parse', 'HEAD']),
    index: git(root, ['write-tree']),
    refs: git(root, ['for-each-ref', '--format=%(refname) %(objectname)']),
    headMode: git(root, ['symbolic-ref', '-q', 'HEAD']),
  };
  const marker = path.join(os.tmpdir(), `interrupted-restore-${Store.randomId()}.json`);
  const code = `const fs=require('fs'),path=require('path'),real=fs.promises.link.bind(fs.promises),marker=${JSON.stringify(marker)},cli=${JSON.stringify(CLI_PATH)},name=${JSON.stringify(saved.manifest.name)};fs.promises.link=async(from,to,...args)=>{const result=await real(from,to,...args);if(String(from).includes(path.join('.project-state','staging'))&&path.basename(String(to))==='.env.local'){const owner=JSON.parse(fs.readFileSync(path.join(process.cwd(),'.project-state','locks','operation.lock','owner.json'),'utf8'));fs.writeFileSync(marker,JSON.stringify({pid:process.pid,operationId:owner.operationId,target:String(to)}));setInterval(()=>{},1000);await new Promise(()=>{})}return result};process.argv=[process.execPath,cli,'restore',name,'--yes'];require(cli);`;
  const child = spawnChild(root, code);
  const stopped = await terminateAt(child, marker);
  assert.equal(stopped.signal, 'SIGTERM');
  const event = JSON.parse(await fsp.readFile(marker, 'utf8'));
  const journal = await Store.readJournal(root, Store.operationJournalPath(root, event.operationId));
  assert.equal(journal.status, 'in-progress');
  assert.equal(await fsp.readFile(path.join(root, '.env.local'), 'utf8'), 'TOKEN=before\n');
  await fsp.rm(marker, { force: true });
  return {
    root, operationId: event.operationId, saved, pin: journal.safety,
    preRestoreGit: preRestore.head, preRestoreIndex: preRestore.index,
    preRestoreRefs: preRestore.refs, preRestoreHeadMode: preRestore.headMode,
  };
}

function childSource(marker, gate, operationId, mode) {
  return `
    const fs=require('node:fs'),path=require('node:path'),Store=require(${JSON.stringify(process.env.PROJECT_STATE_STORAGE || path.resolve(__dirname,'../lib/storage'))});
    const p=fs.promises,read=p.readFile.bind(p),write=p.writeFile.bind(p),rename=p.rename.bind(p);let claimOwnerReads=0;
    const marker=${JSON.stringify(marker)},gate=${JSON.stringify(gate)},observedMarker=marker+'.observed',observedGate=gate+'.observed',op=${JSON.stringify(operationId)},mode=${JSON.stringify(mode)};
    async function wait(file,release){fs.writeFileSync(file,JSON.stringify({pid:process.pid,mode,op}));while(!fs.existsSync(release))await new Promise(r=>setTimeout(r,10));}
    p.readFile=async function(file,...args){const b=await read(file,...args);if(String(file).endsWith(path.join('operation.claim','owner.json'))&&(mode==='late-reader'||mode==='winner')&&++claimOwnerReads===2){await wait(mode==='winner'?observedMarker:marker,mode==='winner'?observedGate:gate)}return b};
    p.writeFile=async function(file,data,...args){const r=await write(file,data,...args);if(String(file).endsWith(path.join('operation.claim','owner.json'))&&mode==='claim-owner')await wait();return r};
    p.rename=async function(from,to,...args){const r=await rename(from,to,...args);if((mode==='winner'||mode==='owner-published')&&String(to).endsWith(path.join('operation.lock','owner.json'))&&path.basename(String(from)).startsWith('.owner-'))await wait(marker,gate);if(mode==='claim-retired'&&String(from).endsWith('operation.claim')&&String(to).includes('.retired-'))await wait(marker,gate);return r};
    const holdClaim=()=>Store.claimInterruptedRestore(process.cwd(),op).then(async x=>{fs.writeFileSync(marker,JSON.stringify({pid:process.pid,mode,op,token:x.lock.token}));while(!fs.existsSync(gate))await new Promise(r=>setTimeout(r,10));await x.lock.release()},e=>{fs.writeFileSync(marker,JSON.stringify({pid:process.pid,mode,op,error:e.code||'ERROR',message:e.message}));});
    if(mode==='api'||mode==='winner'||mode==='late-reader')holdClaim();else {process.argv=[process.execPath,${JSON.stringify(CLI_PATH)},'recover',op,'--compensate','--yes'];require(${JSON.stringify(CLI_PATH)});}
  `;
}

function spawnChild(root, code) {
  const child = spawn(NODE, ['-e', code], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  let out = '', err = '';
  child.stdout.setEncoding('utf8').on('data', (v) => { out += v; });
  child.stderr.setEncoding('utf8').on('data', (v) => { err += v; });
  return { child, closed, out: () => out, err: () => err };
}

test('N01 stale-claim concurrency uses a single durable winner and cannot move its live claim or lock', async (t) => {
  const state = await interruptedRestore(t);
  const claimDir = path.join(state.root, '.project-state', 'locks', 'operation.claim');
  const claimMarker = path.join(os.tmpdir(), `claim-seed-${Store.randomId()}.json`);
  const seedCode = `const fs=require('fs'),path=require('path'),Store=require(${JSON.stringify(process.env.PROJECT_STATE_STORAGE || path.resolve(__dirname,'../lib/storage'))});const p=fs.promises,w=p.writeFile.bind(p),m=${JSON.stringify(claimMarker)},op=${JSON.stringify(state.operationId)};p.writeFile=async(f,d,...a)=>{const r=await w(f,d,...a);if(String(f).endsWith(path.join('operation.claim','owner.json'))){fs.writeFileSync(m,JSON.stringify({pid:process.pid,stage:'claim-owner'}));setInterval(()=>{},1000);await new Promise(()=>{})}return r};Store.claimInterruptedRestore(process.cwd(),op).catch(e=>{console.error(e);process.exitCode=2});`;
  const seed = spawnChild(state.root, seedCode);
  const seedExit = await terminateAt(seed, claimMarker);
  assert.equal(seedExit.signal, 'SIGTERM');
  const claimOwnerFile = path.join(claimDir, 'owner.json');
  const seeded = JSON.parse(await fsp.readFile(claimOwnerFile, 'utf8'));
  seeded.pid = 2147483647;
  const tokenIdentity = { schemaVersion: seeded.schemaVersion, root: seeded.root, host: seeded.host, pid: seeded.pid,
    operation: seeded.operation, targetOperationId: seeded.targetOperationId,
    originalLockToken: seeded.originalLockToken, originalLockDigest: seeded.originalLockDigest,
    journalDigest: seeded.journalDigest,
    ...(Object.hasOwn(seeded, 'resolverOperationId') ? { resolverOperationId: seeded.resolverOperationId,
      allowMissingOriginalLock: seeded.allowMissingOriginalLock } : {}),
    createdAt: seeded.createdAt };
  seeded.token = crypto.createHash('sha256').update(Buffer.from(JSON.stringify(tokenIdentity))).digest('hex').slice(0, 32);
  await fsp.writeFile(claimOwnerFile, JSON.stringify(seeded));
  const oldOwner = await fsp.readFile(claimOwnerFile);

  const markerA = path.join(os.tmpdir(), `claim-a-${Store.randomId()}.json`), gateA = `${markerA}.go`, observedA = `${markerA}.observed`, observedGateA = `${gateA}.observed`;
  const markerB = path.join(os.tmpdir(), `claim-b-${Store.randomId()}.json`), gateB = `${markerB}.go`;
  const a = spawnChild(state.root, childSource(markerA, gateA, state.operationId, 'winner'));
  const b = spawnChild(state.root, childSource(markerB, gateB, state.operationId, 'late-reader'));
  try {
    await waitForFile(observedA, a.child, a.out, a.err);
    await waitForFile(markerB, b.child, b.out, b.err);
    assert.deepEqual(await fsp.readFile(path.join(claimDir, 'owner.json')), oldOwner, 'both processes paused after observing the same dead owner');
    await fsp.writeFile(observedGateA, 'go');
    await waitForFile(markerA, a.child, a.out, a.err);
    // A is paused after the actual operation-lock owner publication. Keep it
    // there while the old observer B resumes its stale rename.
    const aState = JSON.parse(await fsp.readFile(markerA, 'utf8'));
    assert.equal(aState.mode, 'winner');
    const liveClaimBytes = await fsp.readFile(path.join(claimDir, 'owner.json'));
    const liveClaimStat = await fsp.lstat(claimDir, { bigint: true });
    const liveLockBytes = await fsp.readFile(path.join(state.root, '.project-state', 'locks', 'operation.lock', 'owner.json'));
    const liveLockStat = await fsp.lstat(path.join(state.root, '.project-state', 'locks', 'operation.lock'), { bigint: true });
    await fsp.writeFile(gateB, 'go');
    const bExit = await Promise.race([
      b.closed,
      delay(30000).then(() => { throw new Error(`late claimant timed out: ${b.out()} ${b.err()}`); }),
    ]);
    assert.notEqual(bExit.code, null);
    const afterClaim = await fsp.readFile(path.join(claimDir, 'owner.json'));
    const afterClaimStat = await fsp.lstat(claimDir, { bigint: true });
    const afterLock = await fsp.readFile(path.join(state.root, '.project-state', 'locks', 'operation.lock', 'owner.json'));
    const afterLockStat = await fsp.lstat(path.join(state.root, '.project-state', 'locks', 'operation.lock'), { bigint: true });
    assert.deepEqual(afterClaim, liveClaimBytes, 'late observer must not replace/remove the winner owner bytes');
    assert.equal(afterClaimStat.dev, liveClaimStat.dev);
    assert.equal(afterClaimStat.ino, liveClaimStat.ino);
    assert.deepEqual(afterLock, liveLockBytes, 'winner lock owner remains authenticated');
    assert.equal(afterLockStat.dev, liveLockStat.dev);
    assert.equal(afterLockStat.ino, liveLockStat.ino);
    const loser = JSON.parse(await fsp.readFile(markerB, 'utf8'));
    assert.equal(loser.error, 'ELOCKED', `${b.out()}\n${b.err()}`);
    const takeoverEntries = (await fsp.readdir(path.join(state.root, '.project-state', 'locks'))).filter((name) => name.startsWith('operation.claim.takeover-'));
    assert.equal(takeoverEntries.length, 1, 'one durable takeover fence arbitrated both stale observers');
    await fsp.writeFile(gateA, 'finish');
    const aExit = await Promise.race([
      a.closed,
      delay(30000).then(() => { throw new Error(`winner did not finish: ${a.out()} ${a.err()}`); }),
    ]);
    assert.equal(aExit.code, 0, `${a.out()}\n${a.err()}`);
  } finally {
    for (const file of [gateA, gateB, observedGateA]) await fsp.writeFile(file, 'finish').catch(() => {});
    for (const child of [a.child, b.child]) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all([a.closed, b.closed]);
    for (const file of [gateA, gateB, observedGateA, claimMarker]) await fsp.rm(file, { force: true });
  }
});

test('N02 restore resolver id is exactly linked across owner temp and published-owner interruption', async (t) => {
  for (const stage of ['owner-temp', 'owner-published']) await t.test(stage, async (st) => {
    const state = await realInterruptedRestore(st);
    const marker = path.join(os.tmpdir(), `n02-${stage}-${Store.randomId()}.json`);
    const code = `const fs=require('fs'),path=require('path'),realWrite=fs.promises.writeFile.bind(fs.promises),realRename=fs.promises.rename.bind(fs.promises),marker=${JSON.stringify(marker)},stage=${JSON.stringify(stage)};function hold(){fs.writeFileSync(marker,JSON.stringify({pid:process.pid,stage}));setInterval(()=>{},1000);return new Promise(()=>{})}fs.promises.writeFile=async(f,d,...a)=>{const r=await realWrite(f,d,...a);if(stage==='owner-temp'&&String(f).includes(path.join('operation.lock','.owner-'))&&String(f).endsWith('.tmp'))await hold();return r};fs.promises.rename=async(f,to,...a)=>{const r=await realRename(f,to,...a);if(stage==='owner-published'&&String(to).endsWith(path.join('operation.lock','owner.json'))&&path.basename(String(f)).startsWith('.owner-'))await hold();return r};process.argv=[process.execPath,${JSON.stringify(CLI_PATH)},'recover',${JSON.stringify(state.operationId)},'--compensate','--yes'];require(${JSON.stringify(CLI_PATH)});`;
    const child = spawnChild(state.root, code);
    try {
      const stopped = await terminateAt(child, marker);
      assert.equal(stopped.signal, 'SIGTERM');
      const resumed = cli(state.root, ['recover', state.operationId, '--compensate', '--yes']);
      assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
      const original = await Store.readJournal(state.root, Store.operationJournalPath(state.root, state.operationId));
      assert.equal(original.terminalOutcome, 'resolved-by-rollback');
      assert.ok(original.resolvedBy);
      const resolver = await Store.readJournal(state.root, Store.operationJournalPath(state.root, original.resolvedBy));
      assert.equal(resolver.resolvesOperationId, state.operationId);
      assert.equal(resolver.terminalOutcome, 'verified-complete');
      assert.equal(await fsp.readFile(path.join(state.root, '.env.local'), 'utf8'), 'TOKEN=after\n');
      assert.equal(git(state.root, ['status', '--porcelain']), '');
      assert.equal(git(state.root, ['rev-parse', 'HEAD']), state.preRestoreGit);
      assert.equal(git(state.root, ['write-tree']), state.preRestoreIndex);
      assert.equal(git(state.root, ['for-each-ref', '--format=%(refname) %(objectname)']), state.preRestoreRefs);
      assert.equal(git(state.root, ['symbolic-ref', '-q', 'HEAD']) || '(detached)', state.preRestoreHeadMode);
      assert.equal((await Store.listPins(state.root)).some((pin) => pin.pinId === state.pin.pinId), false);
      assert.equal(fs.existsSync(path.join(state.root, '.project-state', 'locks', 'operation.lock')), false);
    } finally { await fsp.rm(marker, { force: true }); if (child.child.exitCode === null) child.child.kill('SIGTERM'); }
  });
});

test('N02 rejects a resolver owner with a broken target-operation association', async (t) => {
  const state = await interruptedRestore(t);
  const ownerPath = path.join(state.root, '.project-state', 'locks', 'operation.lock', 'owner.json');
  const owner = JSON.parse(await fsp.readFile(ownerPath, 'utf8'));
  owner.claimToken = Store.randomId(); owner.claimedOperationId = Store.randomId(); owner.resolverOperationId = owner.operationId;
  await fsp.writeFile(ownerPath, JSON.stringify(owner));
  const result = cli(state.root, ['recover', state.operationId, '--inspect']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /claim|resolver|identity/i);
  assert.equal(fs.existsSync(ownerPath), true, 'mismatched owner evidence is retained');
});

test('restore compensation refuses a missing or incomplete original lock outside verified cleanup', async (t) => {
  for (const lockState of ['absent', 'owner-missing']) await t.test(lockState, async (st) => {
    const state = await interruptedRestore(st);
    const lockDir = path.join(state.root, '.project-state', 'locks', 'operation.lock');
    if (lockState === 'absent') await fsp.rm(lockDir, { recursive: true, force: false });
    else await fsp.rm(path.join(lockDir, 'owner.json'), { force: false });
    const journalBefore = await fsp.readFile(Store.operationJournalPath(state.root, state.operationId));
    await assert.rejects(() => Store.claimInterruptedRestore(state.root, state.operationId), { code: 'ELOCK_OWNER' });
    assert.deepEqual(await fsp.readFile(Store.operationJournalPath(state.root, state.operationId)), journalBefore);
    assert.equal((await Store.listPins(state.root)).some((pin) => pin.pinId === state.pin.pinId), true);
    assert.equal(fs.existsSync(path.join(state.root, '.project-state', 'locks', 'operation.claim')), false);
    if (lockState === 'owner-missing') assert.equal(fs.existsSync(lockDir), true, 'incomplete lock directory is preserved');
  });
});

test('N03 no-original-lock cleanup claim interruption is resumable and preserves unrelated pins', async (t) => {
  const root = await project(t);
  const saved = await snapshotInternal(root, 'cleanup-source', { kind: 'named' });
  const snapshotName = saved.manifest.name;
  await fsp.writeFile(path.join(root, 'state.txt'), 'after\n');
  git(root, ['add', 'state.txt']); git(root, ['commit', '-qm', 'after']);
  const unrelated = await snapshotInternal(root, 'auto-20261018-000010', { kind: 'auto' });
  const unrelatedPin = await Store.pinSnapshot(root, { name: unrelated.manifest.name, generation: unrelated.generation, operationId: Store.randomId(), reason: 'rollback-needed' });
  const realCompleteCleanup = Store.completeCleanupAction;
  let injected = false;
  Store.completeCleanupAction = async (...args) => {
    if (!injected) { injected = true; throw Object.assign(new Error('injected cleanup failure'), { code: 'EACCES' }); }
    return realCompleteCleanup(...args);
  };
  let restored;
  try { restored = await restoreInternal(root, snapshotName, { yes: true }); }
  finally { Store.completeCleanupAction = realCompleteCleanup; }
  assert.ok(injected);
  assert.equal(restored.status, 'restored-verified');
  assert.ok(restored.cleanupPending?.length);
  const operationId = restored.operationId;
  assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')), false, 'verified restore released its original lock');
  const marker = path.join(os.tmpdir(), `n03-cleanup-${Store.randomId()}.json`);
  const code = `const fs=require('fs'),path=require('path'),w=fs.promises.writeFile.bind(fs.promises),marker=${JSON.stringify(marker)};fs.promises.writeFile=async(f,d,...a)=>{const r=await w(f,d,...a);if(String(f).endsWith(path.join('operation.claim','owner.json'))){fs.writeFileSync(marker,JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);await new Promise(()=>{})}return r};process.argv=[process.execPath,${JSON.stringify(CLI_PATH)},'recover',${JSON.stringify(operationId)},'--cleanup','--yes'];require(${JSON.stringify(CLI_PATH)});`;
  const child = spawnChild(root, code);
  try {
    const stopped = await terminateAt(child, marker);
    assert.equal(stopped.signal, 'SIGTERM');
    assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')), false);
    const retried = cli(root, ['recover', operationId, '--cleanup', '--yes']);
    assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.deepEqual((await Store.readJournal(root, Store.operationJournalPath(root, operationId))).cleanupPending, []);
    const repeated = cli(root, ['recover', operationId, '--cleanup', '--yes']);
    assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
    assert.match(`${repeated.stdout}\n${repeated.stderr}`, /no pending cleanup; no changes made/i,
      'repeating a completed cleanup is an explicit idempotent no-op');
    assert.ok((await Store.listPins(root)).some((pin) => pin.pinId === unrelatedPin.pinId), 'unrelated operation pin remains owned and present');
    const ordinary = cli(root, ['snapshot', 'after-no-lock-cleanup']);
    assert.equal(ordinary.status, 0, `${ordinary.stdout}\n${ordinary.stderr}`);
  } finally { Store.completeCleanupAction = realCompleteCleanup; await fsp.rm(marker, { force: true }); if (child.child.exitCode === null) child.child.kill('SIGTERM'); }
});

test('N03 cleanup resumes after resolver lock publication, claim release and pending-journal publication', async (t) => {
  for (const killpoint of ['resolver-owner-written', 'claim-released', 'cleanup-journal-published']) await t.test(killpoint, async (st) => {
    const root = await project(st);
    const saved = await snapshotInternal(root, 'cleanup-source', { kind: 'named' });
    await fsp.writeFile(path.join(root, 'state.txt'), 'after\n');
    git(root, ['add', 'state.txt']); git(root, ['commit', '-qm', 'after']);
    const unrelated = await snapshotInternal(root, 'auto-20261018-000010', { kind: 'auto' });
    const unrelatedPin = await Store.pinSnapshot(root, { name: unrelated.manifest.name, generation: unrelated.generation, operationId: Store.randomId(), reason: 'rollback-needed' });
    const realCompleteCleanup = Store.completeCleanupAction;
    let injected = false;
    Store.completeCleanupAction = async (...args) => {
      if (!injected) { injected = true; throw Object.assign(new Error('injected cleanup failure'), { code: 'EACCES' }); }
      return realCompleteCleanup(...args);
    };
    let restored;
    try { restored = await restoreInternal(root, saved.manifest.name, { yes: true }); }
    finally { Store.completeCleanupAction = realCompleteCleanup; }
    assert.ok(injected);
    assert.equal(restored.status, 'restored-verified');
    assert.ok(restored.cleanupPending?.length);
    assert.ok(restored.safety?.pinId, 'verified restore retains an exact safety-point reference');
    const operationId = restored.operationId;
    const verifiedHead = git(root, ['rev-parse', 'HEAD']);
    const verifiedIndex = git(root, ['write-tree']);
    const verifiedRefs = git(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
    const verifiedFileBytes = await fsp.readFile(path.join(root, 'state.txt'));
    const marker = path.join(os.tmpdir(), `a01-${killpoint}-${Store.randomId()}.json`);
    const gate = `${marker}.gate`;
    const code = `
      const fs=require('node:fs'),path=require('node:path'),p=fs.promises,write=p.writeFile.bind(p),rename=p.rename.bind(p);
      const marker=${JSON.stringify(marker)},gate=${JSON.stringify(gate)},point=${JSON.stringify(killpoint)},op=${JSON.stringify(operationId)},cli=${JSON.stringify(CLI_PATH)};
      const pause=async(stage)=>{fs.writeFileSync(marker,JSON.stringify({pid:process.pid,stage,operationId:op}));setInterval(()=>{},1000);await new Promise(()=>{})};
      p.writeFile=async(file,data,...args)=>{const result=await write(file,data,...args);if(point==='resolver-owner-written'&&String(file).endsWith(path.join('operation.lock','owner.json'))){const owner=JSON.parse(Buffer.from(data).toString('utf8'));if(owner.claimToken)await pause('resolver-owner-written')};return result};
      p.rename=async(from,to,...args)=>{const result=await rename(from,to,...args);if(point==='claim-released'&&String(from).endsWith('operation.claim')&&String(to).includes('.retired-'))await pause('claim-released');if(point==='cleanup-journal-published'&&String(to).endsWith(path.join('operations',op+'.json'))){const j=JSON.parse(fs.readFileSync(to,'utf8'));if(j.cleanupPending?.some(a=>a.reason==='EACCES'))await pause('cleanup-journal-published')};return result};
      if(point==='cleanup-journal-published'){const Store=require(${JSON.stringify(process.env.PROJECT_STATE_STORAGE || path.resolve(__dirname,'../lib/storage'))}),complete=Store.completeCleanupAction;let once=false;Store.completeCleanupAction=async(...args)=>{if(!once){once=true;throw Object.assign(new Error('injected cleanup failure after claim release'),{code:'EACCES'})};return complete(...args)}}
      process.argv=[process.execPath,cli,'recover',op,'--cleanup','--yes'];require(cli);
    `;
    const child = spawnChild(root, code);
    try {
      const stopped = await terminateAt(child, marker);
      assert.equal(stopped.signal, 'SIGTERM', 'child was terminated at the registered real process boundary');
      const event = JSON.parse(await fsp.readFile(marker, 'utf8'));
      assert.equal(event.stage, killpoint);
      const lockOwnerPath = path.join(root, '.project-state', 'locks', 'operation.lock', 'owner.json');
      const lockOwner = JSON.parse(await fsp.readFile(lockOwnerPath, 'utf8'));
      const claimRecords = await fsp.readdir(path.join(root, '.project-state', 'locks'));
      const retainedClaimPath = claimRecords.find((name) => name === 'operation.claim' || name.startsWith('operation.claim.retired-'));
      assert.ok(retainedClaimPath, 'claim provenance remains available to the next process');
      const retainedOwner = JSON.parse(await fsp.readFile(path.join(root, '.project-state', 'locks', retainedClaimPath, 'owner.json'), 'utf8'));
      assert.equal(lockOwner.claimToken, retainedOwner.token);
      assert.equal(retainedOwner.allowMissingOriginalLock, true);
      const retried = cli(root, ['recover', operationId, '--cleanup', '--yes']);
      assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
      assert.deepEqual(await fsp.readFile(path.join(root, 'state.txt')), verifiedFileBytes, 'business file remains byte-identical to the already-verified restore result');
      assert.equal(git(root, ['rev-parse', 'HEAD']), verifiedHead, 'cleanup does not change HEAD');
      assert.equal(git(root, ['write-tree']), verifiedIndex, 'cleanup does not change the Git index');
      assert.equal(git(root, ['for-each-ref', '--format=%(refname) %(objectname)']), verifiedRefs, 'cleanup does not move refs');
      const terminal = await Store.readJournal(root, Store.operationJournalPath(root, operationId));
      assert.deepEqual(terminal.cleanupPending, []);
      assert.equal((await Store.listPins(root)).some((pin) => pin.pinId === unrelatedPin.pinId), true, 'unrelated pin is preserved');
      assert.equal((await Store.listPins(root)).some((pin) => pin.pinId === restored.safety.pinId), true, 'rollback safety pin remains protected');
      assert.equal((await Store.validateSnapshot(root, saved.manifest.name, { mode: 'restore' })).generation, saved.generation, 'protected snapshot remains fully readable');
      assert.equal((await Store.validateSnapshot(root, restored.safety.name, { mode: 'restore' })).generation, restored.safety.generation, 'safety snapshot remains fully readable');
      assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')), false, 'successful recovery releases resolver lock');
      const ordinary = cli(root, ['snapshot', `after-${killpoint}`]);
      assert.equal(ordinary.status, 0, `${ordinary.stdout}\n${ordinary.stderr}`);
    } finally {
      await fsp.rm(marker, { force: true });
      await fsp.rm(gate, { force: true });
      if (child.child.exitCode === null) child.child.kill('SIGTERM');
    }
  });
});

test('A01 no-original-lock cleanup refuses changed claim, owner, journal and active-owner evidence', async (t) => {
  for (const mutation of ['wrong-claim-token', 'wrong-target', 'wrong-resolver', 'wrong-original-token', 'wrong-original-digest', 'foreign-owner', 'malformed-owner', 'missing-owner', 'journal-changed', 'active-owner']) await t.test(mutation, async (st) => {
    const root = await project(st);
    const saved = await snapshotInternal(root, 'cleanup-source', { kind: 'named' });
    await fsp.writeFile(path.join(root, 'state.txt'), 'after\n');
    git(root, ['add', 'state.txt']); git(root, ['commit', '-qm', 'after']);
    const unrelated = await snapshotInternal(root, 'auto-20261018-000010', { kind: 'auto' });
    const unrelatedPin = await Store.pinSnapshot(root, { name: unrelated.manifest.name, generation: unrelated.generation, operationId: Store.randomId(), reason: 'rollback-needed' });
    const complete = Store.completeCleanupAction;
    Store.completeCleanupAction = async () => { throw Object.assign(new Error('injected cleanup failure'), { code: 'EACCES' }); };
    let restored;
    try { restored = await restoreInternal(root, saved.manifest.name, { yes: true }); }
    finally { Store.completeCleanupAction = complete; }
    assert.equal(restored.status, 'restored-verified');
    assert.ok(restored.cleanupPending?.length);
    assert.ok(restored.safety?.pinId);
    const operationId = restored.operationId;
    const originalHead = git(root, ['rev-parse', 'HEAD']);
    const originalBytes = await fsp.readFile(path.join(root, 'state.txt'));
    const state = path.join(root, '.project-state');
    const marker = path.join(os.tmpdir(), `a01-refusal-${mutation}-${Store.randomId()}.json`);
    const code = `const fs=require('node:fs'),path=require('node:path'),p=fs.promises,write=p.writeFile.bind(p),marker=${JSON.stringify(marker)},op=${JSON.stringify(operationId)},cli=${JSON.stringify(CLI_PATH)};p.writeFile=async(file,data,...args)=>{const result=await write(file,data,...args);if(String(file).endsWith(path.join('operation.lock','owner.json'))){const owner=JSON.parse(Buffer.from(data).toString('utf8'));if(owner.claimToken){fs.writeFileSync(marker,JSON.stringify({pid:process.pid,claimToken:owner.claimToken}));setInterval(()=>{},1000);await new Promise(()=>{})}}return result};process.argv=[process.execPath,cli,'recover',op,'--cleanup','--yes'];require(cli);`;
    const child = spawnChild(root, code);
    const ownerFile = path.join(state, 'locks', 'operation.lock', 'owner.json');
    const claimFile = path.join(state, 'locks', 'operation.claim', 'owner.json');
    const journalFile = Store.operationJournalPath(root, operationId);
    try {
      const event = await waitForFile(marker, child.child, child.out, child.err);
      assert.ok(event.claimToken);
      if (mutation === 'active-owner') {
        const beforeOwner = await fsp.readFile(ownerFile);
        const blocked = cli(root, ['recover', operationId, '--cleanup', '--yes']);
        assert.notEqual(blocked.status, 0, `${blocked.stdout}\n${blocked.stderr}`);
        assert.match(`${blocked.stdout}\n${blocked.stderr}`, /active|running|lock/i);
        assert.deepEqual(await fsp.readFile(ownerFile), beforeOwner, 'active operation owner is not changed');
        const stopped = await terminateAt(child, marker);
        assert.equal(stopped.signal, 'SIGTERM');
        const recovered = cli(root, ['recover', operationId, '--cleanup', '--yes']);
        assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
      } else {
        const stopped = await terminateAt(child, marker);
        assert.equal(stopped.signal, 'SIGTERM');
        const owner = JSON.parse(await fsp.readFile(ownerFile, 'utf8'));
        if (mutation === 'wrong-claim-token') owner.claimToken = Store.randomId();
        else if (mutation === 'wrong-target') owner.claimedOperationId = Store.randomId();
        else if (mutation === 'wrong-resolver') owner.resolverOperationId = Store.randomId();
        else if (mutation === 'wrong-original-token') owner.originalLockToken = Store.randomId();
        else if (mutation === 'wrong-original-digest') owner.originalLockDigest = 'a'.repeat(64);
        else if (mutation === 'foreign-owner') owner.root = path.join(root, 'foreign-project');
        else if (mutation === 'malformed-owner') await fsp.writeFile(ownerFile, '{malformed resolver owner');
        else if (mutation === 'missing-owner') await fsp.unlink(ownerFile);
        else if (mutation === 'journal-changed') await fsp.appendFile(journalFile, ' ');
        if (['wrong-claim-token', 'wrong-target', 'wrong-resolver', 'wrong-original-token', 'wrong-original-digest', 'foreign-owner'].includes(mutation)) await fsp.writeFile(ownerFile, JSON.stringify(owner));
        const evidenceFile = mutation === 'journal-changed' ? journalFile : ownerFile;
        const evidenceBefore = await fsp.readFile(evidenceFile).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
        const refusal = cli(root, ['recover', operationId, '--cleanup', '--yes']);
        assert.notEqual(refusal.status, 0, `${refusal.stdout}\n${refusal.stderr}`);
        if (mutation !== 'missing-owner') assert.deepEqual(await fsp.readFile(evidenceFile), evidenceBefore, 'ambiguous owner/journal bytes are preserved');
        else assert.equal(fs.existsSync(ownerFile), false, 'missing owner is not fabricated');
        assert.equal(fs.existsSync(path.join(state, 'locks', 'operation.lock')), true, 'resolver lock evidence is retained');
        assert.equal(fs.existsSync(path.join(state, 'locks', 'operation.claim')), true, 'active claim evidence is retained');
      }
      assert.deepEqual(await fsp.readFile(path.join(root, 'state.txt')), originalBytes, 'business file remains unchanged');
      assert.equal(git(root, ['rev-parse', 'HEAD']), originalHead);
      assert.equal((await Store.listPins(root)).some((pin) => pin.pinId === unrelatedPin.pinId), true, 'unrelated pin remains');
      assert.equal((await Store.listPins(root)).some((pin) => pin.pinId === restored.safety.pinId), true, 'rollback safety pin remains protected');
      assert.equal((await Store.validateSnapshot(root, saved.manifest.name, { mode: 'restore' })).generation, saved.generation);
      assert.equal((await Store.validateSnapshot(root, restored.safety.name, { mode: 'restore' })).generation, restored.safety.generation);
    } finally {
      await fsp.rm(marker, { force: true });
      if (child.child.exitCode === null) child.child.kill('SIGTERM');
    }
  });
});

test('shared snapshot claim resumes a verified no-original-lock branch after claim-owner process death', async (t) => {
  const root = await project(t);
  const snapshotMarker = path.join(os.tmpdir(), `snapshot-no-owner-${Store.randomId()}.json`);
  const snapshotCode = `const fs=require('fs'),path=require('path'),rename=fs.promises.rename.bind(fs.promises),marker=${JSON.stringify(snapshotMarker)},cli=${JSON.stringify(CLI_PATH)};fs.promises.rename=async(from,to,...args)=>{const result=await rename(from,to,...args);if(String(from).includes(path.join('.project-state','operations'))&&String(from).endsWith('.tmp')&&String(to).endsWith('.json')){let j;try{j=JSON.parse(fs.readFileSync(to,'utf8'))}catch{}if(j?.operation==='snapshot'&&j?.snapshotTransaction?.phase==='staging'){const owner=JSON.parse(fs.readFileSync(path.join(process.cwd(),'.project-state','locks','operation.lock','owner.json'),'utf8'));fs.writeFileSync(marker,JSON.stringify({pid:process.pid,operationId:owner.operationId}));setInterval(()=>{},1000);await new Promise(()=>{})}}return result};process.argv=[process.execPath,cli,'snapshot','interrupted-snapshot'];require(cli);`;
  const snapshotChild = spawnChild(root, snapshotCode);
  const snapshotStop = await terminateAt(snapshotChild, snapshotMarker);
  assert.equal(snapshotStop.signal, 'SIGTERM');
  const operationId = JSON.parse(await fsp.readFile(snapshotMarker, 'utf8')).operationId;
  const journal = await Store.readJournal(root, Store.operationJournalPath(root, operationId));
  assert.equal(journal.snapshotTransaction.phase, 'staging');
  await fsp.rm(path.join(root, '.project-state', 'locks', 'operation.lock'), { recursive: true, force: false });
  const claimMarker = path.join(os.tmpdir(), `snapshot-claim-owner-${Store.randomId()}.json`);
  const storagePath = process.env.PROJECT_STATE_STORAGE || path.resolve(__dirname, '../lib/storage');
  const claimCode = `const fs=require('fs'),path=require('path'),Store=require(${JSON.stringify(storagePath)}),write=fs.promises.writeFile.bind(fs.promises),marker=${JSON.stringify(claimMarker)},op=${JSON.stringify(operationId)};fs.promises.writeFile=async(f,d,...a)=>{const result=await write(f,d,...a);if(String(f).endsWith(path.join('operation.claim','owner.json'))){fs.writeFileSync(marker,JSON.stringify({pid:process.pid,operationId:op}));setInterval(()=>{},1000);await new Promise(()=>{})}return result};Store.claimInterruptedSnapshot(process.cwd(),op).catch(e=>{console.error(e);process.exitCode=2});`;
  const claimChild = spawnChild(root, claimCode);
  try {
    const claimStop = await terminateAt(claimChild, claimMarker);
    assert.equal(claimStop.signal, 'SIGTERM');
    assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')), false);
    const resumed = cli(root, ['recover', operationId, '--compensate', '--yes']);
    assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.equal(fs.existsSync(path.join(root, '.project-state', 'snapshots', 'interrupted-snapshot', 'current.json')), false,
      'a not-published snapshot remains unpublished after recovery');
    const terminal = await Store.readJournal(root, Store.operationJournalPath(root, operationId));
    assert.equal(terminal.terminalOutcome, 'failed-rolled-back');
    assert.equal(terminal.snapshotTransaction.phase, 'failed-rolled-back');
    assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')), false);
    const ordinary = cli(root, ['snapshot', 'after-snapshot-claim-recovery']);
    assert.equal(ordinary.status, 0, `${ordinary.stdout}\n${ordinary.stderr}`);
  } finally {
    for (const file of [snapshotMarker, claimMarker]) await fsp.rm(file, { force: true });
    for (const child of [snapshotChild.child, claimChild.child]) if (child.exitCode === null) child.kill('SIGTERM');
  }
});

test('shared snapshot claim preserves no-original-lock provenance after resolver owner publication', async (t) => {
  const root = await project(t);
  const snapshotMarker = path.join(os.tmpdir(), `snapshot-a01-source-${Store.randomId()}.json`);
  const snapshotCode = `const fs=require('node:fs'),path=require('node:path'),p=fs.promises,rename=p.rename.bind(p),marker=${JSON.stringify(snapshotMarker)},cli=${JSON.stringify(CLI_PATH)};p.rename=async(from,to,...args)=>{const result=await rename(from,to,...args);if(String(from).includes(path.join('.project-state','operations'))&&String(from).endsWith('.tmp')&&String(to).endsWith('.json')){let j;try{j=JSON.parse(fs.readFileSync(to,'utf8'))}catch{}if(j?.operation==='snapshot'&&j.snapshotTransaction?.phase==='staging'){const owner=JSON.parse(fs.readFileSync(path.join(process.cwd(),'.project-state','locks','operation.lock','owner.json'),'utf8'));fs.writeFileSync(marker,JSON.stringify({pid:process.pid,operationId:owner.operationId}));setInterval(()=>{},1000);await new Promise(()=>{})}}return result};process.argv=[process.execPath,cli,'snapshot','a01-interrupted-snapshot'];require(cli);`;
  const snapshotChild = spawnChild(root, snapshotCode);
  const snapshotStop = await terminateAt(snapshotChild, snapshotMarker);
  assert.equal(snapshotStop.signal, 'SIGTERM');
  const operationId = JSON.parse(await fsp.readFile(snapshotMarker, 'utf8')).operationId;
  const state = path.join(root, '.project-state');
  const lockDir = path.join(state, 'locks', 'operation.lock');
  assert.equal((await Store.readJournal(root, Store.operationJournalPath(root, operationId))).snapshotTransaction.phase, 'staging');
  await fsp.rm(lockDir, { recursive: true, force: false });
  const ownerMarker = path.join(os.tmpdir(), `snapshot-a01-owner-${Store.randomId()}.json`);
  const storagePath = process.env.PROJECT_STATE_STORAGE || path.resolve(__dirname, '../lib/storage');
  const claimCode = `const fs=require('node:fs'),path=require('node:path'),p=fs.promises,write=p.writeFile.bind(p),Store=require(${JSON.stringify(storagePath)}),marker=${JSON.stringify(ownerMarker)},op=${JSON.stringify(operationId)};p.writeFile=async(file,data,...args)=>{const result=await write(file,data,...args);if(String(file).endsWith(path.join('operation.lock','owner.json'))){const owner=JSON.parse(Buffer.from(data).toString('utf8'));if(owner.claimToken){fs.writeFileSync(marker,JSON.stringify({pid:process.pid,operationId:op,claimToken:owner.claimToken}));setInterval(()=>{},1000);await new Promise(()=>{})}}return result};Store.claimInterruptedSnapshot(process.cwd(),op).catch(error=>{console.error(error);process.exitCode=2});`;
  const claimChild = spawnChild(root, claimCode);
  try {
    const claimStop = await terminateAt(claimChild, ownerMarker);
    assert.equal(claimStop.signal, 'SIGTERM');
    const currentOwner = JSON.parse(await fsp.readFile(path.join(lockDir, 'owner.json'), 'utf8'));
    assert.equal(currentOwner.claimToken, JSON.parse(await fsp.readFile(ownerMarker, 'utf8')).claimToken);
    assert.equal(currentOwner.operationId, operationId);
    const resumed = cli(root, ['recover', operationId, '--compensate', '--yes']);
    assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.equal(fs.existsSync(path.join(state, 'snapshots', 'a01-interrupted-snapshot', 'current.json')), false);
    const terminal = await Store.readJournal(root, Store.operationJournalPath(root, operationId));
    assert.equal(terminal.terminalOutcome, 'failed-rolled-back');
    assert.equal(terminal.snapshotTransaction.phase, 'failed-rolled-back');
    assert.equal(fs.existsSync(lockDir), false);
    const ordinary = cli(root, ['snapshot', 'after-snapshot-a01-recovery']);
    assert.equal(ordinary.status, 0, `${ordinary.stdout}\n${ordinary.stderr}`);
  } finally {
    for (const marker of [snapshotMarker, ownerMarker]) await fsp.rm(marker, { force: true });
    for (const child of [snapshotChild.child, claimChild.child]) if (child.exitCode === null) child.kill('SIGTERM');
  }
});

test('R01 interrupted terminal cleanup closes only its exact dead resolver lock', async (t) => {
  const state = await interruptedRestore(t, { terminalCleanup: true });
  await fsp.rm(path.join(state.root, '.project-state', 'locks', 'operation.lock'), { recursive: true, force: true });
  const safety = await snapshotInternal(state.root, 'auto-20261019-180001', { kind: 'auto' });
  const safetyPin = await Store.pinSnapshot(state.root, { name: safety.manifest.name, generation: safety.generation,
    operationId: state.operationId, reason: 'rollback-needed' });
  const journalPath = Store.operationJournalPath(state.root, state.operationId);
  const journal = await Store.readJournal(state.root, journalPath);
  journal.safety = { name: safety.manifest.name, generation: safety.generation, pinId: safetyPin.pinId };
  await fsp.writeFile(journalPath, JSON.stringify(journal));
  const businessBytes = await fsp.readFile(path.join(state.root, 'state.txt'));
  const gitBefore = { head: git(state.root, ['rev-parse', 'HEAD']), index: git(state.root, ['write-tree']),
    refs: git(state.root, ['for-each-ref', '--format=%(refname) %(objectname)']) };
  const marker = path.join(os.tmpdir(), `r01-terminal-cleanup-${Store.randomId()}.json`);
  const storagePath = process.env.PROJECT_STATE_STORAGE || path.resolve(__dirname, '../lib/storage');
  const cliPath = process.env.PROJECT_STATE_CLI || path.resolve(__dirname, '../bin/project-state.js');
  const code = `const fs=require('node:fs'),path=require('node:path'),Store=require(${JSON.stringify(storagePath)}),write=Store.writeOperationJournal.bind(Store),marker=${JSON.stringify(marker)},op=${JSON.stringify(state.operationId)},cli=${JSON.stringify(cliPath)};Store.writeOperationJournal=async(...args)=>{const result=await write(...args);const data=args[2];if(data.operationId===op&&Array.isArray(data.cleanupPending)&&data.cleanupPending.length===0){fs.writeFileSync(marker,JSON.stringify({pid:process.pid,operationId:op}));setInterval(()=>{},1000);await new Promise(()=>{})}return result};process.argv=[process.execPath,cli,'recover',op,'--cleanup','--yes'];require(cli);`;
  const child = spawn(process.execPath, ['-e', code], { cwd: state.root, stdio: 'ignore', windowsHide: true });
  const closed = new Promise((resolve) => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
  try {
    const end = Date.now() + 30000;
    while (!fs.existsSync(marker) && child.exitCode === null && Date.now() < end) await delay(20);
    assert.ok(fs.existsSync(marker), 'cleanup reached the final empty-list journal publication window');
    assert.equal(child.exitCode, null, 'child is alive at the registered kill point');
    assert.equal(child.kill('SIGTERM'), true);
    const stopped = await Promise.race([closed, delay(10000).then(() => { throw new Error('cleanup child did not terminate'); })]);
    assert.equal(stopped.signal, 'SIGTERM', 'the child was actually terminated by the test');
    assert.equal(fs.existsSync(path.join(state.root, '.project-state', 'locks', 'operation.lock')), true);
    const retry = cli(state.root, ['recover', state.operationId, '--cleanup', '--yes']);
    assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
    assert.equal(fs.existsSync(path.join(state.root, '.project-state', 'locks', 'operation.lock')), false,
      'the third CLI closes the exact dead cleanup resolver lock');
    assert.deepEqual(await fsp.readFile(path.join(state.root, 'state.txt')), businessBytes, 'cleanup recovery leaves business bytes unchanged');
    assert.equal(git(state.root, ['rev-parse', 'HEAD']), gitBefore.head, 'cleanup recovery leaves HEAD unchanged');
    assert.equal(git(state.root, ['write-tree']), gitBefore.index, 'cleanup recovery leaves the index unchanged');
    assert.equal(git(state.root, ['for-each-ref', '--format=%(refname) %(objectname)']), gitBefore.refs, 'cleanup recovery leaves refs unchanged');
    assert.equal((await Store.listPins(state.root)).some((pin) => pin.pinId === safetyPin.pinId), true, 'the safety pin remains protected');
    assert.equal((await Store.listPins(state.root)).some((pin) => pin.pinId === state.pin.pinId), false, 'only the requested cleanup pin was released');
    const ordinary = cli(state.root, ['snapshot', 'r01-after-cleanup']);
    assert.equal(ordinary.status, 0, `${ordinary.stdout}\n${ordinary.stderr}`);
    const repeated = cli(state.root, ['recover', state.operationId, '--cleanup', '--yes']);
    assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
    assert.match(repeated.stdout, /no pending cleanup/i);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await fsp.rm(marker, { force: true });
  }
});

test('R03 terminal cleanup accepts an exact original-lock claim after two real process deaths', async (t) => {
  const root = await project(t);
  const name = 'r03-cleanup-target';
  await fsp.writeFile(path.join(root, '.env.local'), 'PORT=32101\n');
  const saved = await snapshotInternal(root, name, { kind: 'named' });
  await fsp.writeFile(path.join(root, '.env.local'), 'PORT=32102\n');
  const safetyName = 'auto-20261019-192020';
  const safety = await snapshotInternal(root, safetyName, { kind: 'auto' });
  const unrelatedPin = await Store.pinSnapshot(root, { name: safetyName, generation: safety.generation,
    operationId: Store.randomId(), reason: 'manual' });
  const businessBytes = await fsp.readFile(path.join(root, 'state.txt'));
  const gitBefore = { head: git(root, ['rev-parse', 'HEAD']), index: git(root, ['write-tree']),
    refs: git(root, ['for-each-ref', '--format=%(refname) %(objectname)']) };
  const originalMarker = path.join(os.tmpdir(), `r03-original-${Store.randomId()}.json`);
  const resolverMarker = path.join(os.tmpdir(), `r03-resolver-${Store.randomId()}.json`);
  const storagePath = process.env.PROJECT_STATE_STORAGE || path.resolve(__dirname, '../lib/storage');
  const cliPath = process.env.PROJECT_STATE_CLI || path.resolve(__dirname, '../bin/project-state.js');
  const originalCode = `const fs=require('node:fs'),path=require('node:path'),Store=require(${JSON.stringify(storagePath)}),write=Store.writeOperationJournal.bind(Store),marker=${JSON.stringify(originalMarker)},cli=${JSON.stringify(cliPath)},name=${JSON.stringify(name)};Store.writeOperationJournal=async(...args)=>{const result=await write(...args);const data=args[2];if(data.operation==='restore'&&data.status==='completed'&&data.terminalOutcome==='verified-complete'&&Array.isArray(data.cleanupPending)&&data.cleanupPending.length){const owner=JSON.parse(fs.readFileSync(path.join(process.cwd(),'.project-state','locks','operation.lock','owner.json'),'utf8'));fs.writeFileSync(marker,JSON.stringify({pid:process.pid,operationId:data.operationId,ownerToken:owner.token,targetPinId:data.cleanupPending.find(a=>a.kind==='release-restore-target-pin')?.pinId,safetyPinId:data.safety?.pinId}));setInterval(()=>{},1000);await new Promise(()=>{})}return result};process.argv=[process.execPath,cli,'restore',name,'--only','config','--yes'];require(cli);`;
  const original = spawn(process.execPath, ['-e', originalCode], { cwd: root, stdio: 'ignore', windowsHide: true });
  const originalClosed = new Promise((resolve) => original.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
  let resolver;
  try {
    const endOriginal = Date.now() + 30000;
    while (!fs.existsSync(originalMarker) && original.exitCode === null && Date.now() < endOriginal) await delay(20);
    assert.ok(fs.existsSync(originalMarker), `original restore reached its durable completed journal; exit=${original.exitCode}`);
    assert.equal(original.exitCode, null, 'original process is alive at the registered interruption point');
    const first = JSON.parse(await fsp.readFile(originalMarker, 'utf8'));
    const activeOperationId = first.operationId;
    const originalOwnerPath = path.join(root, '.project-state', 'locks', 'operation.lock', 'owner.json');
    const originalOwnerBytes = await fsp.readFile(originalOwnerPath);
    assert.equal(JSON.parse(originalOwnerBytes.toString('utf8')).pid, first.pid);
    const originalJournal = await Store.readJournal(root, Store.operationJournalPath(root, activeOperationId));
    assert.equal(originalJournal.status, 'completed');
    assert.ok(originalJournal.cleanupPending.length > 0);
    assert.equal(originalJournal.safety.pinId, (await Store.listPins(root)).find((pin) => pin.reason === 'rollback-needed')?.pinId);
    assert.equal(await fsp.readFile(path.join(root, '.env.local'), 'utf8'), 'PORT=32101\n', 'the real restore committed the saved config before its process was terminated');
    assert.equal(original.kill('SIGTERM'), true);
    const originalStop = await Promise.race([originalClosed, delay(10000).then(() => { throw new Error('original restore process did not terminate'); })]);
    assert.equal(originalStop.signal, 'SIGTERM', 'the exact original owner process was terminated');

    const resolverCode = `const fs=require('node:fs'),path=require('node:path'),Store=require(${JSON.stringify(storagePath)}),write=Store.writeOperationJournal.bind(Store),marker=${JSON.stringify(resolverMarker)},op=${JSON.stringify(activeOperationId)},cli=${JSON.stringify(cliPath)};Store.writeOperationJournal=async(...args)=>{const result=await write(...args);const data=args[2];if(data.operationId===op&&Array.isArray(data.cleanupPending)&&data.cleanupPending.length===0){const owner=JSON.parse(fs.readFileSync(path.join(process.cwd(),'.project-state','locks','operation.lock','owner.json'),'utf8'));fs.writeFileSync(marker,JSON.stringify({pid:process.pid,operationId:op,claimToken:owner.claimToken,originalLockToken:owner.originalLockToken,originalLockDigest:owner.originalLockDigest}));setInterval(()=>{},1000);await new Promise(()=>{})}return result};process.argv=[process.execPath,cli,'recover',op,'--cleanup','--yes'];require(cli);`;
    resolver = spawn(process.execPath, ['-e', resolverCode], { cwd: root, stdio: 'ignore', windowsHide: true });
    const resolverClosed = new Promise((resolve) => resolver.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
    const endResolver = Date.now() + 30000;
    while (!fs.existsSync(resolverMarker) && resolver.exitCode === null && Date.now() < endResolver) await delay(20);
    assert.ok(fs.existsSync(resolverMarker), `cleanup resolver published empty cleanup journal; exit=${resolver.exitCode}`);
    assert.equal(resolver.exitCode, null, 'resolver process is alive at the registered interruption point');
    const second = JSON.parse(await fsp.readFile(resolverMarker, 'utf8'));
    assert.equal(second.originalLockToken, first.ownerToken, 'resolver retained the exact original lock token');
    assert.match(second.originalLockDigest, /^[a-f0-9]{64}$/, 'resolver retained the original owner digest');
    assert.match(second.claimToken, /^[a-f0-9]{32}$/, 'resolver lock is claim-bound');
    const originalOwnerDigest = require('node:crypto').createHash('sha256').update(originalOwnerBytes).digest('hex');
    assert.equal(second.originalLockDigest, originalOwnerDigest, 'resolver retained the digest of the exact original owner bytes');
    const secondOwner = JSON.parse(await fsp.readFile(path.join(root, '.project-state', 'locks', 'operation.lock', 'owner.json'), 'utf8'));
    assert.equal(secondOwner.pid, second.pid);
    assert.equal(secondOwner.operationId, activeOperationId);
    assert.equal(secondOwner.claimedOperationId, activeOperationId);
    assert.equal(secondOwner.resolverOperationId, activeOperationId);
    assert.equal(secondOwner.claimedOperationToken, first.ownerToken);
    assert.equal(secondOwner.claimToken, second.claimToken);
    const retainedClaimPath = path.join(root, '.project-state', 'locks', `operation.claim.retired-${second.claimToken}`, 'owner.json');
    const retainedClaimBeforeRetry = JSON.parse(await fsp.readFile(retainedClaimPath, 'utf8'));
    assert.equal(retainedClaimBeforeRetry.allowMissingOriginalLock, false);
    assert.equal(retainedClaimBeforeRetry.originalLockToken, first.ownerToken);
    assert.equal(retainedClaimBeforeRetry.originalLockDigest, originalOwnerDigest);
    assert.equal(resolver.kill('SIGTERM'), true);
    const resolverStop = await Promise.race([resolverClosed, delay(10000).then(() => { throw new Error('cleanup resolver process did not terminate'); })]);
    assert.equal(resolverStop.signal, 'SIGTERM', 'the second process was actually terminated after journal publication');

    const journalPath = Store.operationJournalPath(root, activeOperationId);
    const terminal = await Store.readJournal(root, journalPath);
    assert.deepEqual(terminal.cleanupPending, []);
    const lockDirectory = path.join(root, '.project-state', 'locks');
    const resolverOwnerPath = path.join(lockDirectory, 'operation.lock', 'owner.json');
    const resolverOwner = JSON.parse(await fsp.readFile(resolverOwnerPath, 'utf8'));
    const terminalClaimPath = path.join(lockDirectory, `operation.claim.retired-${resolverOwner.claimToken}`, 'owner.json');
    const retainedClaimBytes = await fsp.readFile(terminalClaimPath);
    const alteredClaim = JSON.parse(retainedClaimBytes.toString('utf8'));
    alteredClaim.originalLockDigest = Store.randomId().padEnd(64, '0');
    await fsp.writeFile(terminalClaimPath, JSON.stringify(alteredClaim));
    const wrongDigest = cli(root, ['recover', activeOperationId, '--cleanup', '--yes']);
    assert.notEqual(wrongDigest.status, 0, 'a claim with a changed original-lock digest is refused');
    assert.equal(fs.existsSync(path.join(lockDirectory, 'operation.lock')), true, 'refusal preserves the resolver lock');
    await fsp.writeFile(terminalClaimPath, retainedClaimBytes);
    assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')), true,
      'the interrupted cleanup resolver lock is preserved for exact third-process recovery');
    const retry = cli(root, ['recover', activeOperationId, '--cleanup', '--yes']);
    assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
    assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')), false,
      'the third CLI closes the exact original-lock resolver');
    assert.deepEqual(await fsp.readFile(path.join(root, 'state.txt')), businessBytes);
    assert.equal(git(root, ['rev-parse', 'HEAD']), gitBefore.head);
    assert.equal(git(root, ['write-tree']), gitBefore.index);
    assert.equal(git(root, ['for-each-ref', '--format=%(refname) %(objectname)']), gitBefore.refs);
    const pins = await Store.listPins(root);
    assert.equal(pins.some((pin) => pin.pinId === first.targetPinId), false, 'the cleanup action releases its exact restore-target pin');
    assert.equal(pins.some((pin) => pin.pinId === originalJournal.safety.pinId), true, 'the rollback safety pin remains protected');
    assert.equal(pins.some((pin) => pin.pinId === unrelatedPin.pinId), true, 'an unrelated manual pin remains owned and protected');
    assert.equal(cli(root, ['snapshot', 'r03-after-original-lock-cleanup']).status, 0, 'ordinary snapshots work after exact cleanup');
    const repeated = cli(root, ['recover', activeOperationId, '--cleanup', '--yes']);
    assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
    assert.match(repeated.stdout, /no pending cleanup/i);
  } finally {
    if (original.exitCode === null) original.kill('SIGTERM');
    if (resolver?.exitCode === null) resolver.kill('SIGTERM');
    await fsp.rm(originalMarker, { force: true });
    await fsp.rm(resolverMarker, { force: true });
  }
});

test('R02 a fresh resolver follows the exact persisted journal transition after process death', async (t) => {
  const root = await project(t);
  const cliPath = process.env.PROJECT_STATE_CLI || path.resolve(__dirname, '../bin/project-state.js');
  const firstMarker = path.join(os.tmpdir(), `r02-original-temp-${Store.randomId()}.json`);
  const secondMarker = path.join(os.tmpdir(), `r02-resolver-merge-${Store.randomId()}.json`);
  const name = `r02-snapshot-${Store.randomId().slice(0, 8)}`;
  const firstCode = `const fs=require('node:fs'),path=require('node:path'),p=fs.promises,rename=p.rename.bind(p),marker=${JSON.stringify(firstMarker)},cli=${JSON.stringify(cliPath)};p.rename=async(from,to,...args)=>{if(String(from).includes(path.join('.project-state','operations'))&&String(from).endsWith('.tmp')&&String(to).endsWith('.json')&&fs.existsSync(to)){let j;try{j=JSON.parse(fs.readFileSync(from,'utf8'))}catch{}if(j?.operation==='snapshot'&&j.status==='in-progress'){fs.writeFileSync(marker,JSON.stringify({pid:process.pid,operationId:j.operationId,phase:j.snapshotTransaction?.phase}));setInterval(()=>{},1000);await new Promise(()=>{})}}return rename(from,to,...args)};process.argv=[process.execPath,cli,'snapshot',${JSON.stringify(name)}];require(cli);`;
  const first = spawn(process.execPath, ['-e', firstCode], { cwd: root, stdio: 'ignore', windowsHide: true });
  const firstClosed = new Promise((resolve) => first.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
  let second;
  try {
    const end1 = Date.now() + 30000;
    while (!fs.existsSync(firstMarker) && first.exitCode === null && Date.now() < end1) await delay(20);
    assert.ok(fs.existsSync(firstMarker), `original snapshot left a real operation journal temp; child exit=${first.exitCode}`);
    assert.equal(first.exitCode, null);
    assert.equal(first.kill('SIGTERM'), true);
    const firstStop = await Promise.race([firstClosed, delay(10000).then(() => { throw new Error('original snapshot process did not terminate'); })]);
    assert.equal(firstStop.signal, 'SIGTERM');
    const operationId = JSON.parse(await fsp.readFile(firstMarker, 'utf8')).operationId;
    const secondCode = `const fs=require('node:fs'),path=require('node:path'),p=fs.promises,rename=p.rename.bind(p),marker=${JSON.stringify(secondMarker)},cli=${JSON.stringify(cliPath)},op=${JSON.stringify(operationId)};p.rename=async(from,to,...args)=>{const result=await rename(from,to,...args);if(String(from).includes(path.join('.project-state','operations'))&&String(from).startsWith(path.join(process.cwd(),'.project-state','operations',op+'.json.'))&&String(from).endsWith('.tmp')&&String(to)===path.join(process.cwd(),'.project-state','operations',op+'.json')){fs.writeFileSync(marker,JSON.stringify({pid:process.pid,operationId:op}));setInterval(()=>{},1000);await new Promise(()=>{})}return result};process.argv=[process.execPath,cli,'recover',op,'--compensate','--yes'];require(cli);`;
    second = spawn(process.execPath, ['-e', secondCode], { cwd: root, stdio: 'ignore', windowsHide: true });
    const secondClosed = new Promise((resolve) => second.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
    const end2 = Date.now() + 30000;
    while (!fs.existsSync(secondMarker) && second.exitCode === null && Date.now() < end2) await delay(20);
    assert.ok(fs.existsSync(secondMarker), 'resolver merged the exact temp into the official journal');
    assert.equal(second.exitCode, null);
    const activeRetry = cli(root, ['recover', operationId, '--compensate', '--yes']);
    assert.notEqual(activeRetry.status, 0, 'a third process refuses while the journal resolver is active');
    assert.equal(second.kill('SIGTERM'), true);
    const secondStop = await Promise.race([secondClosed, delay(10000).then(() => { throw new Error('resolver process did not terminate'); })]);
    assert.equal(secondStop.signal, 'SIGTERM');
    const lockOwner = JSON.parse(await fsp.readFile(path.join(root, '.project-state', 'locks', 'operation.lock', 'owner.json'), 'utf8'));
    const transitionPath = path.join(root, '.project-state', 'locks', `operation.claim-journal-${lockOwner.claimToken}.json`);
    const validTransition = await fsp.readFile(transitionPath);
    const originalJournalPath = Store.operationJournalPath(root, operationId);
    const validJournal = await fsp.readFile(originalJournalPath);
    for (const [field, value] of [['claimToken', Store.randomId()], ['targetOperationId', Store.randomId()], ['resolverOperationId', Store.randomId()]]) {
      const altered = JSON.parse(validTransition.toString('utf8'));
      altered[field] = value;
      await fsp.writeFile(transitionPath, JSON.stringify(altered));
      const refused = cli(root, ['recover', operationId, '--compensate', '--yes']);
      assert.notEqual(refused.status, 0, `wrong transition ${field} is rejected`);
      assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')), true, 'ambiguous lock evidence remains');
      await fsp.writeFile(transitionPath, validTransition);
    }
    await fsp.appendFile(originalJournalPath, ' ');
    const alteredJournal = cli(root, ['recover', operationId, '--compensate', '--yes']);
    assert.notEqual(alteredJournal.status, 0, 'a changed official journal is rejected against the transition digest');
    await fsp.writeFile(originalJournalPath, validJournal);
    const recovered = cli(root, ['recover', operationId, '--compensate', '--yes']);
    assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
    const journal = await Store.readJournal(root, Store.operationJournalPath(root, operationId));
    assert.equal(journal.terminalOutcome, 'failed-rolled-back');
    assert.equal(journal.snapshotTransaction.phase, 'failed-rolled-back');
    assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')), false);
    assert.equal(fs.existsSync(path.join(root, '.project-state', 'snapshots', name, 'current.json')), false,
      'pre-publication snapshot recovery does not publish the incomplete generation');
    const ordinary = cli(root, ['snapshot', 'r02-after-recovery']);
    assert.equal(ordinary.status, 0, `${ordinary.stdout}\n${ordinary.stderr}`);
  } finally {
    if (first.exitCode === null) first.kill('SIGTERM');
    if (second && second.exitCode === null) second.kill('SIGTERM');
    await fsp.rm(firstMarker, { force: true });
    await fsp.rm(secondMarker, { force: true });
  }
});

test('R02 restore journal merge is resumable by a third process with exact file and pin checks', async (t) => {
  const root = await project(t);
  await fsp.writeFile(path.join(root, '.env.local'), 'TOKEN=saved\n');
  const saved = await snapshotInternal(root, 'r02-restore-source', { kind: 'named' });
  const before = Buffer.from('TOKEN=before\n');
  await fsp.writeFile(path.join(root, '.env.local'), before);
  const cliPath = process.env.PROJECT_STATE_CLI || path.resolve(__dirname, '../bin/project-state.js');
  const firstMarker = path.join(os.tmpdir(), `r02-restore-temp-${Store.randomId()}.json`);
  const secondMarker = path.join(os.tmpdir(), `r02-restore-merge-${Store.randomId()}.json`);
  const firstCode = `const fs=require('node:fs'),path=require('node:path'),p=fs.promises,rename=p.rename.bind(p),marker=${JSON.stringify(firstMarker)},cli=${JSON.stringify(cliPath)};p.rename=async(from,to,...args)=>{if(String(from).includes(path.join('.project-state','operations'))&&String(from).endsWith('.tmp')&&String(to).endsWith('.json')&&fs.existsSync(to)){let j;try{j=JSON.parse(fs.readFileSync(from,'utf8'))}catch{}if(j?.operation==='restore'&&j.phase==='applying'){fs.writeFileSync(marker,JSON.stringify({pid:process.pid,operationId:j.operationId}));setInterval(()=>{},1000);await new Promise(()=>{})}}return rename(from,to,...args)};process.argv=[process.execPath,cli,'restore',${JSON.stringify(saved.manifest.name)},'--yes'];require(cli);`;
  const first = spawn(process.execPath, ['-e', firstCode], { cwd: root, stdio: 'ignore', windowsHide: true });
  const firstClosed = new Promise((resolve) => first.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
  let second;
  try {
    const end1 = Date.now() + 30000;
    while (!fs.existsSync(firstMarker) && first.exitCode === null && Date.now() < end1) await delay(20);
    assert.ok(fs.existsSync(firstMarker), 'original restore left an exact safety-point journal temp');
    assert.equal(first.exitCode, null);
    assert.equal(first.kill('SIGTERM'), true);
    assert.equal((await Promise.race([firstClosed, delay(10000).then(() => { throw new Error('original restore did not terminate'); })])).signal, 'SIGTERM');
    const operationId = JSON.parse(await fsp.readFile(firstMarker, 'utf8')).operationId;
    const secondCode = `const fs=require('node:fs'),path=require('node:path'),p=fs.promises,rename=p.rename.bind(p),marker=${JSON.stringify(secondMarker)},cli=${JSON.stringify(cliPath)},op=${JSON.stringify(operationId)};p.rename=async(from,to,...args)=>{const result=await rename(from,to,...args);if(String(from).startsWith(path.join(process.cwd(),'.project-state','operations',op+'.json.'))&&String(from).endsWith('.tmp')&&String(to)===path.join(process.cwd(),'.project-state','operations',op+'.json')){fs.writeFileSync(marker,JSON.stringify({pid:process.pid,operationId:op}));setInterval(()=>{},1000);await new Promise(()=>{})}return result};process.argv=[process.execPath,cli,'recover',op,'--compensate','--yes'];require(cli);`;
    second = spawn(process.execPath, ['-e', secondCode], { cwd: root, stdio: 'ignore', windowsHide: true });
    const secondClosed = new Promise((resolve) => second.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
    const end2 = Date.now() + 30000;
    while (!fs.existsSync(secondMarker) && second.exitCode === null && Date.now() < end2) await delay(20);
    assert.ok(fs.existsSync(secondMarker), `restore resolver published the legal journal temp; child exit=${second.exitCode}`);
    assert.equal(second.exitCode, null);
    assert.equal(second.kill('SIGTERM'), true);
    assert.equal((await Promise.race([secondClosed, delay(10000).then(() => { throw new Error('restore resolver did not terminate'); })])).signal, 'SIGTERM');
    const recovered = cli(root, ['recover', operationId, '--compensate', '--yes']);
    assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
    assert.deepEqual(await fsp.readFile(path.join(root, '.env.local')), before, 'third process verifies the pre-restore file bytes');
    const original = await Store.readJournal(root, Store.operationJournalPath(root, operationId));
    assert.equal(original.terminalOutcome, 'resolved-by-rollback');
    assert.ok(!(await Store.listPins(root)).some((pin) => pin.pinId === original.safety.pinId), 'resolved operation safety pin is released only after verification');
    assert.equal((await Store.validateSnapshot(root, saved.manifest.name, { mode: 'restore' })).generation, saved.generation);
  } finally {
    if (first.exitCode === null) first.kill('SIGTERM');
    if (second && second.exitCode === null) second.kill('SIGTERM');
    await fsp.rm(firstMarker, { force: true });
    await fsp.rm(secondMarker, { force: true });
  }
});
