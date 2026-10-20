'use strict';
// Tests for: git noise filtering (v1.1).
// Whitelist rule: only advisory lines (warning:/WARN) matching a known
// harmless pattern are dropped, and ONLY on success paths.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { filterNoiseLines } = require('../lib/utils');
const CLI = path.join(__dirname, '..', 'bin', 'project-state.js');

test('filter: CRLF warning lines dropped, real lines kept', () => {
  const input = [
    "warning: in the working copy of 'app.js', LF will be replaced by CRLF the next time Git touches it",
    'warning: the working copy contains 3 modified files',
    'HEAD is now at 9a3696a init',
  ].join('\n');
  const out = filterNoiseLines(input);
  assert.ok(!out.includes('LF will be replaced'), 'crlf notice dropped');
  assert.ok(out.includes('HEAD is now at'), 'real output kept');
  // The second line is advisory in form but does NOT match a whitelist pattern:
  // whitelist means unknown advisories pass through untouched.
  assert.ok(out.includes('the working copy contains'), 'unknown advisory NOT filtered (no blacklist)');
});

test('filter: deprecation advisories dropped, other warnings kept', () => {
  const input = ['npm WARN deprecated lodash@4.17.20: no longer supported', 'warning: some unknown git advisory', 'done'].join('\n');
  const out = filterNoiseLines(input);
  assert.ok(!out.includes('deprecated'), 'deprecation dropped');
  assert.ok(out.includes('unknown git advisory'), 'unknown warning kept');
  assert.ok(out.includes('done'));
});

test('filter: non-advisory lines always pass, even if they mention the words', () => {
  const input = 'error: LF will be replaced by CRLF is configured - fix your .gitattributes';
  const out = filterNoiseLines(input);
  assert.ok(out.includes('error:'), 'error lines are never filtered');
});

test('integration: CLI success output on an autocrlf repo contains no CRLF noise', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pss-noise-'));
  try {
    const { execFile } = require('child_process');
    const git = (args) =>
      new Promise((res, rej) =>
        execFile('git', args, {
          cwd: proj,
          encoding: 'utf8',
          env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
        }, (e, so, se) => (e ? rej(new Error(se)) : res(so)))
      );
    fs.writeFileSync(path.join(proj, 'a.js'), "x('1');\n");
    await git(['init']);
    await git(['add', '-A']);
    await git(['commit', '-m', 'init']);
    const run = (args) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [CLI, ...args], { cwd: proj });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (status) => resolve({ status, out, err }));
      });
    await run(['snapshot', 's1']);
    fs.writeFileSync(path.join(proj, 'a.js'), "x('2');\n");
    await git(['add', '-A']);
    await git(['commit', '-m', 'drift']);
    const r = await run(['restore', 's1', '--yes']);
    assert.strictEqual(r.status, 0, r.err);
    const combined = r.out + r.err;
    assert.ok(!combined.includes('will be replaced by'), 'no CRLF noise in tool output');
    assert.ok(combined.includes('Restore verified'));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
