// 导入 cookie 的前端预校验（纯函数）。
// 接受浏览器扩展导出的 JSON 数组，或 Playwright storageState 形态 {cookies: [...]}。
// 错误信息里绝不出现 cookie 值：JSON.parse 的原生报错会带上原文片段，所以不透传。

export type CookieItem = Record<string, unknown> & { name: string; value: string }

export type CookieParseResult =
  | { ok: true; cookies: CookieItem[] }
  | { ok: false; error: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseCookieJson(text: string): CookieParseResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, error: '请粘贴 cookie JSON。' }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, error: '不是合法的 JSON。请粘贴扩展导出的完整内容。' }
  }

  const list = isPlainObject(parsed) && Array.isArray(parsed['cookies']) ? parsed['cookies'] : parsed
  if (!Array.isArray(list)) {
    return { ok: false, error: '需要一个 JSON 数组，例如 [{"name": "...", "value": "...", "domain": "..."}]。' }
  }
  if (list.length === 0) return { ok: false, error: '数组是空的，没有可导入的 cookie。' }

  const cookies: CookieItem[] = []
  for (let i = 0; i < list.length; i++) {
    const item: unknown = list[i]
    const n = i + 1
    if (!isPlainObject(item)) return { ok: false, error: `第 ${n} 条不是对象。` }
    const name = item['name']
    if (typeof name !== 'string' || name === '') {
      return { ok: false, error: `第 ${n} 条缺少 name。` }
    }
    if (typeof item['value'] !== 'string') {
      return { ok: false, error: `第 ${n} 条（${name}）缺少 value 或不是字符串。` }
    }
    const domain = item['domain']
    const url = item['url']
    const hasDomain = typeof domain === 'string' && domain !== ''
    const hasUrl = typeof url === 'string' && url !== ''
    if (!hasDomain && !hasUrl) {
      return { ok: false, error: `第 ${n} 条（${name}）缺少 domain。` }
    }
    cookies.push(item as CookieItem)
  }
  return { ok: true, cookies }
}
