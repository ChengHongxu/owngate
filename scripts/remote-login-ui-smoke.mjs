#!/usr/bin/env node
// Actual remote-login React route, disposable Vite and synthetic HTTP/WebSocket APIs.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let output, baseline = false;
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] === '--out' && process.argv[index + 1]) output = resolve(process.argv[++index]);
  else if (process.argv[index] === '--baseline') baseline = true;
  else if (process.argv[index] === '--help') {
    console.log('Usage: node scripts/remote-login-ui-smoke.mjs [--out DIRECTORY] [--baseline]');
    console.log('Disposable actual frontend and synthetic frames only; never the user deployment.');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${process.argv[index]}`);
}
await mkdir(join(root, 'out/ui'), { recursive: true });
output ??= await mkdtemp(join(root, 'out/ui/remote-login-'));
await mkdir(output, { recursive: true });
const cache = await mkdtemp(join(tmpdir(), 'owngate-remote-ui-vite-'));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const browserRequire = createRequire(join(root, 'apps/browser/package.json'));
const { createServer } = await import(pathToFileURL(join(dirname(webRequire.resolve('vite/package.json')), 'dist/node/index.js')).href);
const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href);
const { chromium } = browserRequire('playwright');
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const { QRCodeSVG } = webRequire('qrcode.react');
const qrSvg = renderToStaticMarkup(React.createElement(QRCodeSVG, { xmlns: 'http://www.w3.org/2000/svg', value: 'owngate-remote-login-public-test-fixture', size: 160, marginSize: 4, level: 'M' }));
const report = { status: 'running', source: 'Actual React remote-login route on disposable Vite with synthetic HTTP/WebSocket messages; no live account, platform, credential or deployment access.',
  baseline, checks: [], screenshots: [], requests: [], frames: [], geometry: [], browserErrors: [], consoleErrors: [], unexpected: [] };
const contexts = [];
let vite, browser, origin, page, stage = 'startup';
async function eventually(predicate, description, timeout = 7000) {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await delay(20); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}
async function check(name, action) { stage = name; await action(); report.checks.push(name); }
async function shot(name) {
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); });
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true, animations: 'disabled' });
  report.screenshots.push(`${name}.png`);
}
async function fixture({ width = 1280, colorScheme = 'dark' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, locale: 'zh-CN', serviceWorkers: 'block' });
  contexts.push(context);
  const state = { sockets: [], opens: 0, stops: 0, polls: 0, status: 'pending' };
  await context.addInitScript(colorScheme => { try { localStorage.setItem('owngate.theme', colorScheme); } catch { /* about:blank has no storage origin */ } }, colorScheme);
  await context.addInitScript(() => {
    // Real image decoding still occurs. Only its onload callback can be held
    // and explicitly released to deterministically exercise browser races.
    const NativeImage = window.Image;
    const harness = { holdNext: false, callbacks: [], released: 0 };
    window.__remoteImageHarness = harness;
    function ControlledImage(...args) {
      const image = new NativeImage(...args);
      let onload;
      const held = harness.holdNext;
      if (held) harness.holdNext = false;
      Object.defineProperty(image, 'onload', { configurable: true, get: () => onload, set: value => { onload = value; } });
      image.addEventListener('load', event => {
        const invoke = () => { if (typeof onload === 'function') onload.call(image, event); };
        if (held) harness.callbacks.push(invoke); else invoke();
      });
      return image;
    }
    ControlledImage.prototype = NativeImage.prototype;
    Object.setPrototypeOf(ControlledImage, NativeImage);
    window.Image = ControlledImage;
  });
  context.on('page', target => {
    target.setDefaultTimeout(7000);
    target.on('pageerror', error => report.browserErrors.push(error.message));
    target.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { report.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort(); }
    if (!/^\/(?:auth|admin|api)\//.test(url.pathname)) return route.continue();
    const method = request.method(), path = url.pathname;
    report.requests.push({ method, path });
    if (path === '/auth/status' && method === 'GET') return route.fulfill({ json: { hasUser: true, authenticated: true, stepUp: true, totpEnabled: true, passkeyCount: 0 } });
    if (path === '/admin/screen/ui-remote/open' && method === 'POST') {
      state.opens++;
      return route.fulfill({ json: { ticket: 'synthetic-ticket', ws_path: `/ws/screen/ui-remote?ticket=synthetic-${state.opens}` } });
    }
    if (path === '/admin/screen/ui-remote/status' && method === 'GET') { state.polls++; return route.fulfill({ json: { status: state.status } }); }
    if (path === '/admin/screen/ui-remote/stop' && method === 'POST') { state.stops++; return route.fulfill({ json: { ok: true } }); }
    report.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 404, json: { code: 'FIXTURE_UNEXPECTED' } });
  });
  await context.routeWebSocket(url => new URL(url).pathname === '/ws/screen/ui-remote', ws => {
    state.sockets.push(ws);
    ws.onMessage(() => {});
  });
  const target = await context.newPage();
  await target.goto(`${origin}/connections/ui-remote/login`);
  await target.getByRole('heading', { name: '远程登录', exact: true }).waitFor();
  const images = await target.evaluate(async qrSvg => {
    function image(width, height, color, type) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#edf1f5'; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = color; ctx.fillRect(0, 0, width, 80);
      ctx.fillStyle = '#202631'; ctx.font = '28px sans-serif'; ctx.fillText('OwnGate synthetic remote login', 40, 150);
      ctx.fillStyle = '#fff'; ctx.fillRect(170, 220, 200, 200);
      ctx.fillStyle = '#111';
      for (let y = 0; y < 23; y++) for (let x = 0; x < 23; x++) if ((x * 17 + y * 13) % 5 < 2) ctx.fillRect(182 + x * 7.5, 232 + y * 7.5, 7.5, 7.5);
      return canvas.toDataURL(type).split(',')[1];
    }
    const qr = new Image();
    await new Promise((accept, reject) => { qr.onload = accept; qr.onerror = reject; qr.src = `data:image/svg+xml,${encodeURIComponent(qrSvg)}`; });
    function qrImage(size, type) {
      const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
      canvas.getContext('2d').drawImage(qr, 0, 0, size, size);
      return canvas.toDataURL(type).split(',')[1];
    }
    return { normal: image(1280, 800, '#245bd8', 'image/jpeg'), newer: image(1280, 800, '#23864b', 'image/jpeg'),
      old: image(1280, 800, '#b22b36', 'image/jpeg'), crop: qrImage(160, 'image/jpeg'), largeCrop: qrImage(800, 'image/jpeg'),
      qr: qrImage(160, 'image/png'), qrNext: qrImage(192, 'image/png') };
  }, qrSvg);
  return { context, page: target, state, images };
}
function send(state, data, extra = {}, index = state.sockets.length - 1) {
  state.sockets[index].send(JSON.stringify({ type: 'frame', data, ts: Date.now(), width: 1280, height: 800, ...extra }));
}
async function start(fixture, again = false) {
  const before = fixture.state.sockets.length;
  await fixture.page.getByRole('button', { name: again ? '重新打开' : '打开登录窗口', exact: true }).click();
  await eventually(() => fixture.state.sockets.length === before + 1, 'synthetic stream opens');
  await fixture.page.getByRole('button', { name: '结束', exact: true }).waitFor();
}
async function sample(name) {
  const value = await page.locator('.screen-canvas').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect(), pixel = canvas.width > 20 && canvas.height > 20 ? [...canvas.getContext('2d').getImageData(20, 20, 1, 1).data] : null;
    return { width: canvas.width, height: canvas.height, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, pixel };
  });
  report.frames.push({ name, ...value });
  return value;
}
async function readyPixel(color) {
  await page.waitForFunction(color => {
    const canvas = document.querySelector('.screen-canvas');
    if (canvas?.width !== 1280 || canvas?.height !== 800) return false;
    const pixel = canvas.getContext('2d').getImageData(20, 20, 1, 1).data;
    return color.every((value, index) => Math.abs(value - pixel[index]) <= 5);
  }, color);
}
const blue = [36, 91, 216], green = [35, 134, 75];
async function holdImage() { await page.evaluate(() => { window.__remoteImageHarness.holdNext = true; }); }
async function imageHeld() { await page.waitForFunction(() => window.__remoteImageHarness.callbacks.length === 1); }
async function releaseImage() {
  await page.evaluate(() => {
    const harness = window.__remoteImageHarness;
    for (const invoke of harness.callbacks.splice(0)) { invoke(); harness.released++; }
  });
  await delay(50);
}
async function geometry(name) {
  const value = await page.evaluate(() => {
    const rect = document.querySelector('.screen-canvas').getBoundingClientRect();
    const image = document.querySelector('.qr-image'), qr = image?.getBoundingClientRect();
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, canvas: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      qr: qr ? { x: qr.x, y: qr.y, width: qr.width, height: qr.height, complete: image.complete, naturalWidth: image.naturalWidth } : null };
  });
  report.geometry.push({ name, ...value });
  assert(value.documentWidth <= value.viewport + 1, `${name}: no horizontal document overflow`);
  assert(value.canvas.width > 0 && value.canvas.x >= 0 && value.canvas.x + value.canvas.width <= value.viewport + 1, `${name}: full screen fits viewport`);
  if (value.qr) {
    assert(value.qr.width <= 256 && value.qr.width >= 150 && value.qr.height <= 256, `${name}: QR remains bounded and readable`);
    assert(value.qr.x >= 0 && value.qr.x + value.qr.width <= value.viewport + 1, `${name}: side QR fits viewport`);
    assert(value.qr.complete && value.qr.naturalWidth > 0, `${name}: side QR has decoded`);
  }
  return value;
}
function sameCanvas(a, b, name) {
  for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(a.canvas[key] - b.canvas[key]) <= 0.1, `${name}: canvas ${key} is stable`);
}

try {
  vite = await createServer({ root: join(root, 'apps/web'), configFile: false, plugins: [react()], cacheDir: cache,
    server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  await vite.listen(); origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const current = await fixture(); page = current.page;
  await start(current);
  if (!baseline) await check('A cropped first frame cannot establish the main canvas size', async () => {
    for (const data of [current.images.crop, current.images.largeCrop]) {
      send(current.state, data); await delay(80);
      const value = await sample('initial-crop-rejected');
      assert.notEqual(value.width, 160);
      assert(!(value.width === 800 && value.height === 800), 'a first 800px crop must not become the full viewport');
    }
  });
  await check('A full viewport frame is rendered before an interleaved QR crop', async () => {
    send(current.state, current.images.normal);
    await page.waitForFunction(() => document.querySelector('.screen-canvas')?.width === 1280);
    await sample('normal-before-crop'); await shot('normal-before-crop');
  });
  if (baseline) {
    await check('Old frontend reproduces an enlarged QR crop in the full-page canvas', async () => {
      send(current.state, current.images.crop);
      await page.waitForFunction(() => document.querySelector('.screen-canvas')?.width === 160);
      const value = await sample('cropped-qr-replaces-viewport');
      assert.equal(value.height, 160);
      await shot('cropped-qr-flash');
      send(current.state, current.images.normal);
      await page.waitForFunction(() => document.querySelector('.screen-canvas')?.width === 1280);
      await sample('viewport-restored');
    });
  } else {
    await check('Cropped, malformed and dimensionless frames preserve the latest valid viewport', async () => {
      const before = await geometry('viewport-before-invalid-frames');
      for (const [name, data, extra] of [
        ['small-crop', current.images.crop, {}], ['actual-800px-crop', current.images.largeCrop, {}],
        ['missing-dimensions', current.images.normal, { width: undefined, height: undefined }],
        ['mismatched-dimensions', current.images.normal, { width: 640, height: 400 }],
        ['invalid-dimensions', current.images.normal, { width: -1, height: 800 }],
        ['malformed-image', Buffer.from('not-a-valid-jpeg').toString('base64'), {}],
      ]) {
        send(current.state, data, extra); await delay(80);
        const value = await sample(name);
        assert.equal(value.width, 1280); assert.equal(value.height, 800);
        await readyPixel(blue);
        sameCanvas(before, await geometry(`after-${name}`), name);
      }
      send(current.state, current.images.newer); await readyPixel(green);
      await shot('viewport-preserved-after-invalid-frames');
    });
    await check('Older image decoding cannot overwrite an already rendered newer frame', async () => {
      await holdImage(); send(current.state, current.images.old); await imageHeld();
      send(current.state, current.images.normal); await readyPixel(blue);
      await releaseImage(); await readyPixel(blue);
      const value = await sample('older-decoder-callback-rejected');
      assert(value.pixel[2] > value.pixel[0], 'the newer blue frame remains visible');
    });
    await check('A pending image from an ended stream cannot overwrite a reopened stream', async () => {
      await holdImage(); send(current.state, current.images.old); await imageHeld();
      await page.getByRole('button', { name: '结束', exact: true }).click();
      await page.getByText('画面已关闭。', { exact: true }).waitFor();
      await eventually(() => current.state.stops === 1, 'explicit stop request');
      await start(current, true);
      send(current.state, current.images.newer); await readyPixel(green);
      await releaseImage(); await readyPixel(green);
      await sample('old-stream-decoder-callback-rejected');
    });
    await check('Repeated two-second QR capture cycles keep every visible viewport frame stable', async () => {
      send(current.state, current.images.normal); await readyPixel(blue);
      const before = await geometry('continuous-refresh-start');
      await page.evaluate(() => {
        const samples = []; window.__remoteContinuous = { running: true, samples };
        function sampleFrame() {
          const canvas = document.querySelector('.screen-canvas'), rect = canvas.getBoundingClientRect();
          const pixel = [...canvas.getContext('2d').getImageData(20, 20, 1, 1).data];
          samples.push({ width: canvas.width, height: canvas.height, top: rect.top, visibleHeight: rect.height, pixel });
          if (window.__remoteContinuous.running) requestAnimationFrame(sampleFrame);
        }
        requestAnimationFrame(sampleFrame);
      });
      const pollsBefore = current.state.polls;
      for (let cycle = 0; cycle < 3; cycle++) {
        await delay(2000);
        send(current.state, current.images.largeCrop);
        current.state.sockets.at(-1).send(JSON.stringify({ type: 'qr', data: cycle % 2 ? current.images.qrNext : current.images.qr, ts: Date.now() }));
        await delay(120);
        send(current.state, current.images.normal);
        await readyPixel(blue);
      }
      const samples = await page.evaluate(() => { window.__remoteContinuous.running = false; return window.__remoteContinuous.samples; });
      assert(samples.length > 60, 'sample the actual canvas throughout multiple timer cycles');
      assert(samples.every(value => value.width === 1280 && value.height === 800), 'no animation frame exposes a cropped native canvas');
      assert(samples.every(value => blue.every((component, index) => Math.abs(component - value.pixel[index]) <= 5)), 'no animation frame exposes the giant QR pixels');
      assert(samples.every(value => Math.abs(value.top - before.canvas.y) <= 0.1 && Math.abs(value.visibleHeight - before.canvas.height) <= 0.1), 'the displayed screen geometry remains fixed across all timer cycles');
      assert(current.state.polls >= pollsBefore + 3, 'login status polling remains active during QR updates');
      report.continuous = { samples: samples.length, cycles: 3, polls: current.state.polls - pollsBefore,
        nativeSizes: [...new Set(samples.map(value => `${value.width}x${value.height}`))],
        visibleHeights: [...new Set(samples.map(value => value.visibleHeight))], giantQrFrames: 0 };
      await shot('desktop-continuous-refresh-stable');
    });
    await check('Independent QR updates and removal fit all desktop and mobile layouts', async () => {
      for (const width of [1280, 1920, 390, 320]) for (const colorScheme of ['light', 'dark']) {
        const selected = await fixture({ width, colorScheme }); page = selected.page;
        await start(selected);
        send(selected.state, selected.images.normal); await readyPixel(blue);
        selected.state.sockets.at(-1).send(JSON.stringify({ type: 'qr', data: selected.images.qr, ts: Date.now() }));
        await page.locator('.qr-image').waitFor();
        await page.waitForFunction(() => document.querySelector('.qr-image')?.naturalWidth === 160);
        const before = await geometry(`qr-first-${colorScheme}-${width}`);
        for (const data of [selected.images.largeCrop, selected.images.crop]) {
          send(selected.state, data); await delay(60); await readyPixel(blue);
        }
        selected.state.sockets.at(-1).send(JSON.stringify({ type: 'qr', data: selected.images.qrNext, ts: Date.now() }));
        await page.waitForFunction(() => document.querySelector('.qr-image')?.naturalWidth === 192);
        sameCanvas(before, await geometry(`qr-updated-${colorScheme}-${width}`), 'updated side QR');
        await shot(`remote-login-${colorScheme}-${width}`);
        selected.state.sockets.at(-1).send(JSON.stringify({ type: 'qr', data: null, ts: Date.now() }));
        await page.getByText('尚未检测到二维码', { exact: true }).waitFor();
        assert.equal(await page.locator('.qr-image').count(), 0);
        sameCanvas(before, await geometry(`qr-cleared-${colorScheme}-${width}`), 'cleared side QR');
        await selected.context.close();
      }
    });
    page = current.page;
    await check('A successful login poll closes the stream without replaying pending images', async () => {
      await holdImage(); send(current.state, current.images.old); await imageHeld();
      current.state.status = 'success';
      await page.getByText('✓ 登录成功', { exact: true }).waitFor();
      await releaseImage();
      assert.equal(await page.locator('.screen-layout').isVisible(), false);
      await shot('successful-login-stream-closed');
    });
  }
  assert.deepEqual(report.browserErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.unexpected, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.stage = stage; report.error = error.stack ?? error.message;
  if (page && !page.isClosed()) await shot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  await rm(cache, { recursive: true, force: true });
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, baseline, checks: report.checks.length, screenshots: report.screenshots.length, output, error: report.error }, null, 2));
}
