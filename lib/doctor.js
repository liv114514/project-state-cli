'use strict';
// doctor command: read-only diagnosis of "why might this project not run".
//
// Hard rules:
// - STRICTLY read-only: runs only --version style probes and file reads.
//   A diagnostic that mutates state is a diagnostic users fear.
// - Three-state verdicts: ok / issue / unknown. Unknown (tool missing, no
//   reference snapshot) is honesty; guessing is lying.
// - Every issue ships an actionable "Next" line.

const fsp = require('fs').promises;
const path = require('path');
const U = require('./utils');
const Store = require('./storage');
const { collectGit, collectDeps, collectConfig, collectDocker } = require('./collectors');
const { findLegacyDatabaseBackups } = require('./list');

const PROBE_TIMEOUT = 15000;

async function probe(cmd, args, cwd) {
  const r = await U.runTrusted(cmd, args, { timeout: PROBE_TIMEOUT, cwd });
  return r.ok ? String(r.stdout || '').trim().split('\n')[0] : null;
}

// Find the newest snapshot whose config layer was actually collected.
async function newestConfigSnapshot(root) {
  let names = [];
  try {
    const base = path.join(root, U.SNAPSHOTS_DIR);
    await Store.assertNoLinks(base, { allowMissing: false });
    names = await fsp.readdir(base);
  }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let best = null;
  for (const n of names.filter((name) => U.NAME_RE.test(name))) {
    try {
      const checked = await Store.validateSnapshot(root, n, { mode: 'diagnostic' });
      const m = checked.manifest;
      const config = checked.layers?.config;
      if (m.schemaVersion !== 2 || !config || config.__skipped || config.status === 'skipped' || !config.envFiles) continue;
      if (!best || Date.parse(m.createdAt) > Date.parse(best.createdAt) || (m.createdAt === best.createdAt && n.localeCompare(best.name) < 0)) {
        best = { name: n, createdAt: m.createdAt, config };
      }
    } catch {
      /* damaged manifest - not doctor's business to fix */
    }
  }
  return best;
}

function firstLine(s) {
  return String(s || '').trim().split('\n')[0];
}

async function doctorCmd(root) {
  const results = [];
  const add = (id, state, detail, next) => results.push({ id, state, detail, next });

  const legacy = await findLegacyDatabaseBackups(root);
  if (legacy.found.length) {
    add('legacy backups', 'issue', `privacy warning: legacy files/db-original path(s) may contain complete database contents (${legacy.found.map((x) => `${x.name}: ${x.path}`).join('; ')}); path presence only was checked, with no parsing, execution, or deletion`, 'Treat these old paths as private data and review them manually before sharing the project state directory.');
  }
  if (legacy.errors.length) add('legacy scan', 'unknown', `could not fully inspect historical database backup paths: ${legacy.errors.join('; ')}`, null);

  // 1) Tool availability ---------------------------------------------------
  const gitV = await probe('git', ['--version'], root);
  const gitCol = await collectGit({ root, results: {}, files: [] });
  if (gitV === null) {
    add('git', 'unknown', 'git CLI not found on PATH', 'Install git (https://git-scm.com) - the git layer needs it.');
  } else if (gitCol.status !== 'collected') {
    add('git', 'ok', `${gitV} (not a git repository - git layer will skip)`);
  } else {
    const g = gitCol.data;
    add('git', 'ok', `${gitV} (working tree ${g.dirty ? 'dirty: ' + g.dirtyCount + ' change(s)' : 'clean'})`);
  }

  // node is the runtime this tool is running on - always known, no probing.
  add('node', 'ok', process.version);
  const npmV = await probe('npm', ['--version'], root);
  if (npmV === null) add('npm', 'unknown', 'npm CLI not found on PATH', 'Install Node.js/npm - needed to sync dependencies.');
  else add('npm', 'ok', npmV);

  const sqliteV = await probe('sqlite3', ['--version'], root);
  if (sqliteV === null) add('sqlite3', 'unknown', 'sqlite3 CLI not found on PATH (database collection is unavailable)', 'Install a real sqlite3 CLI to enable local SQLite collection.');
  else add('sqlite3', 'ok', `${firstLine(sqliteV)} (availability only; database restore was not tested)`);

  const dockerV = await probe('docker', ['--version'], root);
  if (dockerV === null) add('docker', 'unknown', 'docker CLI not available (docker layer will skip)', null);
  else add('docker', 'ok', firstLine(dockerV));

  // 2) Dependency sync: lockfile versions vs node_modules reality -----------
  const depsCol = await collectDeps({ root, results: {}, files: [] });
  if (depsCol.status === 'skipped') {
    add('deps sync', 'unknown', depsCol.reason, null);
  } else if (!depsCol.data.resolved) {
    add('deps sync', 'unknown', depsCol.data.note || 'no resolvable lockfile versions', null);
  } else {
    const drift = [];
    let missing = 0;
    for (const [name, locked] of Object.entries(depsCol.data.resolved)) {
      try {
        const installed = JSON.parse(await fsp.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
        if (installed.version !== locked) drift.push(`${name}: lockfile ${locked}, node_modules ${installed.version}`);
      } catch {
        missing++;
        if (drift.length < 5) drift.push(`${name}: locked ${locked} but MISSING in node_modules`);
      }
    }
    if (missing > 5) drift.push(`... and ${missing - 5} more missing packages`);
    if (drift.length > 0) {
      add('deps sync', 'issue', drift.join('; '), 'Run "npm install" to sync node_modules with the lockfile.');
    } else {
      add('deps sync', 'ok', `${Object.keys(depsCol.data.resolved).length} direct deps match node_modules`);
    }
  }

  // 3) Config drift: compare only key names and file ownership, never values.
  const cfgCol = await collectConfig({ root, results: {}, files: [] });
  let currentFiles = null;
  if (cfgCol.status === 'collected') {
    currentFiles = cfgCol.data.envFiles || {};
  }
  const refSnap = await newestConfigSnapshot(root);
  if (!refSnap) {
    const next = U.cliCommandLines(['snapshot', 'before-config-change']);
    add('env keys', 'unknown', 'no snapshot with .env data to compare against', next.length ? `Take a baseline from this project root: ${next.join(' | ')}` : 'Take a named snapshot from this project root before comparing configuration.');
  } else {
    const snapKeys = refSnap.config.envFiles || null;
    if (currentFiles === null && snapKeys === null) {
      add('env keys', 'ok', 'no .env then, none now');
    } else if (snapKeys === null) {
      add('env keys', 'unknown', `snapshot "${refSnap.name}" has no .env data`, null);
    } else {
      const now = currentFiles || {};
      const beforeNames = Object.keys(snapKeys || {}).sort();
      const nowNames = Object.keys(now).sort();
      const changedFiles = beforeNames.filter((f) => !Object.hasOwn(now, f)).map((f) => `-${f}`)
        .concat(nowNames.filter((f) => !Object.hasOwn(snapKeys || {}, f)).map((f) => `+${f}`));
      const keyChanges = [];
      for (const file of new Set([...beforeNames, ...nowNames])) {
        const beforeKeys = Object.keys((snapKeys && snapKeys[file] && snapKeys[file].keys) || {});
        const nowKeys = Object.keys((now[file] && now[file].keys) || {});
        for (const key of nowKeys) if (!beforeKeys.includes(key)) keyChanges.push(`+${file}:${key}`);
        for (const key of beforeKeys) if (!nowKeys.includes(key)) keyChanges.push(`-${file}:${key}`);
      }
      const changes = [...changedFiles, ...keyChanges];
      if (changes.length) {
        const parts = changes.slice(0, 5).join(', ');
        const compare = U.cliCommandLines(['compare', refSnap.name]);
        add(
          'env keys',
          'issue',
          `${changes.length} env file/key change(s) since snapshot "${refSnap.name}": ${parts}`,
          compare.length ? `Compare metadata without showing values: ${compare.join(' | ')}` : 'Compare this snapshot with current metadata; values are never shown.'
        );
      } else {
        add('env keys', 'ok', `matches snapshot "${refSnap.name}"`);
      }
    }
  }

  // 4) git health is folded into the git line above; still surface repo state
  if (gitCol.status !== 'collected' && gitV !== null) {
    // non-git project: explicitly recommend, since snapshot/restore lose a layer
    add('git repo', 'issue', 'not a git repository - code is not version-controlled', 'Run "git init" and make an initial commit.');
  }

  // Output -----------------------------------------------------------------
  console.log(`Checking environment for ${root}\n`);
  let issues = 0;
  const issueNames = [];
  for (const r of results) {
    const tag = r.state.padEnd(7);
    console.log(`  ${r.id.padEnd(10)} ${tag}  ${r.detail}`);
    if (r.state === 'issue') {
      issues++;
      issueNames.push(r.id);
      if (r.next) console.log(`  ${' '.repeat(10)} ${' '.repeat(8)}  Next: ${r.next}`);
    }
  }
  console.log('');
  if (issues > 0) {
    console.log(`  Verdict: ${issues} issue(s) found — likely breakage source: ${issueNames.join(', ')}.`);
  } else {
    const unknowns = results.filter((r) => r.state === 'unknown').length;
    console.log(unknowns > 0 ? '  Verdict: no detected metadata issues; some checks are unknown.' : '  Verdict: metadata checks passed.');
  }
  const unknownItems = results.filter((r) => r.state === 'unknown');
  if (unknownItems.length) console.log(`  Unavailable or unknown checks: ${unknownItems.map((r) => r.id).join(', ')}. These do not by themselves disable every file operation; use the details above to assess the current task.`);
  if (issues > 0) console.log(`  Metadata blockers/issues: ${issueNames.join(', ')}.`);
  console.log('  Application health was not tested.');
  return issues > 0 ? 1 : 0;
}

module.exports = { doctorCmd, newestConfigSnapshot };
