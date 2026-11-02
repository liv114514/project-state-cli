'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const U = require('./utils');
const Store = require('./storage');
const Git = require('./restore-git');

const RESULT_SCHEMA_VERSION = 1;
const TASKS = new Set(['config-snapshot', 'config-restore']);
const CONFIG_FILES = ['.env', '.env.local'];

function check(id, state, required, reasonCode, message) {
  return { id, state, required, reasonCode, message };
}

function isMissing(error) { return error && error.code === 'ENOENT'; }
function isPermission(error) { return error && ['EACCES', 'EPERM'].includes(error.code); }

function permissionState(error, missingCode, unsafeCode) {
  if (error?.code === 'EUNSAFE_PATH') return { state: 'issue', reasonCode: unsafeCode };
  if (isPermission(error)) return { state: 'issue', reasonCode: 'PERMISSION_DENIED' };
  if (isMissing(error)) return { state: 'unknown', reasonCode: missingCode };
  return { state: 'unknown', reasonCode: 'INSPECTION_FAILED' };
}

async function inspectContext(root) {
  const result = { scope: 'current-working-directory', pathDisclosure: 'omitted', gitRepository: 'unknown' };
  try {
    await Store.assertRealProject(root);
  } catch (error) {
    return {
      context: result,
      check: check('project.context', 'issue', true,
        error?.code === 'EUNSAFE_PATH' ? 'PROJECT_PATH_UNSAFE' : isPermission(error) ? 'PROJECT_PATH_PERMISSION_DENIED' : 'PROJECT_CONTEXT_UNKNOWN',
        'The current directory could not be verified as a safe project directory.'),
      gitEntry: 'unknown',
    };
  }

  try {
    const gitStat = await fsp.lstat(path.join(root, '.git'));
    if (gitStat.isSymbolicLink() || (!gitStat.isDirectory() && !gitStat.isFile())) {
      result.gitRepository = 'unknown';
      return {
        context: result,
        check: check('project.context', 'issue', true, 'GIT_METADATA_UNSAFE', 'Git metadata is a link or unsupported filesystem object.'),
        gitEntry: 'unsafe',
      };
    }
    result.gitRepository = 'yes';
    return {
      context: result,
      check: check('project.context', 'ok', true, 'CURRENT_DIRECTORY_VERIFIED', 'The exact current directory is a real directory; no parent discovery was used.'),
      gitEntry: gitStat.isDirectory() ? 'directory' : 'file',
    };
  } catch (error) {
    if (isMissing(error)) {
      result.gitRepository = 'no';
      return {
        context: result,
        check: check('project.context', 'ok', true, 'CURRENT_DIRECTORY_VERIFIED', 'The exact current directory is a real directory; no parent discovery was used.'),
        gitEntry: 'absent',
      };
    }
    result.gitRepository = 'unknown';
    return {
      context: result,
      check: check('project.context', 'unknown', true, 'PROJECT_CONTEXT_UNKNOWN', 'Git project context could not be inspected.'),
      gitEntry: 'unknown',
    };
  }
}

async function inspectConfigFiles(root) {
  const files = [];
  let problem = null;
  for (const name of CONFIG_FILES) {
    const absolute = path.join(root, name);
    let stat;
    try { stat = await fsp.lstat(absolute, { bigint: true }); }
    catch (error) {
      if (isMissing(error)) continue;
      if (!problem) problem = error;
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1n) {
      if (!problem) problem = Store.coded('EUNSAFE_PATH', 'configuration path is not a single-link regular file');
      continue;
    }
    try {
      await fsp.access(absolute, fs.constants.R_OK);
      files.push(name);
    } catch (error) { if (!problem) problem = error; }
  }
  return { files, problem };
}

async function inspectStorageBoundary(root) {
  const stateRoot = path.join(root, Store.STATE_DIR);
  const directories = ['snapshots', 'secrets', 'staging', 'operations', 'locks', 'pins'];
  try {
    await Store.assertRealProject(root);
    for (const directory of directories) await Store.assertNoLinks(path.join(stateRoot, directory), { allowMissing: true });
    const stateStat = await fsp.lstat(stateRoot).catch((error) => isMissing(error) ? null : Promise.reject(error));
    const writablePath = stateStat ? stateRoot : root;
    await fsp.access(writablePath, fs.constants.W_OK);
    return { state: 'ok', reasonCode: 'PRIVATE_STORAGE_BOUNDARY_VERIFIED', message: 'Private storage paths contain no observed links; the existing storage parent reports write access.' };
  } catch (error) {
    const mapped = permissionState(error, 'PRIVATE_STORAGE_STATE_CHANGED', 'PRIVATE_STORAGE_UNSAFE');
    return {
      ...mapped,
      message: mapped.state === 'issue'
        ? 'Private storage paths are unsafe or inaccessible; no snapshot was attempted.'
        : 'Private storage capability could not be confirmed without writing state.',
    };
  }
}

async function inspectGitSnapshotPrivacy(root, gitEntry, configFiles) {
  if (gitEntry === 'absent') return [
    check('tool.git', 'not-applicable', false, 'NOT_A_GIT_PROJECT', 'Git is not needed to save selected configuration in a non-Git directory.'),
    check('privacy.git-exclusion', 'not-applicable', true, 'NOT_A_GIT_PROJECT', 'No Git metadata exists for the current directory.'),
  ];
  if (gitEntry === 'unsafe' || gitEntry === 'unknown') return [
    check('tool.git', 'unknown', true, 'GIT_CONTEXT_UNKNOWN', 'Git availability and private-input status could not be confirmed.'),
    check('privacy.git-exclusion', 'unknown', true, 'GIT_CONTEXT_UNKNOWN', 'Private configuration is not cleared for capture.'),
  ];

  const binary = U.resolveTrustedBinary('git', root);
  if (!binary) return [
    check('tool.git', 'issue', true, 'GIT_UNAVAILABLE', 'Git is required here to verify that private configuration and project-state data are not tracked.'),
    check('privacy.git-exclusion', 'unknown', true, 'GIT_STATUS_UNVERIFIED', 'Private configuration is not cleared for capture.'),
  ];

  const tracked = await U.runTrusted('git', ['ls-files', '-z', '--', '.project-state/', ...configFiles], { cwd: root, timeout: 15000 });
  if (!tracked.ok) return [
    check('tool.git', 'ok', true, 'GIT_AVAILABLE', 'A trusted Git executable is available.'),
    check('privacy.git-exclusion', 'unknown', true, 'GIT_STATUS_UNVERIFIED', 'Git could not verify whether private inputs are tracked.'),
  ];
  const trackedPaths = tracked.stdout.split('\0').filter(Boolean);
  const stateTracked = trackedPaths.some((item) => item === '.project-state' || item.startsWith('.project-state/'));
  const configTracked = trackedPaths.some((item) => configFiles.includes(item));
  if (stateTracked || configTracked) return [
    check('tool.git', 'ok', true, 'GIT_AVAILABLE', 'A trusted Git executable is available.'),
    check('privacy.git-exclusion', 'issue', true, 'PRIVATE_INPUT_TRACKED', 'Git already tracks a selected private path; snapshot capture will not publish that private layer.'),
  ];

  const exclude = await U.runTrusted('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, timeout: 15000 });
  if (!exclude.ok || !exclude.stdout.trim()) return [
    check('tool.git', 'ok', true, 'GIT_AVAILABLE', 'A trusted Git executable is available.'),
    check('privacy.git-exclusion', 'unknown', true, 'GIT_EXCLUSION_UNKNOWN', 'The local Git exclusion boundary could not be confirmed.'),
  ];

  try {
    const excludePath = path.isAbsolute(exclude.stdout.trim()) ? exclude.stdout.trim() : path.resolve(root, exclude.stdout.trim());
    const parent = path.dirname(excludePath);
    await Store.assertNoLinks(parent, { allowMissing: false });
    await Store.assertNoLinks(excludePath, { allowMissing: true, hardlinks: true });
    const stat = await fsp.lstat(excludePath).catch((error) => isMissing(error) ? null : Promise.reject(error));
    if (stat && (!stat.isFile() || stat.nlink > 1n)) throw Store.coded('EUNSAFE_PATH', 'exclude file is not a single-link regular file');
    await fsp.access(stat ? excludePath : parent, fs.constants.W_OK);
    return [
      check('tool.git', 'ok', true, 'GIT_AVAILABLE', 'A trusted Git executable is available.'),
      check('privacy.git-exclusion', 'ok', true, 'GIT_EXCLUSION_BOUNDARY_SAFE', 'Git can safely maintain the local project-state exclusion; no exclusion file was changed by this check.'),
    ];
  } catch (error) {
    const mapped = permissionState(error, 'GIT_EXCLUSION_CHANGED', 'GIT_EXCLUSION_UNSAFE');
    return [
      check('tool.git', 'ok', true, 'GIT_AVAILABLE', 'A trusted Git executable is available.'),
      check('privacy.git-exclusion', mapped.state, true, mapped.reasonCode, 'The local Git exclusion boundary could not be safely verified.'),
    ];
  }
}

async function inspectOperationState(root) {
  const state = path.join(root, Store.STATE_DIR);
  const lockDir = path.join(state, 'locks');
  const operationLock = path.join(lockDir, 'operation.lock');
  const claim = path.join(lockDir, 'operation.claim');
  try {
    await Store.assertNoLinks(lockDir, { allowMissing: true });
    for (const target of [operationLock, claim]) {
      await Store.assertNoLinks(target, { allowMissing: true });
      if (await fsp.lstat(target).then(() => true, (error) => isMissing(error) ? false : Promise.reject(error))) {
        return check('operation.state', 'issue', true, 'OPERATION_STATE_PRESENT', 'An operation lock or claim exists; this read-only check will preserve it and will not infer whether it is stale.');
      }
    }
    const operations = path.join(state, 'operations');
    await Store.assertNoLinks(operations, { allowMissing: true });
    const files = await fsp.readdir(operations).catch((error) => isMissing(error) ? [] : Promise.reject(error));
    if (files.some((name) => name.endsWith('.tmp'))) {
      return check('operation.state', 'unknown', true, 'OPERATION_JOURNAL_TEMP_PRESENT', 'An operation journal temporary exists; its ownership and transaction phase were not inferred. Preserve it for recovery inspection.');
    }
    for (const name of files.filter((item) => /^[a-f0-9]{32}\.json$/.test(item))) {
      let journal;
      try { journal = await Store.readJournal(root, path.join(operations, name)); }
      catch { return check('operation.state', 'unknown', true, 'OPERATION_JOURNAL_INVALID', 'An operation journal could not be validated; preserve project-state and resolve it before continuing.'); }
      if (journal.operation === 'snapshot' && journal.status === 'in-progress') {
        const transaction = journal.snapshotTransaction;
        if (transaction?.phase === 'committed' && journal.terminalOutcome === 'verified-complete' && !(journal.cleanupPending || []).length) continue;
      }
      if (journal.status === 'in-progress' || journal.status === 'failed-rollback-incomplete' || (journal.cleanupPending || []).length > 0) {
        return check('operation.state', 'issue', true, 'OPERATION_UNRESOLVED', 'An operation journal records unresolved work; inspect that operation before continuing.');
      }
    }
    return check('operation.state', 'ok', true, 'NO_UNRESOLVED_OPERATION_OBSERVED', 'No active lock, claim, or unresolved operation journal was observed.');
  } catch (error) {
    const mapped = permissionState(error, 'OPERATION_STATE_CHANGED', 'OPERATION_STATE_UNSAFE');
    return check('operation.state', mapped.state, true, mapped.reasonCode, 'Operation state could not be checked without changing it.');
  }
}

function snapshotError(error) {
  const map = {
    ESNAPSHOT_MISSING: ['issue', 'SNAPSHOT_NOT_FOUND', 'The named snapshot does not exist in this project.'],
    ELEGACY_RESTORE: ['issue', 'SNAPSHOT_LEGACY_DIAGNOSTIC_ONLY', 'This legacy snapshot is diagnostic-only and cannot be restored.'],
    ESCHEMA_UNSUPPORTED: ['issue', 'SNAPSHOT_SCHEMA_UNSUPPORTED', 'This snapshot uses an unsupported schema version.'],
    EARTIFACT_MISSING: ['issue', 'SNAPSHOT_ARTIFACT_MISSING', 'A required snapshot artifact is missing.'],
    ENOENT: ['issue', 'SNAPSHOT_ARTIFACT_MISSING', 'A required snapshot artifact or generation entry is missing.'],
    EARTIFACT_INTEGRITY: ['issue', 'SNAPSHOT_ARTIFACT_INVALID', 'A required snapshot artifact failed integrity validation.'],
    EMANIFEST_INVALID: ['issue', 'SNAPSHOT_MANIFEST_INVALID', 'Snapshot metadata is malformed or inconsistent.'],
    EUNSAFE_PATH: ['issue', 'SNAPSHOT_PATH_UNSAFE', 'A snapshot path violates the local storage boundary.'],
    EACCES: ['issue', 'SNAPSHOT_PERMISSION_DENIED', 'Permission was denied while reading the snapshot.'],
    EPERM: ['issue', 'SNAPSHOT_PERMISSION_DENIED', 'Permission was denied while reading the snapshot.'],
  };
  return map[error?.code] || ['unknown', 'SNAPSHOT_VALIDATION_UNKNOWN', 'Snapshot validity could not be established. Preserve the snapshot and retry inspection after resolving the local read problem.'];
}

function summarize(task, checks) {
  const required = checks.filter((item) => item.required);
  const issues = required.filter((item) => item.state === 'issue').length;
  const unknowns = required.filter((item) => item.state === 'unknown').length;
  if (issues) return { state: 'blocked', requiredIssueCount: issues, requiredUnknownCount: unknowns };
  if (unknowns) return { state: 'unknown', requiredIssueCount: 0, requiredUnknownCount: unknowns };
  if (task === 'config-snapshot' && checks.some((item) => item.id === 'config.applicability' && item.state === 'not-applicable') &&
      checks.some((item) => item.id === 'config.files' && item.state === 'not-applicable')) {
    return { state: 'not-applicable', requiredIssueCount: 0, requiredUnknownCount: 0 };
  }
  const applicable = required.filter((item) => item.state !== 'not-applicable').length;
  return { state: applicable === 0 ? 'not-applicable' : 'ready', requiredIssueCount: 0, requiredUnknownCount: 0 };
}

function nextStepFor(task, snapshot, summary) {
  if (summary.state === 'ready' && task === 'config-snapshot') {
    return { action: 'save-config-snapshot', command: 'snapshot', args: ['<name>'], cwd: 'current-working-directory', confirmation: 'none', effects: 'writes-project-state', revalidates: true };
  }
  if (summary.state === 'ready' && task === 'config-restore') {
    return { action: 'preview-config-restore', command: 'restore', args: [snapshot, '--only', 'config', '--dry-run'], cwd: 'current-working-directory', confirmation: 'none-for-preview', effects: 'may-create-and-release-lock-pin-metadata', revalidates: true };
  }
  if (task === 'config-restore' && summary.state === 'blocked') {
    return { action: 'inspect-snapshot-inventory', command: 'list', args: [], cwd: 'current-working-directory', confirmation: 'none', effects: 'read-only', revalidates: true };
  }
  return { action: 'review-required-checks', command: null, args: [], cwd: 'current-working-directory', confirmation: 'none', effects: 'none', revalidates: true };
}

async function buildTaskDoctorResult(root, { task, snapshot }) {
  if (!TASKS.has(task)) throw new TypeError('unsupported doctor task');
  const context = await inspectContext(root);
  const checks = [context.check];
  const configInfo = await inspectConfigFiles(root);
  const configApplicable = configInfo.files.length > 0;

  if (task === 'config-snapshot') {
    const sqlite = U.resolveTrustedBinary('sqlite3', root);
    checks.push(check('tool.sqlite3', sqlite ? 'ok' : 'unknown', false,
      sqlite ? 'OPTIONAL_TOOL_AVAILABLE' : 'OPTIONAL_TOOL_UNAVAILABLE',
      sqlite ? 'A trusted SQLite CLI is available; database data are not checked by this config task.' : 'SQLite is unavailable but optional for this config task; database data are not checked.'));
    checks.push(check('config.applicability', configInfo.problem ? 'issue' : configApplicable ? 'ok' : 'not-applicable', true,
      configInfo.problem ? 'CONFIG_FILE_UNSAFE' : configApplicable ? 'SUPPORTED_CONFIG_PRESENT' : 'NO_APPLICABLE_CONFIG',
      configInfo.problem ? 'A supported configuration path is unsafe or unreadable.' : configApplicable ? 'At least one supported configuration file is present.' : 'Neither supported configuration file is present in the current directory.'));
    if (configInfo.problem) {
      const mapped = permissionState(configInfo.problem, 'CONFIG_FILE_CHANGED', 'CONFIG_FILE_UNSAFE');
      checks.push(check('config.files', mapped.state, true, mapped.reasonCode,
        mapped.state === 'issue' ? 'A supported configuration path is unsafe or unreadable.' : 'Configuration file state changed or could not be verified.'));
    } else {
      checks.push(check('config.files', configApplicable ? 'ok' : 'not-applicable', configApplicable,
        configApplicable ? 'CONFIG_FILES_READABLE' : 'NO_APPLICABLE_CONFIG',
        configApplicable ? 'Supported configuration paths are regular, readable files; their contents were not read.' : 'No supported configuration file needs checking.'));
    }
    checks.push(await inspectStorageBoundary(root).then((value) => check('privacy.storage', value.state, true, value.reasonCode, value.message)));
    checks.push(await inspectOperationState(root));
    checks.push(...await inspectGitSnapshotPrivacy(root, context.gitEntry, configInfo.files));
    if (configApplicable) {
      const trackedCheck = checks.find((item) => item.id === 'privacy.git-exclusion');
      if (trackedCheck?.reasonCode === 'PRIVATE_INPUT_TRACKED') {
        const applicability = checks.find((item) => item.id === 'config.applicability');
        applicability.state = 'issue';
        applicability.reasonCode = 'PRIVATE_INPUT_TRACKED';
        applicability.message = 'A selected private input is tracked by Git and will not be saved as a private configuration artifact.';
      }
    }
    if (!configApplicable && !configInfo.problem) {
      checks.find((item) => item.id === 'privacy.storage').required = false;
      checks.find((item) => item.id === 'operation.state').required = false;
      checks.find((item) => item.id === 'privacy.git-exclusion').required = false;
      checks.find((item) => item.id === 'tool.git').required = false;
    }
  } else {
    checks.push(check('config.applicability', 'unknown', true, 'SNAPSHOT_REQUIRED', 'A named snapshot must contain supported configuration artifacts for this task.'));
    const binary = U.resolveTrustedBinary('git', root);
    checks.push(binary
      ? check('tool.git', 'ok', true, 'GIT_AVAILABLE', 'A trusted Git executable is available for restore preflight.')
      : check('tool.git', 'issue', true, 'GIT_UNAVAILABLE', 'Git is required by the restore safety inspection.'));
    let gitState = null;
    if (binary && context.check.state === 'ok') {
      try {
        gitState = await Git.inspectGit(root, { readOnly: true });
        if (!gitState.isGit) {
          checks.push(check('git.worktree', 'issue', true, 'GIT_REPOSITORY_REQUIRED', 'Configuration restore requires a supported Git worktree; no parent repository was searched.'));
        } else if (!gitState.clean) {
          checks.push(check('git.worktree', 'issue', true, 'GIT_WORKTREE_DIRTY', 'The Git worktree or index is not clean; restore refuses this state.'));
        } else {
          checks.push(check('git.worktree', 'ok', true, 'GIT_WORKTREE_CLEAN', 'Git status was checked after effective content filters were refused; optional index writes were disabled.'));
        }
      } catch {
        checks.push(check('git.worktree', 'unknown', true, 'GIT_STATE_UNVERIFIED', 'Git restore preconditions could not be verified safely.'));
      }
    } else {
      checks.push(check('git.worktree', 'unknown', true, 'GIT_STATE_UNVERIFIED', 'Git restore preconditions could not be checked.'));
    }

    const operationState = await inspectOperationState(root);
    checks.push(operationState);
    let validated = null;
    try {
      validated = await Store.validateSnapshot(root, snapshot, { mode: 'restore' });
      checks.push(check('snapshot.integrity', 'ok', true, 'SNAPSHOT_VALIDATED', 'Required public and private snapshot artifacts passed integrity validation.'));
    } catch (error) {
      const [state, reasonCode, message] = snapshotError(error);
      checks.push(check('snapshot.integrity', state, true, reasonCode, message));
    }

    if (validated) {
      const configArtifacts = validated.artifacts.filter((artifact) => artifact.layer === 'config' && artifact.restore === 'restore-file' && typeof artifact.target === 'string');
      if (!configArtifacts.length || validated.manifest.layers?.config?.status !== 'collected') {
        checks.push(check('config.targets', 'issue', true, 'CONFIG_NOT_CAPTURED', 'This snapshot did not capture any supported configuration files.'));
      } else {
        let failure = null;
        try {
          const indexPaths = gitState?.isGit ? Git.parseIndexEntries(gitState.indexEntries).map((entry) => entry.path) : [];
          for (const artifact of configArtifacts) {
            await Store.validateRestoreTarget(root, artifact.target, 'config');
            if (indexPaths.includes(artifact.target)) throw Store.coded('ECONFIG_TRACKED', 'configuration target is tracked by the current index');
            const target = path.join(root, artifact.target);
            const targetStat = await fsp.lstat(target).catch((error) => isMissing(error) ? null : Promise.reject(error));
            await fsp.access(targetStat ? target : root, fs.constants.W_OK);
          }
        } catch (error) { failure = error; }
        if (failure) {
          const mapped = permissionState(failure, 'CONFIG_TARGET_CHANGED', 'CONFIG_TARGET_UNSAFE');
          checks.push(check('config.targets', mapped.state, true,
            failure.code === 'ECONFIG_TRACKED' ? 'CONFIG_TARGET_TRACKED' : mapped.reasonCode,
            mapped.state === 'issue' ? 'A selected configuration target is tracked, unsafe, or not writable.' : 'A selected configuration target changed or could not be checked.'));
        } else {
          checks.push(check('config.targets', 'ok', true, 'CONFIG_TARGETS_SAFE', 'Selected configuration targets pass current path and access checks; restore will revalidate them.'));
        }
      }
      checks.find((item) => item.id === 'config.applicability').state = checks.find((item) => item.id === 'config.targets').state === 'ok' ? 'ok' : 'issue';
      checks.find((item) => item.id === 'config.applicability').reasonCode = checks.find((item) => item.id === 'config.targets').state === 'ok' ? 'CONFIG_CAPTURED' : 'CONFIG_RESTORE_UNAVAILABLE';
      checks.find((item) => item.id === 'config.applicability').message = checks.find((item) => item.id === 'config.targets').state === 'ok' ? 'The named snapshot contains supported configuration artifacts.' : 'The named snapshot cannot provide a safe configuration restore plan.';
    }
    checks.push(check('tool.sqlite3', 'not-applicable', false, 'DATABASE_NOT_SELECTED', 'SQLite is not required for the config-only restore task.'));
    checks.push(await inspectStorageBoundary(root).then((value) => check('privacy.storage', value.state, true, value.reasonCode, value.message)));
    void gitState;
  }

  const summary = summarize(task, checks);
  return {
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    toolVersion: U.TOOL_VERSION,
    command: 'doctor',
    task,
    projectContext: context.context,
    checks,
    summary,
    nextStep: nextStepFor(task, snapshot, summary),
    limitations: [
      'Readiness is a point-in-time observation, not write authorization, a lock, a pin, or a reserved snapshot generation.',
      'The real snapshot or restore command revalidates inputs and current project state.',
      'Application health and future process behavior are not tested.',
      'The JSON is local diagnostic output and is not automatically safe to share.',
    ],
  };
}

function renderTaskDoctorText(result) {
  const lines = [
    `Task readiness: ${result.summary.state}`,
    `Task: ${result.task}`,
    'Project scope: current working directory (path omitted)',
    `Git repository: ${result.projectContext.gitRepository}`,
    '',
  ];
  for (const item of result.checks) {
    lines.push(`${item.id}: ${item.state} [${item.reasonCode}]${item.required ? ' required' : ' optional'} — ${item.message}`);
  }
  lines.push('', `Summary: ${result.summary.state}; required issues ${result.summary.requiredIssueCount}; required unknown ${result.summary.requiredUnknownCount}.`);
  if (result.nextStep?.command) lines.push(`Next: from this same directory, review the suggested ${result.nextStep.command} action; execution revalidates state and may write project-state metadata.`);
  else lines.push('Next: resolve or review the reported checks, then rerun this task diagnosis.');
  for (const limitation of result.limitations) lines.push(`Limit: ${limitation}`);
  return lines.join('\n');
}

async function doctorTaskCmd(root, options) {
  let result;
  try {
    result = await buildTaskDoctorResult(root, options);
  } catch {
    result = {
      resultSchemaVersion: RESULT_SCHEMA_VERSION,
      toolVersion: U.TOOL_VERSION,
      command: 'doctor',
      task: options.task,
      projectContext: { scope: 'current-working-directory', pathDisclosure: 'omitted', gitRepository: 'unknown' },
      checks: [check('diagnostic.execution', 'unknown', true, 'DIAGNOSTIC_READ_FAILED', 'The read-only inspection could not complete; no recovery or cleanup was attempted.')],
      summary: { state: 'unknown', requiredIssueCount: 0, requiredUnknownCount: 1 },
      nextStep: nextStepFor(options.task, options.snapshot, { state: 'unknown' }),
      limitations: ['Readiness is not write authorization; real operations must revalidate their inputs.'],
    };
  }
  if (options.json) console.log(JSON.stringify(result));
  else console.log(renderTaskDoctorText(result));
  return result.summary.state === 'blocked' ? 1 : result.summary.state === 'unknown' ? 2 : 0;
}

module.exports = { RESULT_SCHEMA_VERSION, buildTaskDoctorResult, renderTaskDoctorText, doctorTaskCmd };
