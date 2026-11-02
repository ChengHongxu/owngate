// B2: QR readability via CDP screencast vs locator.screenshot() — offline version
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';

mkdirSync('/test/out', { recursive: true });

// QR pre-embedded as data URI — no network needed
const QR_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADIAQMAAACXljzdAAAABlBMVEX///8AAABVwtN+AAAACXBIWXMAAA7EAAAOxAGVKw4bAAAA/ElEQVRYhd2XSw7EMAhD4eS5OUwxJs1o1H099KOK10VRHEPNHmMl4npKC6+jE/Fugm9PHJW+WCVcl1SdCV5Vdq0hT3CvBfsTgmJ9tKhMqMTrLCHar0a1CJ0iHz1Ei+yA/fmZkSQruacgR1oF7E+V0CRq7aBDp5mrks7X7oIIKcYQJca+hAudFnYuS9bWIZzCfHrtu8kszhHUmyhBM8UVd0PteVSTMH8OpPA3YcKGasZueleqRiaSb0TTczyQIqsLY5nTTP1rEpIiU2edPY16bCUqkpFhWtw6PP+MNAm9vK3CU57YzAUtRV3SSsT2uv99dMl2il67o9NKksf4AA0M69UuvuOSAAAAAElFTkSuQmCC';

const html = `<!doctype html>
<html><head><style>
  body{margin:0;background:#fff;}
  #qr{width:200px;height:200px;display:block;}
</style></head>
<body>
  <img id="qr" src="${QR_DATA_URI}" />
  <script>
    document.getElementById('qr').onload = () => { document.body.dataset.ready = '1'; };
  <\/script>
</body></html>`;

const browser = await chromium.launch({
  args: ['--disable-gpu', '--disable-dev-shm-usage'],
  headless: false,
});
const page = await browser.newPage();
await page.setViewportSize({ width: 400, height: 400 });
await page.setContent(html, { waitUntil: 'load' });
await page.waitForFunction(() => document.body.dataset.ready === '1', { timeout: 5000 });

// Method 1: CDP screencast (headed mode has compositor, frames should arrive)
const client = await page.context().newCDPSession(page);
const frames = [];
client.on('Page.screencastFrame', (ev) => {
  frames.push(ev);
  client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
});
await client.send('Page.startScreencast', {
  format: 'jpeg', quality: 85, maxWidth: 400, maxHeight: 400, everyNthFrame: 1,
});
await new Promise(r => setTimeout(r, 1200));
await client.send('Page.stopScreencast').catch(() => {});

console.log('Screencast frames received:', frames.length);
if (frames.length > 0) {
  const frame = frames[frames.length - 1];
  writeFileSync('/test/out/screencast.jpg', Buffer.from(frame.data, 'base64'));
  console.log('screencast frame written, bytes:', frame.data.length);
}

// Method 2: locator.screenshot()
const el = page.locator('#qr');
await el.screenshot({ path: '/test/out/element.png' });
console.log('element.png saved');

// Method 3: full page
await page.screenshot({ path: '/test/out/fullpage.png' });
await browser.close();

// Decode — filter dbus noise
function decode(path) {
  try {
    const out = execSync(`zbarimg --raw -q '${path}' 2>&1`, { encoding: 'utf8' });
    return out.trim().split('\n').filter(l => !l.startsWith('Connection')).join('') || null;
  } catch { return null; }
}

const r = {
  screencast: frames.length ? decode('/test/out/screencast.jpg') : 'no-frames',
  element: decode('/test/out/element.png'),
  fullpage: decode('/test/out/fullpage.png'),
};

console.log('=== B2 QR decode results ===');
console.log('screencast:', r.screencast);
console.log('element:   ', r.element);
console.log('fullpage:  ', r.fullpage);

const pass = r.element === 'webridge-login-test' || r.fullpage === 'webridge-login-test';
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
