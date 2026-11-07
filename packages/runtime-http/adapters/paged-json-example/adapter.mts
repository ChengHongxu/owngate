import type { HttpAdapter } from '@owngate/runtime-http';

/** Example for a self-hosted JSON API; these three exact URLs are in its manifest. */
export default {
  async run(capabilityId, _input, ctx) {
    if (capabilityId !== 'records.list') throw new Error('Unknown read capability');
    const items: Array<{ id: string; title: string | null }> = [];
    for (let page = 1; page <= 3; page++) {
      ctx.signal.throwIfAborted();
      const response = await ctx.http.get(`/api/records?page=${page}`);
      if (response.status !== 200) throw new Error('Records API rejected the read');
      const body = response.json as { items?: unknown[]; has_more?: boolean } | null;
      if (!body || !Array.isArray(body.items)) throw new Error('Invalid records response');
      for (const item of body.items.slice(0, 50)) {
        if (typeof item !== 'object' || item === null || !('id' in item) || typeof item.id !== 'string') continue;
        const title = 'title' in item && typeof item.title === 'string' ? item.title.slice(0, 500) : null;
        items.push({ id: item.id.slice(0, 200), title });
      }
      if (body.has_more !== true) return { items, truncated: false };
    }
    ctx.log('已读取声明的三页；更多记录请在原站查看。');
    return { items, truncated: true };
  },
} satisfies HttpAdapter;
