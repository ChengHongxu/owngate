import { at, count, finish, id, metrics, object, plain, text, timestamp, url, type NormalizedItem, type Platform, type SocialBatch, type SocialFeedItem } from './types.js'

function base(platform: Platform, itemId: string, link: string, kind: SocialFeedItem['kind'], authorId: unknown, authorName: unknown, published: unknown): SocialFeedItem {
  return { platform, id: itemId, url: link, kind, author: { id: id(authorId), name: text(authorName) }, media: [], published_at: timestamp(published), metrics: {} }
}
function image(item: SocialFeedItem, value: unknown): void { const link = url(value); if (link) item.media.push({ type: 'image', url: link }) }
function content(item: SocialFeedItem, title: unknown, body?: unknown): void {
  const heading = plain(title), description = plain(body)
  if (heading !== null) item.title = heading
  if (description !== null) item.text = description
}
function bili(raw: unknown): NormalizedItem {
  const entry = object(raw), dynamic = object(at(entry, 'modules', 'module_dynamic'))
  const archive = object(at(dynamic, 'major', 'archive'))
  const author = object(at(entry, 'modules', 'module_author'))
  const isDynamic = Object.keys(dynamic).length > 0
  const itemId = id(isDynamic ? entry['id_str'] : entry['bvid'] ?? entry['aid'] ?? at(entry, 'history', 'bvid'))
  if (!itemId) throw new Error('B站条目缺少动态ID或视频ID')
  if (isDynamic) {
    const video = text(archive['bvid'])
    const item = base('bilibili', itemId, video ? `https://www.bilibili.com/video/${encodeURIComponent(video)}` : `https://t.bilibili.com/${encodeURIComponent(itemId)}`, video ? 'video' : 'post', author['mid'], author['name'], author['pub_ts'])
    content(item, archive['title'], at(dynamic, 'desc', 'text'))
    image(item, archive['cover'])
    const draws = at(dynamic, 'major', 'draw', 'items')
    if (Array.isArray(draws)) for (const draw of draws) image(item, at(draw, 'src'))
    item.metrics = metrics({ likes: at(entry, 'modules', 'module_stat', 'like', 'count'), comments: at(entry, 'modules', 'module_stat', 'comment', 'count'), shares: at(entry, 'modules', 'module_stat', 'forward', 'count') })
    return finish(item)
  }
  const bvid = text(entry['bvid']) ?? text(at(entry, 'history', 'bvid'))
  const aid = id(entry['aid'])
  if (!bvid && !aid) throw new Error('B站视频条目缺少BV或AV标识')
  const item = base('bilibili', itemId, `https://www.bilibili.com/video/${encodeURIComponent(bvid ?? 'av' + aid)}`, 'video', at(entry, 'owner', 'mid') ?? entry['author_mid'], at(entry, 'owner', 'name') ?? entry['author_name'], entry['pubdate'] ?? entry['ctime'])
  content(item, entry['title'], entry['desc'])
  image(item, entry['pic'] ?? entry['cover'])
  item.metrics = metrics({ likes: at(entry, 'stat', 'like'), comments: at(entry, 'stat', 'reply'), shares: at(entry, 'stat', 'share'), views: at(entry, 'stat', 'view') })
  return finish(item)
}
function xhs(raw: unknown): NormalizedItem {
  const entry = object(raw), card = object(entry['note_card'] ?? entry['noteCard'] ?? entry)
  const noteId = id(entry['id'] ?? entry['note_id'] ?? card['note_id'])
  if (!noteId) throw new Error('小红书条目缺少笔记ID')
  const user = object(card['user']), info = object(card['interact_info'] ?? card['interactInfo'])
  const item = base('xiaohongshu', noteId, `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`, card['type'] === 'video' ? 'video' : 'note', user['user_id'] ?? user['userId'], user['nickname'] ?? user['nick_name'], card['time'] ?? card['publish_time'])
  content(item, card['display_title'] ?? card['title'], card['desc'])
  image(item, at(card, 'cover', 'url_default') ?? at(card, 'cover', 'urlDefault') ?? at(card, 'cover', 'url'))
  const images = card['image_list']
  if (Array.isArray(images)) for (const entry of images) image(item, at(entry, 'url_default') ?? at(entry, 'url'))
  item.metrics = metrics({ likes: info['liked_count'] ?? info['likedCount'], comments: info['comment_count'], shares: info['share_count'], views: info['view_count'] })
  return finish(item)
}
function zhihu(raw: unknown): NormalizedItem {
  const wrapper = object(raw), entry = object(wrapper['target'] ?? wrapper)
  const type = text(entry['type']), itemId = id(entry['id'])
  if (!itemId || !['answer', 'article', 'zvideo', 'pin'].includes(type ?? '')) throw new Error('知乎条目缺少可识别的内容类型或ID')
  const questionId = id(at(entry, 'question', 'id'))
  let link = type === 'answer' && questionId ? `https://www.zhihu.com/question/${questionId}/answer/${itemId}` : type === 'article' ? `https://zhuanlan.zhihu.com/p/${itemId}` : type === 'zvideo' ? `https://www.zhihu.com/zvideo/${itemId}` : `https://www.zhihu.com/pin/${itemId}`
  if (type === 'answer' && !questionId) {
    const supplied = url(entry['url'])
    if (!supplied || new URL(supplied).hostname !== 'www.zhihu.com' || !/^\/question\/\d+\/answer\/\d+/.test(new URL(supplied).pathname)) throw new Error('知乎回答缺少question ID，不能构造真实网页链接')
    link = supplied
  }
  const item = base('zhihu', itemId, link, type === 'answer' ? 'answer' : type === 'article' ? 'article' : type === 'zvideo' ? 'video' : 'post', at(entry, 'author', 'id'), at(entry, 'author', 'name'), entry['created_time'] ?? entry['created'] ?? entry['published_time'])
  content(item, entry['title'] ?? at(entry, 'question', 'title'), entry['excerpt'] ?? entry['content'])
  image(item, entry['image_url'] ?? entry['thumbnail'])
  item.metrics = metrics({ likes: entry['voteup_count'] ?? entry['like_count'], comments: entry['comment_count'], shares: entry['share_count'], views: entry['view_count'] })
  return finish(item)
}
function unwrapTweet(value: unknown): Record<string, unknown> {
  let tweet = object(value)
  if (tweet['__typename'] === 'TweetWithVisibilityResults') tweet = object(tweet['tweet'])
  return tweet
}
function tweet(raw: unknown): NormalizedItem {
  const entry = unwrapTweet(raw), legacy = object(entry['legacy'])
  const itemId = id(entry['rest_id'] ?? legacy['id_str'])
  if (!itemId || !text(legacy['full_text'])) throw new Error('X条目缺少可见的推文ID或正文')
  const user = object(at(entry, 'core', 'user_results', 'result')), userLegacy = object(user['legacy'])
  const handle = text(at(user, 'core', 'screen_name')) ?? text(userLegacy['screen_name'])
  const item = base('x', itemId, `https://x.com/${handle ? encodeURIComponent(handle) : 'i/web'}/status/${encodeURIComponent(itemId)}`, 'post', user['rest_id'], at(user, 'core', 'name') ?? userLegacy['name'], legacy['created_at'])
  content(item, undefined, at(entry, 'note_tweet', 'note_tweet_results', 'result', 'text') ?? legacy['full_text'])
  const media = at(legacy, 'extended_entities', 'media') ?? at(legacy, 'entities', 'media')
  if (Array.isArray(media)) for (const attachment of media) image(item, at(attachment, 'media_url_https'))
  item.metrics = metrics({ likes: legacy['favorite_count'], comments: legacy['reply_count'], shares: legacy['retweet_count'], views: at(entry, 'views', 'count') })
  return finish(item)
}
function xTimeline(body: unknown): { entries: unknown[]; next: string | null; more: boolean | null } {
  const instructions = at(body, 'data', 'home', 'home_timeline_urt', 'instructions') ?? at(body, 'data', 'home', 'home_timeline_urt', 'instructions') ?? at(body, 'data', 'user', 'result', 'timeline_v2', 'timeline', 'instructions')
  if (!Array.isArray(instructions)) throw new Error('X响应缺少已知timeline instructions')
  const entries: unknown[] = []; let next: string | null = null
  const inspect = (entry: unknown) => {
    const content = object(at(entry, 'content'))
    if (content['cursorType'] === 'Bottom') { next = text(content['value']); return }
    const result = at(content, 'itemContent', 'tweet_results', 'result')
    if (result) entries.push(result)
    const moduleItems = content['items']
    if (Array.isArray(moduleItems)) for (const item of moduleItems) { const result = at(item, 'item', 'itemContent', 'tweet_results', 'result'); if (result) entries.push(result) }
    // Explicit unavailable/tombstone posts count as malformed entries rather
    // than being silently converted to an empty timeline.
    if (at(content, 'itemContent', 'tweetDisplayType') && !result) entries.push({})
  }
  for (const instruction of instructions) {
    const list = at(instruction, 'entries')
    if (Array.isArray(list)) for (const entry of list) inspect(entry)
    const entry = at(instruction, 'entry'); if (entry) inspect(entry)
  }
  return { entries, next, more: next !== null ? true : null }
}

/** Only known response structures are accepted; no deep search that can mistake
 * an ad, recommendation module, or another user's profile for the account. */
export function normalizeFeed(platform: Platform, body: unknown, mode: 'feed.list' | 'history.list' | 'watchlater.list' = 'feed.list'): SocialBatch {
  let entries: unknown, next: string | null = null, more: boolean | null = null
  if (platform === 'bilibili') {
    entries = mode === 'history.list' ? at(body, 'data', 'list') : mode === 'watchlater.list' ? at(body, 'data', 'list') : at(body, 'data', 'items') ?? at(body, 'data', 'item')
    next = id(at(body, 'data', 'offset')) ?? id(at(body, 'data', 'cursor', 'max'))
    const hasMore = at(body, 'data', 'has_more')
    if (typeof hasMore === 'boolean') more = hasMore
  } else if (platform === 'xiaohongshu') {
    entries = at(body, 'data', 'items')
    next = text(at(body, 'data', 'cursor_score')) ?? text(at(body, 'data', 'cursor'))
    const hasMore = at(body, 'data', 'has_more'); if (typeof hasMore === 'boolean') more = hasMore
  } else if (platform === 'zhihu') {
    entries = at(body, 'data')
    const paging = object(at(body, 'paging'))
    if (typeof paging['is_end'] === 'boolean') more = !paging['is_end']
    next = text(paging['next'])
    if (next && more === false) next = null
  } else {
    const timeline = xTimeline(body); entries = timeline.entries; next = timeline.next; more = timeline.more
  }
  if (!Array.isArray(entries)) throw new Error(`${platform}响应缺少已知条目数组`)
  const items: NormalizedItem[] = [], errors: SocialBatch['errors'] = []
  entries.forEach((entry, index) => {
    try { items.push(platform === 'bilibili' ? bili(entry) : platform === 'xiaohongshu' ? xhs(entry) : platform === 'zhihu' ? zhihu(entry) : tweet(entry)) }
    catch (error) { errors.push({ index, code: 'ITEM_PARSE_FAILED', reason: error instanceof Error ? error.message : 'unrecognized item' }) }
  })
  return { items, errors, nextCursor: more === false ? null : next, hasMore: more }
}

export function normalizeProfile(platform: Platform, body: unknown): { data: Record<string, unknown>; fields: Record<string, import('@owngate/core').FieldMeta> } {
  let uid: unknown, nickname: unknown, face: unknown
  if (platform === 'bilibili') {
    const data = object(at(body, 'data'))
    if (data['isLogin'] !== true) throw new Error('account response is not logged in')
    uid = data['mid']; nickname = data['uname']; face = data['face']
  } else if (platform === 'xiaohongshu') {
    const data = object(at(body, 'data')), basic = object(data['basic_info'] ?? data)
    uid = data['user_id'] ?? data['userid'] ?? basic['user_id']; nickname = basic['nickname']; face = basic['images'] ?? basic['image'] ?? basic['imageb']
  } else if (platform === 'zhihu') {
    uid = at(body, 'id'); nickname = at(body, 'name'); face = at(body, 'avatar_url')
  } else {
    const data = object(at(body, 'data', 'viewer', 'user_results', 'result') ?? at(body, 'data', 'viewer') ?? at(body, 'data', 'user', 'result'))
    uid = data['rest_id'] ?? at(data, 'legacy', 'id_str'); nickname = at(data, 'core', 'name') ?? at(data, 'legacy', 'name'); face = at(data, 'avatar', 'image_url') ?? at(data, 'legacy', 'profile_image_url_https')
  }
  if (platform === 'bilibili' && (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 0)) throw new Error('B站账号UID不是有效正整数')
  const parsedId = id(uid), parsedName = text(nickname)
  if (!parsedId || !parsedName) throw new Error(`${platform}账号响应缺少当前账号ID或昵称`)
  const faceUrl = url(face)
  const fields: Record<string, import('@owngate/core').FieldMeta> = { nickname: { status: 'ok', untrusted: true, sensitivity: 'pii' } }
  if (!faceUrl) fields['face_url'] = { status: 'unknown', reason: '站点响应未提供可确认头像', sensitivity: 'pii' }
  return { data: { uid: platform === 'bilibili' ? count(uid) : parsedId, nickname: parsedName, face_url: faceUrl }, fields }
}
