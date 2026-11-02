// DbClient — main-thread proxy to the DB worker_thread.
// All calls are async; the worker executes them synchronously via better-sqlite3.

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { DbRequest, DbResponse } from './types.js';
import type * as schema from './schema.js';

type AdminUserRow = typeof schema.admin_users.$inferSelect;
type WebauthnCredentialRow = typeof schema.webauthn_credentials.$inferSelect;
type TotpSecretRow = typeof schema.totp_secrets.$inferSelect;
type LoginSessionRow = typeof schema.login_sessions.$inferSelect;

const __dirname = dirname(fileURLToPath(import.meta.url));

// In production (after build), the worker is at dist/worker.js.
// In tests (ts-node / vitest), we use the TypeScript source via tsx/register.
function resolveWorkerPath(): string {
  if (process.env['WEBRIDGE_DB_WORKER_PATH']) {
    return process.env['WEBRIDGE_DB_WORKER_PATH'];
  }
  return resolve(__dirname, 'worker.js');
}

function resolveWorkerOptions(): { execArgv?: string[] } {
  // In test/dev environments the worker path may be a .ts file — run via tsx
  if (process.env['WEBRIDGE_DB_WORKER_PATH']?.endsWith('.ts')) {
    return { execArgv: ['--import', 'tsx/esm'] };
  }
  return {};
}

export class DbClient {
  private worker: Worker;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private ready: Promise<void>;

  constructor(dbPath: string) {
    this.worker = new Worker(resolveWorkerPath(), {
      workerData: { dbPath },
      ...resolveWorkerOptions(),
    });

    this.worker.on('message', (resp: DbResponse) => {
      const p = this.pending.get(resp.id);
      if (!p) return;
      this.pending.delete(resp.id);
      if (resp.ok) {
        p.resolve(resp.result);
      } else {
        p.reject(new Error(resp.error ?? 'DB worker error'));
      }
    });

    this.worker.on('error', (err: Error) => {
      // Reject all pending requests on worker crash
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });

    // Worker is ready as soon as it is created (better-sqlite3 opens synchronously)
    this.ready = Promise.resolve();
  }

  private call<T>(method: string, args: unknown = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const req: DbRequest = { id, method, args };
      this.worker.postMessage(req);
    });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }

  // ── Connectors ────────────────────────────────────────────
  upsertConnector(args: { id: string; version: string; title: string; transport: string; manifest: unknown }) {
    return this.call('upsertConnector', args);
  }
  listConnectors() {
    return this.call<unknown[]>('listConnectors');
  }

  // ── Connections ───────────────────────────────────────────
  createConnection(args: { id: string; connector_id: string; label: string; config: unknown; capability_states?: unknown }) {
    return this.call('createConnection', args);
  }
  getConnection(id: string) {
    return this.call<unknown | undefined>('getConnection', { id });
  }
  listConnections() {
    return this.call<unknown[]>('listConnections');
  }
  updateConnectionStates(id: string, capability_states: unknown, updated_at: string) {
    return this.call('updateConnectionStates', { id, capability_states, updated_at });
  }

  // ── Clients ────────────────────────────────────────────────
  createClient(args: { id: string; label: string; kind: string; token_hash: string }) {
    return this.call('createClient', args);
  }
  getClientByToken(token_hash: string) {
    return this.call<unknown | undefined>('getClientByToken', { token_hash });
  }
  revokeClient(id: string) {
    return this.call('revokeClient', { id });
  }

  // ── Grants ─────────────────────────────────────────────────
  upsertGrant(args: { client_id: string; connection_id: string; capabilities: unknown }) {
    return this.call('upsertGrant', args);
  }
  getGrants(client_id: string) {
    return this.call<unknown[]>('getGrants', { client_id });
  }

  // ── Tasks ──────────────────────────────────────────────────
  createTask(args: { id: string; client_id: string; connection_id: string; capability_id: string; input: unknown; status: string }) {
    return this.call('createTask', args);
  }
  updateTaskStatus(id: string, status: string, started_at?: string, finished_at?: string) {
    return this.call('updateTaskStatus', { id, status, started_at, finished_at });
  }
  getTask(id: string) {
    return this.call<unknown | undefined>('getTask', { id });
  }

  // ── Cache ──────────────────────────────────────────────────
  getCacheEntry(key: string) {
    return this.call<unknown | undefined>('getCacheEntry', { key });
  }
  setCacheEntry(args: { key: string; ciphertext: string; iv: string; auth_tag: string; expires_at: string }) {
    return this.call('setCacheEntry', args);
  }
  deleteCacheEntry(key: string) {
    return this.call('deleteCacheEntry', { key });
  }

  // ── Audit log ──────────────────────────────────────────────
  appendAuditLog(args: { action: string; client_id?: string | undefined; target?: string | undefined; detail?: unknown; prev_hash: string; entry_hash: string }) {
    return this.call('appendAuditLog', args);
  }
  getLastAuditEntry() {
    return this.call<unknown | undefined>('getLastAuditEntry');
  }

  // ── Admin auth ─────────────────────────────────────────────
  getAdminByUsername(username: string) {
    return this.call<AdminUserRow | undefined>('getAdminByUsername', { username });
  }
  getAdminById(id: string) {
    return this.call<AdminUserRow | undefined>('getAdminById', { id });
  }
  countAdminUsers() {
    return this.call<number>('countAdminUsers');
  }
  createAdminUser(args: { id: string; username: string; password_hash: string }) {
    return this.call<AdminUserRow>('createAdminUser', args);
  }
  updateAdminPassword(args: { id: string; password_hash: string }) {
    return this.call<AdminUserRow>('updateAdminPassword', args);
  }
  setTotpEnabled(args: { id: string; totp_enabled: boolean }) {
    return this.call<AdminUserRow>('setTotpEnabled', args);
  }

  // TOTP secrets (ciphertext produced by Vault)
  getTotpSecret(user_id: string) {
    return this.call<TotpSecretRow | undefined>('getTotpSecret', { user_id });
  }
  upsertTotpSecret(args: { user_id: string; ciphertext: string; iv: string; auth_tag: string }) {
    return this.call<TotpSecretRow>('upsertTotpSecret', args);
  }
  deleteTotpSecret(user_id: string) {
    return this.call<TotpSecretRow | undefined>('deleteTotpSecret', { user_id });
  }

  // WebAuthn credentials
  listWebauthnCredentials(user_id: string) {
    return this.call<WebauthnCredentialRow[]>('listWebauthnCredentials', { user_id });
  }
  getWebauthnCredentialByCredentialId(credential_id: string) {
    return this.call<WebauthnCredentialRow | undefined>('getWebauthnCredentialByCredentialId', { credential_id });
  }
  insertWebauthnCredential(args: {
    id: string; user_id: string; credential_id: string; public_key: string;
    counter: number; transports: unknown;
  }) {
    return this.call<WebauthnCredentialRow>('insertWebauthnCredential', args);
  }
  updateWebauthnCounter(args: { credential_id: string; counter: number }) {
    return this.call<WebauthnCredentialRow>('updateWebauthnCounter', args);
  }
  deleteWebauthnCredential(args: { id: string; user_id: string }) {
    return this.call<WebauthnCredentialRow | undefined>('deleteWebauthnCredential', args);
  }

  // Login sessions
  insertLoginSession(args: { id: string; user_id: string; expires_at: string }) {
    return this.call<LoginSessionRow>('insertLoginSession', args);
  }
  getLoginSession(id: string) {
    return this.call<LoginSessionRow | undefined>('getLoginSession', { id });
  }
  deleteLoginSession(id: string) {
    return this.call<LoginSessionRow | undefined>('deleteLoginSession', { id });
  }
  deleteLoginSessionsForUser(user_id: string) {
    return this.call<LoginSessionRow[]>('deleteLoginSessionsForUser', { user_id });
  }
  deleteExpiredLoginSessions(now: string) {
    return this.call<LoginSessionRow[]>('deleteExpiredLoginSessions', { now });
  }

  // ── Escape hatch for migrations ───────────────────────────
  rawQuery(sql: string, params?: unknown[]) {
    return this.call<unknown[]>('rawQuery', { sql, params });
  }
}
