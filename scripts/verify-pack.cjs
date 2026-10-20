'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const pkg = require('../package.json');
const npmExec = process.env.npm_execpath;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-state-pack-check-'));
let result;
try {
  const command = npmExec ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const args = npmExec ? [npmExec, 'pack', '--dry-run', '--json'] : ['pack', '--dry-run', '--json'];
  result = execFileSync(command, args, {
    cwd: require('node:path').join(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    shell: !npmExec && process.platform === 'win32',
    env: { ...process.env, npm_config_cache: path.join(temp, 'npm-cache') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  console.error('npm pack --dry-run failed');
  fs.rmSync(temp, { recursive: true, force: true });
  process.exit(1);
}
let pack;
try { pack = JSON.parse(result)[0]; } catch {
  console.error('npm pack did not return valid JSON');
  process.exit(1);
}
const files = (pack?.files || []).map(entry => entry.path.replace(/\\/g, '/')).sort();
const root = path.join(__dirname, '..');
const expected = [
  'package.json', 'LICENSE', 'README.md', 'README.zh-CN.md', 'bin/project-state.js',
  ...fs.readdirSync(path.join(root, 'lib')).filter(name => name.endsWith('.js')).map(name => `lib/${name}`),
].sort();
const unexpected = files.filter(p => !expected.includes(p));
const missing = expected.filter(p => !files.includes(p));
if (unexpected.length || missing.length) {
  console.error(JSON.stringify({ unexpected, missing }));
  fs.rmSync(temp, { recursive: true, force: true });
  process.exit(1);
}
console.log(`pack=${pkg.name}@${pkg.version}; files=${files.length}; unexpected=0`);
fs.rmSync(temp, { recursive: true, force: true });
