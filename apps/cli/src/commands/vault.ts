import { Command } from 'commander'
import { openSync, closeSync, readFileSync, writeFileSync, fsyncSync, statSync, existsSync,
  lstatSync, realpathSync, readdirSync, mkdirSync, renameSync, rmdirSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { resolve, dirname, parse, relative, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DbClient, acquireDbLease } from '@owngate/db'
import type { RawStatement } from '@owngate/db'
import { Vault, rekeyEncryptedRecords } from '@owngate/vault'

function readKey(path: string): string {
  const stat = statSync(path)
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error('Master key files must be regular files private to their owner (mode 0600 or 0400).')
  }
  const key = readFileSync(path, 'utf8').trim()
  // Validate without ever including the key in a diagnostic.
  new Vault(key)
  return key
}

function createKey(path: string): string {
  const key = randomBytes(32).toString('hex')
  const fd = openSync(path, 'wx', 0o600)
  try { writeFileSync(fd, `${key}\n`, 'utf8'); fsyncSync(fd) }
  finally { closeSync(fd) }
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(path), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
  return key
}

const isolationPrefix = '.owngate-vault-reset-'
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const connectionDirectory = /^[A-Za-z0-9_-]{1,64}$/
interface ProfilePlan { path: string; stat: Stats; entries: Array<{ name: string; stat: Stats }> }
interface ProfileIsolation { plan: ProfilePlan; path: string; stat: Stats; moved: string[] }

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(suffix))
}

function noSymlinkAncestors(path: string): void {
  const root = parse(path).root
  let current = path
  for (;;) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('--profiles-dir and its ancestors must not be symbolic links.')
    if (current === root) return
    current = dirname(current)
  }
}

function sameDirectory(path: string, expected: Stats): void {
  noSymlinkAncestors(path)
  const actual = lstatSync(path)
  if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error('The managed profiles directory changed during maintenance. Keep the server and browser stopped.')
  }
}

function profilePlan(path: string, dbPath: string): ProfilePlan {
  const resolved = resolve(path)
  // A typo must never recursively clear a home, source tree, system directory,
  // or a directory that contains the database being repaired.
  const anchors = [resolve(homedir()), resolve(repositoryRoot), resolve(process.cwd())]
  const systemRoots = ['/bin', '/sbin', '/etc', '/usr', '/lib', '/lib64', '/proc', '/sys', '/dev', '/run', '/boot']
  const systemDirectories = ['/var', '/var/log', '/var/lib', '/tmp', '/home', '/root', '/opt', '/srv', '/media', '/mnt']
  if (resolved === parse(resolved).root || anchors.some((anchor) => contains(resolved, anchor))
      || (process.platform !== 'win32' && (systemRoots.some((root) => contains(root, resolved)) || systemDirectories.includes(resolved)))
      || contains(resolved, resolve(dbPath)) || contains(resolved, realpathSync(dbPath))) {
    throw new Error('--profiles-dir must be a dedicated managed directory, not a system/home/project directory or an ancestor of the database.')
  }
  noSymlinkAncestors(resolved)
  const stat = lstatSync(resolved)
  if (!stat.isDirectory()) throw new Error('--profiles-dir must point to an existing managed browser directory.')
  const entries = readdirSync(resolved).map((name) => {
    if (name.startsWith(isolationPrefix)) {
      throw new Error(`An unfinished vault reset isolation directory exists at ${join(resolved, name)}. Keep both services stopped. Inspect the offline vault.reset audit for reset_id ${name.slice(isolationPrefix.length)}: discard the isolation directory if committed; restore its connection directories only after confirming rollback. Resolve that previous reset before retrying.`)
    }
    const entry = lstatSync(join(resolved, name))
    if (!connectionDirectory.test(name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('--profiles-dir may contain only real connection-ID directories. Refusing to remove unmanaged entries.')
    }
    return { name, stat: entry }
  })
  return { path: resolved, stat, entries }
}

function restoreProfiles(isolation: ProfileIsolation): void {
  sameDirectory(isolation.plan.path, isolation.plan.stat)
  sameDirectory(isolation.path, isolation.stat)
  // Never overwrite files a still-running browser or another process created.
  // rmdir below also refuses unexpected contents of the isolation directory.
  for (const name of [...isolation.moved].reverse()) {
    const destination = join(isolation.plan.path, name)
    try { lstatSync(destination) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      renameSync(join(isolation.path, name), destination)
      continue
    }
    throw new Error('A profile directory was recreated while restoring; refusing to overwrite it.')
  }
  rmdirSync(isolation.path)
}

function isolateProfiles(plan: ProfilePlan, resetId: string): ProfileIsolation {
  sameDirectory(plan.path, plan.stat)
  const path = join(plan.path, `${isolationPrefix}${resetId}`)
  mkdirSync(path, { mode: 0o700 })
  const isolation: ProfileIsolation = { plan, path, stat: lstatSync(path), moved: [] }
  try {
    for (const entry of plan.entries) {
      sameDirectory(plan.path, plan.stat)
      sameDirectory(join(plan.path, entry.name), entry.stat)
      renameSync(join(plan.path, entry.name), join(path, entry.name))
      isolation.moved.push(entry.name)
    }
    if (readdirSync(plan.path).some((name) => join(plan.path, name) !== path)) {
      throw new Error('The profiles directory changed during maintenance. Stop the browser before retrying.')
    }
    return isolation
  } catch (error) {
    try { restoreProfiles(isolation) }
    catch {
      throw new Error(`No database reset was committed, but browser profiles could not be fully restored. Keep both services stopped. Restore the remaining connection directories from ${path} to ${plan.path} without overwriting existing entries, then remove the empty isolation directory.`)
    }
    throw error
  }
}

function objectColumn(value: unknown): Record<string, unknown> {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown }
    catch { throw new Error('A connection capability state is malformed; no reset was committed.') }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('A connection capability state is malformed; no reset was committed.')
  }
  return parsed as Record<string, unknown>
}

async function resetStatements(db: DbClient, profiles: ProfilePlan): Promise<{ statements: RawStatement[]; detail: Record<string, unknown>; entryHash: string; resetId: string }> {
  const tables = new Set((await db.rawQuery("SELECT name FROM sqlite_master WHERE type='table'") as Array<{ name: string }>).map((row) => row.name))
  const counts: Record<string, number> = {}
  const removedTables = ['credentials', 'results_cache', 'totp_secrets', 'login_sessions', 'monitor_runtime', 'monitors',
    'notification_channels', 'approvals', 'og_action_approvals']
  for (const table of [...removedTables, 'tasks', 'action_proposals', 'connections']) {
    const [row] = tables.has(table) ? await db.rawQuery(`SELECT COUNT(*) AS count FROM ${table}`) as Array<{ count: number }> : []
    counts[table] = row?.count ?? 0
  }
  const at = new Date().toISOString()
  const statements: RawStatement[] = removedTables.filter((table) => tables.has(table)).map((table) => ({ sql: `DELETE FROM ${table}` }))
  statements.push(
    { sql: 'UPDATE admin_users SET totp_enabled=0' },
    { sql: `INSERT INTO task_events(task_id,event,detail,at)
        SELECT id,'vault_reset',?,? FROM tasks`, params: [JSON.stringify({ reason: 'master_key_lost', payloads_discarded: true, retryable: false }), at] },
    { sql: `UPDATE tasks SET input='{}',input_ciphertext=NULL,result_ciphertext=NULL,
        cancellation=CASE WHEN status='pending' THEN ? WHEN status='running' THEN ? ELSE cancellation END,
        cancel_requested_at=CASE WHEN status IN ('pending','running') THEN ? ELSE cancel_requested_at END,
        finished_at=CASE WHEN status IN ('pending','running') THEN ? ELSE finished_at END,
        status=CASE WHEN status='pending' THEN 'cancelled' WHEN status='running' THEN 'unknown_outcome' ELSE status END,
        safe_retry=0,available_at=NULL,lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL`, params: [
      JSON.stringify({ state: 'cancelled_before_send', remote_confirmed: false, may_continue_remote: false }),
      JSON.stringify({ state: 'cancelled_local', remote_confirmed: false, may_continue_remote: true }), at, at] },
    { sql: `UPDATE action_proposals SET input='{}',
        status=CASE WHEN status='running' THEN 'unknown_outcome' WHEN status IN ('pending','approved','stale') THEN 'rejected' ELSE status END` },
    { sql: 'CREATE TABLE IF NOT EXISTS og_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)' },
    { sql: "INSERT INTO og_settings(key,value) VALUES('actions_paused','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value" },
  )
  if (tables.has('og_action_meta')) statements.push({ sql: 'UPDATE og_action_meta SET result=NULL' })
  if (tables.has('og_action_claims')) statements.push({ sql: 'UPDATE og_action_claims SET token=NULL' })
  if (tables.has('og_vault_meta')) statements.push({ sql: "DELETE FROM og_vault_meta WHERE key='key_check'" })
  const connections = await db.rawQuery('SELECT id,capability_states FROM connections') as Array<{ id: string; capability_states: string }>
  for (const connection of connections) {
    const states = Object.fromEntries(Object.entries(objectColumn(connection.capability_states)).map(([id, state]) =>
      [id, state && typeof state === 'object' && (state as Record<string, unknown>)['status'] === 'disabled'
        ? state : { status: 'needs_auth', reason: '保险库已重置，请重新配置凭据并验证', probed_at: at }]))
    statements.push({ sql: 'UPDATE connections SET paused=1,capability_states=?,updated_at=? WHERE id=?',
      params: [JSON.stringify(states), at, connection.id], expectChanges: 1 })
  }
  const resetId = randomUUID()
  const detail = { reset_id: resetId, via: 'offline_cli', reason: 'master_key_lost', removed_rows: Object.fromEntries(removedTables.map((table) => [table, counts[table]])),
    task_payloads_discarded: counts['tasks'], proposal_payloads_discarded: counts['action_proposals'],
    connections_paused: counts['connections'], browser_profiles_discarded: profiles.entries.length,
    totp_disabled: true, actions_paused: true }
  const [last] = await db.rawQuery('SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1') as Array<{ entry_hash: string }>
  const previous = last?.entry_hash ?? '0'
  const entry = { action: 'vault.reset', client_id: null, target: 'vault', detail, at }
  const hash = createHash('sha256').update(`${previous}|${JSON.stringify(entry)}`).digest('hex')
  statements.push({ sql: `INSERT INTO audit_log(action,client_id,target,detail,prev_hash,entry_hash,at)
      SELECT ?,NULL,?,?,?,?,? WHERE COALESCE((SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1),'0')=?`,
    params: [entry.action, entry.target, JSON.stringify(detail), previous, hash, at, previous], expectChanges: 1 })
  return { statements, detail, entryHash: hash, resetId }
}

export function createVaultCommand(): Command {
  const vaultCommand = new Command('vault').description('离线维护：加密数据库密钥与恢复')
  vaultCommand.action(() => { vaultCommand.outputHelp() })

vaultCommand.command('rekey')
  .description('Rotate all encrypted records atomically while the server is stopped')
  .requiredOption('--db <path>', 'Existing owngate SQLite database')
  .requiredOption('--old-key-file <path>', 'Private file containing the current 64-character hexadecimal key')
  .requiredOption('--new-key-file <path>', 'Private new key file; generated securely if it does not exist')
  .action(async (options: { db: string; oldKeyFile: string; newKeyFile: string }) => {
    const dbPath = resolve(options.db)
    const oldPath = resolve(options.oldKeyFile)
    const newPath = resolve(options.newKeyFile)
    if (!existsSync(dbPath) || !statSync(dbPath).isFile()) throw new Error('--db must point to an existing SQLite database.')
    if (oldPath === newPath) throw new Error('Use separate old and new key files so the current key is retained until rotation succeeds.')
    const oldKey = readKey(oldPath)
    const oldVault = new Vault(oldKey)
    const db = new DbClient(dbPath)
    try {
      const lease = await acquireDbLease(db, { mode: 'maintenance' })
      lease.start(() => {})
      try {
        // The new key is durable before the transaction can reference it.
        // Keep both files even on failure: a commit acknowledgement can fail.
        const newKey = existsSync(newPath) ? readKey(newPath) : createKey(newPath)
        if (oldKey.toLowerCase() === newKey.toLowerCase()) throw new Error('The new master key must differ from the old key.')
        const result = await rekeyEncryptedRecords(db, oldVault, new Vault(newKey), { heartbeat: () => lease.renew() })
        console.log(JSON.stringify({ status: 'rekeyed', records: result.upgraded, new_key_file: newPath,
          next_step: 'Point MASTER_KEY_HEX_FILE to the new key file before restarting the server. Retain the old key for old backups.' }, null, 2))
      } finally { await lease.release() }
    } finally { await db.close() }
  })

vaultCommand.command('reset')
  .exitOverride()
  .description('Discard encrypted data and browser logins after losing the master key; stop both server and browser first')
  .requiredOption('--db <path>', 'Existing owngate SQLite database')
  .requiredOption('--profiles-dir <path>', 'Existing dedicated browser profiles directory, mounted explicitly for offline maintenance')
  .requiredOption('--confirm', 'Confirm permanent loss of encrypted inputs, results, credentials, monitors, TOTP and browser logins')
  .action(async (options: { db: string; profilesDir: string; confirm: boolean }) => {
    const dbPath = resolve(options.db)
    if (!existsSync(dbPath) || !statSync(dbPath).isFile()) throw new Error('--db must point to an existing SQLite database.')
    const profiles = profilePlan(options.profilesDir, dbPath)
    const db = new DbClient(dbPath)
    try {
      const lease = await acquireDbLease(db, { mode: 'maintenance' })
      lease.start(() => {})
      try {
        const { statements, detail, entryHash, resetId } = await resetStatements(db, profiles)
        await lease.renew()
        const isolation = isolateProfiles(profiles, resetId)
        try {
          await lease.renew()
          await db.rawTransaction(statements)
        } catch {
          // A lost worker acknowledgement can follow a successful commit.
          // Only restore old logins after independently confirming rollback.
          let committed: boolean
          try { committed = (await db.rawQuery("SELECT entry_hash FROM audit_log WHERE action='vault.reset' AND entry_hash=?", [entryHash])).length === 1 }
          catch {
            throw new Error(`Database reset commit status is UNKNOWN. Keep server and browser stopped; leave ${isolation.path} isolated. Inspect the offline audit log for vault.reset entry_hash ${entryHash}: if present, discard the isolation directory and configure a new master key; if absent after SQLite recovery confirms rollback, restore its connection directories without overwriting existing entries. Do not restore old profiles before verifying the transaction outcome.`)
          }
          if (!committed) {
            try { restoreProfiles(isolation) }
            catch {
              throw new Error(`Database reset failed and was rolled back, but browser profiles could not be fully restored. Keep both services stopped. Restore the remaining connection directories from ${isolation.path} to ${profiles.path} without overwriting existing entries, then remove the empty isolation directory.`)
            }
            throw new Error('Database reset failed and was rolled back; browser profiles were restored. No encrypted data was reset. Resolve the database or audit failure and retry while both services remain stopped.')
          }
        }
        try {
          sameDirectory(profiles.path, profiles.stat)
          sameDirectory(isolation.path, isolation.stat)
          if (readdirSync(profiles.path).some((name) => join(profiles.path, name) !== isolation.path)) {
            throw new Error('The browser recreated profile directories during maintenance.')
          }
          await rm(isolation.path, { recursive: true, force: false })
          sameDirectory(profiles.path, profiles.stat)
          if (readdirSync(profiles.path).length !== 0) throw new Error('The browser recreated profiles during cleanup.')
        } catch {
          throw new Error(`Database reset COMMITTED, but browser profile cleanup is incomplete. Isolation path: ${isolation.path} (it may already have been removed). Keep server and browser stopped. Remove any remaining isolation directory and newly recreated connection profiles from the managed directory before restarting; do not restore old profiles. Configure a new master key before restarting the server.`)
        }
        console.log(JSON.stringify({ status: 'vault_reset', ...detail, browser_profiles_cleared: true,
          next_step: 'Configure a new master key before restarting. Sign in again; reconfigure TOTP, credentials, SMTP and monitors. Reauthenticate and verify each paused connection before resuming it. Admin passwords, Passkeys, client tokens and grants were retained; historical encrypted inputs and results were discarded.' }, null, 2))
      } finally { await lease.release() }
    } finally { await db.close() }
  })

  return vaultCommand

}
