'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const H = require('./helpers');
const Consumer = require('../examples/inspect-snapshots.cjs');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-inspection-'));
  t.after(() => H.removeTemporaryTree(root));
  return root;
}

const layerData = {
  config: { envFiles: { '.env': { keyCount: 1, keys: { PORT: { nonEmpty: true } } } } },
  runtime: { node: process.version, npm: null, python: null, versionPins: [] },
};

function createSnapshot(root, name, options = {}) {
  return H.writeSnapshotGeneration(root, name, {
    createdAt: options.createdAt || '2026-10-24T01:02:03.000Z',
    kind: options.kind,
    layerData,
    privateFiles: options.privateFiles || [{ id: 'config:env', layer: 'config', path: 'config/env.bin', target: '.env', content: 'SYNTHETIC_PRIVATE_VALUE=never-print' }],
  });
}

function parse(result) {
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('list JSON distinguishes absent inventory from an empty inventory', async (t) => {
  const root = project(t);
  let result = await H.cli(root, ['list', '--json']);
  assert.equal(result.status, 0);
  let body = parse(result);
  assert.equal(body.inventory.state, 'missing');
  assert.equal(body.inventory.snapshotCount, 0);
  fs.mkdirSync(path.join(root, '.project-state', 'snapshots'), { recursive: true });
  result = await H.cli(root, ['list', '--json']);
  assert.equal(result.status, 0);
  body = parse(result);
  assert.equal(body.inventory.state, 'empty');
  assert.equal(body.snapshots.length, 0);
});

test('list JSON reports valid metadata and inventory order from the shared model', async (t) => {
  const root = project(t);
  const first = createSnapshot(root, 'before-change');
  const second = createSnapshot(root, 'after-change', { createdAt: '2026-10-24T02:02:03.000Z' });
  const result = await H.cli(root, ['list', '--json']);
  assert.equal(result.status, 0);
  const body = parse(result);
  assert.equal(body.resultSchemaVersion, 2);
  assert.equal(body.inventory.state, 'available', JSON.stringify(body, null, 2));
  assert.deepEqual(body.snapshots.map((item) => item.name), ['after-change', 'before-change']);
  assert.equal(body.snapshots[0].generation, second.generation);
  assert.equal(body.snapshots[1].generation, first.generation);
  assert.equal(body.snapshots[1].state, 'verified');
  assert.equal(body.snapshots[1].environment.restorePrerequisites, 'not-checked');
  assert.equal(body.snapshots[1].environment.applicationHealth, 'not-tested');
});

test('show JSON reveals exact snapshot metadata and classes but not private bytes or hashes', async (t) => {
  const root = project(t);
  const made = createSnapshot(root, 'before-change');
  const currentBefore = fs.readFileSync(path.join(root, '.project-state', 'snapshots', 'before-change', 'current.json'));
  const result = await H.cli(root, ['show', 'before-change', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const body = parse(result);
  assert.equal(body.command, 'show');
  assert.equal(body.resultSchemaVersion, 2);
  assert.equal(body.snapshot.generation, made.generation);
  assert.equal(body.snapshot.schemaVersion, 2);
  assert.equal(body.snapshot.createdAt, '2026-10-24T01:02:03.000Z');
  assert.equal(body.snapshot.state, 'verified');
  assert.ok(body.snapshot.layers.some((layer) => layer.id === 'config' && layer.status === 'collected'));
  assert.equal(body.snapshot.layers.find((layer) => layer.id === 'config').privateArtifactCount, 1);
  assert.ok(body.snapshot.artifacts.some((artifact) => artifact.target === '.env' && artifact.restoreClass === 'supported' && artifact.integrity === 'verified' && artifact.privacy === 'private'));
  assert.equal(body.snapshot.environment.applicationHealth, 'not-tested');
  assert.deepEqual(body.snapshot.nextStep.args, ['before-change', '--dry-run']);
  assert.equal(body.snapshot.nextStep.args.includes('--yes'), false);
  assert.equal(result.stdout.includes('SYNTHETIC_PRIVATE_VALUE'), false);
  assert.equal(result.stdout.includes('never-print'), false);
  assert.equal(result.stdout.includes(crypto.createHash('sha256').update('SYNTHETIC_PRIVATE_VALUE=never-print').digest('hex')), false);
  assert.ok(body.snapshot.artifacts.every((artifact) => !Object.hasOwn(artifact, 'path') && !Object.hasOwn(artifact, 'sha256')));
  assert.deepEqual(fs.readFileSync(path.join(root, '.project-state', 'snapshots', 'before-change', 'current.json')), currentBefore);
  assert.equal(fs.existsSync(path.join(root, '.project-state', 'locks', 'operation.lock')), false);
});

test('show text and JSON render the same validated snapshot identity and layer status', async (t) => {
  const root = project(t);
  const made = createSnapshot(root, 'text-json-parity');
  const textResult = await H.cli(root, ['show', 'text-json-parity']);
  const jsonResult = await H.cli(root, ['show', 'text-json-parity', '--json']);
  assert.equal(textResult.status, 0, textResult.stderr);
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const detail = parse(jsonResult).snapshot;
  assert.ok(textResult.stdout.includes(detail.name));
  assert.ok(textResult.stdout.includes(made.generation));
  for (const layer of detail.layers) assert.ok(textResult.stdout.includes(`Layer ${layer.id}: ${layer.status}`));
  assert.match(textResult.stdout, /config: collected; .*1 private/);
  assert.equal(textResult.stdout.includes('SYNTHETIC_PRIVATE_VALUE'), false);
});

test('sample consumer rejects unknown schemas, malformed JSON, commands, and states', () => {
  const list = {
    resultSchemaVersion: 2, command: 'list',
    inventory: { state: 'available', snapshotCount: 1, diagnosticCount: 0, unrecognizedEntryCount: 0 },
    snapshots: [], diagnostics: [],
  };
  const show = { resultSchemaVersion: 2, command: 'show', snapshot: { name: 'before', state: 'verified' } };
  assert.equal(Consumer.parseResult(JSON.stringify(list), 'list').inventory.state, 'available');
  assert.equal(Consumer.parseResult(JSON.stringify(show), 'show').snapshot.state, 'verified');
  assert.throws(() => Consumer.parseResult(JSON.stringify({ ...list, resultSchemaVersion: 1 }), 'list'), /unsupported inspection result schema/);
  assert.throws(() => Consumer.parseResult(JSON.stringify({ ...list, command: 'show' }), 'list'), /unsupported inspection result schema/);
  assert.throws(() => Consumer.parseResult(JSON.stringify({ ...list, inventory: { ...list.inventory, state: 'incomplete' } }), 'list'), /incomplete or unknown/);
  assert.throws(() => Consumer.parseResult('{bad json', 'list'), SyntaxError);
  assert.throws(() => Consumer.parseResult(JSON.stringify({ ...list, inventory: { ...list.inventory, state: 'maybe' } }), 'list'), /incomplete or unknown/);
  assert.throws(() => Consumer.parseResult(JSON.stringify({ ...show, snapshot: { name: 'before', state: 'almost-verified' } }), 'show'), /incomplete or unknown/);
});

test('show missing name is distinct and has no state-creation side effect', async (t) => {
  const root = project(t);
  const result = await H.cli(root, ['show', 'not-here', '--json']);
  assert.equal(result.status, 1);
  const body = parse(result);
  assert.deepEqual(body.snapshot, {
    name: 'not-here', state: 'missing', reasonCode: 'SNAPSHOT_NOT_FOUND',
    checks: [{ id: 'snapshot.presence', state: 'issue', required: true, reasonCode: 'SNAPSHOT_NOT_FOUND' }],
  });
  assert.equal(fs.existsSync(path.join(root, '.project-state')), false);
});

test('show v1 metadata is diagnostic-only and does not expose unknown legacy values', async (t) => {
  const root = project(t);
  const dir = path.join(root, '.project-state', 'snapshots', 'legacy-one');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, name: 'legacy-one', layers: { secretLayerName: { value: 'LEGACY_SECRET_VALUE' } } }));
  const result = await H.cli(root, ['show', 'legacy-one', '--json']);
  assert.equal(result.status, 0);
  const body = parse(result);
  assert.equal(body.snapshot.state, 'diagnostic-only');
  assert.equal(body.snapshot.integrity.state, 'not-checked');
  assert.equal(result.stdout.includes('LEGACY_SECRET_VALUE'), false);
  assert.equal(result.stdout.includes('secretLayerName'), false);
});

test('list JSON includes damaged candidate diagnostics and never calls inventory complete', async (t) => {
  const root = project(t);
  const folder = path.join(root, '.project-state', 'snapshots', 'broken');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'manifest.json'), '{ bad json');
  const result = await H.cli(root, ['list', '--json']);
  assert.equal(result.status, 0);
  const body = parse(result);
  assert.equal(body.inventory.state, 'incomplete');
  assert.equal(body.snapshots.length, 1);
  assert.equal(body.snapshots[0].state, 'invalid');
  assert.equal(body.snapshots[0].reasonCode, 'SNAPSHOT_METADATA_INVALID');
  assert.ok(body.diagnostics.length > 0);
  assert.equal(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'), '{ bad json');
});

test('show unknown schema stays unknown, without exposing raw manifest or path', async (t) => {
  const root = project(t);
  const made = createSnapshot(root, 'future-format');
  const publicManifest = path.join(root, '.project-state', 'snapshots', 'future-format', 'generations', made.generation, 'manifest.json');
  const privateManifest = path.join(root, '.project-state', 'secrets', 'future-format', 'generations', made.generation, 'manifest.json');
  const publicData = JSON.parse(fs.readFileSync(publicManifest, 'utf8'));
  const privateData = JSON.parse(fs.readFileSync(privateManifest, 'utf8'));
  publicData.schemaVersion = 99;
  privateData.schemaVersion = 99;
  const publicBytes = Buffer.from(JSON.stringify(publicData));
  fs.writeFileSync(publicManifest, publicBytes);
  fs.writeFileSync(privateManifest, JSON.stringify(privateData));
  const pointerPath = path.join(root, '.project-state', 'snapshots', 'future-format', 'current.json');
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  pointer.publicManifestSha256 = crypto.createHash('sha256').update(publicBytes).digest('hex');
  fs.writeFileSync(pointerPath, JSON.stringify(pointer));
  const result = await H.cli(root, ['show', 'future-format', '--json']);
  assert.equal(result.status, 2);
  const body = parse(result);
  assert.equal(body.snapshot.state, 'unknown');
  assert.equal(body.snapshot.reasonCode, 'SNAPSHOT_SCHEMA_UNSUPPORTED');
  assert.equal(result.stdout.includes(root), false);
  assert.equal(result.stdout.includes('SYNTHETIC_PRIVATE_VALUE'), false);
});

test('show missing required bytes reports incomplete integrity and preserves the snapshot', async (t) => {
  const root = project(t);
  const made = createSnapshot(root, 'missing-private-bytes');
  const target = path.join(root, '.project-state', 'secrets', 'missing-private-bytes', 'generations', made.generation, 'files', 'config', 'env.bin');
  fs.unlinkSync(target);
  const result = await H.cli(root, ['show', 'missing-private-bytes', '--json']);
  assert.equal(result.status, 2);
  const body = parse(result);
  assert.equal(body.snapshot.state, 'incomplete');
  assert.equal(body.snapshot.integrity.state, 'incomplete');
  assert.equal(body.snapshot.integrity.missingArtifacts, null);
  assert.equal(fs.existsSync(path.join(root, '.project-state', 'snapshots', 'missing-private-bytes', 'current.json')), true);
  assert.equal(fs.existsSync(path.join(root, '.project-state', 'secrets', 'missing-private-bytes')), true);
});

test('list JSON counts unrecognized entries instead of silently asserting completeness', async (t) => {
  const root = project(t);
  const base = path.join(root, '.project-state', 'snapshots');
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(path.join(base, 'unreviewed name with private context'), { recursive: true });
  const result = await H.cli(root, ['list', '--json']);
  assert.equal(result.status, 0);
  const body = parse(result);
  assert.equal(body.inventory.state, 'incomplete');
  assert.equal(body.inventory.unrecognizedEntryCount, 1);
  assert.equal(body.snapshots.length, 0);
  assert.equal(result.stdout.includes('unreviewed name with private context'), false);
});

test('list JSON reports unreadable inventory and does not mutate it', async (t) => {
  const root = project(t);
  const base = path.join(root, '.project-state', 'snapshots');
  fs.mkdirSync(base, { recursive: true });
  const original = fs.promises.readdir;
  fs.promises.readdir = async function (target, ...args) {
    if (path.resolve(String(target)) === path.resolve(base)) {
      const error = new Error('synthetic access failure with private path');
      error.code = 'EACCES';
      throw error;
    }
    return original.call(this, target, ...args);
  };
  const originalLog = console.log;
  let output = '';
  console.log = (text) => { output += `${text}\n`; };
  try { assert.equal(await require('../lib/list').listCmd(root, { json: true }), 2); }
  finally { fs.promises.readdir = original; console.log = originalLog; }
  const body = JSON.parse(output);
  assert.equal(body.inventory.state, 'unreadable');
  assert.equal(body.inventory.reasonCode, 'SNAPSHOT_ACCESS_DENIED');
  assert.equal(body.inventory.systemCode, 'EACCES');
  assert.equal(output.includes('synthetic access failure'), false);
  assert.deepEqual(fs.readdirSync(path.join(root, '.project-state')), ['snapshots']);
});

test('CLI rejects duplicate JSON and invalid show name without project writes', async (t) => {
  const root = project(t);
  const duplicate = await H.cli(root, ['list', '--json', '--json']);
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.stdout, '');
  const invalid = await H.cli(root, ['show', '..', '--json']);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.equal(fs.existsSync(path.join(root, '.project-state')), false);
});
