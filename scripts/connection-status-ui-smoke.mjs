#!/usr/bin/env node
// The actual Web app, disposable Vite, synthetic APIs and sandboxed Chromium.
// This script never contacts the running service, accounts or platform sites.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let output = join(root, 'out/ui/connection-status');
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--out' && process.argv[index + 1]) output = resolve(process.argv[++index]);
  else if (process.argv[index] === '--help') {
    console.log('Usage: node scripts/connection-status-ui-smoke.mjs [--out SCREENSHOT_DIRECTORY]');
    console.log('Synthetic APIs only; no running service, account, credential or platform access.');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${process.argv[index]}`);
}
await mkdir(output, { recursive: true });
const cache = await mkdtemp(join(tmpdir(), 'owngate-status-vite-'));
const report = { status: 'running', source: 'Actual React source with disposable Vite, sandboxed Chromium and synthetic APIs only; no running service, account, credential or platform access.', checks: [], screenshots: [], layouts: [], requests: [], browserErrors: [], consoleErrors: [], unexpected: [] };
const sourceFiles = ['apps/web/src/pages/ConnectionsPage.tsx', 'apps/web/src/pages/ConnectionDetailPage.tsx', 'apps/web/src/pages/ProductPages.tsx', 'apps/web/src/pages/RemoteLoginPage.tsx', 'apps/web/src/components/StatusBadge.tsx', 'apps/web/src/lib/api.ts', 'apps/web/src/lib/product-api.ts', 'apps/web/src/lib/connection-status.ts'];
async function sourceHashes() { return Object.fromEntries(await Promise.all(sourceFiles.map(async entry => [entry, createHash('sha256').update(await readFile(join(root, entry))).digest('hex')]))); }
report.sourceSha256 = await sourceHashes();
const at = '2026-11-07T08:00:00.000Z';
const capabilities = [
  { id: 'account.profile', title: '账户资料', description: '读取账户资料。' },
  { id: 'model.list', title: '可用模型', description: '读取可见模型。' },
  { id: 'history.list', title: '个人用量记录', description: '读取用量记录。' },
].map(entry => ({ ...entry, kind: 'query', effect: 'read', transport: 'http', support: { status: 'unverified' }, input: { type: 'object', properties: {} }, output: { type: 'object', properties: { value: { type: 'number', title: '合成读数' } } }, cache: null }));
function connection(id, label, status, health, connector_id = 'fixture-http') {
  return { id, label, connector_id, config: {}, scope: 'personal', tags: [], paused: false, health,
    capability_states: Object.fromEntries(capabilities.map(entry => [entry.id, { status }])), created_at: at, updated_at: at };
}
const ready = connection('status-ready', '已有可用能力', 'unverified', { status: 'healthy', reason: '1 项可用 · 2 项待验证' });
ready.capability_states['account.profile'] = { status: 'supported', probed_at: at };
ready.capability_states['history.list'].reason = '能力级原因不应作为连接摘要';
const pending = connection('status-pending', '全新连接', 'unverified', { status: 'unverified', reason: '3 项待验证' });
const login = connection('status-login', '视频平台示例', 'needs_auth', { status: 'needs_auth', reason: '认证检测未通过，请检查登录态。' }, 'fixture-browser');
const isolated = connection('status-isolated', '仅单项认证失败', 'unverified', { status: 'partial', reason: '1 项可用 · 1 项需要认证 · 1 项待验证' });
isolated.capability_states['account.profile'] = { status: 'supported', probed_at: at };
isolated.capability_states['model.list'] = { status: 'needs_auth', reason: '此接口的认证未通过', probed_at: at };
const connections = [ready, pending, login, isolated];
const connectors = [
  { id: 'fixture-http', title: '合成 API', transport: 'http', has_auth: false, has_login: false, config: {} },
  { id: 'fixture-browser', title: '合成浏览器站点', transport: 'browser', has_auth: false, has_login: true, config: {} },
];
let queryPlan = 'success', stage = 'startup', heldRefresh;
function deferred() { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; }
function result(target, capabilityId, failure) {
  return { outcome: failure ? 'error' : 'success', data: failure ? null : { value: 12 }, error: failure ?? null, fields: {},
    source: { connection_id: target.id, connection_label: target.label, capability_id: capabilityId, support: target.capability_states[capabilityId] },
    data_time: at, queried_at: at, cache: null, warnings: [] };
}
function applyQuery(target, capabilityId) {
  if (queryPlan === 'timeout') {
    target.capability_states[capabilityId] = { status: 'unavailable', reason: '上游请求超时，请稍后重试。', probed_at: at };
    target.health = { status: 'partial', reason: '1 项可用 · 1 项暂不可用 · 1 项待验证' };
    return result(target, capabilityId, { code: 'TIMEOUT', message: '上游请求超时，请稍后重试。', retryable: true });
  }
  if (queryPlan === 'parse') {
    target.capability_states[capabilityId] = { status: 'needs_adapter', reason: '站点响应结构已变化。', probed_at: at };
    target.health = { status: 'partial', reason: '1 项可用 · 1 项适配异常 · 1 项待验证' };
    return result(target, capabilityId, { code: 'PARSE_FAILED', message: '站点响应结构已变化。', retryable: false });
  }
  if (queryPlan === 'auth') {
    target.capability_states[capabilityId] = { status: 'needs_auth', reason: '该接口访问凭据未通过验证。', probed_at: at };
    target.health = { status: 'partial', reason: '1 项可用 · 1 项需要认证 · 1 项待验证' };
    return result(target, capabilityId, { code: 'AUTH_REJECTED', message: '该接口访问凭据未通过验证。', retryable: false });
  }
  target.capability_states[capabilityId] = { status: 'supported', probed_at: at };
  if (capabilityId === 'account.profile') {
    for (const [id, state] of Object.entries(target.capability_states)) if (id !== capabilityId && state.status === 'needs_auth') target.capability_states[id] = { status: 'unverified' };
  }
  target.health = { status: 'healthy', reason: capabilityId === 'account.profile' ? '1 项可用 · 2 项待验证' : '2 项可用 · 1 项待验证' };
  return result(target, capabilityId);
}
let vite, browser, page, origin;
async function check(name, run) { stage = name; await run(); report.checks.push(name); }
const card = id => page.locator(`.capability-card[data-capability-id="${id}"]`);
const summaryCard = label => page.locator('.connections-grid > li').filter({ has: page.getByText(label, { exact: true }) });
const count = path => report.requests.filter(entry => entry.path === path).length;
async function screenshot(name) { await page.screenshot({ path: join(output, `${name}.png`), fullPage: true, animations: 'disabled' }); report.screenshots.push(`${name}.png`); }
async function layout(name) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  report.layouts.push({ name, ...dimensions }); assert(dimensions.scrollWidth <= dimensions.width + 1, `${name}: horizontal overflow`);
}
async function navigate(label, heading) {
  await page.locator('.nav:visible').getByRole('link', { name: label, exact: true }).click();
  await page.getByRole('heading', { name: heading, exact: true }).waitFor();
}
async function openCapability(id) {
  await card(id).getByRole('button', { name: /^(试一下|查看结果|查看详情)$/ }).click();
  const dialog = page.getByRole('dialog', { name: capabilities.find(entry => entry.id === id).title, exact: true });
  await dialog.waitFor(); return dialog;
}
async function closeCapability(id) {
  await page.getByRole('dialog', { name: capabilities.find(entry => entry.id === id).title, exact: true }).getByRole('button', { name: `关闭${capabilities.find(entry => entry.id === id).title}`, exact: true }).click();
}
async function submitCapability(id, expectedState, endpoint) {
  const dialog = await openCapability(id), before = count('/admin/connections');
  const response = page.waitForResponse(item => new URL(item.url()).pathname === endpoint && item.request().method() === 'POST');
  await dialog.getByRole('button', { name: /^(试一下|验证并试查)$/ }).click();
  assert.equal((await response).status(), 200);
  await card(id).locator('.capability-card-heading .status').filter({ hasText: expectedState }).waitFor();
  assert(count('/admin/connections') > before, 'a completed query must refresh persisted connection status');
  return dialog;
}

try {
  const webRequire = createRequire(join(root, 'apps/web/package.json'));
  const browserRequire = createRequire(join(root, 'apps/browser/package.json'));
  const { createServer } = await import(pathToFileURL(join(dirname(webRequire.resolve('vite/package.json')), 'dist/node/index.js')).href);
  const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href);
  const { chromium } = browserRequire('playwright');
  vite = await createServer({ root: join(root, 'apps/web'), configFile: false, plugins: [react()], cacheDir: cache, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await vite.listen(); origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'zh-CN' });
  page = await context.newPage(); page.setDefaultTimeout(7000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { report.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    if (!/^\/(?:admin|auth|api|ws)(?:\/|$)/.test(url.pathname)) return route.continue();
    const method = request.method(), path = url.pathname, body = request.postData() ? request.postDataJSON() : undefined;
    report.requests.push({ method, path, ...(body?.capability_id ? { capability: body.capability_id } : {}) });
    const targetId = /^\/admin\/connections\/([^/]+)/.exec(path)?.[1] ?? /^\/admin\/probe\/([^/]+)/.exec(path)?.[1] ?? body?.connection_id;
    const target = connections.find(entry => entry.id === targetId);
    let response;
    if (path === '/auth/status') response = { hasUser: true, authenticated: true, stepUp: true, totpEnabled: true, passkeyCount: 0 };
    else if (path === '/admin/connections' && method === 'GET') { if (heldRefresh) await heldRefresh.promise; response = { connections }; }
    else if (path === '/admin/connectors') response = { connectors };
    else if (path === '/admin/capabilities') response = { capabilities };
    else if (path === '/admin/overview') response = { connections: connections.map(({ id, label, health }) => ({ id, label, health })), tasks: [], pending_proposals: 0, alerts: [], actions_enabled: false };
    else if (target && method === 'POST' && (path === '/admin/invoke' || path.endsWith('/verify'))) {
      const capabilityId = body?.capability_id ?? 'account.profile';
      const envelope = applyQuery(target, capabilityId);
      response = path === '/admin/invoke' ? envelope : { verified: envelope.outcome !== 'error', capability_states: target.capability_states, results: { [capabilityId]: envelope } };
    } else if (target && path.startsWith('/admin/probe/') && method === 'POST') {
      target.capability_states = Object.fromEntries(capabilities.map(entry => [entry.id, { status: entry.id === 'account.profile' ? 'supported' : 'unverified', ...(entry.id === 'account.profile' ? { probed_at: at } : {}) }]));
      target.health = { status: 'healthy', reason: '1 项可用 · 2 项待验证' };
      response = { connectionId: target.id, status: 'supported' };
    } else if (target && path.endsWith('/state') && method === 'PATCH') {
      target.paused = body.paused; target.health = body.paused ? { status: 'paused', reason: '连接已暂停' } : { status: 'healthy', reason: '2 项可用 · 1 项待验证' }; response = target;
    } else { report.unexpected.push(`${method} ${path}`); return route.fulfill({ status: 500, json: { message: 'Unknown fixture request' } }); }
    return route.fulfill({ status: 200, json: structuredClone(response) });
  });
  await page.goto(`${origin}/connections`);
  await page.getByRole('heading', { name: '连接', exact: true }).waitFor();

  await check('connection badges and reasons use the same server summary', async () => {
    await summaryCard(ready.label).locator('.status').filter({ hasText: '正常' }).waitFor();
    assert.equal(await summaryCard(ready.label).getByText(ready.health.reason, { exact: true }).count(), 1);
    assert.equal(await page.getByText('能力级原因不应作为连接摘要', { exact: true }).count(), 0);
    assert.equal(await summaryCard(pending.label).locator('.status').innerText(), '待验证');
    assert.equal(await summaryCard(login.label).locator('.status').innerText(), '需要认证');
    assert.equal(await summaryCard(isolated.label).locator('.status').innerText(), '部分可用');
    assert.equal(await page.getByText('需要重新登录', { exact: true }).count(), 0);
    await screenshot('list-initial-light-1280');
  });
  await summaryCard(ready.label).getByRole('button', { name: '查看', exact: true }).click();
  await page.getByRole('heading', { name: ready.label, exact: true }).waitFor();

  await check('implemented capabilities are pending verification without an adapter failure label', async () => {
    assert.equal(await card('model.list').locator('.status').innerText(), '待验证');
    assert.equal(await page.getByText('尚未适配', { exact: true }).count(), 0);
    const dialog = await openCapability('model.list');
    await dialog.getByRole('button', { name: '可用模型查询说明', exact: true }).click();
    await page.getByRole('tooltip').getByText('尚未在此连接上验证，试查后会更新状态。', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '可用模型查询说明', exact: true }).click();
    await closeCapability('model.list');
  });
  await check('verification results wait for refreshed persisted status rather than changing badges locally', async () => {
    const dialog = await openCapability('model.list'); heldRefresh = deferred();
    const before = count('/admin/connections');
    await dialog.getByRole('button', { name: '验证并试查', exact: true }).click();
    await dialog.getByRole('group', { name: '查询结果', exact: true }).waitFor();
    assert.equal(await card('model.list').locator('.capability-card-heading .status').innerText(), '待验证');
    heldRefresh.release(); heldRefresh = undefined;
    await card('model.list').locator('.capability-card-heading .status').filter({ hasText: '可用' }).waitFor();
    assert(count('/admin/connections') > before);
    assert.equal(await card('history.list').locator('.status').innerText(), '待验证');
    await closeCapability('model.list'); await screenshot('detail-verified-light-1280');
  });
  await check('ordinary invocation failures refresh status and distinguish timeout from adaptation', async () => {
    queryPlan = 'timeout';
    let dialog = await submitCapability('model.list', '暂不可用', '/admin/invoke');
    await dialog.getByRole('alert').filter({ hasText: '上游请求超时' }).waitFor();
    assert.equal(await card('model.list').locator('.capability-card-heading .status').innerText(), '暂不可用');
    await closeCapability('model.list');
    queryPlan = 'parse';
    dialog = await submitCapability('model.list', '适配异常', `/admin/connections/${ready.id}/verify`);
    await dialog.getByRole('alert').filter({ hasText: '站点响应结构已变化' }).waitFor();
    await closeCapability('model.list'); await screenshot('detail-failed-light-1280');
  });
  await check('retry recovers the capability and connection list without marking untested siblings available', async () => {
    queryPlan = 'success';
    await submitCapability('model.list', '可用', `/admin/connections/${ready.id}/verify`);
    await closeCapability('model.list');
    assert.equal(await card('history.list').locator('.status').innerText(), '待验证');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await summaryCard(ready.label).locator('.status').filter({ hasText: '正常' }).waitFor();
    assert.equal(await summaryCard(ready.label).getByText('2 项可用 · 1 项待验证', { exact: true }).count(), 1);
  });
  await check('overview consumes server summaries without capability state inference', async () => {
    await navigate('概览', '概览');
    const panel = page.locator('.overview-connections');
    await panel.getByRole('link', { name: ready.label, exact: true }).waitFor();
    assert.equal(await panel.locator('li').filter({ hasText: ready.label }).locator('.status').innerText(), '正常');
    assert.equal(await panel.locator('li').filter({ hasText: isolated.label }).locator('.status').innerText(), '部分可用');
    assert.equal(await panel.locator('li').filter({ hasText: login.label }).locator('.status').innerText(), '需要认证');
    await screenshot('overview-status-light-1280');
  });
  await check('a single capability auth failure does not label the whole usable connection unauthenticated', async () => {
    await navigate('连接', '连接'); await summaryCard(ready.label).getByRole('button', { name: '查看', exact: true }).click();
    queryPlan = 'auth';
    await submitCapability('model.list', '需要认证', '/admin/invoke'); await closeCapability('model.list');
    assert.equal(await card('account.profile').locator('.status').innerText(), '可用');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await summaryCard(ready.label).locator('.status').filter({ hasText: '部分可用' }).waitFor();
    assert.equal(await summaryCard(ready.label).getByText('1 项可用 · 1 项需要认证 · 1 项待验证', { exact: true }).count(), 1);
  });
  await check('successful login probing clears stale auth badges and leaves other capabilities pending', async () => {
    await summaryCard(login.label).getByRole('button', { name: '查看', exact: true }).click();
    await page.getByRole('button', { name: '立即检测登录态', exact: true }).waitFor();
    const before = count('/admin/connections'); await page.getByRole('button', { name: '立即检测登录态', exact: true }).click();
    await card('account.profile').locator('.status').filter({ hasText: '可用' }).waitFor();
    assert.equal(await card('model.list').locator('.status').innerText(), '待验证');
    assert.equal(await card('history.list').locator('.status').innerText(), '待验证');
    assert(count('/admin/connections') > before);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await summaryCard(login.label).locator('.status').filter({ hasText: '正常' }).waitFor();
    await screenshot('list-after-login-light-1280');
  });
  await check('new status labels fit desktop and mobile layouts in both themes', async () => {
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [1280, 1920, 390, 320]) {
        await page.setViewportSize({ width, height: 900 }); await layout(`list-${colorScheme}-${width}`); await screenshot(`list-${colorScheme}-${width}`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await summaryCard(ready.label).getByRole('button', { name: '查看', exact: true }).click();
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [1280, 1920, 390, 320]) {
        await page.setViewportSize({ width, height: 900 }); await layout(`detail-${colorScheme}-${width}`); await screenshot(`detail-${colorScheme}-${width}`);
      }
    }
  });
  assert.deepEqual(await sourceHashes(), report.sourceSha256, 'tested Web source must remain unchanged throughout the run');
  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.unexpected, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.stage = stage; report.error = error.stack ?? error.message; process.exitCode = 1;
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  heldRefresh?.release(); await browser?.close(); await vite?.close(); await rm(cache, { recursive: true, force: true });
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, stage: report.stage, checks: report.checks.length, screenshots: report.screenshots.length, requests: report.requests.length, layouts: report.layouts.length, error: report.error }));
}
