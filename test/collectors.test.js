'use strict';
// Unit tests for collectors and helpers (no network, no external services).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { parseEnv, collectGit, collectDeps, collectConfig, COLLECTORS } = require('../lib/collectors');
const U = require('../lib/utils');

// ---- name validation -------------------------------------------------------

test('NAME_RE accepts safe names', () => {
  for (const n of ['working', 'before-refactor', 'auto-20261009-003500', 'v1.2']) {
    assert.ok(U.NAME_RE.test(n), n);
  }
});

test('NAME_RE rejects path traversal and junk', () => {
  for (const n of ['../evil', 'a/b', 'a b', '', '.hidden-x'.slice(0), 'x'.repeat(65), '-lead']) {
    assert.ok(!U.NAME_RE.test(n), `should reject: ${n}`);
  }
});

// ---- parseEnv (desensitization core) ----------------------------------------

test('parseEnv keeps key names + nonEmpty only, never values', () => {
  const keys = parseEnv(
    [
      '# comment line',
      'API_KEY=super-secret-value-123',
      'DEBUG=',
      '  export TRIMMED="quoted value"  ',
      "SINGLE='sq'",
      'MALFORMED LINE WITHOUT EQUALS',
      '=no-key',
      'SP ACED=no',
      '',
    ].join('\n')
  );
  assert.deepStrictEqual(Object.keys(keys).sort(), ['API_KEY', 'DEBUG', 'SINGLE', 'TRIMMED']);
  assert.strictEqual(keys.API_KEY.nonEmpty, true);
  assert.strictEqual(keys.DEBUG.nonEmpty, false);
  assert.strictEqual(keys.TRIMMED.nonEmpty, true);
  assert.strictEqual(keys.SINGLE.nonEmpty, true);
  // The parsed object must not contain any value text.
  assert.ok(!JSON.stringify(keys).includes('super-secret-value-123'));
});

// ---- fixture project ---------------------------------------------------------

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-unit-'));

// Async git helper (spawnSync is unavailable in some sandboxed environments;
// async execFile works everywhere).
function git(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: proj,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.join(' ')} failed: ${(stderr || err.message || '').trim()}`));
        else resolve(stdout);
      }
    );
  });
}

const LOCK = {
  name: 'demo',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'demo', version: '1.0.0', dependencies: { lodash: '^4.17.21' } },
    'node_modules/lodash': {
      version: '4.17.21',
      resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
      integrity: 'sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==',
    },
  },
};

test('fixture setup: git repo + deps + env', async () => {
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { lodash: '^4.17.21' } }, null, 2));
  fs.writeFileSync(path.join(proj, 'package-lock.json'), JSON.stringify(LOCK, null, 2));
  fs.writeFileSync(path.join(proj, '.env'), 'API_KEY=unit-secret-abc\nDEBUG=\n');
  await git(['init']);
  await git(['add', '-A']);
  await git(['commit', '-m', 'init']);
});

test('collectGit returns commit/branch/dirty', async () => {
  const ctx = { root: proj, results: {}, files: [] };
  const r = await collectGit(ctx);
  assert.strictEqual(r.status, 'collected');
  assert.match(r.data.commit, /^[0-9a-f]{40}$/);
  assert.ok(r.data.branch === 'master' || r.data.branch === 'main');
  assert.strictEqual(r.data.dirty, false);
});

test('collectGit skips outside a git repo', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-nogit-'));
  const ctx = { root: plain, results: {}, files: [] };
  const r = await collectGit(ctx);
  assert.strictEqual(r.status, 'skipped');
  assert.ok(r.reason.length > 5);
  fs.rmSync(plain, { recursive: true, force: true });
});

test('collectDeps fingerprints lockfile and resolves direct deps', async () => {
  const ctx = { root: proj, results: {}, files: [] };
  const r = await collectDeps(ctx);
  assert.strictEqual(r.status, 'collected');
  assert.strictEqual(r.data.lockFile, 'package-lock.json');
  assert.ok(r.data.lockFingerprint.length > 0);
  assert.strictEqual(r.data.resolved.lodash, '4.17.21');
  // The lockfile copy is queued for the files/ archive.
  assert.ok(ctx.files.some((f) => f.destName === 'package-lock.json' && !f.secret));
});

test('collectDeps skips without package.json', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-nopkg-'));
  const ctx = { root: plain, results: {}, files: [] };
  const r = await collectDeps(ctx);
  assert.strictEqual(r.status, 'skipped');
  fs.rmSync(plain, { recursive: true, force: true });
});

test('collectConfig desensitizes .env and queues secrets copy', async () => {
  const ctx = { root: proj, results: {}, files: [] };
  const r = await collectConfig(ctx);
  assert.strictEqual(r.status, 'collected');
  assert.strictEqual(r.data.envFiles['.env'].keys.API_KEY.nonEmpty, true);
  assert.ok(!JSON.stringify(r.data).includes('unit-secret-abc'), 'no real value may appear in layer data');
  const secretCopy = r.files.find((f) => f.destName === '.env');
  assert.ok(secretCopy && secretCopy.secret === true, '.env raw copy must be flagged secret');
});

test('collectConfig skips without env files', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-noenv-'));
  const ctx = { root: plain, results: {}, files: [] };
  const r = await collectConfig(ctx);
  assert.strictEqual(r.status, 'skipped');
  fs.rmSync(plain, { recursive: true, force: true });
});

test('all six collectors are registered in order', () => {
  assert.deepStrictEqual(
    COLLECTORS.map((c) => c.id),
    ['git', 'deps', 'runtime', 'config', 'docker', 'database']
  );
});

test('ensureLocalExclude is idempotent and append-only (v1.2.1: .git/info/exclude)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-gi-'));
  fs.mkdirSync(path.join(tmp, '.git', 'info'), { recursive: true });
  // Pre-existing content (as git's default exclude has) must be preserved.
  const excludeFile = path.join(tmp, '.git', 'info', 'exclude');
  fs.writeFileSync(excludeFile, '# git default exclude\n*.orig\n', 'utf8');
  const added1 = await U.ensureLocalExclude(tmp, '.project-state/');
  const added2 = await U.ensureLocalExclude(tmp, '.project-state/');
  assert.strictEqual(added1, true);
  assert.strictEqual(added2, false);
  const content = fs.readFileSync(excludeFile, 'utf8');
  assert.strictEqual(content.split('.project-state/').length - 1, 1);
  assert.ok(content.startsWith('# git default exclude\n*.orig\n'), 'existing content preserved, append-only');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('ensureLocalExclude no-ops on non-git projects', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-gi2-'));
  const added = await U.ensureLocalExclude(tmp, '.project-state/');
  assert.strictEqual(added, false);
  assert.ok(!fs.existsSync(path.join(tmp, '.git')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('unit cleanup', () => {
  fs.rmSync(proj, { recursive: true, force: true });
});
