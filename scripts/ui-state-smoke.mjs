#!/usr/bin/env node
// Browser checks for dashboard states, grouped navigation and durable URLs.
// All API responses are synthetic and confined to this disposable Vite origin.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let output;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out' && process.argv[i + 1]) output = resolve(process.argv[++i]);
  else if (process.argv[i] === '--help') {
    console.log('Usage: node scripts/ui-state-smoke.mjs [--out SCREENSHOT_DIRECTORY]');
    console.log('Default output: out/ui/states-<run>/ (screenshots and report.json)');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${process.argv[i]}`);
}
if (output === undefined) {
  const outputRoot = join(root, 'out/ui');
  await mkdir(outputRoot, { recursive: true });
  output = await mkdtemp(join(outputRoot, 'states-'));
}
await mkdir(output, { recursive: true });
const viteCache = await mkdtemp(join(tmpdir(), 'owngate-ui-state-vite-'));

const webRequire = createRequire(join(root, 'apps/web/package.json'));
const browserRequire = createRequire(join(root, 'apps/browser/package.json'));
const { createServer } = await import(pathToFileURL(join(dirname(webRequire.resolve('vite/package.json')), 'dist/node/index.js')).href);
const { chromium } = browserRequire('playwright');
const at = '2026-11-03T08:30:00.000Z';
const connection = {
  id: 'ui-connection', label: '个人哔哩哔哩', connector_id: 'bilibili', scope: 'personal', tags: [], paused: false, config: {},
  health: { status: 'healthy' },
  capability_states: { 'account.profile': { status: 'supported' }, 'feed.list': { status: 'supported' } }, created_at: at, updated_at: at,
};
const capability = {
  id: 'feed.list', title: '信息流', description: '', kind: 'query', effect: 'read', transport: 'browser', support: { status: 'supported' },
  input: { type: 'object', properties: { limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 } } }, output: { type: 'object' },
  cache: null, long_running: true, cancel: 'none', idempotency: 'none', verify: null, approval: 'never',
};
const newApiUser = { ...connection, id: 'ui-newapi-user', connector_id: 'newapi', label: '个人中转站',
  config: { role: 'user', base_url: 'https://user.example.invalid' }, capability_states: { 'account.balance': { status: 'supported' } } };
const newApiAdmin = { ...newApiUser, id: 'ui-newapi-admin', label: '管理中转站', config: { role: 'admin', base_url: 'https://admin.example.invalid' },
  capability_states: { 'account.balance': { status: 'supported' }, 'channel.list': { status: 'supported' }, 'channel.balance': { status: 'supported' } } };
const balanceCapability = { ...capability, id: 'account.balance', title: '账户余额', description: '读取当前账户余额。', transport: 'http', input: {}, long_running: false,
  output: { type: 'object', properties: { quota: { type: 'number', title: '可用额度' }, username: { type: 'string', title: '用户名' }, email: { type: ['string', 'null'], title: '电子邮箱' } } } };
const channelCapability = { ...balanceCapability, id: 'channel.list', title: '渠道列表', description: '读取管理员可见渠道。' };
const channelDetailCapability = { ...channelCapability, id: 'channel.balance', title: '渠道读数', input: { type: 'object', properties: { channel_id: { type: 'integer', title: '渠道编号' } } } };
const resourceCapabilities = [
  { ...balanceCapability, id: 'inventory.scan', title: '资源快照', input: { type: 'object', properties: {
    zone: { type: 'string', title: '库区标记', default: '北库' }, count: { type: 'integer', title: '采样条数', default: 3, minimum: 1, maximum: 100 },
  } }, output: { type: 'object', properties: { entries: { type: 'array', title: '采样记录', items: { type: 'object', properties: {
    record_key: { type: 'string', title: '记录编号' }, caption: { type: 'string', title: '采样设备' }, observed_load: { type: ['number', 'null'], title: '采样读数', 'x-unit': 'kWh' }, observed_at: { type: ['string', 'null'], title: '采样时间', format: 'date-time' },
  } } } } } },
  { ...balanceCapability, id: 'inventory.detail', title: '资源明细', input: { type: 'object', properties: { entry_key: { type: 'string', title: '记录编号' } } },
    output: { type: 'object', properties: { record_key: { type: 'string', title: '记录编号' }, observed_load: { type: ['number', 'null'], title: '采样读数', 'x-unit': 'kWh' } } } },
];
const meterCapability = { ...balanceCapability, id: 'meter.current', title: '仪表读数', output: { type: 'object', properties: { current: { type: 'number', title: '当前读数' } } } };
const resourceConnection = { ...connection, id: 'ui-resource', connector_id: 'warehouse_fixture', label: '北区资源台',
  config: { measurement_unit: 'kWh' }, capability_states: Object.fromEntries(resourceCapabilities.map(item => [item.id, { status: 'supported' }])) };
const otherResourceConnection = { ...resourceConnection, id: 'ui-resource-other', label: '南区资源台' };
const meterConnection = { ...connection, id: 'ui-meter', connector_id: 'meter_fixture', label: '独立仪表', config: {}, capability_states: { 'meter.current': { status: 'supported' } } };
const allConnections = [connection, newApiUser, newApiAdmin, resourceConnection, otherResourceConnection, meterConnection];
const newApiView = { id: 'channel-reading', type: 'comparison', title: '渠道读数核对', description: '本地合成声明，不会访问真实站点。',
  source: { capability: 'channel.list', items: '$.items', id: 'id', label: 'name', value: 'balance', updated_at: 'updated_at', updated_at_format: 'unix_seconds', unit: { config: 'balance_unit', allowed: ['USD'] } },
  detail: { capability: 'channel.balance', input: 'channel_id', id: 'id' }, target: { capability: 'account.balance', value: 'quota' } };
const resourceView = { id: 'resource-readings', type: 'comparison', title: '资源读数比较', description: '以声明指定资源字段和 kWh 单位，关联独立仪表。',
  source: { capability: 'inventory.scan', items: '$.entries', id: 'record_key', label: 'caption', value: 'observed_load', updated_at: 'observed_at', updated_at_format: 'iso8601', unit: { config: 'measurement_unit', allowed: ['kWh', 'Wh'] } },
  detail: { capability: 'inventory.detail', input: 'entry_key', id: 'record_key' }, target: { capability: 'meter.current', value: 'current' } };
let newApiDeclaration = true, resourceDeclaration = true, resourceTitle = resourceView.title, resourceGate = 'supported';
let rejectMapping = false, rejectComparison = false, heldComparison;
const comparisonLinks = [];
const result = { outcome: 'success', status: 'ok', data: { items: [] }, error: null, fields: {},
  source: { connection_id: connection.id, connection_label: connection.label, capability_id: capability.id },
  queried_at: at, data_time: at, cache: { hit: false }, warnings: [],
};
const task = { id: 'ui-task', connection_id: connection.id, capability_id: capability.id, status: 'success',
  created_at: at, started_at: at, finished_at: at, attempts: 1, input: { limit: 20 }, result, cancellation: null };
const report = { status: 'running', source: 'local synthetic API fixtures; no live platform or user deployment access',
  checks: [], screenshots: [], requests: [], browserErrors: [], consoleErrors: [], unexpected: [], layouts: [], navigation: [],
};
let mode = 'populated', revision = 1, stage = 'start', releaseOverview;
let vite, browser, context, page, origin;

function overview() {
  return { connections: mode === 'empty' ? [] : [connection,
    newApiUser,
    { ...connection, id: 'ui-zhihu', connector_id: 'zhihu', label: revision === 1 ? '知乎 · 待授权' : '知乎 · 已恢复',
      health: { status: revision === 1 ? 'needs_auth' : 'healthy' },
      capability_states: { 'feed.list': { status: revision === 1 ? 'needs_auth' : 'supported' } } }],
  tasks: mode === 'empty' ? [] : [task], pending_proposals: 0,
  alerts: mode === 'empty' ? [] : [{ at, action: 'monitor.checked', target: '余额监控' }], actions_enabled: false };
}
function fixture(url, method, body) {
  const path = url.pathname;
  if (method === 'POST' && path === '/admin/invoke') {
    const selected = allConnections.find(item => item.id === body?.connection_id);
    assert(selected && selected.connector_id === 'newapi', 'ordinary queries must keep the selected connection');
    assert.deepEqual(body, { connection_id: selected.id, capability_id: 'account.balance', input: {}, no_cache: true });
    return newApiResult(selected, body.capability_id);
  }
  const comparison = /^\/admin\/connections\/([^/]+)\/views\/([^/]+)\/(links|run)(?:\/([^/]+))?$/.exec(path);
  if (comparison) {
    const [, encodedId, encodedViewId, action, encodedItemId] = comparison;
    const id = decodeURIComponent(encodedId), viewId = decodeURIComponent(encodedViewId), itemId = encodedItemId ? decodeURIComponent(encodedItemId) : undefined;
    const selected = allConnections.find(item => item.id === id);
    assert(selected, 'comparison request must refer to an existing connection');
    assert((selected.connector_id === 'warehouse_fixture' && viewId === resourceView.id) || (selected.id === newApiAdmin.id && viewId === newApiView.id), 'comparison must use a declared view for this connection');
    if (action === 'links' && method === 'GET') return { links: comparisonLinks.filter(link => link.connection_id === id && link.view_id === viewId) };
    if (action === 'links' && method === 'PUT') {
      assert(itemId); assert.deepEqual(body, { target_connection_id: meterConnection.id });
      if (rejectMapping) return { fixture_status: 503, fixture_body: { code: 'FIXTURE_LINK_REFUSED', message: '本地夹具拒绝保存映射' } };
      const record = { connection_id: id, view_id: viewId, item_id: itemId, target_connection_id: body.target_connection_id, created_at: at };
      const previous = comparisonLinks.findIndex(link => link.connection_id === id && link.view_id === viewId && link.item_id === itemId);
      if (previous >= 0) comparisonLinks[previous] = record; else comparisonLinks.push(record);
      return record;
    }
    if (action === 'links' && method === 'DELETE') {
      assert(itemId); assert.equal(body, undefined);
      const previous = comparisonLinks.findIndex(link => link.connection_id === id && link.view_id === viewId && link.item_id === itemId);
      if (previous >= 0) comparisonLinks.splice(previous, 1);
      return { ok: true };
    }
    if (action === 'run' && method === 'POST') {
      assert(!itemId);
      assert.deepEqual(body, { input: selected.connector_id === 'warehouse_fixture' ? { zone: '西库', count: 2 } : {} }, 'run input must come from the source capability schema, without an extra verification');
      if (rejectComparison) return { fixture_status: 503, fixture_body: { code: 'FIXTURE_COMPARE_UNAVAILABLE', message: '本地比较服务暂不可用' } };
      return comparisonResult(selected, viewId);
    }
    throw new Error(`Unexpected comparison operation: ${method} ${path}`);
  }
  if (method !== 'GET') throw new Error(`Unexpected fixture mutation: ${method} ${path}`);
  if (path === '/auth/status') return { hasUser: true, authenticated: true, stepUp: true, totpEnabled: true, passkeyCount: 0 };
  if (path === '/admin/overview') return overview();
  if (path === '/admin/connections') return { connections: allConnections };
  if (path === '/admin/connectors') return { connectors: [{ id: 'bilibili', title: '哔哩哔哩', transport: 'browser', has_login: true, has_auth: false, config: {}, views: [] },
    { id: 'newapi', title: 'New API', transport: 'http', has_login: false, has_auth: false, config: {}, views: newApiDeclaration ? [newApiView] : [] },
    { id: 'warehouse_fixture', title: '资源工作台', transport: 'http', has_login: false, has_auth: false, config: {}, views: resourceDeclaration ? [{ ...resourceView, title: resourceTitle }] : [] },
    { id: 'meter_fixture', title: '独立仪表', transport: 'http', has_login: false, has_auth: false, config: {}, views: [] }] };
  if (path === '/admin/capabilities') {
    const connectorId = url.searchParams.get('connector_id'), selected = allConnections.find(item => item.id === url.searchParams.get('connection_id'));
    assert(selected && selected.connector_id === connectorId, 'capability metadata must belong to the requested connection');
    if (connectorId === 'newapi') return { capabilities: selected.id === newApiAdmin.id ? [balanceCapability, channelCapability, channelDetailCapability] : [balanceCapability] };
    if (connectorId === 'warehouse_fixture') return { capabilities: resourceGate === 'missing-detail' ? [resourceCapabilities[0]] : resourceCapabilities.map(item => {
      if ((resourceGate === 'action' && item.id === resourceView.source.capability) || (resourceGate === 'detail-action' && item.id === resourceView.detail.capability)) return { ...item, kind: 'action', effect: 'external_send' };
      return item.id === resourceView.source.capability ? { ...item, support: { status: ['disabled', 'unsupported'].includes(resourceGate) ? resourceGate : 'supported' } } : item;
    }) };
    if (connectorId === 'meter_fixture') return { capabilities: [meterCapability] };
    return { capabilities: [capability] };
  }
  if (path.endsWith('/credentials')) return { fields: [] };
  if (path === '/admin/tasks') return { tasks: [task] };
  if (path === `/admin/tasks/${task.id}`) return task;
  if (path === `/admin/tasks/${task.id}/events`) return { events: [{ id: 1, at, event: 'task.created', detail: {} }, { id: 2, at, event: 'task.completed', detail: {} }] };
  throw new Error(`Unexpected fixture API: ${path}`);
}
function newApiResult(selected, capabilityId) {
  return { ...result, source: { connection_id: selected.id, connection_label: selected.label, capability_id: capabilityId },
    data: capabilityId === 'account.balance' ? { quota: selected.id === newApiAdmin.id ? 200 : 100, username: '示例用户', email: null } : { items: [] },
    fields: capabilityId === 'account.balance' ? { quota: { status: 'ok', unit: 'USD' }, email: { status: 'redacted' } } : {} };
}
function comparisonResult(selected, viewId) {
  const isResource = selected.connector_id === 'warehouse_fixture';
  const linked = comparisonLinks.find(link => link.connection_id === selected.id && link.view_id === viewId && link.item_id === 'entry-a');
  const prefix = selected.id === otherResourceConnection.id ? '南区' : '北区';
  const target = { ...result, outcome: 'success', data: { current: 13 }, fields: { current: { status: 'ok', unit: 'kWh' } },
    source: { connection_id: meterConnection.id, connection_label: meterConnection.label, capability_id: 'meter.current' } };
  return { outcome: 'partial', source: { ...result, outcome: 'partial', source: { connection_id: selected.id, connection_label: selected.label, capability_id: isResource ? resourceView.source.capability : newApiView.source.capability },
    data: isResource ? { entries: [
      { record_key: 'entry-a', caption: `${prefix}冷却系统`, observed_load: 18, observed_at: at },
      { record_key: 'entry-b', caption: `${prefix}照明系统`, observed_load: 20, observed_at: at },
      { record_key: 'entry-c', caption: `${prefix}备用系统`, observed_load: null, observed_at: null },
    ] } : { items: [] } },
    rows: isResource ? [
      { item_id: 'entry-a', label: `${prefix}冷却系统`, source_value: { value: 18, unit: 'kWh', updated_at: at }, target_connection_id: linked?.target_connection_id ?? null,
        target: linked ? target : null, comparison: linked ? { status: 'comparable', unit: 'kWh', difference: 5, reason: '同为 kWh，可比较读数；采样时间不同。' } : { status: 'unlinked', reason: '尚未关联对照连接' } },
      { item_id: 'entry-b', label: `${prefix}照明系统`, source_value: { value: 20, unit: 'kWh', updated_at: at }, target_connection_id: meterConnection.id,
        target: { ...target, data: { current: 20000 }, fields: { current: { status: 'ok', unit: 'Wh' } } }, comparison: { status: 'unknown_unit', reason: '两端单位不同，保留各自读数' } },
      { item_id: 'entry-c', label: `${prefix}备用系统`, source_value: { value: null, unit: 'kWh', updated_at: null }, target_connection_id: meterConnection.id,
        target: { ...target, outcome: 'error', data: null, fields: {}, error: { code: 'METER_OFFLINE', message: '合成仪表暂时离线' } }, comparison: { status: 'unavailable', reason: '对照查询失败，保留其他项目结果' } },
    ] : [] };
}
async function eventually(check, description) {
  const deadline = Date.now() + 6000;
  do { if (await check()) return; await delay(25); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}
async function check(name, action) { stage = name; await action(); report.checks.push(name); }
async function emulateTheme(colorScheme) {
  await page.emulateMedia({ colorScheme });
  // Chromium delivers matchMedia change events after emulateMedia resolves.
  // Wait for the app's system-theme listener and CSS before inspecting layout.
  await eventually(() => page.evaluate(expected => {
    const root = document.documentElement;
    return matchMedia('(prefers-color-scheme: dark)').matches === (expected === 'dark')
      && root.dataset.theme === expected
      && getComputedStyle(root).colorScheme.split(/\s+/).includes(expected);
  }, colorScheme), `${colorScheme} media, applied theme and native-control scheme must agree`);
}
async function screenshot(name, { fullPage = true } = {}) {
  const filename = `${name}.png`;
  const hasModal = await page.locator('dialog[open]').count() > 0;
  await page.screenshot({ path: join(output, filename), fullPage: fullPage && !hasModal, animations: 'disabled' });
  report.screenshots.push(filename);
}
const main = () => page.locator('main');
const drawer = () => page.getByRole('dialog', { name: '导航菜单', exact: true });
const menu = () => page.getByRole('button', { name: '打开导航', exact: true });
async function navigate(label, heading) {
  if (await menu().isVisible() && await menu().getAttribute('aria-expanded') !== 'true') await menu().click();
  await page.locator('.nav').getByRole('link', { name: label, exact: true }).click();
  if (await menu().isVisible()) await drawer().waitFor({ state: 'hidden' });
  if (heading) await main().getByRole('heading', { name: heading, exact: true }).waitFor();
}
async function noOverflow(description) {
  const measurement = await page.evaluate(() => {
    const modal = document.querySelector('dialog[open]:has([data-comparison-view-id])'), box = modal?.getBoundingClientRect(), content = modal?.querySelector('.page-dialog-content');
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      mainWidth: document.querySelector('main')?.getBoundingClientRect().width ?? 0,
      mainRight: document.querySelector('main')?.getBoundingClientRect().right ?? 0,
      ...(box ? { dialog: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth } } : {}),
    };
  });
  report.layouts.push({ description, ...measurement });
  assert(measurement.documentWidth <= measurement.width + 1, `${description}: horizontal document overflow`);
  assert(measurement.mainWidth > 0 && measurement.mainRight <= measurement.width + 1, `${description}: content must fit the viewport`);
  if (measurement.dialog) {
    assert(measurement.dialog.left >= -1 && measurement.dialog.right <= measurement.width + 1 && measurement.dialog.top >= -1 && measurement.dialog.bottom <= measurement.height + 1, `${description}: comparison dialog must fit the viewport`);
    assert(measurement.dialog.contentScrollWidth <= measurement.dialog.contentWidth + 1, `${description}: comparison content must not overflow horizontally`);
  }
}
const comparisonWorkspace = () => page.locator('dialog[open] [data-comparison-view-id]');
const comparisonRow = id => comparisonWorkspace().locator(`[data-comparison-item-id="${id}"]`);
const mutationCount = () => report.requests.filter(item => item.method !== 'GET').length;
const comparisonRunCount = () => report.requests.filter(item => item.method === 'POST' && /\/views\/[^/]+\/run$/.test(item.path)).length;
async function visitConnection(selected) {
  await page.goto(`${origin}/connections/${selected.id}`);
  await main().getByRole('heading', { name: selected.label, exact: true }).waitFor();
  await main().locator('.capability-card').first().waitFor();
}
async function openComparison(selected, view = resourceView, title = resourceTitle) {
  const before = mutationCount();
  await main().getByRole('button', { name: title, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await dialog.waitFor();
  await comparisonWorkspace().waitFor();
  assert.equal(await comparisonWorkspace().getAttribute('data-comparison-view-id'), view.id);
  await eventually(() => report.requests.some(item => item.method === 'GET' && item.path === `/admin/connections/${selected.id}/views/${view.id}/links`), 'comparison mapping metadata loads for the selected connection');
  assert.equal(mutationCount(), before, 'opening a comparison view must not execute, verify or save');
  return dialog;
}
async function closeComparison(title = resourceTitle) {
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await dialog.getByRole('button', { name: `关闭${title}`, exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function fillResourceParameters() {
  await comparisonWorkspace().getByLabel('库区标记', { exact: true }).fill('西库');
  await comparisonWorkspace().getByLabel('采样条数', { exact: true }).fill('2');
}
async function runComparison(selected = resourceConnection, { expectFailure = false } = {}) {
  const before = comparisonRunCount(), path = `/admin/connections/${selected.id}/views/${resourceView.id}/run`;
  const response = page.waitForResponse(item => new URL(item.url()).pathname === path && item.request().method() === 'POST');
  await comparisonWorkspace().getByRole('button', { name: '读取并比较', exact: true }).click();
  assert.equal((await response).status(), expectFailure ? 503 : 200);
  assert.equal(comparisonRunCount(), before + 1, 'one explicit submission must cause exactly one comparison request');
  if (expectFailure) await comparisonWorkspace().getByRole('alert').filter({ hasText: '本地比较服务暂不可用' }).waitFor();
  else await comparisonRow('entry-a').waitFor();
}
async function readyOverview() {
  await main().getByRole('heading', { name: '概览', exact: true }).waitFor();
  await main().getByText(connection.label, { exact: true }).waitFor();
  await main().locator('time[datetime]').first().waitFor();
}
async function navigationIcons(navigation, shell, name) {
  const destinations = [
    ['概览', 'overview'], ['任务', 'tasks'],
    ['连接', 'connections'], ['扩展', 'extensions'], ['监控通知', 'monitors'],
    ['提案', 'proposals'], ['客户端', 'clients'], ['MCP 工具', 'mcp-tools'],
    ['审计记录', 'audit'], ['设置', 'settings'],
  ];
  assert.deepEqual(await navigation.getByRole('link').allTextContents(), destinations.map(([label]) => label), `${name}: navigation labels and order match the focused destinations`);
  assert.deepEqual(await navigation.locator('.nav-group').filter({ hasText: '常用' }).getByRole('link').allTextContents(), ['概览', '任务'], `${name}: common navigation contains overview and tasks`);
  assert.equal(await navigation.getByRole('link', { name: '信息流', exact: true }).count(), 0, `${name}: platform content stays inside its connection`);
  for (const [label, iconName] of destinations) {
    const link = navigation.getByRole('link', { name: label, exact: true });
    assert.equal(await link.count(), 1, `${name}: ${label} keeps its accessible name`);
    const icon = link.locator(`svg.ui-icon[data-icon="${iconName}"]`);
    assert.equal(await icon.count(), 1, `${name}: ${label} has one matching icon`);
    assert.equal(await icon.getAttribute('aria-hidden'), 'true', `${name}: icons are decorative`);
    assert.equal(await icon.getAttribute('focusable'), 'false', `${name}: icons do not add tab stops`);
    const bounds = await icon.boundingBox();
    assert(bounds && Math.abs(bounds.width - 18) < 1 && Math.abs(bounds.height - 18) < 1, `${name}: navigation icons retain their intended size`);
  }
  const brand = shell.getByRole('link', { name: 'OwnGate', exact: true });
  assert.equal(await brand.count(), 1, `${name}: the brand link retains its accessible name`);
  const mark = brand.locator('img.brand-mark');
  assert.equal(await mark.getAttribute('alt'), '', `${name}: the brand image does not duplicate the visible label`);
  assert.equal(await mark.getAttribute('aria-hidden'), 'true');
  assert.equal(await mark.getAttribute('src'), '/favicon.svg?v=owngate-d-1');
  await eventually(() => mark.evaluate(element => element.complete && element.naturalWidth > 0), 'the shared brand asset loads');
  assert.equal(await page.locator('link[rel="icon"][type="image/svg+xml"]').getAttribute('href'), '/favicon.svg?v=owngate-d-1');
  report.navigation.push({ name, labels: destinations.map(([label]) => label), decorativeIcons: destinations.length, brandLoaded: true });
}

try {
  vite = await createServer({ root: join(root, 'apps/web'), configFile: join(root, 'apps/web/vite.config.ts'), cacheDir: viteCache,
    server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  await vite.listen();
  const address = vite.httpServer.address();
  assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'UTC', colorScheme: 'dark' });
  context.on('page', opened => {
    opened.setDefaultTimeout(7000);
    opened.on('pageerror', error => report.browserErrors.push(error.stack ?? error.message));
    opened.on('console', message => { if (message.type() === 'error' && !/^Failed to load resource: the server responded with a status of (404|503)/.test(message.text())) report.consoleErrors.push(message.text()); });
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { report.unexpected.push(`External request refused: ${url.origin}${url.pathname}`); return route.abort(); }
    if (!url.pathname.startsWith('/auth/') && !url.pathname.startsWith('/admin/')) return route.continue();
    const body = request.postData() ? request.postDataJSON() : undefined;
    const entry = { path: url.pathname, query: url.search, method: request.method(), ...(body !== undefined ? { body } : {}), mode, status: 200 };
    report.requests.push(entry);
    try {
      if (url.pathname === '/admin/overview' && mode === 'delayed') await new Promise(resolve => { releaseOverview = resolve; });
      if (url.pathname === '/admin/overview' && ['error404', 'error503'].includes(mode)) {
        entry.status = mode === 'error404' ? 404 : 503;
        return route.fulfill({ status: entry.status, json: { error: entry.status === 404 ? 'Not Found' : 'Fixture temporarily unavailable', code: entry.status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE' } });
      }
      if (heldComparison && url.pathname === `/admin/connections/${heldComparison.connectionId}/views/${resourceView.id}/run` && request.method() === 'POST') {
        const held = heldComparison; held.arrived.resolve(); await held.release.promise;
        if (heldComparison === held) heldComparison = undefined;
      }
      const response = fixture(url, request.method(), body);
      entry.status = response.fixture_status ?? 200;
      return route.fulfill({ status: entry.status, json: structuredClone(response.fixture_body ?? response) });
    } catch (error) {
      report.unexpected.push(error instanceof Error ? error.message : String(error));
      return route.fulfill({ status: 500, json: { error: 'Unexpected local fixture request' } });
    }
  });
  page = await context.newPage();

  await check('delayed overview has an explicit loading state', async () => {
    mode = 'delayed';
    await page.goto(origin);
    await main().getByRole('status').filter({ hasText: '正在读取概览…' }).waitFor();
    assert.equal(await main().getByRole('heading', { name: '最近任务', exact: true }).count(), 0);
    assert.equal(await main().getByRole('heading', { name: '最近监控', exact: true }).count(), 0);
    await screenshot('dark-overview-loading');
    await eventually(() => typeof releaseOverview === 'function', 'the overview fixture must be waiting');
    mode = 'populated'; releaseOverview(); releaseOverview = undefined;
    await readyOverview();
  });

  await check('both themes fit desktop and narrow mobile viewports with visible grouped navigation', async () => {
    for (const colorScheme of ['light', 'dark']) {
      await emulateTheme(colorScheme);
      for (const width of [1280, 1920, 2560, 390, 320]) {
        await page.setViewportSize({ width, height: width > 900 ? 1000 : 844 });
        await readyOverview();
        await noOverflow(`${colorScheme} ${width}px overview`);
        const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
        assert(scheme.includes(colorScheme), `${colorScheme} theme must reach native controls`);
        assert(await main().getByRole('link', { name: '管理连接', exact: true }).isVisible());
        assert.equal(await main().getByRole('button', { name: '停止全部写操作', exact: true }).isVisible(), false,
          'emergency controls must remain collapsed until requested');
        if (width > 900) {
          assert.equal(await menu().isVisible(), false);
          const navigation = page.locator('aside.sidebar:visible .nav');
          assert.equal(await navigation.getByRole('link').count(), 10);
          assert.equal(await navigation.getByRole('link', { name: 'New API', exact: true }).count(), 0, 'a connection type must not be a top-level destination');
          const accessGroup = navigation.locator('.nav-group').filter({ hasText: '接入' });
          assert.deepEqual(await accessGroup.getByRole('link').allTextContents(), ['连接', '扩展']);
          assert.equal(await navigation.getByRole('link', { name: '审计记录', exact: true }).count(), 1);
          await navigationIcons(navigation, page.locator('aside.sidebar:visible'), `${colorScheme} ${width}px desktop`);
          const size = await navigation.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
          assert(size.scroll <= size.width + 1, 'desktop navigation must not scroll horizontally');
        } else {
          assert(await menu().isVisible());
          await menu().click(); await drawer().waitFor();
          assert.equal(await drawer().locator('.nav').getByRole('link').count(), 10);
          assert.equal(await drawer().locator('.nav').getByRole('link', { name: 'New API', exact: true }).count(), 0);
          await navigationIcons(drawer().locator('.nav'), drawer(), `${colorScheme} ${width}px drawer`);
          const current = drawer().locator('.nav a[aria-current="page"]');
          assert(await current.isVisible());
          await eventually(() => current.evaluate(element => element === document.activeElement), 'opening the drawer must focus the current route');
          await page.keyboard.press('Escape'); await drawer().waitFor({ state: 'hidden' });
          await eventually(() => menu().evaluate(element => element === document.activeElement), 'Escape restores the menu focus');
        }
        if (colorScheme === 'dark' && [1920, 2560, 390, 320].includes(width)) await screenshot(`dark-overview-${width}`);
        if (colorScheme === 'light' && width === 1920) await screenshot('light-overview-1920');
      }
    }
  });

  await check('mobile drawer keeps background controls out of the tab order, closes with Escape or backdrop, and restores focus', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await menu().click(); await drawer().waitFor();
    await eventually(() => drawer().locator('.nav a[aria-current="page"]').evaluate(element => element === document.activeElement),
      'opening the drawer must focus the current route');
    await screenshot('dark-mobile-navigation-390', { fullPage: false });
    for (let index = 0; index < 18; index++) {
      await page.keyboard.press('Tab');
      const focus = await drawer().evaluate(element => ({ inside: element.contains(document.activeElement),
        browserChrome: document.activeElement === document.body && !document.hasFocus(),
      }));
      // A native modal can Tab into the browser toolbar; its page background
      // must stay inert, and the next Tab must return to the modal itself.
      assert(focus.inside || focus.browserChrome, 'Tab must not reach background page controls');
      if (focus.browserChrome) {
        await page.keyboard.press('Tab');
        assert(await drawer().evaluate(element => element.contains(document.activeElement)), 'Tab from the browser toolbar must return to the modal navigation');
      }
    }
    await page.keyboard.press('Escape'); await drawer().waitFor({ state: 'hidden' });
    await eventually(() => menu().evaluate(element => element === document.activeElement), 'Escape restores focus');
    await menu().click(); await drawer().waitFor();
    const box = await drawer().boundingBox();
    assert(box && box.x + box.width < 389, 'a mobile backdrop must remain exposed');
    await page.mouse.click(Math.min(388, box.x + box.width + 10), 20);
    await drawer().waitFor({ state: 'hidden' });
    await eventually(() => menu().evaluate(element => element === document.activeElement), 'backdrop restores focus');
    await navigate('连接', '连接');
    assert.equal(new URL(page.url()).pathname, '/connections');
    await eventually(() => menu().evaluate(element => element === document.activeElement), 'navigation restores focus');
  });

  await check('connection and task URLs survive reload, browser history and new tabs; unknown URLs recover', async () => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.locator('li.card').filter({ hasText: connection.label }).getByRole('button', { name: '查看', exact: true }).click();
    await page.waitForURL(`**/connections/${connection.id}`);
    await main().getByRole('heading', { name: connection.label, exact: true }).waitFor();
    await page.reload();
    await main().getByRole('heading', { name: connection.label, exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, `/connections/${connection.id}`);
    await page.goBack(); await main().getByRole('heading', { name: '连接', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/connections');
    await page.goForward(); await main().getByRole('heading', { name: connection.label, exact: true }).waitFor();
    assert.equal(await main().getByRole('link', { name: '账户与渠道', exact: true }).count(), 0, 'other connection types must not advertise New API tools');
    await navigate('任务', '任务');
    await main().getByRole('link', { name: '查看结果与过程', exact: true }).click();
    await page.waitForURL(`**/tasks/${task.id}`);
    await main().getByRole('heading', { name: '任务详情', exact: true }).waitFor();
    await page.reload();
    await main().getByRole('heading', { name: '任务详情', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, `/tasks/${task.id}`);
    await page.goBack(); await main().getByRole('heading', { name: '任务', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/tasks');
    await page.goForward(); await main().getByRole('heading', { name: '任务详情', exact: true }).waitFor();
    const copied = await context.newPage();
    try {
      await copied.goto(page.url());
      await copied.locator('main').getByRole('heading', { name: '任务详情', exact: true }).waitFor();
      assert.equal(new URL(copied.url()).pathname, `/tasks/${task.id}`);
    } finally { await copied.close(); }
    const opened = context.waitForEvent('page');
    await page.locator('.nav').getByRole('link', { name: '连接', exact: true }).click({ modifiers: ['Control'] });
    const linked = await opened;
    try {
      await linked.waitForLoadState();
      await linked.locator('main').getByRole('heading', { name: '连接', exact: true }).waitFor();
      assert.equal(new URL(linked.url()).pathname, '/connections');
      assert.equal(new URL(page.url()).pathname, `/tasks/${task.id}`, 'modified link clicks must leave the original route intact');
    } finally { await linked.close(); }
    await page.goto(`${origin}/ui-missing-route`);
    await main().getByRole('heading', { name: '找不到页面', exact: true }).waitFor();
    await main().getByRole('link', { name: '返回概览', exact: true }).click();
    await readyOverview();
    assert.equal(new URL(page.url()).pathname, '/');
  });

  await check('removed routes show recovery guidance without requesting an aggregate feed or changing history', async () => {
    const feedRequestsBefore = report.requests.filter(request => request.path === '/admin/feed').length;
    for (const path of ['/feed?removed=1#old-content', '/new-api', `/connections/${newApiAdmin.id}/new-api`]) {
      await page.goto(`${origin}/tasks`);
      await main().getByRole('heading', { name: '任务', exact: true }).waitFor();
      await page.goto(`${origin}${path}`);
      await main().getByRole('heading', { name: '找不到页面', exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, path.split('?')[0]);
      await page.reload();
      await main().getByRole('heading', { name: '找不到页面', exact: true }).waitFor();
      await page.goBack();
      await main().getByRole('heading', { name: '任务', exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/tasks');
      await page.goForward();
      await main().getByRole('heading', { name: '找不到页面', exact: true }).waitFor();
      await main().getByRole('link', { name: '返回概览', exact: true }).click();
      await readyOverview();
    }
    assert.equal(report.requests.filter(request => request.path === '/admin/feed').length, feedRequestsBefore, 'removed routes must not fetch the aggregate feed');
  });

  await check('ordinary New API queries use the same capability dialogs and never add a business page without a declaration', async () => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    newApiDeclaration = false;
    for (const selected of [newApiUser, newApiAdmin]) {
      await visitConnection(selected);
      assert.equal(await main().getByRole('link', { name: '账户与渠道', exact: true }).count(), 0);
      assert.equal(await main().getByRole('button', { name: newApiView.title, exact: true }).count(), 0, 'a connector ID must not create an undeclared comparison entry');
      assert.equal(await main().getByRole('heading', { name: '账户查询', exact: true }).count(), 0);
      assert.equal(await main().getByRole('combobox', { name: '查询内容', exact: true }).count(), 0);
      assert.equal(await main().getByRole('button', { name: /切换.*角色|管理员|普通用户/ }).count(), 0, 'the UI must not invent role-specific actions');
      const navigation = page.locator('aside.sidebar:visible .nav');
      assert.equal(await navigation.getByRole('link', { name: '连接', exact: true }).getAttribute('aria-current'), 'page');
      const before = mutationCount();
      await main().locator('[data-capability-id="account.balance"] .capability-open').click();
      const dialog = page.getByRole('dialog', { name: '账户余额', exact: true });
      const workspace = dialog.locator('[data-capability-workspace="account.balance"]');
      await workspace.waitFor();
      assert.equal(mutationCount(), before, 'opening an ordinary query must not invoke or verify it');
      assert.equal(await workspace.getByRole('group', { name: '查询结果', exact: true }).count(), 0);
      const response = page.waitForResponse(item => new URL(item.url()).pathname === '/admin/invoke' && item.request().method() === 'POST');
      await workspace.getByRole('button', { name: '试一下', exact: true }).click();
      assert.equal((await response).status(), 200);
      const summary = workspace.getByRole('group', { name: '查询结果', exact: true });
      await summary.getByRole('definition').filter({ hasText: 'USD' }).waitFor();
      assert.equal((await summary.getByRole('definition').filter({ hasText: 'USD' }).textContent()).trim(), `${selected.id === newApiAdmin.id ? 200 : 100}USD`);
      await summary.getByText('已隐藏', { exact: true }).waitFor();
      assert.equal(await summary.locator('pre.envelope').first().isVisible(), false);
      await summary.getByText('详细数据', { exact: true }).click();
      assert.deepEqual(JSON.parse(await summary.locator('pre.envelope').first().textContent()), { quota: selected.id === newApiAdmin.id ? 200 : 100, username: '示例用户', email: null });
      await summary.getByText('详细数据', { exact: true }).click();
      await noOverflow(`dark 1280 ordinary ${selected.id}`);
      await screenshot(`dark-unified-query-${selected.config.role}-1280`);
      if (selected.id === newApiUser.id) {
        await page.setViewportSize({ width: 390, height: 844 });
        await noOverflow('dark 390 ordinary New API result');
        await screenshot('dark-unified-query-user-390');
      }
      await dialog.getByRole('button', { name: '关闭账户余额', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(new URL(page.url()).pathname, `/connections/${selected.id}`, 'ordinary queries must remain on the connection URL');
      if (selected.id === newApiUser.id) {
        await menu().click(); await drawer().waitFor();
        const current = drawer().locator('.nav a[aria-current="page"]');
        assert.equal(await current.textContent(), '连接');
        await eventually(() => current.evaluate(element => element === document.activeElement), 'the connection dialog belongs to its parent navigation');
        await screenshot('dark-unified-query-navigation-390', { fullPage: false });
        await page.keyboard.press('Escape'); await drawer().waitFor({ state: 'hidden' });
      }
      await page.setViewportSize({ width: 1280, height: 1000 });
    }
    newApiDeclaration = true;
  });

  await check('declared comparison entries follow filtered read capabilities and metadata instead of connector IDs or role controls', async () => {
    await visitConnection(newApiUser);
    assert.equal(await main().getByRole('button', { name: newApiView.title, exact: true }).count(), 0, 'an ordinary connection lacks the source and detail capabilities required by the view');
    assert.equal(await main().getByRole('button', { name: /管理员|普通用户|切换.*角色/ }).count(), 0);
    await visitConnection(newApiAdmin);
    await main().getByRole('button', { name: newApiView.title, exact: true }).waitFor();
    const before = mutationCount();
    await openComparison(newApiAdmin, newApiView, newApiView.title);
    await screenshot('dark-declared-admin-comparison-1280');
    await closeComparison(newApiView.title);
    assert.equal(mutationCount(), before);
    await visitConnection(resourceConnection);
    await main().getByRole('button', { name: resourceTitle, exact: true }).waitFor();
    assert.equal(Object.hasOwn(resourceConnection.config, 'role'), false, 'the custom connector intentionally has no role setting');
    await screenshot('dark-custom-connection-entry-1280');
    for (const gate of ['disabled', 'unsupported', 'action', 'detail-action', 'missing-detail']) {
      resourceGate = gate;
      resourceConnection.capability_states['inventory.scan'] = { status: ['disabled', 'unsupported'].includes(gate) ? gate : 'supported' };
      await page.reload(); await main().locator('[data-capability-id="inventory.scan"]').waitFor();
      assert.equal(await main().getByRole('button', { name: resourceTitle, exact: true }).count(), 0, `${gate}: nonexecutable or absent source/detail capabilities must suppress the comparison entry`);
    }
    resourceGate = 'supported'; resourceConnection.capability_states['inventory.scan'] = { status: 'supported' };
    resourceTitle = '声明修改后的读数核对';
    await page.reload(); await main().getByRole('button', { name: resourceTitle, exact: true }).waitFor();
    assert.equal(await main().getByRole('button', { name: resourceView.title, exact: true }).count(), 0);
    await openComparison(resourceConnection); await closeComparison();
    resourceDeclaration = false;
    await page.reload(); await main().locator('[data-capability-id="inventory.scan"]').waitFor();
    assert.equal(await main().getByRole('button', { name: resourceTitle, exact: true }).count(), 0, 'removing a declaration removes its entry');
    resourceDeclaration = true; resourceTitle = resourceView.title;
    await page.reload(); await main().getByRole('button', { name: resourceTitle, exact: true }).waitFor();
    assert.equal(mutationCount(), before, 'metadata, declaration changes and opening a view must not execute any capability');
  });

  await check('custom comparison fields, units and partial failures render inside a generic modal without preverification', async () => {
    await openComparison(resourceConnection);
    assert.equal(await comparisonWorkspace().getByLabel('库区标记', { exact: true }).inputValue(), '北库');
    assert.equal(await comparisonWorkspace().getByLabel('采样条数', { exact: true }).inputValue(), '3');
    assert.equal(await comparisonWorkspace().getByLabel('页码', { exact: true }).count(), 0, 'source parameters must not be a fixed pagination form');
    await fillResourceParameters();
    const before = mutationCount();
    await runComparison();
    assert.equal(mutationCount(), before + 1, 'comparison must call only the generic run endpoint once');
    await comparisonRow('entry-a').getByText('北区冷却系统', { exact: false }).waitFor();
    await comparisonRow('entry-a').getByText('尚未关联对照连接', { exact: false }).waitFor();
    await comparisonRow('entry-b').getByText('两端单位不同，保留各自读数', { exact: false }).waitFor();
    await comparisonRow('entry-c').getByText('对照查询失败，保留其他项目结果', { exact: false }).waitFor();
    assert.match(await comparisonRow('entry-a').innerText(), /18\s*kWh/);
    assert.equal(await comparisonRow('entry-a').getByRole('combobox', { name: '对照连接', exact: true }).locator(`option[value="${meterConnection.id}"]`).count(), 1);
    assert.equal(await comparisonRow('entry-a').getByRole('combobox', { name: '对照连接', exact: true }).locator(`option[value="${newApiUser.id}"]`).count(), 0, 'target options must expose the declared target capability');
    assert.equal(report.requests.filter(item => item.path.endsWith('/verify') || item.path.startsWith('/admin/newapi/')).length, 0);
    await screenshot('dark-custom-comparison-partial-1280');
  });

  await check('mapping failures retain their draft, saves and removal use generic endpoints, and matching units expose the difference', async () => {
    const row = comparisonRow('entry-a'), target = row.getByRole('combobox', { name: '对照连接', exact: true });
    const path = `/admin/connections/${resourceConnection.id}/views/${resourceView.id}/links/entry-a`;
    await target.selectOption(meterConnection.id);
    rejectMapping = true;
    let response = page.waitForResponse(item => new URL(item.url()).pathname === path && item.request().method() === 'PUT');
    await row.getByRole('button', { name: '保存映射', exact: true }).click();
    assert.equal((await response).status(), 503);
    await row.getByRole('alert').filter({ hasText: '本地夹具拒绝保存映射' }).waitFor();
    assert.equal(await target.inputValue(), meterConnection.id);
    assert.equal(comparisonLinks.some(link => link.connection_id === resourceConnection.id && link.item_id === 'entry-a'), false);
    await screenshot('dark-custom-comparison-mapping-failed-1280');
    rejectMapping = false;
    response = page.waitForResponse(item => new URL(item.url()).pathname === path && item.request().method() === 'PUT');
    await row.getByRole('button', { name: '保存映射', exact: true }).click();
    assert.equal((await response).status(), 200);
    await eventually(() => comparisonLinks.some(link => link.connection_id === resourceConnection.id && link.item_id === 'entry-a'), 'the exact source/view/item mapping is saved');
    await comparisonWorkspace().getByRole('status').filter({ hasText: /映射/ }).waitFor();
    await runComparison();
    await comparisonRow('entry-a').getByText('同为 kWh，可比较读数；采样时间不同。', { exact: false }).waitFor();
    assert.match(await comparisonRow('entry-a').innerText(), /5\s*kWh/);
    assert.match(await comparisonRow('entry-b').innerText(), /两端单位不同/);
    assert.match(await comparisonRow('entry-c').innerText(), /对照查询失败/);
    await screenshot('dark-custom-comparison-mapped-1280');
    await comparisonRow('entry-a').getByRole('combobox', { name: '对照连接', exact: true }).selectOption('');
    response = page.waitForResponse(item => new URL(item.url()).pathname === path && item.request().method() === 'DELETE');
    await comparisonRow('entry-a').getByRole('button', { name: '保存映射', exact: true }).click();
    assert.equal((await response).status(), 200);
    await comparisonWorkspace().getByRole('status').filter({ hasText: /映射/ }).waitFor();
    assert.equal(comparisonLinks.some(link => link.connection_id === resourceConnection.id && link.item_id === 'entry-a'), false);
    await runComparison(); await comparisonRow('entry-a').getByText('尚未关联对照连接', { exact: false }).waitFor();
    rejectComparison = true; await runComparison(resourceConnection, { expectFailure: true });
    await screenshot('dark-custom-comparison-run-failed-1280');
    rejectComparison = false; await runComparison();
  });

  await check('comparison dialogs and result rows fit desktop and narrow viewports in both themes without changing the connection URL', async () => {
    for (const colorScheme of ['light', 'dark']) {
      await emulateTheme(colorScheme);
      for (const width of [1280, 1920, 390, 320]) {
        await page.setViewportSize({ width, height: width >= 1280 ? 1000 : 844 });
        await page.locator('dialog[open] .page-dialog-content').evaluate(element => element.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
        await noOverflow(`${colorScheme} ${width}px custom comparison`);
        assert.equal(new URL(page.url()).pathname, `/connections/${resourceConnection.id}`);
        if (width !== 320) await screenshot(`${colorScheme}-custom-comparison-${width}`);
      }
    }
    await closeComparison();
    await page.setViewportSize({ width: 1280, height: 1000 });
  });

  await check('comparison results, mapping caches and late responses stay with their connection', async () => {
    await openComparison(resourceConnection); await fillResourceParameters();
    await comparisonRow('entry-a').getByRole('combobox', { name: '对照连接', exact: true }).selectOption(meterConnection.id);
    await comparisonRow('entry-a').getByRole('button', { name: '保存映射', exact: true }).click();
    await comparisonWorkspace().getByRole('status').filter({ hasText: /映射/ }).waitFor();
    await runComparison();
    await comparisonRow('entry-a').getByText('同为 kWh，可比较读数；采样时间不同。', { exact: false }).waitFor();
    assert.equal(comparisonLinks.filter(link => link.connection_id === resourceConnection.id && link.item_id === 'entry-a').length, 1, 'the first connection must have a real saved fixture mapping before testing isolation');
    function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
    const pending = { connectionId: resourceConnection.id, arrived: deferred(), release: deferred() };
    heldComparison = pending;
    await comparisonWorkspace().getByRole('button', { name: '读取并比较', exact: true }).click();
    let pendingTimer;
    try { await Promise.race([pending.arrived.promise, new Promise((_, reject) => { pendingTimer = setTimeout(() => reject(new Error('Timed out: held comparison request arrives')), 7000); })]); }
    finally { clearTimeout(pendingTimer); }
    await closeComparison();
    await visitConnection(otherResourceConnection);
    await openComparison(otherResourceConnection);
    assert.equal(await comparisonWorkspace().locator('[data-comparison-item-id]').count(), 0, 'another connection must not inherit previous result rows');
    pending.release.resolve();
    await eventually(() => heldComparison === undefined, 'the late response is released');
    assert.equal(await comparisonWorkspace().getByText('北区冷却系统', { exact: false }).count(), 0);
    assert.equal(await comparisonWorkspace().getByLabel('库区标记', { exact: true }).inputValue(), '北库', 'another connection starts with declared parameter defaults');
    await fillResourceParameters(); await runComparison(otherResourceConnection);
    await comparisonRow('entry-a').getByText('南区冷却系统', { exact: false }).waitFor();
    assert.equal(await comparisonWorkspace().getByText('北区冷却系统', { exact: false }).count(), 0);
    assert.equal(await comparisonRow('entry-a').getByRole('combobox', { name: '对照连接', exact: true }).inputValue(), '');
    await closeComparison();
  });

  await check('connection URLs preserve history and copied links without querying automatically', async () => {
    const before = mutationCount();
    for (const selected of [newApiUser, newApiAdmin, connection]) {
      await page.goto(`${origin}/tasks`); await main().getByRole('heading', { name: '任务', exact: true }).waitFor();
      await page.goto(`${origin}/connections/${selected.id}`);
      await page.waitForURL(`**/connections/${selected.id}`);
      await main().getByRole('heading', { name: selected.label, exact: true }).waitFor();
      assert.equal(await page.locator('dialog[open]').count(), 0);
      await page.reload(); await main().getByRole('heading', { name: selected.label, exact: true }).waitFor();
      await page.goBack(); await main().getByRole('heading', { name: '任务', exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/tasks');
      await page.goForward(); await main().getByRole('heading', { name: selected.label, exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, `/connections/${selected.id}`);
    }
    const copied = await context.newPage();
    try {
      await copied.goto(`${origin}/connections/${newApiAdmin.id}`);
      await copied.waitForURL(`**/connections/${newApiAdmin.id}`);
      await copied.locator('main').getByRole('heading', { name: newApiAdmin.label, exact: true }).waitFor();
      assert.equal(await copied.locator('dialog[open]').count(), 0);
    } finally { await copied.close(); }
    await page.goto(`${origin}/connections/ui-missing-connection`);
    await page.waitForURL('**/connections/ui-missing-connection');
    await main().getByText('连接不存在', { exact: true }).waitFor();
    await main().getByRole('button', { name: '返回', exact: true }).click();
    await main().getByRole('heading', { name: '连接', exact: true }).waitFor();
    await page.goto(`${origin}/tasks`); await main().getByRole('heading', { name: '任务', exact: true }).waitFor();
    await page.goto(`${origin}/connections`);
    await page.waitForURL('**/connections'); await main().getByRole('heading', { name: '连接', exact: true }).waitFor();
    await page.goBack(); await main().getByRole('heading', { name: '任务', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/tasks', 'Back must restore the previous canonical page');
    assert.equal(mutationCount(), before, 'navigation must not execute a comparison or capability');
    assert.equal(report.requests.filter(item => item.path.endsWith('/verify') || item.path.startsWith('/admin/newapi/')).length, 0);
    await navigate('概览', '概览'); await readyOverview();
  });

  await check('an initial 404 has Chinese recovery guidance, no permanent loading values, and no empty data modules', async () => {
    mode = 'error404';
    await page.goto(origin);
    await main().getByText('概览加载失败', { exact: true }).waitFor();
    const alert = main().getByRole('alert');
    assert(await alert.isVisible());
    assert(await main().getByRole('button', { name: '重试', exact: true }).isVisible());
    const visibleText = await main().innerText();
    assert(!visibleText.includes('Not Found'), 'raw route errors must stay inside collapsed technical details');
    assert(!visibleText.includes('…'), 'a failed request must not retain loading ellipses');
    assert.equal(await main().getByRole('heading', { name: '最近任务', exact: true }).count(), 0);
    assert.equal(await main().getByRole('heading', { name: '最近监控', exact: true }).count(), 0);
    await screenshot('dark-overview-404');
    mode = 'populated';
    await main().getByRole('button', { name: '重试', exact: true }).click();
    await readyOverview();
  });

  await check('empty overview provides an add-connection action and explicit task/monitor states', async () => {
    mode = 'empty';
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin);
    await main().getByText('还没有连接', { exact: true }).waitFor();
    await main().getByText('暂无任务', { exact: true }).waitFor();
    await main().getByText('暂无监控记录', { exact: true }).waitFor();
    assert(await main().getByRole('link', { name: '添加连接', exact: true }).isVisible());
    assert(!((await main().innerText()).includes('…')), 'a resolved empty state must not show loading values');
    await noOverflow('dark 390px empty overview');
    await screenshot('dark-overview-empty');
  });

  await check('refresh failures retain data and last-success timestamp, then recover without a reload', async () => {
    mode = 'populated';
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.goto(origin); await readyOverview();
    const updated = main().locator('time[datetime]').first();
    const previous = await updated.getAttribute('datetime');
    assert(previous && Number.isFinite(Date.parse(previous)));
    mode = 'error503';
    const refresh = main().getByRole('button', { name: '刷新', exact: true });
    if (await refresh.isVisible()) await refresh.click();
    await main().getByRole('alert').filter({ hasText: '刷新失败，显示上次数据。' }).waitFor({ timeout: 15_000 });
    assert.equal(await updated.getAttribute('datetime'), previous, 'failed refresh must keep the previous successful update time');
    assert(await main().getByText(connection.label, { exact: true }).isVisible());
    assert(await main().getByText('知乎 · 待授权', { exact: true }).isVisible());
    assert.equal(await main().getByText('概览加载失败', { exact: true }).count(), 0, 'a refresh failure must retain the overview');
    await screenshot('dark-overview-stale');
    mode = 'populated'; revision = 2;
    const retry = main().getByRole('button', { name: '重试', exact: true });
    if (await retry.isVisible()) await retry.click();
    else if (await refresh.isVisible()) await refresh.click();
    await main().getByText('知乎 · 已恢复', { exact: true }).waitFor({ timeout: 15_000 });
    await eventually(async () => await updated.getAttribute('datetime') !== previous, 'a recovered refresh must update its timestamp');
    await main().getByRole('alert').filter({ hasText: '刷新失败，显示上次数据。' }).waitFor({ state: 'hidden' });
    await screenshot('dark-overview-recovered');
  });
  assert.deepEqual(report.unexpected, [], 'all requests must use known local fixtures');
  assert.deepEqual(report.browserErrors, [], 'the UI must have no uncaught browser errors');
  assert.deepEqual(report.consoleErrors, [], 'the UI must have no unexpected console errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { stage, message: error instanceof Error ? error.message : String(error) };
  if (page && !page.isClosed()) report.failure.focus = await page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 300), documentFocused: document.hasFocus(), drawerOpen: document.querySelector('.sidebar-dialog')?.open })).catch(() => undefined);
  if (page && !page.isClosed()) await screenshot('failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  releaseOverview?.();
  heldComparison?.release.resolve();
  await browser?.close();
  await vite?.close();
  await rm(viteCache, { recursive: true, force: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
if (report.status === 'passed') console.log(`UI state smoke passed (${report.checks.length} checks). Screenshots/report: ${output}`);
else console.error(`UI state smoke failed during ${stage}. Screenshots/report: ${output}`);
