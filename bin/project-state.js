#!/usr/bin/env node
'use strict';
// project-state CLI entry point.
// Git manages code; project-state manages the runnable state around it.

const { snapshotCmd, snapshotInternal } = require('../lib/snapshot');
const { compareCmd } = require('../lib/compare');
const { restoreCmd } = require('../lib/restore');
const { listCmd } = require('../lib/list');
const { pruneCmd } = require('../lib/prune');
const { doctorCmd } = require('../lib/doctor');
const { hookCmd, runHookSnapshot, runHookWorker } = require('../lib/hook');
const U = require('../lib/utils');

const VERSION = U.TOOL_VERSION;

const HELP = `project-state - Record local state and restore a supported subset.

Usage:
  project-state snapshot <name> [--overwrite] [--with-seed]
      Record current state; collection does not verify that the application works.
      SQLite backups require --with-seed and are private; SQL is never executed.

  project-state compare <nameA> [<nameB>]
      Print layer-by-layer differences between two snapshots.
      With one argument: compare that snapshot against the CURRENT live state
      (no persistent snapshot is created). SQLite row contents are not compared.

  project-state list
      List diagnostic status and verified artifacts; this does not claim health.

  project-state doctor
      Read-only diagnosis: tool availability, dependency sync, .env drift,
      git health. Three-state verdicts (ok / issue / unknown). Exit 1 when
      issues were found.

  project-state hook install | hook uninstall
      Attempt a best-effort snapshot before each commit. A foreign pre-commit
      runs first; its failure still blocks the commit. Tool failures do not.

  project-state prune [--yes] [--keep N]
      Retire old validated auto/hook generations. Default is a dry run; --yes
      performs it. Named, invalid-time, pinned, and unresolved generations stay.
      --keep N (default 10) retains the newest eligible auto/hook generations.

  project-state restore <name> [--dry-run] [--yes] [--force] [--only config,deps,runtime]
      Restore the supported project state from snapshot <name>.
      --only     restore a unique subset of config, deps, and runtime files;
                 does not switch Git or restore databases/Docker state, and
                 does not accept target paths. deps is indivisible and the
                 restore layer rejects non-package-lock or inconsistent pairs.
      --dry-run  preview the current plan; it does not reserve a snapshot generation
                 or change business targets, but may create/release lock/pin metadata.
      --yes      explicitly authorize and apply the current validated plan without
                 prompting (there is no interactive confirmation); required for
                 every restore write. Re-run --dry-run
                 after any project or snapshot change.
      --force    cannot bypass dirty/uncertain Git state or missing protection
      --rollback-of <operationId> request a verified, narrowly scoped rollback
      --only cannot be combined with --rollback-of.

  project-state recover <operationId> --inspect
      Inspect an interrupted restore or snapshot journal without changing it.
  project-state recover <operationId> --compensate --yes
      Resolve a verified stale local restore or snapshot transaction.
  project-state recover <operationId> --cleanup --yes
      Retry exact, journaled cleanup after an already verified restore.
  project-state recover <operationId> --continue --yes
      Continue a proven interrupted prune transaction under its original plan.
      Ambiguous state, active/foreign locks, and unsupported recovery are refused.

  project-state help | --help | --version

Exit codes: 0 success | 1 expected error (refused / not found / aborted) | 2 environment error.

Snapshot generations live under .project-state/snapshots/ and private artifacts
under .project-state/secrets/. Secrets are local plaintext, not encrypted.
SQLite restore creates a missing target only; existing databases and sidecars
are refused. Restore does not establish application health.
`;

function usage(line) {
  console.error(`Usage: project-state ${line}`);
  console.error('Run "project-state help" for details.');
}

function badFlag(flag) {
  U.printError(`Unknown option "${flag}".`, 'This option is not supported by the selected command.', 'Run "project-state help" to see valid options.');
}

// Split argv into positional args and --flags, rejecting unknown flags.
// Flags are stored camelCase WITHOUT dashes (--dry-run -> flags.dryRun).
// Flags listed in valueFlags consume the next argument as their value.
function parseArgs(rest, allowedFlags, valueFlags = []) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      if (!allowedFlags.includes(a)) return { bad: a };
      const camel = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (valueFlags.includes(a)) {
        const next = rest[i + 1];
        if (next === undefined || next.startsWith('--')) return { flags, pos, badValue: a };
        flags[camel] = next;
        i++;
      } else {
        flags[camel] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return 0;
  }

  const root = process.cwd();

  if (cmd === 'recover') {
    const p = parseArgs(rest, ['--inspect', '--compensate', '--cleanup', '--continue', '--yes']);
    if (p.bad) { badFlag(p.bad); return 1; }
    const modes = Number(!!p.flags.inspect) + Number(!!p.flags.compensate) + Number(!!p.flags.cleanup) + Number(!!p.flags.continue);
    if (p.pos.length !== 1 || modes !== 1 || (p.flags.yes && !p.flags.compensate && !p.flags.cleanup && !p.flags.continue) || ((p.flags.compensate || p.flags.cleanup || p.flags.continue) && !p.flags.yes)) {
      usage('recover <operationId> --inspect | recover <operationId> --compensate --yes | recover <operationId> --cleanup --yes | recover <operationId> --continue --yes');
      return 1;
    }
    let operationType = null;
    try {
      const Store = require('../lib/storage');
      let journal;
      try { journal = await Store.readJournal(root, Store.operationJournalPath(root, p.pos[0])); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // The only supported journal-less prune state is a single complete,
        // owner-bound temp intent. inspectInterruptedPrune performs that proof.
        const pendingPrune = await Store.inspectInterruptedPrune(root, p.pos[0]);
        journal = pendingPrune.journal;
      }
      operationType = journal.operation;
      if (journal.operation === 'prune') {
        const txn = journal.pruneTransaction;
        if (!txn || journal.status !== 'in-progress' && journal.status !== 'completed') throw new Error('prune journal is not in a supported recoverable state; preserve it and all snapshot generations');
        if (journal.status === 'completed' && journal.terminalOutcome === 'verified-complete') {
          const terminal = await Store.verifyCompletedPruneTransaction(root, p.pos[0], { cleanupStaleLock: !p.flags.inspect });
          console.log(p.flags.inspect
            ? `Prune operation ${p.pos[0]} terminal result verified; inspection made no changes.`
            : `Prune operation ${p.pos[0]} is already committed and verified; no additional retirement was performed.`);
          return 0;
        }
        const inspected = await Store.inspectInterruptedPrune(root, p.pos[0]);
        const inspectedTxn = inspected.journal.pruneTransaction;
        if (p.flags.inspect) {
          console.log(`Prune operation ${p.pos[0]}: ${inspected.action}; process ${inspected.alive ? 'active' : 'not running'}.`);
          console.log(`Plan: ${inspectedTxn.planned.length} exact name+generation target(s); completed: ${inspectedTxn.completed.length}.`);
          for (const row of inspectedTxn.planned) console.log(`  ${row.name} generation=${row.generation} kind=${row.kind} phase=${row.phase}`);
          console.log('Inspection is read-only. After the original process stops, use --continue --yes to finish the recorded plan. Already retired generations are not rolled back.');
          return 0;
        }
        if (!p.flags.continue) throw new Error('prune recovery supports only --inspect or --continue --yes');
        if (inspected.alive) throw new Error(`prune process ${inspected.owner.pid} is still active`);
        const claimed = await Store.claimInterruptedPrune(root, p.pos[0]);
        let completed = false;
        try {
          if (claimed.journal.status === 'completed' && claimed.journal.terminalOutcome === 'verified-complete') {
            completed = true;
            await claimed.lock.release();
            console.log(`Prune operation ${p.pos[0]} terminal journal reconciled; business result was already committed and verified.`);
            return 0;
          }
          const outcome = await Store.continuePruneTransaction(root, claimed.lock);
          completed = true;
          console.log(`Prune operation ${p.pos[0]} continued and verified: ${outcome.retired} planned generation(s) retired.`);
          console.log('Prune does not change project files, Git HEAD, index, or refs. Already committed retirement is not reversible.');
          return 0;
        } finally { if (completed) await claimed.lock.release(); }
      }
      if (p.flags.continue) throw new Error('--continue is supported only for an owner-bound interrupted prune transaction');
      if (p.flags.cleanup) {
        if (journal.operation !== 'restore' || journal.status !== 'completed' || journal.terminalOutcome !== 'verified-complete') {
          throw new Error('cleanup retry requires a completed restore with terminalOutcome=verified-complete');
        }
        const pending = journal.cleanupPending || [];
        if (!pending.length) {
          const terminalCleanup = await Store.finalizeCompletedRestoreCleanup(root, p.pos[0]);
          if (terminalCleanup.closed) {
            console.log(`Restore operation ${p.pos[0]} cleanup lock closed after verifying its terminal journal and resolver provenance.`);
            return 0;
          }
          console.log(`Restore operation ${p.pos[0]} has no pending cleanup; no changes made.`);
          return 0;
        }
        const claimedCleanup = await Store.claimInterruptedRestore(root, p.pos[0], { cleanup: true });
        const lock = claimedCleanup.lock;
        try {
          const cleanupJournal = claimedCleanup.journal;
          if (cleanupJournal.status !== 'completed' || cleanupJournal.terminalOutcome !== 'verified-complete') throw new Error('cleanup journal changed during stale-lock claim; preserve the journal and pins for inspection');
          let remaining = [...(cleanupJournal.cleanupPending || [])];
          for (const action of [...remaining]) {
            try {
              await Store.completeCleanupAction(root, { lock, operationId: p.pos[0], action });
              remaining = remaining.filter((item) => JSON.stringify(item) !== JSON.stringify(action));
              await Store.writeOperationJournal(root, lock, {
                operationId: p.pos[0], operation: 'restore', phase: cleanupJournal.phase,
                status: cleanupJournal.status, terminalOutcome: cleanupJournal.terminalOutcome,
                ...(cleanupJournal.resolvesOperationId ? { resolvesOperationId: cleanupJournal.resolvesOperationId } : {}),
                cleanupPending: remaining,
              });
            } catch (error) {
              const i = remaining.findIndex((item) => item.kind === action.kind && item.pinId === action.pinId && item.path === action.path);
              if (i >= 0) remaining[i] = { ...action, reason: /^[A-Za-z0-9_-]{1,64}$/.test(error.code || '') ? error.code : 'cleanup-failed' };
              else remaining.push({ ...action, reason: /^[A-Za-z0-9_-]{1,64}$/.test(error.code || '') ? error.code : 'cleanup-journal-failed' });
              try {
                await Store.writeOperationJournal(root, lock, {
                  operationId: p.pos[0], operation: 'restore', phase: cleanupJournal.phase,
                  status: cleanupJournal.status, terminalOutcome: cleanupJournal.terminalOutcome,
                  ...(cleanupJournal.resolvesOperationId ? { resolvesOperationId: cleanupJournal.resolvesOperationId } : {}),
                  cleanupPending: remaining,
                });
              } catch { /* the previously durable action remains safely retryable */ }
            }
          }
          if (remaining.length) {
            const kinds = [...new Set(remaining.map((item) => item.kind))].join(', ');
            throw new Error(`cleanup remains pending (${kinds}); retained pins and journal require manual resolution`);
          }
          console.log(`Restore operation ${p.pos[0]} cleanup completed. Verified project data was not changed.`);
          return 0;
        } finally { await lock.release(); }
      }
      if (journal.operation === 'snapshot') {
        const inspected = await Store.inspectInterruptedSnapshot(root, p.pos[0]);
        if (p.flags.inspect) {
          console.log(`Snapshot operation ${p.pos[0]}: ${inspected.transaction.phase}; process ${inspected.alive ? 'active' : 'not running'}.`);
          console.log(`Target: ${inspected.transaction.name} generation ${inspected.transaction.generation}; current generation: ${inspected.currentGeneration || 'none'}; resolution: ${inspected.action}.`);
          console.log('Inspection is read-only. Use --compensate --yes only after the original process has stopped.');
          return 0;
        }
        const claimed = await Store.claimInterruptedSnapshot(root, p.pos[0]);
        let resolved = false;
        try {
          const outcomes = await Store.recoverSnapshotTransactions(root, claimed.lock, p.pos[0]);
          if (outcomes.length !== 1 || outcomes[0].operationId !== p.pos[0]) {
            throw new Error('snapshot transaction did not produce one verified resolution; journal and generations are retained');
          }
          resolved = true;
          const outcome = outcomes[0];
          console.log(`Snapshot operation ${p.pos[0]} resolved: ${outcome.action}; generation ${outcome.generation || 'none'}.`);
          console.log('No snapshot generation or staging data was deleted.');
          return 0;
        } finally {
          // On ambiguity, leave the authenticated lock and journal as a durable
          // manual-resolution boundary; release only a verified resolution.
          if (resolved) await claimed.lock.release();
        }
      }
      if (journal.operation !== 'restore') throw new Error(`operation type "${journal.operation}" is not supported by recover`);
      const inspected = await Store.inspectInterruptedRestore(root, p.pos[0]);
      if (p.flags.inspect) {
        console.log(`Restore operation ${p.pos[0]}: ${inspected.journal.phase}, ${inspected.journal.status}; process ${inspected.alive ? 'active' : 'not running'}.`);
        console.log(`Safety point: ${inspected.safety.name} generation ${inspected.safety.generation}; pin ${inspected.safety.pinId} is retained.`);
        console.log(`Durable applied targets: ${(inspected.journal.appliedTargets || []).length}; pending target: ${inspected.journal.pendingTarget?.target || 'none'}.`);
        console.log(`Private staging: ${inspected.journal.pendingTemp ? `${inspected.journal.pendingTemp.path} (${inspected.journal.pendingTemp.phase})` : 'none'}.`);
        console.log('Inspection is read-only. Use --compensate --yes only after the original process has stopped.');
        return 0;
      }
      const claimed = await require('../lib/storage').claimInterruptedRestore(root, p.pos[0]);
      return restoreCmd(root, claimed.safety.name, { yes: true, rollbackOf: p.pos[0], lock: claimed.lock });
    } catch (error) {
      const next = operationType === 'snapshot'
        ? 'Keep the operation lock, journal, snapshot generations and staging data; inspect the pointer and generation evidence manually before making changes.'
        : operationType === 'restore'
          ? 'Keep the operation journal, safety snapshot and pin; inspect the target state manually before making changes.'
          : 'Keep any operation lock, journal and referenced safety/snapshot data; inspect the state manually before making changes.';
      U.printError(`Cannot recover operation ${p.pos[0]}.`, error.message, next);
      return 1;
    }
  }

  // Hook entry points are hidden implementation paths. They can only create
  // uniquely named hook snapshots; all failure is reported as best effort.
  if (cmd === '__hook-snapshot' || cmd === '__hook-snapshot-worker') {
    const p = parseArgs(rest, []);
    if (p.bad) { badFlag(p.bad); return 1; }
    if (p.pos.length !== 1 || !U.HOOK_RE.test(p.pos[0])) return 1;
    if (cmd === '__hook-snapshot') return runHookSnapshot(root, p.pos[0], __filename);
    return runHookWorker(root, p.pos[0], snapshotInternal);
  }

  if (cmd === 'snapshot') {
    const p = parseArgs(rest, ['--overwrite', '--with-seed'], []);
    if (p.bad) {
      badFlag(p.bad);
      return 1;
    }
    if (p.pos.length !== 1) {
      usage('snapshot <name> [--overwrite] [--with-seed]');
      return 1;
    }
    return snapshotCmd(root, p.pos[0], p.flags);
  }

  if (cmd === 'doctor') {
    const p = parseArgs(rest, []);
    if (p.bad) {
      badFlag(p.bad);
      return 1;
    }
    if (p.pos.length !== 0) {
      usage('doctor');
      return 1;
    }
    return doctorCmd(root);
  }

  if (cmd === 'hook') {
    const p = parseArgs(rest, []);
    if (p.bad) {
      badFlag(p.bad);
      return 1;
    }
    if (p.pos.length !== 1) {
      usage('hook install | hook uninstall');
      return 1;
    }
    return hookCmd(root, p.pos[0]);
  }

  if (cmd === 'compare') {
    const p = parseArgs(rest, []);
    if (p.bad) {
      badFlag(p.bad);
      return 1;
    }
    if (p.pos.length < 1 || p.pos.length > 2) {
      usage('compare <nameA> [<nameB>]');
      return 1;
    }
    return compareCmd(root, p.pos[0], p.pos[1]);
  }

  if (cmd === 'list') {
    const p = parseArgs(rest, []);
    if (p.bad) {
      badFlag(p.bad);
      return 1;
    }
    if (p.pos.length !== 0) {
      usage('list');
      return 1;
    }
    return listCmd(root);
  }

  if (cmd === 'prune') {
    const p = parseArgs(rest, ['--yes', '--keep'], ['--keep']);
    if (p.bad) {
      badFlag(p.bad);
      return 1;
    }
    if (p.badValue) {
      U.printError(
        `Option ${p.badValue} needs a value.`,
        'It expects a whole number (how many newest auto snapshots to keep).',
        'Example: project-state prune --keep 5'
      );
      return 1;
    }
    if (p.pos.length !== 0) {
      usage('prune [--yes] [--keep N]');
      return 1;
    }
    return pruneCmd(root, p.flags);
  }

  if (cmd === 'restore') {
    if (rest.filter((arg) => arg === '--only').length > 1) {
      U.printError('Option --only may be specified only once.', 'Choose one comma-separated subset of config, deps, and runtime.', 'Example: project-state restore before-change --only config,runtime');
      return 1;
    }
    const p = parseArgs(rest, ['--dry-run', '--yes', '--force', '--rollback-of', '--only'], ['--rollback-of', '--only']);
    if (p.bad) {
      badFlag(p.bad);
      return 1;
    }
    if (p.pos.length !== 1) {
      usage('restore <name> [--dry-run] [--yes] [--force] [--only config,deps,runtime] [--rollback-of <operationId>]');
      return 1;
    }
    if (p.badValue) {
      if (p.badValue === '--only') {
        U.printError('Option --only needs a value.', 'It expects a comma-separated, non-empty subset of config, deps, and runtime.', 'Example: project-state restore before-change --only config,runtime');
      } else {
        U.printError('Option --rollback-of needs an operation id.', 'A failed or unresolved restore must be identified explicitly.', 'Use the operation id shown by the restore result.');
      }
      return 1;
    }
    if (p.flags.only !== undefined) {
      const layers = p.flags.only.split(',');
      const allowed = new Set(['config', 'deps', 'runtime']);
      if (layers.some((layer) => layer.length === 0) || layers.some((layer) => !allowed.has(layer)) || new Set(layers).size !== layers.length) {
        U.printError(`Invalid --only value "${p.flags.only}".`, 'Use a comma-separated unique subset of config, deps, and runtime; empty names, duplicates, spaces, and other values are not supported.', 'Example: project-state restore before-change --only config,runtime');
        return 1;
      }
      if (p.flags.rollbackOf !== undefined) {
        U.printError('Options --only and --rollback-of cannot be combined.', 'Selective restore and operation rollback have different safety scopes.', 'Run the generated rollback command without --only, or start a selective restore without --rollback-of.');
        return 1;
      }
      p.flags.onlyLayers = layers;
      delete p.flags.only;
    }
    if (p.flags.force) U.warn('--force is obsolete and does not bypass the clean Git worktree requirement.');
    return restoreCmd(root, p.pos[0], p.flags);
  }

  console.error(`Unknown command: "${cmd}"`);
  console.error('Run "project-state help" to see available commands.');
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code || 0;
  })
  .catch((e) => {
    U.printError(
      `Unexpected crash: ${e.message}`,
      'An internal error occurred - this is a tool bug, not something you did.',
      'Re-run the same command once; if it repeats, keep this message and report it.'
    );
    process.exitCode = 2;
  });
