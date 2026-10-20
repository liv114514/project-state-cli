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
const CLI = path.resolve(__dirname, '..', 'bin', 'project-state.js');

function git(root, args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options }).trim();
}

function cli(root, args, cliPath = process.env.PROJECT_STATE_CLI || CLI) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true });
}

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-state-eff-review-'));
  await fsp.writeFile(path.join(root, '.gitignore'), '.project-state/\n');
  await fsp.writeFile(path.join(root, 'tracked.txt'), 'aaaa\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['add', '.gitignore', 'tracked.txt']);
  git(root, ['commit', '-qm', 'baseline']);
  const made = cli(root, ['snapshot', 'baseline']);
  assert.equal(made.status, 0, `${made.stdout}\n${made.stderr}`);
  t.after(async () => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function autoPruneFixture(t, prefix) {
  const root = await fixture(t);
  const base = Date.now() - 300000;
  for (let index = 0; index < 2; index += 1) {
    const stamp = new Date(base + index * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    await snapshotInternal(root, `auto-${stamp.slice(0, 8)}-${stamp.slice(9, 15)}`, { kind: 'auto' });
  }
  return { root, prefix };
}

async function childUntilMarker(root, source, marker, beforeKill = null) {
  const child = spawn(process.execPath, ['-e', source], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(child.exitCode, null, `child exited before marked window: ${stdout}\n${stderr}`);
  assert.ok(fs.existsSync(marker), `child did not reach marked window: ${stdout}\n${stderr}`);
  const observed = JSON.parse(await fsp.readFile(marker, 'utf8'));
  if (beforeKill) await beforeKill(observed);
  assert.equal(child.kill('SIGTERM'), true);
  const stopped = await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('child termination timed out')), 10000))]);
  assert.ok(stopped.signal || stopped.code !== null, 'close event confirms real child termination');
  return { observed, stopped, stdout, stderr };
}

async function stopPrune(root, stage = 'plan', beforeKill = null) {
  const cliPath = process.env.PROJECT_STATE_CLI || CLI;
  const marker = path.join(os.tmpdir(), `project-state-e03-prune-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const source = `
    const fs=require('node:fs'),path=require('node:path');const p=fs.promises,rename=p.rename.bind(p),write=p.writeFile.bind(p),marker=${JSON.stringify(marker)},stage=${JSON.stringify(stage)},root=process.cwd();
    function hold(id){fs.writeFileSync(marker,JSON.stringify({operationId:id,stage}));setInterval(()=>{},1000);return new Promise(()=>{});}
    p.rename=async(a,b,...rest)=>{if(stage==='plan'&&String(a).includes(path.join('.project-state','operations'))&&String(a).endsWith('.tmp')&&String(b).endsWith('.json')){let j;try{j=JSON.parse(fs.readFileSync(a,'utf8'))}catch{};if(j?.operation==='prune'){await rename(a,b,...rest);await hold(j.operationId)}}return rename(a,b,...rest)};
    p.writeFile=async(a,d,...rest)=>{if(stage==='progress-temp'&&String(a).includes(path.join('.project-state','operations'))&&String(a).endsWith('.tmp')){let j;try{j=JSON.parse(Buffer.from(d).toString('utf8'))}catch{};if(j?.operation==='prune'&&j.pruneTransaction?.planned?.some(x=>x.phase==='retiring')){await write(a,d,...rest);await hold(j.operationId)}}return write(a,d,...rest)};
    process.argv=[process.execPath,${JSON.stringify(cliPath)},'prune','--keep','1','--yes'];require(${JSON.stringify(cliPath)});
  `;
  const result = await childUntilMarker(root, source, marker, beforeKill);
  await fsp.rm(marker, { force: true });
  return result.observed;
}

async function interruptClaim(root, operationId, stage, beforeKill = null) {
  const storagePath = process.env.PROJECT_STATE_STORAGE || path.resolve(__dirname, '../lib/storage');
  const marker = path.join(os.tmpdir(), `project-state-e03-claim-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const source = `
    const fs=require('node:fs'),path=require('node:path'),Store=require(${JSON.stringify(storagePath)});const p=fs.promises,write=p.writeFile.bind(p),rename=p.rename.bind(p),marker=${JSON.stringify(marker)},stage=${JSON.stringify(stage)},op=${JSON.stringify(operationId)},root=process.cwd();
    function hold(){fs.writeFileSync(marker,JSON.stringify({stage,operationId:op}));setInterval(()=>{},1000);return new Promise(()=>{});}
    p.writeFile=async(a,d,...rest)=>{if(stage==='claim-owner'&&String(a).endsWith(path.join('operation.claim','owner.json'))){await write(a,d,...rest);await hold()}return write(a,d,...rest)};
    p.rename=async(a,b,...rest)=>{const from=String(a),to=String(b);if(stage==='before-owner-publish'&&to.endsWith(path.join('operation.lock','owner.json'))&&path.basename(from).startsWith('.owner-'))await hold();if(stage==='before-journal-publish'&&from.includes(path.join('.project-state','operations'))&&from.endsWith('.tmp')&&to.endsWith(op+'.json'))await hold();if(stage==='claim-release'&&from.endsWith('operation.claim')&&(to.includes('.released-')||to.includes('.retired-'))){await rename(a,b,...rest);await hold()}return rename(a,b,...rest)};
    Store.claimInterruptedPrune(root,op).then(()=>{console.error('unexpected natural return')},e=>{console.error(e.stack);process.exitCode=2});
  `;
  const result = await childUntilMarker(root, source, marker, beforeKill);
  await fsp.rm(marker, { force: true });
  return result;
}

function markerDriver(root, name, marker, key = 'clean') {
  const script = path.join(root, 'marker-filter.cjs');
  fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${name}:${key}\n`)}); process.stdin.pipe(process.stdout);`);
  git(root, ['config', `filter.${name}.${key}`, `node ${JSON.stringify(script)}`]);
  return script;
}

async function dirtyEqualLength(root, file, before, after) {
  assert.equal(Buffer.byteLength(before), Buffer.byteLength(after));
  const target = path.join(root, file);
  await fsp.writeFile(target, after);
  const stat = await fsp.stat(target);
  await fsp.utimes(target, new Date(stat.atimeMs), new Date(stat.mtimeMs + 5000));
}

test('E01 reproducer: clean-only unset/unspecified drivers are rejected before status can run them', async (t) => {
  const cliPath = process.env.PROJECT_STATE_CLI || CLI;
  for (const value of ['unset', 'unspecified']) {
    await t.test(value, async (st) => {
      const root = await fixture(st);
      const marker = path.join(root, 'clean-marker.txt');
      markerDriver(root, value, marker, 'clean');
      await fsp.writeFile(path.join(root, '.git', 'info', 'attributes'), `tracked.txt filter=${value}\n`);
      await dirtyEqualLength(root, 'tracked.txt', 'aaaa\n', 'bbbb\n');
      const dry = cli(root, ['restore', 'baseline', '--dry-run'], cliPath);
      assert.notEqual(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
      assert.equal(fs.existsSync(marker), false, `clean filter ran before dry-run refusal: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
      const actual = cli(root, ['restore', 'baseline', '--yes'], cliPath);
      assert.notEqual(actual.status, 0, `${actual.stdout}\n${actual.stderr}`);
      assert.equal(fs.existsSync(marker), false, `clean filter ran before restore refusal: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
    });
  }
});

test('E02 reproducer: staged-only new paths are included in effective filter preflight', async (t) => {
  const cliPath = process.env.PROJECT_STATE_CLI || CLI;
  for (const driver of ['clean', 'process']) {
    await t.test(driver, async (st) => {
      const root = await fixture(st);
      await fsp.writeFile(path.join(root, 'new-staged.txt'), 'aaaa\n');
      git(root, ['add', 'new-staged.txt']);
      const marker = path.join(root, `staged-${driver}-marker.txt`);
      const beforeHead = git(root, ['rev-parse', 'HEAD']);
      const beforeIndex = git(root, ['write-tree']);
      const beforeRefs = git(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
      markerDriver(root, 'reviewmarker', marker, driver);
      await fsp.writeFile(path.join(root, '.git', 'info', 'attributes'), 'new-staged.txt filter=reviewmarker\n');
      await dirtyEqualLength(root, 'new-staged.txt', 'aaaa\n', 'bbbb\n');
      const result = cli(root, ['restore', 'baseline', '--dry-run'], cliPath);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(fs.existsSync(marker), false, `${driver} filter ran before staged-only path refusal: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
      assert.equal(git(root, ['rev-parse', 'HEAD']), beforeHead);
      assert.equal(git(root, ['write-tree']), beforeIndex);
      assert.equal(git(root, ['for-each-ref', '--format=%(refname) %(objectname)']), beforeRefs);
      assert.equal(await fsp.readFile(path.join(root, 'new-staged.txt'), 'utf8'), 'bbbb\n');
    });
  }
});

test('E03 public writers reject unresolved claims and preserve their evidence', async (t) => {
  const root = await fixture(t);
  const locks = path.join(root, '.project-state', 'locks');
  const claim = path.join(locks, 'operation.claim');
  await fsp.mkdir(claim);
  const owner = { schemaVersion: 1, root, host: os.hostname(), pid: process.pid, token: Store.randomId(), targetOperationId: Store.randomId(), state: 'claimed' };
  await fsp.writeFile(path.join(claim, 'owner.json'), `${JSON.stringify(owner)}\n`);
  const before = await fsp.readFile(path.join(claim, 'owner.json'));
  const result = cli(root, ['snapshot', 'must-not-write']);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await fsp.readFile(path.join(claim, 'owner.json')), before);
  assert.equal(fs.existsSync(path.join(root, '.project-state', 'snapshots', 'must-not-write')), false);
});

test('E03 real claim interruption windows recover from a third process using bound operation evidence', async (t) => {
  for (const stage of ['claim-owner', 'before-owner-publish', 'before-journal-publish', 'claim-release']) {
    await t.test(stage, async (st) => {
      const { root } = await autoPruneFixture(st, stage);
      const interrupted = await stopPrune(root, stage === 'before-journal-publish' ? 'progress-temp' : 'plan');
      const operationId = interrupted.operationId;
      assert.ok(operationId);
      const claimed = await interruptClaim(root, operationId, stage);
      assert.equal(claimed.stopped.signal, 'SIGTERM');
      const resumed = cli(root, ['recover', operationId, '--continue', '--yes']);
      assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
      assert.match(resumed.stdout, /continued and verified|already committed and verified/i);
      const inspect = cli(root, ['recover', operationId, '--inspect']);
      assert.equal(inspect.status, 0, `${inspect.stdout}\n${inspect.stderr}`);
      const ordinary = cli(root, ['snapshot', `after-${stage}`]);
      assert.equal(ordinary.status, 0, `${ordinary.stdout}\n${ordinary.stderr}`);
      assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.claim')), false);
      const business = git(root, ['rev-parse', 'HEAD']);
      assert.ok(business);
    });
  }
});

test('E03 a competing writer cannot pass a live claimant, then recovery succeeds after its termination', async (t) => {
  const { root } = await autoPruneFixture(t, 'competition');
  const operationId = (await stopPrune(root, 'plan')).operationId;
  let competing;
  const stopped = await interruptClaim(root, operationId, 'before-owner-publish', async () => {
    competing = cli(root, ['snapshot', 'must-wait']);
    assert.notEqual(competing.status, 0);
    assert.match(`${competing.stdout}\n${competing.stderr}`, /claim|lock/i);
    assert.equal(fs.existsSync(path.join(root, '.project-state', 'snapshots', 'must-wait')), false);
  });
  assert.equal(stopped.stopped.signal, 'SIGTERM');
  const resumed = cli(root, ['recover', operationId, '--continue', '--yes']);
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
});

test('E03 an active original prune owner is refused until the process actually terminates', async (t) => {
  const { root } = await autoPruneFixture(t, 'active-original');
  let activeResult;
  const interrupted = await stopPrune(root, 'plan', ({ operationId }) => {
    activeResult = cli(root, ['recover', operationId, '--continue', '--yes']);
    assert.notEqual(activeResult.status, 0, `${activeResult.stdout}\n${activeResult.stderr}`);
    assert.match(`${activeResult.stdout}\n${activeResult.stderr}`, /active|running|lock/i);
  });
  const resumed = cli(root, ['recover', interrupted.operationId, '--continue', '--yes']);
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
});

test('E03 changed or incomplete claim evidence is preserved and never treated as authorization', async (t) => {
  for (const mutation of ['wrong-token', 'foreign-host', 'malformed', 'missing-owner', 'journal-bytes']) {
    await t.test(mutation, async (st) => {
      const { root } = await autoPruneFixture(st, mutation);
      const operationId = (await stopPrune(root, 'plan')).operationId;
      await interruptClaim(root, operationId, 'claim-owner');
      const claimDir = path.join(root, '.project-state', 'locks', 'operation.claim');
      const ownerFile = path.join(claimDir, 'owner.json');
      const operationLockOwner = path.join(root, '.project-state', 'locks', 'operation.lock', 'owner.json');
      const beforeLock = await fsp.readFile(operationLockOwner);
      if (mutation === 'wrong-token' || mutation === 'foreign-host') {
        const owner = JSON.parse(await fsp.readFile(ownerFile, 'utf8'));
        if (mutation === 'wrong-token') owner.token = Store.randomId();
        else owner.host = 'foreign-host.example.invalid';
        await fsp.writeFile(ownerFile, `${JSON.stringify(owner)}\n`);
      } else if (mutation === 'malformed') await fsp.writeFile(ownerFile, '{invalid claim owner');
      else if (mutation === 'missing-owner') await fsp.unlink(ownerFile);
      else await fsp.appendFile(Store.operationJournalPath(root, operationId), ' ');
      const evidencePath = mutation === 'journal-bytes' ? Store.operationJournalPath(root, operationId) : ownerFile;
      const beforeEvidence = mutation === 'missing-owner' ? null : await fsp.readFile(evidencePath);
      const result = cli(root, ['recover', operationId, '--continue', '--yes']);
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      if (mutation === 'missing-owner') assert.equal(fs.existsSync(evidencePath), false);
      else assert.deepEqual(await fsp.readFile(evidencePath), beforeEvidence);
      assert.deepEqual(await fsp.readFile(operationLockOwner), beforeLock);
      assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.claim')), true);
    });
  }
});
