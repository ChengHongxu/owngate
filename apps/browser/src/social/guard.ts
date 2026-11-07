import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { assertConnectionId } from '@owngate/browser-runtime'
import { workerError } from '../errors.js'
import type { ExecResult } from '../exec.js'

interface SafetyState { day: string; count: number; nextAt: number; paused: boolean }
export interface SocialGuardOptions { directory?: string; now?: () => number; random?: () => number; minIntervalMs?: number; dailyLimit?: number }
/** Persist before navigation so process restarts cannot silently reset daily
 * budgets. Unknown/corrupt state fails closed until an operator repairs it. */
export class SocialGuard {
  private states = new Map<string, SafetyState>()
  private now: () => number
  constructor(private options: SocialGuardOptions = {}) { this.now = options.now ?? Date.now }
  async before(id: string): Promise<ExecResult | null> {
    assertConnectionId(id)
    const now = this.now(), state = await this.state(id), day = new Date(now).toISOString().slice(0, 10)
    if (state.paused) return { status: 'error', error: workerError('RISK_CONTROL_DETECTED', '该连接已因站点风控暂停', '人工检查账号后在后台明确恢复'), meta: { connection_status: 'paused' } }
    if (day !== state.day) { state.day = day; state.count = 0 }
    if (state.count >= (this.options.dailyLimit ?? 100)) return { status: 'error', error: { ...workerError('RATE_LIMITED', '已达到该账号今日浏览器查询上限', '次日再查询或减少自动任务'), retryable: false } }
    if (now < state.nextAt) return { status: 'error', error: { ...workerError('RATE_LIMITED', `该账号需要等待${Math.ceil((state.nextAt - now) / 1000)}秒后再查询`, '降低查询频率，避免连续重试'), retryable: false } }
    state.count++
    state.nextAt = now + (this.options.minIntervalMs ?? 30_000) + Math.floor((this.options.random ?? Math.random)() * 15_000)
    await this.persist(id, state)
    return null
  }
  async after(id: string, result: ExecResult): Promise<void> {
    const meta = result.meta as { connection_status?: string } | undefined
    if (meta?.connection_status !== 'paused') return
    const state = await this.state(id)
    state.paused = true
    await this.persist(id, state)
  }
  async resume(id: string): Promise<void> {
    const state = await this.state(id)
    state.paused = false
    await this.persist(id, state)
  }
  private async state(id: string): Promise<SafetyState> {
    assertConnectionId(id)
    const cached = this.states.get(id)
    if (cached) return cached
    let state: SafetyState = { day: new Date(this.now()).toISOString().slice(0, 10), count: 0, nextAt: 0, paused: false }
    if (this.options.directory) {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(this.options.directory, id, 'owngate-safety.json'), 'utf8'))
        const value = parsed as SafetyState
        if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) || !Number.isSafeInteger(value.count) || value.count < 0 || !Number.isFinite(value.nextAt) || typeof value.paused !== 'boolean') throw new Error('invalid social safety state')
        state = value
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('social safety state unavailable; queries refused') }
    }
    this.states.set(id, state)
    return state
  }
  private async persist(id: string, state: SafetyState): Promise<void> {
    if (!this.options.directory) return
    const directory = join(this.options.directory, id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const target = join(directory, 'owngate-safety.json'), temporary = target + '.' + randomBytes(8).toString('hex')
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
    await rename(temporary, target)
  }
}
