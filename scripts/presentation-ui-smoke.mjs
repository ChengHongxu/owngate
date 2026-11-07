#!/usr/bin/env node
// Actual Web source with synthetic administrator APIs, a disposable Vite
// server, and sandboxed Chromium. Never accesses a live service or account.
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
    console.log('Usage: node scripts/presentation-ui-smoke.mjs [--out SCREENSHOT_DIRECTORY]');
    console.log('Actual Web app with synthetic APIs; no running service, credential or platform access.');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${process.argv[i]}`);
}
await mkdir(join(root, 'out/ui'), { recursive: true });
output ??= await mkdtemp(join(root, 'out/ui/presentation-'));
await mkdir(output, { recursive: true });
const cache = await mkdtemp(join(tmpdir(), 'owngate-presentation-vite-'));
const report = {
  status: 'running',
  source: 'Actual Web source and sandboxed Chromium with synthetic administrator APIs only; no running service, real account or credential access.',
  checks: [], screenshots: [], layouts: [], browserErrors: [], unexpected: [], requestCount: 0,
};
const at = '2026-11-03T10:00:00.000Z';
const scalar = (type, title, rest = {}) => ({ type, title, ...rest });
const object = properties => ({ type: 'object', additionalProperties: false, properties });
const array = (title, items) => ({ type: 'array', title, items });
const cap = (id, title, output, presentation, transport = 'http') => ({
  id, title, description: `${title}的合成展示夹具。`, kind: 'query', effect: 'read', transport,
  input: { type: 'object', properties: {}, additionalProperties: false }, output, cache: null,
  support: { status: 'supported' }, ...(presentation ? { presentation } : {}),
});
const balance = cap('account.balance', '账户余额', object({
  quota: scalar('number', '可用额度', { 'x-unit': 'USD', 'x-sensitivity': 'financial' }),
  available: scalar('boolean', '服务已启用'), unavailable_total: scalar(['number', 'null'], '待确认用量'),
}), { type: 'stats', fields: [{ path: 'quota', label: '当前可用积分', prominent: true }, { path: 'available' }, { path: 'unavailable_total' }] });
const usage = cap('account.usage', '账户用量', object({
  consumed: scalar('number', '累计消耗', { 'x-unit': 'tokens' }), calls: scalar('integer', '实际调用次数', { 'x-unit': 'requests' }),
}), { type: 'stats', fields: [{ path: 'consumed', prominent: true }, { path: 'calls' }] });
const socialSchema = object({
  items: array('内容记录', object({
    id: scalar('string', '内容标识'), title: scalar('string', '标题'), text: scalar('string', '内容'),
    author: object({ name: scalar(['string', 'null'], '作者') }),
    published_at: scalar(['string', 'null'], '发布时间', { format: 'date-time' }),
    metrics: object({ likes: scalar('number', '点赞', { 'x-unit': 'count' }), views: scalar('number', '播放', { 'x-unit': 'count' }) }),
    url: scalar('string', '原文地址', { format: 'uri' }),
  })), has_more: scalar(['boolean', 'null'], '还有更多'),
});
const feed = cap('feed.list', '关注内容', socialSchema, { type: 'feed', items: '$.items' }, 'browser');
const history = cap('history.list', '观看历史', socialSchema, { type: 'feed', items: '$.items', max_rows: 3 }, 'browser');
const rowSchema = object({
  ticket: scalar('string', '工单号'), subject: scalar('string', '处理主题'),
  priority: scalar('string', '优先级'), weight: scalar(['number', 'null'], '处理权重', { 'x-unit': 'score' }),
  detail_url: scalar('string', '详情地址', { format: 'uri' }),
});
const table = cap('tickets.table', '扩展工单表格', object({ records: array('工单记录', rowSchema) }), {
  type: 'table', items: '$.records', max_rows: 3,
  columns: [{ path: 'ticket', label: '编号' }, { path: 'subject', label: '主题' }, { path: 'weight', label: '权重' }, { path: 'detail_url', label: '查看地址', format: 'link' }],
});
const list = cap('tickets.list', '扩展事项列表', object({ entries: array('事项', rowSchema) }), {
  type: 'list', items: '$.entries', max_rows: 2, fields: [{ path: 'subject', label: '待处理事项' }, { path: 'priority', label: '处理等级', format: 'badge' }],
});
const nested = cap('workspace.auto', '自定义嵌套结果', object({ result: object({
  workspace: object({ custom_label: scalar('string', '工作区名称'), owner: object({ public_alias: scalar('string', '负责人称呼') }) }),
  observations: array('环境观测', object({ sensor: scalar('string', '传感器'), reading: scalar('number', '观测值', { 'x-unit': 'kPa' }) })),
  tags: array('分类标签', scalar('string', '标签')),
  private_group: object({ confidential: scalar('string', '保密内容'), private_url: scalar('string', '保密地址', { format: 'uri' }) }),
}) }));
const json = cap('diagnostic.json', '显式数据详情', object({ diagnostic_marker: scalar('string', '诊断标记') }), { type: 'json' });
const empty = cap('tickets.empty', '本次空集合', object({ entries: array('本次事项', rowSchema) }), { type: 'table', items: '$.entries' });
const error = cap('tickets.failed', '失败执行过程', object({ message: scalar('string', '内容') }));
const catalogs = { newapi: [balance, usage], bilibili: [feed, history], fixture_extension: [table, list, nested, json, empty, error] };
const connections = Object.entries(catalogs).map(([id, capabilities]) => ({
  id: `presentation-${id}`, connector_id: id,
  label: id === 'newapi' ? 'New API 展示示例' : id === 'bilibili' ? 'B站内容展示示例' : '扩展展示示例',
  config: {}, health: { status: 'healthy' }, scope: 'personal', tags: [], paused: false,
  capability_states: Object.fromEntries(capabilities.map(item => [item.id, { status: 'supported' }])), created_at: at, updated_at: at,
}));
const connectors = Object.keys(catalogs).map(id => ({ id, title: id === 'bilibili' ? '哔哩哔哩' : id, transport: id === 'bilibili' ? 'browser' : 'http', config: {}, has_auth: false }));
const socialItems = Array.from({ length: 7 }, (_, index) => ({
  id: `preview-${index + 1}`, title: `公开示例视频 ${index + 1}`,
  text: index === 0 ? '这是一段用于验收正文折叠的合成内容。'.repeat(36)
    : index === 5 ? '<img src="https://example.invalid/pixel" onerror="window.fixtureExecuted=1"><script>window.fixtureExecuted=1</script> 合成纯文本'
    : `第 ${index + 1} 条简短说明。`,
  author: { name: index === 2 ? 'HIDDEN_AUTHOR_SENTINEL' : `示例作者 ${index + 1}` },
  published_at: index === 1 ? null : '2026-11-03T08:00:00.000Z',
  metrics: { likes: index, views: index * 10 },
  url: index === 2 ? 'https://example.invalid/hidden-author' : index === 3 ? 'javascript:window.fixtureExecuted=1' : `https://example.invalid/content/${index + 1}`,
}));
const records = Array.from({ length: 7 }, (_, index) => ({
  ticket: `FIX-${index + 1}`, subject: index === 0 ? '一条较长的工单主题，用于检查窄屏换行和列宽，不应造成整页横向溢出。'.repeat(3) : `工单主题 ${index + 1}`,
  priority: index % 2 ? '普通' : '高', weight: index + 1,
  detail_url: index === 0 ? 'javascript:window.fixtureExecuted=1' : index === 1 ? 'https://user:password@example.invalid/unsafe' : `https://example.invalid/ticket/${index + 1}`,
}));
const results = {
  'account.balance': { data: { quota: 0, available: false, unavailable_total: null }, fields: { quota: { status: 'ok', unit: 'quota' }, unavailable_total: { status: 'unknown' } } },
  'account.usage': { data: { consumed: 128, calls: 0 }, fields: {} },
  'feed.list': { data: { items: socialItems, has_more: null }, fields: { 'items.1.published_at': { status: 'unknown' }, 'items.2.author': { status: 'redacted' }, has_more: { status: 'unknown' } }, partial: true },
  'history.list': { data: { items: socialItems.slice(0, 3), has_more: false }, fields: { 'items.1.published_at': { status: 'unknown' }, 'items.2.author': { status: 'redacted' } }, partial: true },
  'tickets.table': { data: { records }, fields: { 'records.0.weight': { status: 'ok', unit: 'points' }, 'records.1.weight': { status: 'unknown' }, 'records.2.detail_url': { status: 'redacted' } }, partial: true },
  'tickets.list': { data: { entries: records.slice(0, 4) }, fields: {} },
  'workspace.auto': { data: { result: { workspace: { custom_label: '北区实验工作台', owner: { public_alias: '项目协调员' } }, observations: [{ sensor: '气压观测器', reading: 0 }, { sensor: '备份观测器', reading: 2.5 }], tags: ['设计', '自动化'], private_group: { confidential: 'HIDDEN_NESTED_SENTINEL', private_url: 'https://example.invalid/hidden-nested' } } }, fields: { 'result.private_group': { status: 'redacted' } } },
  'diagnostic.json': { data: { diagnostic_marker: '显式 JSON 夹具' }, fields: {} },
  'tickets.empty': { data: { entries: [] }, fields: {}, partial: true },
  'tickets.failed': { data: { message: 'FAILED_PAYLOAD_SENTINEL' }, fields: {}, failure: true },
};
let sequence = 0;
function envelope(connection, capabilityId, override) {
  const fixture = { ...structuredClone(results[capabilityId] ?? {}), ...override };
  const failed = Boolean(fixture.failure);
  return {
    outcome: failed ? 'error' : fixture.partial ? 'partial' : 'success', data: fixture.data,
    fields: fixture.fields ?? {}, error: failed ? { code: 'UPSTREAM_ERROR', message: '站点页面返回 HTTP 404', details: { next_step: '检查站点入口' } } : null,
    warnings: [], source: { connection_id: connection.id, connection_label: connection.label, capability_id: capabilityId },
    data_time: at, queried_at: at, cache: null,
    execution: { id: `presentation-${++sequence}`, started_at: at, duration_ms: 120, steps: [
      { id: 'request.validate', label: '检查连接与权限', status: 'success', duration_ms: 1 },
      { id: 'browser.navigate', label: '访问能力页面', status: failed ? 'error' : 'success', duration_ms: 118, ...(failed ? { code: 'UPSTREAM_ERROR', detail: '站点页面返回 HTTP 404' } : {}) },
      { id: 'request.result', label: '返回查询结果', status: 'success', duration_ms: 1 },
    ] },
  };
}
const requests = [], held = new Map();
function defer() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
let vite, browser, page, stage = 'startup', metadataFailure = false;
async function check(name, action) { stage = name; await action(); report.checks.push(name); }
async function eventually(predicate, label) {
  const deadline = Date.now() + 7000;
  do { if (await predicate()) return; await new Promise(done => setTimeout(done, 25)); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
async function event(promise, label) {
  let timer;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 7000); })]); }
  finally { clearTimeout(timer); }
}
async function nextPaint() { await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); }
async function layout(name) {
  const bounds = await page.evaluate(() => {
    const modal = document.querySelector('dialog[open]:has([data-capability-workspace])');
    const rect = modal?.getBoundingClientRect();
    const content = modal?.querySelector('.page-dialog-content');
    return { width: innerWidth, document: document.documentElement.scrollWidth, height: innerHeight,
      ...(rect ? { dialog: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        contentWidth: content?.clientWidth, contentScrollWidth: content?.scrollWidth } } : {}) };
  });
  if (bounds.document > bounds.width + 1) {
    report.overflow = await page.locator('body *').evaluateAll(elements => elements.map(element => ({
      tag: element.tagName, class: element.className,
      right: element.getBoundingClientRect().right, left: element.getBoundingClientRect().left,
      width: element.getBoundingClientRect().width,
      text: element.textContent?.slice(0, 100),
    })).filter(item => item.width > 0 && (item.right > innerWidth + 1 || item.left < -1)).slice(0, 20));
  }
  report.layouts.push({ name, ...bounds });
  assert(bounds.document <= bounds.width + 1, `${name}: horizontal overflow`);
  if (bounds.dialog) {
    assert(bounds.dialog.left >= -1 && bounds.dialog.right <= bounds.width + 1, `${name}: dialog must fit horizontally`);
    assert(bounds.dialog.top >= -1 && bounds.dialog.bottom <= bounds.height + 1, `${name}: dialog must fit vertically`);
    assert(bounds.dialog.contentScrollWidth <= bounds.dialog.contentWidth + 1, `${name}: dialog content must not scroll horizontally`);
  }
}
async function screenshot(name, locator) {
  await page.evaluate(() => {
    scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.querySelector('dialog[open] .page-dialog-content')?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await nextPaint();
  const clip = locator ? await locator.boundingBox() : undefined;
  assert(!locator || clip, 'screenshot target must be visible');
  const hasModal = await activeDialog().count() > 0;
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: !hasModal, ...(clip ? { clip } : {}), animations: 'disabled' });
  report.screenshots.push(`${name}.png`);
}
const card = id => page.locator(`.capability-card[data-capability-id="${id}"]`);
const workspace = id => page.locator(`dialog[open] [data-capability-workspace="${id}"]`);
const data = id => workspace(id).locator('.result-data');
const activeDialog = () => page.locator('dialog[open]').filter({ has: page.locator('[data-capability-workspace]') });
const queryCount = () => requests.filter(request => request.path === '/admin/invoke').length;
async function closeWorkspace() {
  const modal = activeDialog();
  if (await modal.count() === 0) return;
  await modal.getByRole('button', { name: /^关闭/ }).click();
  await modal.waitFor({ state: 'hidden' });
}
async function open(id) {
  if (await workspace(id).isVisible()) return;
  await closeWorkspace();
  const before = queryCount();
  await card(id).locator('.capability-open').click();
  await workspace(id).waitFor({ state: 'visible' });
  assert.equal(queryCount(), before, 'opening a capability must not execute it');
  assert.equal(await page.locator('dialog[open] [data-capability-workspace]').count(), 1, 'only the selected capability workspace is open');
}
async function visit(connectorId) {
  const connection = connections.find(item => item.connector_id === connectorId);
  await page.goto(`${new URL(page.url()).origin}/connections/${connection.id}`);
  await page.getByRole('heading', { name: connection.label, exact: true }).waitFor();
  await card(catalogs[connectorId][0].id).waitFor();
}
async function run(id) {
  await open(id);
  const before = queryCount();
  await workspace(id).getByRole('button', { name: '试一下', exact: true }).click();
  await workspace(id).getByRole('group', { name: '查询结果', exact: true }).waitFor();
  assert.equal(queryCount(), before + 1, 'the workspace run action must execute exactly one query');
}

try {
  const webRequire = createRequire(join(root, 'apps/web/package.json'));
  const browserRequire = createRequire(join(root, 'apps/browser/package.json'));
  const { createServer } = await import(pathToFileURL(join(dirname(webRequire.resolve('vite/package.json')), 'dist/node/index.js')).href);
  const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href);
  const { chromium } = browserRequire('playwright');
  vite = await createServer({ root: join(root, 'apps/web'), configFile: false, plugins: [react()], cacheDir: cache,
    server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await vite.listen();
  const address = vite.httpServer.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(7000);
  page.on('pageerror', err => report.browserErrors.push(err.message));
  page.on('console', message => {
    // The metadata fallback deliberately returns 503. React errors, including
    // duplicate keys that can leave stale result DOM behind, must still fail.
    if (message.type() === 'error' && !(metadataFailure && message.text().startsWith('Failed to load resource:'))) {
      report.browserErrors.push(message.text());
    }
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { report.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    if (!/^\/(?:admin|auth|api|ws)(?:\/|$)/.test(url.pathname)) return route.continue();
    const method = request.method(), path = url.pathname, body = request.postData() ? request.postDataJSON() : undefined;
    const observed = { method, path, capability: body?.capability_id };
    requests.push(observed);
    let result, status = 200;
    if (path === '/auth/status') result = { hasUser: true, authenticated: true, stepUp: true, totpEnabled: true, passkeyCount: 0 };
    else if (path === '/admin/connections' && method === 'GET') result = { connections };
    else if (path === '/admin/connectors' && method === 'GET') result = { connectors };
    else if (path === '/admin/capabilities' && method === 'GET') {
      if (metadataFailure) { status = 503; result = { code: 'FIXTURE_METADATA_UNAVAILABLE', message: '合成元数据暂时不可用' }; }
      else result = { capabilities: catalogs[url.searchParams.get('connector_id')] ?? [] };
    } else if (path === '/admin/invoke' && method === 'POST') {
      const target = connections.find(item => item.id === body.connection_id);
      const pending = held.get(body.capability_id);
      if (pending) { pending.arrived.resolve(); await pending.release.promise; held.delete(body.capability_id); }
      result = envelope(target, body.capability_id);
    } else if (path === '/admin/tasks/metadata-fallback' && method === 'GET') {
      const connection = connections.find(item => item.connector_id === 'fixture_extension');
      result = { id: 'metadata-fallback', task_id: 'metadata-fallback', connection_id: connection.id, capability_id: 'workspace.auto',
        status: 'success', created_at: at, attempts: 1, input: {}, cancellation: null,
        result: envelope(connection, 'workspace.auto', { data: { result: { deployment_state: 'fallback-ready', observations: [{ sensor: 'fallback pressure', reading: 0 }] } }, fields: {} }),
      };
    } else if (path === '/admin/tasks/metadata-fallback/events') result = { events: [] };
    else { status = 500; result = { message: 'Unknown fixture request' }; report.unexpected.push(`${method} ${path}`); }
    observed.status = status;
    return route.fulfill({ status, json: structuredClone(result) });
  });

  await page.goto(`${origin}/connections/presentation-newapi`);
  await page.getByRole('heading', { name: 'New API 展示示例', exact: true }).waitFor();
  await check('schema labels and presentation fields drive New API summaries while runtime units, zero, false and unknown remain distinct', async () => {
    await run('account.balance'); await data('account.balance').waitFor();
    await data('account.balance').getByText('当前可用积分', { exact: true }).waitFor();
    await data('account.balance').getByText('服务已启用', { exact: true }).waitFor();
    const text = await data('account.balance').innerText();
    assert.match(text, /quota/); assert.doesNotMatch(text, /USD/); assert.match(text, /0/); assert.match(text, /否/); assert.match(text, /未知/);
    assert.equal(await workspace('account.balance').locator('.result-details').evaluate(element => element.open), false);
    assert.equal(await workspace('account.balance').locator('.execution-trace').evaluate(element => element.open), false);
    await layout('desktop-newapi-light'); await screenshot('desktop-newapi-light');
  });

  await check('two capability workspaces keep independent pending states and results across closing and reopening', async () => {
    const first = { arrived: defer(), release: defer() }, second = { arrived: defer(), release: defer() };
    held.set('account.balance', first); held.set('account.usage', second);
    await workspace('account.balance').getByRole('button', { name: '试一下', exact: true }).click();
    await event(first.arrived.promise, 'first capability arrives');
    assert(await workspace('account.balance').getByRole('button', { name: '查询中…', exact: true }).isDisabled());
    await closeWorkspace();
    await open('account.usage');
    await workspace('account.usage').getByRole('button', { name: '试一下', exact: true }).click();
    await event(second.arrived.promise, 'second capability arrives');
    assert(await workspace('account.usage').getByRole('button', { name: '查询中…', exact: true }).isDisabled());
    await closeWorkspace();
    await open('account.balance');
    assert(await workspace('account.balance').getByRole('button', { name: '查询中…', exact: true }).isDisabled());
    second.release.resolve();
    await eventually(() => !held.has('account.usage'), 'second capability completes while its workspace is closed');
    assert(await workspace('account.balance').getByRole('button', { name: '查询中…', exact: true }).isDisabled());
    await open('account.usage');
    await data('account.usage').getByText('累计消耗', { exact: true }).waitFor();
    await open('account.balance');
    assert(await workspace('account.balance').getByRole('button', { name: '查询中…', exact: true }).isDisabled());
    first.release.resolve(); await workspace('account.balance').getByRole('button', { name: '试一下', exact: true }).waitFor();
    await data('account.balance').getByText('当前可用积分', { exact: true }).waitFor();
    assert.equal(await workspace('account.balance').getByText('累计消耗', { exact: true }).count(), 0);
    await closeWorkspace();
    await open('account.usage');
    await data('account.usage').getByText('累计消耗', { exact: true }).waitFor();
    assert.equal(await workspace('account.usage').getByText('当前可用积分', { exact: true }).count(), 0);
  });

  await visit('bilibili');
  await check('Bilibili feed and history retain their own rendered content in separate capability workspaces with bounded previews', async () => {
    await run('feed.list');
    await data('feed.list').getByText('公开示例视频 1', { exact: true }).waitFor();
    assert.equal(await data('feed.list').locator('.result-feed-item').count(), 5);
    await run('history.list');
    await data('history.list').getByText('公开示例视频 1', { exact: true }).waitFor();
    assert.equal(await data('history.list').locator('.result-feed-item').count(), 3);
    await open('feed.list');
    await data('feed.list').getByText('公开示例视频 1', { exact: true }).waitFor();
    assert.equal(await data('feed.list').locator('.result-feed-item').count(), 5);
    assert.equal(await data('feed.list').getByText('公开示例视频 6', { exact: true }).count(), 0);
    const collection = data('feed.list').locator('.result-collection');
    await collection.getByRole('button', { name: '显示更多', exact: true }).click();
    await collection.getByText('公开示例视频 7', { exact: true }).waitFor();
    assert.equal(await collection.locator('.result-feed-item').count(), 7);
    await collection.getByRole('button', { name: '收起', exact: true }).click();
    assert.equal(await collection.locator('.result-feed-item').count(), 5);
    assert.equal(await workspace('feed.list').locator('.result-details').evaluate(element => element.open), false);
    await layout('desktop-bilibili-light'); await screenshot('desktop-bilibili-light');
    await screenshot('desktop-bilibili-result-light', activeDialog());
  });

  await check('untrusted social text stays inert, hidden authors stay hidden and only safe original links are actionable', async () => {
    const group = data('feed.list');
    const collection = group.locator('.result-collection');
    await collection.getByRole('button', { name: '显示更多', exact: true }).click();
    await group.getByText(/<img src=/).waitFor();
    assert.equal(await group.getByText('HIDDEN_AUTHOR_SENTINEL', { exact: true }).count(), 0);
    assert.equal(await group.locator('a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => window.fixtureExecuted ?? 0), 0);
    assert.equal(await group.locator('img,iframe,script').count(), 0);
    assert(await group.getByRole('link').count() > 0);
    const hasBodyToggle = group.getByRole('button', { name: /展开正文|展开内容|展开文本|显示全文/ });
    assert(await hasBodyToggle.count() > 0, 'long content must have a user-controlled expansion');
    await hasBodyToggle.first().click();
    assert(await group.getByRole('button', { name: /收起正文|收起内容|收起文本|收起全文/ }).count() > 0);
    await group.getByRole('button', { name: /收起正文|收起内容|收起文本|收起全文/ }).first().click();
    await collection.getByRole('button', { name: '收起', exact: true }).click();
  });

  await check('content views fit dark mobile layouts without loading external images or scrolling the page horizontally', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 390, height: 844 });
    await layout('mobile-bilibili-dark-390'); await screenshot('mobile-bilibili-dark-390');
    await screenshot('mobile-bilibili-result-dark-390', activeDialog());
    await page.setViewportSize({ width: 320, height: 844 });
    await layout('mobile-bilibili-dark-320');
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await visit('fixture_extension');
  await check('extension table and list presentations honor declared labels and columns without relying on built-in field names', async () => {
    await run('tickets.list');
    assert.equal(await data('tickets.list').locator('.result-list-item').count(), 2);
    await data('tickets.list').getByText('待处理事项', { exact: true }).first().waitFor();
    await run('tickets.table');
    await data('tickets.table').getByRole('columnheader', { name: '编号', exact: true }).waitFor();
    await data('tickets.table').getByRole('columnheader', { name: '主题', exact: true }).waitFor();
    assert.equal(await data('tickets.table').locator('.result-record-row').count(), 3);
    assert.match(await data('tickets.table').innerText(), /points/);
    assert.match(await data('tickets.table').innerText(), /未知/);
    assert.equal(await data('tickets.table').locator('a[href^="javascript:"],a[href*="user:password"]').count(), 0);
    assert.equal(await data('tickets.table').locator('a[href="https://example.invalid/ticket/3"]').count(), 0);
    await data('tickets.table').getByRole('button', { name: '显示更多', exact: true }).click();
    assert.equal(await data('tickets.table').locator('.result-record-row').count(), 6);
    await data('tickets.table').getByRole('button', { name: '收起', exact: true }).click();
    assert.equal(await data('tickets.table').locator('.result-record-row').count(), 3);
    await layout('desktop-extension-dark'); await screenshot('desktop-extension-dark');
  });

  await check('automatic rendering traverses OpenAPI-style result objects, nested labels and primitive arrays while hiding protected ancestors', async () => {
    await run('workspace.auto');
    await data('workspace.auto').getByText('北区实验工作台', { exact: true }).waitFor();
    await data('workspace.auto').getByText('工作区名称', { exact: true }).waitFor();
    await data('workspace.auto').getByText('负责人称呼', { exact: true }).waitFor();
    await data('workspace.auto').getByText('气压观测器', { exact: true }).waitFor();
    await data('workspace.auto').getByText('设计', { exact: true }).waitFor();
    assert.equal(await data('workspace.auto').getByText('HIDDEN_NESTED_SENTINEL', { exact: true }).count(), 0);
    assert.equal(await data('workspace.auto').locator('a[href="https://example.invalid/hidden-nested"]').count(), 0);
    assert.equal(await workspace('workspace.auto').locator('.result-details').evaluate(element => element.open), false);
    await screenshot('desktop-extension-auto-dark', activeDialog());
  });

  await check('explicit JSON mode remains available and partial empty collections do not masquerade as errors', async () => {
    await run('diagnostic.json');
    const details = workspace('diagnostic.json').locator('.result-details');
    assert.equal(await details.evaluate(element => element.open), true);
    assert.match(await details.locator('pre').first().innerText(), /显式 JSON 夹具/);
    await run('tickets.empty');
    assert.equal(await data('tickets.empty').locator('.result-record-row').count(), 0);
    assert.equal(await workspace('tickets.empty').locator('.query-error').count(), 0);
    assert.match(await workspace('tickets.empty').getByRole('group', { name: '查询结果', exact: true }).innerText(), /部分/);
  });

  await check('failure traces remain visible and locate the observed failure without rendering failed payloads', async () => {
    await run('tickets.failed');
    assert.equal(await workspace('tickets.failed').locator('.execution-trace').evaluate(element => element.open), true);
    await workspace('tickets.failed').getByText('停在「访问能力页面」', { exact: true }).waitFor();
    assert.equal(await workspace('tickets.failed').locator('.result-data').count(), 0);
    assert.equal(await workspace('tickets.failed').getByText('FAILED_PAYLOAD_SENTINEL', { exact: true }).count(), 0);
  });

  await check('table rows become readable records on 390px and 320px screens in both color schemes', async () => {
    await open('tickets.table');
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await layout(`mobile-extension-${colorScheme}-${width}`);
        assert.equal(await data('tickets.table').locator('.result-record-row').count(), 3);
        if (width === 390) await screenshot(`mobile-extension-${colorScheme}-390`, activeDialog());
      }
    }
  });

  await check('a failed capability metadata request never hides an already-authorized task result', async () => {
    const requestStart = requests.length;
    metadataFailure = true;
    await page.goto(`${origin}/tasks/metadata-fallback`);
    await page.getByRole('heading', { name: '任务详情', exact: true }).waitFor();
    await page.locator('.result-data').getByText('fallback-ready', { exact: true }).waitFor();
    await page.locator('.result-data').getByText('fallback pressure', { exact: true }).waitFor();
    await eventually(() => requests.slice(requestStart).some(item => item.path === '/admin/capabilities' && item.status === 503), 'failed metadata fallback request');
    await layout('mobile-task-metadata-fallback');
    await screenshot('mobile-task-metadata-fallback');
  });

  assert.equal(await page.evaluate(() => window.fixtureExecuted ?? 0), 0);
  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.unexpected, []);
  assert.equal(held.size, 0);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { stage, message: error instanceof Error ? error.message : String(error) };
  if (page) {
    report.resultDom = await page.locator('[data-capability-workspace]').evaluateAll(elements => elements.map(element => ({
      capability: element.getAttribute('data-capability-workspace'),
      results: element.querySelectorAll('.result-data').length,
      collections: element.querySelectorAll('.result-collection').length,
      feedItems: element.querySelectorAll('.result-feed-item').length,
    }))).catch(() => []);
    await writeFile(join(output, 'failure.html'), await page.content()).catch(() => undefined);
  }
  if (page) await screenshot('failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  for (const entry of held.values()) entry.release.resolve();
  await browser?.close(); await vite?.close(); await rm(cache, { recursive: true, force: true });
  report.requestCount = requests.length;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, screenshots: report.screenshots.length, requestCount: report.requestCount, output, ...(report.failure ? { failure: report.failure } : {}) }));
}
