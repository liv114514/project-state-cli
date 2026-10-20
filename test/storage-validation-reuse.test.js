'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers');
const Store = require('../lib/storage');
const { snapshotInternal } = require('../lib/snapshot');

test('generation validation parses each integrity-checked layer JSON from its same-read bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-validate-reuse-'));
  try {
    await H.setupGit(root, { 'app.js': 'module.exports = true;\n' });
    const saved = await snapshotInternal(root, 'read-once');
    const before = await Store.validateSnapshot(root, 'read-once', { mode: 'restore' });
    const layers = before.artifacts.filter((artifact) => artifact.kind === 'layer-json');
    assert.ok(layers.length > 0, 'fixture has collected JSON layers');
    const targets = new Set(layers.map((artifact) => path.resolve(artifact.absolutePath)));
    const reads = new Map([...targets].map((target) => [target, 0]));
    const original = fs.promises.readFile;
    fs.promises.readFile = async function countedRead(...args) {
      const target = path.resolve(String(args[0]));
      if (reads.has(target)) reads.set(target, reads.get(target) + 1);
      return original.apply(this, args);
    };
    let checked;
    try { checked = await Store.validateSnapshot(root, 'read-once', { mode: 'restore' }); }
    finally { fs.promises.readFile = original; }
    assert.ok([...reads.values()].every((count) => count === 1), `each layer artifact is read exactly once during one generation validation (counts: ${[...reads.values()]})`);
    for (const layer of Object.keys(checked.layers)) assert.ok(checked.layers[layer] && typeof checked.layers[layer] === 'object');
    assert.equal(checked.generation, saved.generation);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
