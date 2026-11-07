import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { createReleaseBundle, normalizeOwner, validateVersion } from './release-bundle.mjs';

test('release versions and owner names cannot inject paths, commands or mutable tags', () => {
  for (const version of ['0.1.0', '1.2.3-rc.1', '10.20.30-beta-2']) assert.equal(validateVersion(version), version);
  for (const version of [undefined, '', 'v0.1.0', '01.2.3', '1.2', '1.2.3-01', 'latest', '1.2.3+build.1', '../1.2.3', '1.2.3\n']) assert.throws(() => validateVersion(version));
  assert.equal(normalizeOwner('OwnGate-Team'), 'owngate-team');
  for (const owner of [undefined, '', '../user', '-user', 'user-', 'user/repo', 'user;echo']) assert.throws(() => normalizeOwner(owner));
});

test('archive includes only deployment files and pins all four images without source builds', async () => {
  const out = await mkdtemp(join(tmpdir(), 'owngate-bundle-test-'));
  try {
    const { archive, checksums } = await createReleaseBundle({ version: '0.2.0-rc.1', owner: 'OwnGate-Team', out });
    const prefix = 'owngate-deploy-0.2.0-rc.1';
    const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').filter(path => !path.endsWith('/')).sort();
    assert.deepEqual(files, ['.env.example', 'README.md', 'compose.yaml', 'nginx.example.conf', 'install.sh'].map(name => `${prefix}/${name}`).sort());
    const compose = JSON.parse(execFileSync('tar', ['-xOzf', archive, `${prefix}/compose.yaml`], { encoding: 'utf8' }));
    assert.deepEqual(Object.keys(compose.services).sort(), ['browser', 'egress', 'http-runtime', 'server']);
    for (const [name, service] of Object.entries(compose.services)) {
      assert.equal(service.image, `ghcr.io/owngate-team/owngate-${name}:0.2.0-rc.1`);
      assert.equal(service.platform, 'linux/amd64');
      assert.equal('build' in service, false);
    }
    assert.equal(compose.networks.internal.internal, true);
    assert.deepEqual(compose.services.browser.networks, ['internal']);
    assert.equal(compose.services.server.environment.DB_PATH, '/data/owngate.db');
    assert.equal(compose.secrets.master_key.file, './secrets/master_key');
    assert.ok(compose.volumes['server-data']);
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    const installerDigest = createHash('sha256').update(await readFile(join(out, 'install.sh'))).digest('hex');
    assert.equal(await readFile(checksums, 'utf8'), `${digest}  ${basename(archive)}\n${installerDigest}  install.sh\n`);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
