import { createHash, randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import type { DbClient } from '@owngate/db';
import type { Vault } from '@owngate/vault';
import { vaultContext } from '@owngate/vault';
import type { Capability, Connection, InvokeOptions, InvokeServices } from '@owngate/core';
import { isCapabilityRoleAllowed, isClientExpired } from '@owngate/core';

export type ActionCaller = { kind: 'client'; client_id: string } | { kind: 'admin'; user_id: string };
export class ActionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
interface StoredProposal {
  id: string; client_id: string; connection_id: string; capability_id: string;
  input: string; normalized_hash: string; status: string; created_at: string;
  revision: string; expires_at: string; result: string | null;
}
export interface ProposalView extends Omit<StoredProposal, 'input' | 'result'> {
  input: unknown; result: unknown; target: { label: string; connector_id: string };
  effect: string; production_execution_enabled: false;
}
interface ActionDeps {
  db: DbClient; vault: Vault; services: InvokeServices; invokeOpts: InvokeOptions;
  /** Tests can exercise unknown outcomes; production never supplies this. */
  testExecutor?: (connection: Connection, capability: Capability, input: unknown, idempotencyKey: string) => Promise<unknown>;
}
const validator = new Ajv({ strict: false, validateFormats: false });
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]));
  return value;
}
function future(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time > Date.now();
}
export function proposalHash(connection: string, capability: string, input: unknown, revision: string): string {
  return createHash('sha256').update(JSON.stringify([connection, capability, sorted(input), revision])).digest('hex');
}

export class ActionService {
  constructor(private readonly deps: ActionDeps) {}
  async init() {
    await this.deps.db.rawRun(`CREATE TABLE IF NOT EXISTS og_action_meta (
      proposal_id TEXT PRIMARY KEY REFERENCES action_proposals(id) ON DELETE CASCADE,
      revision TEXT NOT NULL, expires_at TEXT NOT NULL, result TEXT)`);
    await this.deps.db.rawRun(`CREATE TABLE IF NOT EXISTS og_action_approvals (
      proposal_id TEXT PRIMARY KEY, method TEXT NOT NULL, expires_at TEXT NOT NULL)`);
    await this.deps.db.rawRun(`CREATE TABLE IF NOT EXISTS og_action_claims (
      proposal_id TEXT PRIMARY KEY REFERENCES action_proposals(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL DEFAULT 0, token TEXT, claimed_at TEXT NOT NULL)`);
    await this.deps.db.rawRun(`CREATE TABLE IF NOT EXISTS og_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await this.deps.db.rawRun(`INSERT OR IGNORE INTO og_settings(key,value) VALUES ('actions_paused','true')`);
    // The previous process may have sent a request before crashing. Startup
    // cannot infer its remote outcome and must never enqueue another attempt.
    const interrupted = await this.deps.db.rawQuery("SELECT id FROM action_proposals WHERE status='running'") as Array<{ id: string }>;
    for (const { id } of interrupted) {
      const result = JSON.stringify(this.deps.vault.encryptJSON({ code: 'OUTCOME_UNKNOWN', retryable: false, reason: 'interrupted_execution' }, vaultContext.action(id, 'result')));
      const [changed] = await this.deps.db.rawTransaction([
        { sql: "UPDATE action_proposals SET status='unknown_outcome' WHERE id=? AND status='running'", params: [id] },
        { sql: 'UPDATE og_action_meta SET result=? WHERE proposal_id=? AND changes()=1', params: [result, id] },
        { sql: "UPDATE og_action_claims SET token=NULL WHERE proposal_id=? AND EXISTS (SELECT 1 FROM action_proposals WHERE id=? AND status='unknown_outcome')", params: [id, id] },
      ]);
      if ((changed as { changes: number }).changes === 1) await this.audit('action.unknown_outcome', id, { kind: 'admin', user_id: 'system:startup' }, { reason: 'interrupted_execution', retryable: false });
    }
  }
  private sanitize<T>(v: T): T { return (this.deps.invokeOpts.sanitize?.(v) ?? v) as T; }
  private access(connectionId: string, capabilityId: string, caller: ActionCaller): { connection: Connection; capability: Capability } {
    const { services } = this.deps;
    if (caller.kind === 'client') {
      const client = services.auth.getClientById?.(caller.client_id);
      if (!client || client.revoked || isClientExpired(client)) throw new ActionError('CLIENT_REVOKED', '客户端已失效', 401);
      const grant = services.auth.getGrants(client.id).find((g) => g.connection_id === connectionId);
      if (!grant?.capabilities.includes(`propose:${capabilityId}`)) throw new ActionError('PERMISSION_DENIED', '没有此能力的提案权限', 403);
    }
    const connection = services.connections.get(connectionId);
    if (!connection) throw new ActionError('CONNECTION_NOT_FOUND', '连接不存在', 404);
    const capability = services.capabilities.get(connection.connector_id, capabilityId);
    if (!capability || capability.kind !== 'action' || capability.effect === 'read') throw new ActionError('CAPABILITY_NOT_FOUND', '此能力不是操作能力', 404);
    if (!isCapabilityRoleAllowed(connection, capability)) throw new ActionError('PERMISSION_DENIED', '当前连接角色不可使用此操作能力', 403);
    return { connection, capability };
  }
  private async stored(id: string): Promise<StoredProposal> {
    const [row] = await this.deps.db.rawQuery(`SELECT p.*,m.revision,m.expires_at,m.result FROM action_proposals p JOIN og_action_meta m ON m.proposal_id=p.id WHERE p.id=?`, [id]);
    if (!row) throw new ActionError('PROPOSAL_NOT_FOUND', '提案不存在', 404);
    return row as StoredProposal;
  }
  private checkOwner(row: StoredProposal, caller: ActionCaller) {
    if (caller.kind === 'client' && row.client_id !== caller.client_id) throw new ActionError('PERMISSION_DENIED', '不可访问其他客户端的提案', 403);
    return this.access(row.connection_id, row.capability_id, caller);
  }
  private decode(row: StoredProposal, connection: Connection, capability: Capability): ProposalView {
    return this.sanitize({ ...row, input: this.deps.vault.decryptJSON(JSON.parse(row.input), vaultContext.action(row.id, 'input')),
      result: row.result ? this.deps.vault.decryptJSON(JSON.parse(row.result), vaultContext.action(row.id, 'result')) : null,
      target: { label: connection.label, connector_id: connection.connector_id }, effect: capability.effect, production_execution_enabled: false as const });
  }
  async submit(req: { connection_id: string; capability_id: string; input: unknown }, caller: ActionCaller) {
    const { connection, capability } = this.access(req.connection_id, req.capability_id, caller);
    if (!validator.validate(capability.input, req.input)) throw new ActionError('INVALID_PARAMS', '参数不符合能力定义');
    const id = randomUUID(), now = new Date().toISOString(), expires = new Date(Date.now() + 15 * 60_000).toISOString();
    const hash = proposalHash(connection.id, capability.id, req.input, connection.updated_at);
    await this.deps.db.rawTransaction([
      { sql: `INSERT INTO action_proposals(id,client_id,connection_id,capability_id,input,normalized_hash,status,created_at) VALUES (?,?,?,?,?,?,'pending',?)`, params: [id, caller.kind === 'client' ? caller.client_id : `admin:${caller.user_id}`, connection.id, capability.id, JSON.stringify(this.deps.vault.encryptJSON(req.input, vaultContext.action(id, 'input'))), hash, now] },
      { sql: `INSERT INTO og_action_meta(proposal_id,revision,expires_at) VALUES (?,?,?)`, params: [id, connection.updated_at, expires] },
    ]);
    await this.audit('action.proposed', id, caller, { hash });
    return this.get(id, caller);
  }
  async get(id: string, caller: ActionCaller) {
    let row = await this.stored(id);
    this.checkOwner(row, caller);
    if ((row.status === 'pending' || row.status === 'approved') && !future(row.expires_at)) {
      await this.deps.db.rawRun(`UPDATE action_proposals SET status='expired' WHERE id=? AND status IN ('pending','approved')
        AND EXISTS (SELECT 1 FROM og_action_meta WHERE proposal_id=? AND (julianday(expires_at) IS NULL OR julianday(expires_at)<=julianday('now')))`, [id, id]);
      row = await this.stored(id);
    }
    const { connection, capability } = this.checkOwner(row, caller);
    return this.decode(row, connection, capability);
  }
  async list(caller: ActionCaller) {
    const rows = await this.deps.db.rawQuery(`SELECT id FROM action_proposals ${caller.kind === 'client' ? 'WHERE client_id=?' : ''} ORDER BY created_at DESC LIMIT 100`, caller.kind === 'client' ? [caller.client_id] : []);
    const out: ProposalView[] = [];
    for (const row of rows as { id: string }[]) { try { out.push(await this.get(row.id, caller)); } catch (e) { if (!(e instanceof ActionError)) throw e; } }
    return out;
  }
  async update(id: string, input: unknown, caller: ActionCaller) {
    const row = await this.stored(id), { connection, capability } = this.checkOwner(row, caller);
    if (!['pending', 'approved', 'stale'].includes(row.status)) throw new ActionError('INVALID_STATE', '当前提案不能修改', 409);
    if (!validator.validate(capability.input, input)) throw new ActionError('INVALID_PARAMS', '参数不符合能力定义');
    const hash = proposalHash(connection.id, capability.id, input, connection.updated_at);
    const [changed] = await this.deps.db.rawTransaction([
      { sql: `UPDATE action_proposals SET input=?,normalized_hash=?,status='pending' WHERE id=? AND normalized_hash=? AND status IN ('pending','approved','stale')`, params: [JSON.stringify(this.deps.vault.encryptJSON(input, vaultContext.action(id, 'input'))), hash, id, row.normalized_hash], expectChanges: 1 },
      { sql: `UPDATE og_action_meta SET revision=?,expires_at=? WHERE proposal_id=? AND EXISTS (SELECT 1 FROM action_proposals WHERE id=? AND normalized_hash=? AND status='pending')`, params: [connection.updated_at, new Date(Date.now() + 900_000).toISOString(), id, id, hash] },
      { sql: `DELETE FROM approvals WHERE proposal_id=? AND EXISTS (SELECT 1 FROM action_proposals WHERE id=? AND normalized_hash=? AND status='pending')`, params: [id, id, hash] },
      { sql: `DELETE FROM og_action_approvals WHERE proposal_id=? AND EXISTS (SELECT 1 FROM action_proposals WHERE id=? AND normalized_hash=? AND status='pending')`, params: [id, id, hash] },
    ]).catch(() => { throw new ActionError('INVALID_STATE', '提案已变更，请重新读取', 409); });
    if ((changed as { changes: number }).changes !== 1) throw new ActionError('INVALID_STATE', '提案已被其他请求修改，请重新读取', 409);
    await this.audit('action.content_changed', id, caller, { hash });
    return this.get(id, caller);
  }
  async approve(id: string, expectedHash: string, userId: string, method: 'passkey' | 'totp') {
    const row = await this.stored(id), caller: ActionCaller = { kind: 'admin', user_id: userId };
    const { connection } = this.checkOwner(row, caller);
    if (connection.paused) throw new ActionError('CAPABILITY_DISABLED', '连接已暂停', 409);
    if (row.status !== 'pending') throw new ActionError('INVALID_STATE', '提案不在待批准状态', 409);
    if (!future(row.expires_at)) throw new ActionError('APPROVAL_EXPIRED', '提案已过期', 409);
    if (row.normalized_hash !== expectedHash || row.revision !== connection.updated_at) throw new ActionError('APPROVAL_CONTENT_CHANGED', '内容或连接配置已变更，请重新提交', 409);
    const expires = new Date(Date.now() + 900_000).toISOString();
    const [changed] = await this.deps.db.rawTransaction([
      { sql: `UPDATE action_proposals SET status='approved' WHERE id=? AND normalized_hash=? AND status='pending'
        AND EXISTS (SELECT 1 FROM connections WHERE id=? AND updated_at=? AND paused=0)
        AND EXISTS (SELECT 1 FROM og_action_meta WHERE proposal_id=? AND revision=? AND julianday(expires_at)>julianday('now'))`, params: [id, expectedHash, connection.id, row.revision, id, row.revision], expectChanges: 1 },
      { sql: `INSERT INTO approvals(proposal_id,approved_by,approved_hash) SELECT id,?,normalized_hash FROM action_proposals WHERE id=? AND status='approved' AND normalized_hash=?`, params: [userId, id, expectedHash], expectChanges: 1 },
      { sql: `INSERT OR REPLACE INTO og_action_approvals(proposal_id,method,expires_at) VALUES (?,?,?)`, params: [id, method, expires], expectChanges: 1 },
    ]).catch(() => { throw new ActionError('APPROVAL_CONTENT_CHANGED', '提案或连接已变更，请重新读取', 409); });
    if ((changed as { changes: number }).changes !== 1) throw new ActionError('APPROVAL_CONTENT_CHANGED', '提案已变更，请重新读取', 409);
    await this.audit('action.approved', id, caller, { hash: expectedHash, method });
    return this.get(id, caller);
  }
  async reject(id: string, caller: ActionCaller) {
    const row = await this.stored(id); this.checkOwner(row, caller);
    if (caller.kind !== 'admin') throw new ActionError('PERMISSION_DENIED', '只能在后台拒绝提案', 403);
    await this.deps.db.rawRun(`UPDATE action_proposals SET status='rejected' WHERE id=? AND status IN ('pending','approved')`, [id]);
    await this.audit('action.rejected', id, caller, {});
    return this.get(id, caller);
  }
  async pause(caller: ActionCaller) {
    await this.deps.db.rawRun(`INSERT OR REPLACE INTO og_settings(key,value) VALUES ('actions_paused','true')`);
    await this.audit('actions.paused', 'all', caller, {});
    return { paused: true, production_execution_enabled: false };
  }
  async execute(id: string, caller: ActionCaller) {
    const row = await this.stored(id), { connection, capability } = this.checkOwner(row, caller);
    // This guard cannot be changed through HTTP, settings or approvals.
    if (!this.deps.testExecutor) throw new ActionError('CAPABILITY_DISABLED', '本期不开放任何站点写操作', 409);
    if (row.status === 'executed' || row.status === 'unknown_outcome') return this.get(id, caller);
    const [setting] = await this.deps.db.rawQuery("SELECT value FROM og_settings WHERE key='actions_paused'");
    if ((setting as { value: string } | undefined)?.value !== 'false') throw new ActionError('CAPABILITY_DISABLED', '全部写操作已停止', 409);
    const [approval] = await this.deps.db.rawQuery(`SELECT a.id,a.approved_hash,m.expires_at FROM approvals a JOIN og_action_approvals m ON m.proposal_id=a.proposal_id WHERE a.proposal_id=? ORDER BY a.id DESC LIMIT 1`, [id]);
    const signed = approval as { id: number; approved_hash: string; expires_at: string } | undefined;
    if (!signed || row.status !== 'approved') throw new ActionError('APPROVAL_REQUIRED', '需要人工批准', 409);
    if (!future(signed.expires_at) || !future(row.expires_at)) throw new ActionError('APPROVAL_EXPIRED', '提案或批准已过期', 409);
    const input = this.deps.vault.decryptJSON(JSON.parse(row.input), vaultContext.action(id, 'input'));
    if (signed.approved_hash !== row.normalized_hash || row.revision !== connection.updated_at || signed.approved_hash !== proposalHash(row.connection_id, row.capability_id, input, connection.updated_at)) throw new ActionError('APPROVAL_CONTENT_CHANGED', '批准绑定的内容或连接已变更', 409);
    if (connection.paused) throw new ActionError('CAPABILITY_DISABLED', '连接已暂停', 409);
    this.checkOwner(row, caller);
    const token = randomUUID();
    const clientGate = caller.kind === 'client' ? `AND EXISTS (
      SELECT 1 FROM clients c JOIN grants g ON g.client_id=c.id JOIN json_each(g.capabilities) permission
      WHERE c.id=? AND c.revoked=0 AND (c.expires_at IS NULL OR julianday(c.expires_at)>julianday('now'))
        AND g.connection_id=action_proposals.connection_id AND permission.value=?)` : '';
    const [, claimed] = await this.deps.db.rawTransaction([
      { sql: `UPDATE action_proposals SET status='running' WHERE id=? AND status='approved' AND connection_id=? AND capability_id=? AND normalized_hash=? AND input=?
        AND EXISTS (SELECT 1 FROM og_settings WHERE key='actions_paused' AND value='false')
        AND EXISTS (SELECT 1 FROM connections WHERE id=action_proposals.connection_id AND updated_at=? AND paused=0)
        AND EXISTS (SELECT 1 FROM og_action_meta WHERE proposal_id=action_proposals.id AND revision=? AND julianday(expires_at)>julianday('now'))
        AND EXISTS (SELECT 1 FROM approvals a JOIN og_action_approvals m ON m.proposal_id=a.proposal_id
          WHERE a.proposal_id=action_proposals.id AND a.id=? AND a.approved_hash=action_proposals.normalized_hash
            AND a.id=(SELECT MAX(latest.id) FROM approvals latest WHERE latest.proposal_id=action_proposals.id)
            AND m.method IN ('passkey','totp') AND julianday(m.expires_at)>julianday('now')) ${clientGate}`,
        params: [id, connection.id, capability.id, row.normalized_hash, row.input, row.revision, row.revision, signed.id,
          ...(caller.kind === 'client' ? [caller.client_id, `propose:${capability.id}`] : [])], expectChanges: 1 },
      { sql: `INSERT INTO og_action_claims(proposal_id,attempt,token,claimed_at) VALUES (?,1,?,?)
          ON CONFLICT(proposal_id) DO UPDATE SET attempt=og_action_claims.attempt+1,token=excluded.token,claimed_at=excluded.claimed_at
          RETURNING attempt`, params: [id, token, new Date().toISOString()], mode: 'get' },
    ]).catch(() => { throw new ActionError('INVALID_STATE', '提案、批准或执行开关已变更，请重新读取', 409); });
    const attempt = (claimed as { attempt: number }).attempt;
    let status: string, result: unknown;
    try { result = await this.deps.testExecutor(connection, capability, input, row.normalized_hash); status = 'executed'; }
    catch { status = 'unknown_outcome'; result = { code: 'OUTCOME_UNKNOWN', retryable: false }; }
    let encrypted: string;
    try { encrypted = JSON.stringify(this.deps.vault.encryptJSON(this.sanitize(result ?? null), vaultContext.action(id, 'result'))); }
    catch { status = 'unknown_outcome'; encrypted = JSON.stringify(this.deps.vault.encryptJSON({ code: 'OUTCOME_UNKNOWN', retryable: false }, vaultContext.action(id, 'result'))); }
    const [completed] = await this.deps.db.rawTransaction([
      { sql: `UPDATE action_proposals SET status=? WHERE id=? AND status='running' AND normalized_hash=?
        AND EXISTS (SELECT 1 FROM og_action_meta WHERE proposal_id=? AND revision=?)
        AND EXISTS (SELECT 1 FROM og_action_claims WHERE proposal_id=? AND attempt=? AND token=?)`, params: [status, id, row.normalized_hash, id, row.revision, id, attempt, token] },
      { sql: `UPDATE og_action_meta SET result=? WHERE proposal_id=? AND changes()=1`, params: [encrypted, id] },
      { sql: `UPDATE og_action_claims SET token=NULL WHERE proposal_id=? AND attempt=? AND token=? AND changes()=1`, params: [id, attempt, token] },
    ]);
    if ((completed as { changes: number }).changes === 1) await this.audit(`action.${status}`, id, caller, { hash: row.normalized_hash, attempt });
    return this.get(id, caller);
  }
  private async audit(action: string, id: string, caller: ActionCaller, detail: unknown) {
    await this.deps.services.audit.append({ action, target: id, client_id: caller.kind === 'client' ? caller.client_id : undefined, detail: this.sanitize({ actor: caller, detail }) });
  }
}
