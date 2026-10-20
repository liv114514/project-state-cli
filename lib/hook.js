'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const U = require('./utils');
const Store = require('./storage');

const BEGIN_MARKER = '# BEGIN project-state (managed block - do not edit between these markers)';
const END_MARKER = '# END project-state';
const BACKUP_NAME = 'pre-commit.project-state-backup';
const WORKER_TIMEOUT_MS = 20000;

function hooksDir(root) { return path.join(root, '.git', 'hooks'); }
function hooksPathOverride(root) {
  return U.runTrusted('git', ['config', '--get', 'core.hooksPath'], { cwd: root }).then((r) => {
    if (!r.ok && r.code !== 1) throw new Error(`Git could not inspect core.hooksPath: ${r.stderr || r.message || 'probe failed'}`);
    return r.ok ? r.stdout.trim() || null : null;
  });
}
function shq(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }

function hookScript(nodeAbs, cliAbs) {
  const nodeQ = shq(String(nodeAbs).replace(/\\/g, '/'));
  const cliQ = shq(String(cliAbs).replace(/\\/g, '/'));
  return [
    BEGIN_MARKER,
    '# The original pre-commit is preserved byte-for-byte in the sibling backup.',
    '__ps_dir="$(dirname -- "$0")"',
    '__ps_root="$(git rev-parse --show-toplevel 2>/dev/null)"',
    `if [ -f "$__ps_dir/${BACKUP_NAME}" ]; then`,
    `  "$__ps_dir/${BACKUP_NAME}" "$@" || exit $?`,
    'fi',
    '# project-state failures are best effort; foreign hook status above is preserved.',
    `if [ -n "$__ps_root" ]; then ${nodeQ} ${cliQ} __hook-snapshot "hook-$(date +%Y%m%d-%H%M%S)" >/dev/null 2>&1 || :; fi`,
    'exit 0',
    END_MARKER,
    '',
  ].join('\n');
}

async function appendHookLog(root, outcome) {
  const message = `[${new Date().toISOString()}] hook snapshot ${outcome}\n`;
  try {
    const { state } = await Store.assertRealProject(root, { createState: true });
    const log = path.join(state, 'hook.log');
    await Store.assertNoLinks(log, { hardlinks: true });
    let expected = null;
    try {
      expected = await fsp.lstat(log, { bigint: true });
      if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n) return;
    } catch (error) { if (error.code !== 'ENOENT') return; }
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    // O_NONBLOCK prevents a raced-in FIFO/device from hanging a Git commit.
    const nonBlock = fs.constants.O_NONBLOCK || 0;
    const handle = await fsp.open(log, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow | nonBlock, 0o600);
    try {
      const opened = await handle.stat({ bigint: true });
      const current = await fsp.lstat(log, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || current.nlink !== 1n || current.isSymbolicLink() ||
        (expected && (opened.dev !== expected.dev || opened.ino !== expected.ino)) || opened.dev !== current.dev || opened.ino !== current.ino) return;
      // Recheck the open handle and directory entry immediately before append.
      // Logging is best effort: an identity race simply skips this line.
      const finalHandle = await handle.stat({ bigint: true });
      const finalPath = await fsp.lstat(log, { bigint: true });
      if (finalHandle.nlink !== 1n || finalPath.nlink !== 1n || finalPath.isSymbolicLink() ||
        finalHandle.dev !== opened.dev || finalHandle.ino !== opened.ino || finalPath.dev !== opened.dev || finalPath.ino !== opened.ino) return;
      await handle.writeFile(message, 'utf8');
    } finally { await handle.close(); }
  } catch { /* own logging must never affect git commit */ }
}

function uniqueHookName(name, suffix) { return suffix === 1 ? name : `${name}-${suffix}`; }

async function runHookWorker(root, name, snapshotInternal) {
  if (!U.HOOK_RE.test(name)) return 1;
  for (let suffix = 1; suffix <= 100; suffix++) {
    try {
      await snapshotInternal(root, uniqueHookName(name, suffix), { kind: 'hook' });
      return 0;
    } catch (e) {
      if (e.code !== 'EEXISTS' && e.code !== 'ESNAPSHOT_EXISTS') return 1;
    }
  }
  return 1;
}

function runHookSnapshot(root, name, cliPath) {
  return new Promise((resolve) => {
    if (!U.HOOK_RE.test(name)) { resolve(1); return; }
    execFile(process.execPath, [cliPath, '__hook-snapshot-worker', name], {
      cwd: root, timeout: WORKER_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024,
    }, async (error) => {
      const status = error ? 'failed or timed out' : 'completed';
      await appendHookLog(root, status);
      resolve(error ? 1 : 0);
    });
  });
}

async function installCmd(root) {
  const gitEntry = await fsp.lstat(path.join(root, '.git')).catch(() => null);
  if (!gitEntry || !gitEntry.isDirectory() || gitEntry.isSymbolicLink()) {
    U.printError('Refusing hook install in this repository layout.', 'Only a repository root with an ordinary .git directory is supported; linked worktrees and subdirectory installs are unsupported.', 'Run from a supported repository root.');
    return 1;
  }
  await Store.assertNoLinks(path.join(root, '.git'), { allowMissing: false });
  const override = await hooksPathOverride(root);
  if (override) {
    U.printError(`Refusing to install: core.hooksPath is set to "${override}".`, 'A custom hooks directory owns these hooks; writing to .git/hooks would create a dead install.', 'Install the managed hook in the configured directory manually, or unset core.hooksPath.');
    return 1;
  }
  const dir = hooksDir(root), target = path.join(dir, 'pre-commit'), backup = path.join(dir, BACKUP_NAME);
  await Store.ensureRealDirectory(root, dir);
  await Store.assertNoLinks(target, { hardlinks: true });
  let existing = null;
  try {
    const st = await fsp.lstat(target);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) throw new Error('existing pre-commit must be a regular, unlinked file');
    existing = await fsp.readFile(target);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing !== null && existing.includes(Buffer.from(BEGIN_MARKER))) {
    console.log('project-state hook is already installed (nothing to do).');
    return 0;
  }
  if (existing !== null) {
    try { await fsp.lstat(backup); U.printError(`A leftover ${BACKUP_NAME} already exists.`, 'The original hook cannot be preserved safely while that path is occupied.', 'Inspect both files and resolve the prior installation first.'); return 1; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fsp.rename(target, backup);
  }
  const nodeAbs = process.execPath;
  const cliAbs = path.join(__dirname, '..', 'bin', 'project-state.js');
  const script = Buffer.from('#!/bin/sh\n' + hookScript(nodeAbs, cliAbs), 'utf8');
  try {
    await fsp.writeFile(target, script, { flag: 'wx' });
    try { await fsp.chmod(target, 0o755); } catch { /* Git for Windows ignores the executable bit */ }
  } catch (e) {
    if (existing !== null) {
      try { await fsp.lstat(target); } catch (check) { if (check.code === 'ENOENT') await fsp.rename(backup, target); }
    }
    throw e;
  }
  if (existing !== null) console.log(`Installed. Existing pre-commit bytes are preserved at .git/hooks/${BACKUP_NAME} and run first.`);
  else console.log('Installed .git/hooks/pre-commit.');
  console.log('Snapshot failures are best effort and do not block commits.');
  return 0;
}

async function uninstallCmd(root) {
  const dir = hooksDir(root), target = path.join(dir, 'pre-commit'), backup = path.join(dir, BACKUP_NAME);
  await Store.assertNoLinks(target, { hardlinks: true });
  await Store.assertNoLinks(backup, { hardlinks: true });
  let current;
  try { current = await fsp.readFile(target); }
  catch (e) { U.printError('project-state hook is not installed.', e.code === 'ENOENT' ? 'There is no .git/hooks/pre-commit.' : e.message, 'Nothing was changed.'); return 1; }
  if (!current.includes(Buffer.from(BEGIN_MARKER)) || !current.includes(Buffer.from(END_MARKER))) {
    U.printError('project-state hook is not installed.', 'The pre-commit file has no complete project-state managed markers; touching it would be unsafe.', 'Nothing was changed.');
    return 1;
  }
  const expectedWrapper = Buffer.from('#!/bin/sh\n' + hookScript(process.execPath, path.join(__dirname, '..', 'bin', 'project-state.js')), 'utf8');
  if (!current.equals(expectedWrapper)) {
    U.printError('Refusing to uninstall a modified project-state hook.', 'The installed wrapper differs from the exact wrapper generated by this package; managed markers do not prove ownership of surrounding user edits.', 'Preserve both files, review the current hook and backup manually, then remove only content you recognize.');
    return 1;
  }
  let backupStat = null;
  try { backupStat = await fsp.lstat(backup); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (backupStat) {
    if (!backupStat.isFile() || backupStat.isSymbolicLink() || backupStat.nlink > 1) throw new Error('foreign hook backup is not an ordinary, unlinked file');
    const displaced = path.join(dir, 'pre-commit.project-state-removing');
    try { await fsp.lstat(displaced); throw new Error('unfinished hook uninstall exists; inspect pre-commit.project-state-removing'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fsp.rename(target, displaced);
    try { await fsp.rename(backup, target); }
    catch (e) { await fsp.rename(displaced, target); throw e; }
    await fsp.rm(displaced);
    console.log('Uninstalled. The original pre-commit was restored byte-for-byte with its original file permissions.');
  } else {
    await fsp.rm(target);
    console.log('Uninstalled. The project-state pre-commit was removed.');
  }
  return 0;
}

async function hookCmd(root, action) {
  if (action === 'install') return installCmd(root);
  if (action === 'uninstall') return uninstallCmd(root);
  U.printError(`Unknown hook action "${action}".`, 'Only "install" and "uninstall" are supported.', 'Use: project-state hook install | project-state hook uninstall');
  return 1;
}

module.exports = { hookCmd, installCmd, uninstallCmd, runHookWorker, runHookSnapshot, appendHookLog, BEGIN_MARKER, END_MARKER, BACKUP_NAME, WORKER_TIMEOUT_MS };
