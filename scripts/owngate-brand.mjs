#!/usr/bin/env node
// Generate the selected OwnGate mark from its canonical vector, then inspect the
// actual public assets in sandboxed Chromium. No product service is contacted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(root, 'docs/brand/owngate/d-private-domain.svg');
const publicPath = join(root, 'apps/web/public');
const outputPath = join(root, 'out/ui/owngate-d-brand');
const cacheId = 'owngate-d-1';
const color = '#167D76';
const touchBackground = '#F5F8F7';
const sizes = [16, 24, 32, 48];
const icoSizes = [16, 32, 48];
const checkOnly = process.argv.slice(2).includes('--check');
for (const argument of process.argv.slice(2)) {
  if (argument === '--help') {
    console.log('Usage: node scripts/owngate-brand.mjs [--check]');
    console.log('Generate OwnGate D public assets and browser proofs; --check preserves the current assets.');
    process.exit(0);
  }
  assert.equal(argument, '--check', `Unknown argument: ${argument}`);
}

await mkdir(outputPath, { recursive: true });
const source = await readFile(sourcePath, 'utf8');
assert(source.includes('viewBox="0 0 48 48"'));
assert(!/<(?:image|script|foreignObject)\b|https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(source));
const expectedSvg = source.replace(/<title>[\s\S]*?<\/title>/, '<title>OwnGate</title>').replaceAll('currentColor', color);
const report = {
  status: 'running', cacheId, color, source: 'docs/brand/owngate/d-private-domain.svg',
  mode: checkOnly ? 'check' : 'generate-and-check',
  assets: {}, decoded: [], rasterBounds: [], screenshots: [], browserErrors: [], unexpected: [],
};
const { chromium } = createRequire(join(root, 'apps/browser/package.json'))('playwright');
let browser, server;

function packageIco(frames) {
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  frames.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size;
    directory[entry + 1] = size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([directory, ...frames.map(frame => frame.png)]);
}

function unpackIco(ico) {
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved header');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO image type');
  assert.equal(ico.readUInt16LE(4), icoSizes.length, 'ICO frame count');
  return icoSizes.map((size, index) => {
    const entry = 6 + index * 16;
    assert.equal(ico[entry], size, 'ICO frame width');
    assert.equal(ico[entry + 1], size, 'ICO frame height');
    assert.equal(ico.readUInt16LE(entry + 4), 1, 'ICO color plane');
    assert.equal(ico.readUInt16LE(entry + 6), 32, 'ICO RGBA depth');
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert(offset >= 6 + icoSizes.length * 16 && offset + length <= ico.length, 'ICO frame extent');
    const png = ico.subarray(offset, offset + length);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'ICO PNG payload');
    assert.equal(png.readUInt32BE(16), size, 'ICO PNG width');
    assert.equal(png.readUInt32BE(20), size, 'ICO PNG height');
    return { size, png };
  });
}

try {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: 1160, height: 980 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  page.on('pageerror', error => report.browserErrors.push(error.message));
  if (!checkOnly) {
    const rasters = await page.evaluate(async ({ svg, icoSizes, touchBackground }) => {
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      const raster = (size, touch = false) => {
        canvas.width = size; canvas.height = size;
        const context = canvas.getContext('2d');
        if (touch) {
          context.fillStyle = touchBackground;
          context.fillRect(0, 0, size, size);
          context.drawImage(image, 18, 18, 144, 144);
        } else context.drawImage(image, 0, 0, size, size);
        return canvas.toDataURL('image/png').split(',')[1];
      };
      return { frames: icoSizes.map(size => ({ size, data: raster(size) })), touch: raster(180, true) };
    }, { svg: expectedSvg, icoSizes, touchBackground });
    await writeFile(join(publicPath, 'favicon.svg'), expectedSvg);
    await writeFile(join(publicPath, 'favicon.ico'), packageIco(rasters.frames.map(({ size, data }) => ({ size, png: Buffer.from(data, 'base64') }))));
    await writeFile(join(publicPath, 'apple-touch-icon.png'), Buffer.from(rasters.touch, 'base64'));
  }

  const [svg, ico, touch, document, component, style, brandStyle] = await Promise.all([
    readFile(join(publicPath, 'favicon.svg'), 'utf8'), readFile(join(publicPath, 'favicon.ico')),
    readFile(join(publicPath, 'apple-touch-icon.png')), readFile(join(root, 'apps/web/index.html'), 'utf8'),
    readFile(join(root, 'apps/web/src/components/BrandMark.tsx'), 'utf8'),
    readFile(join(root, 'apps/web/src/styles.css'), 'utf8'), readFile(join(root, 'apps/web/src/components/BrandMark.css'), 'utf8'),
  ]);
  assert.equal(svg, expectedSvg, 'public SVG must be generated from the selected D source');
  assert(component.includes(`src="/favicon.svg?v=${cacheId}"`), 'BrandMark uses the current public SVG');
  assert(component.includes('alt="" aria-hidden="true"'), 'surrounding OwnGate wordmark names the decorative image');
  for (const file of ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png']) {
    assert(document.includes(`href="/${file}?v=${cacheId}"`), `${file} cache version`);
  }
  const frames = unpackIco(ico);
  for (const [name, bytes] of [['favicon.svg', Buffer.from(svg)], ['favicon.ico', ico], ['apple-touch-icon.png', touch]]) {
    report.assets[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    await writeFile(join(outputPath, name), bytes);
  }

  const image = (file, size, className = '') => `<img src="/${file}?v=${cacheId}" width="${size}" height="${size}" class="${className}" alt="" draggable="false">`;
  const row = (file, label) => `<div class="asset-row"><span class="asset-name">${label}</span>${sizes.map(size => `<span class="size-sample">${image(file, size)}<span>${size}px</span></span>`).join('')}</div>`;
  const wordmark = (size, mobile = false) => `<span class="brand${mobile ? ' mobile-brand' : ''}">${image('favicon.svg', size, 'brand-mark')}<span>OwnGate</span></span>`;
  const html = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OwnGate D · 正式标志</title><link rel="icon" type="image/svg+xml" href="/favicon.svg?v=${cacheId}"><style>${style}\n${brandStyle}\n
  body{margin:0;padding:38px 42px 30px}h1{margin:0;font-size:23px;letter-spacing:-.025em}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:25px}header>span{color:var(--muted);font:12px var(--mono)}.proof-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.proof-card{min-width:0;border:1px solid var(--border);border-radius:12px;background:var(--surface);padding:27px 28px}.proof-card h2{margin:0 0 20px;color:var(--muted);font-size:12px;font-weight:500}.large-mark{display:flex;align-items:center;justify-content:center;gap:36px;min-height:164px}.large-mark>img{display:block}.large-wordmark{font-size:34px;letter-spacing:-.05em;font-weight:650}.asset-row{display:flex;justify-content:space-between;align-items:center;gap:18px;min-height:82px}.asset-name{color:var(--muted);font:12px var(--mono)}.size-sample{display:flex;align-items:center;flex-direction:column;gap:9px;font:10px var(--mono);color:var(--muted);min-width:48px}.size-sample img{display:block;flex:none}.touch-layout{display:flex;align-items:center;justify-content:center;gap:38px;min-height:192px}.touch-layout>img{display:block;border-radius:30px;border:1px solid var(--border)}.touch-caption{color:var(--muted);font-size:12px;line-height:1.8}.wordmark-list{display:flex;align-items:start;justify-content:center;flex-direction:column;gap:21px;min-height:192px}.wordmark-row{display:flex;align-items:center;justify-content:space-between;gap:32px;width:100%}.wordmark-row>span:last-child{color:var(--muted);font-size:11px}.mobile-brand{font-size:18px}.proof-footer{margin:22px 0 0;color:var(--muted);font-size:11px}.wordmark-themes{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px}.wordmark-theme{border:1px solid var(--border);border-radius:12px;padding:30px}.wordmark-theme.light{background:#fcfcfd;color:#202631}.wordmark-theme.dark{background:#161b22;color:#e9edf3}.wordmark-theme .brand{color:inherit}.wordmark-theme>p{margin:0 0 23px;font-size:11px;opacity:.7}@media(max-width:650px){body{padding:24px 18px}.proof-grid,.wordmark-themes{grid-template-columns:1fr}.proof-card{padding:24px 20px}header{align-items:start;gap:18px;flex-direction:column}.large-mark{gap:18px}.large-wordmark{font-size:29px}.large-mark>img{width:104px;height:104px}.asset-row{gap:8px}.touch-layout{gap:20px}.touch-layout>img{width:144px;height:144px}.wordmark-row{gap:16px}}
  </style></head><body><header><h1>OwnGate <span style="font-weight:400;color:var(--muted)">· D 私域通道</span></h1><span>#167D76 · ${cacheId}</span></header><main class="proof-grid"><section class="proof-card"><h2>正式标识</h2><div class="large-mark">${image('favicon.svg', 144)}<span class="large-wordmark">OwnGate</span></div></section><section class="proof-card"><h2>实际尺寸 · 1× 像素</h2>${row('favicon.svg', 'SVG')}${row('favicon.ico', 'ICO')}</section><section class="proof-card"><h2>触屏图标</h2><div class="touch-layout">${image('apple-touch-icon.png', 180)}<span class="touch-caption">180 × 180<br>不透明背景</span></div></section><section class="proof-card"><h2>页面字标</h2><div class="wordmark-list"><div class="wordmark-row">${wordmark(28)}<span>导航 · 28px</span></div><div class="wordmark-row">${wordmark(26, true)}<span>移动 · 26px</span></div><div class="wordmark-row">${wordmark(28)}<span>登录 · 28px</span></div></div></section></main><section class="wordmark-themes" id="wordmark-themes"><div class="wordmark-theme light"><p>浅色导航背景</p>${wordmark(28)}</div><div class="wordmark-theme dark"><p>深色导航背景</p>${wordmark(28)}</div></section><p class="proof-footer">实际应用 SVG、ICO 与 PNG · 几何来源 d-private-domain.svg</p></body></html>`;
  await writeFile(join(outputPath, 'index.html'), html.replaceAll('src="/', 'src="').replaceAll('href="/', 'href="'));
  const resources = new Map([
    ['/', { bytes: html, type: 'text/html; charset=utf-8' }],
    ['/favicon.svg', { bytes: svg, type: 'image/svg+xml' }],
    ['/favicon.ico', { bytes: ico, type: 'image/x-icon' }],
    ['/apple-touch-icon.png', { bytes: touch, type: 'image/png' }],
    ...frames.map(({ size, png }) => [`/frame-${size}.png`, { bytes: png, type: 'image/png' }]),
  ]);
  server = createServer((request, response) => {
    const asset = resources.get(new URL(request.url, 'http://localhost').pathname);
    if (!asset) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': asset.type }); response.end(asset.bytes);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  page.on('request', request => { if (new URL(request.url()).origin !== origin) report.unexpected.push(request.url()); });
  await page.goto(origin);
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  const inspected = await page.evaluate(async ({ sizes, icoSizes, touchBackground }) => {
    const canvas = document.createElement('canvas');
    const decoded = [], rasterBounds = [];
    const load = async url => {
      const image = new Image(); image.src = url; await image.decode();
      return image;
    };
    const raster = (image, size) => {
      canvas.width = size; canvas.height = size;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, size, size);
      return context.getImageData(0, 0, size, size).data;
    };
    for (const file of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
      const image = await load('/' + file);
      decoded.push({ file, width: image.naturalWidth, height: image.naturalHeight });
      if (file === 'apple-touch-icon.png') {
        const pixels = raster(image, 180);
        const opaque = pixels.every((channel, index) => index % 4 !== 3 || channel === 255);
        const corner = [...pixels.slice(0, 4)];
        decoded[decoded.length - 1] = { file, width: image.naturalWidth, height: image.naturalHeight, opaque, corner, background: touchBackground };
        continue;
      }
      for (const size of sizes) {
        const pixels = raster(image, size), coordinates = [];
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (pixels[(y * size + x) * 4 + 3]) coordinates.push([x, y]);
        rasterBounds.push({ file, size, pixels: coordinates.length, bounds: {
          left: Math.min(...coordinates.map(([x]) => x)), right: Math.max(...coordinates.map(([x]) => x)),
          top: Math.min(...coordinates.map(([, y]) => y)), bottom: Math.max(...coordinates.map(([, y]) => y)),
        } });
      }
    }
    for (const size of icoSizes) {
      const frame = await load(`/frame-${size}.png`);
      const expected = await load('/favicon.svg');
      const actualPixels = raster(frame, size);
      const expectedPixels = raster(expected, size);
      let differentChannels = 0;
      for (let index = 0; index < actualPixels.length; index++) if (Math.abs(actualPixels[index] - expectedPixels[index]) > 2) differentChannels++;
      decoded.push({ file: `favicon.ico[${size}]`, width: frame.naturalWidth, height: frame.naturalHeight, differentChannels });
    }
    return { decoded, rasterBounds };
  }, { sizes, icoSizes, touchBackground });
  report.decoded = inspected.decoded; report.rasterBounds = inspected.rasterBounds;
  assert.deepEqual(report.decoded.find(asset => asset.file === 'favicon.ico'), { file: 'favicon.ico', width: 48, height: 48 });
  const apple = report.decoded.find(asset => asset.file === 'apple-touch-icon.png');
  assert.equal(apple.width, 180); assert.equal(apple.height, 180); assert.equal(apple.opaque, true);
  assert.deepEqual(apple.corner, [245, 248, 247, 255]);
  for (const frame of report.decoded.filter(asset => asset.file.startsWith('favicon.ico['))) {
    assert.equal(frame.width, frame.height);
    assert.equal(frame.differentChannels, 0, `${frame.file} matches the canonical SVG`);
  }
  for (const { file, size, pixels, bounds } of report.rasterBounds) {
    assert(pixels > 10, `${file} ${size}px has visible artwork`);
    assert(bounds.left > 0 && bounds.top > 0 && bounds.right < size - 1 && bounds.bottom < size - 1, `${file} ${size}px has clear outer pixels`);
  }
  const snapshot = async (name, target) => {
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    if (target) await target.screenshot({ path: join(outputPath, name), animations: 'disabled' });
    else await page.screenshot({ path: join(outputPath, name), fullPage: true, animations: 'disabled' });
    report.screenshots.push(name);
  };
  await snapshot('brand-light.png');
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await snapshot('brand-dark.png');
  await snapshot('wordmarks-light-dark.png', page.locator('#wordmark-themes'));
  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.unexpected, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
  await writeFile(join(outputPath, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, mode: report.mode, cacheId, screenshots: report.screenshots.length, output: outputPath, ...(report.error ? { error: report.error } : {}) }));
}
