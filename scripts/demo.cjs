'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PACKAGE_ROOT, 'bin', 'project-state.js');
const MARKER = '.project-state-demo-owner.json';
const A = 'APP_MODE=demo-a\nDEMO_VALUE=synthetic-only\n';
const B = 'APP_MODE=demo-b\nDEMO_VALUE=synthetic-only\n';

function run(file, args, cwd, env = process.env) {
  const result = spawnSync(file, args, {
    cwd, env: { ...env }, encoding: 'utf8', windowsHide: true, timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || '').trim();
    throw new Error(`${path.basename(file)} ${args[0] || ''} exited ${result.status}; ${detail || 'no diagnostic was returned'}`);
  }
  return result.stdout || '';
}

function git(cwd, args) { return run('git', args, cwd); }

function equalBytes(file, expected, step) {
  const actual = fs.readFileSync(file);
  if (!actual.equals(Buffer.from(expected, 'utf8'))) throw new Error(`${step}: configuration bytes did not match the expected synthetic state`);
}

function quotePowerShell(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function quotePosix(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }

function expectedRollbackCommand(name, operationId, platform = process.platform) {
  const args = [process.execPath, CLI, 'restore', name, '--yes', '--rollback-of', operationId];
  return platform === 'win32'
    ? `& ${args.map(quotePowerShell).join(' ')}`
    : args.map(quotePosix).join(' ');
}

function parseRollbackCommand(command, platform = process.platform) {
  const quote = platform === 'win32' ? quotePowerShell : quotePosix;
  const prefix = `${platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(CLI)} ${quote('restore')} `;
  if (!command.startsWith(prefix)) throw new Error('printed rollback command does not target this CLI; keeping demo files');
  const rest = command.slice(prefix.length);
  const match = rest.match(/^'([A-Za-z0-9][A-Za-z0-9._-]{0,63})' '--yes' '--rollback-of' '([a-f0-9]{32})'$/);
  if (!match) throw new Error('printed rollback command arguments are outside the supported safe form; keeping demo files');
  const parsed = { name: match[1], operationId: match[2] };
  if (command !== expectedRollbackCommand(parsed.name, parsed.operationId, platform)) {
    throw new Error('printed rollback command did not match the exact generated CLI arguments; keeping demo files');
  }
  return parsed;
}

function executeExactRollback(command, cwd) {
  parseRollbackCommand(command);
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    if (!systemRoot) throw new Error('Windows system root is unavailable; keeping demo files');
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return run(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], cwd);
  }
  return run('/bin/sh', ['-c', command], cwd);
}

async function createDemoRoot() {
  const temp = await fsp.realpath(os.tmpdir());
  const root = await fsp.mkdtemp(path.join(temp, 'project-state-demo-'));
  const token = crypto.randomBytes(32).toString('hex');
  const info = await fsp.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('temporary demo root is not a plain directory');
  await fsp.writeFile(path.join(root, MARKER), JSON.stringify({ version: 1, token }), { flag: 'wx', mode: 0o600 });
  return { root, token, dev: info.dev, ino: info.ino, temp };
}

async function verifyDemoOwner(state) {
  const info = await fsp.lstat(state.root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== state.dev || info.ino !== state.ino) {
    throw new Error('demo directory identity changed; preserve it and do not clean it automatically');
  }
  const realRoot = await fsp.realpath(state.root);
  const relative = path.relative(state.temp, realRoot);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.dirname(realRoot) !== state.temp) {
    throw new Error('demo directory is no longer a direct child of the verified temporary root');
  }
  const marker = path.join(state.root, MARKER);
  const markerInfo = await fsp.lstat(marker);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new Error('demo ownership marker is not a regular file');
  const recorded = JSON.parse(await fsp.readFile(marker, 'utf8'));
  if (recorded.version !== 1 || recorded.token !== state.token) throw new Error('demo ownership marker does not match this run');
}

async function safeCleanup(state) {
  await verifyDemoOwner(state);
  await fsp.rm(state.root, { recursive: true, force: false });
}

async function main() {
  const args = process.argv.slice(2);
  const keep = args.length === 1 && args[0] === '--keep';
  if (args.length && !keep) throw new Error('usage: npm run demo [-- --keep]');

  const state = await createDemoRoot();
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'project-state demo',
    GIT_AUTHOR_EMAIL: 'demo@example.invalid',
    GIT_COMMITTER_NAME: 'project-state demo',
    GIT_COMMITTER_EMAIL: 'demo@example.invalid',
  };
  let succeeded = false;
  try {
    await fsp.writeFile(path.join(state.root, '.gitignore'), '.env\n.project-state/\n.project-state-demo-owner.json\n');
    await fsp.writeFile(path.join(state.root, 'README.txt'), 'Disposable synthetic project-state demo.\n');
    git(state.root, ['init']);
    await fsp.mkdir(path.join(state.root, '.git', 'project-state-demo-hooks'));
    await fsp.writeFile(path.join(state.root, '.git', 'project-state-demo-attributes'), '');
    git(state.root, ['config', 'core.hooksPath', '.git/project-state-demo-hooks']);
    git(state.root, ['config', 'core.attributesFile', '.git/project-state-demo-attributes']);
    git(state.root, ['config', 'core.fsmonitor', 'false']);
    git(state.root, ['config', 'commit.gpgsign', 'false']);
    git(state.root, ['config', 'user.name', 'project-state demo']);
    git(state.root, ['config', 'user.email', 'demo@example.invalid']);
    git(state.root, ['add', '.gitignore', 'README.txt']);
    git(state.root, ['commit', '-m', 'Create synthetic demo project']);

    const config = path.join(state.root, '.env');
    await fsp.writeFile(config, A);
    const snapshot = run(process.execPath, [CLI, 'snapshot', 'demo-before'], state.root, env);
    const generation = snapshot.match(/generation ([a-f0-9]{32}) saved\./)?.[1];
    if (!generation) throw new Error('snapshot output did not confirm a generation');
    if (git(state.root, ['ls-files']).split(/\r?\n/).includes('.env')) throw new Error('synthetic config was added to Git');
    const cleanStatus = git(state.root, ['status', '--porcelain=v1', '--untracked-files=all']).trim();
    if (cleanStatus) throw new Error('synthetic config or state storage appeared in Git status');

    await fsp.writeFile(config, B);
    equalBytes(config, B, 'B state setup');
    const comparison = run(process.execPath, [CLI, 'compare', 'demo-before'], state.root, env);
    if (!/difference/i.test(comparison)) throw new Error('compare did not report the synthetic config change');

    const preview = run(process.execPath, [CLI, 'restore', 'demo-before', '--only', 'config', '--dry-run'], state.root, env);
    if (!/Restore plan|PREVIEW/i.test(preview)) throw new Error('restore preview was not clearly identified');
    equalBytes(config, B, 'dry-run');

    const restore = run(process.execPath, [CLI, 'restore', 'demo-before', '--only', 'config', '--yes'], state.root, env);
    equalBytes(config, A, 'restored A state');
    if (!/Restore verified/i.test(restore)) throw new Error('restore did not report verified file results');
    const label = process.platform === 'win32' ? 'Exact rollback command (PowerShell): ' : 'Exact rollback command: ';
    const command = restore.split(/\r?\n/).find((line) => line.startsWith(label))?.slice(label.length);
    if (!command) throw new Error('restore output omitted the exact rollback command');
    const { name: rollbackName, operationId } = parseRollbackCommand(command);
    executeExactRollback(command, state.root);
    equalBytes(config, B, 'rollback B state');

    const tracked = git(state.root, ['ls-files']).split(/\r?\n/).filter(Boolean);
    if (tracked.includes('.env') || tracked.some((name) => name.startsWith('.project-state/'))) {
      throw new Error('demo private data was tracked by Git');
    }
    const finalStatus = git(state.root, ['status', '--porcelain=v1', '--untracked-files=all']).trim();
    if (finalStatus) throw new Error('demo left unexpected Git changes');
    console.log('Synthetic configuration exercise passed: bytes verified A → B → A → B.');
    console.log(`Snapshot: demo-before generation ${generation}; restore operation ${operationId}; rollback target ${rollbackName}.`);
    console.log('Dry-run left B unchanged; the unmodified printed rollback command restored B.');
    console.log('This disposable file exercise does not test application health or real project data.');
    succeeded = true;
  } finally {
    if (keep || !succeeded) {
      console.log(`Demo directory retained for inspection: ${state.root}`);
    } else {
      try {
        await safeCleanup(state);
        console.log('Disposable demo directory cleaned after ownership and path verification.');
      } catch (error) {
        console.error(`Demo directory retained because safe cleanup could not be verified: ${state.root}`);
        console.error(`Cleanup reason: ${error.message}`);
        if (succeeded) throw error;
      }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Demo failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { expectedRollbackCommand, parseRollbackCommand };
