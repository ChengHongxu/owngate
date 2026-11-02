// Transform function registry — design doc §4.1.2 ④
// Whitelist only — new functions require a code change and version bump.

export type TransformFn = (value: unknown, ctx: TransformContext) => unknown;

export interface TransformContext {
  /** quota_to_usd needs the connection's quota_per_unit ratio */
  quota_per_unit?: number;
}

const REGISTRY: Record<string, TransformFn> = {
  // Convert API quota units to USD. Returns null if ratio unknown.
  quota_to_usd(value, ctx) {
    if (typeof value !== 'number') return null;
    if (ctx.quota_per_unit === undefined || ctx.quota_per_unit <= 0) return null;
    return value / ctx.quota_per_unit;
  },

  seconds_to_ms(value) {
    if (typeof value !== 'number') return null;
    return value * 1000;
  },

  ms_to_seconds(value) {
    if (typeof value !== 'number') return null;
    return value / 1000;
  },

  unix_to_iso(value) {
    if (typeof value !== 'number') return null;
    return new Date(value * 1000).toISOString();
  },

  iso_to_unix(value) {
    if (typeof value !== 'string') return null;
    const ms = Date.parse(value);
    return isNaN(ms) ? null : Math.floor(ms / 1000);
  },

  strip_html(value) {
    if (typeof value !== 'string') return null;
    // Remove tags, decode basic entities
    return value
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  },

  pick_first(value) {
    if (!Array.isArray(value)) return null;
    return value[0] ?? null;
  },

  number_or_null(value) {
    if (typeof value === 'number' && !isNaN(value)) return value;
    const n = Number(value);
    return isNaN(n) ? null : n;
  },
};

export function applyTransform(name: string, value: unknown, ctx: TransformContext): unknown {
  const fn = REGISTRY[name];
  if (!fn) throw new Error(`Unknown transform function: ${name}`);
  return fn(value, ctx);
}

export function isKnownTransform(name: string): boolean {
  return name in REGISTRY;
}
