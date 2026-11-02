'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const H = require('./helpers');
const Storage = require('../lib/storage');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function directoryEntries(directory) {
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

test('digest-consistent hostile config targets are refused before business or Git mutation', async (t) => {
  for (const hostileTarget of ['../escaped.env', '.git/config']) {
    await t.test(`hostile target ${hostileTarget}`, async (st) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-state-hostile-manifest-'));
      st.after(() => fs.rmSync(root, { recursive: true, force: true }));
      await H.setupGit(root);
      fs.writeFileSync(path.join(root, '.env'), 'API_KEY=synthetic-canary\n');
      H.excludeLocalFiles(root, ['.env']);
      const created = await H.cli(root, ['snapshot', 'baseline']);
      assert.equal(created.status, 0, created.stderr);

      const checked = await Storage.validateSnapshot(root, 'baseline', { mode: 'restore' });
      const publicFile = checked.artifacts.find((item) => item.layer === 'config' && item.kind === 'layer-json');
      const privateFile = checked.artifacts.find((item) => item.layer === 'config' && item.kind === 'file');
      assert.ok(publicFile && privateFile, 'fixture contains its public config projection and private bytes');

      const publicBytes = fs.readFileSync(checked.paths.manifestFile);
      const privateBytes = fs.readFileSync(checked.paths.privateManifestFile);
      const publicManifest = JSON.parse(publicBytes.toString('utf8'));
      const privateManifest = JSON.parse(privateBytes.toString('utf8'));
      const layerPath = path.join(checked.paths.publicGenerationDir, 'files', ...publicFile.path.split('/'));
      const layerData = JSON.parse(fs.readFileSync(layerPath, 'utf8'));
      const configEntry = layerData.envFiles['.env'];
      assert.ok(configEntry, 'fixture config projection includes the private .env');

      // Keep all content hashes and the public pointer consistent while making
      // the author-controlled target violate the restore target allowlist.
      delete layerData.envFiles['.env'];
      layerData.envFiles[hostileTarget] = configEntry;
      const layerBytes = Buffer.from(JSON.stringify(layerData));
      fs.writeFileSync(layerPath, layerBytes);
      publicManifest.artifacts.find((item) => item.id === publicFile.id).sha256 = sha256(layerBytes);
      publicManifest.artifacts.find((item) => item.id === publicFile.id).size = layerBytes.length;
      privateManifest.artifacts.find((item) => item.id === privateFile.id).target = hostileTarget;

      const nextPublicBytes = Buffer.from(JSON.stringify(publicManifest));
      const nextPrivateBytes = Buffer.from(JSON.stringify(privateManifest));
      fs.writeFileSync(checked.paths.manifestFile, nextPublicBytes);
      fs.writeFileSync(checked.paths.privateManifestFile, nextPrivateBytes);
      const pointer = JSON.parse(fs.readFileSync(checked.paths.currentFile, 'utf8'));
      pointer.publicManifestSha256 = sha256(nextPublicBytes);
      fs.writeFileSync(checked.paths.currentFile, JSON.stringify(pointer));

      // Prove this is a self-consistent digest chain, not a stale-checksum case.
      assert.equal(pointer.publicManifestSha256, sha256(fs.readFileSync(checked.paths.manifestFile)));
      for (const [manifest, generationDir] of [
        [publicManifest, checked.paths.publicGenerationDir],
        [privateManifest, checked.paths.privateGenerationDir],
      ]) {
        for (const artifact of manifest.artifacts) {
          if (artifact.kind === 'absent') continue;
          const file = path.join(generationDir, 'files', ...artifact.path.split('/'));
          const bytes = fs.readFileSync(file);
          assert.equal(bytes.length, artifact.size, `${artifact.id} size remains self-consistent`);
          assert.equal(sha256(bytes), artifact.sha256, `${artifact.id} digest remains self-consistent`);
        }
      }

      const gitConfigPath = path.join(root, '.git', 'config');
      const envPath = path.join(root, '.env');
      const before = {
        env: fs.readFileSync(envPath),
        gitConfig: fs.readFileSync(gitConfigPath),
        head: (await H.git(root, ['rev-parse', 'HEAD'])).trim(),
        index: (await H.git(root, ['write-tree'])).trim(),
        refs: (await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(),
        operations: directoryEntries(path.join(root, '.project-state', 'operations')),
        pins: directoryEntries(path.join(root, '.project-state', 'pins')),
      };

      await assert.rejects(
        () => Storage.validateSnapshot(root, 'baseline', { mode: 'restore' }),
        (error) => ['EUNSAFE_PATH', 'EMANIFEST_INVALID'].includes(error.code),
      );
      const refused = await H.cli(root, ['restore', 'baseline', '--yes']);
      assert.equal(refused.status, 1, `${refused.stdout}\n${refused.stderr}`);
      assert.doesNotMatch(refused.stdout + refused.stderr, /synthetic-canary/);
      assert.equal(fs.existsSync(path.join(root, 'escaped.env')), false);
      assert.deepEqual(fs.readFileSync(envPath), before.env, 'business config bytes remain unchanged');
      assert.deepEqual(fs.readFileSync(gitConfigPath), before.gitConfig, 'control-directory bytes remain unchanged');
      assert.equal((await H.git(root, ['rev-parse', 'HEAD'])).trim(), before.head);
      assert.equal((await H.git(root, ['write-tree'])).trim(), before.index);
      assert.equal((await H.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'])).trim(), before.refs);
      assert.deepEqual(directoryEntries(path.join(root, '.project-state', 'operations')), before.operations);
      assert.deepEqual(directoryEntries(path.join(root, '.project-state', 'pins')), before.pins);
    });
  }
});
