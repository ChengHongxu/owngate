/** The only commands accepted from an authenticated remote-login screen. */
export type ScreenInput =
  | { type: 'mouse'; event: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button: 'left' | 'middle' | 'right' | 'none'; buttons: number; clickCount: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; event: 'keyDown' | 'keyUp'; key: string; code: string; keyCode: number; modifiers: number; text: string }
  | { type: 'text'; text: string }
  | { type: 'reload' }

function number(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/** Rebuild a small, bounded command; never pass caller-provided CDP methods. */
export function parseScreenInput(value: unknown): ScreenInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (input['type'] === 'reload') return { type: 'reload' }
  if (input['type'] === 'text') {
    return typeof input['text'] === 'string' && input['text'].length <= 4096
      ? { type: 'text', text: input['text'] } : undefined
  }
  if (input['type'] === 'mouse' || input['type'] === 'wheel') {
    if (!number(input['x'], 0, 20_000) || !number(input['y'], 0, 20_000)) return undefined
    const x = input['x']
    const y = input['y']
    if (input['type'] === 'wheel') {
      if (!number(input['deltaX'], -10_000, 10_000) || !number(input['deltaY'], -10_000, 10_000)) return undefined
      return { type: 'wheel', x, y, deltaX: input['deltaX'], deltaY: input['deltaY'] }
    }
    const event = input['event']
    if (event !== 'mousePressed' && event !== 'mouseReleased' && event !== 'mouseMoved') return undefined
    const button = input['button'] ?? 'left'
    if (button !== 'left' && button !== 'middle' && button !== 'right' && button !== 'none') return undefined
    const buttons = input['buttons'] ?? 0
    const clickCount = input['clickCount'] ?? 1
    if (!number(buttons, 0, 7) || !Number.isInteger(buttons) || !number(clickCount, 0, 3) || !Number.isInteger(clickCount)) return undefined
    return { type: 'mouse', event, x, y, button, buttons, clickCount }
  }
  if (input['type'] === 'key') {
    const event = input['event']
    if (event !== 'keyDown' && event !== 'keyUp') return undefined
    if (typeof input['key'] !== 'string' || input['key'].length > 64 || typeof input['code'] !== 'string' || input['code'].length > 64) return undefined
    const keyCode = input['keyCode'] ?? 0
    const modifiers = input['modifiers'] ?? 0
    const text = input['text'] ?? ''
    if (!number(keyCode, 0, 255) || !Number.isInteger(keyCode) || !number(modifiers, 0, 15) || !Number.isInteger(modifiers)) return undefined
    if (typeof text !== 'string' || text.length > 16) return undefined
    return { type: 'key', event, key: input['key'], code: input['code'], keyCode, modifiers, text }
  }
  return undefined
}
