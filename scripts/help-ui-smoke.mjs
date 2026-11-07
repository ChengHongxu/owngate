#!/usr/bin/env node
// Actual HelpTip and SchemaFields components, isolated from account/admin APIs.
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
    console.log('Usage: node scripts/help-ui-smoke.mjs [--out SCREENSHOT_DIRECTORY]');
    console.log('Actual help components in a disposable local page; no account or API access.');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${process.argv[i]}`);
}
await mkdir(join(root, 'out/ui'), { recursive: true });
output ??= await mkdtemp(join(root, 'out/ui/help-'));
await mkdir(output, { recursive: true });
const cache = await mkdtemp(join(tmpdir(), 'owngate-help-vite-'));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const browserRequire = createRequire(join(root, 'apps/browser/package.json'));
const { createServer } = await import(pathToFileURL(join(dirname(webRequire.resolve('vite/package.json')), 'dist/node/index.js')).href);
const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href);
const { chromium } = browserRequire('playwright');
const report = { status: 'running', source: 'Actual HelpTip/SchemaFields in an isolated local fixture; no account, admin API or remote request.', checks: [], screenshots: [], layouts: [], browserErrors: [], unexpected: [] };
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/theme-init.js"></script><title>帮助交互验收</title><link rel="stylesheet" href="/src/styles.css"><style>
.test-shell{width:100%;max-width:760px;margin:0 auto;padding:28px 24px 80px;display:grid;gap:24px;min-height:1200px;align-content:start}.test-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.test-shell .card{width:100%;max-width:100%}.test-shell h1{font-size:22px}.test-spacer{height:100px}
</style></head><body><main class="test-shell"><div id="root"></div></main><script type="module">
import '/src/lib/theme.ts';import React from 'react';import{createRoot}from'react-dom/client';import{HelpTip}from'/src/components/HelpTip.tsx';import{SchemaFields}from'/src/components/SchemaFields.tsx';
const h=React.createElement;window.fixtureSubmits=0;const longText='按需显示说明，常规操作时保持页面简洁。支持悬浮、聚焦和点击；点击后保持打开，按 Escape 或点击其他位置关闭。';
function Fixture(){const[values,setValues]=React.useState({base_url:'https://example.invalid',egress_strict:'false'});return h(React.Fragment,null,h('div',{className:'test-heading'},h('h1',null,'帮助交互验收'),h(HelpTip,{label:'页面说明'},longText)),h('div',{className:'test-spacer'}),h('form',{className:'card form',onSubmit:e=>{e.preventDefault();window.fixtureSubmits++}},h(SchemaFields,{fields:[{name:'base_url',required:false,schema:{type:'string',label:'站点地址',help:'完整网址只需在编辑时修改。'+longText}},{name:'egress_strict',required:false,schema:{type:'boolean',label:'仅允许站点域名',help:'严格模式仅允许当前平台的域名。'+longText}}],values,onChange:setValues}),h('div',{className:'card-actions'},h('button',{type:'submit'},'保存'),h('button',{type:'button',id:'other-action'},'其他操作'))))}createRoot(document.getElementById('root')).render(h(Fixture));
</script></body></html>`;
let vite, browser, page, stage = 'startup';
const contexts = [];
async function check(name, action) { stage = name; await action(); report.checks.push(name); }
async function eventually(predicate, description) {
  const deadline = Date.now() + 5000;
  do { if (await predicate()) return; await delay(25); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}
async function screenshot(name) {
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: false, animations: 'disabled' });
  report.screenshots.push(`${name}.png`);
}
async function layout(name) {
  const bounds = await page.evaluate(() => { const tip = document.querySelector('[role="tooltip"]')?.getBoundingClientRect(); return { width: innerWidth, document: document.documentElement.scrollWidth, height: innerHeight, tip: tip ? { left: tip.left, right: tip.right, top: tip.top, bottom: tip.bottom } : null }; });
  report.layouts.push({ name, ...bounds });
  assert(bounds.document <= bounds.width + 1, `${name}: horizontal overflow`);
  if (bounds.tip) {
    assert(bounds.tip.left >= 0 && bounds.tip.right <= bounds.width + 1, `${name}: help must fit horizontally`);
    assert(bounds.tip.top >= 0 && bounds.tip.bottom <= bounds.height + 1, `${name}: help must fit vertically`);
  }
}

try {
  vite = await createServer({ root: join(root, 'apps/web'), configFile: false, plugins: [react(), {
    name: 'isolated-help-fixture', configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/help-acceptance') return next();
        void server.transformIndexHtml('/help-acceptance', html).then(body => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(body); }).catch(error => { response.statusCode = 500; response.end('Local fixture unavailable'); report.unexpected.push(error.message); });
      });
    },
  }], cacheDir: cache, resolve: { dedupe: ['react', 'react-dom'] },
    optimizeDeps: { entries: [], include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'] }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await vite.listen();
  const address = vite.httpServer.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  async function fixture({ width = 1280, height = 900, colorScheme = 'light', mobile = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme, hasTouch: mobile, isMobile: mobile });
    contexts.push(context);
    const nextPage = await context.newPage();
    nextPage.setDefaultTimeout(6000);
    nextPage.on('pageerror', error => report.browserErrors.push(error.message));
    await nextPage.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || /^\/(?:admin|auth|api)\//.test(url.pathname)) { report.unexpected.push(`${route.request().method()} ${url.origin}${url.pathname}`); return route.abort(); }
      return route.continue();
    });
    await nextPage.goto(`${origin}/help-acceptance`);
    await nextPage.getByRole('heading', { name: '帮助交互验收', exact: true }).waitFor();
    return nextPage;
  }
  page = await fixture();
  const tip = () => page.getByRole('tooltip');
  const trigger = () => page.getByRole('button', { name: '站点地址说明', exact: true });
  const other = () => page.getByRole('button', { name: '其他操作', exact: true });
  await check('hover enters popup without losing its text', async () => {
    await trigger().hover(); await tip().waitFor();
    const box = await tip().boundingBox(); assert(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
    await delay(220);
    assert(await tip().isVisible());
    await layout('desktop-light-hover'); await screenshot('desktop-light-hover');
    await other().hover(); await tip().waitFor({ state: 'hidden' });
  });
  await check('focus opens help and Escape dismisses without reopening on render', async () => {
    await trigger().focus(); await tip().waitFor();
    await page.keyboard.press('Escape'); await tip().waitFor({ state: 'hidden' });
    assert(await trigger().evaluate(element => element === document.activeElement));
    await delay(220); assert.equal(await tip().count(), 0);
    await page.keyboard.press('Tab'); await page.getByLabel('站点地址', { exact: true }).waitFor();
    assert(await page.getByLabel('站点地址', { exact: true }).evaluate(element => element === document.activeElement));
  });
  await check('click pins, second click closes, outside click dismisses', async () => {
    await trigger().click(); await tip().waitFor();
    await other().hover(); await delay(220); assert(await tip().isVisible());
    await trigger().click(); await tip().waitFor({ state: 'hidden' });
    await trigger().click(); await tip().waitFor();
    await other().click(); await tip().waitFor({ state: 'hidden' });
  });
  await check('help does not submit a form or activate another labeled control', async () => {
    const input = page.getByLabel('站点地址', { exact: true }), select = page.getByLabel('仅允许站点域名', { exact: true });
    await page.getByRole('button', { name: '仅允许站点域名说明', exact: true }).click(); await tip().waitFor();
    assert.equal(await select.inputValue(), 'false');
    assert.equal(await input.inputValue(), 'https://example.invalid');
    assert.equal(await page.evaluate(() => window.fixtureSubmits), 0);
    assert.equal(await trigger().evaluate(element => element.closest('label') !== null), false);
    await page.keyboard.press('Escape');
    await page.locator('label').filter({ hasText: /^站点地址$/ }).click();
    assert(await input.evaluate(element => element === document.activeElement));
  });
  await check('open help follows scroll and resize while staying within bounds', async () => {
    await trigger().click(); await tip().waitFor();
    const initial = await tip().boundingBox(); assert(initial);
    await page.evaluate(() => window.scrollBy(0, 80));
    await eventually(async () => Math.abs((await tip().boundingBox()).y - initial.y) > 40, 'popup follows scrolled anchor');
    await page.setViewportSize({ width: 390, height: 844 });
    await eventually(async () => { const box = await tip().boundingBox(); return box && box.x >= 0 && box.x + box.width <= 391; }, 'popup fits resized viewport');
    await layout('desktop-resized-390'); await screenshot('desktop-resized-390');
    await page.keyboard.press('Escape');
  });
  for (const colorScheme of ['light', 'dark']) {
    for (const width of [390, 320]) {
      await check(`${colorScheme} ${width}px touch help remains readable and dismissible`, async () => {
        page = await fixture({ width, height: 844, colorScheme, mobile: true });
        await trigger().tap(); await tip().waitFor();
        await layout(`${colorScheme}-${width}-touch`); await screenshot(`${colorScheme}-${width}-touch`);
        await trigger().tap(); await tip().waitFor({ state: 'hidden' });
        await trigger().tap(); await tip().waitFor();
        await other().tap(); await tip().waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => window.fixtureSubmits), 0);
      });
    }
  }
  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.unexpected, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { stage, message: error instanceof Error ? error.message : String(error) };
  if (page) await screenshot('failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  await Promise.all(contexts.map(context => context.close().catch(() => undefined)));
  await browser?.close(); await vite?.close(); await rm(cache, { recursive: true, force: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, screenshots: report.screenshots.length, output, ...(report.failure ? { failure: report.failure } : {}) }));
}
