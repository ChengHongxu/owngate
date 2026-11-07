#!/usr/bin/env node
// The real Web app with synthetic admin responses, a disposable Vite server
// and sandboxed Chromium. Never connects to the running service or accounts.
import assert from 'node:assert/strict';
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
    console.log('Usage: node scripts/connection-ui-smoke.mjs [--out SCREENSHOT_DIRECTORY]');
    console.log('Actual Web app with synthetic responses; no running service, real accounts or credentials.');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${process.argv[i]}`);
}
await mkdir(join(root, 'out/ui'), { recursive: true });
output ??= await mkdtemp(join(root, 'out/ui/connection-'));
await mkdir(output, { recursive: true });
const cache = await mkdtemp(join(tmpdir(), 'owngate-connection-vite-'));
const report = {
  status: 'running',
  source: 'Actual Web app served by disposable local Vite with synthetic admin responses only; no running service, real account or credential access.',
  checks: [], screenshots: [], layouts: [], geometry: [], verification: [], browserErrors: [], consoleErrors: [], unexpected: [], requestCount: 0,
};
const at = '2026-11-03T08:00:00.000Z';
const connection = {
  id: 'fixture-detail', connector_id: 'bilibili', label: '连接详情示例', scope: 'personal', tags: ['社交'], paused: false,
  health: { status: 'partial', reason: '4项可用 · 1项待验证 · 1项不支持' },
  config: { base_url: 'https://www.bilibili.com', egress_strict: false },
  capability_states: { 'account.profile': { status: 'supported' }, 'history.list': { status: 'unverified' }, 'search.list': { status: 'supported' }, 'report.list': { status: 'supported' }, 'notes.list': { status: 'supported' }, 'blocked.read': { status: 'unsupported', reason: '合成站点未提供这个接口，请查看该能力的说明。' } }, created_at: at, updated_at: at,
};
const otherConnection = structuredClone({ ...connection, id: 'fixture-other', label: '另一个连接', tags: ['独立配置'] });
const connections = [connection, otherConnection];
const connector = {
  id: 'bilibili', title: '哔哩哔哩', transport: 'browser', has_auth: true, has_login: true,
  config: { base_url: { type: 'string', format: 'uri', label: '站点地址' }, egress_strict: { type: 'boolean', label: '仅允许站点域名', default: false } },
  auth: { type: 'bearer', fields: { api_key: { type: 'string', secret: true, label: '访问令牌', required: true } } },
};
const capabilities = [
  { id: 'account.profile', title: '账户资料', description: '读取登录账号资料。', kind: 'query', effect: 'read', transport: 'browser', support: { status: 'supported' }, input: {}, output: {}, cache: null },
  { id: 'history.list', title: '观看历史', description: '读取历史列表。', kind: 'query', effect: 'read', transport: 'browser', support: { status: 'unverified' },
    input: { type: 'object', properties: { limit: { type: 'integer', title: '条目数', default: 3, minimum: 1, maximum: 100 } } }, output: {}, cache: null },
  { id: 'search.list', title: '检索内容', description: '带两个普通参数的合成查询。', kind: 'query', effect: 'read', transport: 'http', support: { status: 'supported' },
    input: { type: 'object', properties: { keyword: { type: 'string', title: '关键词', default: '本地示例' }, category: { type: 'string', title: '分类', enum: ['all', 'video'], default: 'all' } } }, output: {}, cache: null },
  { id: 'report.list', title: '记录查询', description: '带四个参数的合成查询。', kind: 'query', effect: 'read', transport: 'http', support: { status: 'supported' },
    input: { type: 'object', properties: { limit: { type: 'integer', title: '最大条数', default: 10 }, start: { type: 'string', title: '起始日期', default: '2026-11-01' }, end: { type: 'string', title: '截止日期', default: '2026-11-03' }, archived: { type: 'boolean', title: '包含归档', default: false } } }, output: {}, cache: null },
  { id: 'notes.list', title: '筛选记录', description: '带 JSON 文本域的合成只读查询。', kind: 'query', effect: 'read', transport: 'http', support: { status: 'supported' },
    input: { type: 'object', properties: { filter: { type: 'object', title: '筛选 JSON', default: { category: 'fixture' }, properties: { category: { type: 'string' } } } } }, output: {}, cache: null },
  { id: 'blocked.read', title: '尚不支持的查询', description: '当前不可执行，不能发送合成查询请求。', kind: 'query', effect: 'read', transport: 'http', support: { status: 'unsupported' }, input: {}, output: {}, cache: null },
];
const client = { id: 'fixture-client', label: '示例 AI 客户端', revoked: false, created_at: at, expires_at: null };
let sequence = 0;
function envelope(target, id, { failed = id === 'history.list', nickname = '示例账号' } = {}) {
  const steps = [
    { id: 'request.validate', label: '检查连接与权限', status: 'success', duration_ms: 1 },
    { id: 'request.input', label: '校验查询参数', status: 'success', duration_ms: 1 },
    { id: 'request.execute', label: '执行连接能力', status: failed ? 'error' : 'success', duration_ms: 297 },
    { id: 'transport.browser', label: '调用浏览器 Worker', status: failed ? 'error' : 'success', duration_ms: 296 },
    { id: 'browser.navigate', label: '打开目标页面', status: 'success', duration_ms: 35 },
    { id: 'browser.capture', label: '捕获预期响应', status: failed ? 'error' : 'success', duration_ms: 260,
      ...(failed ? { code: 'PARSE_FAILED', detail: '页面未发出已知的历史响应' } : {}) },
    ...(!failed ? [{ id: 'browser.parse', label: '解析响应数据', status: 'success', duration_ms: 1 }, { id: 'request.output', label: '校验返回数据', status: 'success', duration_ms: 1 }] : []),
    { id: 'request.result', label: '返回查询结果', status: 'success', duration_ms: 1 },
  ];
  return {
    outcome: failed ? 'error' : 'success', data: failed ? null : { nickname }, fields: {},
    error: failed ? { code: 'PARSE_FAILED', message: '页面未发出已知的历史响应', details: { next_step: '检查站点历史页面' } } : null,
    source: { connection_id: target.id, connection_label: target.label, capability_id: id },
    data_time: at, queried_at: at, cache: null, warnings: [],
    execution: { id: `fixture-${++sequence}`, started_at: at, duration_ms: 300, steps },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const plans = new Map(), held = new Set(), requests = [];
function plan(capabilityId, options = {}) {
  const entry = { ...options, arrived: deferred(), released: deferred(), finished: deferred() };
  const queue = plans.get(capabilityId) ?? [];
  queue.push(entry); plans.set(capabilityId, queue);
  if (options.hold) held.add(entry);
  else entry.released.resolve();
  return entry;
}
let vite, browser, page, stage = 'startup', rejectConfig = true;
async function check(name, action) { stage = name; await action(); report.checks.push(name); }
async function fixtureEvent(event, description) {
  let timer;
  try {
    await Promise.race([event.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 7000);
    })]);
  } finally { clearTimeout(timer); }
}
async function nextPaint() { await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); }
async function screenshot(name) {
  await page.evaluate(() => {
    scrollTo({ top: 0, left: 0, behavior: 'instant' });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await nextPaint();
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: await page.locator('dialog[open]').count() === 0, animations: 'disabled' });
  report.screenshots.push(`${name}.png`);
}
async function layout(name) {
  const bounds = await page.evaluate(() => {
    const dialog = document.querySelector('dialog[open]:has([data-capability-workspace])');
    const content = dialog?.querySelector('.page-dialog-content');
    const rect = dialog?.getBoundingClientRect();
    return { width: innerWidth, document: document.documentElement.scrollWidth, height: innerHeight,
      ...(rect ? { dialog: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, content: { width: content.clientWidth, scrollWidth: content.scrollWidth } } : {}) };
  });
  report.layouts.push({ name, ...bounds });
  assert(bounds.document <= bounds.width + 1, `${name}: horizontal overflow`);
  if (bounds.dialog) {
    assert(bounds.dialog.left >= -1 && bounds.dialog.right <= bounds.width + 1, `${name}: capability dialog exceeds viewport width`);
    assert(bounds.dialog.top >= -1 && bounds.dialog.bottom <= bounds.height + 1, `${name}: capability dialog exceeds viewport height`);
    assert(bounds.content.scrollWidth <= bounds.content.width + 1, `${name}: capability workspace overflows horizontally`);
  }
}
const card = id => page.locator(`.capability-card[data-capability-id="${id}"]`);
const profile = () => card('account.profile');
const history = () => card('history.list');
const panel = id => page.getByRole('dialog', { name: capabilities.find(capability => capability.id === id).title, exact: true });
async function openCapability(id) {
  const count = queryCount();
  await card(id).locator('.capability-open').click();
  await panel(id).waitFor();
  assert.equal(queryCount(), count, 'opening a capability must not run or retry its query');
  return panel(id);
}
async function closeCapability(id) {
  await panel(id).getByRole('button', { name: `关闭${capabilities.find(capability => capability.id === id).title}`, exact: true }).click();
  await panel(id).waitFor({ state: 'hidden' }).catch(error => { throw new Error(`${id} dismissal via close button: ${error.message}`); });
}
async function runCapability(id) { await panel(id).getByRole('button', { name: /^(?:试一下|验证并试查)$/ }).click(); }
const queryCount = () => requests.filter(request => request.path === '/admin/invoke' || request.path.endsWith('/verify')).length;
const taskCount = () => requests.filter(request => request.path === '/admin/tasks' && request.method === 'POST').length;
async function geometry() {
  await nextPaint();
  return page.evaluate(() => ({ width: innerWidth, height: document.documentElement.scrollHeight, cards: Array.from(document.querySelectorAll('.capability-card[data-capability-id]')).map(element => { const bounds = element.getBoundingClientRect(); return { id: element.getAttribute('data-capability-id'), x: bounds.x + scrollX, y: bounds.y + scrollY, width: bounds.width, height: bounds.height }; }) }));
}
async function unchanged(name, baseline) {
  const value = await geometry(); report.geometry.push({ name, ...value });
  assert.equal(value.cards.length, capabilities.length);
  assert(Math.abs(value.height - baseline.height) <= 1, `${name}: page height changed`);
  for (const expected of baseline.cards) {
    const actual = value.cards.find(entry => entry.id === expected.id); assert(actual);
    for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(actual[key] - expected[key]) <= 1, `${name}: ${expected.id} ${key} changed from ${expected[key]} to ${actual[key]}`);
  }
  await layout(name);
}

try {
  const webRequire = createRequire(join(root, 'apps/web/package.json'));
  const browserRequire = createRequire(join(root, 'apps/browser/package.json'));
  const { createServer } = await import(pathToFileURL(join(dirname(webRequire.resolve('vite/package.json')), 'dist/node/index.js')).href);
  const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href);
  const { chromium } = browserRequire('playwright');
  // No dev proxy: even an unexpected admin request cannot reach a live backend.
  vite = await createServer({ root: join(root, 'apps/web'), configFile: false, plugins: [react()], cacheDir: cache,
    server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await vite.listen();
  const address = vite.httpServer.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource: the server responded with a status of 503/.test(message.text())) report.consoleErrors.push(message.text()); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { report.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    if (!/^\/(?:admin|auth|api|ws)(?:\/|$)/.test(url.pathname)) return route.continue();
    const method = request.method(), path = url.pathname;
    const body = request.postData() ? request.postDataJSON() : undefined;
    requests.push({ method, path, capability: body?.capability_id, ...(body ? { body } : {}) });
    const targetId = /^\/admin\/connections\/([^/]+)/.exec(path)?.[1] ?? body?.connection_id ?? connection.id;
    const target = connections.find(entry => entry.id === targetId);
    let result, status = 200, activePlan;
    try {
      if (path === '/auth/status' && method === 'GET') result = { hasUser: true, authenticated: true, stepUp: true, totpEnabled: true, passkeyCount: 0 };
      else if (path === '/admin/connections' && method === 'GET') {
        activePlan = plans.get('connections.refresh')?.shift();
        activePlan?.arrived.resolve();
        if (activePlan) await activePlan.released.promise;
        if (activePlan?.transportFailure) {
          status = 503; result = { code: 'FIXTURE_UNAVAILABLE', message: '本地连接列表暂时不可用' };
        } else result = { connections };
      }
      else if (path === '/admin/connectors' && method === 'GET') result = { connectors: [connector] };
      else if (path === '/admin/capabilities' && method === 'GET') result = { capabilities };
      else if (path === '/admin/clients' && method === 'GET') result = { clients: [client] };
      else if (path === '/admin/grants' && method === 'GET') result = { grants: [] };
      else if (target && path.endsWith('/credentials') && method === 'GET') result = { fields: [{ key: 'api_key', updated_at: at }] };
      else if (path === '/admin/tasks' && method === 'POST') result = { task_id: `fixture-task-${taskCount()}`, status: 'pending' };
      else if (target && method === 'POST' && (path === '/admin/invoke' || path.endsWith('/verify'))) {
        const id = body?.capability_id;
        if (id) {
          activePlan = plans.get(id)?.shift();
          activePlan?.arrived.resolve();
          if (activePlan) await activePlan.released.promise;
          if (activePlan?.transportFailure) {
            status = 503; result = { code: 'FIXTURE_UNAVAILABLE', message: '本地夹具暂时不可用', next_step: '稍后重试此能力' };
          } else {
            const current = envelope(target, id, activePlan);
            result = path === '/admin/invoke' ? current : { verified: current.outcome === 'success', capability_states: target.capability_states, results: { [id]: current } };
          }
        } else {
          activePlan = plans.get('connection.verify')?.shift();
          activePlan?.arrived.resolve();
          if (activePlan) await activePlan.released.promise;
          if (activePlan?.transportFailure) {
            status = 503; result = { code: 'FIXTURE_UNAVAILABLE', message: '本地夹具暂时不可用', next_step: '稍后重新验证此连接' };
          } else {
            const results = Object.fromEntries(capabilities.filter(capability => !['unsupported', 'disabled'].includes(target.capability_states[capability.id].status)).map(capability => [capability.id, envelope(target, capability.id, activePlan)]));
            result = { verified: Object.values(results).every(entry => entry.outcome === 'success'), capability_states: target.capability_states, results };
          }
        }
      } else if (target && path.endsWith('/state') && method === 'PATCH') {
        Object.assign(target, body); result = target;
      } else if (target && path === `/admin/connections/${target.id}` && method === 'PATCH') {
        if (rejectConfig) { status = 503; result = { code: 'FIXTURE_REFUSED', message: '本地夹具拒绝保存' }; }
        else { Object.assign(target, body); result = target; }
      } else {
        report.unexpected.push(`${method} ${path}`); status = 500; result = { message: 'Unknown fixture request' };
      }
      await route.fulfill({ status, json: structuredClone(result) });
    } finally {
      activePlan?.finished.resolve();
      if (activePlan) held.delete(activePlan);
    }
  });
  await page.goto(`${origin}/connections/${connection.id}`);
  await page.getByRole('heading', { name: connection.label, exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑凭据', exact: true }).waitFor();

  await check('connection metadata is compact by default and permission entry carries context', async () => {
    assert.equal(await page.getByLabel('名称', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('账户范围', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('访问令牌', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('tooltip').count(), 0);
    assert.equal(await page.getByRole('button', { name: '接入说明', exact: true }).count(), 1);
    const href = await page.getByRole('link', { name: '客户端与权限', exact: true }).getAttribute('href');
    assert.equal(new URL(href, origin).searchParams.get('connection_id'), connection.id);
    await layout('desktop-default'); await screenshot('desktop-default');
  });

  await check('six different capability shapes keep equal cards and unchanged positions through every workspace state', async () => {
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [1280, 1920, 390, 320]) {
        await page.setViewportSize({ width, height: width >= 1280 ? 1000 : 844 });
        await page.reload(); await card('blocked.read').waitFor(); await page.getByRole('button', { name: '编辑凭据', exact: true }).waitFor();
        const baseline = await geometry(), name = `${colorScheme}-${width}`;
        assert.equal(baseline.cards.length, 6);
        assert(Math.max(...baseline.cards.map(entry => entry.width)) - Math.min(...baseline.cards.map(entry => entry.width)) <= 1, `${name}: all cards need equal width`);
        assert(Math.max(...baseline.cards.map(entry => entry.height)) - Math.min(...baseline.cards.map(entry => entry.height)) <= 1, `${name}: all cards need equal height`);
        assert.equal(await page.locator('.capability-card form, .capability-card textarea, .capability-card input, .capability-card .capability-result').count(), 0, 'cards must not contain expanded workspaces');
        await unchanged(`${name}-idle`, baseline);
        if (width === 1280 || width === 1920 || width === 390) await screenshot(`cards-${name}`);

        const beforeOpen = queryCount(), beforeTasks = taskCount();
        await openCapability('notes.list');
        const draft = '{\n  "category": "仅本地草稿"\n}';
        await panel('notes.list').getByLabel('筛选 JSON', { exact: true }).fill(draft);
        await unchanged(`${name}-textarea-draft-open`, baseline);
        await closeCapability('notes.list');
        await unchanged(`${name}-textarea-draft-closed`, baseline);
        assert(await card('notes.list').locator('.capability-open').evaluate(element => element === document.activeElement), 'closing restores the capability opener');
        await openCapability('notes.list');
        assert.equal(await panel('notes.list').getByLabel('筛选 JSON', { exact: true }).inputValue(), draft);
        assert.equal(queryCount(), beforeOpen); assert.equal(taskCount(), beforeTasks);
        await closeCapability('notes.list');

        const pending = plan('account.profile', { hold: true, nickname: `稳定结果-${name}` });
        await openCapability('account.profile'); await runCapability('account.profile'); await fixtureEvent(pending.arrived, 'geometry profile request arrives');
        await unchanged(`${name}-pending-open`, baseline);
        await closeCapability('account.profile');
        await unchanged(`${name}-pending-closed`, baseline);
        assert.match(await profile().locator('.capability-open').innerText(), /查看进度/);
        const pendingCount = queryCount(); await openCapability('account.profile');
        assert(await panel('account.profile').getByRole('button', { name: '查询中…', exact: true }).isDisabled());
        assert(await panel('account.profile').getByRole('button', { name: '作为任务查询', exact: true }).isDisabled(), 'a running query prevents concurrent task submission for the same capability');
        assert.equal(queryCount(), pendingCount, 'reopening pending work must not repeat the request');
        pending.released.resolve(); await panel('account.profile').getByText(`稳定结果-${name}`, { exact: true }).waitFor();
        await unchanged(`${name}-result-open`, baseline);
        if ((width === 1280 && colorScheme === 'light') || (width === 390 && colorScheme === 'dark')) await screenshot(`result-${name}`);
        await closeCapability('account.profile'); await unchanged(`${name}-result-closed`, baseline);
        if (width === 1280) await screenshot(`result-closed-${name}`);
        const completedCount = queryCount(); await openCapability('account.profile');
        await panel('account.profile').getByText(`稳定结果-${name}`, { exact: true }).waitFor();
        assert.equal(queryCount(), completedCount);

        plan('account.profile', { transportFailure: true }); await runCapability('account.profile');
        await panel('account.profile').locator('.query-request-failure').getByText('调用失败：本地夹具暂时不可用', { exact: true }).waitFor();
        await unchanged(`${name}-error-open`, baseline); await closeCapability('account.profile');
        await unchanged(`${name}-error-closed`, baseline);
        const failureCount = queryCount(); await openCapability('account.profile');
        await panel('account.profile').locator('.query-request-failure').waitFor(); assert.equal(queryCount(), failureCount);
        await closeCapability('account.profile');

        await openCapability('search.list');
        await panel('search.list').getByLabel('关键词', { exact: true }).fill('只读任务草稿');
        await panel('search.list').getByRole('button', { name: '作为任务查询', exact: true }).click();
        await panel('search.list').getByRole('status').filter({ hasText: /任务已排队/ }).waitFor();
        await unchanged(`${name}-task-receipt-open`, baseline); await closeCapability('search.list');
        await unchanged(`${name}-task-receipt-closed`, baseline);
        const submitted = taskCount(); await openCapability('search.list');
        assert.equal(await panel('search.list').getByLabel('关键词', { exact: true }).inputValue(), '只读任务草稿');
        await panel('search.list').getByRole('status').filter({ hasText: /任务已排队/ }).waitFor();
        assert.equal(taskCount(), submitted); await closeCapability('search.list');

        await openCapability('blocked.read');
        const blockedRun = panel('blocked.read').getByRole('button', { name: /^(?:试一下|验证并试查)$/ });
        assert(await blockedRun.count() === 0 || await blockedRun.isDisabled());
        await closeCapability('blocked.read');
        assert.equal(requests.filter(request => request.capability === 'blocked.read').length, 0);
        await unchanged(`${name}-unsupported-closed`, baseline);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 }); await page.emulateMedia({ colorScheme: 'light' });
    await page.reload(); await card('blocked.read').waitFor();
  });

  await check('capability dialogs keep focus, ignore Escape and backdrop clicks, and preserve drafts until explicitly closed', async () => {
    const before = queryCount(), beforeTasks = taskCount(), baseline = await geometry();
    await openCapability('report.list');
    const dialog = panel('report.list');
    assert(await dialog.evaluate(element => element instanceof HTMLDialogElement && element.matches(':modal')));
    await dialog.getByLabel('起始日期', { exact: true }).fill('2026-10-31');
    await screenshot('multiple-parameters-desktop');
    await dialog.getByRole('heading', { name: '记录查询', exact: true }).click();
    const controls = await dialog.locator('button, input, select, textarea, a[href], summary').count();
    for (let index = 0; index < controls + 3; index++) {
      await page.keyboard.press('Tab');
      assert(await dialog.evaluate(element => element.contains(document.activeElement) || (!document.hasFocus() && document.activeElement === document.body)), 'page focus must stay in the modal; browser chrome may receive focus');
    }
    // Native Tab navigation can reach browser chrome. Return to the renderer
    // before testing Escape, which otherwise belongs to the browser window.
    await dialog.getByRole('heading', { name: '记录查询', exact: true }).click();
    await page.getByRole('button', { name: '编辑连接配置', exact: true, includeHidden: true }).evaluate(element => element.focus());
    assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'background editing cannot receive focus');
    await page.keyboard.press('Escape');
    assert(await dialog.isVisible(), 'Escape must not discard an open capability workspace');
    assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'Escape keeps keyboard focus in the workspace');
    assert.equal(await dialog.getByLabel('起始日期', { exact: true }).inputValue(), '2026-10-31');
    await page.mouse.click(2, 2);
    assert(await dialog.isVisible(), 'backdrop clicks must not discard an open capability workspace');
    assert.equal(await dialog.getByLabel('起始日期', { exact: true }).inputValue(), '2026-10-31');
    await closeCapability('report.list');
    assert(await card('report.list').locator('.capability-open').evaluate(element => element === document.activeElement));
    await openCapability('report.list');
    assert.equal(await dialog.getByLabel('起始日期', { exact: true }).inputValue(), '2026-10-31');
    await closeCapability('report.list');
    assert.equal(queryCount(), before); assert.equal(taskCount(), beforeTasks);
    await unchanged('explicit-workspace-dismissal', baseline);
  });

  await check('capability workspaces own their result and capture failure identifies the actual observed node', async () => {
    await openCapability('account.profile'); await runCapability('account.profile');
    await panel('account.profile').getByRole('group', { name: '查询结果' }).waitFor();
    assert.equal(await panel('account.profile').getByText('示例账号', { exact: true }).count(), 1);
    assert.equal(await panel('account.profile').locator('.execution-trace').evaluate(element => element.open), false);
    await closeCapability('account.profile');
    await openCapability('history.list'); await runCapability('history.list');
    await panel('history.list').getByRole('group', { name: '查询结果' }).waitFor();
    assert.equal(await panel('history.list').getByText('检查站点历史页面', { exact: false }).count(), 1);
    assert.equal(await panel('history.list').locator('.query-error-code').innerText(), 'PARSE_FAILED');
    assert.equal(await page.locator('dialog[open] [data-capability-workspace]').count(), 1);
    assert.equal(await panel('history.list').locator('.execution-trace').evaluate(element => element.open), true);
    assert.equal(await panel('history.list').getByText('停在「捕获预期响应」', { exact: true }).count(), 1);
    assert.equal(await panel('history.list').locator('.execution-step-label').filter({ hasText: '解析响应数据' }).count(), 0);
    await layout('desktop-results'); await screenshot('desktop-results');
    await page.setViewportSize({ width: 390, height: 844 });
    await layout('mobile-results'); await screenshot('mobile-results');
    await closeCapability('history.list');
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await check('two capabilities can run concurrently and resolve independently', async () => {
    const first = plan('account.profile', { hold: true, nickname: '并行资料' });
    const second = plan('history.list', { hold: true });
    await openCapability('account.profile'); await runCapability('account.profile');
    await fixtureEvent(first.arrived, 'profile request arrives');
    assert(await panel('account.profile').getByRole('button', { name: '查询中…', exact: true }).isDisabled());
    await closeCapability('account.profile');
    await openCapability('history.list'); await runCapability('history.list');
    await fixtureEvent(second.arrived, 'history request arrives');
    assert.equal(await page.getByRole('button', { name: '查询中…', exact: true }).count(), 1);
    await closeCapability('history.list');
    second.released.resolve();
    await openCapability('history.list'); await panel('history.list').getByRole('group', { name: '查询结果' }).waitFor(); await closeCapability('history.list');
    await openCapability('account.profile');
    assert(await panel('account.profile').getByRole('button', { name: '查询中…', exact: true }).isDisabled());
    assert.equal(await panel('account.profile').getByRole('group', { name: '查询结果' }).count(), 0);
    first.released.resolve();
    await panel('account.profile').getByText('并行资料', { exact: true }).waitFor(); await closeCapability('account.profile');
    await openCapability('history.list'); assert.equal(await panel('history.list').getByRole('group', { name: '查询结果' }).count(), 1); await closeCapability('history.list');
  });

  await check('configuration editor cancels without mutation, retains failed drafts and clears old results on save', async () => {
    const patchCount = requests.filter(request => request.method === 'PATCH').length;
    await page.getByRole('button', { name: '编辑连接配置', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('未保存名称');
    await page.getByRole('form', { name: '编辑连接配置' }).getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(requests.filter(request => request.method === 'PATCH').length, patchCount);
    await page.getByRole('button', { name: '编辑连接配置', exact: true }).click();
    assert.equal(await page.getByLabel('名称', { exact: true }).inputValue(), connection.label);
    await page.getByLabel('名称', { exact: true }).fill('保留失败输入');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await page.getByRole('form', { name: '编辑连接配置' }).getByText('保存失败：本地夹具拒绝保存', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('名称', { exact: true }).inputValue(), '保留失败输入');
    rejectConfig = false;
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await page.getByRole('heading', { name: '保留失败输入', exact: true }).waitFor();
    assert.equal(await page.getByRole('form', { name: '编辑连接配置' }).count(), 0);
    assert.equal(await page.locator('.capability-result').count(), 0);
    const count = queryCount();
    for (const id of ['account.profile', 'history.list']) {
      await openCapability(id);
      assert.equal(await panel(id).locator('.capability-result').count(), 0, 'saved configuration must clear stored capability results, including closed workspaces');
      await closeCapability(id);
    }
    assert.equal(queryCount(), count);
  });

  await check('late query responses cannot restore results invalidated by a configuration change', async () => {
    const pending = plan('account.profile', { hold: true, nickname: '过期结果不可见' });
    await openCapability('account.profile'); await runCapability('account.profile'); await fixtureEvent(pending.arrived, 'stale profile request arrives'); await closeCapability('account.profile');
    await page.getByRole('button', { name: '编辑连接配置', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('已更新配置');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await page.getByRole('heading', { name: '已更新配置', exact: true }).waitFor();
    pending.released.resolve(); await fixtureEvent(pending.finished, 'stale profile response finishes'); await nextPaint();
    assert.equal(await page.getByText('过期结果不可见', { exact: true }).count(), 0);
    assert.equal(await page.locator('.capability-result').count(), 0);
    await openCapability('account.profile');
    assert.equal(await panel('account.profile').locator('.capability-result').count(), 0);
    assert(await panel('account.profile').getByRole('button', { name: '试一下', exact: true }).isEnabled());
    await closeCapability('account.profile');
  });

  await check('scope and tags return to a compact summary after explicit save', async () => {
    await page.getByRole('button', { name: '编辑范围与标签', exact: true }).click();
    await page.getByLabel('标签（逗号分隔）').fill('工作, 测试');
    await page.getByRole('button', { name: '保存范围与标签', exact: true }).click();
    await page.getByRole('form', { name: '编辑范围与标签' }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByText('工作', { exact: true }).count(), 1);
    assert.equal(await page.getByLabel('账户范围', { exact: true }).count(), 0);
  });

  await check('credential editing is explicit and cancellation discards the secret draft', async () => {
    await page.getByRole('button', { name: '编辑凭据', exact: true }).click();
    await page.getByLabel('访问令牌', { exact: true }).fill('synthetic-never-send');
    await page.getByRole('form', { name: '编辑凭据' }).getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(requests.filter(request => request.method === 'PUT').length, 0);
    assert.equal(await page.getByLabel('访问令牌', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '编辑凭据', exact: true }).click();
    assert.equal(await page.getByLabel('访问令牌', { exact: true }).inputValue(), '');
    await page.getByRole('form', { name: '编辑凭据' }).getByRole('button', { name: '取消', exact: true }).click();
  });

  await check('invalid local input records only its failed input stage and sends no query', async () => {
    const count = queryCount();
    await openCapability('history.list');
    await panel('history.list').getByLabel('条目数', { exact: true }).fill('0');
    // Bypass native form validity intentionally to exercise the JS validation boundary.
    await panel('history.list').locator('form').dispatchEvent('submit');
    const failure = panel('history.list').locator('.query-request-failure');
    await failure.getByText('调用失败：条目数不能小于 1', { exact: true }).waitFor();
    assert.equal(queryCount(), count);
    assert.equal(await failure.locator('.execution-step').count(), 1);
    assert.equal(await failure.locator('.execution-step-label').innerText(), '检查输入');
    assert.equal(await failure.locator('.execution-trace').evaluate(element => element.open), true);
    assert.equal(await panel('history.list').getByRole('group', { name: '查询结果' }).count(), 0);
    await closeCapability('history.list'); await openCapability('history.list');
    await panel('history.list').locator('.query-request-failure').waitFor();
    assert.equal(await panel('history.list').getByLabel('条目数', { exact: true }).inputValue(), '0');
    assert.equal(queryCount(), count);
    await panel('history.list').getByLabel('条目数', { exact: true }).fill('3');
    await closeCapability('history.list');
  });

  await check('transport failure records only the observed request boundary with code and next step', async () => {
    plan('account.profile', { transportFailure: true });
    await openCapability('account.profile'); await runCapability('account.profile');
    const failure = panel('account.profile').locator('.query-request-failure');
    await failure.getByText('调用失败：本地夹具暂时不可用', { exact: true }).waitFor();
    assert.equal(await failure.locator('.query-error-code').innerText(), 'FIXTURE_UNAVAILABLE');
    assert.equal(await failure.getByText('下一步：稍后重试此能力', { exact: true }).count(), 1);
    assert.equal(await failure.locator('.execution-step').count(), 1);
    assert.equal(await failure.locator('.execution-step-label').innerText(), '提交查询');
    assert.equal(await panel('account.profile').getByRole('group', { name: '查询结果' }).count(), 0);
    await screenshot('desktop-local-failures');
    await closeCapability('account.profile');
  });

  await check('connection-wide verification replaces local errors in each matching capability workspace', async () => {
    await page.getByRole('button', { name: '验证连接', exact: true }).click();
    await page.locator('.connection-verification').waitFor();
    await openCapability('history.list'); await panel('history.list').getByRole('group', { name: '查询结果' }).waitFor(); assert.equal(await panel('history.list').locator('.query-request-failure').count(), 0); await closeCapability('history.list');
    await openCapability('account.profile'); await panel('account.profile').getByRole('group', { name: '查询结果' }).waitFor(); assert.equal(await panel('account.profile').locator('.query-request-failure').count(), 0); await closeCapability('account.profile');
    assert.equal(await page.locator('.capability-card .capability-result').count(), 0);
    assert.equal(await page.locator('.connection-verification').count(), 1);
  });

  await check('repeated connection verification keeps the visible summary and page geometry until the new result arrives', async () => {
    for (const { width, colorScheme } of [{ width: 1280, colorScheme: 'dark' }, { width: 390, colorScheme: 'dark' }, { width: 320, colorScheme: 'light' }]) {
      await page.setViewportSize({ width, height: width >= 1280 ? 1000 : 844 });
      await page.emulateMedia({ colorScheme });
      await page.reload(); await card('blocked.read').waitFor(); await page.getByRole('button', { name: '编辑凭据', exact: true }).waitFor();
      const button = page.getByRole('button', { name: '验证连接', exact: true });
      const summary = page.locator('.connection-verification');
      await button.click(); await summary.waitFor(); await button.waitFor();
      const oldSummary = await summary.innerText(), baseline = await geometry();
      const overview = await page.locator('.connection-overview-grid').elementHandle();
      const measureButton = () => page.getByRole('button', { name: /^(?:验证连接|验证中…)$/, exact: true }).evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x + scrollX, y: bounds.y + scrollY, width: bounds.width, height: bounds.height };
      });
      const beforeButton = await measureButton();
      const pending = plan('connection.verify', { hold: true, failed: false, nickname: `刷新结果-${width}` });
      await button.click(); await fixtureEvent(pending.arrived, 'connection-wide verification starts'); await nextPaint();
      const during = await geometry(), duringButton = await measureButton(), summaryCount = await summary.count();
      report.verification.push({ phase: 'pending', width, colorScheme, summaryCount, beforeButton, duringButton,
        firstCardBefore: baseline.cards[0], firstCardDuring: during.cards[0], overviewConnected: await overview.evaluate(element => element.isConnected) });
      assert.equal(summaryCount, 1, 'a pending verification must not remove the previous summary');
      assert.equal(await summary.innerText(), oldSummary, 'keep the last observed verification result during a refresh');
      assert(await overview.evaluate(element => element.isConnected), 'connection information must remain mounted');
      for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(beforeButton[key] - duringButton[key]) <= 1, `verification button ${key} changed during pending`);
      await unchanged(`verify-pending-${colorScheme}-${width}`, baseline);
      assert(await page.getByRole('button', { name: '验证中…', exact: true }).isDisabled());
      await screenshot(`verification-pending-${colorScheme}-${width}`);
      pending.released.resolve(); await fixtureEvent(pending.finished, 'connection-wide verification response finishes');
      await button.waitFor(); await summary.getByText(/已验证 \d+ 项能力/).waitFor();
      await unchanged(`verify-success-${colorScheme}-${width}`, baseline);
      await openCapability('account.profile'); await panel('account.profile').getByText(`刷新结果-${width}`, { exact: true }).waitFor(); await closeCapability('account.profile');

      const latestSummary = await summary.innerText();
      const failed = plan('connection.verify', { hold: true, transportFailure: true });
      await button.click(); await fixtureEvent(failed.arrived, 'failed connection verification starts');
      await unchanged(`verify-failure-pending-${colorScheme}-${width}`, baseline);
      assert.equal(await summary.innerText(), latestSummary);
      failed.released.resolve(); await fixtureEvent(failed.finished, 'failed connection verification response finishes');
      await page.getByText('验证失败：本地夹具暂时不可用', { exact: true }).waitFor();
      await button.waitFor(); assert.equal(await summary.innerText(), latestSummary, 'request failures keep the last verified summary');
      assert(await overview.evaluate(element => element.isConnected), 'request failures must not discard connection information');
      await openCapability('account.profile'); await panel('account.profile').getByText(`刷新结果-${width}`, { exact: true }).waitFor(); await closeCapability('account.profile');
      await layout(`verify-request-failure-${colorScheme}-${width}`);
      await screenshot(`verification-request-failure-${colorScheme}-${width}`);
      report.verification.push({ phase: 'request-error', width, colorScheme, retainedSummary: latestSummary, retainedCapabilityResult: true });

      const failedBaseline = await geometry(), failedButton = await measureButton();
      const recovery = plan('connection.verify', { hold: true, failed: false, nickname: `恢复结果-${width}` });
      await button.click(); await fixtureEvent(recovery.arrived, 'verification retry after a failed request starts');
      assert.equal(await summary.innerText(), latestSummary);
      await page.getByText('验证失败：本地夹具暂时不可用', { exact: true }).waitFor();
      await unchanged(`verify-error-retry-pending-${colorScheme}-${width}`, failedBaseline);
      const retryButton = await measureButton();
      for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(failedButton[key] - retryButton[key]) <= 1, `retry button ${key} must not move while retaining the failure notice`);
      await screenshot(`verification-error-retry-${colorScheme}-${width}`);
      recovery.released.resolve(); await fixtureEvent(recovery.finished, 'verification retry response finishes'); await button.waitFor();
      await page.getByText('验证失败：本地夹具暂时不可用', { exact: true }).waitFor({ state: 'hidden' });
      await unchanged(`verify-error-retry-success-${colorScheme}-${width}`, baseline);
      await openCapability('account.profile'); await panel('account.profile').getByText(`恢复结果-${width}`, { exact: true }).waitFor(); await closeCapability('account.profile');
      report.verification.push({ phase: 'error-retry', width, colorScheme, retainedErrorWhilePending: true, replacedResultAfterSuccess: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 }); await page.emulateMedia({ colorScheme: 'light' });
  });

  await check('a failed background connection refresh retains the detail and latest result while offering an explicit retry', async () => {
    await page.setViewportSize({ width: 1280, height: 900 }); await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload(); await card('blocked.read').waitFor(); await page.getByRole('button', { name: '编辑凭据', exact: true }).waitFor();
    const overview = await page.locator('.connection-overview-grid').elementHandle();
    const firstCard = await profile().elementHandle();
    const failedRead = plan('connections.refresh', { transportFailure: true });
    const failedRetry = plan('connections.refresh', { transportFailure: true });
    const verified = plan('connection.verify', { hold: true, failed: false, nickname: '后台读取失败时保留的结果' });
    await page.getByRole('button', { name: '验证连接', exact: true }).click();
    await fixtureEvent(verified.arrived, 'verification preceding background refresh arrives');
    verified.released.resolve(); await fixtureEvent(verified.finished, 'verification preceding background refresh completes');
    await fixtureEvent(failedRead.finished, 'background connections read fails');
    await fixtureEvent(failedRetry.finished, 'automatic connections retry fails');
    const notice = page.getByRole('alert').filter({ hasText: '连接信息刷新失败，当前显示上次数据。' });
    await notice.waitFor();
    assert(await overview.evaluate(element => element.isConnected), 'a background error must not unmount the connection information');
    assert(await firstCard.evaluate(element => element.isConnected), 'a background error must not unmount capability cards');
    assert.equal(await page.locator('.capability-card').count(), capabilities.length);
    assert.equal(await page.getByText('无法读取连接', { exact: true }).count(), 0, 'cached detail must not become the initial-load error page');
    const summary = await page.locator('.connection-verification').innerText();
    await openCapability('account.profile'); await panel('account.profile').getByText('后台读取失败时保留的结果', { exact: true }).waitFor(); await closeCapability('account.profile');
    await layout('verification-background-refresh-error'); await screenshot('verification-background-refresh-error');
    const recovery = plan('connections.refresh', { hold: true });
    await notice.getByRole('button', { name: '重试刷新连接', exact: true }).click();
    await fixtureEvent(recovery.arrived, 'explicit background refresh retry arrives');
    assert(await notice.isVisible(), 'a retry keeps the failure notice until data actually arrives');
    assert(await notice.getByRole('button', { name: '刷新中…', exact: true }).isDisabled());
    assert(await overview.evaluate(element => element.isConnected));
    assert(await firstCard.evaluate(element => element.isConnected));
    recovery.released.resolve(); await fixtureEvent(recovery.finished, 'explicit background refresh retry finishes');
    await notice.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.connection-verification').innerText(), summary);
    assert(await overview.evaluate(element => element.isConnected));
    assert(await firstCard.evaluate(element => element.isConnected));
    report.verification.push({ phase: 'background-refresh-error', retainedInformation: true, retainedCapabilities: true,
      retainedLatestResult: true, automaticRetries: 1, explicitRetryRecovered: true });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await check('visible permission link preselects this connection and survives a refresh', async () => {
    await page.getByRole('link', { name: '客户端与权限', exact: true }).click();
    await page.getByRole('heading', { name: '客户端与授权', exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('connection_id'), connection.id);
    await page.locator(`section[data-client-id="${client.id}"]`).waitFor();
    assert.equal(await page.locator('[data-client-choice-id]').count(), 0, 'a sole active client needs no selector');
    await page.locator(`[data-grant-connection-id="${connection.id}"] form`).waitFor();
    assert.equal(await page.locator(`[data-grant-connection-id="${otherConnection.id}"] form`).count(), 0);
    await page.reload();
    await page.locator(`section[data-client-id="${client.id}"]`).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('connection_id'), connection.id);
    await page.locator(`[data-grant-connection-id="${connection.id}"] form`).waitFor();
    assert.equal(await page.locator(`[data-grant-connection-id="${otherConnection.id}"] form`).count(), 0);
    assert.equal(requests.filter(request => request.method === 'POST' && request.path === '/admin/grants').length, 0);
    await layout('desktop-permissions'); await screenshot('desktop-permissions');
    await page.getByRole('link', { name: connection.label, exact: true }).click();
    await page.getByRole('heading', { name: connection.label, exact: true }).waitFor();
  });

  await check('navigating to another connection cannot carry drafts or late capability results', async () => {
    const pending = plan('account.profile', { hold: true, nickname: '前一个连接的结果' });
    await openCapability('account.profile'); await runCapability('account.profile'); await fixtureEvent(pending.arrived, 'previous connection request arrives'); await closeCapability('account.profile');
    await page.getByRole('button', { name: '编辑连接配置', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('前一个连接的草稿');
    await page.getByRole('dialog', { name: '编辑连接配置', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('dialog', { name: '编辑连接配置', exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('heading', { name: '连接', exact: true }).waitFor();
    await page.locator('li.card').filter({ has: page.getByText(otherConnection.label, { exact: true }) }).getByRole('button', { name: '查看', exact: true }).click();
    await page.getByRole('heading', { name: otherConnection.label, exact: true }).waitFor();
    pending.released.resolve(); await fixtureEvent(pending.finished, 'previous connection response finishes'); await nextPaint();
    assert.equal(await page.getByRole('form', { name: '编辑连接配置' }).count(), 0);
    assert.equal(await page.locator('.capability-result').count(), 0);
    assert.equal(await page.getByText('前一个连接的结果', { exact: true }).count(), 0);
    await openCapability('notes.list');
    assert.equal(await panel('notes.list').getByLabel('筛选 JSON', { exact: true }).inputValue(), '{"category":"fixture"}', 'another connection must receive default parameters');
    await closeCapability('notes.list');
    await page.getByRole('button', { name: '编辑连接配置', exact: true }).click();
    assert.equal(await page.getByLabel('名称', { exact: true }).inputValue(), otherConnection.label);
    await page.getByRole('form', { name: '编辑连接配置' }).getByRole('button', { name: '取消', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await layout('mobile-default'); await screenshot('mobile-default');
  });

  assert.deepEqual(report.browserErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.unexpected, []);
  assert.equal(held.size, 0);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { stage, message: error instanceof Error ? error.message : String(error) };
  if (page) { await screenshot('failure').catch(() => undefined); await writeFile(join(output, 'failure.html'), await page.content()).catch(() => undefined); }
  process.exitCode = 1;
} finally {
  for (const entry of held) entry.released.resolve();
  await browser?.close();
  await vite?.close();
  await rm(cache, { recursive: true, force: true });
  report.requestCount = requests.length;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, screenshots: report.screenshots.length, requestCount: report.requestCount, output, ...(report.failure ? { failure: report.failure } : {}) }));
}
