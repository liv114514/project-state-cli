'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const Store = require('../lib/storage');
const { snapshotInternal } = require('../lib/snapshot');
const { removeTemporaryTree } = require('./helpers');

const CLI = path.resolve(__dirname, '..', 'bin', 'project-state.js');
const MARKER_PREFIX = path.join(os.tmpdir(), `project-state-r14-${process.pid}-${Date.now()}`);

async function project(t, snapshotCount = 2) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-state-prune-recovery-'));
  await fsp.writeFile(path.join(root, '.gitignore'), '.project-state/\n.env\n');
  await fsp.writeFile(path.join(root, 'package.json'), '{"name":"prune-recovery-fixture","private":true}\n');
  await fsp.writeFile(path.join(root, '.env'), 'TOKEN=R14_TEST_SECRET\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['add', '.gitignore', 'package.json'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const start = Date.now() - 120_000;
  const names = [];
  for (let index = 0; index < snapshotCount; index += 1) {
    const stamp = new Date(start + index * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const name = `auto-${stamp.slice(0, 8)}-${stamp.slice(9, 15)}`;
    names.push(name);
    await snapshotInternal(root, name, { kind: 'auto' });
  }
  const snapshots = await Promise.all(names.map(async (name) => ({
    name,
    generation: (await Store.validateSnapshot(root, name, { mode: 'restore' })).generation,
  })));
  const gitBefore = gitState(root);
  t.after(() => removeTemporaryTree(root));
  return { root, snapshots, target: snapshots[0], retained: snapshots[snapshots.length - 1], gitBefore };
}

function gitState(root) {
  const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  return {
    head: run(['rev-parse', 'HEAD']),
    branch: run(['symbolic-ref', '-q', 'HEAD']) || null,
    index: run(['write-tree']),
    refs: run(['for-each-ref', '--format=%(refname) %(objectname)']),
    status: run(['status', '--porcelain=v1', '--untracked-files=all']),
    file: fs.readFileSync(path.join(root, 'package.json')),
    secret: fs.readFileSync(path.join(root, '.env')),
  };
}

function childHook(window, marker) {
  return `
    const fs=require('node:fs');const path=require('node:path');
    const root=process.cwd(),marker=${JSON.stringify(marker)},window=${JSON.stringify(window)};
    const p=fs.promises,realRename=p.rename.bind(p),realWrite=p.writeFile.bind(p),realRm=p.rm.bind(p);
    function stop(stage){const owner=JSON.parse(fs.readFileSync(path.join(root,'.project-state','locks','operation.lock','owner.json'),'utf8'));fs.writeFileSync(marker,JSON.stringify({operationId:owner.operationId,stage}));setInterval(()=>{},1000);return new Promise(()=>{});}
    p.writeFile=async function(file,data,...args){if(window==='partial-temp'&&String(file).includes(path.join('.project-state','operations'))&&String(file).endsWith('.tmp')){const bytes=Buffer.from(data);await realWrite(file,bytes.subarray(0,Math.max(1,Math.floor(bytes.length/3))),...args);await stop('partial-journal-temp');}return realWrite(file,data,...args)};
    p.rename=async function(from,to,...args){const a=String(from),b=String(to);
      if(window.startsWith('post-temp-')&&a.includes(path.join('.project-state','operations'))&&a.endsWith('.tmp')&&b.endsWith('.json')&&fs.existsSync(b)){
        let next=null;try{next=JSON.parse(fs.readFileSync(a,'utf8'))}catch{}
        const rows=next?.pruneTransaction?.planned||[];
        const phase=window==='post-temp-retiring'?'retiring':window==='post-temp-committed'?'committed':window==='post-temp-retired'?'retired':null;
        const reached=phase?rows.some(row=>row.phase===phase):window==='post-temp-second-target'&&rows.length>1&&rows[1].phase!=='planned';
        if(reached)await stop('complete-progress-temp-before-rename:'+window);
      }
      if(window==='temp-written'&&a.includes(path.join('.project-state','operations'))&&a.endsWith('.tmp')&&b.endsWith('.json')){await stop('complete-journal-temp-before-rename');}
      if(window==='published-plan'&&a.includes(path.join('.project-state','operations'))&&a.endsWith('.tmp')&&b.endsWith('.json')){await realRename(from,to,...args);await stop('published-plan');}
      if(window==='pointer-moved'&&path.basename(a)==='current.json'&&b.includes(path.join('.project-state','secrets','.retired'))){await realRename(from,to,...args);await stop('pointer-moved');}
      if(window==='public-moved'&&a.includes(path.join('.project-state','snapshots'))&&a.includes('generations')&&path.basename(b)==='public'&&b.includes(path.join('.project-state','secrets','.retired'))){await realRename(from,to,...args);await stop('public-moved');}
      return realRename(from,to,...args)};
    p.rm=async function(target,...args){if(window==='eacces-cleanup'&&String(target).includes(path.join('.project-state','secrets','.retired'))){throw Object.assign(new Error('injected EACCES after prune commit'),{code:'EACCES'});}if((window==='commit-before-cleanup'||window==='recover-interrupted')&&String(target).includes(path.join('.project-state','secrets','.retired'))){await stop('committed-before-cleanup');}return realRm(target,...args)};
    process.argv=[process.execPath,${JSON.stringify(CLI)},'prune','--keep','1','--yes'];require(${JSON.stringify(CLI)});
  `;
}

async function killAtPruneBoundary(root, window) {
  const marker = `${MARKER_PREFIX}-${window}-${Math.random().toString(16).slice(2)}.json`;
  const child = spawn(process.execPath, ['-e', childHook(window, marker)], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 20_000;
  try {
    while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(child.exitCode, null, `child exited before the requested kill window: ${stdout}\n${stderr}`);
    assert.equal(fs.existsSync(marker), true, `child did not reach ${window}: ${stdout}\n${stderr}`);
    const stage = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(child.kill('SIGTERM'), true, 'the marked child was still running and accepted termination');
    const result = await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error(`child did not terminate after ${window}`)), 10_000))]);
    assert.ok(result.signal || result.code !== null, 'close event confirms process termination rather than natural pending execution');
    return { ...stage, close: result, stdout, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await fsp.rm(marker, { force: true });
  }
}

function cli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
}

test('S04 real child termination windows reconcile only owner-bound prune evidence in a fresh CLI', async (t) => {
  for (const window of ['partial-temp', 'temp-written', 'published-plan', 'post-temp-retiring', 'pointer-moved', 'public-moved', 'post-temp-committed', 'post-temp-retired', 'post-temp-second-target', 'commit-before-cleanup']) {
    await t.test(window, async (st) => {
      const f = await project(st, window === 'post-temp-second-target' ? 3 : 2);
      const before = gitState(f.root);
      const stopped = await killAtPruneBoundary(f.root, window);
      assert.ok(stopped.operationId, 'kill marker captures the actual operation id');
      assert.deepEqual(gitState(f.root), before, 'prune interruption leaves business files, HEAD, index and refs unchanged');
      const inspect = cli(f.root, ['recover', stopped.operationId, '--inspect']);
      if (window === 'partial-temp') {
        assert.notEqual(inspect.status, 0, `${inspect.stdout}\n${inspect.stderr}`);
        assert.match(`${inspect.stdout}\n${inspect.stderr}`, /incomplete|invalid|preserve/i);
        assert.equal((await Store.validateSnapshot(f.root, f.target.name, { mode: 'restore' })).generation, f.target.generation);
        assert.equal((await Store.validateSnapshot(f.root, f.retained.name, { mode: 'restore' })).generation, f.retained.generation);
        assert.ok(fs.existsSync(path.join(f.root, '.project-state', 'locks', 'operation.lock', 'owner.json')));
        return;
      }
      assert.equal(inspect.status, 0, `${inspect.stdout}\n${inspect.stderr}`);
      const pending = await Store.inspectInterruptedPrune(f.root, stopped.operationId);
      const journalEvidencePath = pending.temp?.path || Store.operationJournalPath(f.root, stopped.operationId);
      const inspectedJournalBytes = await fsp.readFile(journalEvidencePath);
      if (window.startsWith('post-temp-')) {
        const current = await Store.readJournal(f.root, Store.operationJournalPath(f.root, stopped.operationId));
        const candidate = JSON.parse(inspectedJournalBytes.toString('utf8'));
        assert.equal(Store.validatePruneProgression(current, candidate), true, 'a legal progress transition is accepted independently of wall-clock granularity');
        assert.equal(Store.validatePruneProgression(current, { ...candidate, updatedAt: current.updatedAt }), true, 'same-millisecond journal stamps do not erase an otherwise proven transition');
        assert.throws(() => Store.validatePruneProgression(current, { ...current, updatedAt: new Date(Date.parse(current.updatedAt) + 1000).toISOString() }), /does not prove a new legal progress transition/i, 'a newer timestamp alone does not authorize journal promotion');
      }
      const inspectAgain = cli(f.root, ['recover', stopped.operationId, '--inspect']);
      assert.equal(inspectAgain.status, 0, `${inspectAgain.stdout}\n${inspectAgain.stderr}`);
      assert.deepEqual(await fsp.readFile(journalEvidencePath), inspectedJournalBytes, 'repeated inspect is read-only');
      const row = pending.journal.pruneTransaction.planned[0];
      const paths = Store.snapshotPaths(f.root, row.name, row.generation);
      const retired = path.join(f.root, '.project-state', 'secrets', '.retired', `${stopped.operationId}-${row.name}-${row.generation}`);
      assert.equal(fs.existsSync(paths.currentFile), !['pointer-moved', 'public-moved', 'post-temp-committed', 'post-temp-retired', 'post-temp-second-target', 'commit-before-cleanup'].includes(window));
      if (window === 'pointer-moved') {
        assert.equal(fs.existsSync(paths.publicGenerationDir), true);
        assert.equal(fs.existsSync(paths.privateGenerationDir), true);
        assert.equal(fs.existsSync(path.join(retired, 'current.json')), true);
      }
      if (window === 'public-moved') {
        assert.equal(fs.existsSync(paths.publicGenerationDir), false);
        assert.equal(fs.existsSync(paths.privateGenerationDir), true);
        assert.equal(fs.existsSync(path.join(retired, 'public')), true);
      }
      if (window === 'commit-before-cleanup') {
        assert.equal(row.phase, 'committed');
        assert.equal(fs.existsSync(paths.publicGenerationDir), false);
        assert.equal(fs.existsSync(paths.privateGenerationDir), false);
        assert.equal(fs.existsSync(retired), true);
      }
      assert.match(inspect.stdout, /plan|planned|retiring|committed/i);
      const recovered = cli(f.root, ['recover', stopped.operationId, '--continue', '--yes']);
      assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
      assert.match(recovered.stdout, /continued and verified|retired/i);
      await assert.rejects(Store.validateSnapshot(f.root, f.target.name, { mode: 'restore' }), (error) => error.code === 'ESNAPSHOT_MISSING');
      assert.equal((await Store.validateSnapshot(f.root, f.retained.name, { mode: 'restore' })).generation, f.retained.generation);
      assert.deepEqual(await Store.listPins(f.root), [], 'no unrelated pin was created or released');
      assert.deepEqual(gitState(f.root), before);
      const repeated = cli(f.root, ['recover', stopped.operationId, '--continue', '--yes']);
      assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
      assert.match(repeated.stdout, /already committed and verified/i);
      const noPendingLock = cli(f.root, ['snapshot', 'after-r14-recovery']);
      assert.equal(noPendingLock.status, 0, `${noPendingLock.stdout}\n${noPendingLock.stderr}`);
      const nextPrune = cli(f.root, ['prune', '--keep', '1', '--yes']);
      assert.equal(nextPrune.status, 0, `${nextPrune.stdout}\n${nextPrune.stderr}`);
      await fsp.unlink(path.join(f.root, '.env'));
      const restore = cli(f.root, ['restore', f.retained.name, '--yes', '--force']);
      assert.equal(restore.status, 0, `${restore.stdout}\n${restore.stderr}`);
      assert.deepEqual(await fsp.readFile(path.join(f.root, '.env')), Buffer.from('TOKEN=R14_TEST_SECRET\n'), 'restore remains usable after prune resolution');
    });
  }
});

test('R14 refuses a replaced complete journal temp and preserves the target and lock evidence', async (t) => {
  const f = await project(t);
  const stopped = await killAtPruneBoundary(f.root, 'temp-written');
  const operations = path.join(f.root, '.project-state', 'operations');
  const temps = (await fsp.readdir(operations)).filter((name) => name.startsWith(`${stopped.operationId}.json.`) && name.endsWith('.tmp'));
  assert.equal(temps.length, 1);
  const temp = path.join(operations, temps[0]);
  const before = await fsp.readFile(temp);
  await fsp.writeFile(temp, '{replaced owner-bound journal temp');
  const inspect = cli(f.root, ['recover', stopped.operationId, '--inspect']);
  assert.notEqual(inspect.status, 0);
  assert.match(`${inspect.stdout}\n${inspect.stderr}`, /invalid|incomplete|preserve/i);
  assert.equal(await fsp.readFile(temp, 'utf8'), '{replaced owner-bound journal temp');
  assert.equal((await Store.validateSnapshot(f.root, f.target.name, { mode: 'restore' })).generation, f.target.generation);
  assert.equal((await Store.validateSnapshot(f.root, f.retained.name, { mode: 'restore' })).generation, f.retained.generation);
  assert.ok(before.length > 0);
});

test('S04 refuses a complete prune temp whose lock owner token does not match and preserves evidence', async (t) => {
  const f = await project(t);
  const stopped = await killAtPruneBoundary(f.root, 'temp-written');
  const lockOwner = path.join(f.root, '.project-state', 'locks', 'operation.lock', 'owner.json');
  const owner = JSON.parse(await fsp.readFile(lockOwner, 'utf8'));
  owner.token = Store.randomId();
  const changedOwnerBytes = Buffer.from(`${JSON.stringify(owner)}\n`);
  await fsp.writeFile(lockOwner, changedOwnerBytes);
  const operations = path.join(f.root, '.project-state', 'operations');
  const tempName = (await fsp.readdir(operations)).find((name) => name.startsWith(`${stopped.operationId}.json.`) && name.endsWith('.tmp'));
  assert.ok(tempName);
  const temp = path.join(operations, tempName);
  const tempBytes = await fsp.readFile(temp);
  const inspect = cli(f.root, ['recover', stopped.operationId, '--inspect']);
  assert.notEqual(inspect.status, 0, `${inspect.stdout}\n${inspect.stderr}`);
  assert.match(`${inspect.stdout}\n${inspect.stderr}`, /owner|lock|journal/i);
  assert.deepEqual(await fsp.readFile(lockOwner), changedOwnerBytes, 'mismatched owner evidence is retained byte-for-byte');
  assert.deepEqual(await fsp.readFile(temp), tempBytes, 'complete but unowned temp is retained byte-for-byte');
  assert.equal((await Store.validateSnapshot(f.root, f.target.name, { mode: 'restore' })).generation, f.target.generation);
  assert.equal((await Store.validateSnapshot(f.root, f.retained.name, { mode: 'restore' })).generation, f.retained.generation);
});

test('S04 prune recovery refuses a missing original lock and preserves the exact plan and generations', async (t) => {
  const f = await project(t);
  const stopped = await killAtPruneBoundary(f.root, 'post-temp-retiring');
  const lockDir = path.join(f.root, '.project-state', 'locks', 'operation.lock');
  const ownerPath = path.join(lockDir, 'owner.json');
  const ownerBytes = await fsp.readFile(ownerPath);
  assert.equal(JSON.parse(ownerBytes.toString('utf8')).operationId, stopped.operationId, 'the fixture started from a precisely bound original owner');
  const operations = path.join(f.root, '.project-state', 'operations');
  const journalPath = path.join(operations, `${stopped.operationId}.json`);
  const journalBytes = await fsp.readFile(journalPath);
  const tempName = (await fsp.readdir(operations)).find((name) => name.startsWith(`${stopped.operationId}.json.`) && name.endsWith('.tmp'));
  assert.ok(tempName, 'the interrupted prune has a progress temp for a published formal journal');
  const tempPath = path.join(operations, tempName);
  const tempBytes = await fsp.readFile(tempPath);
  await fsp.rm(lockDir, { recursive: true, force: false });

  const inspect = cli(f.root, ['recover', stopped.operationId, '--inspect']);
  assert.notEqual(inspect.status, 0, `${inspect.stdout}\n${inspect.stderr}`);
  const continued = cli(f.root, ['recover', stopped.operationId, '--continue', '--yes']);
  assert.notEqual(continued.status, 0, `${continued.stdout}\n${continued.stderr}`);
  assert.deepEqual(await fsp.readFile(journalPath), journalBytes, 'unowned operation journal is retained');
  assert.deepEqual(await fsp.readFile(tempPath), tempBytes, 'unowned progress evidence is retained');
  assert.equal(fs.existsSync(ownerPath), false, 'recovery does not fabricate an original lock owner');
  assert.equal(fs.existsSync(path.join(f.root, '.project-state', 'locks', 'operation.claim')), false, 'recovery does not publish a claim without original-owner proof');
  assert.equal((await Store.validateSnapshot(f.root, f.target.name, { mode: 'restore' })).generation, f.target.generation);
  assert.equal((await Store.validateSnapshot(f.root, f.retained.name, { mode: 'restore' })).generation, f.retained.generation);
  assert.deepEqual(gitState(f.root), f.gitBefore, 'prune refusal does not alter business files or Git state');
});

test('R14 refuses hardlinked duplicate journal temps and a same-name generation replacement', async (t) => {
  await t.test('hardlinked temp', async (st) => {
    const f = await project(st);
    const stopped = await killAtPruneBoundary(f.root, 'temp-written');
    const operations = path.join(f.root, '.project-state', 'operations');
    const tempName = (await fsp.readdir(operations)).find((name) => name.startsWith(`${stopped.operationId}.json.`) && name.endsWith('.tmp'));
    assert.ok(tempName);
    const alias = path.join(operations, `${stopped.operationId}.json.${Store.randomId()}.tmp`);
    await fsp.link(path.join(operations, tempName), alias);
    const inspect = cli(f.root, ['recover', stopped.operationId, '--inspect']);
    assert.notEqual(inspect.status, 0);
    assert.match(`${inspect.stdout}\n${inspect.stderr}`, /ambiguous|multiple|invalid/i);
    assert.equal(fs.existsSync(alias), true);
    assert.equal((await Store.validateSnapshot(f.root, f.target.name, { mode: 'restore' })).generation, f.target.generation);
  });
  await t.test('same-name current generation changed', async (st) => {
    const f = await project(st);
    const stopped = await killAtPruneBoundary(f.root, 'published-plan');
    const newGeneration = Store.randomId();
    const oldPaths = Store.snapshotPaths(f.root, f.target.name, f.target.generation);
    const newPaths = Store.snapshotPaths(f.root, f.target.name, newGeneration);
    await fsp.cp(oldPaths.publicGenerationDir, newPaths.publicGenerationDir, { recursive: true, errorOnExist: true });
    await fsp.cp(oldPaths.privateGenerationDir, newPaths.privateGenerationDir, { recursive: true, errorOnExist: true });
    for (const manifestPath of [newPaths.manifestFile, newPaths.privateManifestFile]) {
      const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      manifest.generation = newGeneration;
      await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const publicBytes = await fsp.readFile(newPaths.manifestFile);
    await fsp.writeFile(newPaths.currentFile, `${JSON.stringify({ schemaVersion: 1, name: f.target.name, generation: newGeneration, publicManifestSha256: Store.hash(publicBytes) }, null, 2)}\n`);
    assert.equal((await Store.validateSnapshot(f.root, f.target.name, { mode: 'restore' })).generation, newGeneration);
    await Store.validateGenerationById(f.root, f.target.name, f.target.generation);
    const inspect = cli(f.root, ['recover', stopped.operationId, '--inspect']);
    assert.notEqual(inspect.status, 0, `${inspect.stdout}\n${inspect.stderr}`);
    assert.match(`${inspect.stdout}\n${inspect.stderr}`, /pointer|changed|identity|journal/i);
    assert.equal((await Store.validateSnapshot(f.root, f.target.name, { mode: 'restore' })).generation, newGeneration);
    await Store.validateGenerationById(f.root, f.target.name, f.target.generation);
    assert.equal(fs.existsSync(path.join(f.root, '.project-state', 'locks', 'operation.lock', 'owner.json')), true);
  });
});

test('R14 EACCES after the prune commit is a cleanup retry, not a business rollback', async (t) => {
  const f = await project(t);
  const result = spawnSync(process.execPath, ['-e', childHook('eacces-cleanup', `${MARKER_PREFIX}-unused-${Math.random()}`)], { cwd: f.root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  const operations = path.join(f.root, '.project-state', 'operations');
  const files = (await fsp.readdir(operations)).filter((name) => /^[a-f0-9]{32}\.json$/.test(name));
  const pruneJournals = await Promise.all(files.map(async (name) => ({ name, journal: await Store.readJournal(f.root, path.join(operations, name)) })));
  const match = pruneJournals.find(({ journal }) => journal.operation === 'prune');
  assert.ok(match, 'the failed prune operation has a durable journal');
  const operationId = match.name.slice(0, 32);
  const journal = match.journal;
  assert.equal(journal.pruneTransaction.planned[0].phase, 'committed');
  assert.equal(journal.status, 'in-progress');
  assert.deepEqual(gitState(f.root), f.gitBefore);
  const retry = cli(f.root, ['recover', operationId, '--continue', '--yes']);
  assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
  await assert.rejects(Store.validateSnapshot(f.root, f.target.name, { mode: 'restore' }), (error) => error.code === 'ESNAPSHOT_MISSING');
  assert.equal((await Store.validateSnapshot(f.root, f.retained.name, { mode: 'restore' })).generation, f.retained.generation);
  assert.deepEqual(gitState(f.root), f.gitBefore);
});

test('R14 active owner and foreign pin prevent prune takeover without changing either owner or pin', async (t) => {
  const f = await project(t);
  // The test child is paused after plan publication. While it is live, a second
  // CLI inspection must refuse; after termination a separately owned pin must
  // still refuse the planned deletion.
  const marker = `${MARKER_PREFIX}-active-${Math.random().toString(16).slice(2)}.json`;
  const child = spawn(process.execPath, ['-e', childHook('published-plan', marker)], { cwd: f.root, windowsHide: true, stdio: 'ignore' });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 20_000;
  try {
    while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(child.exitCode, null, 'child remains alive at the plan boundary');
    const ownerBefore = fs.readFileSync(path.join(f.root, '.project-state', 'locks', 'operation.lock', 'owner.json'));
    const operationId = JSON.parse(ownerBefore.toString()).operationId;
    const activeInspect = cli(f.root, ['recover', operationId, '--inspect']);
    assert.notEqual(activeInspect.status, 0);
    assert.match(`${activeInspect.stdout}\n${activeInspect.stderr}`, /active|still running|ELOCKED/i);
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.project-state', 'locks', 'operation.lock', 'owner.json')), ownerBefore);
    assert.equal(child.kill('SIGTERM'), true);
    const termination = await closed;
    assert.ok(termination.signal || termination.code !== null);
    const externalOperationId = Store.randomId();
    const pin = await Store.pinSnapshot(f.root, { name: f.target.name, generation: f.target.generation, operationId: externalOperationId, reason: 'manual' });
    const blocked = cli(f.root, ['recover', operationId, '--continue', '--yes']);
    assert.notEqual(blocked.status, 0, `${blocked.stdout}\n${blocked.stderr}`);
    assert.match(`${blocked.stdout}\n${blocked.stderr}`, /pin|protected|EPIN_INVALID/i);
    assert.equal(fs.existsSync(pin.path), true, 'foreign operation pin remains byte-for-byte present');
    assert.equal((await Store.validateSnapshot(f.root, f.target.name, { mode: 'restore' })).generation, f.target.generation);
    await fsp.unlink(pin.path);
    const resolved = cli(f.root, ['recover', operationId, '--continue', '--yes']);
    assert.equal(resolved.status, 0, `${resolved.stdout}\n${resolved.stderr}`);
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
    await fsp.rm(marker, { force: true });
  }
});

test('R14 terminal journals require an exact completed set and verified retired generation absence', async (t) => {
  for (const forgedState of ['duplicate-completed-reference', 'retired-but-still-present', 'retired-but-still-present-no-lock']) {
    await t.test(forgedState, async (st) => {
      const f = await project(st);
      const before = gitState(f.root);
      const operationId = Store.randomId();
      const lock = await Store.acquireOperationLock(f.root, { operation: 'prune', operationId });
      try {
        const rows = await Promise.all([f.target, f.retained].map(async (snapshot) => {
          const checked = await Store.validateSnapshot(f.root, snapshot.name, { mode: 'restore' });
          return { name: snapshot.name, generation: checked.generation, kind: checked.manifest.kind, createdAt: checked.manifest.createdAt };
        }));
        await Store.beginPruneTransaction(f.root, lock, rows);
        const file = Store.operationJournalPath(f.root, operationId);
        const journal = await Store.readJournal(f.root, file);
        const planned = journal.pruneTransaction.planned.map((row) => ({ ...row, phase: 'retired' }));
        const completed = forgedState === 'duplicate-completed-reference'
          ? [{ name: planned[0].name, generation: planned[0].generation }, { name: planned[0].name, generation: planned[0].generation }]
          : planned.map(({ name, generation }) => ({ name, generation }));
        journal.status = 'completed';
        journal.phase = 'completed';
        journal.terminalOutcome = 'verified-complete';
        journal.pruneTransaction = { ...journal.pruneTransaction, phase: 'completed', planned, completed };
        await fsp.writeFile(file, `${JSON.stringify(journal, null, 2)}\n`);
        if (forgedState.endsWith('-no-lock')) await lock.release();

        const result = cli(f.root, ['recover', operationId, '--continue', '--yes']);
        assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /already committed and verified/i);
        if (forgedState === 'duplicate-completed-reference') {
          await assert.rejects(Store.readJournal(f.root, file), (error) => error.code === 'EJOURNAL_INVALID');
        } else {
          assert.match(`${result.stdout}\n${result.stderr}`, /terminal prune target|retirement data/i);
        }
        for (const snapshot of [f.target, f.retained]) {
          assert.equal((await Store.validateSnapshot(f.root, snapshot.name, { mode: 'restore' })).generation, snapshot.generation);
        }
        assert.deepEqual(gitState(f.root), before);
        assert.equal(fs.existsSync(path.join(f.root, '.project-state', 'locks', 'operation.lock', 'owner.json')), !forgedState.endsWith('-no-lock'));
      } finally { await lock.release().catch(() => {}); }
    });
  }
});

test('R14 interrupted recovery itself can be terminated and resumed by a third process', async (t) => {
  const f = await project(t);
  const stopped = await killAtPruneBoundary(f.root, 'pointer-moved');
  const recoveryMarker = `${MARKER_PREFIX}-recover-${Math.random().toString(16).slice(2)}.json`;
  const source = childHook('recover-interrupted', recoveryMarker).replace(
    `process.argv=[process.execPath,${JSON.stringify(CLI)},'prune','--keep','1','--yes'];require(${JSON.stringify(CLI)});`,
    `process.argv=[process.execPath,${JSON.stringify(CLI)},'recover',${JSON.stringify(stopped.operationId)},'--continue','--yes'];require(${JSON.stringify(CLI)});`,
  );
  const child = spawn(process.execPath, ['-e', source], { cwd: f.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 20_000;
  try {
    while (!fs.existsSync(recoveryMarker) && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(child.exitCode, null, 'recovery child reached committed cleanup and is still live');
    assert.ok(fs.existsSync(recoveryMarker));
    assert.equal(child.kill('SIGTERM'), true);
    const termination = await closed;
    assert.ok(termination.signal || termination.code !== null);
    const resumed = cli(f.root, ['recover', stopped.operationId, '--continue', '--yes']);
    assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.match(resumed.stdout, /continued and verified/i);
    assert.deepEqual(gitState(f.root), f.gitBefore);
    await assert.rejects(Store.validateSnapshot(f.root, f.target.name, { mode: 'restore' }), (error) => error.code === 'ESNAPSHOT_MISSING');
    assert.equal((await Store.validateSnapshot(f.root, f.retained.name, { mode: 'restore' })).generation, f.retained.generation);
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
    await fsp.rm(recoveryMarker, { force: true });
  }
});
