'use strict';

// Git restore helpers. The supported case is deliberately narrow: a clean,
// ordinary repository root with local commit objects and no executable
// content filter boundary.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const U = require('./utils');

async function git(root, args, options = {}) {
  return U.runTrusted('git', args, { cwd: root, ...options });
}

async function required(root, args, label = args.join(' '), options = {}) {
  const result = await git(root, args, options);
  if (!result.ok) throw new Error(`Git ${label} failed: ${(result.stderr || result.message || 'unknown error').trim()}`);
  return result.stdout;
}

function parseStatus(output) {
  const fields = String(output).split('\0');
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== ' ') throw new Error('malformed Git porcelain -z status record');
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (!file) throw new Error('Git porcelain -z status record has an empty path');
    if (code.includes('R') || code.includes('C')) {
      const originalPath = fields[index + 1];
      if (!originalPath) throw new Error('Git porcelain -z rename/copy record lacks its source path');
      entries.push({ code, path: file, originalPath });
      index += 1;
    } else entries.push({ code, path: file });
  }
  return entries;
}

function parseIndexEntries(output) {
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output);
  if (text && !text.endsWith('\0')) throw new Error('malformed Git index -z output: missing NUL terminator');
  const records = [];
  for (const record of text.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    if (separator < 0) throw new Error('malformed Git index -z record: missing path separator');
    const metadata = record.slice(0, separator);
    const match = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/i.exec(metadata);
    const file = record.slice(separator + 1);
    if (!match || !file) throw new Error('malformed Git index -z record');
    records.push({ mode: match[1], objectId: match[2].toLowerCase(), stage: Number(match[3]), path: file });
  }
  return records;
}

async function inspectGit(root) {
  const rootAbs = path.resolve(root);
  const prefix = await git(rootAbs, ['rev-parse', '--show-prefix']);
  if (!prefix.ok) {
    if (/not a git repository/i.test(prefix.stderr || prefix.message || '')) return { isGit: false };
    throw new Error(`cannot determine Git repository state: ${(prefix.stderr || prefix.message || 'probe failed').trim()}`);
  }
  if (prefix.stdout.trim() !== '') throw new Error('restore must run at the Git project root; subdirectory restore is unsupported');
  const dotGit = path.join(rootAbs, '.git');
  const dotGitStat = await fsp.lstat(dotGit).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('linked worktree or non-directory Git metadata is unsupported');
    throw error;
  });
  if (!dotGitStat.isDirectory() || dotGitStat.isSymbolicLink()) throw new Error('linked worktree or linked Git metadata is unsupported');
  const sparse = await git(rootAbs, ['config', '--bool', 'core.sparseCheckout']);
  if (sparse.ok && sparse.stdout.trim() === 'true') throw new Error('sparse checkout restore is unsupported');
  if (!sparse.ok && sparse.code !== 1) throw new Error(`cannot inspect sparse checkout: ${(sparse.stderr || sparse.message || '').trim()}`);
  const head = (await required(rootAbs, ['rev-parse', '--verify', 'HEAD^{commit}'], 'current HEAD')).trim();
  const attached = await git(rootAbs, ['symbolic-ref', '--quiet', 'HEAD']);
  if (!attached.ok && attached.code !== 1) throw new Error(`cannot inspect HEAD attachment: ${(attached.stderr || attached.message || '').trim()}`);
  const indexEntries = await required(rootAbs, ['ls-files', '--stage', '-z'], 'index entries');
  const parsedIndex = parseIndexEntries(indexEntries);
  if (parsedIndex.some((entry) => entry.mode === '160000')) throw new Error('submodule restore is unsupported');
  if (parsedIndex.some((entry) => entry.mode === '120000')) throw new Error('repositories with indexed symbolic links are unsupported');
  // Enumerate HEAD and every index stage before running status. In particular,
  // a staged addition is absent from HEAD but may still cause `git status` to
  // invoke its configured clean filter after an equal-size worktree edit.
  await rejectFilters(rootAbs, [head], parsedIndex.map((entry) => entry.path));
  // `git status` may invoke clean/process filters. The effective-attribute
  // checks above are deliberately completed first and do not execute filters.
  const statusOutput = await required(rootAbs, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'status');
  const indexTree = (await required(rootAbs, ['write-tree'], 'index tree')).trim();
  const refsText = await required(rootAbs, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'], 'all refs');
  const refs = Object.fromEntries(refsText.split(/\r?\n/).filter(Boolean).map((line) => {
    const split = line.indexOf(' ');
    return [line.slice(0, split), line.slice(split + 1)];
  }));
  return {
    isGit: true,
    root: rootAbs,
    head,
    branchRef: attached.ok ? attached.stdout.trim() : null,
    branch: attached.ok ? attached.stdout.trim().replace(/^refs\/heads\//, '') : null,
    indexTree,
    indexEntries,
    refs,
    refsText,
    dirty: parseStatus(statusOutput),
    clean: statusOutput.length === 0,
  };
}

async function rejectFilters(root, commits, observedPaths = []) {
  const sources = [...new Set(commits)];
  const paths = new Set();
  for (const commit of sources) {
    const entries = await required(root, ['ls-tree', '-r', '--name-only', '-z', commit], 'Git filter target paths');
    for (const item of entries.split('\0').filter(Boolean)) paths.add(item);
  }
  for (const item of observedPaths) paths.add(item);
  if (!paths.size) return;
  const orderedPaths = [...paths];
  // `check-attr` resolves the effective values through worktree, .git/info,
  // configured global/system attributes and tree attributes. Check both the
  // live checkout view and each tree Git may materialize. If Git cannot report
  // the effective attributes, refuse before checkout (including compensation).
  for (const source of [null, ...sources]) {
    for (let offset = 0; offset < orderedPaths.length; offset += 96) {
      const batch = orderedPaths.slice(offset, offset + 96);
      const args = ['check-attr', '--all', '-z'];
      if (source) args.push('--source', source);
      args.push('--', ...batch);
      const result = await git(root, args, { maxBuffer: 16 * 1024 * 1024 });
      if (!result.ok) throw new Error(`cannot inspect effective Git attributes${source ? ` for ${source.slice(0, 12)}` : ''}: ${(result.stderr || result.message || 'probe failed').trim()}`);
      const fields = result.stdout.split('\0');
      for (let index = 1; index + 1 < fields.length; index += 3) {
        const attribute = fields[index];
        const value = fields[index + 1];
        // `check-attr` prints the literal strings "unset" and "unspecified"
        // both for state operators and for explicit values with those names.
        // These two values are harmless when no matching driver is configured;
        // if one is configured, fail closed because the query cannot tell
        // whether it came from a state operator or an explicit driver name.
        if (attribute === 'filter') {
          if (value === 'unset' || value === 'unspecified') {
            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const configured = await git(root, ['config', '--get-regexp', `^filter\\.${escaped}\\.(clean|smudge|process)$`]);
            if (!configured.ok && configured.code !== 1) throw new Error(`cannot inspect Git filter.${value} configuration: ${(configured.stderr || configured.message || 'probe failed').trim()}`);
            if (!configured.ok) continue;
          }
          throw new Error(`effective Git attributes report an external content filter (filter=${value}); refusing checkout because Git's status/value output is ambiguous`);
        }
      }
    }
  }
}

async function planGit(root, current, snapshotGit) {
  if (!snapshotGit || snapshotGit.status !== 'collected') return null;
  if (!current.isGit) throw new Error('snapshot contains Git state but the current project is not a supported Git repository');
  const data = snapshotGit.data || snapshotGit;
  const commit = typeof data.commit === 'string' ? data.commit.toLowerCase() : '';
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('snapshot Git commit must be a full object id');
  const resolved = (await required(root, ['rev-parse', '--verify', `${commit}^{commit}`], 'snapshot commit')).trim().toLowerCase();
  if (resolved !== commit) throw new Error('snapshot Git commit does not resolve to the declared commit');
  await rejectFilters(root, [current.head, commit]);
  const targetEntries = await required(root, ['ls-tree', '-r', '-z', '--full-tree', commit], 'snapshot tree');
  for (const record of targetEntries.split('\0').filter(Boolean)) {
    const meta = record.slice(0, record.indexOf('\t'));
    const mode = meta.split(' ')[0];
    if (mode === '160000') throw new Error('snapshot target contains a submodule; restore is unsupported');
    if (mode === '120000') throw new Error('snapshot target contains a symbolic link; restore is unsupported');
  }
  const detached = data.detached === true;
  const branchName = typeof data.branch === 'string' ? data.branch : null;
  let targetBranchRef = null;
  if (!detached && branchName) {
    const valid = await git(root, ['check-ref-format', '--branch', branchName]);
    if (!valid.ok || branchName.startsWith('-')) throw new Error('snapshot branch name is invalid');
    const ref = await git(root, ['rev-parse', '--verify', `refs/heads/${branchName}`]);
    if (ref.ok && ref.stdout.trim().toLowerCase() === commit) targetBranchRef = `refs/heads/${branchName}`;
  }
  const currentRef = current.branchRef;
  const targetRef = targetBranchRef;
  if (current.head.toLowerCase() === commit && currentRef === targetRef) return null;
  return {
    kind: 'git', commit, branchRef: targetRef,
    detail: targetRef ? `git: attach to ${targetRef} at ${commit.slice(0, 12)}` : `git: detach HEAD at ${commit.slice(0, 12)}; all refs preserved`,
    targetEntries,
  };
}

function requireClean(current) {
  if (current.isGit && !current.clean) {
    const paths = current.dirty.slice(0, 8).map((item) => item.path).join(', ');
    throw new Error(`Git index/worktree must be clean before restore (${current.dirty.length} changed path(s): ${paths}); --force cannot preserve and safely replay these changes`);
  }
}

async function applyGit(root, step) {
  const currentHead = (await required(root, ['rev-parse', '--verify', 'HEAD^{commit}'], 'current HEAD before checkout')).trim().toLowerCase();
  await rejectFilters(root, [currentHead, step.commit]);
  const hooksDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-state-empty-hooks-'));
  let checkoutError = null;
  let cleanupError = null;
  try {
    const hookConfig = `core.hooksPath=${hooksDir}`;
    const args = ['-c', hookConfig, 'checkout', '--no-overwrite-ignore'];
    if (step.force === true) args.push('--force');
    if (step.branchRef) args.push(step.branchRef.replace(/^refs\/heads\//, ''));
    else args.push('--detach', step.commit);
    await required(root, args, 'checkout');
  } catch (error) { checkoutError = error; }
  try { await fsp.rm(hooksDir, { recursive: true, force: true }); }
  catch (error) { cleanupError = error; }
  if (checkoutError) {
    checkoutError.gitCheckoutAttempted = true;
    checkoutError.gitCheckoutSucceeded = false;
    if (cleanupError) checkoutError.gitCleanupError = cleanupError.message;
    throw checkoutError;
  }
  if (cleanupError) {
    cleanupError.gitCheckoutAttempted = true;
    cleanupError.gitCheckoutSucceeded = true;
    throw cleanupError;
  }
}

async function verifyGit(root, step, originalRefs, allowedDirtyPaths = []) {
  const current = await inspectGit(root);
  const expectedRef = step.branchRef || null;
  if (!current.isGit || current.head.toLowerCase() !== step.commit || current.branchRef !== expectedRef) {
    throw new Error('final Git HEAD or branch attachment differs from the restore plan');
  }
  if (current.refsText !== originalRefs) throw new Error('a Git ref changed during restore');
  const tree = (await required(root, ['rev-parse', '--verify', `${step.commit}^{tree}`], 'target index tree')).trim();
  if (current.indexTree !== tree) throw new Error('final Git index tree differs from the selected commit');
  const allowed = new Set(allowedDirtyPaths.map((p) => p.toLowerCase()));
  const unexpected = current.dirty.filter((entry) => !allowed.has(entry.path.replace(/\\/g, '/').toLowerCase()));
  if (unexpected.length) throw new Error(`unexpected Git worktree changes after restore: ${unexpected.map((x) => x.path).join(', ')}`);
  return current;
}

module.exports = { git, required, parseStatus, parseIndexEntries, inspectGit, planGit, rejectFilters, requireClean, applyGit, verifyGit };
