'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const H = require('./helpers');
const GitRestore = require('../lib/restore-git');

function tempProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ps-git-nul-')); }

test('Git index -z parser reads every NUL record and preserves spaces and newlines in paths', () => {
  const records = [
    `100644 ${'a'.repeat(40)} 0\tordinary file.txt`,
    `120000 ${'b'.repeat(40)} 0\tline\nbreak`,
    `160000 ${'c'.repeat(40)} 0\tmodule with space`,
  ].join('\0') + '\0';
  assert.deepEqual(GitRestore.parseIndexEntries(records), [
    { mode: '100644', objectId: 'a'.repeat(40), stage: 0, path: 'ordinary file.txt' },
    { mode: '120000', objectId: 'b'.repeat(40), stage: 0, path: 'line\nbreak' },
    { mode: '160000', objectId: 'c'.repeat(40), stage: 0, path: 'module with space' },
  ]);
  assert.throws(() => GitRestore.parseIndexEntries(`not-an-index-record\0`), /malformed Git index/i);
  assert.throws(() => GitRestore.parseIndexEntries(`100644 ${'a'.repeat(40)} 0\tmissing-terminator`), /NUL terminator/i);
});

test('Git porcelain -z parser consumes rename/copy source path fields as part of one record', () => {
  const raw = 'R  new name.txt\0old name.txt\0C  copy.txt\0source\nname.txt\0 M ordinary.txt\0';
  assert.deepEqual(GitRestore.parseStatus(raw), [
    { code: 'R ', path: 'new name.txt', originalPath: 'old name.txt' },
    { code: 'C ', path: 'copy.txt', originalPath: 'source\nname.txt' },
    { code: ' M', path: 'ordinary.txt' },
  ]);
  assert.throws(() => GitRestore.parseStatus('R  new.txt\0'), /lacks its source path/i);
});

test('inspectGit rejects an indexed symlink mode after ordinary NUL records', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root, { 'a.txt': 'ordinary\n', 'b.txt': 'ordinary too\n' });
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'link-target', encoding: 'utf8' }).trim();
    await H.git(root, ['update-index', '--add', '--cacheinfo', `120000,${blob},zz-link`]);
    const raw = await GitRestore.required(root, ['ls-files', '--stage', '-z']);
    const parsed = GitRestore.parseIndexEntries(raw);
    assert.equal(parsed[0].mode, '100644');
    assert.equal(parsed.at(-1).mode, '120000');
    await assert.rejects(GitRestore.inspectGit(root), /indexed symbolic links are unsupported/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('inspectGit rejects an indexed gitlink mode after ordinary NUL records', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root, { 'a.txt': 'ordinary\n', 'b.txt': 'ordinary too\n' });
    const commit = (await H.git(root, ['rev-parse', 'HEAD'])).trim();
    await H.git(root, ['update-index', '--add', '--cacheinfo', `160000,${commit},zz-module`]);
    const raw = await GitRestore.required(root, ['ls-files', '--stage', '-z']);
    const parsed = GitRestore.parseIndexEntries(raw);
    assert.equal(parsed[0].mode, '100644');
    assert.equal(parsed.at(-1).mode, '160000');
    await assert.rejects(GitRestore.inspectGit(root), /submodule restore is unsupported/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Git porcelain -z output from a real rename keeps both paths in one parsed record', async () => {
  const root = tempProject();
  try {
    await H.setupGit(root, { 'old name.txt': 'rename fixture\n' });
    await H.git(root, ['mv', 'old name.txt', 'new name.txt']);
    const raw = await GitRestore.required(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const parsed = GitRestore.parseStatus(raw);
    assert.deepEqual(parsed, [{ code: 'R ', path: 'new name.txt', originalPath: 'old name.txt' }]);
    assert.deepEqual((await GitRestore.inspectGit(root)).dirty, parsed);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
