#!/usr/bin/env node
// Build a public deployment archive from an explicit allowlist, never local data.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const numeric = '(?:0|[1-9][0-9]*)';
const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const versionPattern = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?$`);

export function validateVersion(version) {
  if (typeof version !== 'string' || version.trim() !== version || !versionPattern.test(version) || version.length > 128) {
    throw new Error('Version must be SemVer without a v prefix or build metadata, e.g. 0.1.0 or 0.2.0-rc.1.');
  }
  return version;
}

export function normalizeOwner(owner) {
  if (typeof owner !== 'string' || owner.trim() !== owner || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new Error('Owner must be a GitHub user or organization name.');
  }
  return owner.toLowerCase();
}

export async function createReleaseBundle({ version, owner, out }) {
  validateVersion(version);
  const namespace = normalizeOwner(owner);
  if (!out) throw new Error('An output directory is required.');
  const output = resolve(out);
  const require = createRequire(join(root, 'packages/connector-runtime/package.json'));
  const { parse } = require('yaml');
  const compose = parse(await readFile(join(root, 'deploy/docker-compose.yml'), 'utf8'));
  const services = ['server', 'browser', 'http-runtime', 'egress'];
  if (Object.keys(compose.services ?? {}).sort().join(',') !== [...services].sort().join(',')) {
    throw new Error('Unexpected Compose services; update the release image mapping explicitly.');
  }
  for (const name of services) {
    delete compose.services[name].build;
    compose.services[name].image = `ghcr.io/${namespace}/owngate-${name}:${version}`;
    compose.services[name].platform = 'linux/amd64';
  }
  const stem = `owngate-deploy-${version}`;
  const temporary = await mkdtemp(join(tmpdir(), 'owngate-release-'));
  try {
    const bundle = join(temporary, stem);
    await mkdir(bundle);
    // JSON is valid YAML. Keeping the source Compose as the only deployment model
    // preserves network, volume, secret and sandbox settings without text rewrites.
    await writeFile(join(bundle, 'compose.yaml'), JSON.stringify(compose, null, 2) + '\n');
    for (const [source, target] of [['.env.example', '.env.example'], ['nginx.example.conf', 'nginx.example.conf'], ['release-README.md', 'README.md']]) {
      await copyFile(join(root, 'deploy', source), join(bundle, target));
    }
    await mkdir(output, { recursive: true });
    const archiveName = `${stem}.tar.gz`;
    const archivePath = join(output, archiveName);
    execFileSync('tar', ['-czf', archivePath, '-C', temporary, stem], { stdio: 'pipe' });
    const hash = createHash('sha256').update(await readFile(archivePath)).digest('hex');
    await writeFile(join(output, 'SHA256SUMS'), `${hash}  ${archiveName}\n`);
    return { archive: archivePath, checksums: join(output, 'SHA256SUMS') };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === '--help') {
      console.log('Usage: node scripts/release-bundle.mjs --version 0.1.0 --owner OWNER --out out/release');
      return;
    }
    if (!['--version', '--owner', '--out'].includes(flag) || !process.argv[index + 1] || process.argv[index + 1].startsWith('--') || options[flag.slice(2)]) {
      throw new Error(`Unknown, repeated or incomplete argument: ${flag}`);
    }
    options[flag.slice(2)] = process.argv[++index];
  }
  const result = await createReleaseBundle(options);
  console.log(`Created ${result.archive}\nCreated ${result.checksums}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
