#!/usr/bin/env node
// Real Chromium checks against the Web source and local, synthetic API fixtures.
// No platform account, production server, remote API or real credential is used.
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
    console.log('Usage: node scripts/product-ui-smoke.mjs [--out SCREENSHOT_DIRECTORY]');
    console.log('Default output: out/ui/product-<run>/ (screenshots and report.json)');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${process.argv[i]}`);
}
if (output === undefined) {
  const outputRoot = join(root, 'out/ui');
  await mkdir(outputRoot, { recursive: true });
  output = await mkdtemp(join(outputRoot, 'product-'));
}
await mkdir(output, { recursive: true });
const viteCache = await mkdtemp(join(tmpdir(), 'owngate-product-ui-vite-'));

const webRequire = createRequire(join(root, 'apps/web/package.json'));
const browserRequire = createRequire(join(root, 'apps/browser/package.json'));
const { createServer } = await import(pathToFileURL(join(dirname(webRequire.resolve('vite/package.json')), 'dist/node/index.js')).href);
const { chromium } = browserRequire('playwright');

const now = '2026-10-01T12:00:00.000Z';
const states = { 'account.profile': { status: 'supported' }, 'feed.list': { status: 'supported' }, 'post.create': { status: 'disabled' } };
const connection = (id, label, scope = 'personal') => ({ id, label, scope, connector_id: 'bilibili', config: { egress_strict: false }, capability_states: structuredClone(states), health: { status: 'healthy' }, tags: [], paused: false, created_at: now, updated_at: now });
const connections = [connection('con_personal', '个人哔哩哔哩'), connection('con_organization', '组织账户示例', 'organization')];
const source = { connection_id: 'con_personal', connection_label: '个人哔哩哔哩', capability_id: 'feed.list' };
const item = { platform: 'bilibili', id: 'fixture-post', kind: 'post', url: 'https://t.bilibili.com/123', author: { id: 'fixture-author', name: '示例作者' }, title: '本地信息流示例', text: '<script>window.syntheticXss = true</script> 这段内容应作为文本显示。\n' + '这是长正文示例，初始应收起，展开后完整阅读；内容来自本地夹具。\n'.repeat(15), media: [], published_at: now, metrics: { likes: 3 } };
const success = { outcome: 'partial', data: { items: [item] }, error: null, fields: { 'items.0.metrics.comments': { status: 'unknown' } }, source, data_time: now, queried_at: now, cache: { hit: false }, warnings: ['部分指标未知；保留实际值。'] };
const task = (id, status, result = null) => ({ id, task_id: id, connection_id: 'con_personal', capability_id: 'feed.list', status, created_at: now, started_at: now, attempts: 1, input: { limit: 3 }, result, cancellation: null });
const tasks = [task('task_running', 'running'), task('task_complete', 'partial', success)];
const proposals = ['approve', 'reject'].map((id) => ({ id: `proposal_${id}`, connection_id: 'con_personal', capability_id: 'post.create', normalized_hash: `fixture-${id}-hash`, status: 'pending', input: { text: `待审阅的具体内容 ${id}` }, result: null, target: { label: '个人哔哩哔哩', connector_id: 'bilibili' }, effect: 'external_send', expires_at: '2099-01-01T00:00:00Z' }));
const audit = [{ seq: 2, action: 'query', target: 'con_personal/feed.list', client_id: 'client_fixture', at: now, detail: { outcome: 'partial' }, entry_hash: 'fixture-audit-hash-2' }];
const clients = [];
const grants = [];
const mcpTools = [];
const capabilities = [
  { id: 'account.profile', kind: 'query', effect: 'read', title: '账户资料', description: '获取当前账户资料', transport: 'browser', cache: null, support: { status: 'unverified' }, input: {}, output: { type: 'object', properties: { nickname: { type: 'string', title: '昵称', 'x-sensitivity': 'pii' }, uid: { type: 'integer', title: '账户 ID', 'x-sensitivity': 'pii' } } } },
  { id: 'feed.list', kind: 'query', effect: 'read', title: '信息流', description: '获取授权信息流', transport: 'browser', cache: null, support: { status: 'unverified' }, input: { limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 }, source: { type: 'string', enum: ['following', 'recommended'], default: 'following' } }, output: { type: 'object', properties: { items: { type: 'array', title: '动态内容', 'x-sensitivity': 'content', items: { type: 'object', properties: { text: { type: 'string', title: '正文' } } } } } } },
  { id: 'post.create', kind: 'action', effect: 'external_send', title: '发布内容', description: '仅允许人工审阅具体内容', transport: 'browser', cache: null, support: { status: 'disabled' }, input: { text: { type: 'string', required: true } }, output: {} },
];
const connectors = [{ id: 'bilibili', title: '哔哩哔哩', transport: 'browser', has_auth: false, has_login: true, config: { egress_strict: { type: 'boolean', default: false } } }];
const requests = [];
const unexpected = [];
const pageErrors = [];
const layoutFailures = [];
const screenshots = [];
let mode = 'populated';

function mock(method, url, body) {
  const path = url.pathname;
  if (path === '/auth/status') return { hasUser: true, authenticated: true, stepUp: true, totpEnabled: true, passkeyCount: 0 };
  if (mode === 'error' && path.startsWith('/admin/')) return { status: 503, body: { error: { code: 'FIXTURE_UNAVAILABLE', message: '本地示例服务暂时不可用' } } };
  if (path === '/admin/overview') return { connections: mode === 'empty' ? [] : connections, tasks: mode === 'empty' ? [] : tasks, pending_proposals: mode === 'empty' ? 0 : proposals.filter(p => p.status === 'pending').length, alerts: mode === 'empty' ? [] : [{ at: now, action: 'monitor.checked', target: 'local-fixture' }], actions_enabled: false };
  if (path === '/admin/actions/pause' && method === 'POST') return { paused: true };
  if (path === '/admin/connections') {
    if (method === 'GET') return { connections: mode === 'empty' ? [] : connections };
    if (method === 'POST') { const created = { ...connection(`con_created_${connections.length}`, body.label, body.scope), config: body.config }; connections.push(created); return created; }
  }
  if (path.endsWith('/state') && method === 'PATCH') {
    const saved = connections.find(c => c.id === path.split('/')[3]);
    assert(saved, 'connection state target must exist');
    if (body.scope === 'organization') assert.equal(body.confirm_organization, true);
    Object.assign(saved, body);
    return saved;
  }
  if (path.endsWith('/credentials') && method === 'GET') return { fields: [] };
  if (path === '/admin/connectors') return { connectors };
  if (path === '/admin/capabilities') return { capabilities };
  if (path === '/admin/tasks') {
    if (method === 'GET') return { tasks: mode === 'empty' ? [] : tasks };
    if (method === 'POST') { const created = { ...task('task_submitted', 'pending'), capability_id: body.capability_id, input: body.input }; tasks.push(created); return { task_id: created.id, status: created.status }; }
  }
  if (path.startsWith('/admin/tasks/')) {
    const saved = tasks.find(t => t.id === path.split('/')[3]);
    assert(saved, 'task target must exist');
    if (path.endsWith('/events')) return { events: [{ id: 1, at: now, event: 'task.created', detail: {} }, { id: 2, at: now, event: 'task.running', detail: {} }] };
    if (path.endsWith('/cancel') && method === 'POST') Object.assign(saved, { status: 'cancelled', cancellation: { state: 'cancelled_locally', may_continue_remote: true, remote_confirmed: false } });
    return saved;
  }
  if (path === '/admin/proposals') return { proposals: mode === 'empty' ? [] : proposals };
  if (path.startsWith('/admin/proposals/') && method === 'POST') {
    const saved = proposals.find(p => p.id === path.split('/')[3]);
    assert(saved, 'proposal target must exist');
    if (path.endsWith('/approve')) { assert.equal(body.hash, saved.normalized_hash); saved.status = 'approved'; }
    else if (path.endsWith('/reject')) saved.status = 'rejected';
    else throw new Error(`unexpected proposal mutation ${path}`);
    return saved;
  }
  if (path === '/admin/audit') return { entries: mode === 'empty' || url.searchParams.has('before') ? [] : audit };
  if (path === '/admin/clients') {
    if (method === 'GET') return { clients: mode === 'empty' ? [] : clients };
    if (method === 'POST') { const created = { ...body, id: `client_created_${clients.length}`, revoked: false, created_at: now }; clients.push(created); return { ...created, token: 'og_fixture_once_only_token_do_not_use' }; }
  }
  if (path.endsWith('/revoke') && method === 'POST') { const saved = clients.find(c => c.id === path.split('/')[3]); assert(saved); saved.revoked = true; return { ok: true }; }
  if (path === '/admin/grants') {
    if (method === 'GET') return { grants };
    if (method === 'POST') { const index = grants.findIndex(g => g.client_id === body.client_id && g.connection_id === body.connection_id); if (index >= 0) grants[index] = body; else grants.push(body); return body; }
  }
  if (path === '/admin/mcp-tools') {
    if (method === 'GET') return { tools: mode === 'empty' ? [] : mcpTools };
    if (method === 'POST') { const created = { ...body, id: `mcp_fixture_${mcpTools.length}`, created_at: now, available: true }; mcpTools.push(created); return created; }
  }
  if (path.startsWith('/admin/mcp-tools/') && method === 'DELETE') {
    const index = mcpTools.findIndex(tool => tool.id === path.split('/')[3]);
    assert(index >= 0, 'MCP tool must exist before removal');
    mcpTools.splice(index, 1);
    return { ok: true };
  }
  throw new Error(`Unmocked API: ${method} ${path}`);
}

async function eventually(check, description) {
  const deadline = Date.now() + 5000;
  do { if (await check()) return; await delay(25); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}
const lastRequest = (path, method) => requests.findLast(r => r.path === path && (!method || r.method === method));
const seen = async (path, method) => eventually(() => lastRequest(path, method), `${method} ${path}`);

const server = await createServer({ root: join(root, 'apps/web'), configFile: join(root, 'apps/web/vite.config.ts'), cacheDir: viteCache, server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
let browser;
let page;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'UTC' });
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.setDefaultTimeout(7000);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(`External request refused: ${url.origin}${url.pathname}`); return route.abort(); }
    if (!url.pathname.startsWith('/admin/') && !url.pathname.startsWith('/auth/')) return route.continue();
    try {
      const body = request.postData() ? request.postDataJSON() : undefined;
      requests.push({ method: request.method(), path: url.pathname, query: url.search, body });
      const response = mock(request.method(), url, body);
      return route.fulfill({ status: response?.status === 503 ? 503 : 200, json: response?.status === 503 ? response.body : structuredClone(response) });
    } catch (error) {
      unexpected.push(error instanceof Error ? error.message : String(error));
      return route.fulfill({ status: 500, json: { error: { code: 'FIXTURE_ERROR', message: 'Unexpected local fixture request' } } });
    }
  });

  async function navigate(label, heading) {
    const menu = page.getByRole('button', { name: '打开导航', exact: true });
    if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
    await page.locator('.nav').getByRole('link', { name: label, exact: true }).click();
    if (await menu.isVisible()) await page.getByRole('dialog', { name: '导航菜单', exact: true }).waitFor({ state: 'hidden' });
    if (heading) await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  }
  async function screenshot(name) {
    const path = join(output, `${name}.png`);
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    screenshots.push(path);
  }
  async function checkWidth(name) {
    const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    if (widths.document > widths.viewport + 1) {
      layoutFailures.push(`${name}: document overflow ${widths.document}px > ${widths.viewport}px`);
      await screenshot(`${name.replace(/[^a-z0-9-]/gi, '-')}-overflow`);
    }
  }

  await page.goto(origin);
  await page.getByRole('heading', { name: '概览', exact: true }).waitFor();
  const navigation = page.locator('aside.sidebar:visible .nav');
  assert.deepEqual(await navigation.locator('.nav-group').filter({ hasText: '常用' }).getByRole('link').allTextContents(), ['概览', '任务']);
  assert.equal(await navigation.getByRole('link', { name: '信息流', exact: true }).count(), 0, 'platform-specific content does not get a universal navigation entry');
  await page.getByText('个人哔哩哔哩', { exact: true }).waitFor();
  await page.getByText('安全控制', { exact: true }).click();
  await page.getByRole('button', { name: '停止全部写操作' }).click();
  await page.getByRole('status').filter({ hasText: '写操作保持停止' }).waitFor();
  await seen('/admin/actions/pause', 'POST');
  await screenshot('desktop-overview');

  await navigate('任务', '任务');
  await page.getByRole('link', { name: '查看结果与过程' }).first().click();
  await page.getByRole('heading', { name: '任务详情', exact: true }).waitFor();
  await page.getByRole('button', { name: '取消本地任务' }).click();
  await page.getByText('已停止本地等待，远端可能仍在执行。', { exact: true }).waitFor();
  await seen('/admin/tasks/task_running/cancel', 'POST');
  await page.getByRole('link', { name: '返回任务', exact: true }).click();
  await page.getByRole('heading', { name: '任务', exact: true }).waitFor();
  await page.getByRole('link', { name: '查看结果与过程' }).nth(1).click();
  await page.getByRole('heading', { name: '任务详情', exact: true }).waitFor();
  await page.getByText('部分指标未知；保留实际值。', { exact: true }).waitFor();
  await page.getByText('执行过程', { exact: true }).click();
  await page.getByText(/task\.created/).waitFor();
  await screenshot('desktop-task-detail');

  await navigate('提案', '操作提案');
  await page.getByRole('button', { name: '预览具体内容' }).first().click();
  await page.getByText(/待审阅的具体内容 approve/).waitFor();
  await page.getByRole('button', { name: '验证身份并批准此内容' }).click();
  await seen('/admin/proposals/proposal_approve/approve', 'POST');
  await page.getByRole('heading', { name: '确认提案内容' }).waitFor({ state: 'hidden' });
  assert.deepEqual(lastRequest('/admin/proposals/proposal_approve/approve', 'POST').body, { hash: 'fixture-approve-hash' });
  await page.getByRole('button', { name: '预览具体内容' }).nth(1).click();
  await page.getByRole('button', { name: '拒绝提案' }).click();
  await seen('/admin/proposals/proposal_reject/reject', 'POST');
  await page.getByRole('heading', { name: '确认提案内容' }).waitFor({ state: 'hidden' });
  await screenshot('desktop-proposals');

  await navigate('审计记录', '审计记录');
  await page.getByLabel('客户端 ID').fill('client_fixture');
  await page.getByLabel('连接 ID').fill('con_personal');
  await eventually(() => lastRequest('/admin/audit')?.query.includes('client_id=client_fixture') && lastRequest('/admin/audit')?.query.includes('connection_id=con_personal'), 'audit filters');
  await page.getByText('查看详情', { exact: true }).click();
  await page.getByText('记录指纹：fixture-audit-hash-2', { exact: true }).waitFor();
  await page.getByRole('button', { name: '更早的记录' }).click();
  await eventually(() => lastRequest('/admin/audit')?.query.includes('before=2'), 'audit pagination');
  await page.getByRole('button', { name: '回到最新' }).click();
  await eventually(() => !lastRequest('/admin/audit')?.query.includes('before='), 'audit latest');
  await screenshot('desktop-audit');

  await navigate('连接', '连接');
  await page.getByRole('button', { name: '添加连接' }).click();
  await page.getByLabel('账户范围').selectOption('organization');
  assert(await page.getByRole('button', { name: '继续填写配置' }).isDisabled());
  await page.getByLabel(/我有权接入这个组织账户/).check();
  await page.getByRole('button', { name: '继续填写配置' }).click();
  await page.getByLabel('名称', { exact: true }).fill('UI smoke 组织连接');
  await page.getByRole('button', { name: '添加并继续授权' }).click();
  await page.getByRole('heading', { name: 'UI smoke 组织连接', exact: true }).waitFor();
  const created = lastRequest('/admin/connections', 'POST').body;
  assert.equal(created.scope, 'organization');
  assert.equal(created.confirm_organization, true);
  assert.equal(await page.getByLabel('cookie JSON', { exact: true }).isVisible(), false, 'cookie import is a secondary, collapsed path');
  await page.getByRole('button', { name: '导入已有登录态', exact: true }).click();
  await page.getByLabel('cookie JSON', { exact: true }).waitFor();
  await page.getByRole('dialog', { name: '导入已有登录态', exact: true }).getByRole('button', { name: '关闭导入已有登录态', exact: true }).click();
  await page.getByRole('button', { name: '编辑范围与标签', exact: true }).click();
  await page.getByLabel('账户范围').selectOption('personal');
  await page.getByLabel('标签（逗号分隔）').fill('社交, 工作');
  await page.getByRole('button', { name: '保存范围与标签' }).click();
  await page.getByRole('form', { name: '编辑范围与标签', exact: true }).waitFor({ state: 'hidden' });
  await page.getByLabel('连接信息', { exact: true }).getByText('个人账户', { exact: true }).waitFor();
  assert.deepEqual(lastRequest('/admin/connections/con_created_2/state', 'PATCH').body, { scope: 'personal', tags: ['社交', '工作'] });
  await page.locator('[data-capability-id="account.profile"] .capability-open').click();
  const taskDialog = page.getByRole('dialog', { name: '账户资料', exact: true });
  const taskWorkspace = taskDialog.locator('[data-capability-workspace="account.profile"]');
  await taskWorkspace.getByRole('button', { name: '作为任务查询', exact: true }).click();
  await seen('/admin/tasks', 'POST');
  assert.equal(lastRequest('/admin/tasks', 'POST').body.connection_id, 'con_created_2');
  assert.equal(lastRequest('/admin/tasks', 'POST').body.capability_id, 'account.profile');
  await taskWorkspace.getByRole('status').filter({ hasText: '任务已排队' }).waitFor();
  await screenshot('desktop-capability-task');
  await taskDialog.getByRole('button', { name: '关闭账户资料', exact: true }).click();
  await taskDialog.waitFor({ state: 'hidden' });
  await screenshot('desktop-connection');

  await navigate('客户端', '客户端与授权');
  await page.getByRole('button', { name: '添加客户端' }).click();
  await page.getByLabel('客户端名称').fill('UI smoke AI');
  assert.match(await page.getByLabel('客户端名称').getAttribute('placeholder'), /^例如：/);
  const creationDialog = page.getByRole('dialog', { name: '添加客户端', exact: true });
  const issuedBeforeDismissalAttempts = requests.filter(request => request.path === '/admin/clients' && request.method === 'POST').length;
  await page.keyboard.press('Escape');
  assert(await creationDialog.isVisible(), 'Escape must keep client creation open');
  await page.mouse.click(2, 2);
  assert(await creationDialog.isVisible(), 'a backdrop click must keep client creation open');
  assert.equal(await creationDialog.getByLabel('客户端名称', { exact: true }).inputValue(), 'UI smoke AI');
  assert.equal(requests.filter(request => request.path === '/admin/clients' && request.method === 'POST').length, issuedBeforeDismissalAttempts,
    'accidental dismissal attempts must not issue a token');
  const tokenHelp = page.getByRole('button', { name: '令牌权限说明', exact: true });
  const issuedBeforeHelp = requests.filter(request => request.path === '/admin/clients' && request.method === 'POST').length;
  const grantsBeforeHelp = requests.filter(request => request.path === '/admin/grants' && request.method === 'POST').length;
  assert(await tokenHelp.evaluate(button => button.parentElement === document.querySelector('button[type="submit"]')?.parentElement),
    'token help must belong to the issuance action instead of occupying a separate form row');
  assert.equal(await creationDialog.getByLabel('使用方式').count(), 0, 'client identity is independent of its access method');
  await tokenHelp.click();
  const tooltip = page.getByRole('tooltip');
  await tooltip.waitFor();
  const text = await tooltip.innerText();
  assert.match(text, /签发令牌不会自动授予权限/);
  assert.match(text, /连接、能力和数据范围需单独授权/);
  assert.match(text, /密钥、令牌和 Cookie 始终隐藏/);
  assert.doesNotMatch(text, /余额|默认可见|New API|哔哩哔哩/);
  await page.keyboard.press('Escape');
  await tooltip.waitFor({ state: 'hidden' });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await tokenHelp.click();
      await page.getByRole('tooltip').waitFor();
      const positions = await tokenHelp.evaluate(button => {
        const help = button.getBoundingClientRect(), submit = button.parentElement.querySelector('button[type="submit"]').getBoundingClientRect();
        const tip = document.querySelector('[role="tooltip"]').getBoundingClientRect();
        return { helpCenter: help.y + help.height / 2, submitCenter: submit.y + submit.height / 2,
          gap: help.left - submit.right, tipLeft: tip.left, tipRight: tip.right, viewport: innerWidth };
      });
      assert(Math.abs(positions.helpCenter - positions.submitCenter) < 2 && positions.gap >= 0 && positions.gap < 20,
        'token help must stay beside the issuance button at desktop and mobile widths');
      assert(positions.tipLeft >= 0 && positions.tipRight <= positions.viewport, 'permission help must fit the viewport');
      assert(await page.getByRole('tooltip').evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return [0.2, 0.5, 0.8].every(fraction => {
          const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height * fraction);
          return hit === element || element.contains(hit);
        });
      }), 'modal help must remain visible in the native top layer without clipping');
      await checkWidth(`${width}px client-token-${colorScheme}`);
      await screenshot(`${width === 1280 ? 'desktop' : 'mobile'}-client-token-${colorScheme}`);
      await page.keyboard.press('Escape');
      await page.getByRole('tooltip').waitFor({ state: 'hidden' });
      assert(await page.getByRole('dialog', { name: '添加客户端', exact: true }).isVisible(), 'Escape closes the help before the containing dialog');
    }
  }
  assert.equal(requests.filter(request => request.path === '/admin/clients' && request.method === 'POST').length, issuedBeforeHelp,
    'opening token help must not issue a token');
  assert.equal(requests.filter(request => request.path === '/admin/grants' && request.method === 'POST').length, grantsBeforeHelp,
    'opening token help must not grant access');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByLabel('令牌有效期').selectOption('7');
  const issuedAfter = Date.now();
  await page.getByRole('button', { name: '签发令牌', exact: true }).click();
  await page.getByText('og_fixture_once_only_token_do_not_use', { exact: true }).waitFor();
  const issued = lastRequest('/admin/clients', 'POST').body;
  assert.deepEqual(Object.keys(issued).sort(), ['expires_at', 'label']);
  assert(Math.abs(Date.parse(issued.expires_at) - issuedAfter - 7 * 86_400_000) < 5000);
  await page.getByRole('dialog', { name: '接入方法 · UI smoke AI', exact: true }).getByRole('button', { name: '配置权限', exact: true }).click();
  await page.getByRole('dialog', { name: '接入方法 · UI smoke AI', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByText('og_fixture_once_only_token_do_not_use', { exact: true }).count(), 0);
  const clientGrant = page.locator('[data-grant-connection-id="con_personal"]');
  await clientGrant.getByRole('button', { name: '添加授权', exact: true }).click();
  await clientGrant.getByRole('checkbox', { name: /^账户资料/ }).check();
  await clientGrant.getByRole('checkbox', { name: /^个人信息/ }).check();
  assert.equal(await clientGrant.getByRole('checkbox', { name: /财务数据/ }).count(), 0, 'Bilibili only exposes field categories used by selected capabilities');
  await clientGrant.getByRole('checkbox', { name: /^信息流/ }).check();
  await clientGrant.getByRole('checkbox', { name: /^网站内容/ }).uncheck();
  await clientGrant.getByRole('checkbox', { name: /^信息流/ }).uncheck();
  await clientGrant.getByText('操作提案权限（不会开放站点写操作）', { exact: true }).click();
  await clientGrant.getByLabel(/允许提交「发布内容」/).check();
  await clientGrant.getByRole('button', { name: '保存授权', exact: true }).click();
  await clientGrant.locator('form').waitFor({ state: 'hidden' });
  await clientGrant.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.deepEqual(lastRequest('/admin/grants', 'POST').body, { client_id: 'client_created_0', connection_id: 'con_personal', capabilities: ['account.profile', 'propose:post.create'], visibility: { pii: true, financial: true, content: false } });
  await screenshot('desktop-client-policy');
  await clientGrant.getByRole('button', { name: '编辑授权', exact: true }).click();
  await clientGrant.getByRole('button', { name: '撤销此连接的全部权限' }).click();
  await clientGrant.locator('form').waitFor({ state: 'hidden' });
  await clientGrant.getByRole('status').filter({ hasText: /撤销/ }).waitFor();
  assert.deepEqual(lastRequest('/admin/grants', 'POST').body.capabilities, []);
  await clientGrant.getByRole('button', { name: '添加授权', exact: true }).click();
  await clientGrant.getByRole('checkbox', { name: /^账户资料/ }).check();
  await clientGrant.getByRole('button', { name: '保存授权', exact: true }).click();
  await clientGrant.locator('form').waitFor({ state: 'hidden' });
  await clientGrant.getByRole('status').filter({ hasText: '已保存' }).waitFor();

  await navigate('MCP 工具', 'MCP 常用工具');
  await page.getByRole('button', { name: '添加工具', exact: true }).click();
  await page.getByRole('combobox', { name: /^客户端/ }).selectOption('client_created_0');
  await page.getByRole('combobox', { name: /^查询连接/ }).selectOption('con_personal');
  await page.getByRole('combobox', { name: /^查询能力/ }).selectOption('account.profile');
  assert.equal(await page.getByRole('option', { name: /发布内容/ }).count(), 0);
  assert.equal(await page.getByRole('option', { name: /信息流/ }).count(), 0);
  await page.getByRole('textbox', { name: '工具名称', exact: true }).fill('bilibili_profile');
  await page.getByRole('button', { name: '验证身份并固定工具' }).click();
  await page.getByText('bilibili_profile', { exact: true }).waitFor();
  assert.deepEqual(lastRequest('/admin/mcp-tools', 'POST').body, { client_id: 'client_created_0', name: 'bilibili_profile', connection_id: 'con_personal', capability_id: 'account.profile' });
  await screenshot('desktop-mcp-tools');

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [label, heading, name] of [['概览', '概览', 'overview'], ['任务', '任务', 'tasks'], ['提案', '操作提案', 'proposals'], ['审计记录', '审计记录', 'audit'], ['连接', '连接', 'connections'], ['客户端', '客户端与授权', 'clients'], ['MCP 工具', 'MCP 常用工具', 'mcp-tools']]) {
      await navigate(label, heading);
      if (name === 'tasks') {
        await page.getByRole('link', { name: '查看结果与过程' }).nth(1).click();
        await page.getByRole('heading', { name: '任务详情', exact: true }).waitFor();
        await page.getByText('部分指标未知；保留实际值。', { exact: true }).waitFor();
      } else if (name === 'proposals') {
        await page.getByRole('button', { name: '预览具体内容' }).first().click();
        await page.getByRole('heading', { name: '确认提案内容' }).waitFor();
        assert(await page.getByRole('button', { name: '验证身份并批准此内容' }).isDisabled());
      } else if (name === 'connections') {
        await page.locator('li.card').filter({ hasText: 'UI smoke 组织连接' }).getByRole('button', { name: '查看', exact: true }).click();
        await page.getByRole('heading', { name: 'UI smoke 组织连接', exact: true }).waitFor();
      } else if (name === 'clients') {
        const mobileGrant = page.locator('[data-grant-connection-id="con_personal"]');
        await mobileGrant.getByRole('button', { name: '编辑授权', exact: true }).click();
        await mobileGrant.locator('form').waitFor();
        await mobileGrant.getByRole('checkbox', { name: /^账户资料/ }).waitFor();
      }
      await checkWidth(`${width}px ${name}`);
      if (width === 390) await screenshot(`mobile-${name}`);
      if (name === 'proposals') await page.getByRole('dialog', { name: '确认提案内容', exact: true }).getByRole('button', { name: '关闭确认提案内容', exact: true }).click();
    }
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '导航菜单', exact: true });
    await drawer.waitFor();
    const nav = await drawer.locator('.nav').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    assert(nav.scroll <= nav.width + 1, 'the grouped mobile navigation must fit without horizontal scrolling');
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
  }
  await page.getByRole('button', { name: '移除工具' }).click();
  await page.getByText('bilibili_profile', { exact: true }).waitFor({ state: 'hidden' });
  await seen('/admin/mcp-tools/mcp_fixture_0', 'DELETE');
  await navigate('客户端', '客户端与授权');
  await page.getByRole('button', { name: '撤销客户端' }).click();
  await seen('/admin/clients/client_created_0/revoke', 'POST');
  await page.locator('section[data-client-id]').waitFor({ state: 'hidden' });
  const clientHistory = page.locator('[data-client-history]');
  await clientHistory.waitFor();
  assert.equal(await clientHistory.evaluate(element => element.open), false, 'revoked clients must stay out of the active workspace');
  await clientHistory.locator('summary').click();
  await clientHistory.getByText('UI smoke AI', { exact: true }).waitFor();
  assert.equal(await clientHistory.locator('button, input, select, textarea, a, form').count(), 0, 'revoked history is read-only');

  mode = 'empty';
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate('概览', '概览');
  await page.reload();
  await page.getByRole('link', { name: '添加连接', exact: true }).waitFor();
  await navigate('任务', '任务');
  await page.getByText('还没有任务。在连接详情中使用「作为任务查询」。', { exact: true }).waitFor();
  await navigate('提案', '操作提案');
  await page.getByText('还没有操作提案。', { exact: true }).waitFor();
  await navigate('连接', '连接');
  await page.getByText('还没有连接', { exact: true }).waitFor();
  await navigate('客户端', '客户端与授权');
  await page.getByText('还没有客户端', { exact: true }).waitFor();
  await screenshot('mobile-empty-clients');
  await navigate('MCP 工具', 'MCP 常用工具');
  await page.getByText(/还没有固定工具。通用 MCP 查询工具已经可用/).waitFor();

  mode = 'error';
  await navigate('概览', '概览');
  await page.reload();
  await page.getByRole('alert').waitFor();
  await navigate('任务', '任务');
  await page.getByRole('alert').filter({ hasText: '任务加载失败' }).waitFor();
  await navigate('提案', '操作提案');
  await page.getByRole('alert').filter({ hasText: '本地示例服务暂时不可用' }).waitFor();
  await navigate('审计记录', '审计记录');
  await page.getByRole('alert').filter({ hasText: '记录加载失败' }).waitFor();
  await navigate('连接');
  await page.getByText('连接加载失败', { exact: true }).waitFor();
  await navigate('客户端');
  await page.getByText('客户端加载失败', { exact: true }).waitFor();
  await screenshot('mobile-error-clients');
  await navigate('MCP 工具', 'MCP 常用工具');
  await page.getByRole('alert').filter({ hasText: '本地示例服务暂时不可用' }).waitFor();

  assert.equal(requests.filter(request => request.path === '/admin/feed').length, 0, 'ordinary pages must not request the removed aggregate feed');
  assert.deepEqual(unexpected, [], 'all traffic must use known local API fixtures');
  assert.deepEqual(pageErrors, [], 'no uncaught browser errors');
  assert.deepEqual(layoutFailures, [], 'no document overflow at desktop or narrow mobile widths');
  const report = { status: 'passed', source: 'local synthetic API fixtures; no live platform acceptance', screenshots, requests: requests.length, viewports: [1280, 390, 320], assertions: ['overview/pause', 'task detail/events/cancel/submit', 'focused navigation without an aggregate feed', 'proposal hash approval/rejection', 'audit filters/pagination', 'organization confirmation/scope/tags', 'client expiry/one-time token/grant visibility/proposal rights/revocation', 'MCP pin eligible query/create/remove', 'mobile navigation/overflow', 'empty/error states'] };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Product UI smoke passed: ${report.assertions.join(', ')}. Screenshots/report: ${output}`);
} catch (error) {
  if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  console.error(error instanceof Error ? error.stack : String(error));
  if (unexpected.length) console.error('Unexpected requests:', unexpected);
  if (pageErrors.length) console.error('Browser errors:', pageErrors);
  if (layoutFailures.length) console.error('Layout failures:', layoutFailures);
  console.error(`Failure screenshot: ${join(output, 'failure.png')}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await rm(viteCache, { recursive: true, force: true });
}
