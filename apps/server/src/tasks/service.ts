import { randomUUID } from 'node:crypto';
import { invoke, err, fail, validateCapabilityInput, isCapabilityRoleAllowed, isClientExpired, filterResultEnvelope } from '@owngate/core';
import type {
  ApiError, Capability, Client, InvokeCaller, InvokeOptions, InvokeRequest, InvokeServices,
  ResultEnvelope, Task, TaskCancellation, TaskStatus,
} from '@owngate/core';
import type { DbClient } from '@owngate/db';
import { vaultContext } from '@owngate/vault';
import type { Vault, EncryptedBlob } from '@owngate/vault';

export type TaskCaller = InvokeCaller;
export interface TaskEvent { id: number; task_id: string; event: string; detail: unknown; at: string }
export interface TaskView extends Task {
  task_id: string;
  actor_kind: 'client' | 'admin';
  actor_id: string;
  result: ResultEnvelope | null;
  attempts: number;
  max_attempts: number;
  cancellation: TaskCancellation | null;
}
interface StoredTask {
  id: string; client_id: string; actor_kind: 'client' | 'admin'; actor_id: string | null;
  connection_id: string; capability_id: string; input: string; input_ciphertext: string | null;
  result_ciphertext: string | null; status: TaskStatus; created_at: string;
  started_at: string | null; finished_at: string | null; attempts: number; max_attempts: number;
  no_cache: number; safe_retry: number; available_at: string | null;
  lease_owner: string | null; lease_expires_at: string | null; cancellation: string | null;
}
export interface TaskServiceDeps {
  db: Pick<DbClient, 'rawQuery' | 'rawRun' | 'rawTransaction'>;
  vault: Vault;
  services: InvokeServices;
  invokeOpts: InvokeOptions;
  getClientById?: (id: string) => Client | undefined;
  isAdminActive?: (id: string) => boolean | Promise<boolean>;
  pollIntervalMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  maxAttempts?: number;
  concurrency?: number;
  retryDelayMs?: number;
  now?: () => number;
}

export class TaskServiceError extends Error {
  constructor(readonly statusCode: number, readonly error: ApiError) {
    super(error.message);
    this.name = 'TaskServiceError';
  }
}

/** Durable, read-only queue. A lease token fences every heartbeat and completion. */
export class TaskService {
  private readonly db: TaskServiceDeps['db'];
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly maxAttempts: number;
  private readonly concurrency: number;
  private readonly clock: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private initialized: Promise<void> | undefined;
  private ticking: Promise<void> | undefined;
  private lastHeartbeat = 0;
  private active = new Map<string, { lease: string; controller: AbortController }>();

  private cancelActive(id: string): void {
    this.active.get(id)?.controller.abort();
    this.active.delete(id);
  }

  constructor(private readonly deps: TaskServiceDeps) {
    this.db = deps.db;
    this.leaseMs = Math.max(100, deps.leaseMs ?? 30_000);
    this.heartbeatMs = Math.max(25, Math.min(deps.heartbeatMs ?? 10_000, this.leaseMs / 3));
    this.maxAttempts = Math.max(1, Math.min(10, deps.maxAttempts ?? 3));
    this.concurrency = Math.max(1, Math.min(16, deps.concurrency ?? 4));
    this.clock = deps.now ?? Date.now;
    // Keep the services object itself: invoke's connection serialization and
    // singleflight must also cover synchronous REST/admin calls.
    if (!deps.services.auth.getClientById && deps.getClientById) {
      deps.services.auth.getClientById = deps.getClientById;
    }
  }

  private timestamp(): string { return new Date(this.clock()).toISOString(); }
  private sanitize<T>(value: T): T { return (this.deps.invokeOpts.sanitize?.(value) ?? value) as T; }
  private seal(value: unknown, id: string, field: 'input' | 'result'): string { return JSON.stringify(this.deps.vault.encryptJSON(value, vaultContext.task(id, field))); }
  private open<T>(value: string, id: string, field: 'input' | 'result'): T { return this.deps.vault.decryptJSON<T>(JSON.parse(value) as EncryptedBlob, vaultContext.task(id, field)); }
  private callerId(caller: TaskCaller): string { return caller.kind === 'admin' ? caller.user_id : caller.client_id; }
  private client(id: string): Client | undefined { return (this.deps.getClientById ?? this.deps.services.auth.getClientById)?.(id); }

  private checkClient(caller: TaskCaller): Client | undefined {
    if (caller.kind === 'admin') return undefined;
    const client = this.client(caller.client_id);
    if (!client) throw new TaskServiceError(401, err('UNAUTHENTICATED', 'Invalid or expired client'));
    if (client.revoked) throw new TaskServiceError(401, err('CLIENT_REVOKED', 'This client has been revoked'));
    if (isClientExpired(client)) throw new TaskServiceError(401, err('UNAUTHENTICATED', 'Invalid or expired client'));
    return client;
  }

  private async authenticate(caller: TaskCaller): Promise<void> {
    if (caller.kind === 'admin') {
      if (!caller.user_id || (this.deps.isAdminActive && !await this.deps.isAdminActive(caller.user_id))) {
        throw new TaskServiceError(401, err('UNAUTHENTICATED', 'Admin session is no longer active'));
      }
    } else this.checkClient(caller);
  }

  private access(row: Pick<StoredTask, 'actor_kind' | 'actor_id' | 'client_id' | 'connection_id' | 'capability_id'>, caller: TaskCaller): Capability {
    this.checkClient(caller);
    if (caller.kind === 'client' && (row.actor_kind !== 'client' || (row.actor_id ?? row.client_id) !== caller.client_id)) {
      throw new TaskServiceError(403, err('PERMISSION_DENIED', 'This task belongs to another caller'));
    }
    const connection = this.deps.services.connections.get(row.connection_id);
    const capability = connection && this.deps.services.capabilities.get(connection.connector_id, row.capability_id);
    if (!connection || !capability) throw new TaskServiceError(403, err('GRANT_REVOKED', 'This task is no longer accessible'));
    if (!isCapabilityRoleAllowed(connection, capability)) throw new TaskServiceError(403, err('PERMISSION_DENIED', 'Capability is not available for the current connection role'));
    if (caller.kind === 'client') {
      const grant = this.deps.services.auth.getGrants(caller.client_id).find((g) => g.connection_id === row.connection_id);
      if (!grant || (!grant.capabilities.includes(row.capability_id) && !(grant.capabilities.includes('*') && capability.kind === 'query'))) {
        throw new TaskServiceError(403, err('GRANT_REVOKED', 'This task is no longer accessible with the current grant'));
      }
    }
    return capability;
  }

  /** Encrypt legacy task inputs before they can be served or claimed. */
  private initialize(): Promise<void> {
    this.initialized ??= (async () => {
      for (;;) {
        const rows = await this.db.rawQuery('SELECT id, input FROM tasks WHERE input_ciphertext IS NULL LIMIT 100') as Array<{ id: string; input: string }>;
        if (rows.length === 0) break;
        const writes = rows.map((row) => {
          let input: unknown = {};
          try { input = JSON.parse(row.input); } catch { /* Old corrupt inputs fail validation rather than leak. */ }
          return {
            sql: "UPDATE tasks SET input_ciphertext = ?, input = '{}', actor_id = COALESCE(actor_id, client_id) WHERE id = ? AND input_ciphertext IS NULL",
            params: [this.seal(input, row.id, 'input'), row.id],
          };
        });
        await this.db.rawTransaction(writes);
      }
    })();
    return this.initialized;
  }

  async submit(request: Omit<InvokeRequest, 'token'>, caller: TaskCaller): Promise<{ task_id: string; status: 'pending' }> {
    await this.authenticate(caller);
    await this.initialize();
    const owner = this.callerId(caller);
    const row = { actor_kind: caller.kind, actor_id: owner, client_id: caller.kind === 'client' ? owner : '',
      connection_id: request.connection_id, capability_id: request.capability_id } as const;
    const capability = this.access(row, caller);
    const connection = this.deps.services.connections.get(request.connection_id)!;
    if (connection.paused) throw new TaskServiceError(409, err('CAPABILITY_DISABLED', 'Connection is paused'));
    if (capability.kind !== 'query' || capability.effect !== 'read') {
      throw new TaskServiceError(403, err('CAPABILITY_DISABLED', 'Write operations are not enabled in this release'));
    }
    const inputError = validateCapabilityInput(capability, request.input);
    if (inputError) throw new TaskServiceError(400, inputError);
    const taskId = `tsk_${randomUUID()}`;
    const now = this.timestamp();
    await this.db.rawTransaction([
      { sql: `INSERT INTO tasks (id, client_id, actor_kind, actor_id, connection_id, capability_id, input, input_ciphertext,
          status, no_cache, safe_retry, max_attempts, available_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, '{}', ?, 'pending', ?, 1, ?, ?, ?)`,
        params: [taskId, row.client_id, caller.kind, owner, request.connection_id, request.capability_id,
          this.seal(request.input, taskId, 'input'), request.no_cache ? 1 : 0, this.maxAttempts, now, now] },
      { sql: 'INSERT INTO task_events (task_id, event, detail, at) VALUES (?, ?, ?, ?)',
        params: [taskId, 'created', JSON.stringify({ actor_kind: caller.kind }), now] },
    ]);
    // Current authorization wins even if it changed during the durable write.
    await this.authenticate(caller);
    this.access(row, caller);
    return { task_id: taskId, status: 'pending' };
  }

  private async load(id: string, caller: TaskCaller): Promise<StoredTask> {
    await this.authenticate(caller);
    await this.initialize();
    const rows = await this.db.rawQuery('SELECT * FROM tasks WHERE id = ?', [id]) as StoredTask[];
    await this.authenticate(caller);
    const row = rows[0];
    if (!row) throw new TaskServiceError(404, err('INVALID_PARAMS', 'Task not found'));
    this.access(row, caller);
    return row;
  }

  private view(row: StoredTask, caller: TaskCaller): TaskView {
    const capability = this.access(row, caller);
    let result = row.result_ciphertext ? this.open<ResultEnvelope>(row.result_ciphertext, row.id, 'result') : null;
    if (result?.data !== null && result) {
      const client = caller.kind === 'client' ? this.client(caller.client_id) : undefined;
      const grant = client ? this.deps.services.auth.getGrants(client.id).find((g) => g.connection_id === row.connection_id) : undefined;
      result = filterResultEnvelope(result, capability, caller.kind,
        this.deps.invokeOpts, client, grant);
    }
    return this.sanitize({ id: row.id, task_id: row.id, client_id: row.client_id,
      actor_kind: row.actor_kind, actor_id: row.actor_id ?? row.client_id,
      connection_id: row.connection_id, capability_id: row.capability_id,
      input: row.input_ciphertext ? this.open(row.input_ciphertext, row.id, 'input') : {}, status: row.status,
      created_at: row.created_at, ...(row.started_at ? { started_at: row.started_at } : {}),
      ...(row.finished_at ? { finished_at: row.finished_at } : {}),
      attempts: row.attempts, max_attempts: row.max_attempts, result,
      cancellation: row.cancellation ? JSON.parse(row.cancellation) as TaskCancellation : null });
  }

  async get(id: string, caller: TaskCaller): Promise<TaskView> { return this.view(await this.load(id, caller), caller); }

  async list(caller: TaskCaller, options: { limit?: number; before?: string } = {}): Promise<TaskView[]> {
    await this.authenticate(caller);
    await this.initialize();
    const limit = Math.max(1, Math.min(100, options.limit ?? 50));
    const rows = await this.db.rawQuery(`SELECT * FROM tasks WHERE (? IS NULL OR created_at < ?)
      AND (? = 'admin' OR (actor_kind = 'client' AND COALESCE(actor_id, client_id) = ?))
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    [options.before ?? null, options.before ?? null, caller.kind, this.callerId(caller), limit]) as StoredTask[];
    await this.authenticate(caller);
    const visible: TaskView[] = [];
    for (const row of rows) {
      try { visible.push(this.view(row, caller)); }
      catch (error) { if (!(error instanceof TaskServiceError && error.statusCode === 403)) throw error; }
    }
    return visible;
  }

  async events(id: string, caller: TaskCaller, after = 0): Promise<TaskEvent[]> {
    const row = await this.load(id, caller);
    const events = await this.db.rawQuery('SELECT id, task_id, event, detail, at FROM task_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT 500',
      [id, Math.max(0, after)]) as Array<Omit<TaskEvent, 'detail'> & { detail: string | null }>;
    await this.authenticate(caller);
    this.access(row, caller);
    return this.sanitize(events.map((event) => ({ ...event, detail: event.detail ? JSON.parse(event.detail) as unknown : null })));
  }

  async cancel(id: string, caller: TaskCaller): Promise<TaskView> {
    const row = await this.load(id, caller);
    if (row.status !== 'pending' && row.status !== 'running') return this.view(row, caller);
    const now = this.timestamp();
    // Cancellation racing with a claim must use the status inside SQLite,
    // rather than the earlier read, to avoid falsely claiming "never sent".
    await this.db.rawTransaction([
      { sql: `UPDATE tasks SET cancellation = CASE WHEN status = 'pending'
          THEN ? ELSE ? END, status = 'cancelled', cancel_requested_at = ?, finished_at = ?,
          lease_owner = NULL, lease_expires_at = NULL
          WHERE id = ? AND status IN ('pending', 'running')`,
        params: [JSON.stringify({ state: 'cancelled_before_send', remote_confirmed: false, may_continue_remote: false }),
          JSON.stringify({ state: 'cancelled_local', remote_confirmed: false, may_continue_remote: true }), now, now, id] },
      { sql: `INSERT INTO task_events (task_id, event, detail, at)
          SELECT id, 'cancelled', cancellation, ? FROM tasks WHERE id = ? AND changes() = 1`, params: [now, id] },
    ]);
    this.cancelActive(id);
    return this.get(id, caller);
  }

  /** Used when a connection is deleted/paused. It never reports remote cancellation. */
  async cancelConnection(connectionId: string): Promise<number> {
    const rows = await this.db.rawQuery("SELECT id FROM tasks WHERE connection_id = ? AND status IN ('pending','running')", [connectionId]) as Array<{ id: string }>;
    let count = 0;
    for (const { id } of rows) {
      const now = this.timestamp();
      const result = await this.db.rawTransaction([
        { sql: `UPDATE tasks SET cancellation = CASE WHEN status = 'pending' THEN ? ELSE ? END,
            status = 'cancelled', cancel_requested_at = ?, finished_at = ?, lease_owner = NULL, lease_expires_at = NULL
            WHERE id = ? AND status IN ('pending','running')`, params: [
          JSON.stringify({ state: 'cancelled_before_send', remote_confirmed: false, may_continue_remote: false }),
          JSON.stringify({ state: 'cancelled_local', remote_confirmed: false, may_continue_remote: true }), now, now, id] },
        { sql: `INSERT INTO task_events(task_id,event,detail,at) SELECT id,'cancelled',cancellation,? FROM tasks WHERE id=? AND changes()=1`, params: [now, id] },
      ]);
      count += (result[0] as { changes: number }).changes;
      this.cancelActive(id);
    }
    return count;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.initialize();
    this.running = true;
    const interval = Math.max(10, Math.min(this.deps.pollIntervalMs ?? 250, this.heartbeatMs));
    this.timer = setInterval(() => { void this.tick().catch(() => { /* Retry DB availability on the next bounded tick. */ }); }, interval);
    this.timer.unref();
    await this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const entry of this.active.values()) entry.controller.abort();
    this.active.clear();
    await this.ticking?.catch(() => {});
    // Do not mark running jobs as successful or cancelled on shutdown. Their
    // leases expire and recovery decides whether a read can safely be retried.
  }

  private tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.work().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }

  private async work(): Promise<void> {
    if (!this.running) return;
    const now = this.timestamp();
    if (this.clock() - this.lastHeartbeat >= this.heartbeatMs) {
      for (const [id, active] of this.active) {
        const result = await this.db.rawRun(`UPDATE tasks SET heartbeat_at = ?, lease_expires_at = ?
          WHERE id = ? AND lease_owner = ? AND status = 'running' AND lease_expires_at > ?`,
        [now, new Date(this.clock() + this.leaseMs).toISOString(), id, active.lease, now]);
        if (result.changes === 0) this.cancelActive(id);
      }
      this.lastHeartbeat = this.clock();
    }
    await this.recover(now);
    while (this.running && this.active.size < this.concurrency) {
      const lease = randomUUID();
      const results = await this.db.rawTransaction([
        { sql: `UPDATE tasks SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?),
            lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?
            WHERE id = (SELECT id FROM tasks WHERE status = 'pending' AND (available_at IS NULL OR available_at <= ?)
              ORDER BY created_at, id LIMIT 1) AND status = 'pending' RETURNING *`,
          params: [now, lease, new Date(this.clock() + this.leaseMs).toISOString(), now, now], mode: 'all' },
        { sql: `INSERT INTO task_events(task_id,event,detail,at) SELECT id,'started',?,? FROM tasks WHERE lease_owner=? AND status='running'`,
          params: [JSON.stringify({ lease_acquired: true }), now, lease] },
      ]);
      const row = (results[0] as StoredTask[])[0];
      if (!row) break;
      const controller = new AbortController();
      this.active.set(row.id, { lease, controller });
      void this.execute(row, lease, controller).catch(() => { /* Lease recovery handles a failed persistence write. */ })
        .finally(() => { if (this.active.get(row.id)?.lease === lease) this.active.delete(row.id); });
    }
  }

  private async recover(now: string): Promise<void> {
    const expired = await this.db.rawQuery("SELECT * FROM tasks WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)", [now]) as StoredTask[];
    for (const row of expired) {
      const connection = this.deps.services.connections.get(row.connection_id);
      const cap = connection && this.deps.services.capabilities.get(connection.connector_id, row.capability_id);
      const retry = row.safe_retry === 1 && cap?.kind === 'query' && cap.effect === 'read' && row.attempts < row.max_attempts;
      const result = retry ? null : this.seal(fail(err('OUTCOME_UNKNOWN', 'The previous worker stopped before recording an outcome; this task was not retried'), this.source(row)), row.id, 'result');
      const transition = await this.db.rawTransaction([
        { sql: `UPDATE tasks SET status=?, available_at=?, result_ciphertext=?, finished_at=?, lease_owner=NULL, lease_expires_at=NULL
            WHERE id=? AND status='running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
          params: [retry ? 'pending' : 'unknown_outcome', now, result, retry ? null : now, row.id, now] },
        { sql: `INSERT INTO task_events(task_id,event,detail,at) SELECT ?,?,?,? WHERE changes()=1`,
          params: [row.id, retry ? 'recovered' : 'unknown_outcome', JSON.stringify({ reason: 'lease_expired', retry_scheduled: retry }), now] },
      ]);
      if ((transition[0] as { changes: number }).changes > 0) this.cancelActive(row.id);
    }
  }

  private source(row: StoredTask): ResultEnvelope['source'] {
    const connection = this.deps.services.connections.get(row.connection_id);
    const cap = connection && this.deps.services.capabilities.get(connection.connector_id, row.capability_id);
    return { connection_id: row.connection_id, connection_label: connection?.label ?? row.connection_id,
      capability_id: row.capability_id, support: connection?.capability_states[row.capability_id] ?? cap?.support ?? { status: 'unsupported' } };
  }

  private async execute(row: StoredTask, lease: string, controller: AbortController): Promise<void> {
    let result: ResultEnvelope;
    let authorizedRaw: ResultEnvelope | undefined;
    const caller: TaskCaller = row.actor_kind === 'admin'
      ? { kind: 'admin', user_id: row.actor_id ?? '' }
      : { kind: 'client', client_id: row.actor_id ?? row.client_id };
    try {
      await this.authenticate(caller);
      // A cancellation may have won just after the atomic claim.
      const owned = await this.db.rawQuery("SELECT id FROM tasks WHERE id=? AND lease_owner=? AND status='running'", [row.id, lease]);
      if (!this.running || owned.length === 0 || controller.signal.aborted) return;
      result = await invoke({ connection_id: row.connection_id, capability_id: row.capability_id,
        input: this.open(row.input_ciphertext!, row.id, 'input'), ...(row.no_cache ? { no_cache: true } : {}) },
      this.deps.services, { ...this.deps.invokeOpts, signal: controller.signal,
        onAuthorizedResult: (raw) => { authorizedRaw = raw; } }, caller);
    } catch (error) {
      result = fail(error instanceof TaskServiceError ? error.error : err('INTERNAL_ERROR', 'Task execution could not be completed'), this.source(row));
    }
    if (!this.running || controller.signal.aborted) return;
    const connection = this.deps.services.connections.get(row.connection_id);
    const cap = connection && this.deps.services.capabilities.get(connection.connector_id, row.capability_id);
    const retry = row.safe_retry === 1 && cap?.kind === 'query' && cap.effect === 'read' && result.outcome === 'error'
      && result.error?.retryable === true && row.attempts < row.max_attempts;
    const now = this.timestamp();
    const status: TaskStatus = retry ? 'pending' : result.status === 'unknown_outcome' ? 'unknown_outcome'
      : result.outcome === 'success' ? 'success' : result.outcome === 'partial' ? 'partial' : 'failed';
    const delay = (this.deps.retryDelayMs ?? 1000) * 2 ** Math.max(0, row.attempts - 1);
    await this.db.rawTransaction([
      { sql: `UPDATE tasks SET status=?, result_ciphertext=?, finished_at=?, available_at=?, lease_owner=NULL, lease_expires_at=NULL
          WHERE id=? AND lease_owner=? AND status='running' AND lease_expires_at > ?`,
        params: [status, retry ? null : this.seal(this.sanitize(result.outcome === 'error' ? result : authorizedRaw ?? result), row.id, 'result'), retry ? null : now,
          retry ? new Date(this.clock() + delay).toISOString() : null, row.id, lease, now] },
      { sql: `INSERT INTO task_events(task_id,event,detail,at) SELECT ?,?,?,? WHERE changes()=1`,
        params: [row.id, retry ? 'retry_scheduled' : 'finished', JSON.stringify({ status, attempt: row.attempts,
          ...(result.error ? { code: result.error.code } : {}), ...(retry ? { retry_in_ms: delay } : {}) }), now] },
    ]);
  }
}
