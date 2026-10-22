'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const H = require('./helpers');
const { expectedRollbackCommand, parseRollbackCommand } = require('../scripts/demo.cjs');
const Store = require('../lib/storage');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'project-state.js');

function run(cwd, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env },
  });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function emptyProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'project-state-usability-')); }

function executePrintedSuggestion(stderr, cwd) {
  const line = String(stderr).split(/\r?\n/).find((item) => item.includes('Next:'));
  assert.ok(line, `no next-step suggestion found: ${stderr}`);
  let command;
  if (process.platform === 'win32') {
    const match = line.match(/PowerShell:\s*(.+?)(?:\s+OR Command Prompt:|$)/);
    assert.ok(match, `no runnable PowerShell command in suggestion: ${line}`);
    command = match[1];
  } else {
    const start = line.indexOf("with: ");
    assert.notEqual(start, -1, `suggestion does not identify its command: ${line}`);
    command = line.slice(start + 'with: '.length);
  }
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true })
    : spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  return { ...result, command };
}

function rollbackPreviewCommand(stdout) {
  const marker = stdout.indexOf('To apply later,');
  assert.notEqual(marker, -1, `preview omitted its apply instruction: ${stdout}`);
  const lines = stdout.slice(marker).split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean);
  const candidate = process.platform === 'win32'
    ? lines.find((line) => line.startsWith('PowerShell: '))
    : lines.find((line) => !line.startsWith('Plan details:'));
  assert.ok(candidate, `preview omitted a command for this shell: ${stdout}`);
  return process.platform === 'win32' ? candidate.slice('PowerShell: '.length) : candidate;
}

function executePrintedRollback(command, cwd) {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true })
    : spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', timeout: 60000 });
  assert.ifError(result.error);
  return result;
}

test('global help leads with the normal workflow and keeps recovery details advanced', () => {
  const cwd = emptyProject();
  try {
    const results = [[], ['help'], ['--help']].map((args) => run(cwd, args));
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /doctor.*snapshot <name>.*compare <name>.*restore <name> --dry-run.*restore <name> --yes/s);
      assert.match(result.stdout, /help <command>/);
      assert.match(result.stdout, /Advanced commands/);
      assert.doesNotMatch(result.stdout, /recover <operationId> --compensate/);
      assert.ok(result.stdout.length < 1800, `global help is still too long (${result.stdout.length} chars)`);
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
test('every command has a focused help entry and help is side-effect free', () => {
  const cwd = emptyProject();
  const commands = ['snapshot', 'compare', 'list', 'doctor', 'restore', 'prune', 'hook', 'recover'];
  try {
    for (const command of commands) {
      const fromHelp = run(cwd, ['help', command]);
      const fromCommand = run(cwd, [command, '--help']);
      for (const result of [fromHelp, fromCommand]) {
        assert.equal(result.status, 0, `${command}: ${result.stderr}`);
        assert.match(result.stdout, new RegExp(`project-state ${command}\\b`));
        assert.match(result.stdout, /Exit codes:/);
        assert.match(result.stdout, /CLI entry:/);
        if (process.platform === 'win32') assert.match(result.stdout, /Command Prompt:/);
        else assert.doesNotMatch(result.stdout, /Command Prompt:/);
      }
    }
    assert.deepEqual(fs.readdirSync(cwd), [], 'help must not create project state, a lock, journal, or business file');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('help errors remain controlled for unknown commands and malformed arguments', () => {
  const cwd = emptyProject();
  try {
    const cases = [
      [['help', 'not-a-command'], /Unknown help topic/],
      [['not-a-command', '--help'], /Unknown command/],
      [['snapshot'], /Usage:/],
      [['snapshot', '--unknown'], /Unknown option/],
      [['restore'], /Usage:/],
      [['prune', '--keep'], /needs a value/],
      [['hook', 'unknown-action'], /Unknown hook action/],
    ];
    for (const [args, expected] of cases) {
      const result = run(cwd, args);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, expected);
      if (args[0] === 'snapshot' || args[0] === 'restore' || args[0] === 'prune' || args[0] === 'hook') {
        if (process.platform === 'win32') assert.match(result.stderr, /Command Prompt:/);
      }
    }
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('help rejects inherited JavaScript properties without touching the project', () => {
  const cwd = emptyProject();
  try {
    for (const topic of ['toString', 'constructor', '__proto__']) {
      const result = run(cwd, ['help', topic]);
      assert.equal(result.status, 1, `${topic}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /Unknown help topic/);
      assert.doesNotMatch(result.stdout, /\[native code\]|function Object|__defineGetter__/);
    }
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('demo parser accepts exact POSIX commands and rejects wrong entry or extra arguments', () => {
  const id = 'a'.repeat(32);
  const posix = expectedRollbackCommand('before', id, 'linux');
  assert.deepEqual(parseRollbackCommand(posix, 'linux'), { name: 'before', operationId: id });
  const windows = expectedRollbackCommand('before', id, 'win32');
  assert.deepEqual(parseRollbackCommand(windows, 'win32'), { name: 'before', operationId: id });
  assert.throws(() => parseRollbackCommand(posix.replace(process.execPath, 'other-node'), 'linux'), /does not target this CLI/);
  assert.throws(() => parseRollbackCommand(`${posix} '--force'`, 'linux'), /outside the supported safe form/);
});

test('rollback preview command is executed unchanged and only reverses the original selective config operation', async (t) => {
  for (const targetOriginallyExisted of [false, true]) {
    const root = emptyProject();
    t.after(() => H.removeTemporaryTree(root));
    await H.setupGit(root, { '.gitignore': '.project-state/\n' });
    H.excludeLocalFiles(root, ['.env', '.nvmrc']);
    const envFile = path.join(root, '.env');
    const pinFile = path.join(root, '.nvmrc');
    fs.writeFileSync(envFile, 'MODE=snapshot\n');
    fs.writeFileSync(pinFile, '20\n');
    const saved = await H.cli(root, ['snapshot', 'before-config']);
    assert.equal(saved.status, 0, `${saved.stdout}\n${saved.stderr}`);

    fs.writeFileSync(pinFile, '22\n');
    if (targetOriginallyExisted) fs.writeFileSync(envFile, 'MODE=before-restore\n');
    else fs.unlinkSync(envFile);
    const applied = await H.cli(root, ['restore', 'before-config', '--only', 'config', '--yes']);
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
    const applyLine = applied.stdout.split(/\r?\n/).find((line) => line.includes('--rollback-of'));
    assert.ok(applyLine, `applied operation omitted its rollback reference: ${applied.stdout}`);
    const operationMatch = applyLine.match(/--rollback-of[^a-f0-9]*([a-f0-9]{32})/i);
    const safetyMatch = applied.stdout.match(/Verified safety point: ([A-Za-z0-9._-]+) generation ([a-f0-9]{32})/);
    assert.ok(operationMatch && safetyMatch, `operation/safety identity missing: ${applied.stdout}`);
    const originalOperationId = operationMatch[1];
    const originalJournalPath = Store.operationJournalPath(root, originalOperationId);
    const originalJournalBefore = await Store.readJournal(root, originalJournalPath);
    const pinsBeforePreview = await Store.listPins(root);
    const headBeforePreview = (await H.git(root, ['rev-parse', 'HEAD'])).trim();
    const indexBeforePreview = (await H.git(root, ['write-tree'])).trim();
    const envBeforePreview = fs.existsSync(envFile) ? fs.readFileSync(envFile) : null;
    const pinBeforePreview = fs.readFileSync(pinFile);

    const preview = await H.cli(root, ['restore', safetyMatch[1], '--rollback-of', originalOperationId, '--dry-run']);
    assert.equal(preview.status, 0, `${preview.stdout}\n${preview.stderr}`);
    assert.match(preview.stdout, /files: 1/);
    assert.match(preview.stdout, /"target": "\.env"/);
    assert.doesNotMatch(preview.stdout, /"target": "\.nvmrc"/);
    const suggestedCommand = rollbackPreviewCommand(preview.stdout);
    assert.match(suggestedCommand, /--rollback-of/);
    assert.match(suggestedCommand, new RegExp(originalOperationId));
    assert.equal(fs.existsSync(envFile), envBeforePreview !== null);
    if (envBeforePreview) assert.deepEqual(fs.readFileSync(envFile), envBeforePreview);
    assert.deepEqual(fs.readFileSync(pinFile), pinBeforePreview);
    assert.equal((await H.git(root, ['rev-parse', 'HEAD'])).trim(), headBeforePreview);
    assert.equal((await H.git(root, ['write-tree'])).trim(), indexBeforePreview);
    assert.deepEqual(await Store.listPins(root), pinsBeforePreview, 'preview pin lifecycle must return to its prior state');
    assert.deepEqual(await Store.readJournal(root, originalJournalPath), originalJournalBefore, 'preview must not rewrite the original operation journal');

    fs.writeFileSync(pinFile, '24\n');
    const executed = executePrintedRollback(suggestedCommand, root);
    assert.equal(executed.status, 0, `${executed.stdout}\n${executed.stderr}`);
    if (targetOriginallyExisted) assert.equal(fs.readFileSync(envFile, 'utf8'), 'MODE=before-restore\n');
    else assert.equal(fs.existsSync(envFile), false, 'rollback restores original absence');
    assert.equal(fs.readFileSync(pinFile, 'utf8'), '24\n', 'external edit outside the preview target set remains unchanged');
    assert.equal((await H.git(root, ['rev-parse', 'HEAD'])).trim(), headBeforePreview);
    assert.equal((await H.git(root, ['write-tree'])).trim(), indexBeforePreview);

    const journals = await fs.promises.readdir(path.join(root, '.project-state', 'operations'));
    let rollbackJournal;
    for (const file of journals.filter((entry) => entry.endsWith('.json'))) {
      const entry = await Store.readJournal(root, path.join(root, '.project-state', 'operations', file));
      if (entry.resolvesOperationId === originalOperationId) rollbackJournal = entry;
    }
    assert.ok(rollbackJournal, 'executed command must create a journal linked to the previewed rollback operation');
    assert.equal(rollbackJournal.terminalOutcome, 'verified-complete');
    const resolvedOriginal = await Store.readJournal(root, originalJournalPath);
    assert.equal(resolvedOriginal.terminalOutcome, 'resolved-by-rollback');
    assert.equal(resolvedOriginal.resolvedBy, rollbackJournal.operationId);
    assert.equal((await Store.listPins(root)).some((pin) => pin.pinId === originalJournalBefore.safety.pinId), false, 'only the exact resolved operation safety pin is released');
    await Store.validateGenerationById(root, originalJournalBefore.safety.name, originalJournalBefore.safety.generation);
  }
});

test('preflight refusals suggest and execute a read-only check without inventing a recovery journal', async (t) => {
  const missingRoot = emptyProject();
  t.after(() => H.removeTemporaryTree(missingRoot));
  await H.setupGit(missingRoot, { '.gitignore': '.project-state/\n' });
  const missing = await H.cli(missingRoot, ['restore', 'does-not-exist', '--yes']);
  assert.equal(missing.status, 1, `${missing.stdout}\n${missing.stderr}`);
  assert.match(missing.stderr, /No recovery operation was recorded/);
  assert.match(missing.stderr, /doctor/);
  assert.doesNotMatch(missing.stderr, /recover .*--inspect/);
  const doctor = executePrintedSuggestion(missing.stderr, missingRoot);
  assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
  assert.match(doctor.stdout, /Verdict:/);
  assert.equal(fs.existsSync(path.join(missingRoot, '.project-state', 'operations')), false);

  const dirtyRoot = emptyProject();
  t.after(() => H.removeTemporaryTree(dirtyRoot));
  await H.setupGit(dirtyRoot, { '.gitignore': '.project-state/\n' });
  const saved = await H.cli(dirtyRoot, ['snapshot', 'before']);
  assert.equal(saved.status, 0, `${saved.stdout}\n${saved.stderr}`);
  const app = path.join(dirtyRoot, 'app.js');
  fs.writeFileSync(app, 'external dirty change\n');
  const dirtyBytes = fs.readFileSync(app);
  const dirtyStatus = await H.git(dirtyRoot, ['status', '--porcelain=v1']);
  const refused = await H.cli(dirtyRoot, ['restore', 'before', '--yes']);
  assert.equal(refused.status, 1, `${refused.stdout}\n${refused.stderr}`);
  assert.match(refused.stderr, /No recovery operation was recorded/);
  assert.doesNotMatch(refused.stderr, /recover .*--inspect/);
  const inspected = executePrintedSuggestion(refused.stderr, dirtyRoot);
  assert.equal(inspected.status, 0, `${inspected.stdout}\n${inspected.stderr}`);
  assert.deepEqual(fs.readFileSync(app), dirtyBytes);
  assert.equal(await H.git(dirtyRoot, ['status', '--porcelain=v1']), dirtyStatus);
  const operations = path.join(dirtyRoot, '.project-state', 'operations');
  if (fs.existsSync(operations)) {
    const entries = await fs.promises.readdir(operations);
    const restoreJournals = [];
    for (const file of entries.filter((name) => name.endsWith('.json'))) {
      const journal = await Store.readJournal(dirtyRoot, path.join(operations, file));
      if (journal.operation === 'restore') restoreJournals.push(journal);
    }
    assert.deepEqual(restoreJournals, [], 'preflight rejection must not fabricate a restore recovery record');
  }
});

test('source package exposes the disposable first-run demo command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.demo, 'node scripts/demo.cjs');
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'demo.cjs')), true);
});

test('English and Chinese quickstarts guard Git ignore and show the same preview/authorization flow', () => {
  const english = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const chinese = fs.readFileSync(path.join(ROOT, 'README.zh-CN.md'), 'utf8');
  for (const [language, readme] of [['English', english], ['Chinese', chinese]]) {
    assert.match(readme, /git check-ignore -- \.env/, `${language} quickstart must check Git exclusion before config use`);
    assert.match(readme, /restore before-config-change --only config --dry-run/);
    assert.match(readme, /restore before-config-change --only config --yes/);
    assert.match(readme, /npm run demo/);
    assert.match(readme, /TOOL_ROOT='\/path\/to\/project-state'/, `${language} Bash tool path must be shell-quoted`);
    assert.match(readme, /does not (?:restart|test application health)|不会重启应用或验证应用健康/);
    assert.ok(readme.indexOf('git check-ignore -- .env') < readme.indexOf('snapshot before-config-change'), `${language} ignore check must precede snapshot instructions`);
    assert.ok(readme.indexOf('--dry-run') < readme.indexOf('--yes'), `${language} preview must precede explicit authorization`);
  }
});

test('demo executes synthetic config bytes through A to B to A to B and cleans only its owned root', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'demo.cjs')], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env },
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /bytes verified A → B → A → B/);
  assert.match(result.stdout, /unmodified printed rollback command restored B/);
  assert.match(result.stdout, /directory cleaned after ownership and path verification/);
  assert.match(result.stdout, /does not test application health or real project data/);
});

test('snapshot, compare, preview, and restore summaries make partial and unverified scope visible', async () => {
  const root = emptyProject();
  try {
    await H.setupGit(root, { '.gitignore': '.env\n.project-state/\n' });
    const env = path.join(root, '.env');
    fs.writeFileSync(env, 'MODE=alpha\n');
    const saved = await H.cli(root, ['snapshot', 'before']);
    assert.equal(saved.status, 0, `${saved.stdout}\n${saved.stderr}`);
    assert.match(saved.stdout, /Snapshot completeness: PARTIAL/);
    assert.match(saved.stdout, /SQLite row data: not included/);
    assert.match(saved.stdout, /Next: compare this snapshot/);

    fs.writeFileSync(env, 'MODE=bravo\n');
    const comparison = await H.cli(root, ['compare', 'before']);
    assert.equal(comparison.status, 0, comparison.stderr);
    assert.match(comparison.stdout, /difference\(s\) found/);
    assert.match(comparison.stdout, /Next: preview restoring the first snapshot/);
    assert.doesNotMatch(comparison.stdout, /MODE=alpha|MODE=bravo/);

    const preview = await H.cli(root, ['restore', 'before', '--only', 'config', '--dry-run']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /PREVIEW ONLY/);
    assert.match(preview.stdout, /lock\/pin metadata/);
    assert.match(preview.stdout, /files: 1/);
    assert.match(preview.stdout, /'--only' 'config' '--yes'/);
    assert.equal(fs.readFileSync(env, 'utf8'), 'MODE=bravo\n', 'dry-run must leave business config bytes unchanged');

    const restored = await H.cli(root, ['restore', 'before', '--only', 'config', '--yes']);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /Restore verified/);
    assert.match(restored.stdout, /Application health: not tested/);
    assert.equal(fs.readFileSync(env, 'utf8'), 'MODE=alpha\n');

    const inventory = await H.cli(root, ['list']);
    assert.equal(inventory.status, 0, inventory.stderr);
    assert.match(inventory.stdout, /generation [a-f0-9]{32}/);
    assert.match(inventory.stdout, /application health not tested/);

    const diagnosis = await H.cli(root, ['doctor']);
    assert.equal(diagnosis.status, 0, diagnosis.stderr);
    assert.match(diagnosis.stdout, /Verdict:/);
    assert.match(diagnosis.stdout, /Application health was not tested/);
  } finally { await H.removeTemporaryTree(root); }
});
