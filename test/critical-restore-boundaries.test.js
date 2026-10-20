'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const H = require('./helpers');
const Store = require('../lib/storage');

const CLI = path.resolve(__dirname, '..', 'bin', 'project-state.js');
function tempProject() { return fsp.mkdtemp(path.join(os.tmpdir(), 'pss-critical-restore-')); }
function child(root, injected, args = ['restore', 'before', '--yes']) {
  const code = `${injected}\nprocess.argv=[process.execPath,${JSON.stringify(CLI)},...${JSON.stringify(args)}];require(${JSON.stringify(CLI)});`;
  return spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true });
}
async function makeConfigSnapshot(root, { targetExists = true } = {}) {
  await H.setupGit(root, { '.gitignore': '.project-state/\n' });
  H.excludeLocalFiles(root, ['.env']);
  await fsp.writeFile(path.join(root, '.env'), 'MODE=before\n');
  const saved = await H.cli(root, ['snapshot', 'before']);
  assert.equal(saved.status, 0, `${saved.stdout}\n${saved.stderr}`);
  if (targetExists) await fsp.writeFile(path.join(root, '.env'), 'MODE=after!\n');
  else await fsp.unlink(path.join(root, '.env'));
}

test('CR01 reproducer: external edit at the publication boundary must not be overwritten', async (t) => {
  const root = await tempProject();
  t.after(() => H.removeTemporaryTree(root));
  await makeConfigSnapshot(root);
  const envPath = path.join(root, '.env');
  const identity = path.join(root, 'external-identity.json');
  const code = `
    const fs=require('node:fs');const p=fs.promises;const real=p.rename.bind(p);let fired=false;
    p.rename=async(a,b,...rest)=>{if(!fired&&String(a)===${JSON.stringify(envPath)}&&String(b).endsWith('.tmp.previous')){fired=true;fs.writeFileSync(${JSON.stringify(envPath)},${JSON.stringify('MODE=external\n')});const s=fs.statSync(${JSON.stringify(envPath)},{bigint:true});fs.writeFileSync(${JSON.stringify(identity)},JSON.stringify({dev:String(s.dev),ino:String(s.ino)}))}return real(a,b,...rest)};
  `;
  const result = child(root, code);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'MODE=external\n', `${result.stdout}\n${result.stderr}`);
  const id = JSON.parse(fs.readFileSync(identity, 'utf8'));
  const after = fs.statSync(envPath, { bigint: true });
  assert.equal(String(after.dev), id.dev);
  assert.equal(String(after.ino), id.ino);
});

test('CR01 regression: an externally-created absent target is preserved at exclusive publication', async (t) => {
  const root = await tempProject();
  t.after(() => H.removeTemporaryTree(root));
  await makeConfigSnapshot(root, { targetExists: false });
  const envPath = path.join(root, '.env');
  const identity = path.join(root, 'external-identity.json');
  const code = `
    const fs=require('node:fs'),p=fs.promises,real=p.link.bind(p);let fired=false;
    p.link=async(a,b)=>{if(!fired&&String(b)===${JSON.stringify(envPath)}){fired=true;fs.writeFileSync(${JSON.stringify(envPath)},${JSON.stringify('MODE=external\n')});const s=fs.statSync(${JSON.stringify(envPath)},{bigint:true});fs.writeFileSync(${JSON.stringify(identity)},JSON.stringify({dev:String(s.dev),ino:String(s.ino)}));}return real(a,b)};
  `;
  const result = child(root, code);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'MODE=external\n');
  const id = JSON.parse(fs.readFileSync(identity, 'utf8'));
  const after = fs.statSync(envPath, { bigint: true });
  assert.equal(String(after.dev), id.dev);
  assert.equal(String(after.ino), id.ino);
});

test('CR01 regression: failed compensation preserves an external replacement of a formerly absent target', async (t) => {
  const root = await tempProject();
  t.after(() => H.removeTemporaryTree(root));
  const envPath = path.join(root, '.env');
  await H.setupGit(root, { '.gitignore': '.project-state/\n.env\n' });
  H.excludeLocalFiles(root, ['.env']);
  fs.writeFileSync(envPath, 'MODE=before\n');
  const saved = await H.cli(root, ['snapshot', 'before']);
  assert.equal(saved.status, 0, `${saved.stdout}\n${saved.stderr}`);
  fs.unlinkSync(envPath);
  const identity = path.join(root, 'external-identity.json');
  const code = `
    const fs=require('node:fs'),p=fs.promises,Store=require(${JSON.stringify(path.resolve(__dirname,'../lib/storage'))});
    const realRename=p.rename.bind(p),realJournal=Store.writeOperationJournal.bind(Store);let replaced=false,failed=false;
    Store.writeOperationJournal=async(root,lock,fields)=>{if(!failed&&fields?.phase==='verifying'){failed=true;const e=new Error('injected verification failure');e.code='EINJECTED';throw e;}return realJournal(root,lock,fields)};
    p.rename=async(a,b,...rest)=>{if(!replaced&&String(a)===${JSON.stringify(envPath)}&&String(b).includes('retire-')){replaced=true;fs.writeFileSync(${JSON.stringify(envPath)},${JSON.stringify('MODE=external\n')});const s=fs.statSync(${JSON.stringify(envPath)},{bigint:true});fs.writeFileSync(${JSON.stringify(identity)},JSON.stringify({dev:String(s.dev),ino:String(s.ino)}));}return realRename(a,b,...rest)};
  `;
  const result = child(root, code, ['restore', 'before', '--only', 'config', '--yes']);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'MODE=external\n');
  const expected = JSON.parse(fs.readFileSync(identity, 'utf8'));
  const actual = fs.statSync(envPath, { bigint: true });
  assert.equal(String(actual.dev), expected.dev);
  assert.equal(String(actual.ino), expected.ino);
});

test('CR02 reproducer: same-content external inode is not claimed after pre-publication journal failure', async (t) => {
  for (const originalExists of [false, true]) await t.test(`originalExists=${originalExists}`, async (st) => {
    const root = await tempProject();
    st.after(() => H.removeTemporaryTree(root));
    await makeConfigSnapshot(root, { targetExists: originalExists });
    const envPath = path.join(root, '.env');
    const identity = path.join(root, 'external-identity.json');
    const expected = 'MODE=before\n';
    const before = originalExists ? fs.readFileSync(envPath) : null;
    const code = `
      const fs=require('node:fs'),Store=require(${JSON.stringify(path.resolve(__dirname,'../lib/storage'))});
      const original=Store.writeOperationJournal.bind(Store);let fired=false;
      Store.writeOperationJournal=async(root,lock,fields)=>{
        if(!fired&&fields?.pendingTemp?.phase==='prepared'){
          fired=true;fs.writeFileSync(${JSON.stringify(envPath)},${JSON.stringify(expected)});
          const s=fs.statSync(${JSON.stringify(envPath)},{bigint:true});fs.writeFileSync(${JSON.stringify(identity)},JSON.stringify({dev:String(s.dev),ino:String(s.ino)}));
          const e=new Error('injected prepared journal failure');e.code='EINJECTED';throw e;
        }
        return original(root,lock,fields);
      };
    `;
    const result = child(root, code);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(envPath), true, 'external file was not removed');
    assert.equal(fs.readFileSync(envPath, 'utf8'), expected, 'external replacement bytes remain');
    const id = JSON.parse(fs.readFileSync(identity, 'utf8'));
    const after = fs.statSync(envPath, { bigint: true });
    assert.equal(String(after.dev), id.dev);
    assert.equal(String(after.ino), id.ino);
    if (before) assert.notDeepEqual(fs.readFileSync(envPath), before, 'external inode was not rolled back to the pre-operation bytes');
  });
});

test('CR02 regression: own published inode is still compensated when its progress journal fails', async (t) => {
  const root = await tempProject();
  t.after(() => H.removeTemporaryTree(root));
  await makeConfigSnapshot(root);
  const envPath = path.join(root, '.env');
  const code = `
    const Store=require(${JSON.stringify(path.resolve(__dirname,'../lib/storage'))});
    const original=Store.writeOperationJournal.bind(Store);let failed=false;
    Store.writeOperationJournal=async(root,lock,fields)=>{
      if(!failed&&fields?.pendingTemp?.phase==='published'){failed=true;const e=new Error('injected published progress failure');e.code='EINJECTED';throw e;}
      return original(root,lock,fields);
    };
  `;
  const result = child(root, code);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'MODE=after!\n', `the original pre-restore bytes were restored\n${result.stdout}\n${result.stderr}`);
  const operations = path.join(root, '.project-state', 'operations');
  const journals = await Promise.all((await fsp.readdir(operations)).filter((name) => name.endsWith('.json')).map((name) => Store.readJournal(root, path.join(operations, name))));
  assert.ok(journals.some((journal) => journal.operation === 'restore' && journal.terminalOutcome === 'failed-rolled-back'), 'a failed restore records its verified compensation outcome');
});

test('CR03 reproducer: checkout cleanup failure cannot report complete rollback with changed Git state', async (t) => {
  const root = await tempProject();
  t.after(() => H.removeTemporaryTree(root));
  await H.setupGit(root, { 'tracked.txt': 'state A\n' });
  await H.git(root, ['config', 'core.autocrlf', 'false']);
  const saved = await H.cli(root, ['snapshot', 'before']);
  assert.equal(saved.status, 0, `${saved.stdout}\n${saved.stderr}`);
  await fsp.writeFile(path.join(root, 'tracked.txt'), 'state B\n');
  await H.git(root, ['add', 'tracked.txt']);
  await H.git(root, ['commit', '-m', 'state B']);
  const beforeHead = (await H.git(root, ['rev-parse', 'HEAD'])).trim();
  const beforeBytes = fs.readFileSync(path.join(root, 'tracked.txt'));
  const code = `
    const fs=require('node:fs'),p=fs.promises,real=p.rm.bind(p);let failed=false;
    p.rm=async(target,options)=>{if(!failed&&String(target).includes('project-state-empty-hooks-')){failed=true;const e=new Error('injected hook directory cleanup failure');e.code='EACCES';throw e;}return real(target,options)};
  `;
  const result = child(root, code);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal((await H.git(root, ['rev-parse', 'HEAD'])).trim(), beforeHead, 'compensation restored the original HEAD');
  assert.deepEqual(fs.readFileSync(path.join(root, 'tracked.txt')), beforeBytes);
  assert.doesNotMatch(result.stderr, /failed-rolled-back/i);
});
