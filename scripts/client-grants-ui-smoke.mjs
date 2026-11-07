#!/usr/bin/env node
// Actual Web source + sandboxed Chromium + local synthetic administrator APIs.
// Never reads live accounts, tokens, profiles, or the running port-3000 service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let output;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out' && process.argv[i + 1]) output = resolve(process.argv[++i]);
  else if (process.argv[i] === '--help') {
    console.log('Usage: node scripts/client-grants-ui-smoke.mjs [--out SCREENSHOT_DIRECTORY]');
    console.log('Disposable local APIs and synthetic credentials only; no real account access.');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${process.argv[i]}`);
}
await mkdir(join(root, 'out/ui'), { recursive: true });
output ??= await mkdtemp(join(root, 'out/ui/client-grants-'));
await mkdir(output, { recursive: true });
const cache = await mkdtemp(join(tmpdir(), 'owngate-client-grants-vite-'));
const report = { status: 'running', source: 'Actual Web source with disposable Vite, sandboxed Chromium and synthetic administrator APIs only; no existing service, account or credential access.', checks: [], screenshots: [], layouts: [], dialogs: [], usageTabs: [], browserErrors: [], consoleErrors: [], unexpected: [], requestCount: 0 };
const sourceFiles = ['apps/web/src/pages/ClientsPage.tsx', 'apps/web/src/pages/clients.css', 'apps/web/src/components/ClientUsageGuide.tsx', 'apps/web/src/components/ClientUsageGuide.css', 'apps/web/src/lib/api.ts', 'apps/web/src/lib/client-usage.ts', 'apps/web/src/lib/grant-fields.ts'];
async function sourceHashes() { return Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')]))); }
report.sourceSha256 = await sourceHashes();
const at = '2026-11-03T08:00:00.000Z';
const capability = (id, title, output, kind = 'query') => ({ id, title, description: `查询${title}的合成示例。`, kind, effect: kind === 'action' ? 'external_send' : 'read', transport: 'http', support: { status: kind === 'action' ? 'disabled' : 'supported' }, input: { type: 'object', properties: {} }, output, cache: null });
const catalogs = {
  newapi: [capability('account.balance', '账户余额', { type: 'object', properties: { quota: { type: 'number', title: '剩余配额', 'x-sensitivity': 'financial' }, username: { type: 'string', title: '账户名称', 'x-sensitivity': 'pii' } } }), capability('model.list', '可用模型', { type: 'object', properties: { models: { type: 'array', title: '模型名称', items: { type: 'string' } } } })],
  bilibili: [capability('account.profile', '账户资料', { type: 'object', properties: { uid: { type: 'integer', title: '账户 ID', 'x-sensitivity': 'pii' }, nickname: { type: 'string', title: '昵称', 'x-sensitivity': 'pii' }, token: { type: 'string', title: '不得显示的密钥字段', 'x-secret': true, 'x-sensitivity': 'financial' } } }), capability('feed.list', '信息流', { type: 'object', properties: { items: { type: 'array', title: '动态内容', 'x-sensitivity': 'content', items: { type: 'object', properties: { text: { type: 'string', title: '正文' }, author: { type: 'object', properties: { name: { type: 'string', title: '作者名称', 'x-sensitivity': 'pii' } } } } } } } }), capability('post.create', '发布内容', {}, 'action')],
  fixture_extension: [capability('records.list', '业务记录', { type: 'object', properties: { records: { type: 'array', title: '记录', items: { type: 'object', properties: { id: { type: 'string', title: '编号' }, status: { type: 'string', title: '状态' } } } } } }), capability('job.run', '执行业务', {}, 'action')],
  fixture_empty: [capability('health.read', '健康状态', { type: 'object', properties: { available: { type: 'boolean', title: '可用状态' } } })],
};
const connection = (id, connector_id, label) => ({ id, connector_id, label, config: {}, capability_states: Object.fromEntries(catalogs[connector_id].map(cap => [cap.id, cap.support])), health: { status: 'healthy' }, scope: 'personal', tags: [], paused: false, created_at: at, updated_at: at });
const connections = [connection('grant-newapi', 'newapi', '配额站点示例'), connection('grant-bilibili', 'bilibili', '视频平台示例'), connection('grant-extension', 'fixture_extension', '业务接口示例'), connection('grant-empty', 'fixture_empty', '尚未授权站点')];
const clients = [{ id: 'agent-revoked', label: 'Agent', revoked: true, created_at: at, expires_at: null }, { id: 'agent-primary', label: 'A2', revoked: false, created_at: at, expires_at: null }];
const grants = [
  { client_id: 'agent-primary', connection_id: 'grant-newapi', capabilities: ['account.balance', 'model.list'], visibility: { pii: false, financial: true, content: true } },
  { client_id: 'agent-primary', connection_id: 'grant-bilibili', capabilities: ['account.profile'], visibility: { pii: false, financial: true, content: true } },
  { client_id: 'agent-primary', connection_id: 'grant-extension', capabilities: ['*', 'legacy.query', 'propose:job.run'], visibility: { pii: false, financial: true, content: true } },
];
const requests = [];
const held = new Set();
let nextGrantFailure = false, nextGrantHold, metadataFailure = false, clientRefreshFailure = false, nextClientStepUp = false;
let vite, browser, page, origin, stage = 'startup';
function defer() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const row = id => page.locator(`[data-grant-connection-id="${id}"]`);
const clientWorkspace = id => page.locator(`section[data-client-id="${id}"]`);
const clientChoice = id => page.locator(`[data-client-choice-id="${id}"]`);
const history = () => page.locator('[data-client-history]');
const createDialog = () => page.getByRole('dialog', { name: '添加客户端', exact: true });
const guideDialog = id => page.getByRole('dialog', { name: `接入方法 · ${clients.find(client => client.id === id)?.label}`, exact: true });
const lastGrant = () => requests.findLast(request => request.path === '/admin/grants' && request.method === 'POST');
const grantPosts = () => requests.filter(request => request.path === '/admin/grants' && request.method === 'POST').length;
const mutations = () => requests.filter(request => !['GET', 'HEAD'].includes(request.method)).length;
async function check(name, action) { stage = name; await action(); report.checks.push(name); }
async function eventually(predicate, label) { const deadline = Date.now() + 8000; do { if (await predicate()) return; await new Promise(done => setTimeout(done, 25)); } while (Date.now() < deadline); throw new Error(`Timed out: ${label}`); }
async function layout(name) { const bounds = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, height: innerHeight })); report.layouts.push({ name, ...bounds }); assert(bounds.document <= bounds.width + 1, `${name}: horizontal overflow`); }
async function screenshot(name, target) { await page.evaluate(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }); await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); const clip = target ? await target.boundingBox() : undefined; assert(!target || clip, 'screenshot target must be visible'); await page.screenshot({ path: join(output, `${name}.png`), fullPage: await page.locator('dialog[open]').count() === 0, ...(clip ? { clip } : {}), animations: 'disabled' }); report.screenshots.push(`${name}.png`); }
async function chooseClient(id) { await page.locator('section[data-client-id]').waitFor(); if (await clientChoice(id).count() && await clientChoice(id).getAttribute('aria-pressed') !== 'true') await clientChoice(id).click(); await clientWorkspace(id).waitFor(); await row('grant-bilibili').waitFor(); assert.equal(await page.locator('section[data-client-id]').count(), 1); if (await clientChoice(id).count()) assert.equal(await clientChoice(id).getAttribute('aria-pressed'), 'true'); }
async function closeGuide(id) { const dialog = guideDialog(id); await dialog.getByRole('button', { name: `关闭接入方法 · ${clients.find(client => client.id === id)?.label}`, exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); }
async function edit(id) { await row(id).getByRole('button', { name: /编辑授权|配置授权|添加授权/ }).click(); await row(id).locator('form').waitFor(); }
async function save(id) { await row(id).getByRole('button', { name: /保存授权|保存选中权限/ }).click(); }

try {
  const webRequire = createRequire(join(root, 'apps/web/package.json'));
  const browserRequire = createRequire(join(root, 'apps/browser/package.json'));
  const { createServer } = await import(pathToFileURL(join(dirname(webRequire.resolve('vite/package.json')), 'dist/node/index.js')).href);
  const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href);
  const { chromium } = browserRequire('playwright');
  vite = await createServer({ root: join(root, 'apps/web'), configFile: false, plugins: [react()], cacheDir: cache, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await vite.listen();
  const address = vite.httpServer.address(); assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'zh-CN' });
  await context.addInitScript(() => {
    // Record only the public synthetic snippets copied by this acceptance run.
    // No permission or host clipboard access is needed.
    window.__syntheticClipboard = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async text => { window.__syntheticClipboard.push(text); } } });
  });
  page = await context.newPage(); page.setDefaultTimeout(7000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource: the server responded with a status of (503|403)/.test(message.text())) report.consoleErrors.push(message.text()); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.origin !== origin) { report.unexpected.push(`${method} ${url.origin}${path}`); return route.abort(); }
    if (!/^\/(?:admin|auth|api|ws)(?:\/|$)/.test(path)) return route.continue();
    const body = request.postData() ? request.postDataJSON() : undefined;
    const observed = { method, path, ...(body ? { body } : {}) }; requests.push(observed);
    let response, status = 200;
    if (path === '/auth/status') response = { hasUser: true, authenticated: true, stepUp: true, totpEnabled: true, passkeyCount: 0 };
    else if (path === '/admin/clients' && method === 'GET') {
      if (clientRefreshFailure) { status = 503; response = { code: 'FIXTURE_CLIENT_REFRESH_UNAVAILABLE', message: '本地客户端列表暂时无法刷新' }; }
      else response = { clients };
    }
    else if (path === '/admin/connections' && method === 'GET') response = { connections };
    else if (path === '/admin/connectors' && method === 'GET') response = { connectors: Object.keys(catalogs).map(id => ({ id, title: id, transport: 'http', has_auth: false })) };
    else if (path === '/admin/grants' && method === 'GET') response = { grants };
    else if (path === '/admin/capabilities' && method === 'GET') {
      if (metadataFailure && url.searchParams.get('connector_id') === 'fixture_extension') { status = 503; response = { code: 'FIXTURE_METADATA_UNAVAILABLE', message: '本地能力目录暂时不可用' }; }
      else response = { capabilities: catalogs[url.searchParams.get('connector_id')] ?? [] };
    } else if (path === '/admin/grants' && method === 'POST') {
      const pending = nextGrantHold; nextGrantHold = undefined;
      if (pending) { pending.arrived.resolve(); await pending.release.promise; held.delete(pending); }
      if (nextGrantFailure) { nextGrantFailure = false; status = 503; response = { code: 'FIXTURE_SAVE_REFUSED', message: '本地夹具拒绝保存，请重试' }; }
      else { const index = grants.findIndex(grant => grant.client_id === body.client_id && grant.connection_id === body.connection_id); if (index < 0) grants.push(structuredClone(body)); else grants[index] = structuredClone(body); response = body; }
    } else if (path === '/admin/clients' && method === 'POST') {
      assert.deepEqual(Object.keys(body).sort(), ['expires_at', 'label'], 'client creation accepts identity and expiry only');
      if (nextClientStepUp) { nextClientStepUp = false; status = 403; response = { code: 'STEP_UP_REQUIRED', message: '本地夹具需要二次验证' }; }
      else { const created = { ...body, id: `created-${clients.length}`, revoked: false, created_at: at }; clients.push(created); response = { ...created, token: `og_synthetic_one_time_${created.id}` }; }
    } else if (/^\/admin\/clients\/[^/]+\/revoke$/.test(path) && method === 'POST') {
      const target = clients.find(client => client.id === path.split('/')[3]); assert(target); target.revoked = true; response = { ok: true };
    } else { report.unexpected.push(`${method} ${path}`); status = 500; response = { message: 'Unexpected fixture request' }; }
    observed.status = status;
    await route.fulfill({ status, json: structuredClone(response) });
  });
  await page.goto(`${origin}/clients`);
  await page.getByRole('heading', { name: '客户端与授权', exact: true }).waitFor();
  await chooseClient('agent-primary');

  await check('a revoked Agent stays in collapsed read-only history while the sole active A2 owns the workspace', async () => {
    assert.equal(await page.locator('[data-client-choice-id]').count(), 0, 'one active client needs no selector');
    assert.equal(await clientWorkspace('agent-revoked').count(), 0);
    await clientWorkspace('agent-primary').getByRole('heading', { name: 'A2', exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('.clients-page').innerText(), /正在管理授权|管理授权/);
    assert.equal(await history().evaluate(element => element.open), false, 'revoked history starts collapsed');
    assert(await clientWorkspace('agent-primary').evaluate(element => (element.compareDocumentPosition(document.querySelector('[data-client-history]')) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0), 'revoked history belongs after the current workspace');
    assert.equal(await history().getByText('Agent', { exact: true }).isVisible(), false);
    await screenshot('desktop-a2-active-agent-history-collapsed');
    const before = mutations();
    await history().locator('summary').click();
    await history().getByText('Agent', { exact: true }).waitFor();
    assert.equal(await history().locator('button, input, select, textarea, a, form').count(), 0, 'revoked records must have no client operations');
    assert.equal(await clientWorkspace('agent-primary').count(), 1, 'opening history must not select a revoked client');
    assert.equal(mutations(), before);
    await screenshot('desktop-agent-readonly-history-expanded', history());
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await layout(`mobile-agent-history-${colorScheme}-${width}`);
        if (width === 390) await screenshot(`mobile-agent-history-${colorScheme}-390`);
      }
    }
    await history().locator('summary').click();
    await page.setViewportSize({ width: 1280, height: 900 }); await page.emulateMedia({ colorScheme: 'light' });
  });

  await check('adding a client uses a modal and cancelling restores focus without changing the current client', async () => {
    const before = mutations();
    await page.getByRole('button', { name: '添加客户端', exact: true }).click();
    await createDialog().getByLabel('客户端名称', { exact: true }).fill('尚未创建的合成客户端');
    await createDialog().getByLabel('令牌有效期').selectOption('7');
    assert.equal(await createDialog().locator('input, select, textarea').count(), 2, 'only identity and expiry belong in creation');
    assert.equal(await createDialog().getByLabel('使用方式').count(), 0);
    assert(await createDialog().evaluate(element => element instanceof HTMLDialogElement && element.open && element.matches(':modal')));
    assert.equal(await clientWorkspace('agent-primary').count(), 1, 'opening a modal preserves the underlying workspace');
    assert.doesNotMatch(await page.locator('.clients-page').innerText(), /正在管理授权|管理授权/);
    await screenshot('desktop-add-client');
    await page.keyboard.press('Escape');
    await page.mouse.click(2, 2);
    assert(await createDialog().isVisible(), 'accidental dismissal attempts keep the creation form open');
    assert.equal(await createDialog().getByLabel('客户端名称', { exact: true }).inputValue(), '尚未创建的合成客户端');
    assert.equal(await createDialog().getByLabel('令牌有效期').inputValue(), '7');
    await page.setViewportSize({ width: 1920, height: 900 });
    await layout('desktop-add-client-light-1920');
    await screenshot('desktop-add-client-light-1920');
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await layout(`mobile-add-client-${colorScheme}-${width}`);
        if (width === 390) await screenshot(`mobile-add-client-${colorScheme}-390`);
      }
    }
    await createDialog().getByRole('button', { name: '关闭添加客户端', exact: true }).click();
    await chooseClient('agent-primary');
    assert.equal(await page.getByLabel('客户端名称', { exact: true }).count(), 0);
    assert.equal(mutations(), before);
    assert.equal(await page.getByRole('button', { name: '添加客户端', exact: true }).evaluate(element => element === document.activeElement), true);
    await page.setViewportSize({ width: 1280, height: 900 }); await page.emulateMedia({ colorScheme: 'light' });
  });

  await check('cancelling nested identity verification preserves its parent creation dialog without issuing a token', async () => {
    const beforeClients = clients.length, beforeGrant = grantPosts();
    await page.getByRole('button', { name: '添加客户端', exact: true }).click();
    await createDialog().getByLabel('客户端名称', { exact: true }).fill('嵌套验证合成客户端');
    nextClientStepUp = true;
    await createDialog().getByRole('button', { name: '签发令牌', exact: true }).click();
    const identity = page.locator('dialog.dialog[open]');
    await identity.getByText('需要二次验证', { exact: true }).waitFor();
    assert.equal(await page.locator('dialog[open]').count(), 2);
    assert(await page.locator('dialog.page-dialog button[aria-label="关闭添加客户端"]').isDisabled(), 'the parent cannot close during the pending issuance');
    await identity.getByLabel('当前密码', { exact: true }).fill('synthetic-password-for-ui-only');
    await identity.getByLabel('TOTP 验证码', { exact: true }).fill('123456');
    assert(await identity.evaluate(element => element.contains(document.activeElement)));
    await screenshot('desktop-nested-step-up');
    await identity.getByLabel('TOTP 验证码', { exact: true }).focus();
    await page.keyboard.press('Escape');
    assert(await identity.isVisible(), 'Escape must not cancel nested identity verification');
    await page.mouse.click(2, 2);
    assert(await identity.isVisible(), 'a backdrop click must not cancel nested identity verification');
    assert.equal(await identity.getByLabel('当前密码', { exact: true }).inputValue(), 'synthetic-password-for-ui-only');
    assert.equal(await identity.getByLabel('TOTP 验证码', { exact: true }).inputValue(), '123456');
    assert.equal(await page.locator('dialog[open]').count(), 2, 'both parent and child remain open until explicit cancellation');
    await identity.getByRole('button', { name: '取消', exact: true }).click();
    await identity.waitFor({ state: 'hidden' });
    await createDialog().getByText(/已取消二次验证，操作未执行/).waitFor();
    assert.equal(await createDialog().getByLabel('客户端名称', { exact: true }).inputValue(), '嵌套验证合成客户端');
    assert(await createDialog().evaluate(element => element.open && element.matches(':modal')));
    const focus = await createDialog().evaluate(element => ({ contained: element.contains(document.activeElement), documentFocused: document.hasFocus(), activeTag: document.activeElement?.tagName, activeText: document.activeElement?.textContent?.slice(0, 120) }));
    report.dialogs.push({ name: 'nested-step-up-cancel', ...focus });
    assert(focus.contained, `closing the child restores focus to the parent modal: ${JSON.stringify(focus)}`);
    assert.equal(clients.length, beforeClients); assert.equal(grantPosts(), beforeGrant);
    assert.equal(await page.locator('.secret').count(), 0);
    await createDialog().getByRole('button', { name: '关闭添加客户端', exact: true }).click();
  });

  await check('all saved connection grants and capability names are visible together without a connection dropdown', async () => {
    for (const connection of connections) await row(connection.id).waitFor();
    await row('grant-newapi').getByText('账户余额', { exact: true }).waitFor();
    await row('grant-bilibili').getByText('账户资料', { exact: true }).waitFor();
    await row('grant-extension').getByText('业务记录', { exact: true }).waitFor();
    assert.match(await row('grant-empty').innerText(), /未授权/);
    assert.equal(await page.getByRole('combobox', { name: /^连接$/ }).count(), 0);
    assert.equal(await page.locator('[data-grant-connection-id] form').count(), 0);
    await layout('desktop-overview-light'); await screenshot('desktop-overview-light');
  });

  await check('desktop permissions share rows while editors span the row and usage dialogs preserve focus, drafts and page height', async () => {
    const before = mutations();
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const first = await row('grant-newapi').boundingBox(), second = await row('grant-bilibili').boundingBox();
      assert(first && second && second.x > first.x + 20 && Math.abs(first.y - second.y) < 3, `${width}px permissions should share a row`);
      await screenshot(`desktop-permission-columns-${width}`);
      await edit('grant-newapi');
      const expanded = await row('grant-newapi').boundingBox(), parent = await page.locator('.client-grant-list').boundingBox();
      assert(expanded && parent && Math.abs(expanded.width - parent.width) < 3, `${width}px expanded editor must span the permission grid`);
      await row('grant-newapi').getByRole('checkbox', { name: '财务数据', exact: true }).uncheck();
      const opener = clientWorkspace('agent-primary').getByRole('button', { name: '接入方法', exact: true });
      await opener.focus();
      const closedHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      await opener.click();
      const dialog = guideDialog('agent-primary'); await dialog.waitFor();
      assert(await dialog.evaluate(element => element instanceof HTMLDialogElement && element.open && element.matches(':modal')));
      const openHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      assert(Math.abs(openHeight - closedHeight) <= 3, 'opening usage must not append to page height');
      const focusable = await dialog.locator('button, input, select, textarea, a[href], summary').count();
      for (let step = 0; step < focusable + 3; step++) {
        await page.keyboard.press('Tab');
        assert(await dialog.evaluate(element => element.contains(document.activeElement) || (!document.hasFocus() && document.activeElement === document.body)), 'page focus must remain inside the native modal; the browser chrome may receive Tab focus');
      }
      if (!await page.evaluate(() => document.hasFocus())) await page.keyboard.press('Tab');
      await opener.evaluate(element => element.focus());
      assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'the background cannot take focus while showModal is active');
      await dialog.getByRole('heading', { name: '接入方法 · A2', exact: true }).click();
      await page.keyboard.press('Escape');
      assert(await dialog.isVisible(), 'Escape must keep the usage dialog open');
      await page.mouse.click(2, 2);
      assert(await dialog.isVisible(), 'a backdrop click must keep the usage dialog open');
      assert.equal(await row('grant-newapi').getByRole('checkbox', { name: '财务数据', exact: true }).isChecked(), false, 'opening usage must preserve the grant draft');
      await closeGuide('agent-primary');
      assert(await opener.evaluate(element => element === document.activeElement), 'the close button restores focus to the guide opener');
      assert.equal(await row('grant-newapi').getByRole('checkbox', { name: '财务数据', exact: true }).isChecked(), false, 'explicitly closing guidance preserves the grant draft');
      report.dialogs.push({ width, closedHeight, openHeight, focusable, escapeBlocked: true, backdropBlocked: true, explicitClose: true, backgroundFocusBlocked: true, grantDraftPreserved: true });
      await row('grant-newapi').getByRole('button', { name: '取消', exact: true }).click();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(mutations(), before, 'opening and closing guidance must not change grants or issue tokens');
  });

  await check('editing uses large capability targets and schema-derived fields without irrelevant Bilibili financial categories', async () => {
    await edit('grant-bilibili');
    const form = row('grant-bilibili').locator('form');
    const profile = form.getByRole('checkbox', { name: /^账户资料/ });
    await profile.waitFor();
    const target = await profile.evaluate(element => { const control = element.getBoundingClientRect(), label = element.closest('label')?.getBoundingClientRect(); return { control: { width: control.width, height: control.height }, label: label ? { width: label.width, height: label.height } : null }; });
    assert(target.control.width >= 20 && target.control.height >= 20, 'the checkbox itself must be easy to see');
    assert(target.label && target.label.height >= 44 && target.label.width > 150, 'the whole capability row must be a comfortable click target');
    assert.equal(await form.getByRole('checkbox', { name: /财务数据/ }).count(), 0);
    assert.equal(await form.getByText('不得显示的密钥字段', { exact: false }).count(), 0);
    assert.match(await form.innerText(), /昵称|账户 ID/);
    const before = grantPosts();
    await form.getByRole('button', { name: '返回字段说明', exact: true }).click();
    const help = await page.getByRole('tooltip').innerText();
    assert.match(help, /能力决定允许调用什么/); assert.match(help, /限制查询结果/);
    assert.equal(grantPosts(), before); await page.keyboard.press('Escape');
    await form.getByText('信息流', { exact: true }).click();
    assert(await form.getByRole('checkbox', { name: /^信息流/ }).isChecked(), 'clicking a capability label must toggle its checkbox');
    assert.match(await form.innerText(), /正文|动态内容/);
    await layout('desktop-editor-light'); await screenshot('desktop-editor-light'); await screenshot('desktop-bilibili-editor-light', row('grant-bilibili'));
  });

  await check('save failures preserve drafts and successful saves visibly return to a current overview', async () => {
    nextGrantFailure = true;
    await save('grant-bilibili');
    await row('grant-bilibili').getByRole('alert').filter({ hasText: /拒绝保存/ }).waitFor();
    assert(await row('grant-bilibili').getByRole('checkbox', { name: /^信息流/ }).isChecked());
    const pending = { arrived: defer(), release: defer() }; nextGrantHold = pending; held.add(pending);
    await save('grant-bilibili'); await eventually(() => requests.some(request => request === lastGrant() && request.body?.connection_id === 'grant-bilibili' && request.status === undefined), 'pending save request');
    assert(await row('grant-bilibili').getByRole('button', { name: /保存中/ }).isDisabled());
    pending.release.resolve();
    await row('grant-bilibili').locator('form').waitFor({ state: 'hidden' });
    await row('grant-bilibili').getByText('信息流', { exact: true }).waitFor();
    assert.match(await row('grant-bilibili').innerText(), /已保存/);
    assert.deepEqual(lastGrant().body.capabilities, ['account.profile', 'feed.list']);
    await row('grant-newapi').getByText('账户余额', { exact: true }).waitFor();
    await screenshot('desktop-saved-overview');
  });

  await check('cancel discards drafts and schema categories change with the selected capabilities', async () => {
    await edit('grant-newapi');
    const form = row('grant-newapi').locator('form');
    await form.getByRole('checkbox', { name: /^账户余额/ }).uncheck();
    assert.equal(await form.getByRole('checkbox', { name: /财务数据/ }).count(), 0);
    const before = grantPosts();
    await form.getByRole('button', { name: /取消/ }).click();
    assert.equal(grantPosts(), before);
    await row('grant-newapi').getByText('账户余额', { exact: true }).waitFor();
    await edit('grant-newapi');
    assert(await row('grant-newapi').getByRole('checkbox', { name: /^账户余额/ }).isChecked());
    const financial = row('grant-newapi').getByRole('checkbox', { name: /财务数据/ });
    assert(await financial.isChecked());
    await financial.uncheck();
    await save('grant-newapi');
    await row('grant-newapi').locator('form').waitFor({ state: 'hidden' });
    assert.equal(lastGrant().body.visibility.financial, false);
  });

  await check('editing legacy grants keeps unrecognized capability IDs and proposal rights instead of silently deleting access', async () => {
    await edit('grant-extension');
    const before = grantPosts();
    assert(await row('grant-extension').getByRole('button', { name: /保存授权/ }).isDisabled(), 'unrecognized rights must require explicit review');
    assert.equal(grantPosts(), before);
    await row('grant-extension').getByRole('checkbox', { name: /legacy\.query/ }).uncheck();
    await save('grant-extension');
    await row('grant-extension').locator('form').waitFor({ state: 'hidden' });
    assert(!lastGrant().body.capabilities.includes('legacy.query'));
    assert(lastGrant().body.capabilities.includes('propose:job.run'));
    assert(lastGrant().body.capabilities.includes('*') || lastGrant().body.capabilities.includes('records.list'));
  });

  await check('context links open the requested connection without granting it and keep the context after refresh', async () => {
    const before = grantPosts();
    await page.goto(`${origin}/clients?connection_id=grant-empty`);
    await chooseClient('agent-primary');
    await row('grant-empty').locator('form').waitFor();
    assert.equal(grantPosts(), before);
    await page.reload(); await chooseClient('agent-primary');
    await row('grant-empty').locator('form').waitFor();
    assert.equal(grantPosts(), before);
    assert.equal(new URL(page.url()).searchParams.get('connection_id'), 'grant-empty');
    await row('grant-empty').getByRole('button', { name: /取消/ }).click();
  });

  await check('compact choices and successful creation retain the correct client context even if refreshing the list fails', async () => {
    await page.getByRole('button', { name: '添加客户端', exact: true }).click();
    await page.getByLabel('客户端名称', { exact: true }).fill('独立脚本示例');
    const id = `created-${clients.length}`;
    clientRefreshFailure = true;
    await page.getByRole('button', { name: '签发令牌', exact: true }).click();
    await clientWorkspace(id).waitFor();
    await page.locator('.inline-notice').getByText('刷新失败，显示上次的授权设置。', { exact: true }).waitFor();
    const token = `og_synthetic_one_time_${id}`;
    await guideDialog(id).getByText(token, { exact: true }).waitFor();
    assert.equal(await clientWorkspace('agent-primary').count(), 0, 'a refresh failure must not put the new token under the previous client');
    assert.equal(await guideDialog(id).locator('.client-usage-guide').count(), 1);
    await screenshot('desktop-created-client-refresh-failure');
    clientRefreshFailure = false;
    await closeGuide(id);
    assert.equal(await page.getByText(token, { exact: true }).count(), 0, 'closing the guide clears the one-time token');
    await page.locator('.inline-notice').getByRole('button', { name: '重试', exact: true }).click();
    await page.locator('.inline-notice').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[data-client-choice-id]').count(), 2);
    assert.equal(await clientChoice('agent-revoked').count(), 0);
    assert.equal(await clientChoice(id).getAttribute('aria-pressed'), 'true');
    assert.match(await clientChoice('agent-primary').innerText(), /A2/);
    assert.match(await clientChoice(id).innerText(), /独立脚本示例/);
    for (const connection of connections) assert.match(await row(connection.id).innerText(), /未授权/);
    const before = mutations();
    await page.getByRole('button', { name: '添加客户端', exact: true }).click();
    assert.equal(await clientWorkspace(id).count(), 1);
    await createDialog().getByRole('button', { name: '关闭添加客户端', exact: true }).click();
    await clientWorkspace(id).waitFor();
    assert.equal(await clientChoice(id).getAttribute('aria-pressed'), 'true', 'cancelling creation must restore a previously chosen client');
    assert.equal(mutations(), before);
    await chooseClient('agent-primary');
    await screenshot('desktop-multiple-client-choices');
    await edit('grant-bilibili');
    await row('grant-bilibili').getByRole('button', { name: /撤销.*授权|撤销此连接/ }).click();
    await row('grant-bilibili').locator('form').waitFor({ state: 'hidden' });
    assert.deepEqual(lastGrant().body.capabilities, []);
    assert.match(await row('grant-bilibili').innerText(), /未授权/);
  });

  await check('overview and expanded records fit 390px and 320px screens in both themes', async () => {
    await page.goto(`${origin}/clients`); await chooseClient('agent-primary');
    await edit('grant-newapi');
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await layout(`mobile-grants-${colorScheme}-${width}`);
        if (width === 390) { await screenshot(`mobile-grants-${colorScheme}-390`); await screenshot(`mobile-grant-editor-${colorScheme}-390`, row('grant-newapi')); }
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 }); await page.emulateMedia({ colorScheme: 'light' });
  });

  await check('one client offers MCP, HTTP API and CLI tabs with correct ARIA, keyboard navigation and public clipboard examples', async () => {
    await page.getByRole('button', { name: '添加客户端', exact: true }).click();
    await page.getByLabel('客户端名称', { exact: true }).fill('统一接入示例');
    await page.getByLabel('令牌有效期').selectOption('7');
    const beforeGrant = grantPosts(), issuedAfter = Date.now();
    const id = `created-${clients.length}`;
    await page.getByRole('button', { name: '签发令牌', exact: true }).click();
    const token = `og_synthetic_one_time_${id}`;
    const dialog = guideDialog(id), usage = dialog.locator('.client-usage-guide');
    await dialog.getByText(token, { exact: true }).waitFor();
    await clientWorkspace(id).waitFor();
    assert.equal(await page.locator('section[data-client-id]').count(), 1);
    assert.equal(await clientChoice(id).getAttribute('aria-pressed'), 'true');
    assert.doesNotMatch(await page.locator('.clients-page').innerText(), /正在管理授权|管理授权|AI \/ MCP|命令行 \/ CLI/);
    assert(await page.locator('.secret').evaluateAll(elements => elements.every(element => element.closest('dialog'))), 'the one-time token only belongs to its creation guide');
    const created = requests.findLast(request => request.path === '/admin/clients' && request.method === 'POST').body;
    assert.deepEqual(Object.keys(created).sort(), ['expires_at', 'label']);
    assert(Math.abs(Date.parse(created.expires_at) - issuedAfter - 7 * 86_400_000) < 5000);
    assert.equal(grantPosts(), beforeGrant, 'creating a client must not create grants');
    for (const connection of connections) assert.match(await row(connection.id).innerText(), /未授权/);

    const tablist = usage.getByRole('tablist', { name: '接入方式', exact: true });
    await tablist.waitFor();
    assert.deepEqual(await tablist.getByRole('tab').allTextContents(), ['MCP', 'HTTP API', 'CLI']);
    async function selected(name, focused = false) {
      const tab = tablist.getByRole('tab', { name, exact: true });
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
      assert.equal(await tab.getAttribute('tabindex'), '0');
      assert.equal(await usage.getByRole('tabpanel').count(), 1, 'only the chosen method is visible');
      const panel = usage.getByRole('tabpanel');
      const id = await panel.getAttribute('id');
      assert(id && await tab.getAttribute('aria-controls') === id, 'the selected tab controls the visible panel');
      assert.equal(await panel.getAttribute('aria-labelledby'), await tab.getAttribute('id'));
      assert.equal(await tablist.locator('[role="tab"][aria-selected="true"]').count(), 1);
      assert.equal(await tablist.locator('[role="tab"][tabindex="0"]').count(), 1);
      if (focused) assert(await tab.evaluate(element => document.activeElement === element), 'arrow and boundary keys move tab focus');
      assert(!(await usage.innerText()).includes(token), 'usage examples contain placeholders rather than the issued token');
      assert.equal(await dialog.getByText(token, { exact: true }).count(), 1, 'switching access methods preserves the one-time token until explicitly hidden');
      return panel;
    }
    await selected('MCP');
    await tablist.getByRole('tab', { name: 'MCP', exact: true }).focus();
    for (const [key, name] of [['ArrowRight', 'HTTP API'], ['ArrowRight', 'CLI'], ['ArrowRight', 'MCP'], ['ArrowLeft', 'CLI'], ['Home', 'MCP'], ['End', 'CLI']]) {
      await page.keyboard.press(key); await selected(name, true);
    }

    for (const name of ['MCP', 'HTTP API', 'CLI']) {
      await tablist.getByRole('tab', { name, exact: true }).click();
      const panel = await selected(name);
      const text = await panel.innerText();
      if (name === 'MCP') {
        assert(text.includes(`${origin}/mcp`) && text.includes('Bearer'));
        await panel.getByText('客户端仅支持 stdio？', { exact: true }).click();
        assert.match(await panel.innerText(), /owngate mcp/);
      } else if (name === 'HTTP API') {
        assert(text.includes(`${origin}/api/connections`) && text.includes(`${origin}/api/invoke`));
        assert.match(text, /connection_id/); assert.match(text, /capability_id/);
        assert.doesNotMatch(text, /New API|account\.balance|余额|bilibili/);
        const query = await panel.locator('.client-usage-code').filter({ hasText: '/api/invoke' }).innerText();
        const request = JSON.parse(query.match(/-d\s+'([\s\S]*?)'/)?.[1] ?? 'null');
        assert.deepEqual(request, { connection_id: '<连接ID>', capability_id: '<能力ID>', input: {} });
        const capabilityHelp = panel.locator('details').filter({ hasText: '能力与刷新' });
        assert.equal(await capabilityHelp.evaluate(element => element.open), false, 'capability and polling details stay collapsed during ordinary use');
        await capabilityHelp.locator('summary').click();
        assert((await panel.innerText()).includes(`${origin}/api/connections/<连接ID>/capabilities`));
        assert((await panel.innerText()).includes('"no_cache": true'));
        await screenshot('usage-http-api-capabilities-expanded');
      } else assert(text.includes('login') && text.includes('--server') && text.includes(origin));
      const snippets = panel.locator('.client-usage-snippet');
      let copied = 0;
      for (let index = 0; index < await snippets.count(); index++) {
        const snippet = snippets.nth(index);
        if (!await snippet.isVisible()) continue;
        const expected = await snippet.locator('.client-usage-code').innerText();
        await snippet.getByRole('button', { name: /^复制/ }).click();
        assert.equal(await page.evaluate(() => window.__syntheticClipboard.at(-1)), expected, 'copy returns the exact public example with real newlines');
        copied++;
      }
      report.usageTabs.push({ method: name, copiedSnippets: copied, ariaLinked: true, keyboardNavigation: true, issuedTokenOutsideExamples: true });
      while (await panel.locator('details[open]').count()) await panel.locator('details[open]').first().locator('summary').click();
    }
    assert.equal(await page.evaluate(secret => Object.values(localStorage).concat(Object.values(sessionStorage)).some(value => value.includes(secret)), token), false);
    assert.equal(await page.evaluate(secret => window.__syntheticClipboard.some(value => value.includes(secret)), token), false);

    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [1280, 1920, 390, 320]) {
        await page.setViewportSize({ width, height: width >= 1280 ? 900 : 844 });
        for (const name of ['MCP', 'HTTP API', 'CLI']) {
          await tablist.getByRole('tab', { name, exact: true }).click();
          const panel = await selected(name);
          if (name === 'HTTP API') await panel.getByText('能力与刷新', { exact: true }).click();
          const method = name.toLowerCase().replaceAll(' ', '-');
          await layout(`usage-${method}-${colorScheme}-${width}`);
          assert(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'expanded integration instructions fit the panel');
          const bounds = await dialog.boundingBox();
          assert(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1, 'the usage dialog fits the viewport');
          const last = dialog.getByRole('button', { name: '配置权限', exact: true });
          await last.scrollIntoViewIfNeeded();
          assert(await last.isVisible(), 'the footer action remains reachable on short or narrow screens');
          await screenshot(`usage-${method}-${colorScheme}-${width}`);
          while (await panel.locator('details[open]').count()) await panel.locator('details[open]').first().locator('summary').click();
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 }); await page.emulateMedia({ colorScheme: 'light' });
    await dialog.getByRole('button', { name: '配置权限', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.getByText(token, { exact: true }).count(), 0);
    await clientWorkspace(id).getByRole('button', { name: '接入方法', exact: true }).click();
    await usage.waitFor();
    assert.equal(await tablist.getByRole('tab', { name: 'MCP', exact: true }).getAttribute('aria-selected'), 'true', 'reopening guidance starts with the default method');
    assert(!(await dialog.innerText()).includes(token), 'the one-time token cannot be retrieved by reopening guidance');
    await closeGuide(id);

    // Identity has no implied PII access. The stored grant records all three
    // field choices explicitly and the same choices return after a refresh.
    await edit('grant-newapi');
    const form = row('grant-newapi').locator('form');
    await form.getByRole('checkbox', { name: /^账户余额/ }).check();
    assert.equal(await form.getByRole('checkbox', { name: '个人信息', exact: true }).isChecked(), false);
    assert.equal(await form.getByRole('checkbox', { name: '财务数据', exact: true }).isChecked(), true);
    await form.getByRole('checkbox', { name: '个人信息', exact: true }).check();
    await form.getByRole('checkbox', { name: '财务数据', exact: true }).uncheck();
    await save('grant-newapi');
    await form.waitFor({ state: 'hidden' });
    assert.deepEqual(lastGrant().body.visibility, { pii: true, financial: false, content: true });
    await page.reload(); await chooseClient(id); await edit('grant-newapi');
    assert.equal(await row('grant-newapi').getByRole('checkbox', { name: '个人信息', exact: true }).isChecked(), true);
    assert.equal(await row('grant-newapi').getByRole('checkbox', { name: '财务数据', exact: true }).isChecked(), false);
    await row('grant-newapi').getByRole('button', { name: '取消', exact: true }).click();
  });

  await check('revoking the current client selects another active client and the last revocation leaves a read-only history', async () => {
    let verifyRefreshFailure = true;
    while (clients.some(client => !client.revoked)) {
      const selected = await page.locator('section[data-client-id]').getAttribute('data-client-id');
      assert(selected && clients.some(client => client.id === selected && !client.revoked));
      const beforeGrant = grantPosts();
      clientRefreshFailure = verifyRefreshFailure;
      await clientWorkspace(selected).getByRole('button', { name: '撤销客户端', exact: true }).click();
      await eventually(() => clients.find(client => client.id === selected)?.revoked === true, 'current client revoke reaches the synthetic API');
      const next = clients.find(client => !client.revoked);
      await clientWorkspace(selected).waitFor({ state: 'detached' });
      assert.equal(await clientChoice(selected).count(), 0);
      assert.equal(grantPosts(), beforeGrant, 'revoking a client must not rewrite grants for another client');
      if (next) {
        await clientWorkspace(next.id).waitFor();
        assert.equal(await page.locator('section[data-client-id]').count(), 1);
        if (clients.filter(client => !client.revoked).length > 1) assert.equal(await clientChoice(next.id).getAttribute('aria-pressed'), 'true');
        else assert.equal(await page.locator('[data-client-choice-id]').count(), 0);
      }
      if (verifyRefreshFailure) {
        await page.locator('.inline-notice').getByText('刷新失败，显示上次的授权设置。', { exact: true }).waitFor();
        assert.equal(await clientWorkspace(selected).count(), 0, 'refresh failure must not select the revoked client again');
        await screenshot('desktop-revoked-client-refresh-failure');
        clientRefreshFailure = false;
        await page.locator('.inline-notice').getByRole('button', { name: '重试', exact: true }).click();
        await page.locator('.inline-notice').waitFor({ state: 'hidden' });
        verifyRefreshFailure = false;
      }
    }
    assert.equal(await page.locator('section[data-client-id]').count(), 0);
    assert.equal(await page.locator('[data-client-choice-id], [data-grant-connection-id], .client-usage-guide').count(), 0);
    await page.getByText('暂无可用客户端', { exact: true }).waitFor();
    await page.getByRole('button', { name: '添加客户端', exact: true }).waitFor();
    assert.equal(await history().evaluate(element => element.open), false);
    await screenshot('desktop-all-clients-revoked');
    await history().locator('summary').click();
    for (const client of clients) await history().getByText(client.label, { exact: true }).waitFor();
    assert.equal(await history().locator('button, input, select, textarea, a, form').count(), 0);
    await screenshot('desktop-all-revoked-history', history());
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await layout(`mobile-no-active-${colorScheme}-${width}`);
      }
    }
  });

  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.unexpected, []); assert.equal(held.size, 0);
  assert.deepEqual(await sourceHashes(), report.sourceSha256, 'acceptance source remained unchanged throughout the run');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { stage, message: error instanceof Error ? error.message : String(error) }; process.exitCode = 1;
  if (page) { await screenshot('failure').catch(() => undefined); await writeFile(join(output, 'failure.html'), await page.content()).catch(() => undefined); }
} finally {
  for (const pending of held) pending.release.resolve();
  await browser?.close(); await vite?.close(); await rm(cache, { recursive: true, force: true });
  report.requestCount = requests.length;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, screenshots: report.screenshots.length, requestCount: report.requestCount, output, ...(report.failure ? { failure: report.failure } : {}) }));
}
