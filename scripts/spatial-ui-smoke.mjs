#!/usr/bin/env node
// Actual Web source, disposable Vite, sandboxed Chromium and synthetic APIs only.
// Opens/cancels product dialogs; never reads a deployed service or real credentials.
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
  else if (process.argv[i] === '--help') { console.log('Usage: node scripts/spatial-ui-smoke.mjs [--out SCREENSHOT_DIRECTORY]'); process.exit(0); }
  else throw new Error(`Unknown argument: ${process.argv[i]}`);
}
await mkdir(join(root, 'out/ui'), { recursive: true });
output ??= await mkdtemp(join(root, 'out/ui/spatial-'));
await mkdir(output, { recursive: true });
const cache = await mkdtemp(join(tmpdir(), 'owngate-spatial-vite-'));
const report = { status: 'running', source: 'Actual Web source with disposable Vite, sandboxed Chromium and synthetic read-only administrator APIs; no user deployment, platform or credential access.', checks: [], screenshots: [], layouts: [], grids: [], dialogs: [], browserErrors: [], consoleErrors: [], unexpected: [], requestCount: 0 };
const at = '2026-11-03T08:00:00Z';
const capability = (id, title) => ({ id, title, description: '本地布局验收查询', kind: 'query', effect: 'read', transport: 'http', support: { status: 'supported' }, input: { type: 'object', properties: {} }, output: { type: 'object', properties: { available: { type: 'boolean', title: '可用状态' } } }, cache: null });
const catalogs = {
  bilibili: [capability('account.profile', '账户资料'), capability('feed.list', '信息流'), capability('video.list', '视频列表'), capability('history.list', '历史记录')],
  newapi: [capability('account.balance', '账户余额'), capability('usage.today', '今日用量'), capability('model.list', '可用模型'), capability('channel.list', '渠道列表')],
  warehouse_fixture: [
    { ...capability('inventory.scan', '资源快照'), input: { type: 'object', properties: { region: { type: 'string', title: '采样区域', default: '北区' }, count: { type: 'integer', title: '采样数量', default: 20, minimum: 1, maximum: 100 } } } },
    capability('inventory.detail', '资源明细'),
  ],
};
const comparisonView = { id: 'resource-comparison', type: 'comparison', title: '资源读数比较', description: '来自自定义连接器声明的布局示例。',
  source: { capability: 'inventory.scan', items: '$.entries', id: 'record_key', label: 'caption', value: 'reading', updated_at: 'observed_at', updated_at_format: 'iso8601', unit: { config: 'reading_unit', allowed: ['kWh'] } },
  detail: { capability: 'inventory.detail', input: 'entry_key', id: 'record_key' }, target: { capability: 'account.profile', value: 'available' } };
const connection = (id, connector_id, label, config = {}) => ({ id, connector_id, label, config, capability_states: Object.fromEntries(catalogs[connector_id].map(cap => [cap.id, cap.support])), health: { status: 'healthy' }, scope: 'personal', tags: [], paused: false, created_at: at, updated_at: at });
const connections = [connection('spatial-bili-1', 'bilibili', '视频站点一'), connection('spatial-bili-2', 'bilibili', '视频站点二'), connection('spatial-bili-3', 'bilibili', '视频站点三'), connection('spatial-newapi', 'newapi', '配额站点'), connection('spatial-resource', 'warehouse_fixture', '资源工作台', { reading_unit: 'kWh' })];
const clients = [{ id: 'spatial-client', label: '查询客户端', revoked: false, created_at: at, expires_at: null }];
const grants = connections.map(conn => ({ client_id: 'spatial-client', connection_id: conn.id, capabilities: ['*'], visibility: { pii: false, financial: true, content: true } }));
const channels = [1, 2].map(number => ({ id: `spatial-channel-${number}`, label: `邮件渠道${number}`, type: 'smtp', host: 'smtp.example.test', port: 465, secure: true, user: 'layout-fixture', from: 'sender@example.test', to: ['recipient@example.test'], has_password: true, created_at: at }));
const monitors = [1, 2, 3].map(number => ({ id: `spatial-monitor-${number}`, label: `监控规则${number}`, connection_id: 'spatial-bili-1', capability_id: 'account.profile', cron: '*/15 * * * *', timezone: 'UTC', condition: 'available == true', mode: 'data', channel_id: 'spatial-channel-1', cooldown_seconds: 3600, input: {}, email_fields: [], enabled: true, created_at: at, next_run_at: at, runtime: { last_run_at: at, last_result: 'normal', last_status: 'success', last_error: null, active: false, false_streak: 2, last_notification_at: null, delivery: 'none' } }));
const extensions = [1, 2, 3].map(number => ({ id: `spatial_extension_${number}`, title: `示例接口${number}`, version: '1.0.0', transport: 'http', fingerprint: `synthetic-fingerprint-${number}`, enabled_capabilities: ['health.read'], operations: [{ id: 'health.read', title: '健康状态', method: 'GET', path: '/health', eligible: true, reason: '只读查询' }], status: 'installed' }));
const extensionPreview = { id: 'spatial_preview', title: '布局接口预览', version: '1.0.0', transport: 'http', fingerprint: 'synthetic-preview-fingerprint', config: {}, auth: null, operations: [1, 2, 3].map(number => ({ id: `status.read_${number}`, title: `状态查询${number}`, method: 'GET', path: `/status/${number}`, eligible: true, reason: '本地只读查询', status: 'disabled' })) };
const tools = [1, 2, 3].map(number => ({ id: `spatial-tool-${number}`, client_id: 'spatial-client', name: `layout_query_${number}`, connection_id: `spatial-bili-${number}`, capability_id: 'account.profile', created_at: at, available: true }));
const tasks = [1, 2, 3].map(number => ({ id: `spatial-task-${number}`, task_id: `spatial-task-${number}`, connection_id: 'spatial-bili-1', capability_id: 'account.profile', status: 'pending', created_at: at, attempts: 0, input: {}, result: null, cancellation: null }));
const requests = [];
const writes = () => requests.filter(request => request.method !== 'GET' && request.path !== '/admin/extensions/preview');
let vite, browser, page, origin, stage = 'startup';
async function check(name, action) { stage = name; await action(); report.checks.push(name); }
async function layout(name) {
  const value = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, height: innerHeight, documentHeight: document.documentElement.scrollHeight }));
  report.layouts.push({ name, ...value }); assert(value.document <= value.width + 1, `${name}: horizontal overflow`);
}
async function screenshot(name) { await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' })); await page.screenshot({ path: join(output, `${name}.png`), fullPage: false, animations: 'disabled' }); report.screenshots.push(`${name}.png`); }
async function visit(path, title) { await page.goto(`${origin}${path}`); await page.getByRole('heading', { name: title, exact: true }).waitFor(); }
async function formSnapshot(dialog) { return dialog.locator('input, textarea, select').evaluateAll(elements => elements.map(element => ({ value: element.value, checked: element instanceof HTMLInputElement ? element.checked : undefined }))); }
async function beside(name, elements, minimum = 250, align = 'top') {
  await elements.nth(1).waitFor();
  const bounds = await elements.evaluateAll(nodes => nodes.slice(0, 2).map(node => { const value = node.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height }; }));
  const container = await elements.first().evaluate(node => { const value = node.parentElement.getBoundingClientRect(); return { width: value.width, columns: getComputedStyle(node.parentElement).gridTemplateColumns }; });
  report.grids.push({ name, ...container, bounds });
  const aligned = align === 'bottom' ? Math.abs(bounds[0].y + bounds[0].height - bounds[1].y - bounds[1].height) < 3 : Math.abs(bounds[0].y - bounds[1].y) < 3;
  assert(bounds[1].x > bounds[0].x + 20 && aligned, `${name}: desktop items must share a row`);
  assert(bounds.every(value => value.width >= minimum), `${name}: columns must keep usable reading width`);
}
const scenarios = [
  { name: 'connections', path: '/connections', title: '连接', items: () => page.locator('main .card-list > .card') },
  { name: 'capabilities', path: '/connections/spatial-bili-1', title: '视频站点一', items: () => page.locator('[data-capability-id]') },
  { name: 'extensions', path: '/extensions', title: '扩展导入', items: () => page.locator('main .secondary-extension-grid > .card') },
  { name: 'mcp-tools', path: '/mcp-tools', title: 'MCP 常用工具', items: () => page.locator('main .card-list > .card') },
  { name: 'monitors', path: '/monitors', title: '监控与通知', items: () => page.locator('main .secondary-monitor-layout > :is(section, aside)') },
  { name: 'security', path: '/settings/security', title: '安全设置', items: () => page.locator('main .secondary-security-grid > section') },
];
const dialogScenarios = [
  { name: 'add-connection', path: '/connections', pageTitle: '连接', trigger: '添加连接', title: '添加连接', ready: () => page.locator('main .connections-grid > .card').first(), prepare: async dialog => { await dialog.getByRole('button', { name: '继续填写配置', exact: true }).click(); await dialog.getByLabel('名称', { exact: true }).fill('不会保存的合成连接'); } },
  { name: 'smtp', path: '/monitors', pageTitle: '监控与通知', trigger: '添加邮件渠道', title: '添加 SMTP 渠道', ready: () => page.locator('.secondary-monitor-layout'), prepare: async dialog => { await dialog.getByLabel('渠道名称', { exact: true }).fill('不会保存的合成邮件渠道'); await dialog.getByLabel('SMTP 密码', { exact: true }).fill('synthetic-password-only'); } },
  { name: 'monitor', path: '/monitors', pageTitle: '监控与通知', trigger: '添加监控规则', title: '添加监控规则', ready: () => page.locator('.secondary-monitor-layout'), prepare: async dialog => { await dialog.getByRole('combobox', { name: /^查询能力/ }).selectOption('account.profile'); await dialog.getByLabel('规则名称', { exact: true }).fill('不会保存的合成规则'); } },
  { name: 'extension-import', path: '/extensions', pageTitle: '扩展导入', trigger: '导入扩展', title: '导入扩展', ready: () => page.locator('.secondary-extension-grid > .card').first(), prepare: async dialog => { await dialog.getByLabel('接口定义', { exact: true }).fill('connector: spatial_draft\nversion: 1.0.0\n'); } },
  { name: 'mcp-add', path: '/mcp-tools', pageTitle: 'MCP 常用工具', trigger: '添加工具', title: '添加常用工具', ready: () => page.locator('.secondary-tool-grid > .card').first(), prepare: async dialog => { await dialog.getByRole('combobox', { name: /^客户端/ }).selectOption('spatial-client'); await dialog.getByRole('combobox', { name: /^查询连接/ }).selectOption('spatial-bili-1'); await dialog.getByRole('combobox', { name: /^查询能力/ }).selectOption('account.profile'); await dialog.getByLabel('工具名称', { exact: true }).fill('unsaved_layout_query'); } },
  { name: 'comparison', path: '/connections/spatial-resource', pageTitle: '资源工作台', trigger: comparisonView.title, title: comparisonView.title, ready: () => page.locator('[data-capability-id="inventory.scan"]'), prepare: async dialog => {
    await dialog.locator(`[data-comparison-view-id="${comparisonView.id}"]`).waitFor();
    await dialog.getByLabel('采样区域', { exact: true }).fill('仅本地草稿');
    await dialog.getByLabel('采样数量', { exact: true }).fill('5');
    if (await page.evaluate(() => innerWidth >= 1280)) await beside('comparison-source-fields', dialog.locator('.comparison-fields > *'), 200);
  } },
];

try {
  const webRequire = createRequire(join(root, 'apps/web/package.json'));
  const browserRequire = createRequire(join(root, 'apps/browser/package.json'));
  const { createServer } = await import(pathToFileURL(join(dirname(webRequire.resolve('vite/package.json')), 'dist/node/index.js')).href);
  const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href);
  const { chromium } = browserRequire('playwright');
  vite = await createServer({ root: join(root, 'apps/web'), configFile: false, plugins: [react()], cacheDir: cache, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await vite.listen(); const address = vite.httpServer.address(); assert(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', locale: 'zh-CN' });
  page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== origin) { report.unexpected.push(`${method} ${url.origin}${path}`); return route.abort(); }
    if (!/^\/(?:admin|auth|api|ws)(?:\/|$)/.test(path)) return route.continue();
    requests.push({ method, path });
    let response, status = 200;
    if (path === '/admin/extensions/preview' && method === 'POST') response = extensionPreview;
    else if (method !== 'GET') { report.unexpected.push(`Unexpected mutation: ${method} ${path}`); status = 500; response = { message: 'Spatial acceptance is read-only' }; }
    else if (path === '/auth/status') response = { hasUser: true, authenticated: true, stepUp: true, totpEnabled: true, passkeyCount: 1 };
    else if (path === '/auth/passkeys') response = { passkeys: [{ id: 'synthetic-layout-passkey', createdAt: at }] };
    else if (path === '/admin/connections') response = { connections };
    else if (path === '/admin/connectors') response = { connectors: Object.keys(catalogs).map(id => ({ id, title: id, transport: id === 'bilibili' ? 'browser' : 'http', has_login: id === 'bilibili', has_auth: false, config: id === 'bilibili' ? { base_url: { type: 'string', format: 'uri', label: '站点地址' } } : {}, views: id === 'warehouse_fixture' ? [comparisonView] : [] })) };
    else if (path === '/admin/capabilities') response = { capabilities: catalogs[url.searchParams.get('connector_id')] ?? [] };
    else if (path.endsWith('/credentials')) response = { fields: [] };
    else if (path === '/admin/clients') response = { clients };
    else if (path === '/admin/grants') response = { grants };
    else if (path === '/admin/notification-channels') response = { channels };
    else if (path === '/admin/monitors') response = { monitors };
    else if (path === '/admin/extensions') response = { extensions };
    else if (path === '/admin/mcp-tools') response = { tools };
    else if (path === '/admin/tasks') response = { tasks };
    else if (path === '/admin/proposals') response = { proposals: [] };
    else if (path === '/admin/audit') response = { entries: [] };
    else if (path === '/admin/overview') response = { connections, tasks, alerts: [], pending_proposals: 0, actions_enabled: false };
    else if (path === `/admin/connections/spatial-resource/views/${comparisonView.id}/links`) response = { links: [] };
    else { report.unexpected.push(`${method} ${path}`); status = 500; response = { message: 'Unexpected local fixture request' }; }
    await route.fulfill({ status, json: response });
  });

  await check('desktop collections use adjacent columns at 1280px and 1920px with useful card widths', async () => {
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const scenario of scenarios) {
        await visit(scenario.path, scenario.title);
        await beside(`${scenario.name}-${width}`, scenario.items(), scenario.minimum, scenario.align);
        await layout(`${scenario.name}-${width}`); await screenshot(`desktop-${scenario.name}-${width}`);
      }
    }
  });

  await check('all collections remain readable at 390px and 320px in light and dark themes', async () => {
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        for (const scenario of scenarios) {
          await visit(scenario.path, scenario.title); await scenario.items().first().waitFor();
          await layout(`${scenario.name}-${colorScheme}-${width}`);
          if (width === 390 && colorScheme === 'dark') await screenshot(`mobile-${scenario.name}-dark-390`);
        }
      }
    }
  });

  await check('add-connection drafts survive backdrop clicks, Escape and dragging outside until Cancel or the close button is used', async () => {
    for (const { width, colorScheme } of [{ width: 1280, colorScheme: 'light' }, { width: 390, colorScheme: 'dark' }, { width: 320, colorScheme: 'light' }]) {
      await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme });
      await visit('/connections', '连接'); await page.locator('main .connections-grid > .card').first().waitFor();
      const trigger = page.getByRole('button', { name: '添加连接', exact: true });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: '添加连接', exact: true });
      await dialog.getByRole('button', { name: '继续填写配置', exact: true }).click();
      const name = dialog.getByLabel('名称', { exact: true });
      await name.fill('误触后仍然保留的连接');
      await dialog.getByLabel('站点地址', { exact: true }).fill('https://draft.example.invalid');
      const draft = await formSnapshot(dialog);
      async function retained(reason) {
        assert(await dialog.isVisible(), `${width}: ${reason} must keep the add-connection dialog open`);
        assert.deepEqual(await formSnapshot(dialog), draft, `${width}: ${reason} must preserve the filled draft`);
      }
      await page.mouse.click(2, 2); await retained('backdrop click');
      await name.focus(); await page.keyboard.press('Escape'); await retained('Escape');
      const field = await name.boundingBox(); assert(field);
      await page.mouse.move(field.x + field.width / 2, field.y + field.height / 2);
      await page.mouse.down(); await page.mouse.move(2, 2, { steps: 8 }); await page.mouse.up();
      await retained('dragging from the field to the backdrop');
      await layout(`protected-add-connection-${colorScheme}-${width}`);
      await screenshot(`protected-add-connection-${colorScheme}-${width}`);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert(await trigger.evaluate(element => element === document.activeElement), 'Cancel restores focus to Add connection');
      await trigger.click();
      await dialog.getByRole('button', { name: '继续填写配置', exact: true }).click();
      assert.equal(await name.inputValue(), '', 'an explicit cancellation clears the abandoned creation draft');
      await name.fill('仅使用关闭按钮取消');
      await dialog.getByRole('button', { name: '关闭添加连接', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert(await trigger.evaluate(element => element === document.activeElement), 'the close button restores focus to Add connection');
      assert.equal(writes().length, 0, 'accidental dismissal attempts and explicit cancellation must not create a connection');
    }
  });

  await check('creation, import and declarative comparison dialogs ignore accidental dismissal and close explicitly without saving or querying', async () => {
    for (const { width, colorScheme } of [{ width: 1280, colorScheme: 'light' }, { width: 1920, colorScheme: 'light' }, { width: 390, colorScheme: 'light' }, { width: 320, colorScheme: 'light' }, { width: 390, colorScheme: 'dark' }, { width: 320, colorScheme: 'dark' }]) {
      await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme });
      for (const scenario of dialogScenarios) {
        await visit(scenario.path, scenario.pageTitle); await scenario.ready().waitFor();
        const closedHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        const trigger = page.getByRole('button', { name: scenario.trigger, exact: true });
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: scenario.title, exact: true });
        await dialog.waitFor(); await scenario.prepare(dialog);
        const metrics = await dialog.evaluate(element => {
          const bounds = element.getBoundingClientRect(), content = element.querySelector('.page-dialog-content');
          return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: innerWidth, height: innerHeight, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight, scrollWidth: content.scrollWidth, clientWidth: content.clientWidth, nativeModal: element instanceof HTMLDialogElement && element.matches(':modal'), documentHeight: document.documentElement.scrollHeight };
        });
        assert(metrics.nativeModal);
        assert(metrics.left >= 0 && metrics.right <= metrics.width + 1 && metrics.top >= 0 && metrics.bottom <= metrics.height + 1, `${scenario.name}-${width}: dialog must stay inside the viewport`);
        assert(Math.abs(metrics.documentHeight - closedHeight) <= 3, `${scenario.name}-${width}: dialog must not append to the page height`);
        assert(metrics.scrollWidth <= metrics.clientWidth + 1, `${scenario.name}-${width}: dialog content must fit horizontally`);
        if (scenario.name === 'monitor' && width <= 390) assert(metrics.scrollHeight > metrics.clientHeight, 'long mobile editors need their own scrolling area');
        report.dialogs.push({ name: scenario.name, colorScheme, width, closedHeight, ...metrics });
        await layout(`dialog-${scenario.name}-${colorScheme}-${width}`);
        if ((width === 1280 && colorScheme === 'light') || (width === 390 && colorScheme === 'dark')) await screenshot(`${width === 1280 ? 'desktop' : 'mobile'}-dialog-${scenario.name}-${colorScheme}-${width}`);
        const draft = await formSnapshot(dialog);
        await page.keyboard.press('Escape');
        assert(await dialog.isVisible(), `${scenario.name}: Escape must leave the dialog open`);
        await page.mouse.click(2, 2);
        assert(await dialog.isVisible(), `${scenario.name}: backdrop clicks must leave the dialog open`);
        assert.deepEqual(await formSnapshot(dialog), draft, `${scenario.name}: accidental dismissal must preserve field values`);
        await dialog.getByRole('button', { name: `关闭${scenario.title}`, exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert(await trigger.evaluate(element => element === document.activeElement), `${scenario.name}: the close button restores the opener focus`);
        assert.equal(writes().length, 0, 'cancelling a dialog must not save, authorize or query');
      }
    }
  });

  await check('extension source and preview share desktop width and stack inside mobile dialogs without installing', async () => {
    for (const { width, colorScheme } of [{ width: 1280, colorScheme: 'light' }, { width: 1920, colorScheme: 'light' }, { width: 390, colorScheme: 'light' }, { width: 320, colorScheme: 'light' }, { width: 390, colorScheme: 'dark' }, { width: 320, colorScheme: 'dark' }]) {
      await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme });
      await visit('/extensions', '扩展导入'); await page.locator('.secondary-extension-grid > .card').first().waitFor();
      const closedHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.getByRole('button', { name: '导入扩展', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '导入扩展', exact: true });
      await dialog.getByLabel('接口定义', { exact: true }).fill('connector: spatial_preview\nversion: 1.0.0\n');
      await dialog.getByRole('button', { name: '预览操作', exact: true }).click();
      await dialog.getByRole('heading', { name: '布局接口预览 · 1.0.0', exact: true }).waitFor();
      const panels = dialog.locator('.extension-workbench.with-preview > *');
      if (width >= 1280) await beside(`extension-preview-${width}`, panels);
      else {
        const values = await panels.evaluateAll(elements => elements.map(element => { const bounds = element.getBoundingClientRect(); return { x: bounds.x, y: bounds.y, bottom: bounds.bottom }; }));
        assert(Math.abs(values[0].x - values[1].x) <= 1 && values[1].y >= values[0].bottom, 'mobile source and preview must stack inside the scroll area');
      }
      assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 0, 'a preview must not enable or install queries');
      assert(Math.abs(await page.evaluate(() => document.documentElement.scrollHeight) - closedHeight) <= 3);
      await layout(`extension-preview-${colorScheme}-${width}`);
      if (width === 1920 || (width === 390 && colorScheme === 'dark')) await screenshot(`extension-preview-${colorScheme}-${width}`);
      await page.keyboard.press('Escape');
      assert(await dialog.isVisible(), 'Escape must not discard an extension preview');
      assert.equal(await dialog.getByLabel('接口定义', { exact: true }).inputValue(), 'connector: spatial_preview\nversion: 1.0.0\n');
      assert.equal(await dialog.locator('.extension-preview').count(), 1);
      await dialog.getByRole('button', { name: '关闭导入扩展', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '导入扩展', exact: true }).click();
      assert.equal(await dialog.getByLabel('接口定义', { exact: true }).inputValue(), '', 'closing import clears its unsaved source');
      assert.equal(await dialog.locator('.extension-preview').count(), 0);
      await dialog.getByRole('button', { name: '关闭导入扩展', exact: true }).click();
      assert.equal(writes().length, 0);
    }
  });

  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.unexpected, []);
  assert.equal(writes().length, 0);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { stage, message: error instanceof Error ? error.message : String(error) }; process.exitCode = 1;
  if (page) { await screenshot('failure').catch(() => undefined); await writeFile(join(output, 'failure.html'), await page.content()).catch(() => undefined); }
} finally {
  await browser?.close(); await vite?.close(); await rm(cache, { recursive: true, force: true }); report.requestCount = requests.length;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, screenshots: report.screenshots.length, requestCount: report.requestCount, output, ...(report.failure ? { failure: report.failure } : {}) }));
}
