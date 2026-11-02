// Capability executor — M1 stub. Real implementations (feed.list etc.) come in M2.

import type { BrowserContext } from 'playwright'

export interface ExecResult {
  status: 'ok' | 'error'
  data?: unknown
  error?: {
    code: string
    what_happened: string
    next_step: string
    retryable: boolean
  }
  meta?: unknown
}

export async function execCapability(
  _context: BrowserContext,
  capability: string,
  params: Record<string, unknown>,
  _deadlineMs: number,
): Promise<ExecResult> {
  // M1 stub: return a fixed shape. Real per-capability handlers land in M2.
  return {
    status: 'ok',
    data: {
      capability,
      params,
      executed_at: new Date().toISOString(),
    },
  }
}
