import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SocialGuard } from '../src/social/guard.js'

describe('social account request budgets', () => {
  it('keeps a manually persisted risk pause across a new day', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owngate-state-social-'))
    const profile = join(directory, 'fixture')
    const state = JSON.stringify({ day: '2026-11-01', count: 0, nextAt: 0, paused: true })
    try {
      await mkdir(profile)
      await writeFile(join(profile, 'owngate-safety.json'), state)
      const guard = new SocialGuard({ directory, now: () => Date.UTC(2026, 10, 2) })
      expect(await guard.before('fixture')).toMatchObject({
        status: 'error', error: { code: 'RISK_CONTROL_DETECTED' }, meta: { connection_status: 'paused' },
      })
      expect(await readFile(join(profile, 'owngate-safety.json'), 'utf8')).toBe(state)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('enforces a daily budget manually persisted before the worker starts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owngate-state-social-'))
    const profile = join(directory, 'fixture')
    const state = JSON.stringify({ day: '2026-11-02', count: 2, nextAt: 0, paused: false })
    try {
      await mkdir(profile)
      await writeFile(join(profile, 'owngate-safety.json'), state)
      const guard = new SocialGuard({ directory, now: () => Date.UTC(2026, 10, 2), dailyLimit: 2 })
      expect(await guard.before('fixture')).toMatchObject({
        status: 'error', error: { code: 'RATE_LIMITED', retryable: false },
      })
      expect(await readFile(join(profile, 'owngate-safety.json'), 'utf8')).toBe(state)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('persists daily usage and risk pause across worker restarts and resumes only explicitly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owngate-social-'))
    let now = Date.UTC(2026, 10, 2)
    const options = { directory, now: () => now, random: () => 0, minIntervalMs: 30_000, dailyLimit: 2 }
    try {
      const first = new SocialGuard(options)
      expect(await first.before('fixture')).toBeNull()
      expect((await first.before('fixture'))?.error?.code).toBe('RATE_LIMITED')
      now += 30_000
      const restarted = new SocialGuard(options)
      expect(await restarted.before('fixture')).toBeNull()
      now += 30_000
      expect((await restarted.before('fixture'))?.error?.what_happened).toContain('今日')
      await restarted.after('fixture', { status: 'error', meta: { connection_status: 'paused' } })
      now += 24 * 60 * 60 * 1000
      const paused = new SocialGuard(options)
      expect((await paused.before('fixture'))?.meta).toEqual({ connection_status: 'paused' })
      await paused.resume('fixture')
      expect(await paused.before('fixture')).toBeNull()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('fails closed on corrupt safety state and never accepts path traversal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'owngate-social-'))
    try {
      const guard = new SocialGuard({ directory })
      await guard.before('fixture')
      await writeFile(join(directory, 'fixture', 'owngate-safety.json'), '{invalid')
      await expect(new SocialGuard({ directory }).before('fixture')).rejects.toThrow('queries refused')
      await expect(guard.before('../escape')).rejects.toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

it('requires a signed explicit resume and preserves the pause until that action', async () => {
  const { buildBrowserServer } = await import('../src/main.js')
  const { FakeSessionManager, SECRET, checkBody, post } = await import('./helpers.js')
  process.env['BROWSER_RPC_SECRET'] = SECRET
  const sessions = new FakeSessionManager(), guard = new SocialGuard({ minIntervalMs: 0, random: () => 0 })
  let calls = 0
  const { app } = await buildBrowserServer({ sessionManager: sessions, socialGuard: guard, exec: async () => {
    calls++
    return calls === 1 ? { status: 'error', meta: { connection_status: 'paused' } } : { status: 'ok', data: { uid: 42 } }
  } })
  try {
    await post(app, '/v1/check', checkBody('fixture'))
    const blocked = await post(app, '/v1/check', checkBody('fixture'))
    expect(blocked.json()).toMatchObject({ status: 'error', error: { code: 'RISK_CONTROL_DETECTED' } })
    expect(calls).toBe(1)
    expect((await app.inject({ method: 'POST', url: '/v1/safety/resume', payload: { connection_id: 'fixture' } })).statusCode).toBe(401)
    expect((await post(app, '/v1/safety/resume', { connection_id: 'fixture' })).json()).toEqual({ ok: true })
    expect((await post(app, '/v1/check', checkBody('fixture'))).json()).toMatchObject({ status: 'ok' })
    expect(calls).toBe(2)
  } finally { await sessions.closeAll(); await app.close() }
})
