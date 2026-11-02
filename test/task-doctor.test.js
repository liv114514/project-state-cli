'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers');
const Store = require('../lib/storage');
const DoctorTask = require('../lib/doctor-task');

function project(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-task-doctor-'));
  t.after(() => H.removeTemporaryTree(root));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  return root;
}

function parseJson(result) {
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1, result.stdout);
  return JSON.parse(result.stdout);
}

function treeDigest(root) {
  const rows = [];
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { rows.push([relative, 'directory']); visit(absolute, relative); }
      else if (entry.isFile()) rows.push([relative, 'file', crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
      else rows.push([relative, 'other']);
    }
  };
  visit(root);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

test('task doctor: no applicable config is not-applicable and creates no state', async (t) => {
  const root = project(t, { 'app.js': 'module.exports = 1;\n' });
  const result = await H.cli(root, ['doctor', '--task', 'config-snapshot', '--json']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const body = parseJson(result);
  assert.equal(body.resultSchemaVersion, 1);
  assert.equal(body.task, 'config-snapshot');
  assert.equal(body.summary.state, 'not-applicable');
  assert.ok(body.checks.some((check) => check.id === 'config.applicability' && check.state === 'not-applicable'));
  assert.equal(fs.existsSync(path.join(root, '.project-state')), false);
});

test('task doctor: text and JSON share check states and do not disclose config values or paths', async (t) => {
  const secret = 'TASK_DOCTOR_SECRET_7fd3e2';
  const root = project(t, { '.env': `TOKEN=${secret}\n`, 'app.js': 'module.exports = 1;\n' });
  const before = fs.readFileSync(path.join(root, '.env'));
  const jsonRun = await H.cli(root, ['doctor', '--task', 'config-snapshot', '--json']);
  const textRun = await H.cli(root, ['doctor', '--task', 'config-snapshot']);
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  assert.equal(textRun.status, 0, textRun.stderr);
  const body = parseJson(jsonRun);
  assert.equal(body.summary.state, 'ready');
  assert.deepEqual(Object.keys(body).sort(), ['checks', 'command', 'limitations', 'nextStep', 'projectContext', 'resultSchemaVersion', 'summary', 'task', 'toolVersion'].sort());
  assert.deepEqual(Object.keys(body.checks[0]).sort(), ['id', 'message', 'reasonCode', 'required', 'state'].sort());
  for (const check of body.checks) {
    assert.match(textRun.stdout, new RegExp(`${check.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s+${check.state}\\s+\\[${check.reasonCode}\\]`));
  }
  for (const output of [jsonRun.stdout, jsonRun.stderr, textRun.stdout, textRun.stderr]) {
    assert.equal(output.includes(secret), false);
    assert.equal(output.includes(root), false);
  }
  assert.deepEqual(fs.readFileSync(path.join(root, '.env')), before);
  assert.equal(fs.existsSync(path.join(root, '.project-state')), false);
});

test('task doctor: absent requested snapshot is distinguished from invalid snapshot', async (t) => {
  const root = project(t, { '.env': 'PORT=4123\n' });
  const missing = await H.cli(root, ['doctor', '--task', 'config-restore', '--snapshot', 'absent', '--json']);
  assert.equal(missing.status, 1, missing.stderr);
  const missingBody = parseJson(missing);
  assert.equal(missingBody.summary.state, 'blocked');
  assert.ok(missingBody.checks.some((check) => check.reasonCode === 'SNAPSHOT_NOT_FOUND' && check.state === 'issue'));
  assert.equal(fs.existsSync(path.join(root, '.project-state')), false);
});

test('task doctor: valid config snapshot produces a preview suggestion without lock, pin, journal, or generation writes', async (t) => {
  const root = project(t, { '.env': 'PORT=4123\n', 'app.js': 'module.exports = 1;\n' });
  await H.git(root, ['init']);
  H.excludeLocalFiles(root, ['.env']);
  await H.git(root, ['add', 'app.js']);
  await H.git(root, ['commit', '-m', 'baseline']);
  const saved = await H.cli(root, ['snapshot', 'baseline']);
  assert.equal(saved.status, 0, saved.stderr);
  const beforeHead = (await H.git(root, ['rev-parse', 'HEAD'])).trim();
  const beforeIndex = fs.readFileSync(path.join(root, '.git', 'index'));
  const beforeRefs = await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/']);
  const beforeState = treeDigest(path.join(root, '.project-state'));

  const result = await H.cli(root, ['doctor', '--task', 'config-restore', '--snapshot', 'baseline', '--json']);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const body = parseJson(result);
  assert.equal(body.summary.state, 'ready');
  assert.ok(body.checks.some((check) => check.id === 'snapshot.integrity' && check.state === 'ok'));
  assert.ok(body.nextStep && body.nextStep.command === 'restore');
  assert.ok(!body.nextStep.args.includes('--yes'));
  assert.equal(body.nextStep.cwd, 'current-working-directory');
  assert.deepEqual((await H.git(root, ['rev-parse', 'HEAD'])).trim(), beforeHead);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'index')), beforeIndex);
  assert.equal(await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/']), beforeRefs);
  assert.equal(treeDigest(path.join(root, '.project-state')), beforeState);
  assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')), false);
});

test('task doctor: missing SQLite is optional for config snapshot', async (t) => {
  const root = project(t, { '.env': 'PORT=4123\n' });
  const result = await H.cli(root, ['doctor', '--task', 'config-snapshot', '--json'], { ...process.env, PATH: path.dirname(process.execPath) });
  assert.equal(result.status, 0, result.stderr);
  const body = parseJson(result);
  const sqlite = body.checks.find((check) => check.id === 'tool.sqlite3');
  assert.ok(sqlite);
  assert.equal(sqlite.required, false);
  assert.equal(sqlite.state, 'unknown');
  assert.equal(sqlite.reasonCode, 'OPTIONAL_TOOL_UNAVAILABLE');
  assert.notEqual(body.summary.state, 'blocked');
});

test('task doctor: missing Git blocks privacy checks only for a Git project', async (t) => {
  const root = project(t, { '.env': 'TOKEN=NEVER_EMIT\n', 'app.js': 'module.exports = 1;\n' });
  await H.git(root, ['init']);
  await H.git(root, ['add', 'app.js']);
  await H.git(root, ['commit', '-m', 'baseline']);
  const before = fs.readFileSync(path.join(root, '.git', 'index'));
  const result = await H.cli(root, ['doctor', '--task', 'config-snapshot', '--json'], {
    ...process.env,
    PATH: path.dirname(process.execPath),
  });
  assert.equal(result.status, 1, result.stdout);
  const body = parseJson(result);
  assert.ok(body.checks.some((item) => item.id === 'tool.git' && item.state === 'issue' && item.reasonCode === 'GIT_UNAVAILABLE'));
  assert.ok(body.checks.some((item) => item.id === 'privacy.git-exclusion' && item.state === 'unknown'));
  assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'index')), before);
  assert.equal(fs.existsSync(path.join(root, '.project-state')), false);
  assert.equal(result.stdout.includes('NEVER_EMIT'), false);
});

test('task doctor: dirty Git state blocks config restore and does not mutate it', async (t) => {
  const root = project(t, { '.env': 'PORT=4123\n', 'app.js': 'module.exports = 1;\n' });
  await H.git(root, ['init']);
  H.excludeLocalFiles(root, ['.env']);
  await H.git(root, ['add', 'app.js']);
  await H.git(root, ['commit', '-m', 'baseline']);
  await H.cli(root, ['snapshot', 'baseline']);
  fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 2;\n');
  const before = fs.readFileSync(path.join(root, '.git', 'index'));
  const result = await H.cli(root, ['doctor', '--task', 'config-restore', '--snapshot', 'baseline', '--json']);
  assert.equal(result.status, 1, result.stderr);
  const body = parseJson(result);
  assert.equal(body.summary.state, 'blocked');
  assert.ok(body.checks.some((check) => check.reasonCode === 'GIT_WORKTREE_DIRTY' && check.state === 'issue'));
  assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'index')), before);
  assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'module.exports = 2;\n');
});

test('task doctor: malformed task arguments are rejected without project writes', async (t) => {
  const root = project(t, { '.env': 'PORT=4123\n' });
  const result = await H.cli(root, ['doctor', '--task', 'config-restore', '--json']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--snapshot/);
  assert.equal(fs.existsSync(path.join(root, '.project-state')), false);
});

test('task doctor: treats the supplied subdirectory as its exact project scope', async (t) => {
  const root = project(t, { '.env': 'TOKEN=DO_NOT_READ_PARENT\n' });
  const child = path.join(root, 'nested');
  fs.mkdirSync(child);
  fs.writeFileSync(path.join(child, 'app.js'), 'module.exports = 1;\n');
  const result = await H.cli(child, ['doctor', '--task', 'config-snapshot', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseJson(result).summary.state, 'not-applicable');
  assert.equal(fs.existsSync(path.join(root, '.project-state')), false);
  assert.equal(fs.existsSync(path.join(child, '.project-state')), false);
  assert.equal(result.stdout.includes('DO_NOT_READ_PARENT'), false);
});

test('task doctor: a non-file configuration path is an issue without repair or writes', async (t) => {
  const root = project(t);
  fs.mkdirSync(path.join(root, '.env'));
  const before = fs.readdirSync(root).sort();
  const result = await H.cli(root, ['doctor', '--task', 'config-snapshot', '--json']);
  assert.equal(result.status, 1, result.stdout);
  const body = parseJson(result);
  assert.ok(body.checks.some((item) => item.id === 'config.files' && item.state === 'issue' && item.reasonCode === 'CONFIG_FILE_UNSAFE'));
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.equal(fs.existsSync(path.join(root, '.project-state')), false);
});

test('task doctor: missing required artifact and unknown schema have distinct diagnoses', async (t) => {
  const root = project(t, { '.env': 'PORT=4123\n', 'app.js': 'module.exports = 1;\n' });
  await H.git(root, ['init']);
  H.excludeLocalFiles(root, ['.env']);
  await H.git(root, ['add', 'app.js']);
  await H.git(root, ['commit', '-m', 'baseline']);
  const saved = await H.cli(root, ['snapshot', 'baseline']);
  assert.equal(saved.status, 0, saved.stderr);

  const original = await Store.validateSnapshot(root, 'baseline', { mode: 'restore' });
  const envArtifact = original.artifacts.find((item) => item.layer === 'config' && item.target === '.env');
  const envPath = path.join(original.paths.privateGenerationDir, 'files', ...envArtifact.path.split('/'));
  const envBytes = fs.readFileSync(envPath);
  fs.unlinkSync(envPath);
  const missing = await H.cli(root, ['doctor', '--task', 'config-restore', '--snapshot', 'baseline', '--json']);
  assert.equal(missing.status, 1, missing.stdout);
  assert.ok(parseJson(missing).checks.some((item) => item.id === 'snapshot.integrity' && item.reasonCode === 'SNAPSHOT_ARTIFACT_MISSING'));
  fs.writeFileSync(envPath, envBytes, { flag: 'wx' });

  const publicManifestPath = path.join(original.paths.publicGenerationDir, 'manifest.json');
  const privateManifestPath = path.join(original.paths.privateGenerationDir, 'manifest.json');
  const publicManifest = JSON.parse(fs.readFileSync(publicManifestPath, 'utf8'));
  const privateManifest = JSON.parse(fs.readFileSync(privateManifestPath, 'utf8'));
  publicManifest.schemaVersion = 999;
  privateManifest.schemaVersion = 999;
  const publicBytes = Buffer.from(`${JSON.stringify(publicManifest, null, 2)}\n`);
  fs.writeFileSync(publicManifestPath, publicBytes);
  fs.writeFileSync(privateManifestPath, `${JSON.stringify(privateManifest, null, 2)}\n`);
  const pointerPath = original.paths.currentFile;
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  pointer.publicManifestSha256 = Store.hash(publicBytes);
  fs.writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  const unsupported = await H.cli(root, ['doctor', '--task', 'config-restore', '--snapshot', 'baseline', '--json']);
  assert.equal(unsupported.status, 1, unsupported.stdout);
  assert.ok(parseJson(unsupported).checks.some((item) => item.id === 'snapshot.integrity' && item.reasonCode === 'SNAPSHOT_SCHEMA_UNSUPPORTED'));
});

test('task doctor: missing current directory must not be summarized as not-applicable', async (t) => {
  const root = project(t, { 'app.js': 'module.exports = 1;\n' });
  await H.removeTemporaryTree(root);
  const result = await DoctorTask.buildTaskDoctorResult(root, { task: 'config-snapshot' });
  assert.notEqual(result.summary.state, 'not-applicable');
  assert.ok(result.checks.some((item) => item.id === 'project.context' && ['issue', 'unknown'].includes(item.state)));
});

test('task doctor: config restore cannot be ready outside the Git repository restore supports', async (t) => {
  const root = project(t, { '.env': 'PORT=4123\n', 'app.js': 'module.exports = 1;\n' });
  await H.git(root, ['init']);
  H.excludeLocalFiles(root, ['.env']);
  await H.git(root, ['add', 'app.js']);
  await H.git(root, ['commit', '-m', 'baseline']);
  const saved = await H.cli(root, ['snapshot', 'baseline']);
  assert.equal(saved.status, 0, saved.stderr);
  fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });

  const result = await DoctorTask.buildTaskDoctorResult(root, { task: 'config-restore', snapshot: 'baseline' });
  assert.equal(result.summary.state, 'blocked');
  assert.ok(result.checks.some((item) => item.id === 'git.worktree' && item.state === 'issue' && item.reasonCode === 'GIT_REPOSITORY_REQUIRED'));
});

test('task doctor: read-only Git inspection leaves the index bytes unchanged', async (t) => {
  const root = project(t, { '.env': 'PORT=4124\n', 'app.js': 'module.exports = 1;\n' });
  await H.git(root, ['init']);
  H.excludeLocalFiles(root, ['.env']);
  await H.git(root, ['add', 'app.js']);
  await H.git(root, ['commit', '-m', 'baseline']);
  const saved = await H.cli(root, ['snapshot', 'baseline']);
  assert.equal(saved.status, 0, saved.stderr);

  const index = path.join(root, '.git', 'index');
  const before = require('crypto').createHash('sha256').update(fs.readFileSync(index)).digest('hex');
  const changedTime = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(root, 'app.js'), changedTime, changedTime);
  const result = await DoctorTask.buildTaskDoctorResult(root, { task: 'config-restore', snapshot: 'baseline' });
  assert.equal(result.summary.state, 'ready');
  const after = require('crypto').createHash('sha256').update(fs.readFileSync(index)).digest('hex');
  assert.equal(after, before, 'read-only Git inspection must not refresh the index');
});
