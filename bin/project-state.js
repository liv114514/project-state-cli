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

const HELP = `project-state - Record selected local project state and restore supported artifacts.

First use:
  doctor → snapshot <name> → compare <name> → restore <name> --dry-run → restore <name> --yes

Common commands:
  snapshot <name>     Save selected project state
  compare <name>      Compare a snapshot with current state
  list                Inspect saved snapshots
  restore <name>      Preview, restore, or roll back supported artifacts
  doctor              Read-only environment and state diagnosis

Advanced commands:
  prune               Retire eligible auto/hook snapshots
  hook                Install or remove the best-effort pre-commit hook
  recover             Inspect or resolve a proven interrupted operation

Use "project-state help <command>" or "project-state <command> --help" for details.
Restore writes require --yes to explicitly authorize and apply the current validated plan;
there is no interactive confirmation. --dry-run previews the current plan but may create/release
lock/pin metadata. It does not reserve a snapshot generation or freeze project state.
Only validated supported artifacts are restored; application health is not tested.
From a source checkout use: node bin/project-state.js <command> [arguments].
From an installed package use: project-state <command> [arguments].
`;

const COMMAND_HELP = {
  snapshot: `project-state snapshot <name> [--overwrite] [--with-seed]

Purpose: Save selected project state as a validated snapshot generation.
Arguments: <name> is required. Names use letters, digits, dot, underscore, or hyphen (max 64).
Options: --overwrite replaces a named snapshot only after its new generation verifies.
         --with-seed requests a private, consistent SQLite binary backup.
Examples:
  project-state snapshot before-change
  project-state snapshot before-change --with-seed
Writes: Creates .project-state snapshot and private data; may add a Git exclusion.
Limits: Collection is not an application health check. Optional layers may be skipped;
        explicit --with-seed failure does not publish a generation. Private data is plaintext.
Exit codes: 0 saved (possibly partial); 1 invalid name/existing name; 2 environment or required collection failure.
`,
  compare: `project-state compare <nameA> [<nameB>]

Purpose: Compare validated snapshot metadata and supported artifact bytes.
Arguments: <nameA> is required; optional <nameB> compares two saved snapshots.
Examples:
  project-state compare before-change
  project-state compare before-change after-change
Writes: Read-only; no snapshot or business files are written.
Limits: SQLite row contents are not compared. Unknown checks are not proof of equality.
Exit codes: 0 comparison completed; 1 missing, invalid, or unreadable snapshot.
`,
  list: `project-state list

Purpose: Inspect snapshot names, generations, collection scope, and artifact validity.
Arguments: None.
Example:
  project-state list
Writes: Read-only; does not recover, migrate, or delete snapshots.
Limits: Valid artifacts do not establish environment recoverability or application health.
Exit codes: 0 inventory displayed; 2 inventory could not be read completely.
`,
  doctor: `project-state doctor

Purpose: Read-only checks of tool availability and selected project metadata.
Arguments: None.
Example:
  project-state doctor
Writes: Read-only. No tools are installed and no fixes are run automatically.
Limits: Results use ok / issue / unknown. Availability is not a restore or health test;
        optional Docker or SQLite availability does not by itself block file operations.
Exit codes: 0 no reported issue (some checks may be unknown); 1 issue found; 2 check failed.
`,
  restore: `project-state restore <name> [--dry-run] [--yes] [--force] [--only config,deps,runtime] [--rollback-of <operationId>]

Purpose: Preview or restore a validated snapshot's explicitly supported artifacts.
Arguments: <name> is required. --rollback-of is used only with its matching operation.
Examples:
  project-state restore before-change --only config --dry-run
  project-state restore before-change --only config --yes
Writes: --dry-run changes no business targets, but may create/release lock and pin metadata.
        --yes explicitly authorizes every restore write; there is no interactive confirmation.
Limits: The plan is revalidated when applied. --force cannot bypass dirty or uncertain state.
        --only supports config, deps, runtime; it does not restore Git, databases, or Docker.
        Restore does not restart the application or prove application health.
Exit codes: 0 preview or verified result; 1 refused/not found; 2 failed or incomplete compensation.
`,
  prune: `project-state prune [--yes] [--keep N]

Purpose: Retire eligible old auto/hook snapshot generations.
Arguments: None. N is a whole number; default is 10.
Examples:
  project-state prune --keep 5
  project-state prune --keep 5 --yes
Writes: Without --yes, previews. With --yes, retires eligible unreferenced generations.
Limits: Named, pinned, unresolved, current, invalid-time, and ambiguous generations are retained.
        Completed retirement is not reversible.
Exit codes: 0 preview/completed; 1 invalid arguments; 2 operation or cleanup remains unresolved.
`,
  hook: `project-state hook install | project-state hook uninstall

Purpose: Install or remove the best-effort pre-commit snapshot hook.
Arguments: Choose exactly one of install or uninstall.
Examples:
  project-state hook install
  project-state hook uninstall
Writes: Changes the project's Git hook configuration. A foreign hook is preserved and runs first.
Limits: This tool's snapshot/log failures do not block commit; a foreign hook failure still does.
        Uninstall refuses edited or ambiguous hook content.
Exit codes: 0 changed/already installed; 1 invalid or unsafe operation; 2 I/O failure.
`,
  recover: `project-state recover <operationId> --inspect
project-state recover <operationId> --compensate --yes
project-state recover <operationId> --cleanup --yes
project-state recover <operationId> --continue --yes

Purpose: Inspect or resolve a supported interrupted local transaction.
Arguments: <operationId> is the exact ID printed by the original operation.
Examples:
  project-state recover 0123456789abcdef0123456789abcdef --inspect
  project-state recover 0123456789abcdef0123456789abcdef --compensate --yes
Writes: --inspect is read-only. Other modes require --yes and a verified journal/lock binding.
Limits: Active, foreign, ambiguous, damaged, or unsupported operations are refused.
        Keep the journal, pins, and referenced generations when resolution is refused.
Exit codes: 0 inspected/resolved; 1 refused/invalid; 2 resolution remains incomplete.
`,
};

function usage(line) {
  console.error(`Usage: project-state ${line}`);
  console.error(U.cliNext(['help'], 'Run "project-state help" for details.'));
}

function printHelp(topic) {
  if (typeof topic !== 'string' || !Object.hasOwn(COMMAND_HELP, topic)) {
    U.printError(`Unknown help topic "${topic}".`, 'No command help is registered under that name.', U.cliNext(['help'], 'Run "project-state help" to see the supported commands.'));
    return 1;
  }
  const text = COMMAND_HELP[topic];
  console.log(text);
  if (process.argv[1] && require('node:path').basename(process.argv[1]).toLowerCase() === 'project-state.js') {
    console.log(`CLI entry: ${U.cliNext(['help', topic], 'node bin/project-state.js help ' + topic)}`);
  }
  return 0;
}

function badFlag(flag) {
  U.printError(`Unknown option "${flag}".`, 'This option is not supported by the selected command.', U.cliNext(['help'], 'Run "project-state help" to see valid options.'));
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
    if (cmd === 'help' && rest.length === 1) return printHelp(rest[0]);
    if (cmd === 'help' && rest.length > 1) {
      usage('help [<command>]');
      return 1;
    }
    if (cmd && cmd !== 'help' && rest.length > 0) {
      usage('--help');
      return 1;
    }
    console.log(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return 0;
  }

  if (Object.hasOwn(COMMAND_HELP, cmd) && rest.some((arg) => arg === '--help' || arg === '-h')) {
    if (rest.length !== 1) {
      usage(`${cmd} --help`);
      return 1;
    }
    return printHelp(cmd);
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
        `Example: ${U.cliNext(['prune', '--keep', '5'], 'project-state prune --keep 5')}`
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
      U.printError('Option --only may be specified only once.', 'Choose one comma-separated subset of config, deps, and runtime.', `Example: ${U.cliNext(['restore', 'before-change', '--only', 'config,runtime', '--dry-run'], 'project-state restore before-change --only config,runtime --dry-run')}`);
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
        U.printError('Option --only needs a value.', 'It expects a comma-separated, non-empty subset of config, deps, and runtime.', `Example: ${U.cliNext(['restore', 'before-change', '--only', 'config,runtime', '--dry-run'], 'project-state restore before-change --only config,runtime --dry-run')}`);
      } else {
        U.printError('Option --rollback-of needs an operation id.', 'A failed or unresolved restore must be identified explicitly.', 'Use the operation id shown by the restore result.');
      }
      return 1;
    }
    if (p.flags.only !== undefined) {
      const layers = p.flags.only.split(',');
      const allowed = new Set(['config', 'deps', 'runtime']);
      if (layers.some((layer) => layer.length === 0) || layers.some((layer) => !allowed.has(layer)) || new Set(layers).size !== layers.length) {
        U.printError(`Invalid --only value "${p.flags.only}".`, 'Use a comma-separated unique subset of config, deps, and runtime; empty names, duplicates, spaces, and other values are not supported.', `Example: ${U.cliNext(['restore', 'before-change', '--only', 'config,runtime', '--dry-run'], 'project-state restore before-change --only config,runtime --dry-run')}`);
        return 1;
      }
      if (p.flags.rollbackOf !== undefined) {
        U.printError('Options --only and --rollback-of cannot be combined.', 'Selective restore and operation rollback have different safety scopes.', 'Use the exact rollback command generated by the completed operation; for a new selective restore, remove --rollback-of and review --dry-run first.');
        return 1;
      }
      p.flags.onlyLayers = layers;
      delete p.flags.only;
    }
    if (p.flags.force) U.warn('--force is obsolete and does not bypass the clean Git worktree requirement.');
    return restoreCmd(root, p.pos[0], p.flags);
  }

  console.error(`Unknown command: "${cmd}"`);
  console.error(U.cliNext(['help'], 'Run "project-state help" to see available commands.'));
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
