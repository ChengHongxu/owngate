#!/usr/bin/env node
// Exercises the production BrowserPool and Xvfb with an offline page.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let image = 'owngate/browser:smoke';
let egressImage = 'owngate/egress-proxy:smoke';
let build = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--build') build = true;
  else if (arg === '--egress-image' && process.argv[i + 1]) egressImage = process.argv[++i];
  else if (arg === '--image' && process.argv[i + 1]) image = process.argv[++i];
  else if (arg === '--help') {
    console.log('Usage: node scripts/browser-smoke.mjs [--build] [--image IMAGE] [--egress-image IMAGE]');
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: root, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'], ...options,
  });
}

if (build) {
  docker(['build', '--file', 'services/egress-proxy/Dockerfile', '--tag', egressImage, '.'], { stdio: 'inherit', timeout: 10 * 60_000 });
  docker(['build', '--file', 'apps/browser/Dockerfile', '--tag', image, '.'], {
    stdio: 'inherit', timeout: 15 * 60_000,
  });
}

const id = randomBytes(8).toString('hex');
const container = `owngate-browser-smoke-${id}`;
const volume = `owngate-browser-smoke-profiles-${id}`;
const network = `owngate-browser-smoke-internal-${id}`;
const proxyContainer = `owngate-egress-smoke-${id}`;
const workerContainer = `owngate-browser-shutdown-smoke-${id}`;
const fixtureDir = mkdtempSync(join(tmpdir(), 'owngate-browser-smoke-'));
const secretFile = join(fixtureDir, 'egress_control_secret');
const browserSecretFile = join(fixtureDir, 'browser_rpc_secret');
writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o444 });
writeFileSync(browserSecretFile, randomBytes(32).toString('hex'), { mode: 0o444 });
let volumeCreated = false;
let networkCreated = false;
try {
  docker(['network', 'create', '--internal', network]);
  networkCreated = true;
  docker(['run', '--detach', '--name', proxyContainer, '--network', network, '--network-alias', 'egress', '--read-only',
    '--mount', `type=bind,source=${secretFile},target=/run/secrets/egress_control_secret,readonly`,
    '--env', 'EGRESS_CONTROL_SECRET_FILE=/run/secrets/egress_control_secret', '--env', 'LOG_LEVEL=error', '--entrypoint', 'node', egressImage, '--input-type=module', '--eval', `
      import {readFileSync} from 'node:fs';
      import {PolicyRegistry} from './src/policy.js';
      import {createProxyServer} from './src/main.js';
      const registry=new PolicyRegistry(),revoke=registry.revoke.bind(registry);
      // Observe only the connection id; credentials never leave the registry.
      registry.revoke=(id)=>{revoke(id);console.log('FIXTURE_REVOKED:'+id);};
      createProxyServer({registry,controlSecret:readFileSync('/run/secrets/egress_control_secret','utf8').trim()}).listen(3128,'0.0.0.0');
    `]);
  const proxyDeadline = Date.now() + 15_000;
  while (true) {
    try {
      docker(['exec', proxyContainer, 'node', '-e', "fetch('http://127.0.0.1:3128/health').then(r => {if (!r.ok) process.exit(1)}).catch(() => process.exit(1))"]);
      break;
    } catch { if (Date.now() > proxyDeadline) throw new Error('Egress proxy did not become healthy'); await delay(100); }
  }
  docker(['volume', 'create', volume]);
  volumeCreated = true;
  docker([
    'run', '--detach', '--name', container,
    '--network', network, '--read-only', '--tmpfs', '/tmp', '--shm-size', '1g',
    '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
    '--cap-add', 'SYS_ADMIN', '--cap-add', 'SYS_CHROOT',
    '--mount', `type=volume,source=${volume},target=/profiles`,
    '--mount', `type=bind,source=${secretFile},target=/run/secrets/egress_control_secret,readonly`,
    '--entrypoint', 'node', image, '--input-type=module', '--eval', `
      import { getuid } from 'node:process';
      import { existsSync, readFileSync } from 'node:fs';
      import http from 'node:http';
      import { setTimeout as delay } from 'node:timers/promises';
      import { BrowserPool, XvfbManager, EgressController, ProxyCredentialStore } from './packages/browser-runtime/dist/index.js';
      if (getuid() !== 1000) throw new Error('Browser must run as uid 1000');
      const credentials = new ProxyCredentialStore();
      const proxyServer = 'http://egress:3128';
      const controller = new EgressController({ baseUrl: proxyServer, secret: readFileSync('/run/secrets/egress_control_secret', 'utf8').trim() }, credentials, async id => { await pool.get(id)?.context.close(); });
      const pool = new BrowserPool(new XvfbManager(), '/profiles', { proxy: { proxyServer, credentials, authorize: id => controller.ensure(id) } });
      const proxyCode = (auth) => new Promise((accept, reject) => {
        const request = http.request(proxyServer, { path: 'http://127.0.0.1:3000/fixture', headers: { 'Proxy-Authorization': auth } }, response => { response.resume(); response.on('end', () => accept(response.statusCode)); });
        request.on('error', reject); request.setTimeout(2000, () => request.destroy(new Error('proxy timeout'))); request.end();
      });
      const initialAuth = credentials.basicAuth('offline-smoke');
      const navigateDenied = async (page, address, expected) => {
        try { if ((await page.goto(address))?.status() !== expected) throw new Error('unexpected HTTP status'); }
        catch (error) { if (!/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_INVALID_AUTH_CREDENTIALS/.test(String(error))) throw error; }
      };
      if (await proxyCode(initialAuth) !== 407) throw new Error('Unregistered proxy credentials were accepted');
      controller.configure('offline-smoke', { strict: false, allowed_domains: [] });
      try {
        let entry = await pool.acquire('offline-smoke');
        let page = entry.context.pages()[0] ?? await entry.context.newPage();
        if (await proxyCode(credentials.basicAuth('offline-smoke')) !== 403) throw new Error('Registered proxy did not apply SSRF blocking');
        await navigateDenied(page, 'http://127.0.0.1:3000/blocked', 403);
        await controller.revoke('offline-smoke');
        if (await proxyCode(initialAuth) !== 407) throw new Error('Revoked credentials still work');
        await navigateDenied(page, 'http://127.0.0.1:3000/revoked', 407);
        await pool.close('offline-smoke');
        controller.configure('offline-smoke', { strict: false, allowed_domains: [] });
        entry = await pool.acquire('offline-smoke');
        page = entry.context.pages()[0] ?? await entry.context.newPage();
        let directEscaped = false;
        try { await fetch('http://1.1.1.1', { signal: AbortSignal.timeout(500) }); directEscaped = true; } catch {}
        if (directEscaped) throw new Error('Browser container has direct internet access');
        await page.setContent('<!doctype html><h1>owngate-sandbox-smoke</h1>');
        if (await page.locator('h1').textContent() !== 'owngate-sandbox-smoke') {
          throw new Error('Production headed browser did not render the offline page');
        }
        const cdp = await entry.context.newCDPSession(page);
        let frameTimeout;
        const frame = new Promise((accept, reject) => {
          frameTimeout = setTimeout(() => reject(new Error('No CDP screencast frame')), 5000);
          cdp.on('Page.screencastFrame', (event) => {
            cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
            if (event.data.length > 0) accept(event);
          });
        });
        try {
          await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85 });
          await frame;
        } finally {
          clearTimeout(frameTimeout);
          await cdp.send('Page.stopScreencast').catch(() => {});
          await cdp.detach();
        }
        console.log('BROWSER_RENDERING_READY');
        const deadline = Date.now() + 30_000;
        while (!existsSync('/tmp/smoke-release')) {
          if (Date.now() > deadline) throw new Error('Host did not finish inspecting renderer processes');
          await delay(100);
        }
        let refused = false;
        try { await pool.acquire('offline-smoke'); } catch { refused = true; }
        if (!refused || pool.get('offline-smoke')) throw new Error('Unavailable control plane did not close the browser');
      } finally {
        await pool.closeAll();
        await controller.close();
      }
    `,
  ]);
  const deadline = Date.now() + 30_000;
  while (!docker(['logs', container]).includes('BROWSER_RENDERING_READY')) {
    if (docker(['inspect', '--format', '{{.State.Running}}', container]).trim() !== 'true') {
      throw new Error('Browser exited before rendering the offline page');
    }
    if (Date.now() > deadline) throw new Error('Browser did not become ready within 30 seconds');
    await delay(250);
  }
  // Sandboxed processes may deliberately hide /proc/cmdline from their parent.
  // Docker inspects them from outside their user namespace without relaxing it.
  const rows = docker(['top', container, '-eo', 'pid,uid,args', '-ww']).split('\n');
  const renderers = rows.filter((row) => row.trim().split(/\s+/).includes('--type=renderer'));
  if (renderers.length === 0) throw new Error('No renderer process could be inspected');
  for (const renderer of renderers) {
    const columns = renderer.trim().split(/\s+/);
    if (columns[1] !== '1000') throw new Error('Renderer is not uid 1000');
    if (columns.includes('--no-sandbox')) throw new Error('Renderer has --no-sandbox');
  }
  docker(['stop', '--time', '2', proxyContainer]);
  docker(['exec', container, 'node', '-e', "require('node:fs').writeFileSync('/tmp/smoke-release', '')"]);
  const exitCode = docker(['wait', container]).trim();
  if (exitCode !== '0') throw new Error(`Browser check exited with ${exitCode}`);
  docker(['start', proxyContainer]);
  docker(['run', '--detach', '--name', workerContainer, '--network', network, '--read-only', '--tmpfs', '/tmp', '--shm-size', '1g',
    '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL', '--cap-add', 'SYS_ADMIN', '--cap-add', 'SYS_CHROOT',
    '--mount', `type=volume,source=${volume},target=/profiles`,
    '--mount', `type=bind,source=${secretFile},target=/run/secrets/egress_control_secret,readonly`,
    '--mount', `type=bind,source=${browserSecretFile},target=/run/secrets/browser_rpc_secret,readonly`,
    '--env', 'BROWSER_RPC_SECRET_FILE=/run/secrets/browser_rpc_secret', '--env', 'EGRESS_CONTROL_SECRET_FILE=/run/secrets/egress_control_secret',
    '--env', 'BROWSER_EGRESS_PROXY=http://egress:3128', '--env', 'BROWSER_PROFILES_DIR=/profiles', image]);
  const healthyWorker = async () => {
    const deadline = Date.now() + 20_000;
    while (true) {
      try { docker(['exec', workerContainer, 'node', '-e', "fetch('http://127.0.0.1:4000/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]); return; }
      catch { if (Date.now() > deadline) throw new Error('Production browser main did not become healthy'); await delay(100); }
    }
  };
  await healthyWorker();
  const setupWorker = `
    import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
    import {signRequest} from './packages/browser-runtime/dist/index.js';
    const secret=readFileSync('/run/secrets/browser_rpc_secret','utf8').trim();
    const call=async(path,input)=>{const body=JSON.stringify(input),response=await fetch('http://127.0.0.1:4000'+path,{method:'POST',headers:{'content-type':'application/json',...signRequest(body,secret,{method:'POST',path})},body});assert(response.ok);return response.json();};
    assert.deepEqual(await (await fetch('http://127.0.0.1:4000/v1/health')).json(),{browsers:[]});
    await call('/v1/session/open',{connection_id:'shutdown-smoke',egress_policy:{strict:false,allowed_domains:[]}});
    const imported=await call('/v1/cookies/import',{connection_id:'shutdown-smoke',cookies:[{name:'owngate-smoke-persist',value:'fixture-cookie',domain:'example.invalid',path:'/',expires:Math.floor(Date.now()/1000)+3600}],success_when:[{type:'cookie',name:'owngate-smoke-persist',domain:'example.invalid'}]});
    assert.equal(imported.logged_in,true,'synthetic cookie must exist in the live Chromium context before shutdown');
    assert.equal((await (await fetch('http://127.0.0.1:4000/v1/health')).json()).browsers.length,1);
  `;
  docker(['exec', '--interactive', workerContainer, 'node', '--input-type=module'], { input: setupWorker });
  docker(['stop', '--time', '15', workerContainer]);
  if (docker(['inspect', '--format', '{{.State.ExitCode}}', workerContainer]).trim() !== '0') throw new Error('SIGTERM did not close production browser main cleanly');
  if (!docker(['logs', proxyContainer]).includes('FIXTURE_REVOKED:shutdown-smoke')) throw new Error('Browser shutdown did not revoke its live egress lease');
  docker(['run', '--rm', '--network', 'none', '--read-only', '--mount', `type=volume,source=${volume},target=/profiles,readonly`, '--entrypoint', 'node', image, '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync('/profiles/shutdown-smoke/Default/Cookies',{readOnly:true});
    const cookie=db.prepare('SELECT host_key,name,is_persistent FROM cookies WHERE name=?').get('owngate-smoke-persist');
    assert.deepEqual({...cookie},{host_key:'example.invalid',name:'owngate-smoke-persist',is_persistent:1});db.close();
  `]);
  docker(['start', workerContainer]);
  await healthyWorker();
  docker(['exec', '--interactive', workerContainer, 'node', '--input-type=module'], { input: setupWorker });
  docker(['stop', '--time', '15', workerContainer]);
  if (docker(['inspect', '--format', '{{.State.ExitCode}}', workerContainer]).trim() !== '0') throw new Error('Restarted browser did not shut down cleanly');
  console.log('Browser + egress smoke passed: production headed Chromium, sandbox/non-root/CDP, real credential registration/revocation, loopback SSRF blocking, internal network and control-plane fail closed, actual main SIGTERM/restart with persistent cookie profile and egress revocation.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  try { docker(['logs', '--tail', '60', container], { stdio: 'inherit' }); } catch { /* run may have failed */ }
  try { docker(['logs', '--tail', '60', workerContainer], { stdio: 'inherit' }); } catch {}
  process.exitCode = 1;
} finally {
  // Also handles a timed-out docker client leaving the container running.
  try { docker(['rm', '--force', container]); } catch { /* --rm may already have removed it */ }
  try { docker(['rm', '--force', workerContainer]); } catch {}
  try { docker(['rm', '--force', proxyContainer]); } catch {}
  if (volumeCreated) docker(['volume', 'rm', volume]);
  if (networkCreated) docker(['network', 'rm', network]);
  rmSync(fixtureDir, { recursive: true, force: true });
}
