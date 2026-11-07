import type { BrowserContext, Page, Response } from 'playwright'
import { detectAuthFailure } from '@owngate/browser-runtime'
import type { FieldMeta } from '@owngate/core'
import { authFailureResult, type ExecResult } from '../exec.js'
import { classifyError, workerError } from '../errors.js'
import { normalizeFeed, normalizeProfile } from './normalize.js'
import { at, object, type ItemError, type Platform, type SocialFeedItem } from './types.js'
import type { BrowserDiagnostics } from '../diagnostics.js'

export const SOCIAL_PLATFORMS = ['bilibili', 'xiaohongshu', 'zhihu', 'x'] as const
const SITE: Record<Platform, string> = { bilibili: 'https://www.bilibili.com/', xiaohongshu: 'https://www.xiaohongshu.com/explore', zhihu: 'https://www.zhihu.com/', x: 'https://x.com/home' }
const MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_RESPONSES = 12
export interface CaptureOptions { scrollWaitMs?: number; maxScrolls?: number }

function responseExpectation(platform: Platform, capability: string, source: unknown): string {
  if (platform === 'bilibili') {
    const path = capability === 'account.profile' ? '/x/web-interface/nav'
      : capability === 'history.list' ? '/x/web-interface/history/cursor'
      : capability === 'watchlater.list' ? '/x/v2/history/toview/web'
      : source === 'following' ? '/x/polymer/web-dynamic/v1/feed/all' : '/x/web-interface/wbi/index/top/feed/rcmd'
    return `未匹配预期接口 ${path} 的响应`
  }
  return '页面已访问，但没有捕获到此能力可识别的站点响应'
}

function endpoint(platform: Platform, capability: string, source: string, response: Response, ownHandle?: string): boolean {
  let url: URL
  try { url = new URL(response.url()) } catch { return false }
  if (platform === 'bilibili') {
    if (url.hostname !== 'api.bilibili.com') return false
    const expected = capability === 'account.profile' ? '/x/web-interface/nav' : capability === 'history.list' ? '/x/web-interface/history/cursor' : capability === 'watchlater.list' ? '/x/v2/history/toview' : source === 'following' ? '/x/polymer/web-dynamic/v1/feed/all' : '/x/web-interface/wbi/index/top/feed/rcmd'
    return url.pathname === expected || capability === 'watchlater.list' && url.pathname === expected + '/web'
      || capability === 'feed.list' && source === 'recommended' && url.pathname === '/x/web-interface/index/top/feed/rcmd'
  }
  if (platform === 'xiaohongshu') {
    if (url.hostname !== 'edith.xiaohongshu.com' && url.hostname !== 'www.xiaohongshu.com') return false
    if (capability === 'account.profile') return ['/api/sns/web/v1/user/selfinfo', '/api/sns/web/v2/user/me'].includes(url.pathname)
    if (url.pathname !== '/api/sns/web/v1/homefeed') return false
    if (source === 'following') {
      try { return /follow/.test(String(object(response.request().postDataJSON())['category'] ?? '')) } catch { return false }
    }
    return true
  }
  if (platform === 'zhihu') {
    if (url.hostname !== 'www.zhihu.com') return false
    if (capability === 'account.profile') return url.pathname === '/api/v4/me'
    return source === 'following' ? ['/api/v3/feed/following', '/api/v3/moments', '/api/v4/moments'].includes(url.pathname) : url.pathname === '/api/v3/feed/topstory/recommend'
  }
  if (url.hostname !== 'x.com' && url.hostname !== 'api.x.com' && url.hostname !== 'twitter.com' && url.hostname !== 'api.twitter.com') return false
  if (capability !== 'account.profile') return url.pathname.endsWith('/' + (source === 'following' ? 'HomeLatestTimeline' : 'HomeTimeline'))
  if (url.pathname.endsWith('/Viewer')) return true
  if (!ownHandle || !url.pathname.endsWith('/UserByScreenName')) return false
  try { return String(object(JSON.parse(url.searchParams.get('variables') ?? '{}'))['screen_name']).toLowerCase() === ownHandle.toLowerCase() } catch { return false }
}

function siteFailure(platform: Platform, body: unknown, status: number): ExecResult | null {
  const code = at(body, 'code'), errors = at(body, 'errors')
  if (status === 429) return { status: 'error', error: { ...workerError('RATE_LIMITED', '站点已限制请求频率', '停止请求，等待后人工检查'), retryable: false }, meta: { connection_status: 'paused' } }
  if ([412, 418, 461, 471].includes(status) || [-412, -352, 300012, 300013].includes(code as number) || Array.isArray(errors) && errors.some(entry => [226, 326].includes(Number(at(entry, 'code'))))) return authFailureResult({ code: 'RISK_CONTROL_DETECTED', what_happened: '站点响应要求安全验证或账号受限' })
  if ([401, 403].includes(status) || code === -101 || platform === 'bilibili' && at(body, 'data', 'isLogin') === false || platform === 'xiaohongshu' && [-100, -101].includes(code as number) || Array.isArray(errors) && errors.some(entry => [32, 89, 215].includes(Number(at(entry, 'code'))))) return authFailureResult({ code: 'LOGIN_REQUIRED', what_happened: '站点未接受当前登录态' })
  if (status < 200 || status >= 300) return { status: 'error', error: workerError('UPSTREAM_ERROR', `站点响应 HTTP ${status}`, '稍后人工检查站点状态') }
  if (platform === 'bilibili' && code !== 0 || platform === 'xiaohongshu' && at(body, 'success') === false || Array.isArray(errors) && errors.length > 0) return { status: 'error', error: workerError('UPSTREAM_ERROR', '站点响应未确认请求成功', '检查站点页面；若持续发生请更新适配器') }
  return null
}

export async function captureSocial(context: BrowserContext, platform: Platform, capability: string, params: Record<string, unknown>, deadlineMs: number, signal?: AbortSignal, options: CaptureOptions = {}, diagnostics?: BrowserDiagnostics): Promise<ExecResult> {
  const supported = capability === 'account.profile' || capability === 'feed.list' || platform === 'bilibili' && ['history.list', 'watchlater.list'].includes(capability)
  if (!supported) return { status: 'error', error: workerError('CAPABILITY_UNSUPPORTED', '该平台尚未实现此浏览器能力', '选择已实现的只读能力') }
  const extra = Object.keys(params).filter(key => !['limit', 'source'].includes(key))
  const limit = params['limit'] ?? 20
  const source = params['source'] ?? (platform === 'bilibili' ? 'following' : 'recommended')
  if (extra.length || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100 || !['following', 'recommended'].includes(String(source))) return { status: 'error', error: workerError('INVALID_PARAMS', '只接受limit（1–100整数）和source（following/recommended）', '检查能力输入') }
  signal?.throwIfAborted()
  const authChecked = diagnostics?.start('browser.auth', '检查当前页面状态')
  const current = context.pages()[0]
  if (current) {
    const failure = await detectAuthFailure(current)
    if (failure && failure.code !== 'LOGIN_REQUIRED') {
      authChecked?.('error', '当前页面要求人工处理验证或账号状态', failure.code)
      return authFailureResult(failure)
    }
    if (failure?.code === 'LOGIN_REQUIRED') {
      const cookieNames: Record<Platform, string[]> = { bilibili: ['SESSDATA'], xiaohongshu: ['web_session'], zhihu: ['z_c0'], x: ['auth_token'] }
      if (!(await context.cookies(SITE[platform])).some(cookie => cookieNames[platform].includes(cookie.name))) {
        authChecked?.('error', '当前页面要求登录，且缺少此站点的登录标记', failure.code)
        return authFailureResult(failure)
      }
    }
  }
  const page = await context.newPage()
  const initialFailure = await detectAuthFailure(page)
  if (initialFailure) {
    authChecked?.('error', '页面要求人工处理登录或验证', initialFailure.code)
    await page.close().catch(() => undefined)
    return authFailureResult(initialFailure)
  }
  authChecked?.('success', '未发现需要人工处理的页面拦截提示')
  const deadline = Date.now() + deadlineMs
  let ownHandle: string | undefined
  let profile: ReturnType<typeof normalizeProfile> | undefined
  let failure: ExecResult | undefined
  let navigationFailed = false
  let captures = 0, readFailures = 0, parsed = 0, rawOffset = 0, pending = 0
  let collecting = true
  let nextCursor: string | null = null, hasMore: boolean | null = null
  const items: SocialFeedItem[] = [], fields: Record<string, FieldMeta> = {}, itemErrors: ItemError[] = [], warnings: string[] = [], seen = new Set<string>()
  const navigationDone = diagnostics?.start('browser.navigate', '访问能力页面')
  const captureDone = diagnostics?.start('browser.capture', '捕获预期站点响应')
  let parseDone: ReturnType<BrowserDiagnostics['start']> | undefined
  const statuses = new Set<number>()
  const remaining = () => Math.max(1, deadline - Date.now())
  const receive = (response: Response) => {
    if (captures >= MAX_RESPONSES || !endpoint(platform, capability, String(source), response, ownHandle)) return
    captures++; pending++
    statuses.add(response.status())
    void (async () => {
      let bodyReady = false
      try {
        if (Number(response.headers()['content-length'] ?? 0) > MAX_BODY_BYTES) throw new Error('响应体超出5MiB限制')
        const bytes = await response.body()
        if (!collecting) return
        if (bytes.length > MAX_BODY_BYTES) throw new Error('响应体超出5MiB限制')
        bodyReady = true
        parseDone ??= diagnostics?.start('browser.parse', '解析站点响应')
        const body: unknown = JSON.parse(bytes.toString('utf8'))
        const error = siteFailure(platform, body, response.status())
        if (error) { failure = error; return }
        if (capability === 'account.profile') { profile = normalizeProfile(platform, body); parsed++; return }
        const batch = normalizeFeed(platform, body, capability as 'feed.list' | 'history.list' | 'watchlater.list')
        parsed++
        for (const entry of batch.items) {
          if (items.length >= limit || seen.has(entry.data.id)) continue
          const index = items.length; seen.add(entry.data.id); items.push(entry.data)
          for (const [path, meta] of Object.entries(entry.fields)) fields[`items.${index}.${path}`] = meta
        }
        itemErrors.push(...batch.errors.map(error => ({ ...error, index: error.index + rawOffset })))
        rawOffset += batch.items.length + batch.errors.length
        nextCursor = batch.nextCursor; hasMore = batch.hasMore
      } catch (error) {
        // A failed response cannot turn a second response with valid items into
        // an apparent complete success. Raw body text is never logged/returned.
        if (collecting) {
          if (!bodyReady) readFailures++
          warnings.push(error instanceof SyntaxError ? '站点响应不是有效JSON' : error instanceof Error ? error.message : '站点响应无法解析')
        }
      } finally { pending-- }
    })()
  }
  page.on('response', receive)
  const checkPage = async () => {
    const found = await detectAuthFailure(page)
    if (found) {
      if (!failure) diagnostics?.start('browser.blocked', '检查页面验证状态')('error', '站点页面要求人工处理登录或安全验证', found.code)
      failure = authFailureResult(found)
    }
  }
  const wait = async (ms: number) => {
    const end = Math.min(deadline, Date.now() + ms)
    while (Date.now() < end && !failure && !profile && items.length < limit) {
      signal?.throwIfAborted()
      if (parsed > 0 && pending === 0 && hasMore === false) break
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, end - Date.now()))))
    }
  }
  const abort = () => { void page.close().catch(() => undefined) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    let destination = SITE[platform]
    if (platform === 'bilibili' && capability === 'feed.list' && source === 'following') destination = 'https://t.bilibili.com/'
    if (platform === 'bilibili' && capability === 'history.list') destination = 'https://www.bilibili.com/account/history'
    if (platform === 'bilibili' && capability === 'watchlater.list') destination = 'https://www.bilibili.com/watchlater/'
    if (platform === 'zhihu' && source === 'following' && capability === 'feed.list') destination = 'https://www.zhihu.com/follow'
    try {
      const document = await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: remaining() })
      if (document && document.status() >= 400) {
        navigationFailed = true
        failure = siteFailure(platform, {}, document.status())!
        navigationDone?.('error', `站点页面返回 HTTP ${document.status()}`, failure.error?.code)
        return failure
      }
      navigationDone?.('success', '已访问此能力对应的站点页面')
    } catch {
      signal?.throwIfAborted()
      navigationDone?.('partial', '页面加载未完成，继续检查已收到的响应')
      warnings.push('页面未能完整加载，仅返回已截获内容')
    }
    await checkPage()
    if (!failure && platform === 'x' && capability === 'account.profile' && !profile) {
      const link = page.locator('[data-testid="AppTabBar_Profile_Link"]')
      const href = await link.getAttribute('href', { timeout: Math.min(3000, remaining()) })
      const match = /^\/([A-Za-z0-9_]{1,15})$/.exec(href ?? '')
      if (!match) throw new Error('无法确认当前账号的个人主页入口')
      ownHandle = match[1]
      await page.goto('https://x.com/' + ownHandle, { waitUntil: 'domcontentloaded', timeout: remaining() })
    }
    if (!failure && capability === 'feed.list' && platform === 'x') {
      const name = source === 'following' ? /^(Following|正在关注|关注)$/ : /^(For you|For You|为你推荐|推荐)$/
      await page.getByRole('tab', { name }).first().click({ timeout: Math.min(3000, remaining()) })
    }
    if (!failure && capability === 'feed.list' && platform === 'xiaohongshu' && source === 'following') await page.getByText('关注', { exact: true }).first().click({ timeout: Math.min(3000, remaining()) })
    const maxScrolls = capability === 'account.profile' ? 0 : options.maxScrolls ?? 6
    const scrollWait = options.scrollWaitMs ?? 1500
    await wait(Math.min(3000, remaining()))
    for (let scroll = 0; scroll < maxScrolls && !failure && !profile && items.length < limit && Date.now() < deadline && hasMore !== false; scroll++) {
      await checkPage()
      if (failure) break
      await page.mouse.wheel(0, 700)
      await wait(scrollWait + (options.scrollWaitMs === undefined ? Math.floor(Math.random() * 500) : 0))
    }
    while (pending > 0 && Date.now() < deadline) { signal?.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 20)) }
    signal?.throwIfAborted()
    await checkPage()
    if (failure) return failure
    if (profile) return { status: 'ok', data: profile.data, fields: profile.fields, ...(Object.values(profile.fields).some(meta => meta.status !== 'ok') ? { partial: true } : {}), ...(warnings.length ? { warnings } : {}) }
    if (!parsed || items.length === 0 && itemErrors.length > 0) {
      failure = { status: 'error', error: workerError('PARSE_FAILED', captures ? '已截获响应，但结构或条目无法可靠解析' : '页面未发出已知的账号或信息流响应', '检查正常站点页面；保存脱敏HAR用于更新适配器'), warnings, item_errors: itemErrors }
      return failure
    }
    if (hasMore === null) fields['has_more'] = { status: 'unknown', reason: '站点未提供可靠分页终态' }
    if (itemErrors.length) warnings.push(`${itemErrors.length}个条目解析失败，已逐条列出原因`)
    if (items.length < limit && hasMore !== false) warnings.push('已达到本次滚动或等待上限，信息流可能尚未取全')
    const partial = warnings.length > 0 || itemErrors.length > 0 || Object.values(fields).some(meta => meta.status !== 'ok')
    return { status: 'ok', data: { items, next_cursor: nextCursor, has_more: hasMore }, fields, warnings, item_errors: itemErrors, ...(partial ? { partial: true } : {}) }
  } catch (error) {
    signal?.throwIfAborted()
    failure ??= { status: 'error', error: workerError('PARSE_FAILED', error instanceof Error ? error.message : '社交页面无法读取', '人工检查站点页面；不要自动重试风控或验证码'), warnings }
    return failure
  } finally {
    // Closing an aborted page can reject navigation before withDeadline's
    // catch runs. Preserve the actual interruption cause at this boundary.
    if (signal?.aborted) diagnostics?.interrupt(classifyError(signal.reason, 'BROWSER_UNAVAILABLE'))
    const code = failure?.error?.code
    navigationDone?.('error', '页面访问或操作未能完成', code ?? 'PARSE_FAILED')
    captureDone?.(captures > 0 ? readFailures === captures ? 'error' : readFailures ? 'partial' : 'success' : navigationFailed ? 'skipped' : 'error', captures > 0
      ? `已匹配 ${captures} 个响应，HTTP ${[...statuses].sort().join('、')}${readFailures ? `；${readFailures} 个响应体无法读取` : ''}`
      : navigationFailed ? '页面未能加载，停止等待接口响应' : responseExpectation(platform, capability, source), readFailures ? 'PARSE_FAILED' : captures > 0 || navigationFailed ? undefined : code ?? 'PARSE_FAILED')
    const unknown = Object.values(fields).filter(field => field.status !== 'ok').length
    parseDone?.(failure ? 'error' : itemErrors.length || warnings.length || unknown ? 'partial' : 'success', failure
      ? '站点响应未通过状态或结构检查'
      : profile ? '账号响应已通过结构检查'
      : `保留 ${items.length} 条内容；${itemErrors.length} 条无法解析，${unknown} 个字段未知`, code)
    collecting = false
    page.off('response', receive)
    signal?.removeEventListener('abort', abort)
    await page.close().catch(() => undefined)
  }
}
