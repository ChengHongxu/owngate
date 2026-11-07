#!/usr/bin/env node
// Actual settings/auth UI with synthetic APIs on disposable Vite, never the trial server.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let output;
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--out' && process.argv[index + 1]) output = resolve(process.argv[++index]);
  else if (process.argv[index] === '--help') {
    console.log('Usage: node scripts/settings-ui-smoke.mjs [--out SCREENSHOT_DIRECTORY]');
    console.log('Actual settings/theme/account UI, temporary Vite and synthetic auth APIs only.');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${process.argv[index]}`);
}
await mkdir(join(root, 'out/ui'), { recursive: true });
output ??= await mkdtemp(join(root, 'out/ui/settings-'));
await mkdir(output, { recursive: true });
const cache = await mkdtemp(join(tmpdir(), 'owngate-settings-vite-'));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const browserRequire = createRequire(join(root, 'apps/browser/package.json'));
const { createServer } = await import(pathToFileURL(join(dirname(webRequire.resolve('vite/package.json')), 'dist/node/index.js')).href);
const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href);
const { chromium } = browserRequire('playwright');
const report = { status: 'running', source: 'Actual frontend, disposable Vite, sandboxed Chromium and synthetic auth APIs; no live deployment, account, platform or credential access.',
  checks: [], screenshots: [], layouts: [], requests: [], theme: [], qr: [], browserErrors: [], consoleErrors: [], unexpected: [] };
const contexts = [];
const currentPassword = 'synthetic-current-password';
const nextPassword = 'synthetic-next-password';
// Public RFC 4226 test key, used only for visibly synthetic QR review images.
// Real enrollment credentials are covered by auth-ui-smoke and are masked there.
const syntheticTotpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const syntheticTotpUrl = `otpauth://totp/OwnGate:synthetic-qr-review?${new URLSearchParams({ secret: syntheticTotpSecret, issuer: 'OwnGate', algorithm: 'SHA1', digits: '6', period: '30' })}`;
const syntheticTotpCode = '123456';
let vite, browser, origin, page, stage = 'startup';

async function check(name, action) {
  stage = name;
  await action();
  report.checks.push(name);
}
async function eventually(predicate, description) {
  const deadline = Date.now() + 7000;
  do { if (await predicate()) return; await delay(25); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}
async function screenshot(name, target = page, fullPage = false) {
  if (fullPage) await target.evaluate(async () => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await target.screenshot({ path: join(output, `${name}.png`), fullPage, animations: 'disabled', mask: [target.locator('input[type="password"]')], maskColor: '#687386' });
  report.screenshots.push(`${name}.png`);
}
async function layout(name, target = page) {
  const bounds = await target.evaluate(() => {
    const dialog = document.querySelector('dialog[open]');
    const rect = dialog?.getBoundingClientRect();
    const radios = [...document.querySelectorAll('.settings-theme-option')].map(element => { const box = element.getBoundingClientRect(); return { width: box.width, height: box.height, left: box.left, right: box.right }; });
    return { viewport: { width: innerWidth, height: innerHeight }, document: document.documentElement.scrollWidth,
      dialog: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null, radios };
  });
  assert(bounds.document <= bounds.viewport.width + 1, `${name}: horizontal overflow`);
  if (bounds.dialog) {
    assert(bounds.dialog.left >= 0 && bounds.dialog.right <= bounds.viewport.width + 1, `${name}: dialog fits width`);
    assert(bounds.dialog.top >= 0 && bounds.dialog.bottom <= bounds.viewport.height + 1, `${name}: dialog fits height`);
  }
  for (const radio of bounds.radios) {
    assert(radio.left >= 0 && radio.right <= bounds.viewport.width + 1, `${name}: theme choices fit`);
    assert(radio.width >= 160 && radio.height >= 64, `${name}: theme choices retain a large click target`);
  }
  report.layouts.push({ name, ...bounds });
}
const main = (target = page) => target.getByRole('main');
const settingsNav = (target = page) => target.getByRole('navigation', { name: '设置分类' });
const accountDialog = (name, target = page) => target.getByRole('dialog', { name, exact: true });
const mutationCount = () => report.requests.filter(entry => !['GET', 'HEAD'].includes(entry.method)).length;
async function themeIs(value, target = page) {
  await eventually(() => target.evaluate(expected => document.documentElement.dataset.theme === expected, value), `theme ${value}`);
  const state = await target.evaluate(() => ({ dataset: document.documentElement.dataset.theme, colorScheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.body).backgroundColor, rootChildren: document.querySelector('#root')?.childElementCount ?? 0 }));
  assert.equal(state.colorScheme, value, 'rendered color scheme matches the chosen theme');
  report.theme.push(state);
}

async function fixture({ width = 1280, height = 900, colorScheme = 'light', preference, authenticated = true, storageBlocked = false, blockMain = false, totpEnabled = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', timezoneId: 'UTC', colorScheme, serviceWorkers: 'block' });
  contexts.push(context);
  const state = { authenticated, username: 'bridge-admin', createdAt: '2026-10-01T08:30:00.000Z', accountError: false, reject: false, hold: false, release: null, mainRequested: false, releaseMain: null,
    totpEnabled, totpEnrolling: false, totpConfirmations: 0 };
  await context.addInitScript(({ preference, storageBlocked }) => {
    if (storageBlocked) {
      Object.defineProperty(Storage.prototype, 'getItem', { configurable: true, value() { throw new DOMException('Storage is blocked', 'SecurityError'); } });
      Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, value() { throw new DOMException('Storage is blocked', 'SecurityError'); } });
    } else if (preference !== undefined) {
      try {
        if (sessionStorage.getItem('settings-fixture-initialized') !== '1') {
          localStorage.setItem('owngate.theme', preference);
          sessionStorage.setItem('settings-fixture-initialized', '1');
        }
      } catch { /* Init scripts also run before the fixture has a local origin. */ }
    }
  }, { preference, storageBlocked });
  context.on('page', opened => {
    opened.setDefaultTimeout(7000);
    opened.on('pageerror', error => report.browserErrors.push(error.stack ?? error.message));
    opened.on('console', message => {
      if (message.type() === 'error' && !/^Failed to load resource: the server responded with a status of (400|401|403|503)/.test(message.text())) report.consoleErrors.push(message.text());
    });
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { report.unexpected.push(`Refused ${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    if (blockMain && url.pathname === '/src/main.tsx') {
      state.mainRequested = true;
      await new Promise(resolve => { state.releaseMain = resolve; });
      return route.continue();
    }
    if (!/^\/(?:auth|admin|api)\//.test(url.pathname)) return route.continue();
    const method = request.method(), body = request.postData() ? request.postDataJSON() : undefined;
    // Never retain submitted passwords or other form bodies in the report.
    const entry = { path: url.pathname, method, status: 200, fields: body ? Object.keys(body) : [] };
    report.requests.push(entry);
    const respond = (status, json) => { entry.status = status; return route.fulfill({ status, json }); };
    try {
      if (url.pathname === '/auth/status' && method === 'GET') return respond(200, { hasUser: true, authenticated: state.authenticated, stepUp: true, totpEnabled: state.totpEnabled, passkeyCount: 0 });
      if (url.pathname === '/auth/account' && method === 'GET') return state.accountError
        ? respond(503, { code: 'FIXTURE_UNAVAILABLE', error: '本地账户服务暂不可用' })
        : respond(200, { username: state.username, createdAt: state.createdAt });
      if (url.pathname === '/auth/passkeys' && method === 'GET') return respond(200, { passkeys: [] });
      if (url.pathname === '/auth/totp/enroll' && method === 'POST') {
        state.totpEnrolling = true;
        return respond(200, { secretBase32: syntheticTotpSecret, otpauthUrl: syntheticTotpUrl, enabled: state.totpEnabled });
      }
      if (url.pathname === '/auth/totp/confirm' && method === 'POST') {
        assert(state.totpEnrolling, 'only an explicitly opened synthetic enrollment can be confirmed');
        if (body.code !== syntheticTotpCode) return respond(401, { code: 'TOTP_INVALID', message: 'Synthetic code rejected' });
        state.totpEnabled = true; state.totpEnrolling = false; state.totpConfirmations++;
        return respond(200, { ok: true, totpEnabled: true });
      }
      if (url.pathname === '/admin/connections' && method === 'GET') return respond(200, { connections: [] });
      if ((url.pathname === '/auth/account' && method === 'PATCH') || (url.pathname === '/auth/account/password' && method === 'POST')) {
        assert.equal(body.current_password, currentPassword, 'fixture uses only its synthetic current password');
        if (state.hold) await new Promise(resolve => { state.release = resolve; });
        if (state.reject) return respond(400, { code: 'INVALID_CURRENT_PASSWORD', error: 'Synthetic current password rejected' });
        const changed = method === 'PATCH' ? body.username !== state.username : body.new_password !== currentPassword;
        if (method === 'PATCH') state.username = body.username;
        else assert.equal(body.new_password, changed ? nextPassword : currentPassword);
        if (changed) state.authenticated = false;
        return respond(200, { changed, requiresLogin: changed });
      }
      report.unexpected.push(`Unexpected API ${method} ${url.pathname}`);
      return respond(500, { code: 'UNEXPECTED_FIXTURE_API' });
    } catch (error) {
      report.unexpected.push(error.message);
      return respond(500, { code: 'FIXTURE_ASSERTION_FAILED' });
    }
  });
  const nextPage = await context.newPage();
  return { context, page: nextPage, state };
}
async function readyAccount(target = page) {
  await main(target).getByRole('heading', { name: '设置', exact: true }).waitFor();
  await main(target).getByRole('button', { name: '修改登录名', exact: true }).waitFor();
}
async function openUsername(target = page) {
  await main(target).getByRole('button', { name: '修改登录名', exact: true }).click();
  await accountDialog('修改登录名', target).waitFor();
  return accountDialog('修改登录名', target);
}
async function openPassword(target = page) {
  await main(target).getByRole('button', { name: '修改密码', exact: true }).click();
  await accountDialog('修改密码', target).waitFor();
  return accountDialog('修改密码', target);
}
async function fillPassword(dialog, next = nextPassword) {
  await dialog.getByLabel('当前密码', { exact: true }).fill(currentPassword);
  await dialog.getByLabel('新密码', { exact: true }).fill(next);
  await dialog.getByLabel('确认新密码', { exact: true }).fill(next);
}
const totpSection = (target = page) => target.getByRole('region', { name: 'TOTP 管理', exact: true });
const totpQr = (target = page) => target.getByRole('img', { name: 'TOTP 绑定二维码', exact: true });
const manualTotp = (target = page) => totpSection(target).locator('details').filter({ has: target.getByText('无法扫码？手动添加', { exact: true }) });
async function qrLayout(name, target = page) {
  const metrics = await totpQr(target).evaluate(async element => {
    if (!(element instanceof SVGSVGElement)) throw new Error('enrollment QR must be a local SVG');
    const bounds = element.getBoundingClientRect(), view = element.viewBox.baseVal;
    const enrollment = element.closest('.totp-enrollment');
    const container = enrollment.getBoundingClientRect(), form = enrollment.querySelector('.totp-confirm-form').getBoundingClientRect();
    const scale = 4, canvas = document.createElement('canvas');
    canvas.width = Math.round(view.width) * scale; canvas.height = Math.round(view.height) * scale;
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(element))}`;
    await image.decode();
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let whiteQuietZone = true, darkModules = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const offset = (y * canvas.width + x) * 4;
      const border = x < 4 * scale || y < 4 * scale || x >= canvas.width - 4 * scale || y >= canvas.height - 4 * scale;
      if (border && (pixels[offset] !== 255 || pixels[offset + 1] !== 255 || pixels[offset + 2] !== 255 || pixels[offset + 3] !== 255)) whiteQuietZone = false;
      if (!border && pixels[offset] < 64 && pixels[offset + 1] < 64 && pixels[offset + 2] < 64 && pixels[offset + 3] === 255) darkModules++;
    }
    return { viewport: innerWidth, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height,
      containerWidth: container.width, form: { left: form.left, top: form.top, right: form.right, bottom: form.bottom },
      whiteQuietZone, darkModules, quietZoneModules: 4, modules: view.width };
  });
  assert(metrics.whiteQuietZone, `${name}: QR retains four opaque white border modules in either theme`);
  assert(metrics.darkModules > 100, `${name}: QR contains visible dark modules`);
  assert(metrics.width >= 180 && Math.abs(metrics.width - metrics.height) <= 1, `${name}: QR remains square and readable`);
  assert(metrics.left >= 0 && metrics.right <= metrics.viewport + 1, `${name}: QR fits the viewport`);
  if (metrics.containerWidth >= 440) {
    assert(metrics.form.left >= metrics.right + 16, `${name}: wide cards place confirmation next to the QR`);
    assert(Math.abs(metrics.form.top - metrics.top) <= 1, `${name}: QR and confirmation align at the top`);
  } else {
    assert(metrics.form.top >= metrics.bottom + 16, `${name}: narrow cards place confirmation below the QR`);
    assert(Math.abs(metrics.form.left - metrics.left) <= 1, `${name}: stacked confirmation aligns with the QR`);
  }
  const png = await totpQr(target).screenshot({ animations: 'disabled' });
  const actual = await target.evaluate(async ({ base64, modules }) => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    // SVG geometry can start on a half CSS pixel. Ignore just the outer pixel
    // touched by screenshot rounding, then check the actual rendered quiet zone.
    const border = Math.floor(canvas.width * 4 / modules) - 1;
    let renderedWhiteQuietZone = true;
    for (let y = 1; y < canvas.height - 1; y++) for (let x = 1; x < canvas.width - 1; x++) {
      if (x >= border && y >= border && x < canvas.width - border && y < canvas.height - border) continue;
      const offset = (y * canvas.width + x) * 4;
      if (pixels[offset] !== 255 || pixels[offset + 1] !== 255 || pixels[offset + 2] !== 255 || pixels[offset + 3] !== 255) renderedWhiteQuietZone = false;
    }
    return { renderedWhiteQuietZone, screenshotWidth: canvas.width, screenshotHeight: canvas.height };
  }, { base64: png.toString('base64'), modules: metrics.modules });
  Object.assign(metrics, actual);
  report.qr.push({ name, ...metrics });
  assert(metrics.renderedWhiteQuietZone, `${name}: the rendered QR quiet zone is not clipped or tinted by its container`);
  await layout(name, target);
}

try {
  // No project dev proxy: an accidentally missed fixture can never reach localhost:3000.
  vite = await createServer({ root: join(root, 'apps/web'), configFile: false, plugins: [react()], cacheDir: cache,
    server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  await vite.listen();
  const address = vite.httpServer.address();
  assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });

  let current = await fixture();
  page = current.page;
  await page.goto(`${origin}/settings`);
  await readyAccount();

  await check('account summary is compact, values are readable and dialogs restore focus', async () => {
    assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1);
    assert.equal(await main().getByText('bridge-admin', { exact: true }).count(), 1);
    assert.equal(await main().locator('input').count(), 0);
    assert(await main().getByLabel('已设置登录密码').isVisible());
    const before = mutationCount();
    const dialog = await openUsername();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '修改登录名');
    await dialog.getByLabel('登录名', { exact: true }).fill('cancelled-draft');
    await dialog.getByLabel('当前密码', { exact: true }).fill(currentPassword);
    await page.keyboard.press('Escape');
    assert(await dialog.isVisible(), 'Escape must not close account editing');
    await page.mouse.click(2, 2);
    assert(await dialog.isVisible(), 'a backdrop click must not close account editing');
    assert.equal(await dialog.getByLabel('登录名', { exact: true }).inputValue(), 'cancelled-draft');
    assert.equal(await dialog.getByLabel('当前密码', { exact: true }).inputValue(), currentPassword);
    assert.equal(mutationCount(), before, 'accidental dismissal attempts must not save the account');
    await dialog.getByLabel('当前密码', { exact: true }).focus();
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => document.querySelector('dialog[open]')?.contains(document.activeElement)));
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await eventually(() => main().getByRole('button', { name: '修改登录名', exact: true }).evaluate(element => element === document.activeElement), 'dialog returns focus to opener');
    assert.equal(mutationCount(), before);
    const reopened = await openUsername();
    assert.equal(await reopened.getByLabel('登录名', { exact: true }).inputValue(), 'bridge-admin');
    assert.equal(await reopened.getByLabel('当前密码', { exact: true }).inputValue(), '');
    await reopened.getByRole('button', { name: '关闭修改登录名', exact: true }).click();
    await accountDialog('修改登录名').waitFor({ state: 'detached' });
    await eventually(() => main().getByRole('button', { name: '修改登录名', exact: true }).evaluate(element => element === document.activeElement), 'the close button returns focus to the opener');
    await layout('account-desktop-light');
    await screenshot('desktop-account-light');
  });

  await check('username failure preserves the draft, pending blocks duplicate saves and cancel clears password', async () => {
    current.state.reject = true;
    current.state.hold = true;
    const before = mutationCount();
    const dialog = await openUsername();
    await dialog.getByLabel('登录名', { exact: true }).fill('retained-draft');
    await dialog.getByLabel('当前密码', { exact: true }).fill(currentPassword);
    await dialog.getByRole('button', { name: '保存登录名', exact: true }).click();
    await eventually(() => current.state.release !== null, 'pending account request');
    assert(await dialog.getByRole('button', { name: '保存中…', exact: true }).isDisabled());
    assert(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled());
    assert(await dialog.getByRole('button', { name: '关闭修改登录名', exact: true }).isDisabled());
    await page.keyboard.press('Escape');
    assert(await dialog.isVisible());
    assert.equal(mutationCount(), before + 1);
    current.state.release(); current.state.release = null; current.state.hold = false;
    await dialog.getByRole('alert').filter({ hasText: '当前密码不正确' }).waitFor();
    assert.equal(await dialog.getByLabel('登录名', { exact: true }).inputValue(), 'retained-draft');
    assert.equal(await dialog.getByLabel('当前密码', { exact: true }).inputValue(), currentPassword);
    await screenshot('desktop-username-failure');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    const reopened = await openUsername();
    assert.equal(await reopened.getByLabel('当前密码', { exact: true }).inputValue(), '');
    await reopened.getByRole('button', { name: '取消', exact: true }).click();
    current.state.reject = false;
  });

  await check('same username is a no-op with explicit feedback and retains the session', async () => {
    const dialog = await openUsername();
    await dialog.getByLabel('登录名', { exact: true }).fill(' bridge-admin ');
    await dialog.getByLabel('当前密码', { exact: true }).fill(currentPassword);
    await dialog.getByRole('button', { name: '保存登录名', exact: true }).click();
    await main().getByRole('status').filter({ hasText: '登录名未变更' }).waitFor();
    assert(current.state.authenticated);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await screenshot('desktop-username-noop');
  });

  await check('password mismatch stays local, server failure preserves fields and no-op is explicit', async () => {
    const dialog = await openPassword();
    await fillPassword(dialog);
    await dialog.getByLabel('确认新密码', { exact: true }).fill('different-synthetic-password');
    const before = mutationCount();
    await dialog.getByRole('button', { name: '保存密码', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '两次输入的新密码不一致' }).waitFor();
    assert.equal(mutationCount(), before);
    await fillPassword(dialog);
    current.state.reject = true;
    await dialog.getByRole('button', { name: '保存密码', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '当前密码不正确' }).waitFor();
    assert.equal(await dialog.getByLabel('新密码', { exact: true }).inputValue(), nextPassword);
    assert.equal(await dialog.getByLabel('确认新密码', { exact: true }).inputValue(), nextPassword);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    const reopened = await openPassword();
    for (const field of ['当前密码', '新密码', '确认新密码']) assert.equal(await reopened.getByLabel(field, { exact: true }).inputValue(), '');
    current.state.reject = false;
    await fillPassword(reopened, currentPassword);
    await reopened.getByRole('button', { name: '保存密码', exact: true }).click();
    await main().getByRole('status').filter({ hasText: '密码未变更' }).waitFor();
    assert(current.state.authenticated);
  });

  await check('successful username change clears secrets, clearly requires sign-in and does not auto-dismiss', async () => {
    const dialog = await openUsername();
    await dialog.getByLabel('登录名', { exact: true }).fill('renamed-admin');
    await dialog.getByLabel('当前密码', { exact: true }).fill(currentPassword);
    await dialog.getByRole('button', { name: '保存登录名', exact: true }).click();
    const completed = accountDialog('登录名已更新');
    await completed.waitFor();
    assert.equal(await page.locator('input[name="current_password"], input[name="new_password"], input[name="confirm_password"]').count(), 0);
    await page.keyboard.press('Escape');
    assert(await completed.isVisible());
    await screenshot('desktop-account-success-relogin');
    await completed.getByRole('button', { name: '重新登录', exact: true }).click();
    await page.getByRole('heading', { name: '登录后台', exact: true }).waitFor();
    assert.equal(await page.getByLabel('密码', { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel('用户名', { exact: true }).inputValue(), '');
  });

  await check('successful password change explicitly requires sign-in and removes form inputs', async () => {
    current = await fixture(); page = current.page;
    await page.goto(`${origin}/settings`); await readyAccount();
    const dialog = await openPassword(); await fillPassword(dialog);
    await dialog.getByRole('button', { name: '保存密码', exact: true }).click();
    const completed = accountDialog('密码已更新'); await completed.waitFor();
    assert.equal(await page.locator('input[name="current_password"], input[name="new_password"], input[name="confirm_password"]').count(), 0);
    await completed.getByRole('button', { name: '重新登录', exact: true }).click();
    await page.getByRole('heading', { name: '登录后台', exact: true }).waitFor();
  });

  await check('settings have canonical addresses, browser history and recovery for unknown routes', async () => {
    current = await fixture(); page = current.page;
    await page.goto(`${origin}/settings`); await readyAccount();
    const nav = settingsNav();
    assert.deepEqual(await nav.getByRole('link').allTextContents(), ['账户', '外观', '安全']);
    await nav.getByRole('link', { name: '外观', exact: true }).click();
    await page.waitForURL(`${origin}/settings/appearance`);
    assert.equal(await nav.getByRole('link', { name: '外观', exact: true }).getAttribute('aria-current'), 'page');
    await nav.getByRole('link', { name: '安全', exact: true }).click();
    await page.waitForURL(`${origin}/settings/security`);
    await main().getByRole('heading', { name: '安全设置', exact: true }).waitFor();
    assert.equal(await main().getByRole('heading', { level: 1 }).count(), 1);
    await page.goBack(); await page.waitForURL(`${origin}/settings/appearance`);
    await page.goForward(); await page.waitForURL(`${origin}/settings/security`);
    await page.reload(); await main().getByRole('heading', { name: '安全设置', exact: true }).waitFor();
    await page.goto(`${origin}/connections`); await main().getByRole('heading', { name: '连接', exact: true }).waitFor();
    await page.goto(`${origin}/security`);
    await main().getByRole('heading', { name: '找不到页面', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/security');
    await page.goBack(); await page.waitForURL(`${origin}/connections`);
    await page.goto(`${origin}/settings/appearance`); await main().getByRole('heading', { name: '主题', exact: true }).waitFor();
    assert.equal(await page.locator('.app-shell > .sidebar .nav-item[aria-current="page"]').textContent(), '设置');
  });

  await check('all three theme options apply immediately, persist across refresh and make no mutation requests', async () => {
    const before = mutationCount();
    assert.equal(await page.getByRole('radio').count(), 3);
    await themeIs('light');
    await page.getByRole('radio', { name: '深色', exact: true }).check(); await themeIs('dark');
    assert.equal(await page.evaluate(() => localStorage.getItem('owngate.theme')), 'dark');
    await page.reload(); await page.getByRole('radio', { name: '深色', exact: true }).waitFor();
    assert(await page.getByRole('radio', { name: '深色', exact: true }).isChecked()); await themeIs('dark');
    await page.emulateMedia({ colorScheme: 'light' }); await themeIs('dark');
    await screenshot('desktop-appearance-dark'); await layout('appearance-desktop-dark');
    await page.getByRole('radio', { name: '浅色', exact: true }).check(); await themeIs('light');
    await page.reload(); await page.getByRole('radio', { name: '浅色', exact: true }).waitFor();
    assert(await page.getByRole('radio', { name: '浅色', exact: true }).isChecked()); await themeIs('light');
    await screenshot('desktop-appearance-light');
    await page.getByRole('radio', { name: '跟随系统', exact: true }).check();
    await page.emulateMedia({ colorScheme: 'dark' }); await themeIs('dark');
    await page.emulateMedia({ colorScheme: 'light' }); await themeIs('light');
    assert.equal(await page.evaluate(() => localStorage.getItem('owngate.theme')), 'system');
    assert.equal(mutationCount(), before);
  });

  await check('storage events keep a second tab in sync and system selection remains reactive', async () => {
    const before = mutationCount();
    const other = await current.context.newPage();
    await other.goto(`${origin}/settings/appearance`); await other.getByRole('radio', { name: '跟随系统', exact: true }).waitFor();
    await page.getByRole('radio', { name: '深色', exact: true }).check();
    await themeIs('dark', other); assert(await other.getByRole('radio', { name: '深色', exact: true }).isChecked());
    await other.getByRole('radio', { name: '浅色', exact: true }).check(); await themeIs('light');
    assert(await page.getByRole('radio', { name: '浅色', exact: true }).isChecked());
    await other.getByRole('radio', { name: '跟随系统', exact: true }).check();
    await eventually(() => page.getByRole('radio', { name: '跟随系统', exact: true }).isChecked(), 'storage updates system selection');
    await page.emulateMedia({ colorScheme: 'dark' }); await themeIs('dark');
    await other.emulateMedia({ colorScheme: 'light' }); await themeIs('light', other);
    assert.equal(mutationCount(), before);
    await other.close();
  });

  await check('storage-disabled browsers can switch themes for this page and recover to system on refresh', async () => {
    const before = mutationCount();
    const unavailable = await fixture({ storageBlocked: true, colorScheme: 'dark' });
    const target = unavailable.page;
    await target.goto(`${origin}/settings/appearance`); await target.getByRole('radio', { name: '跟随系统', exact: true }).waitFor();
    await themeIs('dark', target);
    await target.getByRole('radio', { name: '浅色', exact: true }).check(); await themeIs('light', target);
    await target.reload(); await target.getByRole('radio', { name: '跟随系统', exact: true }).waitFor();
    assert(await target.getByRole('radio', { name: '跟随系统', exact: true }).isChecked()); await themeIs('dark', target);
    assert.equal(mutationCount(), before);
    await screenshot('desktop-storage-unavailable-dark', target);
  });

  await check('saved theme is applied before the main JavaScript starts and also styles the login page', async () => {
    for (const [preference, system, expected] of [['dark', 'light', 'dark'], ['light', 'dark', 'light']]) {
      const early = await fixture({ authenticated: false, preference, colorScheme: system, blockMain: true });
      const target = early.page;
      await target.goto(`${origin}/settings/appearance`, { waitUntil: 'commit' });
      await eventually(() => early.state.mainRequested, 'main module is waiting for first-paint inspection');
      await target.waitForFunction(expected => document.documentElement.dataset.theme === expected, expected);
      await target.locator('script[src="/src/main.tsx"]').waitFor({ state: 'attached' });
      const beforeReact = await target.evaluate(() => ({ theme: document.documentElement.dataset.theme, children: document.querySelector('#root')?.childElementCount ?? 0,
        scripts: [...document.querySelectorAll('script[src]')].map(script => ({ src: script.getAttribute('src'), type: script.type })) }));
      assert.equal(beforeReact.theme, expected); assert.equal(beforeReact.children, 0);
      const initIndex = beforeReact.scripts.findIndex(script => new URL(script.src, origin).pathname === '/theme-init.js');
      const mainIndex = beforeReact.scripts.findIndex(script => script.src === '/src/main.tsx');
      assert(initIndex >= 0 && mainIndex > initIndex, 'theme init precedes the application entry');
      assert.equal(beforeReact.scripts[initIndex].type, '', 'theme initializer is synchronous');
      early.state.releaseMain(); early.state.releaseMain = null;
      await target.getByRole('heading', { name: '登录后台', exact: true }).waitFor();
      await themeIs(expected, target); await layout(`login-${expected}`, target);
      await screenshot(`login-${expected}-saved-theme`, target);
      report.theme.push({ beforeReact: true, stored: preference, system, observed: beforeReact.theme });
    }
  });

  await check('320px dark account, forms, appearance and navigation remain usable', async () => {
    current = await fixture({ width: 320, height: 760, colorScheme: 'dark', preference: 'dark' }); page = current.page;
    await page.goto(`${origin}/settings`); await readyAccount(); await themeIs('dark');
    await layout('account-mobile-dark-320'); await screenshot('mobile-account-dark-320');
    const dialog = await openPassword(); await fillPassword(dialog);
    await layout('password-mobile-dark-320'); await screenshot('mobile-password-dark-320');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await settingsNav().getByRole('link', { name: '外观', exact: true }).click();
    await page.getByRole('radio', { name: '深色', exact: true }).waitFor();
    await layout('appearance-mobile-dark-320'); await screenshot('mobile-appearance-dark-320');
    await page.getByRole('radio', { name: '浅色', exact: true }).check(); await themeIs('light');
    await layout('appearance-mobile-light-320'); await screenshot('mobile-appearance-light-320');
    await settingsNav().getByRole('link', { name: '安全', exact: true }).click();
    await main().getByRole('heading', { name: '安全设置', exact: true }).waitFor();
    await layout('security-mobile-light-320');
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '导航菜单', exact: true }); await drawer.waitFor();
    assert.equal(await drawer.getByRole('link', { name: '设置', exact: true }).getAttribute('aria-current'), 'page');
    await drawer.getByRole('button', { name: '关闭导航', exact: true }).click();
    assert(await page.getByRole('button', { name: '打开导航', exact: true }).evaluate(element => element === document.activeElement));
  });

  await check('TOTP enrollment shows a locally rendered scan code with a manual fallback across themes and viewport sizes', async () => {
    for (const colorScheme of ['light', 'dark']) for (const width of [1280, 1920, 390, 320]) {
      current = await fixture({ width, height: 900, colorScheme, preference: colorScheme, totpEnabled: false }); page = current.page;
      await page.goto(`${origin}/settings/security`);
      await totpSection().getByRole('button', { name: '启用 TOTP', exact: true }).click();
      await totpQr().waitFor(); await themeIs(colorScheme);
      const manual = manualTotp();
      assert.equal(await manual.evaluate(element => element.open), false, 'manual credentials are collapsed by default');
      assert.equal(await manual.locator('code.secret').first().isVisible(), false);
      assert.equal(current.state.totpEnabled, false, 'displaying the QR must not enable TOTP');
      await qrLayout(`totp-qr-${colorScheme}-${width}`);
      await screenshot(`totp-qr-${colorScheme}-${width}`, page, true);
      if ((width === 1280 && colorScheme === 'light') || (width === 320 && colorScheme === 'dark')) {
        await manual.getByText('无法扫码？手动添加', { exact: true }).click();
        assert.equal(await manual.locator('code.secret').nth(0).textContent(), syntheticTotpSecret);
        assert.equal(await manual.locator('code.secret').nth(1).textContent(), syntheticTotpUrl);
        await qrLayout(`totp-manual-${colorScheme}-${width}`);
        await screenshot(`totp-manual-${colorScheme}-${width}`, page, true);
      }
      await totpSection().getByRole('button', { name: '取消绑定', exact: true }).click();
      assert.equal(await totpQr().count(), 0, 'cancelling removes the QR');
      assert.equal(await totpSection().locator('code.secret').count(), 0, 'cancelling removes the manual credentials');
      assert.equal(await totpSection().innerText().then(text => text.includes(syntheticTotpSecret)), false);
      assert.equal(current.state.totpConfirmations, 0);
      assert.equal(current.state.totpEnabled, false);
      await current.context.close();
    }
  });

  await check('TOTP confirmation rejects an invalid code without losing the enrollment and removes credentials after success', async () => {
    current = await fixture({ totpEnabled: false }); page = current.page;
    await page.goto(`${origin}/settings/security`);
    await totpSection().getByRole('button', { name: '启用 TOTP', exact: true }).click();
    await totpQr().waitFor();
    const code = totpSection().getByLabel('App 显示的验证码', { exact: true });
    await code.fill('654321');
    await totpSection().getByRole('button', { name: '确认启用', exact: true }).click();
    await totpSection().getByText('验证码不正确或已过期。', { exact: true }).waitFor();
    assert(await totpQr().isVisible());
    assert.equal(await code.inputValue(), '654321');
    assert.equal(current.state.totpEnabled, false);
    await code.fill(syntheticTotpCode);
    await totpSection().getByRole('button', { name: '确认启用', exact: true }).click();
    await totpQr().waitFor({ state: 'detached' });
    await totpSection().getByText('已启用', { exact: true }).waitFor();
    assert.equal(await totpQr().count(), 0);
    assert.equal(await totpSection().locator('code.secret').count(), 0);
    assert.equal(await totpSection().innerText().then(text => text.includes(syntheticTotpSecret)), false);
    assert.equal(current.state.totpConfirmations, 1);
  });

  await check('TOTP replacement keeps the enabled state when cancelled and clears its QR after explicit confirmation', async () => {
    current = await fixture({ width: 390, height: 900, colorScheme: 'dark', preference: 'dark' }); page = current.page;
    await page.goto(`${origin}/settings/security`);
    await totpSection().getByRole('button', { name: '重新绑定（换手机）', exact: true }).click();
    await totpQr().waitFor();
    assert(current.state.totpEnabled, 'enrolling a replacement cannot disable the old factor');
    await qrLayout('totp-replacement-dark-390');
    await screenshot('totp-replacement-dark-390', page, true);
    await totpSection().getByRole('button', { name: '取消绑定', exact: true }).click();
    assert.equal(await totpQr().count(), 0);
    assert.equal(await totpSection().locator('code.secret').count(), 0);
    assert(current.state.totpEnabled);
    assert.equal(current.state.totpConfirmations, 0);
    await totpSection().getByRole('button', { name: '重新绑定（换手机）', exact: true }).click();
    await totpQr().waitFor();
    assert.equal(await manualTotp().evaluate(element => element.open), false);
    await totpSection().getByLabel('App 显示的验证码', { exact: true }).fill(syntheticTotpCode);
    await totpSection().getByRole('button', { name: '确认启用', exact: true }).click();
    await totpQr().waitFor({ state: 'detached' });
    await totpSection().getByText('已启用', { exact: true }).waitFor();
    assert.equal(await totpQr().count(), 0);
    assert.equal(await totpSection().locator('code.secret').count(), 0);
    assert.equal(current.state.totpConfirmations, 1);
  });

  assert.equal(report.unexpected.length, 0, 'no unexpected API or external requests');
  assert.equal(report.browserErrors.length, 0, 'no uncaught browser errors');
  assert.equal(report.consoleErrors.length, 0, 'no unexpected console errors');
  assert(report.requests.filter(entry => entry.method !== 'GET').every(entry => ['/auth/account', '/auth/account/password', '/auth/totp/enroll', '/auth/totp/confirm'].includes(entry.path)), 'only explicit account and TOTP actions mutate synthetic state');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.stage = stage; report.error = error.stack ?? String(error);
  if (page) await screenshot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (vite) await vite.close().catch(() => {});
  await rm(cache, { recursive: true, force: true });
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, stage: report.stage, checks: report.checks.length, screenshots: report.screenshots.length, requests: report.requests.length, layouts: report.layouts.length, report: join(output, 'report.json'), error: report.error }, null, 2));
}
