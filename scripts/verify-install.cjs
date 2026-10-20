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
function outputRollback(stdout) {
  const label = process.platform === 'win32' ? 'Exact rollback command (PowerShell): ' : 'Exact rollback command: ';
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith(label));
  if (!line) throw new Error('installed CLI omitted the platform rollback command');
  const command = line.slice(label.length);
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
    'package.json', 'LICENSE', 'README.md', 'README.zh-CN.md', 'bin/project-state.js',
    ...fs.readdirSync(path.join(repo, 'lib')).filter((name) => name.endsWith('.js')).map((name) => `lib/${name}`),
  ].sort();
  const actual = (pack.files || []).map((entry) => entry.path.replace(/\\/g, '/')).sort();
  if (pack.version !== pkg.version || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('tarball version or allowlisted file inventory mismatch');

  npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, tgz], temp);
  const version = installedCli(['--version']);
  if (version.trim() !== pkg.version) throw new Error('installed CLI version does not match package metadata');
  installedCli(['--help']);

  fs.writeFileSync(path.join(project, '.gitignore'), '.project-state/\n');
  fs.writeFileSync(path.join(project, '.env'), 'PORT=4101\n');
  run('git', ['init'], { cwd: project });
  fs.appendFileSync(path.join(project, '.git', 'info', 'exclude'), '\n.env\napp.db\n');
  run('git', ['add', '.gitignore'], { cwd: project });
  run('git', ['-c', 'user.name=install-test', '-c', 'user.email=install-test@example.invalid', 'commit', '-m', 'baseline'], { cwd: project });
  installedCli(['snapshot', 'before']);
  fs.writeFileSync(path.join(project, '.env'), 'PORT=4102\n');
  const configRestore = installedCli(['restore', 'before', '--only', 'config', '--yes']);
  if (fs.readFileSync(path.join(project, '.env'), 'utf8') !== 'PORT=4101\n') throw new Error('installed CLI failed snapshot/restore bytes verification');
  outputRollback(configRestore);
  if (fs.readFileSync(path.join(project, '.env'), 'utf8') !== 'PORT=4102\n') throw new Error('installed CLI printed rollback did not restore the original config bytes');

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
  console.log(JSON.stringify({ package: `${pkg.name}@${pkg.version}`, files: actual.length, tarballSha256: packHash, tarballPath: retainedTarball, installedCli: 'verified', sourceFallback: false, sqliteVersion, snapshotRestoreRollback: 'verified', sqliteSeedRestoreIntegrity: 'verified', sqliteRollback: 'verified' }));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
