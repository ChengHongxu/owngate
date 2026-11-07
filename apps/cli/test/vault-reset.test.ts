import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { DbClient, acquireDbLease } from '@owngate/db'
import { Vault, migrateEncryptedRecords, vaultContext } from '@owngate/vault'
import type { Capability, Client, Connection, InvokeServices } from '@owngate/core'
import { TaskService } from '../../server/src/tasks/service.js'
import { ActionService } from '../../server/src/actions/service.js'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const bin = resolve(root, 'apps/cli/dist/bin.js')
const oldKey = '71'.repeat(32), newKey = '82'.repeat(32), privateValue = 'vault-reset-fixture-private-content'
const cleanup: Array<() => Promise<void>> = []
const taskStatuses = ['pending', 'running', 'success', 'failed', 'cancelled', 'unknown_outcome']
const proposalStatuses = ['pending', 'approved', 'stale', 'running', 'executed', 'rejected', 'expired', 'unknown_outcome']
const removedTables = ['credentials', 'results_cache', 'totp_secrets', 'login_sessions', 'monitors', 'notification_channels',
  'monitor_runtime', 'approvals', 'og_action_approvals']
beforeAll(async () => {
  await execute(resolve(root, 'apps/cli/node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: resolve(root, 'apps/cli') })
}, 30_000)
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'owngate-vault-reset-'))
  cleanup.push(async () => { rmSync(directory, { recursive: true, force: true }) })
  const dbPath = join(directory, 'owngate.db'), profiles = join(directory, 'profiles')
  mkdirSync(join(profiles, 'connection'), { recursive: true })
  mkdirSync(join(profiles, 'connection_2'), { recursive: true })
  writeFileSync(join(profiles, 'connection', 'Cookies'), privateValue)
  writeFileSync(join(profiles, 'connection_2', 'Cookies'), privateValue)
  const outside = join(directory, 'must-survive')
  mkdirSync(outside)
  writeFileSync(join(outside, 'sentinel'), 'external-data')
  if (process.platform !== 'win32') symlinkSync(outside, join(profiles, 'connection', 'external-link'), 'dir')
  const db = new DbClient(dbPath), vault = new Vault(oldKey)
  cleanup.push(() => db.close())
  await db.upsertConnector({ id: 'fixture', version: '1', title: 'Fixture', transport: 'http', manifest: { preserved: true } })
  await db.createConnection({ id: 'connection', connector_id: 'fixture', label: 'Original label', config: { base_url: 'https://example.com', role: 'user' },
    scope: 'organization', tags: ['fixture'], capability_states: {
      'test.read': { status: 'supported', reason: 'old verification' }, 'post.create': { status: 'disabled', reason: 'writes disabled' },
      'test.partial': { status: 'partial' },
    } })
  await db.upsertCredential({ connection_id: 'connection', key: 'token', ...vault.encrypt(privateValue, vaultContext.credential('connection', 'token')) })
  // Recovery must also work with damaged ciphertext, without the missing key.
  await db.upsertCredential({ connection_id: 'connection', key: 'corrupt', ciphertext: 'corrupt', iv: 'corrupt', auth_tag: 'corrupt' })
  await db.createClient({ id: 'client', label: 'Original client', token_hash: 'retained-client-hash' })
  await db.upsertGrant({ client_id: 'client', connection_id: 'connection', capabilities: ['test.read', 'propose:post.create'] })
  await db.createAdminUser({ id: 'admin', username: 'administrator', password_hash: 'retained-password-hash' })
  await db.rawRun("UPDATE admin_users SET totp_enabled=1 WHERE id='admin'")
  await db.rawRun('INSERT INTO totp_secrets(user_id,ciphertext,iv,auth_tag) VALUES(?,?,?,?)',
    (() => { const blob = vault.encrypt(privateValue, vaultContext.totp('admin')); return ['admin', blob.ciphertext, blob.iv, blob.auth_tag] })())
  await db.rawRun("INSERT INTO webauthn_credentials(id,user_id,credential_id,public_key) VALUES('passkey','admin','retained-credential','retained-public-key')")
  await db.insertLoginSession({ id: 'session', user_id: 'admin', expires_at: '2100-01-01' })
  await db.setCacheEntry({ key: 'cache', ...vault.encrypt(privateValue, vaultContext.cache('cache')), expires_at: '2100-01-01' })
  await db.rawTransaction([
    { sql: 'CREATE TABLE og_vault_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)' },
    { sql: 'CREATE TABLE og_action_meta(proposal_id TEXT PRIMARY KEY REFERENCES action_proposals(id),revision TEXT NOT NULL,expires_at TEXT NOT NULL,result TEXT)' },
    { sql: 'CREATE TABLE og_action_approvals(proposal_id TEXT PRIMARY KEY,method TEXT NOT NULL,expires_at TEXT NOT NULL)' },
    { sql: 'CREATE TABLE og_action_claims(proposal_id TEXT PRIMARY KEY REFERENCES action_proposals(id),attempt INTEGER NOT NULL,token TEXT,claimed_at TEXT NOT NULL)' },
    { sql: 'CREATE TABLE og_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)' },
    { sql: "INSERT INTO og_settings VALUES('actions_paused','false')" },
    { sql: "INSERT INTO og_vault_meta VALUES('key_check',?)", params: [JSON.stringify(vault.encryptJSON('owngate.vault.v2', vaultContext.keyCheck()))] },
    { sql: 'CREATE TABLE monitor_runtime(monitor_id TEXT PRIMARY KEY REFERENCES monitors(id),config TEXT NOT NULL,state TEXT NOT NULL,next_run_at TEXT)' },
    { sql: "INSERT INTO notification_channels(id,type,config) VALUES('smtp','smtp',?)", params: [JSON.stringify(vault.encryptJSON({ pass: privateValue }, vaultContext.notification('smtp')))] },
    { sql: "INSERT INTO monitors(id,connection_id,capability_id,cron,condition,channel_id) VALUES('monitor','connection','test.read','* * * * *','{}','smtp')" },
    { sql: "INSERT INTO monitor_runtime VALUES('monitor',?,?,NULL)", params: [JSON.stringify(vault.encryptJSON({ input: privateValue }, vaultContext.monitor('monitor', 'config'))), JSON.stringify(vault.encryptJSON({ last: privateValue }, vaultContext.monitor('monitor', 'state')))] },
    { sql: "INSERT INTO channel_upstream_links(connection_id,channel_id,upstream_connection_id) VALUES('connection','17','connection')" },
  ])
  for (const status of taskStatuses) {
    const id = `task-${status}`
    await db.rawRun(`INSERT INTO tasks(id,client_id,actor_kind,actor_id,connection_id,capability_id,input,input_ciphertext,result_ciphertext,status,
      safe_retry,attempts,available_at,lease_owner,lease_expires_at,heartbeat_at,created_at,finished_at)
      VALUES(?,'client','client','client','connection','test.read',?,?,?,?,1,2,'2100-01-01','stale-owner','2100-01-01','2026-01-01','2026-01-01','2026-01-02')`,
    [id, JSON.stringify({ legacy_private: privateValue }), JSON.stringify(vault.encryptJSON({ message: privateValue }, vaultContext.task(id, 'input'))),
      JSON.stringify(vault.encryptJSON({ private: privateValue }, vaultContext.task(id, 'result'))), status])
    await db.rawRun("INSERT INTO task_events(task_id,event,detail) VALUES(?,'fixture.history','{}')", [id])
  }
  for (const status of proposalStatuses) {
    const id = `proposal-${status}`
    await db.rawRun("INSERT INTO action_proposals(id,client_id,connection_id,capability_id,input,normalized_hash,status) VALUES(?,'client','connection','post.create',?,'retained-proposal-hash',?)",
      [id, JSON.stringify(vault.encryptJSON({ text: privateValue }, vaultContext.action(id, 'input'))), status])
    await db.rawTransaction([
      { sql: "INSERT INTO og_action_meta VALUES(?,'old-revision','2100-01-01',?)", params: [id, JSON.stringify(vault.encryptJSON({ private: privateValue }, vaultContext.action(id, 'result')))] },
      { sql: "INSERT INTO approvals(proposal_id,approved_by,approved_hash) VALUES(?,'admin','retained-proposal-hash')", params: [id] },
      { sql: "INSERT INTO og_action_approvals VALUES(?,'passkey','2100-01-01')", params: [id] },
      { sql: "INSERT INTO og_action_claims VALUES(?,3,'old-claim','2026-01-01')", params: [id] },
    ])
  }
  await db.appendAuditLog({ action: 'fixture.seed', target: 'vault', detail: { retained: true } })
  const run = (args: string[] = [], preload?: string) => execute(process.execPath,
    [...(preload ? ['--import', preload] : []), bin, 'vault', 'reset', '--db', dbPath, '--profiles-dir', profiles, ...args],
    { timeout: 15_000, env: { ...process.env, MASTER_KEY_HEX: 'missing-key-reset-does-not-read-this', MASTER_KEY_HEX_FILE: join(directory, 'missing-key') } })
  return { directory, db, dbPath, profiles, outside, run }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function snapshot(db: DbClient) {
  const tables = await db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('sqlite_sequence','og_service_lease') ORDER BY name") as Array<{ name: string }>
  return Object.fromEntries(await Promise.all(tables.map(async ({ name }) => [name, await db.rawQuery(`SELECT * FROM ${name} ORDER BY rowid`)])))
}
function preload(f: Fixture, code: string): string {
  const path = join(f.directory, `fault-${readdirSync(f.directory).length}.mjs`)
  writeFileSync(path, `import fs from 'node:fs';\nimport promises from 'node:fs/promises';\nimport {syncBuiltinESMExports} from 'node:module';\nimport {isMainThread} from 'node:worker_threads';\nif(isMainThread){${code}\nsyncBuiltinESMExports();}\n`)
  return pathToFileURL(path).href
}

describe('spawned offline vault reset', () => {
  it('requires explicit confirmation and a dedicated profiles path before changing any data', async () => {
    const f = await fixture(), before = await snapshot(f.db)
    await expect(f.run()).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('--confirm') })
    await expect(execute(process.execPath, [bin, 'vault', 'reset', '--db', f.dbPath, '--confirm'])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('--profiles-dir') })
    expect(await snapshot(f.db)).toEqual(before)
    expect(readFileSync(join(f.profiles, 'connection', 'Cookies'), 'utf8')).toBe(privateValue)
  })

  it('refuses an active server before isolating profiles or deleting encrypted records', async () => {
    const f = await fixture(), before = await snapshot(f.db)
    const lease = await acquireDbLease(f.db, { mode: 'server' })
    cleanup.push(() => lease.release())
    await expect(f.run(['--confirm'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('active server or maintenance') })
    expect(await snapshot(f.db)).toEqual(before)
    expect(readdirSync(f.profiles).sort()).toEqual(['connection', 'connection_2'])
  })

  it('discards all encrypted payloads, pauses connections and preserves safe configuration and audit history', async () => {
    const f = await fixture()
    const preserved = await Promise.all(['connectors', 'clients', 'grants', 'channel_upstream_links', 'webauthn_credentials'].map((table) => f.db.rawQuery(`SELECT * FROM ${table}`)))
    const { stdout, stderr } = await f.run(['--confirm'])
    expect(JSON.parse(stdout)).toMatchObject({ status: 'vault_reset', browser_profiles_cleared: true, browser_profiles_discarded: 2,
      connections_paused: 1, task_payloads_discarded: taskStatuses.length, proposal_payloads_discarded: proposalStatuses.length })
    for (const table of removedTables) expect(await f.db.rawQuery(`SELECT * FROM ${table}`)).toEqual([])
    expect(await f.db.rawQuery("SELECT * FROM og_vault_meta WHERE key='key_check'")).toEqual([])
    expect(await f.db.rawQuery('SELECT * FROM og_action_meta')).toHaveLength(proposalStatuses.length)
    expect(await f.db.rawQuery('SELECT result FROM og_action_meta WHERE result IS NOT NULL')).toEqual([])
    expect(await f.db.rawQuery('SELECT token FROM og_action_claims WHERE token IS NOT NULL')).toEqual([])
    expect(await f.db.rawQuery("SELECT value FROM og_settings WHERE key='actions_paused'")).toEqual([{ value: 'true' }])
    expect(await f.db.rawQuery('SELECT username,password_hash,totp_enabled FROM admin_users')).toEqual([{ username: 'administrator', password_hash: 'retained-password-hash', totp_enabled: 0 }])
    expect(await Promise.all(['connectors', 'clients', 'grants', 'channel_upstream_links', 'webauthn_credentials'].map((table) => f.db.rawQuery(`SELECT * FROM ${table}`)))).toEqual(preserved)
    const connection = await f.db.getConnection('connection')
    expect(connection).toMatchObject({ paused: true, label: 'Original label', scope: 'organization', tags: ['fixture'], config: { base_url: 'https://example.com', role: 'user' },
      capability_states: { 'test.read': { status: 'needs_auth' }, 'test.partial': { status: 'needs_auth' }, 'post.create': { status: 'disabled', reason: 'writes disabled' } } })
    for (const previous of taskStatuses) {
      const [task] = await f.db.rawQuery('SELECT * FROM tasks WHERE id=?', [`task-${previous}`]) as Array<Record<string, unknown>>
      expect(task).toMatchObject({ status: previous === 'pending' ? 'cancelled' : previous === 'running' ? 'unknown_outcome' : previous,
        input: '{}', input_ciphertext: null, result_ciphertext: null, safe_retry: 0, available_at: null, lease_owner: null, lease_expires_at: null, heartbeat_at: null, attempts: 2 })
      if (previous === 'running') expect(JSON.parse(String(task!['cancellation']))).toMatchObject({ remote_confirmed: false, may_continue_remote: true })
      const events = await f.db.rawQuery('SELECT event,detail FROM task_events WHERE task_id=? ORDER BY id', [`task-${previous}`]) as Array<{ event: string; detail: string }>
      expect(events.map((event) => event.event)).toEqual(['fixture.history', 'vault_reset'])
      expect(JSON.parse(events[1]!.detail)).toMatchObject({ payloads_discarded: true, retryable: false })
    }
    for (const previous of proposalStatuses) {
      expect(await f.db.rawQuery('SELECT input,status FROM action_proposals WHERE id=?', [`proposal-${previous}`])).toEqual([{ input: '{}',
        status: ['pending', 'approved', 'stale'].includes(previous) ? 'rejected' : previous === 'running' ? 'unknown_outcome' : previous }])
    }
    const audit = await f.db.rawQuery('SELECT * FROM audit_log ORDER BY seq') as Array<{ action: string; client_id: string | null; target: string; detail: string; at: string; prev_hash: string; entry_hash: string }>
    expect(audit).toHaveLength(2)
    const entry = audit[1]!
    expect(entry.action).toBe('vault.reset')
    expect(entry.prev_hash).toBe(audit[0]!.entry_hash)
    expect(entry.entry_hash).toBe(createHash('sha256').update(`${entry.prev_hash}|${JSON.stringify({ action: entry.action,
      client_id: entry.client_id, target: entry.target, detail: JSON.parse(entry.detail), at: entry.at })}`).digest('hex'))
    expect(stdout + stderr + JSON.stringify(audit)).not.toContain(oldKey)
    expect(stdout + stderr + JSON.stringify(audit)).not.toContain(privateValue)
    expect(readdirSync(f.profiles)).toEqual([])
    expect(lstatSync(f.profiles).isDirectory()).toBe(true)
    expect(readFileSync(join(f.outside, 'sentinel'), 'utf8')).toBe('external-data')
    // A second reset is safe and does not need a key or profile contents.
    expect(JSON.parse((await f.run(['--confirm'])).stdout)).toMatchObject({ status: 'vault_reset', browser_profiles_discarded: 0 })
  })

  it('starts migration under a new key and serves task/proposal metadata without resurrecting old payloads', async () => {
    const f = await fixture()
    await f.run(['--confirm'])
    const reopened = new DbClient(f.dbPath), vault = new Vault(newKey)
    cleanup.push(() => reopened.close())
    const lease = await acquireDbLease(reopened, { mode: 'server' })
    cleanup.push(() => lease.release())
    await migrateEncryptedRecords(reopened, vault)
    const check = await reopened.rawQuery("SELECT value FROM og_vault_meta WHERE key='key_check'") as Array<{ value: string }>
    expect(vault.decryptJSON(JSON.parse(check[0]!.value), vaultContext.keyCheck())).toBe('owngate.vault.v2')
    expect(() => new Vault(oldKey).decryptJSON(JSON.parse(check[0]!.value), vaultContext.keyCheck())).toThrow()
    const connection = await reopened.getConnection('connection') as Connection
    const client: Client = { id: 'client', label: 'Client', revoked: false, created_at: '2026-01-01' }
    const read: Capability = { id: 'test.read', title: 'Read', description: '', kind: 'query', effect: 'read', approval: 'never',
      input: { type: 'object' }, output: { type: 'object' }, cache: null, long_running: true, cancel: 'none', idempotency: 'none', verify: null, transport: 'http', support: { status: 'needs_auth' } }
    const action: Capability = { ...read, id: 'post.create', kind: 'action', effect: 'external_send', approval: 'always', support: { status: 'disabled' } }
    const dispatch = vi.fn()
    const services: InvokeServices = { auth: { getClient: () => client, getClientById: () => client, getGrants: () => [{ client_id: 'client', connection_id: 'connection', capabilities: ['test.read', 'propose:post.create'] }] },
      connections: { get: () => connection }, capabilities: { get: (_connector, id) => id === 'test.read' ? read : action },
      dispatch: { dispatch }, cache: { get: () => undefined, set: () => {}, invalidate: () => {} }, audit: { append: () => {} } }
    const invokeOpts = { hashToken: (token: string) => token, redactOutput: (value: unknown) => value }
    const tasks = new TaskService({ db: reopened, vault, services, invokeOpts })
    cleanup.push(() => tasks.stop())
    const actions = new ActionService({ db: reopened, vault, services, invokeOpts })
    await actions.init()
    expect(await tasks.get('task-running', { kind: 'client', client_id: 'client' })).toMatchObject({ status: 'unknown_outcome', input: {}, result: null })
    expect(await actions.get('proposal-running', { kind: 'client', client_id: 'client' })).toMatchObject({ status: 'unknown_outcome', input: {}, result: null })
    await tasks.start()
    await new Promise<void>((done) => setImmediate(done))
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('rolls back every database change and restores profiles when the atomic audit append fails', async () => {
    const f = await fixture()
    await f.db.rawRun("CREATE TRIGGER reject_reset BEFORE INSERT ON audit_log WHEN NEW.action='vault.reset' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END")
    const before = await snapshot(f.db)
    await expect(f.run(['--confirm'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('rolled back; browser profiles were restored') })
    expect(await snapshot(f.db)).toEqual(before)
    expect(readdirSync(f.profiles).sort()).toEqual(['connection', 'connection_2'])
    expect(readFileSync(join(f.profiles, 'connection', 'Cookies'), 'utf8')).toBe(privateValue)
    expect(readFileSync(join(f.profiles, 'connection_2', 'Cookies'), 'utf8')).toBe(privateValue)
  })

  it('restores an already moved profile when a later rename fails, without touching the database', async () => {
    const f = await fixture(), before = await snapshot(f.db)
    const fault = preload(f, `const original=fs.renameSync; let moved=0; fs.renameSync=(source,destination)=>{if(String(destination).includes('.owngate-vault-reset-')&&++moved===2) throw new Error('fixture rename failure'); return original(source,destination);};`)
    await expect(f.run(['--confirm'], fault)).rejects.toMatchObject({ code: 1 })
    expect(await snapshot(f.db)).toEqual(before)
    expect(readdirSync(f.profiles).sort()).toEqual(['connection', 'connection_2'])
    expect(readFileSync(join(f.profiles, 'connection', 'Cookies'), 'utf8')).toBe(privateValue)
  })

  it('reports a committed reset and the retained isolation path when deletion fails; retry cannot silently skip old profiles', async () => {
    const f = await fixture()
    const fault = preload(f, `const original=promises.rm; promises.rm=async(path,options)=>{if(String(path).includes('.owngate-vault-reset-')) throw new Error('fixture cleanup failure'); return original(path,options);};`)
    await expect(f.run(['--confirm'], fault)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Database reset COMMITTED') })
    const [isolation] = readdirSync(f.profiles)
    expect(isolation).toMatch(/^\.owngate-vault-reset-/)
    expect(readFileSync(join(f.profiles, isolation!, 'connection', 'Cookies'), 'utf8')).toBe(privateValue)
    expect(await f.db.listCredentials('connection')).toEqual([])
    const audit = await f.db.rawQuery("SELECT detail FROM audit_log WHERE action='vault.reset'") as Array<{ detail: string }>
    expect(audit).toHaveLength(1)
    expect(isolation).toBe(`.owngate-vault-reset-${JSON.parse(audit[0]!.detail).reset_id}`)
    await expect(f.run(['--confirm'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(join(f.profiles, isolation!)) })
  })

  it('refuses to report success when a still-running browser recreates profiles during deletion', async () => {
    const f = await fixture()
    const fault = preload(f, `const {dirname,join}=await import('node:path'); const original=promises.rm; promises.rm=async(path,options)=>{const result=await original(path,options);if(String(path).includes('.owngate-vault-reset-')){fs.mkdirSync(join(dirname(path),'recreated'));fs.writeFileSync(join(dirname(path),'recreated','Cookies'),'new browser login');}return result;};`)
    await expect(f.run(['--confirm'], fault)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Database reset COMMITTED') })
    expect(readdirSync(f.profiles)).toEqual(['recreated'])
    expect(await f.db.listCredentials('connection')).toEqual([])
  })

  it('does not restore old browser logins when the transaction committed but its acknowledgement was lost', async () => {
    const f = await fixture()
    const dbModule = pathToFileURL(resolve(root, 'packages/db/dist/index.js')).href
    const fault = preload(f, `const {DbClient}=await import(${JSON.stringify(dbModule)}); const original=DbClient.prototype.rawTransaction; DbClient.prototype.rawTransaction=async function(statements){const result=await original.call(this,statements);if(statements.some(s=>s.sql.includes('INSERT INTO audit_log')))throw new Error('fixture acknowledgement lost');return result;};`)
    expect(JSON.parse((await f.run(['--confirm'], fault)).stdout).status).toBe('vault_reset')
    expect(readdirSync(f.profiles)).toEqual([])
    expect(await f.db.listCredentials('connection')).toEqual([])
  })

  it('leaves old profiles isolated when the database outcome cannot be checked after losing its worker', async () => {
    const f = await fixture()
    const dbModule = pathToFileURL(resolve(root, 'packages/db/dist/index.js')).href
    const fault = preload(f, `const {DbClient}=await import(${JSON.stringify(dbModule)}); const original=DbClient.prototype.rawTransaction; DbClient.prototype.rawTransaction=async function(statements){const result=await original.call(this,statements);if(statements.some(s=>s.sql.includes('INSERT INTO audit_log'))){await this.close();throw new Error('fixture worker lost');}return result;};`)
    await expect(f.run(['--confirm'], fault)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('commit status is UNKNOWN') })
    expect(readdirSync(f.profiles)).toHaveLength(1)
    expect(readdirSync(f.profiles)[0]).toMatch(/^\.owngate-vault-reset-/)
    expect(existsSync(join(f.profiles, 'connection'))).toBe(false)
    expect(await f.db.listCredentials('connection')).toEqual([])
  })

  it('rejects system, home, project and database ancestor paths, symlinks and unmanaged entries', async () => {
    const f = await fixture(), before = await snapshot(f.db)
    for (const path of ['/', homedir(), root, f.directory, '/etc']) {
      await expect(f.run(['--confirm', '--profiles-dir', path])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('dedicated managed directory') })
    }
    if (process.platform !== 'win32') {
      const linkedRoot = join(f.directory, 'linked-profiles')
      symlinkSync(f.profiles, linkedRoot, 'dir')
      await expect(f.run(['--confirm', '--profiles-dir', linkedRoot])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('symbolic links') })
      const linkedParent = join(f.directory, 'linked-parent')
      symlinkSync(f.directory, linkedParent, 'dir')
      await expect(f.run(['--confirm', '--profiles-dir', join(linkedParent, 'profiles')])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('symbolic links') })
      symlinkSync(f.outside, join(f.profiles, 'linked'), 'dir')
      await expect(f.run(['--confirm'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('unmanaged entries') })
      rmSync(join(f.profiles, 'linked'))
    }
    writeFileSync(join(f.profiles, 'unexpected-file'), 'keep me')
    await expect(f.run(['--confirm'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('unmanaged entries') })
    expect(await snapshot(f.db)).toEqual(before)
    expect(readFileSync(join(f.outside, 'sentinel'), 'utf8')).toBe('external-data')
  })

  it('handles older databases without optional runtime tables and recreates the paused action setting', async () => {
    const f = await fixture()
    await f.db.rawTransaction(['og_action_meta', 'og_action_approvals', 'og_action_claims', 'og_vault_meta', 'monitor_runtime', 'og_settings']
      .map((table) => ({ sql: `DROP TABLE ${table}` })))
    expect(JSON.parse((await f.run(['--confirm'])).stdout)).toMatchObject({ status: 'vault_reset', actions_paused: true })
    expect(await f.db.rawQuery("SELECT value FROM og_settings WHERE key='actions_paused'")).toEqual([{ value: 'true' }])
    expect(await f.db.listCredentials('connection')).toEqual([])
    expect(readdirSync(f.profiles)).toEqual([])
  })
})
