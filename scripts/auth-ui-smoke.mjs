#!/usr/bin/env node
// Real Web UI, Fastify/SQLite, TOTP and WebAuthn cryptography on loopback only.
// The Chromium virtual authenticator substitutes for a physical Passkey device.
// All credentials are generated for this run; only masked screenshots and safe
// metadata survive cleanup. Run `pnpm build` before invoking this script.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let output;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out' && process.argv[i + 1]) output = resolve(process.argv[++i]);
  else if (process.argv[i] === '--help') {
    console.log('Usage: node scripts/auth-ui-smoke.mjs [--out SCREENSHOT_DIRECTORY]');
    console.log('Default output: out/ui/auth-<run>/ (masked screenshots and report.json)');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${process.argv[i]}`);
}
if (output === undefined) {
  const outputRoot = join(root, 'out/ui');
  await mkdir(outputRoot, { recursive: true });
  output = await mkdtemp(join(outputRoot, 'auth-'));
}
await mkdir(output, { recursive: true });

const username = 'auth-ui-smoke';
const renamedUsername = 'auth-ui-smoke-renamed';
const password = randomBytes(24).toString('base64url');
const replacementPassword = randomBytes(24).toString('base64url');
const incorrectPassword = randomBytes(24).toString('base64url');
const secrets = new Set([password, replacementPassword, incorrectPassword]);
const sanitize = value => {
  let text = String(value);
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
  return text;
};
const report = {
  status: 'running',
  source: 'real buildServer, temporary SQLite, Vite, Chromium CDP virtual authenticator; loopback only',
  checks: [], screenshots: [], requests: [], browserErrors: [], externalRequests: [],
  totpQr: { decoder: 'jsQR; actual Chromium-rendered SVG screenshot pixels', decodedEnrollments: 0, confirmedEnrollments: 0 },
};
let stage = 'start';
let temporary, vite, backend, browser, context, page, decodeQr;
const responseReads = [];
const proxyServers = [];

async function check(name, action) {
  stage = name;
  await action();
  report.checks.push(name);
}
async function screenshot(name) {
  const filename = `${name}.png`;
  await page.screenshot({ path: join(output, filename), fullPage: true, animations: 'disabled',
    mask: [page.locator('input[type="password"]:visible, input[autocomplete="one-time-code"]:visible, code.secret:visible, .totp-qr:visible')],
  });
  report.screenshots.push(filename);
}
async function navigateSettings(section) {
  const menu = page.getByRole('button', { name: '打开导航', exact: true });
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
  await page.locator('.nav').getByRole('link', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  await page.getByRole('navigation', { name: '设置分类', exact: true }).getByRole('link', { name: section, exact: true }).click();
}
async function navigateSecurity() {
  await navigateSettings('安全');
  await page.getByRole('heading', { name: '安全设置', exact: true }).waitFor();
}
async function responseFor(path, status, action) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === path && response.status() === status);
  await action();
  return pending;
}
// This bypasses the UI's automatic retry/prompt only for negative boundary checks.
// The request still travels through Vite to the real routes and session cookie.
async function api(path, body) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'include',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = await response.json();
    return { status: response.status, code: data.code ?? data.error?.code, ...(path === '/auth/status' ? { auth: data } : {}) };
  }, { path, body });
}
async function readEnrollment() {
  const qr = page.getByRole('img', { name: 'TOTP 绑定二维码', exact: true });
  await qr.waitFor();
  const manual = page.locator('details').filter({ has: page.getByText('无法扫码？手动添加', { exact: true }) });
  assert.equal(await manual.evaluate(element => element.open), false, 'manual setup must be collapsed before the user requests it');
  await manual.getByText('无法扫码？手动添加', { exact: true }).click();
  const secret = await page.locator('code.secret').first().textContent();
  assert(secret && /^[A-Z2-7]{32}$/.test(secret), 'a real TOTP seed must be displayed');
  secrets.add(secret);
  const url = await page.locator('code.secret').nth(1).textContent();
  assert(url, 'manual setup must retain the complete otpauth URL');
  secrets.add(url);

  // Only this in-memory screenshot contains an unmasked, randomly generated
  // enrollment QR. Decode the actual rendered pixels with an independent
  // decoder; never persist its PNG, pixel array or decoded credential.
  const png = await qr.screenshot({ animations: 'disabled' });
  const image = await page.evaluate(async encoded => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('QR pixel canvas is unavailable');
    context.drawImage(bitmap, 0, 0); bitmap.close();
    return { width: canvas.width, height: canvas.height,
      pixels: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data) };
  }, png.toString('base64'));
  const decoded = decodeQr(new Uint8ClampedArray(image.pixels), image.width, image.height);
  assert(decoded && typeof decoded.data === 'string', 'the visible TOTP QR must decode from actual browser pixels');
  secrets.add(decoded.data);
  assert(decoded.data === url, 'the scanned QR must contain the exact manual otpauth URL');
  const scanned = new URL(decoded.data);
  assert.equal(scanned.protocol, 'otpauth:');
  assert.equal(scanned.hostname, 'totp');
  assert.equal(scanned.searchParams.get('issuer'), 'OwnGate');
  assert.equal(decodeURIComponent(scanned.pathname.slice(1)), `OwnGate:${username}`);
  assert.equal(scanned.searchParams.get('algorithm'), 'SHA1');
  assert.equal(scanned.searchParams.get('digits'), '6');
  assert.equal(scanned.searchParams.get('period'), '30');
  const scannedSecret = scanned.searchParams.get('secret');
  assert(scannedSecret === secret, 'the scanned seed must match the manual setup seed');
  report.totpQr.decodedEnrollments++;
  await manual.getByText('无法扫码？手动添加', { exact: true }).click();
  // All subsequent real TOTP confirmations use the independently scanned seed.
  return scannedSecret;
}

async function assertEnrollmentRemoved() {
  assert.equal(await page.getByRole('img', { name: 'TOTP 绑定二维码', exact: true }).count(), 0,
    'the completed or cancelled enrollment must remove its QR');
  assert.equal(await page.locator('code.secret').count(), 0, 'the enrollment seed and URL must be removed with its QR');
}

try {
  temporary = await mkdtemp(join(tmpdir(), 'owngate-auth-ui-db-'));
  const connectorsDir = join(temporary, 'connectors');
  await mkdir(connectorsDir);
  // Ignore inherited deployment configuration and never open a user's database.
  Object.assign(process.env, { NODE_ENV: 'test', VITEST: '1', DEV_SKIP_AUTH: '0', LOG_LEVEL: 'silent',
    MASTER_KEY_HEX: randomBytes(32).toString('hex'), WEB_ROOT: '', OWNGATE_RP_ID: 'localhost',
    HTTP_RUNTIME_URL: '', HTTP_BROKER_ORIGIN: '', BROWSER_RPC_URL: 'http://127.0.0.1:1',
    BROWSER_RPC_SECRET: randomBytes(32).toString('hex'), HTTP_RUNTIME_SECRET: randomBytes(32).toString('hex'),
  });
  const webRequire = createRequire(join(root, 'apps/web/package.json'));
  const browserRequire = createRequire(join(root, 'apps/browser/package.json'));
  decodeQr = webRequire('jsqr');
  const { createServer } = await import(pathToFileURL(join(dirname(webRequire.resolve('vite/package.json')), 'dist/node/index.js')).href);
  const { chromium } = browserRequire('playwright');
  // Listen first to get an exact WebAuthn origin without reserving a fixed port.
  // Each proxy receives its real loopback target before the browser is launched.
  const proxy = Object.fromEntries(['/admin', '/auth', '/api', '/ws'].map(path => [path, {
    target: 'http://127.0.0.1:1', ws: path === '/ws', configure: instance => proxyServers.push(instance),
  }]));
  vite = await createServer({ root: join(root, 'apps/web'), configFile: join(root, 'apps/web/vite.config.ts'), cacheDir: join(temporary, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, proxy }, logLevel: 'error',
  });
  await vite.listen();
  const address = vite.httpServer.address();
  assert(address && typeof address !== 'string');
  const origin = `http://localhost:${address.port}`;
  process.env.OWNGATE_ORIGIN = origin;
  const { buildServer } = await import(pathToFileURL(join(root, 'apps/server/dist/main.js')).href);
  const { totpAt } = await import(pathToFileURL(join(root, 'apps/server/dist/auth/totp.js')).href);
  const code = secret => { const value = totpAt(secret, Math.floor(Date.now() / 1000)); secrets.add(value); return value; };
  backend = await buildServer({ dbPath: join(temporary, 'auth.sqlite'), connectorsDir });
  const backendOrigin = await backend.app.listen({ port: 0, host: '127.0.0.1' });
  for (const instance of proxyServers) instance.options.target = backendOrigin;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => report.browserErrors.push(sanitize(error.stack ?? error.message)));
  page.on('response', response => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/auth/') && !url.pathname.startsWith('/admin/')) return;
    const entry = { method: response.request().method(), path: url.pathname, status: response.status() };
    report.requests.push(entry);
    if (response.status() >= 400) responseReads.push(response.json().then(data => {
      const value = data.code ?? data.error?.code;
      if (typeof value === 'string' && /^[A-Z_]+$/.test(value)) entry.code = value;
    }).catch(() => undefined));
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    report.externalRequests.push(`${url.protocol}//${url.hostname}${url.pathname}`);
    return route.abort();
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  const dialog = page.getByRole('dialog');
  let user, originalSeed, originalBlob, replacementSeed, registeredCounter;

  await check('real bootstrap and authenticated session', async () => {
    await page.goto(origin);
    await page.getByRole('heading', { name: '创建管理员', exact: true }).waitFor();
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码（至少 8 位）', { exact: true }).fill(password);
    await page.getByLabel('再输一次', { exact: true }).fill(password);
    await responseFor('/auth/bootstrap', 201, () => page.getByRole('button', { name: '创建并登录', exact: true }).click());
    await page.getByRole('heading', { name: '概览', exact: true }).waitFor();
    user = await backend.db.getAdminByUsername(username);
    assert(user, 'bootstrap must persist an admin');
    const session = (await context.cookies(origin)).find(cookie => cookie.name === 'og_session');
    assert(session?.httpOnly && session.sameSite === 'Strict', 'the session cookie must be HttpOnly and Strict');
    secrets.add(session.value);
    await navigateSecurity();
  });

  await check('real overview endpoint returns data through the configured Vite proxy', async () => {
    const overview = await page.evaluate(async () => {
      const response = await fetch('/admin/overview', { credentials: 'include' });
      const data = await response.json();
      return { status: response.status, connections: Array.isArray(data.connections) ? data.connections.length : null,
        tasks: Array.isArray(data.tasks) ? data.tasks.length : null, alerts: Array.isArray(data.alerts) ? data.alerts.length : null,
        pendingProposals: data.pending_proposals, actionsEnabled: data.actions_enabled };
    });
    assert.deepEqual(overview, { status: 200, connections: 0, tasks: 0, alerts: 0, pendingProposals: 0, actionsEnabled: false });
    report.overview = overview;
  });

  await check('first MFA requires separate password proof; proof cannot authorize sensitive operations', async () => {
    await page.getByRole('button', { name: '启用 TOTP', exact: true }).click();
    await dialog.getByText('确认首次配置', { exact: true }).waitFor();
    assert(await dialog.getByLabel('当前密码', { exact: true }).isVisible());
    assert.equal(await dialog.getByLabel('TOTP 验证码', { exact: true }).count(), 0);
    await screenshot('01-first-mfa-password-proof');
    await dialog.getByLabel('当前密码', { exact: true }).fill(incorrectPassword);
    await responseFor('/auth/mfa/setup', 401, () => dialog.getByRole('button', { name: '确认密码', exact: true }).click());
    assert.equal((await backend.db.getAdminById(user.id)).totp_enabled, false);
    await dialog.getByLabel('当前密码', { exact: true }).fill(password);
    await responseFor('/auth/totp/enroll', 200, () => dialog.getByRole('button', { name: '确认密码', exact: true }).click());
    originalSeed = await readEnrollment();
    assert.equal(await backend.db.getTotpSecret(user.id), undefined, 'a pending seed must not be persisted');
    const denied = await api('/admin/clients', { label: 'must-not-be-created' });
    assert.deepEqual(denied, { status: 403, code: 'STEP_UP_REQUIRED' });
    assert.equal((await api('/auth/status')).auth.stepUp, false);
    await screenshot('02-totp-enrollment-masked');
    await page.getByLabel('App 显示的验证码', { exact: true }).fill(code(originalSeed));
    await responseFor('/auth/totp/confirm', 200, () => page.getByRole('button', { name: '确认启用', exact: true }).click());
    await page.getByRole('button', { name: '重新绑定（换手机）', exact: true }).waitFor();
    await assertEnrollmentRemoved();
    report.totpQr.confirmedEnrollments++;
    originalBlob = await backend.db.getTotpSecret(user.id);
    assert(originalBlob?.ciphertext.startsWith('og2:'), 'the confirmed seed must use encrypted vault storage');
    assert(backend.vault.decryptJSON(originalBlob, ['totp', user.id, 'secret']).secretBase32 === originalSeed,
      'the encrypted seed must match the confirmed authenticator');
  });

  await check('TOTP-only step-up requires both password and code; real Passkey registration', async () => {
    const missing = await api('/auth/step-up/totp', { code: code(originalSeed) });
    assert.equal(missing.status, 400, 'the route must reject a code without a password');
    await page.getByRole('button', { name: '注册新 Passkey', exact: true }).click();
    await dialog.getByText('需要二次验证', { exact: true }).waitFor();
    assert(await dialog.getByLabel('当前密码', { exact: true }).evaluate(input => input.required));
    assert(await dialog.getByLabel('TOTP 验证码', { exact: true }).evaluate(input => input.required));
    assert.equal(await dialog.getByRole('button', { name: '用 Passkey 验证', exact: true }).count(), 0);
    await screenshot('03-password-and-totp-step-up');
    await dialog.getByLabel('当前密码', { exact: true }).fill(incorrectPassword);
    await dialog.getByLabel('TOTP 验证码', { exact: true }).fill(code(originalSeed));
    await responseFor('/auth/step-up/totp', 401, () => dialog.getByRole('button', { name: '用验证码验证', exact: true }).click());
    assert.equal((await api('/auth/status')).auth.stepUp, false);
    await dialog.getByLabel('当前密码', { exact: true }).fill(password);
    await dialog.getByLabel('TOTP 验证码', { exact: true }).fill(code(originalSeed));
    await responseFor('/auth/passkeys/register/finish', 201, () => dialog.getByRole('button', { name: '用验证码验证', exact: true }).click());
    const credentials = await backend.db.listWebauthnCredentials(user.id);
    assert.equal(credentials.length, 1, 'real server verification must persist exactly one public key');
    assert(Buffer.from(credentials[0].public_key, 'base64').length > 32, 'the server must persist a real COSE public key');
    registeredCounter = credentials[0].counter;
    // CDP also returns a private key: retain only comparisons/counters, never serialize it.
    const virtual = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    assert.equal(virtual.credentials.length, 1);
    assert(Buffer.from(virtual.credentials[0].credentialId, 'base64').toString('base64url') === credentials[0].credential_id,
      'the browser authenticator and server must share the same real credential');
    await page.reload();
    await page.getByRole('heading', { name: '安全设置', exact: true }).waitFor();
    await navigateSecurity();
    await page.getByRole('button', { name: '删除', exact: true }).waitFor();
    const status = (await api('/auth/status')).auth;
    assert.equal(status.passkeyCount, 1);
    assert.equal(status.stepUp, false, 'credential changes must invalidate the previous TOTP proof');
    await screenshot('04-real-passkey-registered');
  });

  await check('existing Passkey requires Passkey-only step-up; no TOTP downgrade', async () => {
    const denied = await api('/auth/step-up/totp', { password, code: code(originalSeed) });
    assert.deepEqual(denied, { status: 403, code: 'PASSKEY_REQUIRED' });
    await page.getByRole('button', { name: '重新绑定（换手机）', exact: true }).click();
    await dialog.getByRole('button', { name: '用 Passkey 验证', exact: true }).waitFor();
    assert.equal(await dialog.locator('input').count(), 0, 'no password/TOTP fallback may appear for an existing Passkey');
    assert.equal(await dialog.getByRole('button', { name: '用验证码验证', exact: true }).count(), 0);
    await screenshot('05-passkey-only-step-up');
    await responseFor('/auth/totp/enroll', 200, () => dialog.getByRole('button', { name: '用 Passkey 验证', exact: true }).click());
    await readEnrollment();
    const active = await backend.db.getTotpSecret(user.id);
    assert(active.ciphertext === originalBlob.ciphertext, 'pending rebind must keep the old TOTP seed active');
    const credential = (await backend.db.listWebauthnCredentials(user.id))[0];
    assert(credential.counter > registeredCounter, 'a verified real assertion must advance the server counter');
    await page.getByRole('button', { name: '取消绑定', exact: true }).click();
    await assertEnrollmentRemoved();
  });

  await check('password + Passkey recovery login works without a TOTP code; no premature session', async () => {
    await page.getByRole('button', { name: '退出', exact: true }).click();
    await page.getByRole('heading', { name: '登录后台', exact: true }).waitFor();
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await responseFor('/auth/login', 401, () => page.getByRole('button', { name: '登录', exact: true }).click());
    await page.getByLabel('TOTP 验证码', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('TOTP 验证码', { exact: true }).inputValue(), '');
    assert.equal((await api('/auth/status')).auth.authenticated, false);
    await screenshot('06-lost-totp-login');
    // Hold only the real assertion POST to inspect the intermediate state. Its
    // body and eventual response pass through unchanged to the real server.
    const assertionReady = Promise.withResolvers();
    const releaseAssertion = Promise.withResolvers();
    await page.route('**/auth/login/passkey/finish', async route => {
      assertionReady.resolve();
      await releaseAssertion.promise;
      await route.continue();
    }, { times: 1 });
    const finish = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/login/passkey/finish' && response.status() === 200);
    try {
      await responseFor('/auth/login/passkey/begin', 200, () => page.getByRole('button', { name: '用密码 + Passkey 登录', exact: true }).click());
      await Promise.race([assertionReady.promise, finish]);
      assert(!(await context.cookies(origin)).some(cookie => cookie.name === 'og_session'), 'a password-checked ticket must not create a session');
      const flow = (await context.cookies(`${origin}/auth/login/passkey/finish`)).find(cookie => cookie.name === 'og_login_flow');
      assert(flow?.httpOnly && flow.sameSite === 'Strict' && flow.path === '/auth/login/passkey', 'the recovery ticket must be bound to an HttpOnly browser-flow cookie');
      secrets.add(flow.value);
    } finally { releaseAssertion.resolve(); }
    await finish;
    await page.locator('.app-shell').waitFor();
    const cookies = await context.cookies(origin);
    const session = cookies.find(cookie => cookie.name === 'og_session');
    assert(session?.httpOnly && session.sameSite === 'Strict');
    secrets.add(session.value);
    assert(!cookies.some(cookie => cookie.name === 'og_login_flow'), 'the one-use browser-flow cookie must be cleared');
    const status = (await api('/auth/status')).auth;
    assert(status.authenticated && status.stepUp && status.totpEnabled && status.passkeyCount === 1);
    await navigateSecurity();
    await screenshot('07-passkey-recovery-session');
  });

  await check('recovery session can rebind lost TOTP; new credential invalidates prior proofs', async () => {
    await responseFor('/auth/totp/enroll', 200, () => page.getByRole('button', { name: '重新绑定（换手机）', exact: true }).click());
    replacementSeed = await readEnrollment();
    assert(replacementSeed !== originalSeed, 'recovery must generate a fresh seed');
    assert((await backend.db.getTotpSecret(user.id)).ciphertext === originalBlob.ciphertext,
      'the original seed remains active until replacement confirmation');
    await page.getByLabel('App 显示的验证码', { exact: true }).fill(code(replacementSeed));
    await responseFor('/auth/totp/confirm', 200, () => page.getByRole('button', { name: '确认启用', exact: true }).click());
    await page.getByRole('button', { name: '重新绑定（换手机）', exact: true }).waitFor();
    await assertEnrollmentRemoved();
    report.totpQr.confirmedEnrollments++;
    const replacement = await backend.db.getTotpSecret(user.id);
    assert(backend.vault.decryptJSON(replacement, ['totp', user.id, 'secret']).secretBase32 === replacementSeed,
      'the new seed must replace the encrypted persisted secret');
    assert.equal((await api('/auth/status')).auth.stepUp, false);
    await page.reload();
    await page.getByRole('heading', { name: '安全设置', exact: true }).waitFor();
    await navigateSecurity();
    await page.getByRole('button', { name: '重新绑定（换手机）', exact: true }).click();
    await dialog.getByRole('button', { name: '用 Passkey 验证', exact: true }).waitFor();
    assert.equal(await dialog.locator('input').count(), 0);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await screenshot('08-recovered-security-settings');
  });

  await check('real account rename validates password and Passkey, revokes all sessions, then logs in with the new name', async () => {
    await navigateSettings('账户');
    await page.getByRole('heading', { name: '账户信息', exact: true }).waitFor();
    const oldSession = (await context.cookies(origin)).find(cookie => cookie.name === 'og_session');
    assert(oldSession, 'the existing recovery session must be available before a rename');
    secrets.add(oldSession.value);
    assert.equal((await api('/auth/status')).auth.stepUp, false, 'rebound TOTP must have invalidated the earlier proof');

    // A second real password + TOTP login provides evidence that the write
    // revokes all sessions, including a different browser's session.
    const parallel = await browser.newContext();
    try {
      const secondLogin = await parallel.request.post(`${origin}/auth/login`, { data: { username, password, totp: code(replacementSeed) } });
      assert.equal(secondLogin.status(), 200);
      const secondSession = (await parallel.cookies(origin)).find(cookie => cookie.name === 'og_session');
      assert(secondSession, 'the independent browser login must create another real session');
      secrets.add(secondSession.value);
      assert.notEqual(oldSession.value, secondSession.value);
      assert.equal((await backend.db.rawQuery('SELECT COUNT(*) AS count FROM login_sessions WHERE user_id=?', [user.id]))[0].count, 2);

      await page.getByRole('button', { name: '修改登录名', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '修改登录名', exact: true });
      await editor.getByLabel('登录名', { exact: true }).fill(renamedUsername);
      await editor.getByLabel('当前密码', { exact: true }).fill(incorrectPassword);
      const rejected = await responseFor('/auth/account', 403, () => editor.getByRole('button', { name: '保存登录名', exact: true }).click());
      assert.equal((await rejected.json()).code, 'INVALID_CURRENT_PASSWORD');
      await editor.getByRole('alert').filter({ hasText: '当前密码不正确' }).waitFor();
      assert.equal(await editor.getByLabel('登录名', { exact: true }).inputValue(), renamedUsername, 'validation failure must retain the draft');
      assert.equal((await api('/auth/status')).auth.authenticated, true, 'a wrong current password must not log out the account');
      await screenshot('09-rename-validation-masked');

      await editor.getByLabel('当前密码', { exact: true }).fill(password);
      const gateResponse = await responseFor('/auth/account', 403, () => editor.getByRole('button', { name: '保存登录名', exact: true }).click());
      assert.equal((await gateResponse.json()).code, 'STEP_UP_REQUIRED');
      const identity = page.locator('dialog.dialog[open]');
      await identity.getByRole('button', { name: '用 Passkey 验证', exact: true }).waitFor();
      assert.equal(await identity.locator('input').count(), 0, 'existing Passkey must remain the only step-up option');
      const renameResponse = await responseFor('/auth/account', 200, () => identity.getByRole('button', { name: '用 Passkey 验证', exact: true }).click());
      assert.deepEqual(await renameResponse.json(), { ok: true, changed: true, requiresLogin: true });
      const completion = page.getByRole('dialog', { name: '登录名已更新', exact: true });
      await completion.waitFor();
      await page.waitForLoadState('networkidle');
      assert(await completion.isVisible(), 'the MFA status refresh must not swallow the account success dialog');
      assert.equal(await completion.locator('input[type="password"]').count(), 0, 'success must remove every credential input');
      assert(!(await context.cookies(origin)).some(cookie => cookie.name === 'og_session'), 'the server must clear the active browser session cookie');
      assert.equal(await backend.db.getLoginSession(oldSession.value), undefined, 'the original session and its step-up proof must no longer authorize requests');
      assert.equal(await backend.db.getLoginSession(secondSession.value), undefined, 'the other browser session must also be revoked');
      const expired = await parallel.request.get(`${origin}/auth/account`);
      assert.equal(expired.status(), 401);
      assert.equal((await expired.json()).code, 'SESSION_EXPIRED');
      assert.equal((await backend.db.getAdminById(user.id)).username, renamedUsername);
      assert.equal(await backend.db.getAdminByUsername(username), undefined, 'the old login name must no longer resolve');
      await screenshot('10-rename-success');
      await completion.getByRole('button', { name: '重新登录', exact: true }).click();
      await page.getByRole('heading', { name: '登录后台', exact: true }).waitFor();
      await page.getByLabel('用户名', { exact: true }).fill(username);
      await page.getByLabel('密码', { exact: true }).fill(password);
      const oldName = await responseFor('/auth/login', 401, () => page.getByRole('button', { name: '登录', exact: true }).click());
      assert.equal((await oldName.json()).code, 'INVALID_CREDENTIALS');
      await page.getByLabel('用户名', { exact: true }).fill(renamedUsername);
      await responseFor('/auth/login/passkey/finish', 200, () => page.getByRole('button', { name: '用密码 + Passkey 登录', exact: true }).click());
      await page.locator('.app-shell').waitFor();
      const status = (await api('/auth/status')).auth;
      assert(status.authenticated && status.stepUp && status.totpEnabled && status.passkeyCount === 1,
        'the same registered Passkey and TOTP must survive a login-name change');
      await page.getByRole('heading', { name: '账户信息', exact: true }).waitFor();
      await page.locator('.settings-account-row dd').filter({ hasText: renamedUsername }).waitFor();
      report.accountRename = { currentPasswordChecked: true, passkeyVerified: true, allSessionsRevoked: true,
        oldUsernameRejected: true, renamedAccountRecoveryLogin: true };
    } finally { await parallel.close(); }
  });

  await check('real account password change revokes the recovery session, rejects the old password, and accepts the new password plus Passkey', async () => {
    const oldSession = (await context.cookies(origin)).find(cookie => cookie.name === 'og_session');
    assert(oldSession, 'the renamed account must have a real session');
    secrets.add(oldSession.value);
    assert.equal((await api('/auth/status')).auth.stepUp, true, 'the prior real Passkey login supplies the preferred proof');
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '修改密码', exact: true });
    await editor.getByLabel('当前密码', { exact: true }).fill(password);
    await editor.getByLabel('新密码', { exact: true }).fill(replacementPassword);
    await editor.getByLabel('确认新密码', { exact: true }).fill(incorrectPassword);
    const beforeMismatch = report.requests.filter(request => request.path === '/auth/account/password').length;
    await editor.getByRole('button', { name: '保存密码', exact: true }).click();
    await editor.getByRole('alert').filter({ hasText: '两次输入的新密码不一致' }).waitFor();
    assert.equal(report.requests.filter(request => request.path === '/auth/account/password').length, beforeMismatch,
      'mismatched confirmation must be rejected locally before writing');
    await editor.getByLabel('确认新密码', { exact: true }).fill(replacementPassword);
    const changed = await responseFor('/auth/account/password', 200, () => editor.getByRole('button', { name: '保存密码', exact: true }).click());
    assert.deepEqual(await changed.json(), { ok: true, changed: true, requiresLogin: true });
    const completion = page.getByRole('dialog', { name: '密码已更新', exact: true });
    await completion.waitFor();
    await page.waitForLoadState('networkidle');
    assert(await completion.isVisible(), 'password-change success must remain visible until the user chooses to sign in');
    assert.equal(await completion.locator('input[type="password"]').count(), 0);
    assert.equal(await backend.db.getLoginSession(oldSession.value), undefined, 'the Passkey recovery session must be revoked after changing the password');
    assert.equal((await backend.db.rawQuery('SELECT COUNT(*) AS count FROM login_sessions WHERE user_id=?', [user.id]))[0].count, 0);
    assert(!(await context.cookies(origin)).some(cookie => cookie.name === 'og_session'));
    const previousSession = await backend.app.inject({ method: 'GET', url: '/auth/account', headers: { cookie: `og_session=${oldSession.value}` } });
    assert.equal(previousSession.statusCode, 401);
    assert.equal(previousSession.json().code, 'SESSION_EXPIRED');
    await screenshot('11-password-change-success');
    await completion.getByRole('button', { name: '重新登录', exact: true }).click();
    await page.getByRole('heading', { name: '登录后台', exact: true }).waitFor();
    await page.getByLabel('用户名', { exact: true }).fill(renamedUsername);
    await page.getByLabel('密码', { exact: true }).fill(password);
    const oldPassword = await responseFor('/auth/login', 401, () => page.getByRole('button', { name: '登录', exact: true }).click());
    assert.equal((await oldPassword.json()).code, 'INVALID_CREDENTIALS');
    const oldRecoveryPassword = await responseFor('/auth/login/passkey/begin', 401, () => page.getByRole('button', { name: '用密码 + Passkey 登录', exact: true }).click());
    assert.equal((await oldRecoveryPassword.json()).code, 'INVALID_CREDENTIALS', 'a Passkey must not bypass the changed password');
    await page.getByLabel('密码', { exact: true }).fill(replacementPassword);
    await responseFor('/auth/login/passkey/finish', 200, () => page.getByRole('button', { name: '用密码 + Passkey 登录', exact: true }).click());
    await page.locator('.app-shell').waitFor();
    const status = (await api('/auth/status')).auth;
    assert(status.authenticated && status.stepUp && status.totpEnabled && status.passkeyCount === 1);
    await page.getByRole('heading', { name: '账户信息', exact: true }).waitFor();
    await page.locator('.settings-account-row dd').filter({ hasText: renamedUsername }).waitFor();
    await screenshot('12-updated-account');
    report.accountPassword = { confirmationValidatedBeforeWrite: true, priorSessionRevoked: true,
      oldPasswordRejected: true, oldPasswordPasskeyLoginRejected: true, newPasswordPasskeyLogin: true };
  });

  await check('persisted public key/counters and auth audit evidence; no browser or external-network errors', async () => {
    const credentials = await backend.db.listWebauthnCredentials(user.id);
    report.passkey = { count: credentials.length, registrationCounter: registeredCounter, finalCounter: credentials[0].counter,
      userVerification: 'required', authenticator: 'Chromium CDP CTAP2 virtual platform authenticator' };
    assert(credentials[0].counter >= registeredCounter + 2, 'both step-up and recovery must verify real assertions');
    report.audit = await backend.db.rawQuery("SELECT action, COUNT(*) AS count FROM audit_log WHERE action LIKE 'auth.%' GROUP BY action ORDER BY action");
    for (const action of ['auth.mfa.setup_verified', 'auth.totp.confirm.success', 'auth.passkey.register', 'auth.passkey.authenticate.success', 'auth.stepup', 'auth.account.username.change', 'auth.password.change']) {
      assert(report.audit.some(entry => entry.action === action), `the audit must contain ${action}`);
    }
    await Promise.all(responseReads);
    assert.equal(report.totpQr.decodedEnrollments, 3, 'initial setup, cancelled rebind and recovery must all render decodable QR codes');
    assert.equal(report.totpQr.confirmedEnrollments, 2, 'initial setup and recovery must confirm the independently scanned seeds');
    assert.equal(report.browserErrors.length, 0, 'the UI must not have uncaught browser errors');
    assert.equal(report.externalRequests.length, 0, 'all browser traffic must stay on the local UI origin');
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { stage, name: error instanceof Error ? error.name : 'Error', message: sanitize(error instanceof Error ? error.message : error) };
  if (page && !page.isClosed()) await screenshot('failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  for (const [name, close] of [
    ['browser', () => browser?.close()], ['vite', () => vite?.close()], ['server', () => backend?.app.close()],
    ['temporary database', () => temporary && rm(temporary, { recursive: true, force: true })],
  ]) {
    try { await close(); } catch (error) { cleanupErrors.push({ resource: name, error: error instanceof Error ? error.name : 'Error' }); }
  }
  await Promise.all(responseReads);
  report.cleanup = { temporaryDatabaseRemoved: !!temporary && !existsSync(temporary), errors: cleanupErrors };
  if (cleanupErrors.length) { report.status = 'failed'; process.exitCode = 1; }
  await writeFile(join(output, 'report.json'), sanitize(JSON.stringify(report, null, 2)) + '\n');
}
if (report.status === 'passed') console.log(`Auth UI smoke passed (${report.checks.length} checks). Masked screenshots/report: ${output}`);
else console.error(`Auth UI smoke failed during ${stage}. Safe diagnostics and masked screenshots: ${output}`);
