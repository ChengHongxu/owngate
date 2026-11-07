#!/usr/bin/env node
// Checks the final server image with fresh data and fixture secrets only.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let image = 'owngate/server:smoke';
let build = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--build') build = true;
  else if (arg === '--image' && process.argv[i + 1]) image = process.argv[++i];
  else if (arg === '--help') {
    console.log('Usage: node scripts/deploy-smoke.mjs [--build] [--image IMAGE]');
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

function inContainer(source) {
  return docker(['exec', '--interactive', container, 'node', '--input-type=module'], { input: source });
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      inContainer(`
        const response = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(1000) });
        if (!response.ok || !(await response.json()).ok) process.exit(1);
      `);
      return;
    } catch {
      if (docker(['inspect', '--format', '{{.State.Running}}', container]).trim() !== 'true') {
        throw new Error('Server exited before becoming healthy');
      }
      await delay(250);
    }
  }
  throw new Error('Server did not become healthy within 30 seconds');
}

if (build) {
  docker(['build', '--file', 'apps/server/Dockerfile', '--tag', image, '.'], {
    stdio: 'inherit',
    timeout: 15 * 60_000,
  });
}

const id = randomBytes(8).toString('hex');
const container = `owngate-smoke-${id}`;
const volume = `owngate-smoke-data-${id}`;
const fixtureDir = mkdtempSync(join(tmpdir(), 'owngate-smoke-'));
let volumeCreated = false;
let containerCreated = false;

try {
  for (const name of ['master_key', 'browser_rpc_secret', 'http_runtime_secret']) {
    // These disposable files must be readable by the image's uid 1000.
    writeFileSync(join(fixtureDir, name), randomBytes(32).toString('hex'), { mode: 0o444 });
  }
  docker(['volume', 'create', volume]);
  volumeCreated = true;
  docker([
    'run', '--detach', '--name', container, '--network', 'none', '--read-only',
    '--mount', `type=volume,source=${volume},target=/data`,
    '--mount', `type=bind,source=${join(fixtureDir, 'master_key')},target=/run/secrets/master_key,readonly`,
    '--mount', `type=bind,source=${join(fixtureDir, 'browser_rpc_secret')},target=/run/secrets/browser_rpc_secret,readonly`,
    '--mount', `type=bind,source=${join(fixtureDir, 'http_runtime_secret')},target=/run/secrets/http_runtime_secret,readonly`,
    '--env', 'MASTER_KEY_HEX_FILE=/run/secrets/master_key',
    '--env', 'BROWSER_RPC_SECRET_FILE=/run/secrets/browser_rpc_secret',
    '--env', 'HTTP_RUNTIME_SECRET_FILE=/run/secrets/http_runtime_secret',
    '--env', 'OWNGATE_ORIGIN=http://localhost:3000',
    '--env', 'OWNGATE_RP_ID=localhost',
    '--env', 'LOG_LEVEL=warn',
    image,
  ]);
  containerCreated = true;
  await waitForHealth();
  const cliHelp = docker(['exec', container, 'node', 'apps/cli/dist/bin.js', '--help']);
  if (!cliHelp.includes('vault') || !cliHelp.includes('admin')) throw new Error('Offline maintenance CLI is missing from the server image');
  inContainer(`
    import { getuid } from 'node:process';
    if (getuid() !== 1000) throw new Error('Server must run as uid 1000');
    const page = await fetch('http://127.0.0.1:3000/');
    if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) {
      throw new Error('Built admin UI is not served');
    }
    const html = await page.text();
    const asset = html.match(/src="([^"]+\\.js)"/)?.[1];
    if (!asset || !(await fetch(new URL(asset, 'http://127.0.0.1:3000'))).ok) {
      throw new Error('Built admin asset is missing');
    }
    const initial = await (await fetch('http://127.0.0.1:3000/auth/status')).json();
    if (initial.hasUser !== false) throw new Error('Smoke data must start empty');
    const response = await fetch('http://127.0.0.1:3000/auth/bootstrap', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'smoke-admin', password: 'disposable-smoke-password' }),
    });
    if (!response.ok) throw new Error('Fresh database is not writable');
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('Bootstrap did not create an admin session');
    const connectorResponse = await fetch('http://127.0.0.1:3000/admin/connectors', { headers: { cookie } });
    if (!connectorResponse.ok) throw new Error('Admin connector catalog is unavailable');
    const catalog = await connectorResponse.json();
    for (const id of ['bilibili', 'xiaohongshu', 'zhihu', 'x', 'newapi']) {
      if (!catalog.connectors.some(connector => connector.id === id)) throw new Error('Final connector missing: ' + id);
      if (id === 'newapi') continue;
      const capabilities = await (await fetch('http://127.0.0.1:3000/admin/capabilities?connector_id=' + id, { headers: { cookie } })).json();
      const feed = capabilities.capabilities.find(capability => capability.id === 'feed.list');
      const action = capabilities.capabilities.find(capability => capability.id === 'post.create');
      if (!feed?.output?.properties?.items?.items?.properties?.author) throw new Error('Social feed schema missing: ' + id);
      if (feed.support.status === 'supported') throw new Error('Unverified social feed claimed support: ' + id);
      if (action?.support?.status !== 'disabled') throw new Error('Social publishing executor must remain disabled: ' + id);
    }
  `);
  docker(['restart', container]);
  await waitForHealth();
  inContainer(`
    const status = await (await fetch('http://127.0.0.1:3000/auth/status')).json();
    if (status.hasUser !== true) throw new Error('Admin data did not survive restart');
  `);
  console.log('Server image smoke passed: non-root startup, fresh writable database, admin UI, maintenance CLI, complete unverified social catalog and graceful restart persistence.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (containerCreated) {
    docker(['logs', '--tail', '60', container], { stdio: 'inherit' });
  }
  process.exitCode = 1;
} finally {
  if (containerCreated) docker(['rm', '--force', container]);
  if (volumeCreated) docker(['volume', 'rm', volume]);
  rmSync(fixtureDir, { recursive: true, force: true });
}
