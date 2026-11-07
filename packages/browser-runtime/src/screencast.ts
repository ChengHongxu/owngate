// Wraps Page.startScreencast / Page.stopScreencast / Page.captureScreenshot
// for the login flow described in design doc §4.4.3

import type { CDPSession, Page } from 'playwright'
import { PNG } from 'pngjs'
import type { ScreenInput } from './input.js'

// Only look for QR-labelled media. A square logo or an arbitrary canvas is
// not enough evidence, and a whole-page screenshot is never a QR fallback.
const QR_MEDIA_SELECTOR = [
  '[class*="qrcode" i] :is(img, canvas, svg)',
  '[class*="qr-code" i] :is(img, canvas, svg)',
  '[class*="qr_code" i] :is(img, canvas, svg)',
  '[id*="qrcode" i] :is(img, canvas, svg)',
  ':is(img, canvas, svg)[class*="qrcode" i]',
  ':is(img, canvas, svg)[class*="qr-code" i]',
  ':is(img, canvas, svg)[id*="qrcode" i]',
  'img[alt*="二维码"]',
  'img[alt*="QR code" i]',
  ':is(img, canvas, svg)[aria-label*="二维码"]',
].join(', ')
const QR_MIN_SIZE = 64
const QR_MAX_SIZE = 512
const QR_MAX_CANDIDATES = 24
const QR_CAPTURE_BUDGET_MS = 1_500

export interface ScreencastOptions {
  /** JPEG quality, default 80 */
  quality?: number
  // No maxWidth/maxHeight — login phase doesn't downsample
}

export class ScreencastSession {
  private cdp: CDPSession | undefined
  constructor(private readonly page: Page) {}

  async start(
    opts: ScreencastOptions,
    onFrame: (data: string, ts: number) => void,
  ): Promise<void> {
    const quality = opts.quality ?? 80
    const cdp = await this.page.context().newCDPSession(this.page)
    this.cdp = cdp
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality,
      everyNthFrame: 1,
    })
    cdp.on('Page.screencastFrame', (event) => {
      onFrame(event.data, event.metadata.timestamp ?? Date.now())
      const sid: number | undefined = event.sessionId
      if (sid !== undefined) {
        void cdp.send('Page.screencastFrameAck', { sessionId: sid }).catch(() => undefined)
      }
    })
  }

  async stop(): Promise<void> {
    const cdp = this.cdp
    this.cdp = undefined
    if (!cdp) return
    try {
      await cdp.send('Page.stopScreencast')
    } finally {
      await cdp.detach()
    }
  }

  async input(input: ScreenInput): Promise<void> {
    const cdp = this.cdp
    if (!cdp) throw new Error('screencast is not active')
    if (input.type === 'mouse') {
      await cdp.send('Input.dispatchMouseEvent', { type: input.event, x: input.x, y: input.y, button: input.button, buttons: input.buttons, clickCount: input.clickCount })
    } else if (input.type === 'wheel') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY })
    } else if (input.type === 'key') {
      await cdp.send('Input.dispatchKeyEvent', { type: input.event, key: input.key, code: input.code, windowsVirtualKeyCode: input.keyCode, modifiers: input.modifiers, ...(input.event === 'keyDown' && input.text ? { text: input.text } : {}) })
    } else if (input.type === 'text') {
      await cdp.send('Input.insertText', { text: input.text })
    } else {
      await this.page.reload({ timeout: 10_000, waitUntil: 'domcontentloaded' })
    }
  }

  /** A bounded QR element as PNG base64, or null when no visible QR exists.
   * An explicit selector is authoritative: a missing login QR must not be
   * replaced by an unrelated download QR elsewhere on the page. */
  async captureQrSnapshot(selector?: string): Promise<string | null> {
    const deadline = Date.now() + QR_CAPTURE_BUDGET_MS
    let inspected = 0
    const viewport = this.page.viewportSize()
    for (const frame of this.page.frames()) {
      if (Date.now() >= deadline || inspected >= QR_MAX_CANDIDATES) break
      try {
        const candidates = frame.locator(selector ?? QR_MEDIA_SELECTOR)
        const count = Math.min(await candidates.count(), QR_MAX_CANDIDATES - inspected)
        for (let index = 0; index < count; index++) {
          if (Date.now() >= deadline) return null
          inspected++
          const candidate = candidates.nth(index)
          if (!(await candidate.isVisible())) continue
          const box = await candidate.boundingBox({ timeout: 300 })
          if (!box || box.width < QR_MIN_SIZE || box.height < QR_MIN_SIZE ||
              box.width > QR_MAX_SIZE || box.height > QR_MAX_SIZE ||
              box.width / box.height < 0.8 || box.width / box.height > 1.25) continue
          if (viewport && box.width * box.height > viewport.width * viewport.height * 0.6) continue
          // A QR outside the visible page is not part of the login view.
          if (box.x < 0 || box.y < 0 || (viewport &&
              (box.x + box.width > viewport.width || box.y + box.height > viewport.height))) continue
          return await this.captureViewportCrop(box)
        }
      } catch {
        // Login pages replace QR nodes/frames while refreshing a code.
        // A later snapshot retries without exposing the full page.
      }
    }
    return null
  }

  private async captureViewportCrop(box: { x: number; y: number; width: number; height: number }): Promise<string | null> {
    const screenshotViewport = this.page.viewportSize()
    if (!screenshotViewport) return null
    const existing = this.cdp
    const cdp = existing ?? await this.page.context().newCDPSession(this.page)
    try {
      const { cssVisualViewport: viewport } = await cdp.send('Page.getLayoutMetrics')
      if (viewport.clientWidth <= 0 || viewport.clientHeight <= 0 ||
          box.x < 0 || box.y < 0 ||
          box.x + box.width > viewport.clientWidth || box.y + box.height > viewport.clientHeight) return null

      // Chromium also sends the screenshot surface to an active screencast.
      // A clipped Page.captureScreenshot (including locator.screenshot) briefly
      // replaces the full page with a magnified QR in that stream. Capture the
      // unchanged viewport, then crop in Node. The temporary PNG stays in Node;
      // only the QR crop is returned, and no scrolling is needed.
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
      })
      const image = PNG.sync.read(Buffer.from(data, 'base64'))
      // The PNG includes scrollbar pixels; cssVisualViewport excludes them.
      // Using its client size as the scale moves the crop inward whenever a
      // scrollbar is present, cutting off QR finder patterns near the edges.
      const scaleX = image.width / screenshotViewport.width
      const scaleY = image.height / screenshotViewport.height
      const left = Math.floor(box.x * scaleX)
      const top = Math.floor(box.y * scaleY)
      const right = Math.min(image.width, Math.ceil((box.x + box.width) * scaleX))
      const bottom = Math.min(image.height, Math.ceil((box.y + box.height) * scaleY))
      const crop = new PNG({ width: right - left, height: bottom - top })
      PNG.bitblt(image, crop, left, top, crop.width, crop.height, 0, 0)
      return PNG.sync.write(crop).toString('base64')
    } finally {
      if (!existing) await cdp.detach().catch(() => undefined)
    }
  }
}
