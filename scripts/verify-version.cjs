'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const runtime = require('../lib/utils');
const contract = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CONTRACTS.md'), 'utf8');
const release = fs.readFileSync(path.join(__dirname, '..', 'docs', 'RELEASE-CANDIDATE.md'), 'utf8');
const revision = Number(contract.match(/^# .*revision (\d+) \(snapshot schema v(\d+)\)/im)?.[1]);
const contractSchema = Number(contract.match(/^# .*revision (\d+) \(snapshot schema v(\d+)\)/im)?.[2]);
if (pkg.version !== runtime.TOOL_VERSION) {
  console.error('package.json and runtime tool versions differ');
  process.exit(1);
}
if (!revision || contractSchema !== runtime.SNAPSHOT_SCHEMA_VERSION) {
  console.error('Contract heading and runtime snapshot schema differ');
  process.exit(1);
}
if (!release.includes(String.fromCharCode(96) + pkg.version + String.fromCharCode(96))) {
  console.error('Release-candidate document does not name the package version');
  process.exit(1);
}
console.log(`version=${pkg.version}; contractRevision=${revision}; snapshotSchema=${runtime.SNAPSHOT_SCHEMA_VERSION}`);
