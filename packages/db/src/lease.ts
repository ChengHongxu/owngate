import { randomUUID } from 'node:crypto';
import type { DbClient } from './client.js';

export interface DbLeaseOptions {
  mode: 'server' | 'maintenance';
  ttlMs?: number;
}

/** A single-owner lease, additionally enforced by every bound worker call. */
export class DbLease {
  private timer: ReturnType<typeof setInterval> | undefined;
  private released = false;
  private renewing = false;
  private lost = false;

  constructor(private readonly db: DbClient, readonly owner: string, readonly mode: DbLeaseOptions['mode'], readonly ttlMs: number) {}

  async renew(): Promise<void> {
    if (this.released || this.lost) throw new Error('Database lease is no longer active');
    const now = Date.now();
    const result = await this.db.rawRun(`UPDATE og_service_lease SET expires_at=?
      WHERE slot='primary' AND owner=? AND mode=? AND expires_at>?`, [now + this.ttlMs, this.owner, this.mode, now]);
    if (result.changes !== 1) {
      this.lost = true;
      throw new Error('Database service lease was lost or expired');
    }
  }

  start(onLost: (error: Error) => void | Promise<void>): void {
    if (this.timer || this.released || this.lost) return;
    this.timer = setInterval(() => {
      if (this.renewing || this.released) return;
      this.renewing = true;
      void this.renew().catch(async () => {
        this.lost = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        if (!this.released) await onLost(new Error('Database service lease was lost or expired'));
      }).catch(() => {}).finally(() => { this.renewing = false; });
    }, Math.max(25, Math.floor(this.ttlMs / 3)));
    this.timer.unref();
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // A takeover or closed worker is already fenced. Never erase another owner.
    try { await this.db.rawRun("DELETE FROM og_service_lease WHERE slot='primary' AND owner=?", [this.owner]); }
    catch { /* An expired owner cannot access the database anymore. */ }
  }
}

export async function acquireDbLease(db: DbClient, options: DbLeaseOptions): Promise<DbLease> {
  const ttlMs = Math.max(100, Math.min(600_000, options.ttlMs ?? 30_000));
  const owner = randomUUID();
  const now = Date.now();
  const rows = await db.rawQuery(`INSERT INTO og_service_lease(slot,owner,mode,expires_at) VALUES('primary',?,?,?)
    ON CONFLICT(slot) DO UPDATE SET owner=excluded.owner,mode=excluded.mode,expires_at=excluded.expires_at
    WHERE og_service_lease.expires_at<=? RETURNING owner`, [owner, options.mode, now + ttlMs, now]);
  if (rows.length !== 1) throw new Error('Database is owned by an active server or maintenance process. Stop it before continuing.');
  await db.bindLease(owner);
  return new DbLease(db, owner, options.mode, ttlMs);
}
