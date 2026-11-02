'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const repo = path.resolve(__dirname, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-state-install-'));
const prefix = path.join(temp, 'prefix');
const project = path.join(temp, 'project');
process.env.npm_config_cache = path.join(temp, 'npm-cache');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} exited ${result.status}: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout || '';
}
function npm(args, cwd = repo) {
  const npmCli = process.env.npm_execpath;
  return npmCli
    ? run(process.execPath, [npmCli, ...args], { cwd })
    : run(npmCommand, args, { cwd, shell: process.platform === 'win32' });
}
function installedCli(args, cwd = project) {
  return run(process.execPath, [path.join(prefix, 'node_modules', pkg.name, 'bin', 'project-state.js'), ...args], { cwd });
}
function treeFingerprint(directory) {
  const rows = [];
  const visit = (current, prefix = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { rows.push([relative, 'directory']); visit(target, relative); }
      else if (entry.isFile()) rows.push([relative, 'file', crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')]);
      else rows.push([relative, 'other']);
    }
  };
  visit(directory);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
function outputRollback(stdout) {
  const label = process.platform === 'win32' ? 'Exact rollback command (PowerShell): ' : 'Exact rollback command: ';
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith(label));
  if (!line) throw new Error('installed CLI omitted the platform rollback command');
  const command = line.slice(label.length);
  return process.platform === 'win32'
    ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: project })
    : run('/bin/sh', ['-c', command], { cwd: project });
}
function previewApply(stdout) {
  const marker = stdout.indexOf('To apply later,');
  if (marker < 0) throw new Error('installed CLI preview omitted its next step');
  const lines = stdout.slice(marker).split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean);
  const line = process.platform === 'win32'
    ? lines.find((entry) => entry.startsWith('PowerShell: '))
    : lines.find((entry) => !entry.startsWith('Plan details:'));
  if (!line) throw new Error('installed CLI preview omitted a command for this shell');
  const command = process.platform === 'win32' ? line.slice('PowerShell: '.length) : line;
  return process.platform === 'win32'
    ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: project })
    : run('/bin/sh', ['-c', command], { cwd: project });
}

try {
  fs.mkdirSync(project, { recursive: true });
  const packJson = npm(['pack', '--json', '--pack-destination', temp]);
  const pack = JSON.parse(packJson)[0];
  const tgz = path.join(temp, pack.filename);
  const packageBytes = fs.readFileSync(tgz);
  const packHash = crypto.createHash('sha256').update(packageBytes).digest('hex');
  const artifactsDir = process.env.PROJECT_STATE_ARTIFACTS_DIR;
  let retainedTarball = null;
  if (artifactsDir) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    retainedTarball = path.join(artifactsDir, pack.filename);
    fs.copyFileSync(tgz, retainedTarball, fs.constants.COPYFILE_EXCL);
    const retainedHash = crypto.createHash('sha256').update(fs.readFileSync(retainedTarball)).digest('hex');
    if (retainedHash !== packHash) throw new Error('retained tarball bytes differ from the package installed for this verification');
  }
  const expected = [
    'package.json', 'LICENSE', 'README.md', 'README.zh-CN.md', 'scripts/demo.cjs', 'examples/inspect-snapshots.cjs', 'CONTRIBUTING.md',
    'docs/CAPABILITY-MATRIX.md', 'docs/CONTRACTS.md', 'docs/TASK-DIAGNOSTICS.md', 'docs/SNAPSHOT-INSPECTION.md', 'docs/KNOWN-LIMITATIONS.md', 'bin/project-state.js',
    ...fs.readdirSync(path.join(repo, 'lib')).filter((name) => name.endsWith('.js')).map((name) => `lib/${name}`),
  ].sort();
  const actual = (pack.files || []).map((entry) => entry.path.replace(/\\/g, '/')).sort();
  if (pack.version !== pkg.version || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('tarball version or allowlisted file inventory mismatch');

  npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tgz], temp);
  const installedPackage = path.join(prefix, 'node_modules', pkg.name);
  const packagedMarkdown = [
    'README.md', 'README.zh-CN.md',
    ...fs.readdirSync(path.join(installedPackage, 'docs'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => path.join('docs', name)),
  ];
  for (const markdownName of packagedMarkdown) {
    const markdown = fs.readFileSync(path.join(installedPackage, markdownName), 'utf8');
    const links = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
    for (const target of links.filter((item) => !/^(?:[a-z]+:|#)/i.test(item))) {
      if (!fs.existsSync(path.resolve(path.dirname(path.join(installedPackage, markdownName)), target))) {
        throw new Error(`${markdownName} has a missing installed-package link: ${target}`);
      }
    }
  }
  const demoOutput = npm(['run', 'demo'], installedPackage);
  if (!/bytes verified A → B → A → B/.test(demoOutput) || !/unmodified printed rollback command restored B/.test(demoOutput)) {
    throw new Error('installed package demo did not verify the synthetic restore and exact rollback flow');
  }
  const version = installedCli(['--version']);
  if (version.trim() !== pkg.version) throw new Error('installed CLI version does not match package metadata');
  const help = installedCli(['help', 'restore']);
  if (/Source checkout entry/.test(help) || !/CLI entry:/.test(help)) throw new Error('installed CLI entry help label is inaccurate');

  fs.writeFileSync(path.join(project, '.gitignore'), '.project-state/\n');
  fs.writeFileSync(path.join(project, '.env'), 'PORT=4101\n');
  fs.writeFileSync(path.join(project, '.nvmrc'), '20\n');
  run('git', ['init'], { cwd: project });
  fs.appendFileSync(path.join(project, '.git', 'info', 'exclude'), '\n.env\n.env.local\n.nvmrc\napp.db\n');
  run('git', ['add', '.gitignore'], { cwd: project });
  run('git', ['-c', 'user.name=install-test', '-c', 'user.email=install-test@example.invalid', 'commit', '-m', 'baseline'], { cwd: project });
  installedCli(['snapshot', 'before']);
  const doctorBefore = treeFingerprint(path.join(project, '.project-state'));
  const doctorOutput = installedCli(['doctor', '--task', 'config-restore', '--snapshot', 'before', '--json']);
  const doctor = JSON.parse(doctorOutput);
  if (doctor.resultSchemaVersion !== 1 || doctor.summary.state !== 'ready' || doctor.nextStep?.command !== 'restore' || doctor.nextStep.args.includes('--yes')) {
    throw new Error('installed task doctor JSON did not report a read-only ready result with a non-authorizing next step');
  }
  if (doctorOutput.includes('4101') || doctorOutput.includes(path.resolve(project))) throw new Error('installed task doctor disclosed private configuration or the project path');
  if (treeFingerprint(path.join(project, '.project-state')) !== doctorBefore) throw new Error('installed task doctor changed project-state bytes or entries');
  const inventoryOutput = installedCli(['list', '--json']);
  const inventory = JSON.parse(inventoryOutput);
  const listedBefore = inventory.snapshots.find((item) => item.name === 'before');
  if (inventory.resultSchemaVersion !== 2 || !listedBefore || listedBefore.state !== 'verified') {
    throw new Error('installed list JSON did not include the validated baseline snapshot');
  }
  const consumerOutput = run(process.execPath, [path.join(installedPackage, 'examples', 'inspect-snapshots.cjs'), 'before'], { cwd: project });
  if (!consumerOutput.includes('Snapshot before: verified;') || !consumerOutput.includes('application health: not-tested')) {
    throw new Error('installed snapshot consumer did not safely report the explicit validated snapshot');
  }
  const detailOutput = installedCli(['show', 'before', '--json']);
  const detailResult = JSON.parse(detailOutput);
  const detail = detailResult.snapshot;
  if (detailResult.resultSchemaVersion !== 2 || detailResult.command !== 'show') throw new Error('installed show JSON result schema mismatch');
  if (detail.state !== 'verified' || detail.generation !== listedBefore.generation || detail.environment.applicationHealth !== 'not-tested') {
    throw new Error('installed show JSON did not return the validated snapshot identity and health boundary');
  }
  if (detailOutput.includes('4101') || detailOutput.includes(path.resolve(project)) || detailOutput.includes('.project-state/secrets')) {
    throw new Error('installed show JSON disclosed private configuration, storage paths, or the project path');
  }
  fs.writeFileSync(path.join(project, '.env'), 'PORT=4102\n');
  const configRestore = installedCli(['restore', 'before', '--only', 'config', '--yes']);
  if (fs.readFileSync(path.join(project, '.env'), 'utf8') !== 'PORT=4101\n') throw new Error('installed CLI failed snapshot/restore bytes verification');
  outputRollback(configRestore);
  if (fs.readFileSync(path.join(project, '.env'), 'utf8') !== 'PORT=4102\n') throw new Error('installed CLI printed rollback did not restore the original config bytes');

  fs.writeFileSync(path.join(project, '.nvmrc'), '22\n');
  fs.writeFileSync(path.join(project, '.env.local'), 'LOCAL=original\n');
  installedCli(['snapshot', 'rollback-preview-before']);
  fs.writeFileSync(path.join(project, '.env'), 'PORT=4103\n');
  fs.unlinkSync(path.join(project, '.env.local'));
  const selective = installedCli(['restore', 'rollback-preview-before', '--only', 'config', '--yes']);
  const rollbackLine = selective.split(/\r?\n/).find((line) => line.includes('--rollback-of'));
  const operationMatch = rollbackLine?.match(/--rollback-of[^a-f0-9]*([a-f0-9]{32})/i);
  const safetyMatch = selective.match(/Verified safety point: ([A-Za-z0-9._-]+) generation ([a-f0-9]{32})/);
  if (!operationMatch || !safetyMatch) throw new Error('installed selective restore omitted rollback or safety identity');
  const preview = installedCli(['restore', safetyMatch[1], '--rollback-of', operationMatch[1], '--dry-run']);
  if (!preview.includes('--rollback-of') || !preview.includes(operationMatch[1]) || !preview.includes('.env.local')) throw new Error('installed rollback preview lost its original operation or file scope');
  fs.writeFileSync(path.join(project, '.nvmrc'), '24\n');
  const previewRollback = previewApply(preview);
  if (!/Verified rollback of operation/.test(previewRollback)) throw new Error('installed printed preview command did not perform the operation rollback');
  if (fs.readFileSync(path.join(project, '.env'), 'utf8') !== 'PORT=4103\n' || fs.existsSync(path.join(project, '.env.local')) || fs.readFileSync(path.join(project, '.nvmrc'), 'utf8') !== '24\n') {
    throw new Error('installed rollback preview command changed files outside its exact target set');
  }
  const originalJournal = JSON.parse(fs.readFileSync(path.join(project, '.project-state', 'operations', `${operationMatch[1]}.json`), 'utf8'));
  if (originalJournal.terminalOutcome !== 'resolved-by-rollback') throw new Error('installed rollback did not resolve the original journal');

  const sqlitePath = process.env.PROJECT_STATE_SQLITE || 'sqlite3';
  const sqliteVersion = run(sqlitePath, ['--version']).trim().split(/\s+/)[0];
  const db = path.join(project, 'app.db');
  run(sqlitePath, [db, 'CREATE TABLE marker (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO marker(value) VALUES (\'installed\');']);
  installedCli(['snapshot', 'seed', '--with-seed']);
  fs.unlinkSync(db);
  const dbRestore = installedCli(['restore', 'seed', '--yes']);
  if (run(sqlitePath, [db, 'SELECT value FROM marker WHERE id=1;']).trim() !== 'installed' || run(sqlitePath, [db, 'PRAGMA integrity_check;']).trim() !== 'ok') {
    throw new Error('installed CLI SQLite seed/restore verification failed');
  }
  outputRollback(dbRestore);
  if (fs.existsSync(db)) throw new Error('installed CLI printed database rollback did not restore target absence');
  console.log(JSON.stringify({ package: `${pkg.name}@${pkg.version}`, files: actual.length, tarballSha256: packHash, tarballPath: retainedTarball, installedCli: 'verified', installedTaskDoctor: 'JSON ready result, redaction, no project-state entry changes', installedSnapshotInspection: 'list/show JSON v2 identity, integrity state, privacy projection verified', installedConsumer: 'explicit-name consumer validates schema and never invokes restore', installedDemo: 'A-to-B-to-A-to-B and exact printed rollback verified', installedRollbackPreview: 'rollback-of preserved; target bytes, untouched file, and original journal verified', packageReadmeLinks: 'all relative targets present', sourceFallback: false, sqliteVersion, snapshotRestoreRollback: 'verified', sqliteSeedRestoreIntegrity: 'verified', sqliteRollback: 'verified' }));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
