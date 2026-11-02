// B1: Chromium sandbox test — must NOT use --no-sandbox
import { chromium } from 'playwright';

console.log('Launching Chromium (no --no-sandbox)...');

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  // no sandbox flags — if user namespace works, launch should succeed
  args: ['--disable-gpu', '--disable-dev-shm-usage'],
  headless: true,
});

const page = await browser.newPage();
await page.goto('data:text/html,<h1>sandbox-ok</h1>');
const title = await page.evaluate(() => document.querySelector('h1').textContent);
console.log('Page content:', title);

// B2: grab a screenshot to verify CDP screencast quality later
const screenshot = await page.screenshot({ type: 'png' });
console.log('Screenshot size (bytes):', screenshot.byteLength);

// QR code test page
await page.goto('https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=webridge-test', {
  timeout: 15000,
  waitUntil: 'networkidle',
}).catch(e => console.warn('QR fetch skipped:', e.message));

const qrShot = await page.screenshot({ type: 'png' });
const { writeFileSync } = await import('fs');
writeFileSync('/test/out/qr.png', qrShot);
console.log('QR screenshot written to /test/out/qr.png, size:', qrShot.byteLength);

await browser.close();
console.log('SUCCESS: Chromium sandbox works without --no-sandbox');
