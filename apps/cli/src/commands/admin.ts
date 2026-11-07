import { Command } from 'commander'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import * as argon2 from 'argon2'
import { DbClient, acquireDbLease } from '@owngate/db'

function readPassword(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) {
      throw new Error('The password file must be a regular file private to its current owner (mode 0600 or 0400).')
    }
    if (stat.size > 4096) throw new Error('The password file is too large.')
    // Shell-created files usually end in one newline; preserve password spaces.
    const password = readFileSync(fd, 'utf8').replace(/\r?\n$/, '')
    if (password.length < 8 || /[\r\n\0]/.test(password)) throw new Error('The password file must contain one password of at least eight characters.')
    return password
  } finally { closeSync(fd) }
}

export function createAdminCommand(): Command {
  const adminCommand = new Command('admin').description('离线维护：管理员账户恢复')
  adminCommand.action(() => { adminCommand.outputHelp() })

adminCommand.command('reset-password')
  .description('Reset an existing administrator password atomically while the server is stopped')
  .requiredOption('--db <path>', 'Existing owngate SQLite database')
  .requiredOption('--username <username>', 'Existing administrator username')
  .requiredOption('--password-file <path>', 'Private file containing the new password')
  .option('--reset-passkeys', 'Also remove this administrator’s registered passkeys')
  .action(async (options: { db: string; username: string; passwordFile: string; resetPasskeys?: boolean }) => {
    const dbPath = resolve(options.db)
    if (!existsSync(dbPath) || !statSync(dbPath).isFile()) throw new Error('--db must point to an existing SQLite database.')
    const password = readPassword(resolve(options.passwordFile))
    const db = new DbClient(dbPath)
    try {
      const lease = await acquireDbLease(db, { mode: 'maintenance' })
      lease.start(() => {})
      try {
        const user = await db.getAdminByUsername(options.username)
        if (!user) throw new Error('The requested administrator does not exist.')
        const passwordHash = await argon2.hash(password)
        const [last] = await db.rawQuery('SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1') as Array<{ entry_hash: string }>
        const previous = last?.entry_hash ?? '0'
        const at = new Date().toISOString()
        const detail = { via: 'offline_cli', reset_passkeys: Boolean(options.resetPasskeys) }
        const entry = { action: 'auth.password.reset', client_id: null, target: user.id, detail, at }
        const hash = createHash('sha256').update(`${previous}|${JSON.stringify(entry)}`).digest('hex')
        await lease.renew()
        await db.rawTransaction([
          { sql: 'UPDATE admin_users SET password_hash=? WHERE id=? AND password_hash=?', params: [passwordHash, user.id, user.password_hash], expectChanges: 1 },
          { sql: 'DELETE FROM login_sessions WHERE user_id=?', params: [user.id] },
          ...(options.resetPasskeys ? [{ sql: 'DELETE FROM webauthn_credentials WHERE user_id=?', params: [user.id] }] : []),
          { sql: `INSERT INTO audit_log(action,client_id,target,detail,prev_hash,entry_hash,at)
              SELECT ?,NULL,?,?,?,?,? WHERE COALESCE((SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1),'0')=?`,
            params: [entry.action, entry.target, JSON.stringify(detail), previous, hash, at, previous], expectChanges: 1 },
        ])
        console.log(JSON.stringify({ status: 'password_reset', username: user.username, sessions_revoked: true,
          passkeys_reset: Boolean(options.resetPasskeys), next_step: 'Restart the server and sign in with the new password.' }, null, 2))
      } finally { await lease.release() }
    } finally { await db.close() }
  })

  return adminCommand

}
