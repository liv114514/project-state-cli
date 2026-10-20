'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./helpers');

const npmManifest = (range) => JSON.stringify({
  name: 'product-loop-fixture', version: '1.0.0', dependencies: { sample: range },
}, null, 2) + '\n';
const npmLock = JSON.stringify({
  name: 'product-loop-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'product-loop-fixture', version: '1.0.0', dependencies: { sample: '^1.0.0' } },
    'node_modules/sample': { version: '1.2.0' },
  },
}, null, 2) + '\n';

test('compare reports dependency declaration drift even when lockfile bytes are unchanged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-product-deps-'));
  try {
    await H.setupGit(root, { 'package.json': npmManifest('^1.0.0'), 'package-lock.json': npmLock });
    const { cli } = H.bindRunner(root);
    fs.writeFileSync(path.join(root, 'app.js'), 'temporary working change();\n');
    const created = await cli(['snapshot', 'before-declaration-change']);
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    fs.writeFileSync(path.join(root, 'app.js'), 'x();\n');
    fs.writeFileSync(path.join(root, 'package.json'), npmManifest('^2.0.0'));
    assert.equal(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'), npmLock);
    const after = await cli(['snapshot', 'after-declaration-change']);
    assert.equal(after.status, 0, `${after.stdout}\n${after.stderr}`);

    const compared = await cli(['compare', 'before-declaration-change', 'after-declaration-change']);
    assert.equal(compared.status, 0, `${compared.stdout}\n${compared.stderr}`);
    assert.match(compared.stdout, /package\.json dependency declarations changed/);
    assert.match(compared.stdout, /package\.json and package-lock\.json declarations disagree in B/);
    assert.doesNotMatch(compared.stdout, /\^1\.0\.0|\^2\.0\.0/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('snapshot output records runtime pin names without printing pin contents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-product-runtime-'));
  const marker = 'PRIVATE-PIN-MARKER-24.7.1';
  try {
    await H.setupGit(root, { '.node-version': marker + '\n' });
    const { cli } = H.bindRunner(root);
    const created = await cli(['snapshot', 'runtime-pin']);
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    assert.match(created.stdout, /\.node-version \(recorded; value withheld\)/);
    assert.doesNotMatch(created.stdout, new RegExp(marker));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('list explains per-layer collected and restorable scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-product-list-'));
  try {
    await H.setupGit(root, { '.gitignore': '.env\n' });
    H.excludeLocalFiles(root, ['.env']);
    fs.writeFileSync(path.join(root, '.env'), 'DEMO_TOKEN=fake-only\n');
    const { cli } = H.bindRunner(root);
    const created = await cli(['snapshot', 'scope-view']);
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    const listed = await cli(['list']);
    assert.equal(listed.status, 0, `${listed.stdout}\n${listed.stderr}`);
    assert.match(listed.stdout, /Layer scope: .*config=collected \(1 restorable, 1 record-only, 1 private\)/);
    assert.match(listed.stdout, /database=skipped/);
    assert.doesNotMatch(listed.stdout, /fake-only/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('successful restore reports verified target names and manual validation boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-product-restore-'));
  try {
    await H.setupGit(root, { '.gitignore': '.env\n' });
    H.excludeLocalFiles(root, ['.env']);
    fs.writeFileSync(path.join(root, '.env'), 'DEMO_TOKEN=before\n');
    const { git, cli } = H.bindRunner(root);
    const created = await cli(['snapshot', 'before-runtime-change']);
    assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
    fs.writeFileSync(path.join(root, '.env'), 'DEMO_TOKEN=after\n');
    fs.writeFileSync(path.join(root, 'app.js'), 'changed();\n');
    await git(['add', 'app.js']);
    await git(['commit', '-m', 'runtime change']);
    const restored = await cli(['restore', 'before-runtime-change', '--yes']);
    assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
    assert.match(restored.stdout, /Verified artifact targets: \.env/);
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'DEMO_TOKEN=before\n');
    assert.match(restored.stdout, /Application health: not tested/i);
    assert.match(restored.stdout, /then run your normal validation/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
