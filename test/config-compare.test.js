'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers');
const Store = require('../lib/storage');
const Compare = require('../lib/compare');

function tempProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pss-config-compare-')); }

async function setupConfigProject(root, value) {
  await H.setupGit(root, { '.gitignore': '.env\n.env.local\n' });
  H.excludeLocalFiles(root, ['.env', '.env.local']);
  fs.writeFileSync(path.join(root, '.env'), value);
  return H.bindRunner(root);
}

test('compare identifies private config byte changes without revealing values', async () => {
  const root = tempProject();
  try {
    const { cli } = await setupConfigProject(root, 'API_TOKEN=alpha-private-marker\n');
    assert.equal((await cli(['snapshot', 'config-a'])).status, 0);
    fs.writeFileSync(path.join(root, '.env'), 'API_TOKEN=bravo-private-marker\n');
    fs.writeFileSync(path.join(root, '.env.local'), 'SECONDARY=charlie-private-marker\n');
    assert.equal((await cli(['snapshot', 'config-b'])).status, 0);

    const changed = await cli(['compare', 'config-a', 'config-b']);
    assert.equal(changed.status, 0, `${changed.stdout}\n${changed.stderr}`);
    assert.match(changed.stdout, /~ env file \.env contents changed \(values withheld\)/);
    assert.match(changed.stdout, /\+ key SECONDARY added in \.env\.local \(non-empty\)/);
    assert.doesNotMatch(changed.stdout, /alpha-private-marker|bravo-private-marker|charlie-private-marker/);
    assert.doesNotMatch(changed.stdout, /[a-f0-9]{64}/i);

    const reversed = await cli(['compare', 'config-b', 'config-a']);
    assert.equal(reversed.status, 0, `${reversed.stdout}\\n${reversed.stderr}`);
    assert.match(reversed.stdout, /- env file \.env\.local: present in A only/);
    assert.match(reversed.stdout, /- key SECONDARY removed with \.env\.local/);
    assert.doesNotMatch(reversed.stdout, /charlie-private-marker/);

    const same = await cli(['compare', 'config-b', 'config-b']);
    assert.equal(same.status, 0, `${same.stdout}\n${same.stderr}`);
    assert.match(same.stdout, /= env file \.env contents match \(values withheld\)/);
    assert.match(same.stdout, /= env file \.env\.local contents match \(values withheld\)/);
    assert.doesNotMatch(same.stdout, /charlie-private-marker/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('compare against live config reports changed private bytes without revealing values', async () => {
  const root = tempProject();
  try {
    const { cli } = await setupConfigProject(root, 'DATABASE_PASSWORD=old-live-marker\n');
    assert.equal((await cli(['snapshot', 'config-live'])).status, 0);
    fs.writeFileSync(path.join(root, '.env'), 'DATABASE_PASSWORD=new-live-marker\n');
    const compared = await cli(['compare', 'config-live']);
    assert.equal(compared.status, 0, `${compared.stdout}\n${compared.stderr}`);
    assert.match(compared.stdout, /~ env file \.env contents changed \(values withheld\)/);
    assert.doesNotMatch(compared.stdout, /old-live-marker|new-live-marker/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('compare marks corrupted private config evidence as unknown', async () => {
  const root = tempProject();
  try {
    const { cli } = await setupConfigProject(root, 'API_TOKEN=integrity-marker\n');
    assert.equal((await cli(['snapshot', 'config-integrity'])).status, 0);
    const checked = await Store.validateSnapshot(root, 'config-integrity', { mode: 'diagnostic' });
    const artifact = checked.artifacts.find((item) => item.layer === 'config' && item.target === '.env');
    assert.ok(artifact?.absolutePath, 'snapshot must contain the real private config artifact');
    fs.writeFileSync(artifact.absolutePath, 'API_TOKEN=changed-without-manifest-update\n');

    const result = await cli(['compare', 'config-integrity', 'config-integrity']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /artifact size\/hash mismatch/);
    assert.doesNotMatch(result.stdout, /No differences found|contents match/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /integrity-marker|changed-without-manifest-update/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('compare observation reuses private artifact bytes and derived digest only within one invocation', async () => {
  const file = path.join(os.tmpdir(), `project-state-observation-${process.pid}-${Date.now()}.json`);
  const bytes = Buffer.from('{"dependencies":{"private-package":"1.x"}}\n');
  fs.writeFileSync(file, bytes);
  const artifact = { absolutePath: file };
  const original = fs.promises.readFile;
  let reads = 0;
  fs.promises.readFile = async function countedRead(...args) {
    if (path.resolve(String(args[0])) === path.resolve(file)) reads += 1;
    return original.apply(this, args);
  };
  try {
    const first = Compare.createObservation();
    const [one, two, parsedOne, parsedTwo, digestOne, digestTwo] = await Promise.all([
      Compare.artifactBytes(artifact, first), Compare.artifactBytes(artifact, first),
      Compare.artifactJson(artifact, first), Compare.artifactJson(artifact, first),
      Compare.artifactDigest(artifact, first), Compare.artifactDigest(artifact, first),
    ]);
    assert.equal(reads, 1, 'all reads and derived values share one byte observation');
    assert.equal(one, two);
    assert.equal(parsedOne, parsedTwo);
    assert.equal(digestOne, digestTwo);
    const nextInvocation = Compare.createObservation();
    await Compare.artifactBytes(artifact, nextInvocation);
    assert.equal(reads, 2, 'a new comparison does not reuse the prior invocation cache');
  } finally {
    fs.promises.readFile = original;
    fs.rmSync(file, { force: true });
  }
});
