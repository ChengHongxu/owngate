import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DbClient, acquireDbLease } from '@owngate/db'
import { Vault, vaultContext } from '@owngate/vault'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const bin = resolve(root, 'apps/cli/dist/bin.js')
const key = '77'.repeat(32)
const cleanup: Array<() => Promise<void>> = []
beforeAll(async () => { await execute('pnpm', ['--filter', '@owngate/cli', 'build'], { cwd: root }) }, 30_000)
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'owngate-cli-rekey-'))
  const dbPath = join(directory, 'owngate.db'), oldPath = join(directory, 'old-key'), newPath = join(directory, 'new-key')
  cleanup.push(async () => { rmSync(directory, { recursive: true, force: true }) })
  writeFileSync(oldPath, `${key}\n`, { mode: 0o600 })
  const db = new DbClient(dbPath)
  cleanup.push(() => db.close())
  await db.upsertConnector({ id: 'fixture', version: '1', title: 'Fixture', transport: 'http', manifest: {} })
  await db.createConnection({ id: 'connection', connector_id: 'fixture', label: 'Fixture', config: {} })
  const oldVault = new Vault(key)
  await db.upsertCredential({ connection_id: 'connection', key: 'token', ...oldVault.encrypt('private-host-credential', vaultContext.credential('connection', 'token')) })
  return { db, dbPath, oldPath, newPath, oldVault }
}
function rotate(dbPath: string, oldPath: string, newPath: string) {
  return execute(process.execPath, [bin, 'vault', 'rekey', '--db', dbPath, '--old-key-file', oldPath, '--new-key-file', newPath], { timeout: 10_000 })
}

describe('spawned offline vault maintenance', () => {
  it('persists a private new key before rotating and decrypts the database with it after reopening', async () => {
    const { db, dbPath, oldPath, newPath, oldVault } = await fixture()
    const { stdout, stderr } = await rotate(dbPath, oldPath, newPath)
    expect(JSON.parse(stdout)).toMatchObject({ status: 'rekeyed', new_key_file: newPath })
    expect(stdout + stderr).not.toContain(key)
    expect(stdout + stderr).not.toContain('private-host-credential')
    const nextKey = readFileSync(newPath, 'utf8').trim()
    expect(nextKey).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(newPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(oldPath, 'utf8').trim()).toBe(key)
    const rows = await db.listCredentials('connection')
    expect(new Vault(nextKey).decrypt(rows[0]!, vaultContext.credential('connection', 'token'))).toBe('private-host-credential')
    expect(() => oldVault.decrypt(rows[0]!, vaultContext.credential('connection', 'token'))).toThrow()
    expect(await db.rawQuery("SELECT value FROM og_vault_meta WHERE key='key_check'")).toHaveLength(1)
  })

  it('refuses an active server and leaves the destination key path untouched', async () => {
    const { db, dbPath, oldPath, newPath, oldVault } = await fixture()
    const lease = await acquireDbLease(db, { mode: 'server' })
    cleanup.push(() => lease.release())
    await expect(rotate(dbPath, oldPath, newPath)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('active server or maintenance') })
    expect(existsSync(newPath)).toBe(false)
    expect(oldVault.decrypt((await db.listCredentials('connection'))[0]!, vaultContext.credential('connection', 'token'))).toBe('private-host-credential')
  })

  it('keeps the old database and both key files when a corrupt record aborts rotation', async () => {
    const { db, dbPath, oldPath, newPath, oldVault } = await fixture()
    await db.upsertCredential({ connection_id: 'connection', key: 'corrupt', ciphertext: 'broken', iv: 'broken', auth_tag: 'broken' })
    const before = await db.listCredentials('connection')
    await expect(rotate(dbPath, oldPath, newPath)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('wrong key, context, or corrupted') })
    expect(await db.listCredentials('connection')).toEqual(before)
    expect(existsSync(oldPath)).toBe(true)
    expect(existsSync(newPath)).toBe(true)
    const good = before.find((row) => row.key === 'token')!
    expect(oldVault.decrypt(good, vaultContext.credential('connection', 'token'))).toBe('private-host-credential')
  })
})
