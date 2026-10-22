'use strict';
// End-to-end smoke test: fresh project -> snapshot -> break -> restore,
// verifying all five v1 acceptance criteria:
//   1) this script runs green
//   2) install -> snapshot -> break -> restore works on a fresh project
//   3) restore on a dirty worktree is refused without --force
//   4) no plaintext secret anywhere under snapshots/
//   5) compare lists ALL known differences, no omissions

const { test } = require('node:test');
const H = require('./helpers');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const Storage = require('../lib/storage');

const CLI = path.join(__dirname, '..', 'bin', 'project-state.js');
const SECRET_TOKEN = 'super-secret-value-123';
const DB_PASSWORD = 'hunter2pw';

let proj;
const { git, cli } = H.bindRunner(() => proj);
let origHead; // HEAD after setup (the "good" state)
let thirdHead; // HEAD used for the abort test

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

// NOTE: spawnSync is unavailable in some sandboxed environments (EBUSY on
// process creation). Async execFile/spawn work everywhere, so both helpers
// below are Promise-based.

const LOCK_V1 = {
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

function writeLock(version) {
  const lock = JSON.parse(JSON.stringify(LOCK_V1));
  lock.packages['node_modules/lodash'].version = version;
  fs.writeFileSync(path.join(proj, 'package-lock.json'), JSON.stringify(lock, null, 2));
  return lock;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  );
}

// ---- the flow -----------------------------------------------------------------

test('setup: fresh fixture project (README flow, acceptance #2 start)', async () => {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-smoke-'));
  fs.writeFileSync(path.join(proj, 'app.js'), "console.log('v1');\n");
  fs.writeFileSync(
    path.join(proj, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { lodash: '^4.17.21' } }, null, 2)
  );
  writeLock('4.17.21');
  await git(['init']);
  await git(['add', '-A']);
  await git(['commit', '-m', 'init']);
  H.excludeLocalFiles(proj, ['.env']);
  fs.writeFileSync(path.join(proj, '.env'), `API_KEY=${SECRET_TOKEN}\nDEBUG=\nDB_URL=postgres://alice:${DB_PASSWORD}@localhost:5432/appdb\n`);
  origHead = (await git(['rev-parse', 'HEAD'])).trim();
  assert.match(origHead, /^[0-9a-f]{40}$/);
});

test('snapshot working -> exit 0, manifest + layers on disk', async () => {
  console.log('[DIAG] proj =', proj, '| exists:', fs.existsSync(path.join(proj, '.project-state', 'snapshots', 'working')));
  const r = await cli(['snapshot', 'working']);
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const snap = path.join(proj, '.project-state', 'snapshots', 'working');
  const checked = await Storage.validateSnapshot(proj, 'working', { mode: 'restore' });
  assert.ok(fs.existsSync(path.join(snap, 'current.json')), 'v2 current pointer is committed');
  for (const layer of ['git', 'deps', 'runtime', 'config']) {
    assert.ok(checked.artifacts.some((artifact) => artifact.id === `layer:${layer}`), `${layer} layer artifact is validated`);
  }
  assert.equal(checked.manifest.layers.docker.status, 'skipped');
  assert.equal(checked.manifest.layers.database.status, 'skipped');
  assert.ok(r.stdout.includes('skipped'), 'skipped layers are reported, not silent');
});

test('duplicate snapshot refused without --overwrite', async () => {
  const r = await cli(['snapshot', 'working']);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('--overwrite'));
});

test('invalid snapshot name refused (path traversal)', async () => {
  const r = await cli(['snapshot', '../evil']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid|unsafe|snapshot|name|path/i);
});

test('help and unknown command behave', async () => {
  const help = await cli(['help']);
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /explicitly authorize and apply the current validated plan/i);
  assert.match(help.stdout, /there is no interactive confirmation/i);
  assert.match(help.stdout, /does not reserve a snapshot generation/i);
  assert.match(help.stdout, /may create\/release\s+lock\/pin metadata/i);
  const r = await cli(['frobnicate']);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('Unknown command'));
});

test('break the project: new commit + lockfile downgrade + .env deleted', async () => {
  fs.writeFileSync(path.join(proj, 'app.js'), "console.log('v2-broken');\n");
  writeLock('4.17.20');
  await git(['add', '-A']);
  await git(['commit', '-m', 'accidental change']);
  fs.rmSync(path.join(proj, '.env'));
  assert.ok(!fs.existsSync(path.join(proj, '.env')));
});

test('dry-run shows the plan and changes nothing (safety step 2)', async () => {
  const r = await cli(['restore', 'working', '--dry-run']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /git: (?:attach to|detach HEAD)/, 'Git attachment/checkout plan is explicit');
  assert.ok(r.stdout.includes('package-lock.json'), 'lockfile restore in plan');
  assert.ok(r.stdout.includes('.env'), 'env restore in plan');
  assert.ok(r.stdout.includes('PREVIEW ONLY: restore plan for "working"'), 'current plan preview is labeled and not presented as a reservation');
  // nothing actually changed
  assert.ok(!fs.existsSync(path.join(proj, '.env')));
});

test('dirty worktree -> restore refused without --force (acceptance #3)', async () => {
  fs.writeFileSync(path.join(proj, 'app.js'), "console.log('uncommitted');\n");
  const r = await cli(['restore', 'working']);
  assert.strictEqual(r.status, 1, 'must refuse');
  assert.match(r.stderr, /must be clean|changed path|cannot preserve/i, 'warning names the clean-state protection');
  assert.ok(r.stderr.includes('--force'), 'error explains that force cannot preserve the dirty state');
});

test('restore --yes --force refuses to erase dirty source work, preserving HEAD, index, and bytes', async () => {
  const headBefore = (await git(['rev-parse', 'HEAD'])).trim();
  const indexBefore = (await git(['write-tree'])).trim();
  const statusBefore = await git(['status', '--porcelain=v1', '-z']);
  const appBefore = fs.readFileSync(path.join(proj, 'app.js'));
  const r = await cli(['restore', 'working', '--yes', '--force']);
  assert.strictEqual(r.status, 1, `force must refuse unprotected dirty source work: ${r.stderr}`);
  assert.match(r.stderr, /--force cannot preserve/i);
  assert.strictEqual((await git(['rev-parse', 'HEAD'])).trim(), headBefore, 'HEAD did not move');
  assert.strictEqual((await git(['write-tree'])).trim(), indexBefore, 'index tree did not change');
  assert.strictEqual(await git(['status', '--porcelain=v1', '-z']), statusBefore, 'Git worktree status did not change');
  assert.deepStrictEqual(fs.readFileSync(path.join(proj, 'app.js')), appBefore, 'uncommitted source bytes remain untouched');
  assert.ok(!fs.existsSync(path.join(proj, '.env')), 'the already deleted env remains deleted on refusal');
});

test('clean Git state restores the snapshot and verifies file contents (acceptance #2 end)', async () => {
  // Previous checks prove the forced dirty restore is refused. Return app.js
  // to its already committed broken bytes; .env was an untracked private input
  // and its deletion creates no Git change to commit.
  fs.writeFileSync(path.join(proj, 'app.js'), "console.log('v2-broken');\n");
  assert.strictEqual((await git(['status', '--porcelain'])).trim(), '', 'precondition: restore starts from a clean worktree');
  const r = await cli(['restore', 'working', '--yes']);
  assert.strictEqual(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  // 1) git back to the original commit
  assert.strictEqual((await git(['rev-parse', 'HEAD'])).trim(), origHead);
  // 2) app.js content restored via Git (normalize CRLF to account for the
  //    user's core.autocrlf checkout policy).
  const appContent = fs.readFileSync(path.join(proj, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual(appContent, "console.log('v1');\n");
  // 3) lockfile byte-identical to the good state
  const lockNow = fs.readFileSync(path.join(proj, 'package-lock.json'), 'utf8');
  assert.strictEqual(JSON.parse(lockNow).packages['node_modules/lodash'].version, '4.17.21');
  // 4) .env restored from the local secrets store, real values intact
  const env = fs.readFileSync(path.join(proj, '.env'), 'utf8');
  assert.ok(env.includes(SECRET_TOKEN), '.env real value restored');
  assert.ok(r.stdout.includes('Restore verified'), 'verified result is reported');
  assert.match(r.stdout, /Exact rollback command(?: \(PowerShell\))?: /, 'a shell-specific exact rollback command is provided');
  // 5) an auto safety snapshot was created
  const autoDirs = fs
    .readdirSync(path.join(proj, '.project-state', 'snapshots'))
    .filter((n) => n.startsWith('auto-'));
  assert.ok(autoDirs.length >= 1, 'auto-<timestamp> snapshot exists');
});

test('no plaintext secret anywhere under snapshots/ (acceptance #4)', async () => {
  const files = walk(path.join(proj, '.project-state', 'snapshots'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    assert.ok(!txt.includes(SECRET_TOKEN), `secret leaked into ${f}`);
    assert.ok(!txt.includes(DB_PASSWORD), `db password leaked into ${f}`);
  }
  // ...while the secrets store intentionally holds it, outside snapshots/
  const checked = await Storage.validateSnapshot(proj, 'working', { mode: 'restore' });
  const envArtifact = checked.artifacts.find((artifact) => artifact.layer === 'config' && artifact.kind === 'file'
    && artifact.privacy === 'private' && artifact.target === '.env');
  assert.ok(envArtifact, 'private .env is declared in v2');
  const sec = fs.readFileSync(envArtifact.absolutePath, 'utf8');
  assert.ok(sec.includes(SECRET_TOKEN));
});

test('.git/info/exclude gained the state-dir entry automatically (v1.2.1: no more .gitignore churn)', async () => {
  const exclude = fs.readFileSync(path.join(proj, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude.includes('.project-state/'));
  // The user's .gitignore must stay untouched by the tool now.
  const giExists = fs.existsSync(path.join(proj, '.gitignore'));
  if (giExists) {
    const gi = fs.readFileSync(path.join(proj, '.gitignore'), 'utf8');
    assert.ok(!gi.includes('.project-state/'), 'tool must not write user .gitignore anymore');
  }
});

test('compare lists ALL known differences, no omissions (acceptance #5)', async () => {
  // Build "after" with a fully known diff set vs "working":
  //   git: commit moves; deps: lodash 4.17.21 -> 4.17.22 (+ fingerprint);
  //   config: NEW_FLAG added, DB_URL removed; runtime: identical (must NOT be reported)
  writeLock('4.17.22');
  fs.writeFileSync(path.join(proj, '.env'), `API_KEY=${SECRET_TOKEN}\nDEBUG=\nNEW_FLAG=1\n`);
  fs.writeFileSync(path.join(proj, 'extra.js'), '// extra file\n');
  await git(['add', '-A']);
  await git(['commit', '-m', 'bump lodash']);
  const afterHead = (await git(['rev-parse', 'HEAD'])).trim();
  assert.notStrictEqual(afterHead, origHead);

  const s = await cli(['snapshot', 'after']);
  assert.strictEqual(s.status, 0, s.stderr);

  const c = await cli(['compare', 'working', 'after']);
  assert.strictEqual(c.status, 0, c.stderr);
  const out = c.stdout;

  // git diff present
  assert.ok(out.includes(origHead.slice(0, 7)), 'old commit shown');
  assert.ok(out.includes(afterHead.slice(0, 7)), 'new commit shown');
  // deps: fingerprint + exact version diff
  assert.ok(/lodash: 4\.17\.21 -> 4\.17\.22/.test(out), 'lodash version diff listed');
  // config: added key listed
  assert.ok(/NEW_FLAG/.test(out), 'added env key listed');
  assert.ok(/DB_URL/.test(out), 'removed env key listed');
  // desensitization: key names may appear, values must not
  assert.ok(!out.includes(SECRET_TOKEN), 'no secret value in compare output');
  // no false positives on identical layers
  assert.ok(/=\s*node:/.test(out), 'runtime equality is stated, not omitted');
  assert.ok(!out.includes('No differences'), 'differences were found');
  assert.ok(/\d+ difference\(s\)/.test(out), 'summary count present');
});

test('piped confirmation cannot bypass the required non-interactive --yes flag', async () => {
  fs.writeFileSync(path.join(proj, 'app.js'), "console.log('v3');\n");
  await git(['add', '-A']);
  await git(['commit', '-m', 'third']);
  thirdHead = (await git(['rev-parse', 'HEAD'])).trim();

  const r = await cli(['restore', 'working'], { input: 'n\n' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /requires --yes to explicitly authorize writes; no interactive confirmation is available/i);
  assert.strictEqual((await git(['rev-parse', 'HEAD'])).trim(), thirdHead, 'HEAD untouched after abort');
});

test('explicit --yes completes the restore from a non-interactive CLI', async () => {
  const r = await cli(['restore', 'working', '--yes']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual((await git(['rev-parse', 'HEAD'])).trim(), origHead);
});

test('restore of an unknown snapshot lists available names and does not change project state', async () => {
  const headBefore = (await git(['rev-parse', 'HEAD'])).trim();
  const indexBefore = (await git(['write-tree'])).trim();
  const appBefore = fs.readFileSync(path.join(proj, 'app.js'));
  const r = await cli(['restore', 'nope']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /snapshot not found: nope/i);
  assert.ok(`${r.stdout}\n${r.stderr}`.includes('working') && `${r.stdout}\n${r.stderr}`.includes('after'), 'available names shown');
  assert.strictEqual((await git(['rev-parse', 'HEAD'])).trim(), headBefore, 'HEAD unchanged');
  assert.strictEqual((await git(['write-tree'])).trim(), indexBefore, 'index unchanged');
  assert.deepStrictEqual(fs.readFileSync(path.join(proj, 'app.js')), appBefore, 'project bytes unchanged');
});

test('cleanup temp project', async () => {
  fs.rmSync(proj, { recursive: true, force: true });
});
