// Wraps Page.startScreencast / Page.stopScreencast / Page.captureScreenshot
// for the login flow described in design doc §4.4.3

import type { Page } from 'playwright'

export interface ScreencastOptions {
  /** JPEG quality, default 80 */
  quality?: number
  // No maxWidth/maxHeight — login phase doesn't downsample
}

export class ScreencastSession {
  constructor(private readonly page: Page) {}

  async start(
    opts: ScreencastOptions,
    onFrame: (data: string, ts: number) => void,
  ): Promise<void> {
    const quality = opts.quality ?? 80
    const cdp = await this.page.context().newCDPSession(this.page)
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality,
      everyNthFrame: 1,
    })
    cdp.on('Page.screencastFrame', (event) => {
      onFrame(event.data, event.metadata.timestamp ?? Date.now())
      const sid: number | undefined = event.sessionId
      if (sid !== undefined) {
        void cdp.send('Page.screencastFrameAck', { sessionId: sid })
      }
    })
  }

  async stop(): Promise<void> {
    const cdp = await this.page.context().newCDPSession(this.page)
    await cdp.send('Page.stopScreencast')
  }

  /** High-res QR snapshot: returns PNG base64 */
  async captureQrSnapshot(selector?: string): Promise<string> {
    let buf: Buffer
    if (selector) {
      buf = await this.page.locator(selector).screenshot({ type: 'png' })
    } else {
      buf = await this.page.screenshot({ type: 'png', fullPage: false })
    }
    return buf.toString('base64')
  }
}
