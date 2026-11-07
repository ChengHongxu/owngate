import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { PNG } from 'pngjs'
import { ScreencastSession } from '../src/screencast.js'

// These local pages exercise real element geometry, iframe coordinates and
// PNG cropping. Ordinary unit CI has no Chromium; opt in alongside the other
// real-browser checks, without touching a website or a logged-in profile.
describe.runIf(process.env['OWNGATE_REAL_BROWSER_TEST'] === '1')('QR snapshots in real Chromium', () => {
  let browser: Browser
  beforeAll(async () => {
    // Production is headed and reserves real scrollbar gutters. Headless
    // Chromium normally hides them, which would conceal crop-offset errors.
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, ignoreDefaultArgs: ['--hide-scrollbars'] })
  })
  afterAll(async () => { await browser?.close() })

  async function withPage(html: string, check: (page: Page, session: ScreencastSession) => Promise<void>) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    try {
      const page = await context.newPage()
      await page.setContent(html)
      await check(page, new ScreencastSession(page))
    } finally { await context.close() }
  }
  function dimensions(data: string | null) {
    expect(data).not.toBeNull()
    const png = Buffer.from(data!, 'base64')
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  }
  const media = '<canvas class="qrcode" width="120" height="120" style="background:#000"></canvas>'

  it('crops QR-labelled media instead of making a thumbnail of the full page', async () => {
    await withPage(`<body style="background:blue">${media}</body>`, async (_page, session) => {
      expect(dimensions(await session.captureQrSnapshot())).toEqual({ width: 120, height: 120 })
    })
  })

  it('does not label an arbitrary square canvas or logo as a QR code', async () => {
    await withPage('<canvas width="120" height="120"></canvas><img alt="logo" width="128" height="128">', async (_page, session) => {
      expect(await session.captureQrSnapshot()).toBeNull()
    })
  })

  it('does not substitute a download QR when the declared login QR is absent', async () => {
    await withPage(`<div class="download-qrcode">${media}</div>`, async (_page, session) => {
      expect(await session.captureQrSnapshot('.login-qrcode img')).toBeNull()
    })
  })

  it('skips hidden matches and clears a QR that has disappeared', async () => {
    await withPage(`<div hidden>${media}</div>${media}`, async (page, session) => {
      expect(dimensions(await session.captureQrSnapshot())).toEqual({ width: 120, height: 120 })
      await page.evaluate("document.querySelectorAll('canvas')[1].remove()")
      expect(await session.captureQrSnapshot()).toBeNull()
    })
  })

  it('rejects non-square containers and a whole-page selector', async () => {
    await withPage('<div id="qr" style="width:400px;height:100px;background:black"></div>', async (_page, session) => {
      expect(await session.captureQrSnapshot('#qr')).toBeNull()
      expect(await session.captureQrSnapshot('body')).toBeNull()
    })
  })

  it('does not scroll the login page to capture an offscreen QR', async () => {
    await withPage(`<div style="height:1200px"></div>${media}`, async (page, session) => {
      expect(await session.captureQrSnapshot()).toBeNull()
      expect(await page.evaluate('window.scrollY')).toBe(0)
    })
  })

  it('can crop a QR rendered inside an iframe', async () => {
    await withPage(`<iframe style="width:400px;height:300px" srcdoc='${media}'></iframe>`, async (page, session) => {
      await page.frameLocator('iframe').locator('canvas').waitFor()
      expect(dimensions(await session.captureQrSnapshot())).toEqual({ width: 120, height: 120 })
    })
  })

  it('rejects a selector covering nearly the entire small viewport', async () => {
    await withPage('<body style="margin:0;width:320px;height:320px"></body>', async (page, session) => {
      await page.setViewportSize({ width: 320, height: 320 })
      expect(await session.captureQrSnapshot('body')).toBeNull()
    })
  })

  it('preserves every full-page screencast frame while repeatedly taking QR snapshots', async () => {
    await withPage(`<style>
      body { margin: 0; background: rgb(31, 79, 111); }
      canvas { position: absolute; left: 300px; top: 200px; }
      #pulse { width: 10px; height: 10px; animation: pulse 0.1s infinite alternate; }
      @keyframes pulse { from { background: red; } to { background: green; } }
      </style><div id="pulse"></div>${media}`, async (page, session) => {
      const frames: string[] = []
      await session.start({}, data => frames.push(data))
      try {
        await expect.poll(() => frames.length).toBeGreaterThan(0)
        for (let count = 0; count < 5; count++) {
          expect(dimensions(await session.captureQrSnapshot())).toEqual({ width: 120, height: 120 })
          await page.waitForTimeout(80)
        }
        expect(frames.length).toBeGreaterThanOrEqual(5)
      } finally {
        await session.stop()
      }

      // Decode the JPEG pixels in another page, never inside the producing
      // page or using the stream metadata (which stays full-size in the bug).
      const decoder = await browser.newPage()
      try {
        const decoded = await decoder.evaluate<Array<{ width: number; height: number; sample: number[] }>>(`(async frames => Promise.all(frames.map(async data => {
          const image = new Image(); image.src = 'data:image/jpeg;base64,' + data; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          return { width: image.width, height: image.height, sample: [...context.getImageData(1000, 600, 1, 1).data] };
        })))(${JSON.stringify(frames)})`)
        for (const frame of decoded) {
          expect({ width: frame.width, height: frame.height }).toEqual({ width: 1280, height: 800 })
          expect(frame.sample[0]).toBeCloseTo(31, -1)
          expect(frame.sample[1]).toBeCloseTo(79, -1)
          expect(frame.sample[2]).toBeCloseTo(111, -1)
          expect(frame.sample[3]).toBe(255)
        }
      } finally {
        await decoder.close()
      }
    })
  })

  it('crops viewport pixels with page and iframe scroll at a higher device scale without moving focus', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
    try {
      const page = await context.newPage()
      await page.setContent(`<body style="margin:0;background:blue"><input id="entry"><div style="height:100px"></div><iframe style="width:400px;height:300px" srcdoc='<div style="height:200px"></div>${media}<div style="height:300px"></div>'></iframe><div style="height:1500px"></div></body>`)
      await page.frameLocator('iframe').locator('canvas').waitFor()
      const frame = page.frames().find(candidate => candidate !== page.mainFrame())!
      await frame.evaluate('window.scrollTo(0, 180)')
      await page.locator('#entry').focus()
      await page.evaluate('window.scrollTo(0, 50)')
      const cdp = await context.newCDPSession(page)
      const { data: viewportData } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
      await cdp.detach()
      const viewportImage = PNG.sync.read(Buffer.from(viewportData, 'base64'))
      const snapshot = await new ScreencastSession(page).captureQrSnapshot()
      expect(dimensions(snapshot)).toEqual({ width: 120 * viewportImage.width / 1280, height: 120 * viewportImage.height / 800 })
      const image = PNG.sync.read(Buffer.from(snapshot!, 'base64'))
      expect([...image.data.subarray(0, 4)]).toEqual([0, 0, 0, 255])
      expect(await page.evaluate('window.scrollY')).toBe(50)
      expect(await frame.evaluate('window.scrollY')).toBe(180)
      expect(await page.evaluate('document.activeElement.id')).toBe('entry')
    } finally {
      await context.close()
    }
  })

  const scrollCases = [1, 2].flatMap(deviceScaleFactor => (
    ['none', 'vertical', 'horizontal', 'both'] as const
  ).map(scrollbars => ({ deviceScaleFactor, scrollbars })))

  it.each(scrollCases)('keeps every QR edge with $scrollbars scrollbars at device scale $deviceScaleFactor', async ({ deviceScaleFactor, scrollbars }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor })
    try {
      const vertical = scrollbars === 'vertical' || scrollbars === 'both'
      const horizontal = scrollbars === 'horizontal' || scrollbars === 'both'
      const page = await context.newPage()
      // Different colours on all four edges detect coordinate drift that a
      // solid black rectangle or successful QR decoding alone would miss.
      await page.setContent(`<style>
        html { overflow-x: ${horizontal ? 'scroll' : 'hidden'}; overflow-y: ${vertical ? 'scroll' : 'hidden'}; }
        body { margin: 0; background: rgb(31, 79, 111); width: ${horizontal ? '1600px' : 'auto'}; height: ${vertical ? '1600px' : 'auto'}; }
        canvas { position: absolute; left: 354.25px; top: 270.375px; width: 200.5px; height: 200.5px; }
      </style><canvas id="qr" class="qrcode" width="200" height="200"></canvas>`)
      await page.evaluate(`(() => {
        const ctx = document.querySelector('canvas').getContext('2d')
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 200, 200)
        ctx.fillStyle = 'black'
        for (let y = 8; y < 192; y += 8) for (let x = 8; x < 192; x += 8) {
          if ((x + y) % 24 === 0) ctx.fillRect(x, y, 8, 8)
        }
        ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 4, 200)
        ctx.fillStyle = 'lime'; ctx.fillRect(0, 0, 200, 4)
        ctx.fillStyle = 'blue'; ctx.fillRect(196, 0, 4, 200)
        ctx.fillStyle = 'magenta'; ctx.fillRect(0, 196, 200, 4)
      })()`)
      const cdp = await context.newCDPSession(page)
      try {
        const { cssVisualViewport } = await cdp.send('Page.getLayoutMetrics')
        expect(1280 - cssVisualViewport.clientWidth).toBe(vertical ? 15 : 0)
        expect(800 - cssVisualViewport.clientHeight).toBe(horizontal ? 15 : 0)
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
        const full = PNG.sync.read(Buffer.from(data, 'base64'))
        const box = (await page.locator('canvas').boundingBox())!
        // The reference uses the configured complete 1280×800 viewport,
        // including gutters, and fractional CSS bounds painted in that image.
        const left = Math.floor(box.x * full.width / 1280)
        const top = Math.floor(box.y * full.height / 800)
        const right = Math.ceil((box.x + box.width) * full.width / 1280)
        const bottom = Math.ceil((box.y + box.height) * full.height / 800)
        const expected = new PNG({ width: right - left, height: bottom - top })
        PNG.bitblt(full, expected, left, top, expected.width, expected.height, 0, 0)
        const visibleColors = new Set<string>()
        for (let index = 0; index < expected.data.length; index += 4) {
          visibleColors.add([...expected.data.subarray(index, index + 4)].join(','))
        }
        for (const color of ['255,0,0,255', '0,255,0,255', '0,0,255,255', '255,0,255,255']) {
          expect(visibleColors.has(color)).toBe(true)
        }
        const snapshot = await new ScreencastSession(page).captureQrSnapshot('#qr')
        const actual = PNG.sync.read(Buffer.from(snapshot!, 'base64'))
        expect({ width: actual.width, height: actual.height }).toEqual({ width: expected.width, height: expected.height })
        expect(actual.data.equals(expected.data)).toBe(true)
      } finally { await cdp.detach() }
    } finally { await context.close() }
  })

  it('does not expose QR pixels hidden behind the viewport scrollbars', async () => {
    await withPage(`<style>html { overflow: scroll; } body { margin: 0; width: 1600px; height: 1600px; }
      canvas { position: absolute; width: 120px; height: 120px; background: black; }
      #right { left: 1150px; top: 100px; } #bottom { left: 100px; top: 670px; }
      </style><canvas id="right" class="qrcode"></canvas><canvas id="bottom" class="qrcode"></canvas>`, async (_page, session) => {
      expect(await session.captureQrSnapshot('#right')).toBeNull()
      expect(await session.captureQrSnapshot('#bottom')).toBeNull()
    })
  })
})
