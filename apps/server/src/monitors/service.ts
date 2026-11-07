import { randomBytes } from 'node:crypto';
import { Ajv } from 'ajv';
import type { ResultEnvelope } from '@owngate/core';
import { vaultContext, type EncryptedBlob } from '@owngate/vault';
import { compileCondition, evaluateCondition, fieldValue, validFieldPath } from './condition.js';
import { minuteStart, nextRun, skipMissed } from './schedule.js';
import { sendSmtpMail } from './smtp.js';
import { MonitorError } from './types.js';
import type { ChannelView, MailOptions, MonitorDeps, MonitorInput, MonitorRunResult, MonitorState, MonitorView, StoredChannel } from './types.js';

const ajv = new Ajv({ strict: false, validateFormats: false });
const newId = () => randomBytes(12).toString('hex');
const initialState = (): MonitorState => ({ last_run_at: null, last_result: 'never', last_status: null, last_error: null,
  active: false, false_streak: 0, last_notification_at: null, delivery: 'none', pending: null });
interface MonitorRow { id: string; connection_id: string; capability_id: string; cron: string; condition: string; channel_id: string; enabled: number; created_at: string; config: string; state: string; next_run_at: string | null }
interface ChannelRow { id: string; type: string; config: string; created_at: string }
const MONITOR_SELECT = `SELECT m.*, r.config, r.state, r.next_run_at FROM monitors m JOIN monitor_runtime r ON r.monitor_id=m.id`;
const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw new MonitorError('INVALID_PARAMS', `${name} 无效`);
  return value.trim();
};
const address = (value: unknown): string => {
  const result = text(value, '邮件地址', 254);
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(result)) throw new MonitorError('INVALID_PARAMS', '请输入单个完整邮件地址');
  return result;
};
const asObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MonitorError('INVALID_PARAMS', '请求需要 JSON 对象');
  return value as Record<string, unknown>;
};

export class MonitorService {
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flights = new Map<string, Promise<unknown>>();
  private ticking: Promise<void> | null = null;
  private stopping = false;
  constructor(private readonly deps: MonitorDeps) { this.now = deps.now ?? (() => new Date()); }

  async init(): Promise<void> {
    await this.deps.db.rawRun(`CREATE TABLE IF NOT EXISTS monitor_runtime (
      monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
      config TEXT NOT NULL, state TEXT NOT NULL, next_run_at TEXT
    )`);
    // Legacy rows predate runtime settings: keep their rules, using safe defaults.
    const legacy = await this.deps.db.rawQuery(`SELECT m.id FROM monitors m LEFT JOIN monitor_runtime r ON r.monitor_id=m.id WHERE r.monitor_id IS NULL`) as { id: string }[];
    for (const row of legacy) await this.deps.db.rawRun('INSERT INTO monitor_runtime(monitor_id,config,state,next_run_at) VALUES(?,?,?,NULL)',
      [row.id, this.encryptMonitor(row.id, 'config', { label: row.id, timezone: 'UTC', mode: 'data', cooldown_seconds: 3600, input: {}, email_fields: [] }), this.encryptMonitor(row.id, 'state', initialState())]);
    for (const monitor of await this.listMonitors()) {
      if (monitor.runtime.last_result === 'running') {
        monitor.runtime.last_result = 'error'; monitor.runtime.last_error = 'RUN_INTERRUPTED';
        await this.saveState(monitor);
        await this.audit('monitor.interrupted', monitor.id, {});
      }
      if (!monitor.enabled) continue;
      try { await this.advanceMissed(monitor, this.now()); }
      catch {
        await this.deps.db.rawRun('UPDATE monitors SET enabled=0 WHERE id=?', [monitor.id]);
        await this.audit('monitor.invalid_schedule', monitor.id, {});
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    const tick = () => { void this.tick().catch(() => this.audit('monitor.scheduler_error', undefined, {})); };
    this.timer = setInterval(tick, 15_000); this.timer.unref(); tick();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
    await Promise.allSettled([...this.flights.values()]);
  }
  private audit(action: string, target: string | undefined, detail: unknown) {
    return Promise.resolve(this.deps.audit({ action, ...(target ? { target } : {}), detail }));
  }
  private exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const before = this.flights.get(key) ?? Promise.resolve();
    const run = before.catch(() => {}).then(task);
    this.flights.set(key, run);
    void run.finally(() => { if (this.flights.get(key) === run) this.flights.delete(key); }).catch(() => {});
    return run;
  }
  private async channelRow(id: string): Promise<ChannelRow> {
    const rows = await this.deps.db.rawQuery('SELECT * FROM notification_channels WHERE id=? AND type=?', [id, 'smtp']) as ChannelRow[];
    if (!rows[0]) throw new MonitorError('CHANNEL_NOT_FOUND', '通知渠道不存在', 404);
    return rows[0];
  }
  private publicChannel(row: ChannelRow): ChannelView {
    const { pass, ...config } = this.decryptChannel(row);
    return { ...config, id: row.id, type: 'smtp', has_password: !!pass, created_at: row.created_at };
  }
  private decryptChannel(row: ChannelRow): StoredChannel {
    return this.deps.vault.decryptJSON<StoredChannel>(JSON.parse(row.config) as EncryptedBlob, vaultContext.notification(row.id));
  }
  async listChannels(): Promise<ChannelView[]> {
    const rows = await this.deps.db.rawQuery('SELECT * FROM notification_channels WHERE type=? ORDER BY created_at,id', ['smtp']) as ChannelRow[];
    return rows.map((row) => this.publicChannel(row));
  }
  private normalizeChannel(input: unknown, previous?: StoredChannel): StoredChannel {
    const value = asObject(input);
    if (Object.keys(value).some((key) => !['label', 'host', 'port', 'secure', 'user', 'pass', 'from', 'to'].includes(key))) throw new MonitorError('INVALID_PARAMS', '通知渠道包含未知字段');
    const host = text(value['host'], 'SMTP 主机', 253);
    if (!/^[a-zA-Z0-9._:\-]+$/.test(host)) throw new MonitorError('INVALID_PARAMS', 'SMTP 主机不能包含 URL 或空白');
    const port = value['port']; const secure = value['secure'];
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 || typeof secure !== 'boolean') throw new MonitorError('INVALID_PARAMS', 'SMTP 端口或 TLS 设置无效');
    const to = value['to'];
    if (!Array.isArray(to) || to.length === 0 || to.length > 20) throw new MonitorError('INVALID_PARAMS', '请选择 1 到 20 个收件地址');
    const user = value['user'] === undefined || value['user'] === '' ? '' : text(value['user'], 'SMTP 用户', 320);
    const pass = value['pass'];
    if (pass !== undefined && (typeof pass !== 'string' || pass.length > 4096)) throw new MonitorError('INVALID_PARAMS', 'SMTP 密码无效');
    const password = pass === undefined ? previous?.pass : pass === '' ? undefined : pass as string;
    if (password && !user) throw new MonitorError('INVALID_PARAMS', '设置密码时需要填写 SMTP 用户');
    return { label: text(value['label'], '渠道名称', 100), host, port, secure, user, from: address(value['from']), to: [...new Set(to.map(address))], ...(password ? { pass: password } : {}) };
  }
  async createChannel(input: unknown): Promise<ChannelView> {
    const config = this.normalizeChannel(input); const id = newId();
    if ((await this.listChannels()).length >= 20) throw new MonitorError('CHANNEL_LIMIT', '最多可设置 20 个通知渠道', 409);
    await this.deps.db.rawRun('INSERT INTO notification_channels(id,type,config) VALUES(?,?,?)', [id, 'smtp', JSON.stringify(this.deps.vault.encryptJSON(config, vaultContext.notification(id)))]);
    await this.audit('notification.channel_created', id, {});
    return this.publicChannel(await this.channelRow(id));
  }
  async updateChannel(id: string, input: unknown): Promise<ChannelView> {
    return this.exclusive(`channel:${id}`, async () => {
      const previous = await this.channelRow(id); const config = this.normalizeChannel(input, this.decryptChannel(previous));
      await this.deps.db.rawRun('UPDATE notification_channels SET config=? WHERE id=?', [JSON.stringify(this.deps.vault.encryptJSON(config, vaultContext.notification(id))), id]);
      await this.audit('notification.channel_updated', id, {});
      return this.publicChannel(await this.channelRow(id));
    });
  }
  async deleteChannel(id: string): Promise<void> {
    return this.exclusive(`channel:${id}`, async () => {
      await this.channelRow(id);
      const refs = await this.deps.db.rawQuery('SELECT id FROM monitors WHERE channel_id=? LIMIT 1', [id]);
      if (refs.length) throw new MonitorError('CHANNEL_IN_USE', '请先修改或删除使用这个渠道的监控规则', 409);
      await this.deps.db.rawRun('DELETE FROM notification_channels WHERE id=?', [id]);
      await this.audit('notification.channel_deleted', id, {});
    });
  }
  private async send(row: ChannelRow, subject: string, body: string): Promise<void> {
    const config = this.decryptChannel(row);
    const options: MailOptions = { host: config.host, port: config.port, secure: config.secure,
      ...(config.user ? { auth: { user: config.user, pass: config.pass ?? '' } } : {}) };
    await (this.deps.sendMail ?? sendSmtpMail)(options, { from: config.from, to: config.to, subject, text: body });
  }
  async testChannel(id: string): Promise<{ ok: true; status: 'sent' }> {
    const row = await this.channelRow(id);
    try { await this.send(row, '[owngate] 通知测试', '这是一封 owngate 通知渠道测试邮件。未包含站点数据或凭据。'); }
    catch { await this.audit('notification.test_failed', id, {}); throw new MonitorError('SMTP_DELIVERY_FAILED', '测试邮件发送失败，请检查 SMTP 配置和收件地址', 502); }
    await this.audit('notification.test_sent', id, {});
    return { ok: true, status: 'sent' };
  }
  private fromRow(row: MonitorRow): MonitorView {
    const config = this.deps.vault.decryptJSON<Pick<MonitorInput, 'label' | 'timezone' | 'mode' | 'cooldown_seconds' | 'input' | 'email_fields'>>(JSON.parse(row.config) as EncryptedBlob, vaultContext.monitor(row.id, 'config'));
    return { ...config, id: row.id, connection_id: row.connection_id, capability_id: row.capability_id, cron: row.cron, condition: row.condition,
      channel_id: row.channel_id, enabled: !!row.enabled, created_at: row.created_at, next_run_at: row.next_run_at, runtime: { ...initialState(), ...this.deps.vault.decryptJSON<MonitorState>(JSON.parse(row.state) as EncryptedBlob, vaultContext.monitor(row.id, 'state')) } };
  }
  async listMonitors(): Promise<MonitorView[]> {
    const rows = await this.deps.db.rawQuery(`${MONITOR_SELECT} ORDER BY m.created_at,m.id`) as MonitorRow[];
    return rows.map((row) => this.fromRow(row));
  }
  async getMonitor(id: string): Promise<MonitorView> {
    const rows = await this.deps.db.rawQuery(`${MONITOR_SELECT} WHERE m.id=?`, [id]) as MonitorRow[];
    if (!rows[0]) throw new MonitorError('MONITOR_NOT_FOUND', '监控规则不存在', 404);
    return this.fromRow(rows[0]);
  }
  private async normalizeMonitor(input: unknown): Promise<MonitorInput> {
    const value = asObject(input);
    if (Object.keys(value).some((key) => !['label', 'connection_id', 'capability_id', 'cron', 'timezone', 'condition', 'mode', 'channel_id', 'cooldown_seconds', 'input', 'email_fields', 'enabled'].includes(key))) throw new MonitorError('INVALID_PARAMS', '监控规则包含未知字段');
    const connectionId = text(value['connection_id'], '连接', 100); const capabilityId = text(value['capability_id'], '能力', 150);
    const connection = this.deps.getConnection(connectionId); const capability = this.deps.getCapability(connectionId, capabilityId);
    if (!connection) throw new MonitorError('CONNECTION_NOT_FOUND', '连接不存在', 404);
    if (!capability || capability.kind !== 'query' || capability.effect !== 'read') throw new MonitorError('CAPABILITY_DISABLED', '监控只允许现有的只读查询能力');
    const timezone = value['timezone'] ?? 'UTC'; const cron = text(value['cron'], 'cron', 120);
    // nextRun validates both the bounded grammar and whether the schedule can fire.
    if (timezone !== 'UTC') throw new MonitorError('INVALID_SCHEDULE', '当前仅支持 UTC 时区');
    nextRun(cron, this.now());
    const mode = value['mode'];
    if (mode !== 'data' && mode !== 'failure') throw new MonitorError('INVALID_PARAMS', '请选择数据告警或查询失败告警');
    const condition = text(value['condition'], '条件', 1000); const compiled = compileCondition(condition, mode);
    const schemaForPath = (path: string): Record<string, unknown> | undefined => {
      let schema: Record<string, unknown> = capability.output;
      for (const part of path.split('.')) { const fields = schema['properties'] as Record<string, Record<string, unknown>> | undefined; if (!fields?.[part]) return undefined; schema = fields[part]; }
      return schema;
    };
    for (const path of [...compiled.paths, ...compiled.states]) if (!schemaForPath(path)) throw new MonitorError('INVALID_CONDITION', `能力未声明字段 ${path}`);
    const emailFields = value['email_fields'] ?? [];
    if (!Array.isArray(emailFields) || emailFields.length > 20 || emailFields.some((field) => typeof field !== 'string' || !validFieldPath(field) || !schemaForPath(field)
      || ['object', 'array'].includes(String(schemaForPath(field)?.['type'])) || schemaForPath(field)?.['x-secret'] === true)) throw new MonitorError('INVALID_PARAMS', '邮件字段只能选择能力声明的非秘密单值字段，最多 20 项');
    const cooldown = value['cooldown_seconds'] ?? 3600;
    if (typeof cooldown !== 'number' || !Number.isInteger(cooldown) || cooldown < 60 || cooldown > 30 * 86400) throw new MonitorError('INVALID_PARAMS', '冷却时间应为 60 到 2592000 秒');
    const params = asObject(value['input'] ?? {});
    if (JSON.stringify(params).length > 16_000 || !ajv.validate(capability.input, params)) throw new MonitorError('INVALID_PARAMS', '查询参数不符合能力定义');
    const channelId = text(value['channel_id'], '通知渠道', 100); await this.channelRow(channelId);
    if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') throw new MonitorError('INVALID_PARAMS', '启用状态需要布尔值');
    return { label: text(value['label'], '规则名称', 100), connection_id: connectionId, capability_id: capabilityId, cron,
      timezone: 'UTC', mode, condition, channel_id: channelId, cooldown_seconds: cooldown, input: params,
      email_fields: [...new Set(emailFields as string[])], enabled: value['enabled'] !== false };
  }
  private encryptMonitor(id: string, kind: 'config' | 'state', value: unknown): string {
    return JSON.stringify(this.deps.vault.encryptJSON(value, vaultContext.monitor(id, kind)));
  }
  private config(id: string, input: MonitorInput) {
    const { label, timezone, mode, cooldown_seconds, input: params, email_fields } = input;
    return this.encryptMonitor(id, 'config', { label, timezone, mode, cooldown_seconds, input: params, email_fields });
  }
  async createMonitor(input: unknown): Promise<MonitorView> {
    const value = await this.normalizeMonitor(input); const id = newId();
    if ((await this.listMonitors()).length >= 100) throw new MonitorError('MONITOR_LIMIT', '最多可设置 100 条规则', 409);
    await this.deps.db.rawTransaction([
      { sql: 'INSERT INTO monitors(id,connection_id,capability_id,cron,condition,channel_id,enabled) VALUES(?,?,?,?,?,?,?)', params: [id, value.connection_id, value.capability_id, value.cron, value.condition, value.channel_id, Number(value.enabled)] },
      { sql: 'INSERT INTO monitor_runtime(monitor_id,config,state,next_run_at) VALUES(?,?,?,?)', params: [id, this.config(id, value), this.encryptMonitor(id, 'state', initialState()), value.enabled ? nextRun(value.cron, this.now()) : null] },
    ]);
    await this.audit('monitor.created', id, {}); return this.getMonitor(id);
  }
  async updateMonitor(id: string, input: unknown): Promise<MonitorView> {
    return this.exclusive(id, async () => {
      await this.getMonitor(id); const value = await this.normalizeMonitor(input);
      await this.deps.db.rawTransaction([
        { sql: 'UPDATE monitors SET connection_id=?,capability_id=?,cron=?,condition=?,channel_id=?,enabled=? WHERE id=?', params: [value.connection_id, value.capability_id, value.cron, value.condition, value.channel_id, Number(value.enabled), id] },
        { sql: 'UPDATE monitor_runtime SET config=?,state=?,next_run_at=? WHERE monitor_id=?', params: [this.config(id, value), this.encryptMonitor(id, 'state', initialState()), value.enabled ? nextRun(value.cron, this.now()) : null, id] },
      ]);
      await this.audit('monitor.updated', id, {}); return this.getMonitor(id);
    });
  }
  async setEnabled(id: string, enabled: boolean): Promise<MonitorView> {
    return this.exclusive(id, async () => {
      const monitor = await this.getMonitor(id);
      const next = enabled ? nextRun(monitor.cron, this.now()) : null;
      await this.deps.db.rawTransaction([
        { sql: 'UPDATE monitors SET enabled=? WHERE id=?', params: [Number(enabled), id] },
        { sql: 'UPDATE monitor_runtime SET next_run_at=? WHERE monitor_id=?', params: [next, id] },
      ]);
      await this.audit(enabled ? 'monitor.enabled' : 'monitor.disabled', id, {}); return this.getMonitor(id);
    });
  }
  async deleteMonitor(id: string): Promise<void> {
    return this.exclusive(id, async () => { await this.getMonitor(id);
      await this.deps.db.rawTransaction([{ sql: 'DELETE FROM monitor_runtime WHERE monitor_id=?', params: [id] }, { sql: 'DELETE FROM monitors WHERE id=?', params: [id] }]);
      await this.audit('monitor.deleted', id, {});
    });
  }
  private async saveState(monitor: MonitorView): Promise<void> {
    await this.deps.db.rawRun('UPDATE monitor_runtime SET state=?,next_run_at=? WHERE monitor_id=?', [this.encryptMonitor(monitor.id, 'state', monitor.runtime), monitor.next_run_at, monitor.id]);
  }
  private async advanceMissed(monitor: MonitorView, now: Date): Promise<void> {
    if (!monitor.next_run_at) { monitor.next_run_at = nextRun(monitor.cron, now); await this.saveState(monitor); return; }
    const skipped = skipMissed(monitor.cron, monitor.next_run_at, now);
    if (skipped.missed) {
      monitor.next_run_at = skipped.next; await this.saveState(monitor);
      await this.audit('monitor.missed', monitor.id, { count: skipped.missed, capped: skipped.capped });
    }
  }
  tick(now = this.now()): Promise<void> {
    if (this.ticking) return this.ticking;
    const run = (async () => {
      for (const current of await this.listMonitors()) {
        if (this.stopping || !current.enabled || this.flights.has(current.id)) continue;
        await this.exclusive(current.id, async () => {
          const monitor = await this.getMonitor(current.id);
          if (!monitor.enabled) return;
          await this.advanceMissed(monitor, now);
          if (!monitor.next_run_at || new Date(monitor.next_run_at).getTime() > minuteStart(now).getTime()) return;
          // Claim the current period before executing; never replay it after restart.
          monitor.next_run_at = nextRun(monitor.cron, now);
          await this.saveState(monitor);
          await this.execute(monitor, 'scheduled');
        }).catch(async () => { await this.audit('monitor.run_error', current.id, {}); });
      }
    })();
    this.ticking = run;
    void run.finally(() => { if (this.ticking === run) this.ticking = null; }).catch(() => {});
    return run;
  }
  run(id: string): Promise<MonitorRunResult> {
    if (this.flights.has(id)) return Promise.reject(new MonitorError('MONITOR_BUSY', '这个规则正在执行，请等待结果', 409));
    return this.exclusive(id, async () => {
      const monitor = await this.getMonitor(id);
      if (!monitor.enabled) throw new MonitorError('MONITOR_DISABLED', '规则已停用，请先启用再执行', 409);
      return this.execute(monitor, 'manual');
    });
  }
  private emailBody(monitor: MonitorView, envelope: ResultEnvelope, recovered: boolean): string {
    const connection = this.deps.getConnection(monitor.connection_id);
    const lines = [`连接：${connection?.label ?? monitor.connection_id}`, `规则：${monitor.label}`, recovered ? '状态：已恢复（连续两次正常）' : '状态：告警', `条件：${monitor.condition}`, `时间：${this.now().toISOString()}`];
    // Only explicitly selected values from the cron-redacted envelope leave the server.
    for (const path of monitor.email_fields) {
      const state = envelope.fields[path]?.status;
      if (state && state !== 'ok') { lines.push(`${path}：[${state}]`); continue; }
      const value = fieldValue(envelope.data, path);
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') lines.push(`${path}：${String(value).slice(0, 2000)}`);
    }
    return lines.join('\n');
  }
  private async execute(monitor: MonitorView, trigger: 'manual' | 'scheduled'): Promise<MonitorRunResult> {
    const state = monitor.runtime;
    state.last_run_at = this.now().toISOString(); state.last_result = 'running'; state.last_error = null; state.delivery = 'none';
    await this.saveState(monitor);
    let envelope: ResultEnvelope;
    try { envelope = await this.deps.invoke({ connection_id: monitor.connection_id, capability_id: monitor.capability_id, input: monitor.input, no_cache: true }, monitor.id); }
    catch {
      state.last_result = 'error'; state.last_error = 'INVOKE_FAILED'; state.false_streak = 0;
      await this.saveState(monitor); await this.audit('monitor.invoke_failed', monitor.id, { trigger });
      return { monitor, result: { evaluation: 'skipped', reason: 'INVOKE_FAILED', delivery: 'none' } };
    }
    state.last_status = envelope.status;
    const matched = evaluateCondition(compileCondition(monitor.condition, monitor.mode), envelope, monitor.mode);
    const evaluation = matched === null ? 'skipped' : matched ? 'alert' : 'normal';
    state.last_result = evaluation;
    let reason: string | undefined;
    if (matched === null) { reason = envelope.outcome === 'error' ? 'QUERY_FAILED' : 'FIELD_NOT_EVALUABLE'; state.false_streak = 0; }
    else if (matched) { state.active = true; state.false_streak = 0; state.pending = 'alert'; }
    else if (state.active) { state.pending = null; state.false_streak = Math.min(2, state.false_streak + 1); if (state.false_streak === 2) { state.active = false; state.pending = 'recovery'; } }
    else state.false_streak = Math.min(2, state.false_streak + 1);
    if (state.pending && matched !== null) {
      const isRecovery = state.pending === 'recovery';
      const cooled = !state.last_notification_at || this.now().getTime() - new Date(state.last_notification_at).getTime() >= monitor.cooldown_seconds * 1000;
      if (!isRecovery && !cooled) state.delivery = 'suppressed';
      else {
        try {
          await this.send(await this.channelRow(monitor.channel_id), `[owngate] ${isRecovery ? '已恢复' : '告警'}：${monitor.label}`, this.emailBody(monitor, envelope, isRecovery));
          state.delivery = 'sent'; state.last_notification_at = this.now().toISOString(); state.pending = null;
        } catch { state.delivery = 'failed'; state.last_error = 'SMTP_DELIVERY_FAILED'; }
        // Persist delivery before audit; an audit failure must not turn a sent
        // message into a retryable SMTP failure on the next run.
        await this.saveState(monitor);
        await this.audit(state.delivery === 'failed' ? 'monitor.delivery_failed' : isRecovery ? 'monitor.recovered' : 'monitor.notified', monitor.id, { trigger });
      }
    }
    await this.saveState(monitor);
    await this.audit('monitor.evaluated', monitor.id, { trigger, evaluation, status: envelope.status, ...(reason ? { reason } : {}), delivery: state.delivery });
    return { monitor, result: { evaluation, ...(reason ? { reason } : {}), delivery: state.delivery } };
  }
}
