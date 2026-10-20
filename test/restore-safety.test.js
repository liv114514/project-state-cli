'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('./helpers');
const U = require('../lib/utils');
const Store = require('../lib/storage');
const { restoreCmd, restoreInternal } = require('../lib/restore');

function tempProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pss-restore-safety-')); }
function read(p) { return fs.readFileSync(p); }
async function head(root) { return (await H.git(root, ['rev-parse', 'HEAD'])).trim(); }
async function snapshot(root, name) {
  const r = await H.cli(root, ['snapshot', name]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return Store.validateSnapshot(root, name, { mode: 'restore' });
}
async function restoreWithRollbackToken() {
  const root = tempProject();
  await H.setupGit(root, { '.nvmrc': 'head-A\n' });
  await H.git(root, ['config', 'core.autocrlf', 'false']);
  const targetHead = await head(root);
  fs.writeFileSync(path.join(root, '.nvmrc'), 'snapshot-B\n');
  await snapshot(root, 'rollback-target');
  await H.git(root, ['add', '.nvmrc']);
  await H.git(root, ['commit', '-m', 'commit pin B']);
  const beforeHead = await head(root);
  const beforeBranch = (await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
  const beforeRef = (await H.git(root, ['rev-parse', `refs/heads/${beforeBranch}`])).trim();
  const beforeIndex = (await H.git(root, ['write-tree'])).trim();
  const beforeBytes = read(path.join(root, '.nvmrc'));
  const restored = await H.cli(root, ['restore', 'rollback-target', '--yes']);
  assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
  assert.equal(await head(root), targetHead);
  assert.deepEqual(read(path.join(root, '.nvmrc')), Buffer.from('snapshot-B\n'));
  const label = process.platform === 'win32' ? 'Exact rollback command (PowerShell): ' : 'Exact rollback command: ';
  const commandLine = restored.stdout.split(/\r?\n/).find((line) => line.startsWith(label));
  assert.ok(commandLine, `success output includes a shell-specific rollback command: ${restored.stdout}`);
  const command = commandLine.slice(label.length).match(/['"]restore['"] ['"]([^'"]+)['"] ['"]--yes['"] ['"]--rollback-of['"] ['"]([a-f0-9]{32})['"]$/);
  assert.ok(command, `rollback command carries a quoted safety name and operation id: ${commandLine}`);
  return { root, beforeHead, beforeBranch, beforeRef, beforeIndex, beforeBytes, safetyName: command[1], operationId: command[2], commandLine: commandLine.slice(label.length) };
}

function invokeExactRollback(root, commandLine) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', commandLine]
    : ['-c', commandLine];
  const result = spawnSync(shell, args, { cwd: root, encoding: 'utf8', timeout: 30000 });
  if (result.error) return { status: -1, stdout: result.stdout || '', stderr: `${result.stderr || ''}\n${result.error.message}` };
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('unknown restore name lists only validated snapshots and makes no restore changes', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root);
    await snapshot(root, 'known-good');
    const beforeHead = await head(root);
    const beforeIndexTree = (await H.git(root, ['write-tree'])).trim();
    const beforeBytes = read(path.join(root, 'app.js'));
    const beforeSnapshots = await U.listSnapshots(root);

    const r = await H.cli(root, ['restore', 'missing-name', '--yes']);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /snapshot not found: missing-name/i);
    assert.equal(await head(root), beforeHead);
    assert.equal((await H.git(root, ['write-tree'])).trim(), beforeIndexTree);
    assert.deepEqual(read(path.join(root, 'app.js')), beforeBytes);
    assert.deepEqual(await U.listSnapshots(root), beforeSnapshots);

    const manifest = Store.snapshotPaths(root, 'known-good').manifestFile;
    fs.writeFileSync(manifest, '{ broken json', 'utf8');
    const corrupt = await H.cli(root, ['restore', 'known-good', '--yes']);
    assert.equal(corrupt.status, 1, `${corrupt.stdout}\n${corrupt.stderr}`);
    assert.match(corrupt.stderr, /snapshot|manifest|integrity|refus/i);
    assert.doesNotMatch(corrupt.stderr, /available complete snapshots/i);
    assert.equal(await head(root), beforeHead);
    assert.equal((await H.git(root, ['write-tree'])).trim(), beforeIndexTree);
    assert.deepEqual(read(path.join(root, 'app.js')), beforeBytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F01 --force refuses dirty source work and leaves bytes, index, HEAD, and recovery storage unchanged', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root);
    await snapshot(root, 'saved');
    const beforeHead = await head(root);
    const beforeIndexTree = (await H.git(root, ['write-tree'])).trim();
    const beforeSnapshots = await U.listSnapshots(root);
    fs.writeFileSync(path.join(root, 'app.js'), 'uncommitted source that must survive\n');
    const beforeBytes = read(path.join(root, 'app.js'));
    const r = await H.cli(root, ['restore', 'saved', '--yes', '--force']);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /--force cannot (preserve|bypass)/i);
    assert.deepEqual(read(path.join(root, 'app.js')), beforeBytes);
    assert.equal((await H.git(root, ['write-tree'])).trim(), beforeIndexTree);
    assert.equal(await head(root), beforeHead);
    assert.deepEqual(await U.listSnapshots(root), beforeSnapshots, 'refusal creates no misleading safety point');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F01 --force refuses staged, mixed, binary, delete, rename, and untracked work without changing Git state', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root, { 'delete-me.txt': 'delete baseline\n', 'rename-from.txt': 'rename baseline\n' });
    await snapshot(root, 'protected');
    const beforeHead = await head(root);
    const beforeBranch = (await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
    const beforeRefs = (await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim();

    fs.writeFileSync(path.join(root, 'app.js'), 'staged bytes\n');
    await H.git(root, ['add', 'app.js']);
    fs.writeFileSync(path.join(root, 'app.js'), 'different unstaged bytes\n');
    fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0, 255, 1, 128]));
    await H.git(root, ['add', 'binary.dat']);
    fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([3, 0, 254, 127]));
    await H.git(root, ['rm', '--quiet', 'delete-me.txt']);
    await H.git(root, ['mv', 'rename-from.txt', 'rename-to.txt']);
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'untracked marker\n');

    const beforeBytes = new Map(['app.js', 'binary.dat', 'rename-to.txt', 'untracked.txt'].map((name) => [name, read(path.join(root, name))]));
    const beforeStatus = await H.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const beforeIndex = (await H.git(root, ['write-tree'])).trim();
    const r = await H.cli(root, ['restore', 'protected', '--yes', '--force']);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /must be clean/i);
    assert.equal(await head(root), beforeHead);
    assert.equal((await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), beforeBranch);
    assert.equal((await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(), beforeRefs);
    assert.equal((await H.git(root, ['write-tree'])).trim(), beforeIndex);
    assert.equal(await H.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), beforeStatus);
    for (const [name, bytes] of beforeBytes) assert.deepEqual(read(path.join(root, name)), bytes, `${name} bytes survive refusal`);
    assert.equal(fs.existsSync(path.join(root, 'delete-me.txt')), false, 'staged deletion remains staged');
    assert.equal(fs.existsSync(path.join(root, 'rename-from.txt')), false, 'staged rename source remains absent');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F01 ignored target conflict is refused by Git checkout without changing the ignored file', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root, { 'ignored-conflict.txt': 'tracked target bytes\n' });
    await snapshot(root, 'target-with-ignored-path');
    await H.git(root, ['rm', '--quiet', 'ignored-conflict.txt']);
    await H.git(root, ['commit', '-m', 'remove future ignored conflict']);
    fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\n/ignored-conflict.txt\n');
    fs.writeFileSync(path.join(root, 'ignored-conflict.txt'), 'external ignored marker\n');
    const before = read(path.join(root, 'ignored-conflict.txt'));
    const beforeHead = await head(root);
    const beforeRefs = (await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim();
    const beforeIndex = (await H.git(root, ['write-tree'])).trim();

    const r = await H.cli(root, ['restore', 'target-with-ignored-path', '--yes', '--force']);
    assert.notEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(read(path.join(root, 'ignored-conflict.txt')), before);
    assert.equal(await head(root), beforeHead);
    assert.equal((await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(), beforeRefs);
    assert.equal((await H.git(root, ['write-tree'])).trim(), beforeIndex);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F02 file artifacts are replayed after Git checkout even when they matched before checkout', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root, { '.nvmrc': 'head-pin\n' });
    await H.git(root, ['config', 'core.autocrlf', 'false']);
    const snapshotHead = await head(root);
    fs.writeFileSync(path.join(root, '.nvmrc'), 'snapshot-pin\n');
    await snapshot(root, 'saved-pin'); // captures the dirty pin while Git records snapshotHead
    await H.git(root, ['add', '.nvmrc']);
    await H.git(root, ['commit', '-m', 'commit captured pin']);
    const currentHead = await head(root);
    const currentRef = (await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
    const currentRefs = (await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim();
    const targetIndex = (await H.git(root, ['rev-parse', `${snapshotHead}^{tree}`])).trim();
    assert.notEqual(currentHead, snapshotHead);
    assert.equal(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8'), 'snapshot-pin\n');

    const r = await H.cli(root, ['restore', 'saved-pin', '--yes']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(await head(root), snapshotHead);
    assert.equal((await H.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim(), '', 'diverged target branch is not moved; restore is detached');
    assert.equal((await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(), currentRefs, 'all branch refs remain unchanged');
    assert.equal((await H.git(root, ['write-tree'])).trim(), targetIndex, 'index matches the target commit tree');
    assert.notEqual(currentRef, '', 'the pre-restore state was branch-attached');
    assert.equal(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8'), 'snapshot-pin\n');
    assert.match(r.stdout, /Restore verified/i);
    assert.match(r.stdout, /Git HEAD mode: detached/i, 'CLI states the verified detached result');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F03 restoring a detached snapshot keeps the current branch ref unchanged', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root);
    await H.git(root, ['checkout', '--detach', 'HEAD']);
    const target = await head(root);
    await snapshot(root, 'detached-save');
    fs.writeFileSync(path.join(root, 'app.js'), 'second commit\n');
    await H.git(root, ['add', 'app.js']);
    await H.git(root, ['commit', '-m', 'advance current branch']);
    await H.git(root, ['branch', 'keep-current']);
    const current = await head(root);
    assert.notEqual(current, target);

    const r = await H.cli(root, ['restore', 'detached-save', '--yes']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(await head(root), target);
    assert.equal((await H.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim(), '', 'restore leaves HEAD detached');
    assert.equal((await H.git(root, ['rev-parse', 'refs/heads/keep-current'])).trim(), current, 'existing branch ref was not moved');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F03 restoring the same commit from a different attached branch restores attachment without moving refs', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root);
    const target = await head(root);
    const targetBranch = (await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
    await H.git(root, ['branch', 'other-branch']);
    await snapshot(root, 'same-commit-branch');
    await H.git(root, ['checkout', 'other-branch']);
    assert.equal(await head(root), target, 'both branches start at the same commit');
    const refsBefore = (await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim();
    const indexBefore = (await H.git(root, ['write-tree'])).trim();

    const result = await H.cli(root, ['restore', 'same-commit-branch', '--yes']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await head(root), target);
    assert.equal((await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), targetBranch);
    assert.equal((await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(), refsBefore);
    assert.equal((await H.git(root, ['write-tree'])).trim(), indexBefore);
    assert.match(result.stdout, new RegExp(`Git HEAD mode: attached to refs/heads/${targetBranch}\\.`));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('printed rollback command restores the exact pre-restore Git and file state', async () => {
  const state = await restoreWithRollbackToken();
  try {
    const original = await Store.readJournal(state.root, Store.operationJournalPath(state.root, state.operationId));
    const independentPin = await Store.pinSnapshot(state.root, { name: state.safetyName, generation: original.safety.generation, operationId: Store.randomId(), reason: 'manual' });
    const rollback = invokeExactRollback(state.root, state.commandLine);
    assert.equal(rollback.status, 0, `${rollback.stdout}\n${rollback.stderr}`);
    assert.equal(await head(state.root), state.beforeHead);
    assert.equal((await H.git(state.root, ['symbolic-ref', '--short', 'HEAD'])).trim(), state.beforeBranch);
    assert.equal((await H.git(state.root, ['rev-parse', `refs/heads/${state.beforeBranch}`])).trim(), state.beforeRef);
    assert.equal((await H.git(state.root, ['write-tree'])).trim(), state.beforeIndex);
    assert.deepEqual(read(path.join(state.root, '.nvmrc')), state.beforeBytes);
    const resolved = await Store.readJournal(state.root, Store.operationJournalPath(state.root, state.operationId));
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.terminalOutcome, 'resolved-by-rollback');
    assert.ok(resolved.resolvedBy);
    const pins = await Store.listPins(state.root);
    assert.equal(pins.some((pin) => pin.pinId === original.safety.pinId), false, 'successful verified rollback releases the original rollback-needed pin');
    assert.equal(pins.some((pin) => pin.pinId === independentPin.pinId), true, 'a different owner pin remains protected');
  } finally { fs.rmSync(state.root, { recursive: true, force: true }); }
});

test('Command Prompt rollback survives percent and exclamation characters in the CLI installation path', async (t) => {
  if (process.platform !== 'win32') { t.skip('Command Prompt invocation is Windows-specific'); return; }
  const root = tempProject();
  const cliRoot = path.join(os.tmpdir(), `project-state-%TEMP%-bang!-cli-${process.pid}-${Date.now()}`);
  const batchFile = path.join(os.tmpdir(), `project-state-cmd-rollback-${process.pid}-${Date.now()}.cmd`);
  const launcherFile = `${batchFile}.ps1`;
  const outputFile = `${batchFile}.log`;
  try {
    fs.mkdirSync(cliRoot, { recursive: true });
    fs.cpSync(path.resolve(__dirname, '..', 'bin'), path.join(cliRoot, 'bin'), { recursive: true });
    fs.cpSync(path.resolve(__dirname, '..', 'lib'), path.join(cliRoot, 'lib'), { recursive: true });
    const copiedCli = path.join(cliRoot, 'bin', 'project-state.js');

    await H.setupGit(root, { '.nvmrc': 'head-A\n' });
    await H.git(root, ['config', 'core.autocrlf', 'false']);
    const targetHead = await head(root);
    fs.writeFileSync(path.join(root, '.nvmrc'), 'snapshot-B\n');
    await snapshot(root, 'cmd-special-path');
    await H.git(root, ['add', '.nvmrc']);
    await H.git(root, ['commit', '-m', 'commit pin B']);
    const beforeHead = await head(root);
    const beforeBranch = (await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
    const beforeRef = (await H.git(root, ['rev-parse', `refs/heads/${beforeBranch}`])).trim();
    const beforeIndex = (await H.git(root, ['write-tree'])).trim();
    const beforeBytes = read(path.join(root, '.nvmrc'));

    const restored = spawnSync(process.execPath, [copiedCli, 'restore', 'cmd-special-path', '--yes'], { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
    assert.equal(await head(root), targetHead);
    assert.deepEqual(read(path.join(root, '.nvmrc')), Buffer.from('snapshot-B\n'));
    const label = 'Command Prompt equivalent (encoded PowerShell): ';
    const line = restored.stdout.split(/\r?\n/).find((entry) => entry.startsWith(label));
    assert.ok(line, `restore output includes the encoded Command Prompt command: ${restored.stdout}`);
    const commandLine = line.slice(label.length);
    const encoded = commandLine.match(/-EncodedCommand ([A-Za-z0-9+/=]+)$/)?.[1];
    assert.ok(encoded, `encoded command uses a CMD-safe Base64 argument: ${commandLine}`);
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.ok(decoded.includes(cliRoot), 'encoded script retains the literal special-character CLI path');
    assert.ok(decoded.includes('%TEMP%-bang!'), 'encoded script preserves percent and exclamation characters');
    assert.match(decoded, /exit \$LASTEXITCODE\s*$/, 'the CMD caller receives the Node CLI exit status');

    const fakeProjectLauncher = path.join(root, 'powershell.exe');
    H.excludeLocalFiles(root, ['powershell.exe']);
    fs.writeFileSync(fakeProjectLauncher, 'not a valid executable; must not shadow the system PowerShell launcher');
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const powershellPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    assert.ok(fs.existsSync(powershellPath), `system PowerShell launcher exists: ${powershellPath}`);

    // Redirect in the batch wrapper so the encoded PowerShell and its Node
    // child do not inherit the test runner's output handles.
    fs.writeFileSync(batchFile, `@echo off\r\n${commandLine} >> "${outputFile}" 2>&1\r\n`, 'utf8');
    const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;
    fs.writeFileSync(launcherFile,
      `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', ${psQuote(batchFile)}) -WorkingDirectory ${psQuote(root)} -Wait -PassThru -NoNewWindow\nexit $p.ExitCode\n`,
      'utf8');
    const rollback = spawnSync(powershellPath, ['-NoProfile', '-NonInteractive', '-File', launcherFile], { stdio: 'ignore', timeout: 30000 });
    const rollbackOutput = fs.existsSync(outputFile) ? read(outputFile).toString('utf8') : '';
    assert.equal(rollback.status, 0, `status=${rollback.status}; command=${commandLine}\n${rollbackOutput}`);
    assert.match(rollbackOutput, /Verified rollback/i);
    assert.equal(await head(root), beforeHead);
    assert.equal((await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), beforeBranch);
    assert.equal((await H.git(root, ['rev-parse', `refs/heads/${beforeBranch}`])).trim(), beforeRef);
    assert.equal((await H.git(root, ['write-tree'])).trim(), beforeIndex);
    assert.deepEqual(read(path.join(root, '.nvmrc')), beforeBytes);

    fs.writeFileSync(outputFile, '');
    const repeated = spawnSync(powershellPath, ['-NoProfile', '-NonInteractive', '-File', launcherFile], { stdio: 'ignore', timeout: 30000 });
    const repeatedOutput = read(outputFile).toString('utf8');
    assert.equal(repeated.status, 1, `CMD propagates a refused rollback's exit status: ${repeatedOutput}`);
    assert.match(repeatedOutput, /Restore did not complete/i);
    assert.equal(await head(root), beforeHead);
    assert.equal((await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), beforeBranch);
    assert.equal((await H.git(root, ['rev-parse', `refs/heads/${beforeBranch}`])).trim(), beforeRef);
    assert.equal((await H.git(root, ['write-tree'])).trim(), beforeIndex);
    assert.deepEqual(read(path.join(root, '.nvmrc')), beforeBytes);
  } finally {
    fs.rmSync(batchFile, { force: true });
    fs.rmSync(launcherFile, { force: true });
    fs.rmSync(outputFile, { force: true });
    fs.rmSync(cliRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rollback refuses a changed target and keeps its bytes, Git state, and safety pin', async () => {
  const state = await restoreWithRollbackToken();
  try {
    fs.writeFileSync(path.join(state.root, '.nvmrc'), 'external change C\n');
    const changed = read(path.join(state.root, '.nvmrc'));
    const restoreHead = await head(state.root);
    const index = (await H.git(state.root, ['write-tree'])).trim();
    const rollback = invokeExactRollback(state.root, state.commandLine);
    assert.equal(rollback.status, 1, `${rollback.stdout}\n${rollback.stderr}`);
    assert.match(rollback.stderr, /rollback|changed|proof|state/i);
    assert.equal(await head(state.root), restoreHead);
    assert.equal((await H.git(state.root, ['write-tree'])).trim(), index);
    assert.deepEqual(read(path.join(state.root, '.nvmrc')), changed);
    const pins = await Store.listPins(state.root);
    const pin = pins.find((entry) => entry.name === state.safetyName);
    assert.ok(pin, 'uncertain operation keeps its safety generation persistently pinned');
    await Store.validateSnapshot(state.root, pin.name, { mode: 'restore' });
  } finally { fs.rmSync(state.root, { recursive: true, force: true }); }
});

test('a killed child after file rename is inspected and compensated by a fresh process', async () => {
  const root = tempProject();
  let child;
  try {
    await H.setupGit(root);
    H.excludeLocalFiles(root, ['.env']);
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=snapshot-value\n');
    await snapshot(root, 'crash-source');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=pre-restore-value\n');
    const originalBytes = read(path.join(root, '.env'));
    const cliPath = path.join(__dirname, '..', 'bin', 'project-state.js');
    const killpoint = path.join(os.tmpdir(), `project-state-killpoint-${path.basename(root)}.marker`);
    const childCode = `const fs=require('fs');const real=fs.promises.link.bind(fs.promises);fs.promises.link=async(a,b,...x)=>{const r=await real(a,b,...x);if(String(a).includes('staging')&&String(a).includes('restore-')&&String(b).endsWith('.env')){fs.writeFileSync(${JSON.stringify(killpoint)},String(a));setInterval(()=>{},1000);await new Promise(()=>{})}return r};process.argv=[process.execPath,${JSON.stringify(cliPath)},'restore','crash-source','--yes'];require(${JSON.stringify(cliPath)});`;
    child = spawn(process.execPath, ['-e', childCode], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const childClosed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    let childOutput = '';
    child.stdout.on('data', (chunk) => { childOutput += chunk; });
    child.stderr.on('data', (chunk) => { childOutput += chunk; });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !fs.existsSync(killpoint)) {
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(killpoint), `child reached the post-rename window; exit=${child.exitCode}; output=${childOutput}`);
    assert.notDeepEqual(read(path.join(root, '.env')), originalBytes, 'rename already changed target bytes before post-apply journal write');
    assert.equal(child.kill(), true, 'child process is still alive at the rename killpoint');
    const termination = await childClosed;
    assert.equal(termination.signal, 'SIGTERM', `child was terminated at the rename window: ${JSON.stringify(termination)}`);
    let journal; let journalPath;
    const operations = path.join(root, '.project-state', 'operations');
    for (const name of fs.readdirSync(operations).filter((x) => x.endsWith('.json'))) {
      const candidate = JSON.parse(fs.readFileSync(path.join(operations, name), 'utf8'));
      if (candidate.phase === 'applying' && candidate.pendingTarget?.target === '.env') { journal = candidate; journalPath = path.join(operations, name); break; }
    }
    assert.ok(journal, 'operation journal retained the staged identity and pending target after process termination');
    assert.equal(journal.pendingTemp?.phase, 'prepared', 'the durable record describes the exact private staging file before the post-rename journal window');
    assert.match(journal.pendingTemp?.path || '', /^staging\/[a-f0-9]{32}\/private\//, 'restore bytes are staged below the private operation directory');
    assert.ok(fs.existsSync(killpoint), 'the child recorded the actual private staging path used for rename');
    assert.equal(path.relative(path.join(root, '.project-state'), fs.readFileSync(killpoint, 'utf8').trim()).startsWith('..'), false, 'staging path remains inside .project-state');
    const operationId = path.basename(journalPath, '.json');
    assert.equal(fs.readdirSync(root).some((entry) => entry.startsWith('.project-state-restore-')), false, 'no restore temp was written beside the business target');
    const inspect = await H.cli(root, ['recover', operationId, '--inspect']);
    assert.equal(inspect.status, 0, `${inspect.stdout}\n${inspect.stderr}`);
    assert.match(inspect.stdout, /process not running/i);
    const recovered = await H.cli(root, ['recover', operationId, '--compensate', '--yes']);
    assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
    assert.deepEqual(read(path.join(root, '.env')), originalBytes);
    const resolved = await Store.readJournal(root, Store.operationJournalPath(root, operationId));
    assert.equal(resolved.terminalOutcome, 'resolved-by-rollback');
    assert.equal((await Store.listPins(root)).some((pin) => pin.pinId === journal.safety.pinId), false);
  } finally {
    if (child && child.exitCode === null) child.kill();
    try { fs.unlinkSync(path.join(os.tmpdir(), `project-state-killpoint-${path.basename(root)}.marker`)); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a killed child before target displacement is inspectable and leaves the target unchanged', async () => {
  const root = tempProject();
  let child;
  try {
    await H.setupGit(root);
    H.excludeLocalFiles(root, ['.env']);
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=snapshot-value\n');
    await snapshot(root, 'crash-before-publish');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=pre-restore-value\n');
    const originalBytes = read(path.join(root, '.env'));
    const cliPath = path.join(__dirname, '..', 'bin', 'project-state.js');
    const marker = path.join(os.tmpdir(), `project-state-before-publish-${path.basename(root)}.marker`);
    const childCode = `const fs=require('fs');const real=fs.promises.rename.bind(fs.promises);fs.promises.rename=async(a,b,...x)=>{if(String(a).endsWith('.env')&&String(b).includes('.previous')){fs.writeFileSync(${JSON.stringify(marker)},String(b));setInterval(()=>{},1000);await new Promise(()=>{})}return real(a,b,...x)};process.argv=[process.execPath,${JSON.stringify(cliPath)},'restore','crash-before-publish','--yes'];require(${JSON.stringify(cliPath)});`;
    child = spawn(process.execPath, ['-e', childCode], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const childClosed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !fs.existsSync(marker)) {
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(marker), 'child reached the target-displacement boundary after the prepared journal');
    const displacedPath = fs.readFileSync(marker, 'utf8').trim();
    assert.ok(path.relative(path.join(root, '.project-state'), displacedPath).split(path.sep)[0] !== '..');
    assert.deepEqual(read(path.join(root, '.env')), originalBytes, 'business target is unchanged before displacement');
    assert.equal(child.kill(), true);
    assert.equal((await childClosed).signal, 'SIGTERM');
    const journalFile = fs.readdirSync(path.join(root, '.project-state', 'operations')).map((file) => path.join(root, '.project-state', 'operations', file)).find((file) => {
      const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
      return journal.phase === 'applying' && journal.pendingTemp?.path;
    });
    assert.ok(journalFile, 'prepared private temp is referenced by an in-progress operation journal');
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    assert.equal(journal.pendingTemp.phase, 'prepared');
    const stagedPath = path.resolve(root, '.project-state', ...journal.pendingTemp.path.split('/'));
    assert.equal(fs.existsSync(stagedPath), true, 'the exact staged bytes remain private and available for inspection');
    const operationId = path.basename(journalFile, '.json');
    const recovered = await H.cli(root, ['recover', operationId, '--compensate', '--yes']);
    assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
    assert.deepEqual(read(path.join(root, '.env')), originalBytes);
    assert.equal(fs.existsSync(stagedPath), false, `verified compensation removes only the exact staged file; output=${recovered.stdout}\n${recovered.stderr}; journal=${JSON.stringify(await Store.readJournal(root, Store.operationJournalPath(root, operationId)))}`);
  } finally {
    if (child && child.exitCode === null) child.kill();
    try { fs.unlinkSync(path.join(os.tmpdir(), `project-state-before-publish-${path.basename(root)}.marker`)); } catch {}
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a prepared-journal failure removes only the exact private staged secret before returning', async () => {
  const root = tempProject();
  const originalWrite = Store.writeOperationJournal;
  let injected = false;
  try {
    await H.setupGit(root);
    H.excludeLocalFiles(root, ['.env']);
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=SAVED_PRIVATE_MARKER\n');
    await snapshot(root, 'saved');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=BEFORE_PRIVATE_MARKER\n');
    Store.writeOperationJournal = async (...args) => {
      if (!injected && args[2]?.pendingTemp?.phase === 'prepared') {
        injected = true;
        throw Object.assign(new Error('injected prepared-journal failure'), { code: 'EIO' });
      }
      return originalWrite(...args);
    };
    let result;
    try { result = await restoreInternal(root, 'saved', { yes: true }); }
    catch (error) { result = error.restoreResult; }
    assert.equal(injected, true, 'the failure occurred after private staging but before target rename');
    assert.equal(result.status, 'failed-rolled-back');
    assert.deepEqual(read(path.join(root, '.env')), Buffer.from('TOKEN=BEFORE_PRIVATE_MARKER\n'));
    const staging = path.join(root, '.project-state', 'staging');
    const leftovers = [];
    for (const operation of fs.readdirSync(staging)) {
      const privateDir = path.join(staging, operation, 'private');
      if (fs.existsSync(privateDir)) leftovers.push(...fs.readdirSync(privateDir).filter((name) => name.startsWith('restore-')));
    }
    assert.deepEqual(leftovers, [], 'the tool-created private temp was removed after its identity was checked');
    const others = (await H.git(root, ['ls-files', '--others', '--exclude-standard'])).trim();
    assert.doesNotMatch(others, /restore-.*\.tmp/i, 'no secret-bearing staging file can be added by git add -A');
  } finally {
    Store.writeOperationJournal = originalWrite;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('interrupted multi-file recovery preserves an externally changed target not yet applied', async () => {
  const root = tempProject();
  let child;
  try {
    await H.setupGit(root);
    H.excludeLocalFiles(root, ['.env', '.env.local']);
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=first-snapshot\n');
    fs.writeFileSync(path.join(root, '.env.local'), 'MODE=first-snapshot\n');
    await snapshot(root, 'crash-multi-file');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=pre-restore\n');
    fs.writeFileSync(path.join(root, '.env.local'), 'MODE=pre-restore\n');
    const originalEnv = read(path.join(root, '.env'));
    const externalLocal = Buffer.from('MODE=external-writer\n');
    const cliPath = path.join(__dirname, '..', 'bin', 'project-state.js');
    const marker = path.join(os.tmpdir(), `project-state-multi-file-${path.basename(root)}.marker`);
    const childCode = `const fs=require('fs');const real=fs.promises.link.bind(fs.promises);fs.promises.link=async(a,b,...x)=>{const r=await real(a,b,...x);if(String(a).includes('staging')&&String(b).endsWith('.env')){fs.writeFileSync(${JSON.stringify(marker)},'published');setInterval(()=>{},1000);await new Promise(()=>{})}return r};process.argv=[process.execPath,${JSON.stringify(cliPath)},'restore','crash-multi-file','--yes'];require(${JSON.stringify(cliPath)});`;
    child = spawn(process.execPath, ['-e', childCode], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
    const childClosed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !fs.existsSync(marker)) {
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(marker), 'the first target was published before the process termination');
    child.kill();
    assert.equal((await childClosed).signal, 'SIGTERM');
    fs.writeFileSync(path.join(root, '.env.local'), externalLocal);
    const operationFile = fs.readdirSync(path.join(root, '.project-state', 'operations')).map((file) => path.join(root, '.project-state', 'operations', file)).find((file) => {
      const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
      return journal.phase === 'applying' && journal.pendingTarget?.target === '.env';
    });
    assert.ok(operationFile);
    const operationId = path.basename(operationFile, '.json');
    const recovered = await H.cli(root, ['recover', operationId, '--compensate', '--yes']);
    assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
    assert.deepEqual(read(path.join(root, '.env')), originalEnv, 'the already-published target is restored from the safety generation');
    assert.deepEqual(read(path.join(root, '.env.local')), externalLocal, 'a not-yet-applied target changed by another process is preserved');
  } finally {
    if (child && child.exitCode === null) child.kill();
    try { fs.unlinkSync(path.join(os.tmpdir(), `project-state-multi-file-${path.basename(root)}.marker`)); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a killed child in verifying phase can be compensated from durable applied records', async () => {
  const root = tempProject();
  let child;
  try {
    await H.setupGit(root);
    H.excludeLocalFiles(root, ['.env']);
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=verified-target\n');
    await snapshot(root, 'crash-verifying');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=pre-restore\n');
    const originalBytes = read(path.join(root, '.env'));
    const cliPath = path.join(__dirname, '..', 'bin', 'project-state.js');
    const marker = path.join(os.tmpdir(), `project-state-verifying-${path.basename(root)}.marker`);
    const childCode = `const fs=require('fs');const S=require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'storage.js'))});const real=S.writeOperationJournal.bind(S);S.writeOperationJournal=async(root,lock,data)=>{const out=await real(root,lock,data);if(data.phase==='verifying'){fs.writeFileSync(${JSON.stringify(marker)},data.operationId);setInterval(()=>{},1000);await new Promise(()=>{})}return out};process.argv=[process.execPath,${JSON.stringify(cliPath)},'restore','crash-verifying','--yes'];require(${JSON.stringify(cliPath)});`;
    child = spawn(process.execPath, ['-e', childCode], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
    const childClosed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !fs.existsSync(marker)) {
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(marker), 'child terminated after the durable verifying journal write');
    const operationId = fs.readFileSync(marker, 'utf8').trim();
    assert.notDeepEqual(read(path.join(root, '.env')), originalBytes);
    child.kill();
    assert.equal((await childClosed).signal, 'SIGTERM');
    const journal = await Store.readJournal(root, Store.operationJournalPath(root, operationId));
    assert.equal(journal.phase, 'verifying');
    assert.equal(journal.appliedTargets.length, 1);
    const recovery = await H.cli(root, ['recover', operationId, '--compensate', '--yes']);
    assert.equal(recovery.status, 0, `${recovery.stdout}\n${recovery.stderr}`);
    assert.deepEqual(read(path.join(root, '.env')), originalBytes);
  } finally {
    if (child && child.exitCode === null) child.kill();
    try { fs.unlinkSync(path.join(os.tmpdir(), `project-state-verifying-${path.basename(root)}.marker`)); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a child killed during compensation remains fail-closed and keeps the durable safety pin', async () => {
  const root = tempProject();
  const marker = path.join(os.tmpdir(), `project-state-compensating-${path.basename(root)}.marker`);
  let child;
  try {
    await H.setupGit(root);
    H.excludeLocalFiles(root, ['.env']);
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=snapshot-value\n');
    await snapshot(root, 'compensating-kill');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=pre-restore-value\n');
    const originalBytes = read(path.join(root, '.env'));
    const cliPath = path.resolve(__dirname, '..', 'bin', 'project-state.js');
    const storagePath = path.resolve(__dirname, '..', 'lib', 'storage.js');
    const targetPath = path.resolve(root, '.env');
    const code = `const fs=require('fs');const path=require('path');const S=require(${JSON.stringify(storagePath)});const realJournal=S.writeOperationJournal.bind(S);let failed=false;S.writeOperationJournal=async(...args)=>{const result=await realJournal(...args);const data=args[2];if(!failed&&data.phase==='applying'&&data.appliedTargets?.length){failed=true;throw Object.assign(new Error('injected failure after applied-target journal'),{code:'EIO'})}return result};const realLink=fs.promises.link.bind(fs.promises);let targetPublishes=0;fs.promises.link=async(from,to,...args)=>{const result=await realLink(from,to,...args);if(path.resolve(String(to))===${JSON.stringify(targetPath)}&&String(from).includes(path.join('.project-state','staging'))){targetPublishes++;if(targetPublishes===2){fs.writeFileSync(${JSON.stringify(marker)},'compensated');setInterval(()=>{},1000);await new Promise(()=>{})}}return result};process.argv=[process.execPath,${JSON.stringify(cliPath)},'restore','compensating-kill','--yes'];require(${JSON.stringify(cliPath)});`;
    child = spawn(process.execPath, ['-e', code], { cwd: root, stdio: 'ignore' });
    const closed = new Promise((resolve) => child.once('close', (_code, signal) => resolve(signal)));
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(marker), 'child stopped after compensation had restored the pre-operation bytes');
    child.kill();
    assert.equal(await closed, 'SIGTERM');
    assert.deepEqual(read(path.join(root, '.env')), originalBytes, 'compensation reached the original bytes before termination');
    const operationId = fs.readdirSync(path.join(root, '.project-state', 'operations')).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(root, '.project-state', 'operations', name), 'utf8')))
      .find((journal) => journal.operation === 'restore')?.operationId;
    assert.ok(operationId);
    const journal = await Store.readJournal(root, Store.operationJournalPath(root, operationId));
    assert.equal(journal.phase, 'compensating');
    assert.equal(journal.status, 'in-progress');
    assert.ok((await Store.listPins(root)).some((pin) => pin.pinId === journal.safety.pinId), 'uncertain compensation keeps the exact safety pin');
    const recovery = await H.cli(root, ['recover', operationId, '--compensate', '--yes']);
    assert.equal(recovery.status, 1, `${recovery.stdout}\n${recovery.stderr}`);
    assert.match(recovery.stderr, /interrupted restore journal|safely inspectable/i);
    assert.deepEqual(read(path.join(root, '.env')), originalBytes, 'unsupported compensation retry does not change project bytes');
    assert.equal((await Store.readJournal(root, Store.operationJournalPath(root, operationId))).phase, 'compensating');
    assert.ok((await Store.listPins(root)).some((pin) => pin.pinId === journal.safety.pinId));
  } finally {
    if (child && child.exitCode === null) child.kill();
    try { fs.unlinkSync(marker); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a killed Git checkout window is recognized from durable intent and rolled back exactly', async () => {
  const root = tempProject();
  const marker = path.join(os.tmpdir(), `project-state-git-intent-${path.basename(root)}.marker`);
  let child;
  try {
    await H.setupGit(root, { '.nvmrc': 'BASE\n' });
    await H.git(root, ['config', 'core.autocrlf', 'false']);
    await snapshot(root, 'saved');
    fs.writeFileSync(path.join(root, '.nvmrc'), 'NEW\n');
    await H.git(root, ['add', '.nvmrc']);
    await H.git(root, ['commit', '-m', 'advance before interrupted restore']);
    const originalHead = await head(root);
    const originalBranch = (await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
    const originalRef = (await H.git(root, ['rev-parse', `refs/heads/${originalBranch}`])).trim();
    const originalIndex = (await H.git(root, ['write-tree'])).trim();
    const originalBytes = read(path.join(root, '.nvmrc'));
    const cli = path.resolve(__dirname, '..', 'bin', 'project-state.js');
    const gitModule = path.resolve(__dirname, '..', 'lib', 'restore-git.js');
    const code = `const fs=require('fs');const G=require(${JSON.stringify(gitModule)});const real=G.applyGit;const hold=async()=>{fs.writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000);await new Promise(()=>{})};G.applyGit=async(...a)=>{await real(...a);await hold()};process.argv=[process.execPath,${JSON.stringify(cli)},'restore','saved','--yes'];require(${JSON.stringify(cli)});`;
    child = spawn(process.execPath, ['-e', code], { cwd: root, stdio: 'ignore' });
    const childClosed = new Promise((resolve) => child.once('close', (_code, signal) => resolve(signal)));
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(marker), 'child stopped after checkout and before postGit journal publication');
    child.kill();
    assert.equal(await childClosed, 'SIGTERM');
    const operationFiles = fs.readdirSync(path.join(root, '.project-state', 'operations')).filter((name) => name.endsWith('.json'));
    const journal = operationFiles.map((name) => JSON.parse(fs.readFileSync(path.join(root, '.project-state', 'operations', name), 'utf8'))).find((candidate) => candidate.operation === 'restore');
    assert.ok(journal, 'restore operation journal exists');
    assert.ok(journal.gitIntent?.expectedGit, 'durable Git intent identifies the exact planned HEAD, branch and index tree');
    assert.deepEqual(journal.gitIntent.targets, ['.nvmrc']);
    assert.equal(journal.postGit.head, originalHead.toLowerCase(), 'postGit is deliberately still the pre-checkout state');
    const recovered = await H.cli(root, ['recover', journal.operationId, '--compensate', '--yes']);
    assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
    assert.equal(await head(root), originalHead);
    assert.equal((await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), originalBranch);
    assert.equal((await H.git(root, ['rev-parse', `refs/heads/${originalBranch}`])).trim(), originalRef);
    assert.equal((await H.git(root, ['write-tree'])).trim(), originalIndex);
    assert.deepEqual(read(path.join(root, '.nvmrc')), originalBytes);
  } finally {
    if (child && child.exitCode === null) child.kill();
    try { fs.unlinkSync(marker); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a killed completed-journal rename is reconciled from its exact validated operation temp', async () => {
  const root = tempProject();
  const marker = path.join(os.tmpdir(), `project-state-journal-temp-${path.basename(root)}.marker`);
  let child;
  try {
    await H.setupGit(root);
    H.excludeLocalFiles(root, ['.env']);
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=SAVED\n');
    await snapshot(root, 'saved');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=BEFORE\n');
    const before = read(path.join(root, '.env'));
    const cli = path.resolve(__dirname, '..', 'bin', 'project-state.js');
    const code = `const fs=require('fs');const real=fs.promises.rename.bind(fs.promises);fs.promises.rename=async(a,b,...rest)=>{if(String(a).includes('operations')&&String(a).endsWith('.tmp')&&String(b).endsWith('.json')){let data;try{data=JSON.parse(fs.readFileSync(a,'utf8'))}catch{}if(data?.terminalOutcome==='verified-complete'&&data?.status==='completed'){fs.writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000);await new Promise(()=>{})}}return real(a,b,...rest)};process.argv=[process.execPath,${JSON.stringify(cli)},'restore','saved','--yes'];require(${JSON.stringify(cli)});`;
    child = spawn(process.execPath, ['-e', code], { cwd: root, stdio: 'ignore' });
    const childClosed = new Promise((resolve) => child.once('close', (_code, signal) => resolve(signal)));
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(marker), 'child stopped after writing the terminal journal temp and before rename');
    child.kill();
    assert.equal(await childClosed, 'SIGTERM');
    const tempEntries = fs.readdirSync(path.join(root, '.project-state', 'operations')).filter((name) => name.endsWith('.tmp'));
    assert.equal(tempEntries.length, 1, 'only the exact owned journal temp remains');
    const parsed = JSON.parse(fs.readFileSync(path.join(root, '.project-state', 'operations', tempEntries[0]), 'utf8'));
    const recovery = await H.cli(root, ['recover', parsed.operationId, '--compensate', '--yes']);
    assert.equal(recovery.status, 0, `${recovery.stdout}\n${recovery.stderr}`);
    assert.deepEqual(read(path.join(root, '.env')), before, 'the printed rollback path restores the actual pre-restore bytes');
    assert.equal(fs.readdirSync(path.join(root, '.project-state', 'operations')).some((name) => name.endsWith('.tmp')), false, 'the exact journal temp was reconciled');
    const resolved = await Store.readJournal(root, Store.operationJournalPath(root, parsed.operationId));
    assert.equal(resolved.terminalOutcome, 'resolved-by-rollback');
  } finally {
    if (child && child.exitCode === null) child.kill();
    try { fs.unlinkSync(marker); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a verified rollback with pin cleanup failure retains its pin and a new CLI process retries idempotently', async () => {
  const state = await restoreWithRollbackToken();
  const originalUnlink = fs.promises.unlink;
  try {
    const originalJournal = await Store.readJournal(state.root, Store.operationJournalPath(state.root, state.operationId));
    const exactPin = path.resolve(state.root, '.project-state', 'pins', originalJournal.safety.name, originalJournal.safety.generation, `${originalJournal.safety.pinId}.json`);
    fs.promises.unlink = async (target, ...args) => {
      if (path.resolve(String(target)) === exactPin) throw Object.assign(new Error('injected EACCES after original journal resolution'), { code: 'EACCES' });
      return originalUnlink.call(fs.promises, target, ...args);
    };
    const result = await restoreInternal(state.root, state.safetyName, { yes: true, rollbackOf: state.operationId });
    fs.promises.unlink = originalUnlink;
    assert.equal(result.status, 'restored-verified', 'pin cleanup failure does not trigger compensating the verified business result');
    assert.equal(result.cleanupPending?.length, 1);
    assert.deepEqual(read(path.join(state.root, '.nvmrc')), state.beforeBytes);
    const resolved = await Store.readJournal(state.root, Store.operationJournalPath(state.root, result.operationId));
    assert.equal(resolved.terminalOutcome, 'verified-complete', 'the rollback operation remains terminal and truthful');
    assert.ok(resolved.cleanupPending?.some((item) => item.kind === 'resolve-original-safety-pin'));
    const partiallyCleanedOriginal = await Store.readJournal(state.root, Store.operationJournalPath(state.root, state.operationId));
    assert.equal(partiallyCleanedOriginal.terminalOutcome, 'resolved-by-rollback', 'the original journal commit happened before the injected unlink failure');
    assert.equal(partiallyCleanedOriginal.resolvedBy, result.operationId);
    assert.ok((await Store.listPins(state.root)).some((pin) => pin.pinId === originalJournal.safety.pinId), 'failed cleanup retains the original safety pin');
    const retried = await H.cli(state.root, ['recover', result.operationId, '--cleanup', '--yes']);
    assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.match(retried.stdout, /cleanup completed/i);
    const originalAfter = await Store.readJournal(state.root, Store.operationJournalPath(state.root, state.operationId));
    assert.equal(originalAfter.terminalOutcome, 'resolved-by-rollback');
    assert.equal(originalAfter.resolvedBy, result.operationId);
    assert.ok(!(await Store.listPins(state.root)).some((pin) => pin.pinId === originalJournal.safety.pinId), 'only the exact original pin is released');
    const resolverAfter = await Store.readJournal(state.root, Store.operationJournalPath(state.root, result.operationId));
    assert.deepEqual(resolverAfter.cleanupPending, []);
    const repeated = await H.cli(state.root, ['recover', result.operationId, '--cleanup', '--yes']);
    assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
    assert.match(repeated.stdout, /no pending cleanup/i);
  } finally {
    fs.promises.unlink = originalUnlink;
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('a process killed after pin unlink retries the durable cleanup intent in a fresh CLI process', async () => {
  const state = await restoreWithRollbackToken();
  const marker = path.join(os.tmpdir(), `project-state-pin-unlinked-${path.basename(state.root)}.marker`);
  let child;
  try {
    const originalJournal = await Store.readJournal(state.root, Store.operationJournalPath(state.root, state.operationId));
    const exactPin = path.resolve(state.root, '.project-state', 'pins', originalJournal.safety.name, originalJournal.safety.generation, `${originalJournal.safety.pinId}.json`);
    const cli = path.resolve(__dirname, '..', 'bin', 'project-state.js');
    const code = `const fs=require('fs');const real=fs.promises.unlink.bind(fs.promises);fs.promises.unlink=async(target,...args)=>{const result=await real(target,...args);if(path.resolve(String(target))===${JSON.stringify(exactPin)}){fs.writeFileSync(${JSON.stringify(marker)},'unlinked');setInterval(()=>{},1000);await new Promise(()=>{})}return result};const path=require('path');process.argv=[process.execPath,${JSON.stringify(cli)},'restore',${JSON.stringify(state.safetyName)},'--yes','--rollback-of',${JSON.stringify(state.operationId)}];require(${JSON.stringify(cli)});`;
    child = spawn(process.execPath, ['-e', code], { cwd: state.root, stdio: 'ignore' });
    const closed = new Promise((resolve) => child.once('close', (_code, signal) => resolve(signal)));
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(marker), 'the child removed the original exact pin after the durable intent was written');
    child.kill();
    assert.equal(await closed, 'SIGTERM');
    const resolverId = fs.readdirSync(path.join(state.root, '.project-state', 'operations')).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(state.root, '.project-state', 'operations', name), 'utf8')))
      .find((journal) => journal.resolvesOperationId === state.operationId)?.operationId;
    assert.ok(resolverId, 'resolver terminal journal remains after process death');
    const beforeRetry = await Store.readJournal(state.root, Store.operationJournalPath(state.root, resolverId));
    assert.ok(beforeRetry.cleanupPending?.some((item) => item.kind === 'resolve-original-safety-pin'), 'the cleanup intent was persisted before unlink');
    assert.equal(await Store.isGenerationProtected(state.root, originalJournal.safety.name, originalJournal.safety.generation), true, 'the durable cleanup intent protects its generation after pin unlink');
    const retried = await H.cli(state.root, ['recover', resolverId, '--cleanup', '--yes']);
    assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
    const originalAfter = await Store.readJournal(state.root, Store.operationJournalPath(state.root, state.operationId));
    assert.equal(originalAfter.terminalOutcome, 'resolved-by-rollback');
    assert.equal(originalAfter.resolvedBy, resolverId);
    assert.equal((await Store.listPins(state.root)).some((pin) => pin.pinId === originalJournal.safety.pinId), false, 'retry recognizes the already unlinked exact pin');
    assert.deepEqual((await Store.readJournal(state.root, Store.operationJournalPath(state.root, resolverId))).cleanupPending, []);
    assert.equal(await Store.isGenerationProtected(state.root, originalJournal.safety.name, originalJournal.safety.generation), false, 'the completed cleanup intent no longer protects an otherwise unpinned generation');
  } finally {
    if (child && child.exitCode === null) child.kill();
    try { fs.unlinkSync(marker); } catch {}
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('C01 a Git checkout interruption only compensates targets with durable file-step proof', async () => {
  const root = tempProject();
  let child;
  const marker = path.join(os.tmpdir(), `project-state-c01-${path.basename(root)}.marker`);
  try {
    await H.setupGit(root);
    H.excludeLocalFiles(root, ['.env', '.env.local']);
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=saved-value\n');
    fs.writeFileSync(path.join(root, '.env.local'), 'LOCAL=saved-value\n');
    await snapshot(root, 'c01-source');
    const snapshotHead = await head(root);
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=pre-restore-value\n');
    fs.writeFileSync(path.join(root, '.env.local'), 'LOCAL=pre-restore-value\n');
    fs.writeFileSync(path.join(root, 'app.js'), 'advance();\n');
    await H.git(root, ['add', 'app.js']);
    await H.git(root, ['commit', '-m', 'advance for C01']);
    const preHead = await head(root);
    const preIndex = (await H.git(root, ['write-tree'])).trim();
    const preRefs = (await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim();
    const interruptedHead = await head(root);
    const cliPath = path.resolve(__dirname, '..', 'bin', 'project-state.js');
    const storagePath = path.resolve(__dirname, '..', 'lib', 'storage.js');
    const code = `const fs=require('fs');const S=require(${JSON.stringify(storagePath)});const write=S.writeOperationJournal.bind(S);S.writeOperationJournal=async(...args)=>{const out=await write(...args);const d=args[2];if(d.phase==='applying'&&d.pendingTarget===null&&d.appliedTargets?.length===1){fs.writeFileSync(${JSON.stringify(marker)},'first-file-applied');setInterval(()=>{},1000);await new Promise(()=>{})}return out};process.argv=[process.execPath,${JSON.stringify(cliPath)},'restore','c01-source','--yes'];require(${JSON.stringify(cliPath)});`;
    child = spawn(process.execPath, ['-e', code], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const closed = new Promise((resolve) => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !fs.existsSync(marker) && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(marker), `restore child reached the first applied-file journal window: ${output}`);
    const operations = path.join(root, '.project-state', 'operations');
    const journalFiles = fs.readdirSync(operations).filter((n) => n.endsWith('.json'));
    const killJournal = journalFiles.map((name) => JSON.parse(fs.readFileSync(path.join(operations, name), 'utf8')))
      .find((journal) => journal.operation === 'restore' && journal.phase === 'applying')?.operationId;
    assert.ok(killJournal, 'the restore journal is selected by operation identity and phase');
    assert.equal(child.kill(), true);
    assert.equal((await closed).signal, 'SIGTERM');
    const journalName = fs.readdirSync(operations).find((n) => n.endsWith('.json') && JSON.parse(fs.readFileSync(path.join(operations, n), 'utf8')).operationId === killJournal);
    const journal = await Store.readJournal(root, path.join(operations, journalName));
    assert.ok(journal.gitIntent, 'Git checkout intent was durably recorded');
    assert.deepEqual(journal.appliedTargets.map((item) => item.target), ['.env']);
    const external = Buffer.from('LOCAL=external-after-crash\n');
    fs.writeFileSync(path.join(root, '.env.local'), external);
    const recovery = await H.cli(root, ['recover', killJournal, '--compensate', '--yes']);
    assert.equal(recovery.status, 0, `${recovery.stdout}\n${recovery.stderr}`);
    assert.deepEqual(read(path.join(root, '.env')), Buffer.from('TOKEN=pre-restore-value\n'), 'the operation-applied first file is compensated');
    assert.deepEqual(read(path.join(root, '.env.local')), external, 'an external edit to the never-applied file is preserved');
    assert.equal(await head(root), preHead, 'Git checkout is compensated to its pre-restore HEAD');
    assert.equal((await H.git(root, ['write-tree'])).trim(), preIndex, 'index is unchanged');
    assert.equal((await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(), preRefs, 'refs are unchanged');
    assert.notEqual(interruptedHead, snapshotHead, 'fixture included a real Git checkout transition');
  } finally {
    if (child && child.exitCode === null) child.kill();
    try { fs.unlinkSync(marker); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C05 a post-commit result-read failure cannot compensate a resolved rollback', async () => {
  const state = await restoreWithRollbackToken();
  const originalComplete = Store.completeCleanupAction;
  const originalLstat = fs.promises.lstat;
  let injectReadFailure = false;
  let unexpectedPostCommitRead = false;
  try {
    Store.completeCleanupAction = async (...args) => {
      const result = await originalComplete(...args);
      if (args[1]?.action?.kind === 'resolve-original-safety-pin') injectReadFailure = true;
      return result;
    };
    fs.promises.lstat = async function(target, ...args) {
      if (injectReadFailure && path.resolve(String(target)) === path.join(state.root, '.nvmrc')) {
        unexpectedPostCommitRead = true;
        throw Object.assign(new Error('injected EIO at the former post-commit final read'), { code: 'EIO' });
      }
      return originalLstat.call(fs.promises, target, ...args);
    };
    const result = await restoreInternal(state.root, state.safetyName, { yes: true, rollbackOf: state.operationId });
    assert.equal(result.status, 'restored-verified');
    assert.equal(unexpectedPostCommitRead, false, 'file result bytes were verified before the durable commit; no post-commit target read can enter compensation');
    assert.deepEqual(read(path.join(state.root, '.nvmrc')), state.beforeBytes, 'committed rollback bytes remain in place');
    const original = await Store.readJournal(state.root, Store.operationJournalPath(state.root, state.operationId));
    const resolver = await Store.readJournal(state.root, Store.operationJournalPath(state.root, result.operationId));
    assert.equal(original.terminalOutcome, 'resolved-by-rollback');
    assert.equal(original.resolvedBy, result.operationId);
    assert.equal(resolver.terminalOutcome, 'verified-complete');
    assert.deepEqual(resolver.cleanupPending, []);
    assert.equal((await Store.listPins(state.root)).some((pin) => pin.pinId === original.safety.pinId), false, 'only the resolved operation safety pin is released');
    const repeated = await H.cli(state.root, ['restore', state.safetyName, '--yes', '--rollback-of', state.operationId]);
    assert.equal(repeated.status, 1, 'the resolved original operation is no longer eligible for rollback retry');
    assert.deepEqual(read(path.join(state.root, '.nvmrc')), state.beforeBytes, 'retry refusal preserves the committed rollback result');
  } finally {
    Store.completeCleanupAction = originalComplete;
    fs.promises.lstat = originalLstat;
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('C04 effective .git/info attributes refuse configured filters before restore mutation', async () => {
  const root = tempProject();
  const marker = path.join(root, 'external-filter-ran.marker');
  try {
    await H.setupGit(root, { 'app.js': 'saved();\n' });
    await snapshot(root, 'filter-boundary');
    fs.writeFileSync(path.join(root, 'app.js'), 'current();\n');
    await H.git(root, ['add', 'app.js']);
    await H.git(root, ['commit', '-m', 'advance before filter refusal']);
    const beforeBytes = read(path.join(root, 'app.js'));
    const beforeHead = await head(root);
    const beforeIndex = (await H.git(root, ['write-tree'])).trim();
    const beforeRefs = (await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim();
    fs.appendFileSync(path.join(root, '.git', 'info', 'attributes'), '\napp.js filter=review-marker\n');
    const command = `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');process.stdin.pipe(process.stdout)"`;
    await H.git(root, ['config', 'filter.review-marker.smudge', command]);
    const restore = await H.cli(root, ['restore', 'filter-boundary', '--yes']);
    assert.equal(restore.status, 1, `${restore.stdout}\n${restore.stderr}`);
    assert.match(restore.stderr, /external content filter/i);
    assert.equal(fs.existsSync(marker), false, 'the configured smudge command was not executed');
    assert.deepEqual(read(path.join(root, 'app.js')), beforeBytes);
    assert.equal(await head(root), beforeHead);
    assert.equal((await H.git(root, ['write-tree'])).trim(), beforeIndex);
    assert.equal((await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(), beforeRefs);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('S01 filter attributes refuse active drivers and safely handle negative/reset attributes', async (t) => {
  const expressions = ['filter=review-marker', 'filter=unset', 'filter=unspecified', '-filter', '!filter'];
  for (const source of ['info', 'global', 'tree']) {
    for (const expression of expressions) {
      await t.test(`${source}: ${expression}`, async () => {
        const root = tempProject();
        const marker = path.join(root, `filter-${source}-${expressions.indexOf(expression)}.marker`);
        const name = `s01-${source}-${expressions.indexOf(expression)}`;
        try {
          const files = { 'app.js': 'saved();\n' };
          if (source === 'tree') files['.gitattributes'] = `app.js ${expression}\n`;
          await H.setupGit(root, files);
          const savedHead = await head(root);
          const savedIndex = (await H.git(root, ['write-tree'])).trim();
          await snapshot(root, name);
          fs.writeFileSync(path.join(root, 'app.js'), 'current();\n');
          await H.git(root, ['add', 'app.js']);
          await H.git(root, ['commit', '-m', 'advance before filter probe']);
          const driver = expression.match(/^filter=([^ ]+)$/)?.[1];
          if (source === 'info') fs.writeFileSync(path.join(root, '.git', 'info', 'attributes'), `app.js ${expression}\n`);
          if (source === 'global') {
            const attributes = path.join(root, '.git', 'global-attributes');
            const globalConfig = path.join(root, '.git', 'global.config');
            fs.writeFileSync(attributes, `app.js ${expression}\n`);
            await H.git(root, ['config', '--file', globalConfig, 'core.attributesFile', attributes]);
          }
          if (driver) {
            const markerArg = marker.replaceAll('\\', '/');
            const command = `node -e "require('fs').writeFileSync('${markerArg}', 'executed');process.stdin.pipe(process.stdout)"`;
            await H.git(root, ['config', `filter.${driver}.smudge`, command]);
            const processCommand = `node -e "require('fs').writeFileSync('${markerArg}', 'executed');process.exit(0)"`;
            await H.git(root, ['config', `filter.${driver}.process`, processCommand]);
          }
          const env = source === 'global' ? { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, '.git', 'global.config') } : process.env;
          const before = {
            bytes: read(path.join(root, 'app.js')),
            head: await head(root),
            index: (await H.git(root, ['write-tree'])).trim(),
            refs: (await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(),
          };
          const result = await H.cli(root, ['restore', name, '--yes'], env);
          assert.ok([0, 1].includes(result.status), `${result.stdout}\n${result.stderr}`);
          assert.equal(fs.existsSync(marker), false, 'no configured filter command executed');
          if (driver) {
            assert.equal(result.status, 1, 'an explicitly named filter driver is refused even when its name is unset/unspecified');
            assert.match(result.stderr, /external content filter/i);
            assert.deepEqual(read(path.join(root, 'app.js')), before.bytes, 'refusal leaves business file bytes unchanged');
            assert.equal(await head(root), before.head);
            assert.equal((await H.git(root, ['write-tree'])).trim(), before.index);
          } else {
            assert.equal(result.status, 0, 'negative and reset attributes may proceed when no filter is selected');
            assert.equal(read(path.join(root, 'app.js')).toString('utf8').replace(/\r\n/g, '\n'), 'saved();\n');
            assert.equal(await head(root), savedHead);
            assert.equal((await H.git(root, ['write-tree'])).trim(), savedIndex);
          }
          assert.equal((await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(), before.refs);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
      });
    }
  }
});

test('C04 global attributes and saved-tree attributes are included in effective filter checks', async () => {
  for (const source of ['global', 'tree']) {
    const root = tempProject();
    const marker = path.join(root, `filter-${source}-executed.marker`);
    try {
      const initial = source === 'tree' ? { 'app.js': 'saved();\n', '.gitattributes': 'app.js filter=review-marker\n' } : { 'app.js': 'saved();\n' };
      await H.setupGit(root, initial);
      await snapshot(root, `filter-${source}`);
      fs.writeFileSync(path.join(root, 'app.js'), 'current();\n');
      await H.git(root, ['add', 'app.js']);
      await H.git(root, ['commit', '-m', `advance before ${source} filter refusal`]);
      const before = read(path.join(root, 'app.js'));
      const command = `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');process.stdin.pipe(process.stdout)"`;
      await H.git(root, ['config', 'filter.review-marker.smudge', command]);
      let env = process.env;
      if (source === 'global') {
        const globalConfig = path.join(root, '.git', 'global.config');
        const attributes = path.join(root, '.git', 'global-attributes');
        fs.writeFileSync(attributes, 'app.js filter=review-marker\n');
        const configResult = await new Promise((resolve, reject) => require('child_process').execFile('git', ['config', '--file', globalConfig, 'core.attributesFile', attributes], { cwd: root }, (error) => error ? reject(error) : resolve()));
        void configResult;
        env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
      }
      const result = await H.cli(root, ['restore', `filter-${source}`, '--yes'], env);
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /external content filter/i);
      assert.equal(fs.existsSync(marker), false, `${source} filter command was not executed`);
      assert.deepEqual(read(path.join(root, 'app.js')), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('C04 a filter introduced after checkout blocks compensating checkout and retains its safety pin', async () => {
  const root = tempProject();
  const marker = path.join(root, 'compensation-filter-ran.marker');
  const Git = require('../lib/restore-git');
  const realApply = Git.applyGit;
  const realWrite = Store.writeOperationJournal;
  let changed = false;
  let injected = false;
  try {
    await H.setupGit(root, { 'app.js': 'saved();\n' });
    await snapshot(root, 'filter-compensation');
    fs.writeFileSync(path.join(root, 'app.js'), 'current();\n');
    await H.git(root, ['add', 'app.js']);
    await H.git(root, ['commit', '-m', 'advance before compensation filter test']);
    Git.applyGit = async (...args) => {
      const result = await realApply(...args);
      changed = true;
      return result;
    };
    Store.writeOperationJournal = async (...args) => {
      const result = await realWrite(...args);
      if (!injected && changed && args[2]?.postGit) {
        fs.writeFileSync(path.join(root, '.git', 'info', 'attributes'), 'app.js filter=unset\n');
        await H.git(root, ['config', 'filter.unset.process', `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');process.exit(0)"`]);
        injected = true;
        throw Object.assign(new Error('injected failure after Git checkout'), { code: 'EIO' });
      }
      return result;
    };
    await assert.rejects(() => restoreInternal(root, 'filter-compensation', { yes: true }), (error) => {
      assert.equal(error.restoreResult?.status, 'failed-rollback-incomplete');
      assert.match(error.restoreResult?.compensation?.git?.message || '', /external content filter/i);
      return true;
    });
    assert.equal(injected, true);
    assert.equal(fs.existsSync(marker), false, 'compensating checkout refused before invoking the newly introduced filter');
    const journal = fs.readdirSync(path.join(root, '.project-state', 'operations')).map((name) => JSON.parse(fs.readFileSync(path.join(root, '.project-state', 'operations', name), 'utf8'))).find((item) => item.operation === 'restore');
    assert.ok(journal?.safety, 'unresolved restore retains its journaled safety point');
    assert.ok((await Store.listPins(root)).some((pin) => pin.pinId === journal.safety.pinId), 'unverified compensation retains the safety pin');
  } finally {
    Git.applyGit = realApply;
    Store.writeOperationJournal = realWrite;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C08 --only deps validates arguments, preserves unselected targets, and its printed rollback runs in a new process', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root, {
      'package.json': JSON.stringify({ name: 'selective-fixture', version: '1.0.0', dependencies: {} }, null, 2) + '\n',
      'package-lock.json': JSON.stringify({ name: 'selective-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'selective-fixture', version: '1.0.0', dependencies: {} } } }, null, 2) + '\n',
      '.nvmrc': '20.0.0\n',
    });
    H.excludeLocalFiles(root, ['.env']);
    fs.writeFileSync(path.join(root, '.env'), 'DEMO_TOKEN=before\n');
    await snapshot(root, 'selective-deps');
    const savedPackage = read(path.join(root, 'package.json'));
    const savedLock = read(path.join(root, 'package-lock.json'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'selective-fixture', version: '2.0.0', dependencies: {} }, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'selective-fixture', version: '2.0.0', lockfileVersion: 3, packages: { '': { name: 'selective-fixture', version: '2.0.0', dependencies: {} } } }, null, 2) + '\n');
    fs.writeFileSync(path.join(root, '.nvmrc'), '22.0.0\n');
    fs.writeFileSync(path.join(root, '.env'), 'DEMO_TOKEN=after\n');
    await H.git(root, ['add', 'package.json', 'package-lock.json', '.nvmrc']);
    await H.git(root, ['commit', '-m', 'advance selective targets']);
    const beforeHead = await head(root);
    const beforeIndex = (await H.git(root, ['write-tree'])).trim();
    const beforeRefs = (await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim();
    const beforePackage = read(path.join(root, 'package.json'));
    const beforeLock = read(path.join(root, 'package-lock.json'));
    const beforeRuntime = read(path.join(root, '.nvmrc'));
    const beforeEnv = read(path.join(root, '.env'));
    for (const invalid of [[], ['deps,deps'], ['database'], ['deps ']]) {
      const args = ['restore', 'selective-deps'];
      if (invalid.length) args.push('--only', invalid[0]); else args.push('--only');
      const rejected = await H.cli(root, args);
      assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
      assert.match(rejected.stderr, /--only|selection|subset/i);
      assert.deepEqual(read(path.join(root, 'package.json')), beforePackage);
      assert.deepEqual(read(path.join(root, '.nvmrc')), beforeRuntime);
    }
    const repeatedOption = await H.cli(root, ['restore', 'selective-deps', '--only', 'deps', '--only', 'runtime']);
    assert.equal(repeatedOption.status, 1, `${repeatedOption.stdout}\n${repeatedOption.stderr}`);
    assert.match(repeatedOption.stderr, /specified only once/i);
    assert.deepEqual(read(path.join(root, 'package.json')), beforePackage);
    const conflicted = await H.cli(root, ['restore', 'selective-deps', '--only', 'deps', '--rollback-of', '0123456789abcdef0123456789abcdef']);
    assert.equal(conflicted.status, 1);
    assert.deepEqual(read(path.join(root, 'package.json')), beforePackage);
    const dry = await H.cli(root, ['restore', 'selective-deps', '--only', 'deps', '--dry-run']);
    assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
    assert.match(dry.stdout, /"mode": "only"/);
    assert.deepEqual(read(path.join(root, 'package.json')), beforePackage, 'dry-run makes no changes');
    const applied = await H.cli(root, ['restore', 'selective-deps', '--only', 'deps', '--yes']);
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
    assert.deepEqual(read(path.join(root, 'package.json')), savedPackage);
    assert.deepEqual(read(path.join(root, 'package-lock.json')), savedLock);
    assert.deepEqual(read(path.join(root, '.nvmrc')), beforeRuntime, 'unselected runtime remains untouched');
    assert.deepEqual(read(path.join(root, '.env')), beforeEnv, 'unselected config remains untouched');
    assert.equal(await head(root), beforeHead);
    assert.equal((await H.git(root, ['write-tree'])).trim(), beforeIndex);
    assert.equal((await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(), beforeRefs);
    const label = process.platform === 'win32' ? 'Exact rollback command (PowerShell): ' : 'Exact rollback command: ';
    const line = applied.stdout.split(/\r?\n/).find((item) => item.startsWith(label));
    assert.ok(line, `successful selective restore prints rollback command: ${applied.stdout}`);
    const rolledBack = invokeExactRollback(root, line.slice(label.length));
    assert.equal(rolledBack.status, 0, `${rolledBack.stdout}\n${rolledBack.stderr}`);
    assert.deepEqual(read(path.join(root, 'package.json')), beforePackage);
    assert.deepEqual(read(path.join(root, 'package-lock.json')), beforeLock);
    assert.deepEqual(read(path.join(root, '.nvmrc')), beforeRuntime);
    assert.deepEqual(read(path.join(root, '.env')), beforeEnv);

    // The selective rollback intentionally restores the pre-restore worktree,
    // which may be dirty against Git's normalized index on Windows. Commit that
    // exact fixture state before injecting a separate clean selective restore.
    await H.git(root, ['add', 'package.json', 'package-lock.json']);
    await H.git(root, ['commit', '--allow-empty', '-m', 'establish clean selective fault fixture']);
    const preFailure = {
      pkg: read(path.join(root, 'package.json')),
      lock: read(path.join(root, 'package-lock.json')),
      head: await head(root),
      index: (await H.git(root, ['write-tree'])).trim(),
      refs: (await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(),
    };
    const realWriteJournal = Store.writeOperationJournal;
    let injected = false;
    try {
      Store.writeOperationJournal = async (...args) => {
        const written = await realWriteJournal(...args);
        const journal = args[2];
        if (!injected && journal.phase === 'applying' && journal.pendingTarget === null && journal.appliedTargets?.length === 1) {
          injected = true;
          throw Object.assign(new Error('C08 injected after first selected dependency target'), { code: 'EIO' });
        }
        return written;
      };
      await assert.rejects(() => restoreInternal(root, 'selective-deps', { yes: true, onlyLayers: ['deps'] }), (error) => {
        assert.equal(error.restoreResult?.status, 'failed-rolled-back', error.message);
        return true;
      });
    } finally { Store.writeOperationJournal = realWriteJournal; }
    assert.equal(injected, true, 'failure landed after one selected target was published');
    assert.deepEqual(read(path.join(root, 'package.json')), preFailure.pkg);
    assert.deepEqual(read(path.join(root, 'package-lock.json')), preFailure.lock);
    assert.equal(await head(root), preFailure.head);
    assert.equal((await H.git(root, ['write-tree'])).trim(), preFailure.index);
    assert.equal((await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(), preFailure.refs);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('C08 --only deps refuses a mismatched package.json and package-lock pair before writes', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root, {
      'package.json': JSON.stringify({ name: 'mismatch-fixture', version: '1.0.0', dependencies: { marker: '1.0.0' } }, null, 2) + '\n',
      'package-lock.json': JSON.stringify({ name: 'mismatch-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'mismatch-fixture', version: '1.0.0' } } }, null, 2) + '\n',
    });
    await snapshot(root, 'selective-mismatch');
    const beforePkg = read(path.join(root, 'package.json'));
    const beforeLock = read(path.join(root, 'package-lock.json'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'mismatch-fixture', version: '2.0.0', dependencies: {} }, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'mismatch-fixture', version: '2.0.0', lockfileVersion: 3, packages: { '': { name: 'mismatch-fixture', version: '2.0.0', dependencies: {} } } }, null, 2) + '\n');
    await H.git(root, ['add', 'package.json', 'package-lock.json']);
    await H.git(root, ['commit', '-m', 'advance mismatched dependency fixture']);
    const driftPkg = read(path.join(root, 'package.json'));
    const driftLock = read(path.join(root, 'package-lock.json'));
    const result = await H.cli(root, ['restore', 'selective-mismatch', '--only', 'deps', '--yes']);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /disagree on dependencies/i);
    assert.deepEqual(read(path.join(root, 'package.json')), driftPkg);
    assert.deepEqual(read(path.join(root, 'package-lock.json')), driftLock);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cleanup reconciles an original-journal temp killed before its atomic rename', async () => {
  const state = await restoreWithRollbackToken();
  const marker = path.join(os.tmpdir(), `project-state-original-journal-temp-${path.basename(state.root)}.marker`);
  let child;
  try {
    const originalJournal = await Store.readJournal(state.root, Store.operationJournalPath(state.root, state.operationId));
    const cli = path.resolve(__dirname, '..', 'bin', 'project-state.js');
    const code = `const fs=require('fs');const path=require('path');const real=fs.promises.rename.bind(fs.promises);fs.promises.rename=async(from,to,...args)=>{if(String(from).startsWith(${JSON.stringify(path.join(state.root, '.project-state', 'operations', `${state.operationId}.json.`))})&&String(from).endsWith('.tmp')){let data;try{data=JSON.parse(fs.readFileSync(from,'utf8'))}catch{}if(data?.terminalOutcome==='resolved-by-rollback'&&data?.resolvedBy){fs.writeFileSync(${JSON.stringify(marker)},String(data.resolvedBy));setInterval(()=>{},1000);await new Promise(()=>{})}}return real(from,to,...args)};process.argv=[process.execPath,${JSON.stringify(cli)},'restore',${JSON.stringify(state.safetyName)},'--yes','--rollback-of',${JSON.stringify(state.operationId)}];require(${JSON.stringify(cli)});`;
    child = spawn(process.execPath, ['-e', code], { cwd: state.root, stdio: 'ignore' });
    const closed = new Promise((resolve) => child.once('close', (_code, signal) => resolve(signal)));
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(marker), 'child stopped with a resolved original-journal temp before rename');
    const resolverId = fs.readFileSync(marker, 'utf8').trim();
    child.kill();
    assert.equal(await closed, 'SIGTERM');
    const originalTemps = fs.readdirSync(path.join(state.root, '.project-state', 'operations')).filter((name) => name.startsWith(`${state.operationId}.json.`) && name.endsWith('.tmp'));
    assert.equal(originalTemps.length, 1);
    assert.equal(await Store.isGenerationProtected(state.root, originalJournal.safety.name, originalJournal.safety.generation), true, 'cleanup journal protects the safety generation while original journal temp is unresolved');
    const retried = await H.cli(state.root, ['recover', resolverId, '--cleanup', '--yes']);
    assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
    assert.deepEqual(fs.readdirSync(path.join(state.root, '.project-state', 'operations')).filter((name) => name.startsWith(`${state.operationId}.json.`) && name.endsWith('.tmp')), []);
    const originalAfter = await Store.readJournal(state.root, Store.operationJournalPath(state.root, state.operationId));
    assert.equal(originalAfter.terminalOutcome, 'resolved-by-rollback');
    assert.equal(originalAfter.resolvedBy, resolverId);
    assert.equal((await Store.listPins(state.root)).some((pin) => pin.pinId === originalJournal.safety.pinId), false);
  } finally {
    if (child && child.exitCode === null) child.kill();
    try { fs.unlinkSync(marker); } catch {}
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('rollback refuses a same-byte replacement inode and preserves the replacement', async () => {
  const state = await restoreWithRollbackToken();
  try {
    const target = path.join(state.root, '.nvmrc');
    const replacement = path.join(state.root, '.nvmrc.external-replacement');
    fs.writeFileSync(replacement, read(target));
    fs.unlinkSync(target);
    fs.renameSync(replacement, target);
    const replacementBytes = read(target);
    const restoreHead = await head(state.root);
    const index = (await H.git(state.root, ['write-tree'])).trim();
    const rollback = invokeExactRollback(state.root, state.commandLine);
    assert.equal(rollback.status, 1, `${rollback.stdout}\n${rollback.stderr}`);
    assert.match(rollback.stderr, /rollback|changed|proof|state/i);
    assert.equal(await head(state.root), restoreHead);
    assert.equal((await H.git(state.root, ['write-tree'])).trim(), index);
    assert.deepEqual(read(target), replacementBytes, 'same bytes at a different file identity are retained');
    const pin = (await Store.listPins(state.root)).find((entry) => entry.name === state.safetyName);
    assert.ok(pin, 'unverified rollback keeps the safety generation pinned');
  } finally { fs.rmSync(state.root, { recursive: true, force: true }); }
});

test('fault injection after Git checkout compensates file bytes, HEAD, branch attachment, and index tree', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root, { '.nvmrc': 'head-pin\n' });
    await H.git(root, ['config', 'core.autocrlf', 'false']);
    const initialHead = await head(root);
    const initialBranch = (await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
    fs.writeFileSync(path.join(root, '.nvmrc'), 'snapshot-pin\n');
    await snapshot(root, 'rollback-source');
    await H.git(root, ['add', '.nvmrc']);
    await H.git(root, ['commit', '-m', 'commit snapshot pin']);
    const beforeHead = await head(root);
    const beforeBranch = (await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
    const beforeRef = (await H.git(root, ['rev-parse', `refs/heads/${beforeBranch}`])).trim();
    const beforeIndex = (await H.git(root, ['write-tree'])).trim();
    const beforeBytes = read(path.join(root, '.nvmrc'));
    const fsp = fs.promises;
    const realLink = fsp.link;
    let inject = true;
    fsp.link = async (from, to, ...args) => {
      if (inject && String(from).includes('staging') && String(from).includes('restore-') && String(to).endsWith('.nvmrc')) {
        inject = false;
        const error = new Error('injected destination publication failure');
        error.code = 'EIO';
        throw error;
      }
      return realLink.call(fsp, from, to, ...args);
    };
    const errors = [];
    const realError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    let code;
    try { code = await restoreCmd(root, 'rollback-source', { yes: true }); }
    finally { fsp.link = realLink; console.error = realError; }

    assert.equal(code, 2, errors.join('\n'));
    assert.match(errors.join('\n'), /local compensation verified/i);
    assert.equal(await head(root), beforeHead);
    assert.equal((await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), beforeBranch);
    assert.equal((await H.git(root, ['rev-parse', `refs/heads/${beforeBranch}`])).trim(), beforeRef);
    assert.equal((await H.git(root, ['write-tree'])).trim(), beforeIndex);
    assert.deepEqual(read(path.join(root, '.nvmrc')), beforeBytes);
    assert.notEqual(beforeHead, initialHead);
    const pins = await Store.listPins(root);
    assert.ok(pins.some((entry) => entry.reason === 'rollback-needed' && entry.name.startsWith('auto-')),
      'failed operation keeps its exact auto safety generation persistently pinned after lock release');
    const autoPin = pins.find((entry) => entry.reason === 'rollback-needed' && entry.name.startsWith('auto-'));
    await Store.validateSnapshot(root, autoPin.name, { mode: 'restore' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F08 corrupt required layer artifact is rejected before changing project state', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root);
    const checked = await snapshot(root, 'saved');
    const gitArtifact = checked.artifacts.find((a) => a.id === 'layer:git');
    assert.ok(gitArtifact, 'fixture snapshot has a required Git layer artifact');
    fs.writeFileSync(path.join(root, 'app.js'), 'different but clean\n');
    await H.git(root, ['add', 'app.js']);
    await H.git(root, ['commit', '-m', 'change current state']);
    const beforeHead = await head(root);
    const beforeIndex = (await H.git(root, ['write-tree'])).trim();
    const beforeBranch = (await H.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    const beforeRefs = (await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim();
    const beforeBytes = read(path.join(root, 'app.js'));
    fs.appendFileSync(gitArtifact.absolutePath, 'tamper');

    const r = await H.cli(root, ['restore', 'saved', '--yes']);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /integrity mismatch|size\/hash mismatch/i);
    assert.equal(await head(root), beforeHead);
    assert.equal((await H.git(root, ['write-tree'])).trim(), beforeIndex, 'corrupt input is rejected before index changes');
    assert.equal((await H.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim(), beforeBranch, 'corrupt input is rejected before HEAD attachment changes');
    assert.equal((await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(), beforeRefs, 'corrupt input is rejected before refs change');
    assert.deepEqual(read(path.join(root, 'app.js')), beforeBytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('private config artifact is refused when target commit tracks its destination, including dry-run', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root);
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=private-value\n');
    H.excludeLocalFiles(root, ['.env']);
    const checked = await snapshot(root, 'tracked-env');
    const configArtifact = checked.artifacts.find((artifact) => artifact.layer === 'config' && artifact.kind === 'file'
      && artifact.privacy === 'private' && artifact.target === '.env');
    assert.ok(configArtifact, 'CLI snapshot uses the declared private-file artifact format');

    // The collector correctly refuses to capture a currently tracked .env.
    // Model a valid but adversarial v2 snapshot whose Git layer targets a
    // later commit that tracks the same private destination.
    await H.git(root, ['add', '-f', '.env']);
    await H.git(root, ['commit', '-m', 'track env after private capture']);
    const beforeHead = await head(root);
    const branch = (await H.git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
    const gitArtifact = checked.artifacts.find((artifact) => artifact.id === 'layer:git');
    const gitData = JSON.parse(fs.readFileSync(gitArtifact.absolutePath, 'utf8'));
    gitData.commit = beforeHead;
    gitData.branch = branch;
    gitData.detached = false;
    gitData.dirty = false;
    const gitBytes = Buffer.from(JSON.stringify(gitData));
    fs.writeFileSync(gitArtifact.absolutePath, gitBytes);
    const paths = Store.snapshotPaths(root, 'tracked-env', checked.generation);
    const publicManifestFile = path.join(paths.publicGenerationDir, 'manifest.json');
    const publicManifest = JSON.parse(fs.readFileSync(publicManifestFile, 'utf8'));
    const artifact = publicManifest.artifacts.find((item) => item.id === 'layer:git');
    artifact.sha256 = U.sha256(gitBytes);
    artifact.size = gitBytes.length;
    fs.writeFileSync(publicManifestFile, JSON.stringify(publicManifest));
    const pointer = JSON.parse(fs.readFileSync(paths.currentFile, 'utf8'));
    pointer.publicManifestSha256 = U.sha256(fs.readFileSync(publicManifestFile));
    fs.writeFileSync(paths.currentFile, JSON.stringify(pointer));
    await Store.validateSnapshot(root, 'tracked-env', { mode: 'restore' });

    const beforeIndex = (await H.git(root, ['write-tree'])).trim();
    const beforeEnv = read(path.join(root, '.env'));
    const beforeSnapshots = await U.listSnapshots(root);

    const dry = await H.cli(root, ['restore', 'tracked-env', '--dry-run']);
    assert.equal(dry.status, 1, `${dry.stdout}\n${dry.stderr}`);
    assert.match(dry.stderr, /private configuration target \.env is tracked by the target Git commit/i);
    assert.equal(await head(root), beforeHead);
    assert.equal((await H.git(root, ['write-tree'])).trim(), beforeIndex);
    assert.deepEqual(read(path.join(root, '.env')), beforeEnv);

    const actual = await H.cli(root, ['restore', 'tracked-env', '--yes']);
    assert.equal(actual.status, 1, `${actual.stdout}\n${actual.stderr}`);
    assert.match(actual.stderr, /private configuration target \.env is tracked by the target Git commit/i);
    assert.equal(await head(root), beforeHead);
    assert.equal((await H.git(root, ['write-tree'])).trim(), beforeIndex);
    assert.deepEqual(read(path.join(root, '.env')), beforeEnv);
    assert.deepEqual(await U.listSnapshots(root), beforeSnapshots, 'refusal does not create a safety generation');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
