import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import * as argon2 from 'argon2'
import { DbClient, acquireDbLease } from '@owngate/db'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const bin = resolve(root, 'apps/cli/dist/bin.js')
const password = 'new-recovery-password'
const cleanup: Array<() => Promise<void>> = []
let originalHash: string
beforeAll(async () => {
  await execute(resolve(root, 'apps/cli/node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: resolve(root, 'apps/cli') })
  originalHash = await argon2.hash('old-recovery-password')
}, 30_000)
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'owngate-admin-reset-'))
  cleanup.push(async () => { rmSync(directory, { recursive: true, force: true }) })
  const dbPath = join(directory, 'owngate.db'), passwordFile = join(directory, 'password')
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 })
  const db = new DbClient(dbPath)
  cleanup.push(() => db.close())
  await db.createAdminUser({ id: 'admin', username: 'fixture', password_hash: originalHash })
  await db.insertLoginSession({ id: 'session', user_id: 'admin', expires_at: '2100-01-01' })
  await db.rawRun("INSERT INTO webauthn_credentials(id,user_id,credential_id,public_key) VALUES('passkey','admin','fixture-key','fixture-public-key')")
  await db.rawRun("UPDATE admin_users SET totp_enabled=1 WHERE id='admin'")
  await db.appendAuditLog({ action: 'fixture.seed', target: 'admin', detail: {} })
  const reset = (...extra: string[]) => execute(process.execPath, [bin, 'admin', 'reset-password', '--db', dbPath,
    '--username', 'fixture', '--password-file', passwordFile, ...extra], { timeout: 10_000 })
  return { db, passwordFile, reset }
}

describe('spawned offline administrator recovery', () => {
  it('changes the password, revokes sessions and appends a hash-chained audit without exposing secrets', async () => {
    const { db, reset } = await fixture()
    const { stdout, stderr } = await reset()
    expect(JSON.parse(stdout)).toMatchObject({ status: 'password_reset', username: 'fixture', sessions_revoked: true, passkeys_reset: false })
    const user = await db.getAdminByUsername('fixture')
    expect(await argon2.verify(user!.password_hash, password)).toBe(true)
    expect(user!.totp_enabled).toBe(true)
    expect(await db.rawQuery('SELECT id FROM login_sessions')).toEqual([])
    expect(await db.rawQuery('SELECT id FROM webauthn_credentials')).toHaveLength(1)
    const audit = await db.rawQuery('SELECT * FROM audit_log ORDER BY seq') as Array<{ action: string; client_id: string | null; target: string; detail: string; at: string; prev_hash: string; entry_hash: string }>
    expect(audit).toHaveLength(2)
    const entry = audit[1]!
    expect(entry.prev_hash).toBe(audit[0]!.entry_hash)
    expect(entry.entry_hash).toBe(createHash('sha256').update(`${entry.prev_hash}|${JSON.stringify({ action: entry.action,
      client_id: entry.client_id, target: entry.target, detail: JSON.parse(entry.detail), at: entry.at })}`).digest('hex'))
    expect(stdout + stderr + JSON.stringify(audit)).not.toContain(password)
    expect(stdout + stderr + JSON.stringify(audit)).not.toContain(user!.password_hash)
  })

  it('removes passkeys only when explicitly requested', async () => {
    const { db, reset } = await fixture()
    const { stdout } = await reset('--reset-passkeys')
    expect(JSON.parse(stdout).passkeys_reset).toBe(true)
    expect(await db.rawQuery('SELECT id FROM webauthn_credentials')).toEqual([])
  })

  it('refuses an active server without changing account or sessions', async () => {
    const { db, reset } = await fixture()
    const lease = await acquireDbLease(db, { mode: 'server' })
    cleanup.push(() => lease.release())
    await expect(reset()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('active server or maintenance') })
    expect((await db.getAdminByUsername('fixture'))!.password_hash).toBe(originalHash)
    expect(await db.rawQuery('SELECT id FROM login_sessions')).toHaveLength(1)
  })

  it('rolls back the password, sessions and passkeys when the audit append fails', async () => {
    const { db, reset } = await fixture()
    await db.rawRun("CREATE TRIGGER reject_reset BEFORE INSERT ON audit_log WHEN NEW.action='auth.password.reset' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END")
    await expect(reset('--reset-passkeys')).rejects.toMatchObject({ code: 1 })
    expect((await db.getAdminByUsername('fixture'))!.password_hash).toBe(originalHash)
    expect(await db.rawQuery('SELECT id FROM login_sessions')).toHaveLength(1)
    expect(await db.rawQuery('SELECT id FROM webauthn_credentials')).toHaveLength(1)
    expect(await db.rawQuery('SELECT seq FROM audit_log')).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('rejects password files readable by other users before touching account data', async () => {
    const { db, passwordFile, reset } = await fixture()
    chmodSync(passwordFile, 0o644)
    await expect(reset()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('private to its current owner') })
    expect((await db.getAdminByUsername('fixture'))!.password_hash).toBe(originalHash)
  })
})
