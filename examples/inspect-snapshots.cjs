'use strict';

// Minimal consumer example. It reads an explicit snapshot name and never
// chooses a snapshot automatically or invokes restore.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const INSPECTION_RESULT_SCHEMA = 2;
const INVENTORY_STATES = new Set(['missing', 'empty', 'available', 'incomplete', 'unreadable']);
const SNAPSHOT_STATES = new Set(['verified', 'diagnostic-only', 'incomplete', 'invalid', 'unknown', 'missing']);

function parseResult(text, command) {
  const result = JSON.parse(text);
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      result.resultSchemaVersion !== INSPECTION_RESULT_SCHEMA || result.command !== command) {
    throw new Error('unsupported inspection result schema or command');
  }
  if (command === 'list') {
    const inventory = result.inventory;
    if (!inventory || !INVENTORY_STATES.has(inventory.state) ||
        !Number.isSafeInteger(inventory.snapshotCount) || inventory.snapshotCount < 0 ||
        !Number.isSafeInteger(inventory.diagnosticCount) || inventory.diagnosticCount < 0 ||
        !Number.isSafeInteger(inventory.unrecognizedEntryCount) || inventory.unrecognizedEntryCount < 0 ||
        !Array.isArray(result.snapshots) || !Array.isArray(result.diagnostics) ||
        ['incomplete', 'unreadable'].includes(inventory.state)) {
      throw new Error('inspection inventory result is incomplete or unknown');
    }
  } else if (command === 'show') {
    if (!result.snapshot || !SNAPSHOT_STATES.has(result.snapshot.state) ||
        typeof result.snapshot.name !== 'string') {
      throw new Error('inspection detail result is incomplete or unknown');
    }
  } else {
    throw new Error('unsupported inspection command');
  }
  return result;
}

function query(cli, args, command, cwd) {
  const stdout = execFileSync(process.execPath, [cli, ...args, '--json'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  return parseResult(stdout, command);
}

function main(snapshotName) {
  if (!snapshotName || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(snapshotName)) {
    console.error('Usage: node examples/inspect-snapshots.cjs <snapshot-name>');
    return 1;
  }

  const cli = path.resolve(__dirname, '..', 'bin', 'project-state.js');
  try {
    const inventory = query(cli, ['list'], 'list', process.cwd());
    console.log(`Inventory: ${inventory.inventory.state}; ${inventory.inventory.snapshotCount} candidate(s).`);
    const detail = query(cli, ['show', snapshotName], 'show', process.cwd()).snapshot;
    console.log(`Snapshot ${detail.name}: ${detail.state}; generation=${detail.generation || '(unverified)'}.`);
    if (detail.state !== 'verified') {
      console.error(`Do not rely on this snapshot yet (${detail.reasonCode || detail.state}).`);
      return 2;
    }
    console.log(`Restore prerequisites: ${detail.environment?.restorePrerequisites || 'not-checked'}; application health: ${detail.environment?.applicationHealth || 'not-tested'}.`);
    return 0;
  } catch {
    // Do not echo child-process output, private paths, or raw exception details.
    console.error('Snapshot inspection failed; preserve project state and inspect it manually.');
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv[2]);

module.exports = { INSPECTION_RESULT_SCHEMA, parseResult, main };
