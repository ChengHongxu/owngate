import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { DbClient } from '@owngate/db';
import { Vault, vaultContext } from '@owngate/vault';
import { invoke, ok, fail, err, type Capability, type Connection, type InvokeServices, type ResultEnvelope } from '@owngate/core';
import { redact } from '@owngate/vault';
import { MonitorService } from '../src/monitors/service.js';
import { registerMonitorRoutes } from '../src/routes/monitors.js';
import { compileCondition, evaluateCondition } from '../src/monitors/condition.js';
import { cronSchedule, skipMissed } from '../src/monitors/schedule.js';
import { sendSmtpMail } from '../src/monitors/smtp.js';
import type { MailMessage, MonitorDeps, MonitorInput, SendMail } from '../src/monitors/types.js';
import { loginAdmin, stepUp, tempDbPath } from './helpers/admin.js';
import { smtpFixture } from './helpers/smtp.js';

const SOURCE = { connection_id: 'monitor-conn', connection_label: 'Fixture connection', capability_id: 'account.balance', support: { status: 'supported' as const } };
const cap: Capability = { id: SOURCE.capability_id, title: 'Balance', description: '', kind: 'query', effect: 'read', approval: 'never',
  input: { type: 'object', properties: { account: { type: 'integer' } }, additionalProperties: false },
  output: { type: 'object', properties: { remaining: { type: 'number', 'x-sensitivity': 'financial' }, email: { type: 'string', 'x-sensitivity': 'pii' }, secret: { type: 'string', 'x-secret': true } } },
  cache: null, transport: 'http', support: { status: 'supported' }, long_running: false, cancel: 'none', idempotency: 'none', verify: null };
const conn: Connection = { id: SOURCE.connection_id, connector_id: 'fixture', label: SOURCE.connection_label, config: {}, capability_states: {}, created_at: '2026-11-02', updated_at: '2026-11-02' };
const channelInput = { label: 'Fixture SMTP', host: '127.0.0.1', port: 2525, secure: false, user: 'fixture', pass: 'fixture-smtp-password', from: 'sender@example.invalid', to: ['recipient@example.invalid'] };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { sendMail?: SendMail; path?: string } = {}) {
  const temp = options.path ? null : tempDbPath('owngate-monitors-');
  const db = new DbClient(options.path ?? temp!.path);
  const vault = new Vault('39'.repeat(32));
  let now = new Date('2026-11-02T12:00:00.000Z');
  let envelope: ResultEnvelope = ok({ remaining: 3, email: 'private@example.invalid', secret: 'upstream-secret' }, SOURCE);
  const messages: MailMessage[] = [];
  const audit = vi.fn(async (_entry: unknown) => {});
  const invokeFn = vi.fn(async () => envelope);
  const deps: MonitorDeps = { db, vault, getConnection: (id: string) => id === conn.id ? conn : undefined,
    getCapability: (_connectionId: string, id: string) => id === cap.id ? cap : undefined,
    invoke: invokeFn, audit, now: () => now,
    sendMail: options.sendMail ?? (async (_options, message) => { messages.push(message); }) };
  const service = new MonitorService(deps);
  await service.init();
  cleanups.push(async () => { await service.stop(); await db.close(); temp?.cleanup(); });
  const channel = await service.createChannel(channelInput);
  const input: MonitorInput = { label: 'Low balance', connection_id: conn.id, capability_id: cap.id, cron: '* * * * *', timezone: 'UTC',
    condition: 'remaining < 5', mode: 'data', channel_id: channel.id, cooldown_seconds: 3600, input: {}, email_fields: [], enabled: true };
  return { db, vault, service, channel, input, messages, invokeFn, audit, deps,
    setNow: (date: string) => { now = new Date(date); }, setEnvelope: (result: ResultEnvelope) => { envelope = result; } };
}

describe('bounded monitor DSL and schedule', () => {
  it('supports typed fields, state, precedence, negation and status without coercing unavailable numbers to zero', () => {
    const result = ok({ remaining: 3 }, SOURCE);
    const value = (condition: string, envelope: ResultEnvelope = result) => evaluateCondition(compileCondition(condition, 'data'), envelope, 'data');
    expect(value('remaining < 5 and !(remaining >= 5)')).toBe(true);
    expect(value('remaining == 3 or remaining > 9 and remaining < 0')).toBe(true);
    expect(value('remaining in [2, 3, 4]')).toBe(true);
    expect(value('remaining < 5', ok({ remaining: null }, SOURCE, { fields: { remaining: { status: 'unknown' } } }))).toBeNull();
    expect(value('state(remaining) == unknown', ok({}, SOURCE))).toBe(true);
    expect(value('remaining < 5', ok({ remaining: '3' }, SOURCE))).toBeNull();
    expect(value('!(remaining < 5)', ok({}, SOURCE))).toBeNull();
    const error = fail(err('AUTH_EXPIRED', 'Login expired'), SOURCE);
    expect(value('state(remaining) == unknown', error)).toBeNull();
    expect(evaluateCondition(compileCondition('status != ok', 'failure'), error, 'failure')).toBe(true);
    expect(evaluateCondition(compileCondition('status != ok', 'failure'), result, 'failure')).toBe(false);
  });

  it.each(['remaining < 5 trailing', 'remaining < "unterminated', 'constructor == null', 'a.__proto__ == null', 'remaining < 5 )', 'remaining in [1,', 'remaining < 5 status != ok'])('rejects incomplete or unsafe condition %s', (condition) => {
    expect(() => compileCondition(condition, 'data')).toThrow();
  });
  it('keeps query failures separate and rejects arbitrary code or mixed rule modes', () => {
    expect(() => compileCondition('status != ok', 'data')).toThrow();
    expect(() => compileCondition('remaining < 5', 'failure')).toThrow();
    expect(() => compileCondition('status != ok or remaining < 5', 'failure')).toThrow();
    expect(() => compileCondition('process.exit(0)', 'data')).toThrow();
  });
  it('accepts only five bounded UTC cron fields and reports missed periods without catchup', () => {
    const now = new Date('2026-11-02T12:05:10Z');
    const schedule = cronSchedule('*/15 * * * *', 'UTC', now);
    expect(schedule.nextRun(now)?.toISOString()).toBe('2026-11-02T12:15:00.000Z'); schedule.stop();
    expect(skipMissed('* * * * *', '2026-11-02T12:01:00Z', now)).toEqual({ missed: 4, capped: false, next: '2026-11-02T12:05:00.000Z' });
    for (const cron of ['* * * * * *', '61 * * * *', '@hourly', '* * * JAN MON', '0 0 31 2 *']) expect(() => cronSchedule(cron, 'UTC', now)).toThrow();
    expect(() => cronSchedule('* * * * *', 'America/Denver', now)).toThrow();
  });
});

describe('monitor persistence, invocation and notification lifecycle', () => {
  it('encrypts SMTP password, never returns it, preserves it on edit and sanitizes delivery failures', async () => {
    const f = await fixture({ sendMail: async () => { throw new Error(channelInput.pass); } });
    const stored = JSON.stringify(await f.db.rawQuery('SELECT config FROM notification_channels'));
    expect(stored).not.toContain(channelInput.pass);
    expect(stored).not.toContain(channelInput.to[0]);
    expect(stored).not.toContain(channelInput.host);
    expect(f.channel.has_password).toBe(true);
    expect(f.channel).not.toHaveProperty('pass');
    const { pass: _pass, ...edit } = channelInput;
    expect((await f.service.updateChannel(f.channel.id, { ...edit, label: 'Edited' })).has_password).toBe(true);
    await expect(f.service.testChannel(f.channel.id)).rejects.toThrow('测试邮件发送失败');
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain(channelInput.pass);
    const removed = await f.service.updateChannel(f.channel.id, { ...edit, pass: '' });
    expect(removed.has_password).toBe(false);
  });
  it('deduplicates during cooldown, separates failures, and only recovers after two consecutive normal results', async () => {
    const f = await fixture(); const monitor = await f.service.createMonitor(f.input);
    expect((await f.service.run(monitor.id)).result).toEqual({ evaluation: 'alert', delivery: 'sent' });
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]!.text).not.toContain('private@example.invalid'); expect(f.messages[0]!.text).not.toContain('remaining：'); expect(f.messages[0]!.text).not.toContain('upstream-secret');
    expect((await f.service.run(monitor.id)).result.delivery).toBe('suppressed');
    f.setEnvelope(ok({ remaining: 10 }, SOURCE));
    expect((await f.service.run(monitor.id)).monitor.runtime.false_streak).toBe(1);
    expect(f.messages).toHaveLength(1); // A suppressed alert must not get sent on the first healthy check.
    f.setEnvelope(fail(err('UPSTREAM_TIMEOUT', 'timed out'), SOURCE));
    expect((await f.service.run(monitor.id)).result).toEqual({ evaluation: 'skipped', reason: 'QUERY_FAILED', delivery: 'none' });
    f.setEnvelope(ok({ remaining: 10 }, SOURCE));
    expect((await f.service.run(monitor.id)).monitor.runtime.false_streak).toBe(1);
    const recovered = await f.service.run(monitor.id);
    expect(recovered.monitor.runtime.active).toBe(false); expect(recovered.result.delivery).toBe('sent');
    expect(f.messages).toHaveLength(2); expect(f.messages[1]!.subject).toContain('已恢复');
    await f.service.run(monitor.id); expect(f.messages).toHaveLength(2);
  });
  it('retries failed notification without exposing SMTP errors and survives restart with active state and cooldown', async () => {
    let reject = true;
    const sent: MailMessage[] = [];
    const f = await fixture({ sendMail: async (_options, mail) => { if (reject) throw new Error('fixture confidential password'); sent.push(mail); } });
    const monitor = await f.service.createMonitor(f.input);
    const failed = await f.service.run(monitor.id);
    expect(failed.result.delivery).toBe('failed'); expect(failed.monitor.runtime.last_error).toBe('SMTP_DELIVERY_FAILED');
    reject = false;
    expect((await f.service.run(monitor.id)).result.delivery).toBe('sent'); expect(sent).toHaveLength(1);
    const restarted = new MonitorService(f.deps); await restarted.init(); cleanups.push(() => restarted.stop());
    expect((await restarted.run(monitor.id)).result.delivery).toBe('suppressed'); expect(sent).toHaveLength(1);
    f.setNow('2026-11-02T13:01:00Z');
    expect((await restarted.run(monitor.id)).result.delivery).toBe('sent'); expect(sent).toHaveLength(2);
  });
  it('skips old schedules, audits their count, runs the current period once, and does not replay after restart', async () => {
    const f = await fixture(); const monitor = await f.service.createMonitor(f.input);
    f.setNow('2026-11-02T12:05:10Z');
    const restarted = new MonitorService(f.deps); await restarted.init(); cleanups.push(() => restarted.stop());
    expect(f.invokeFn).not.toHaveBeenCalled();
    expect(f.audit).toHaveBeenCalledWith({ action: 'monitor.missed', target: monitor.id, detail: { count: 4, capped: false } });
    await restarted.tick(); expect(f.invokeFn).toHaveBeenCalledTimes(1);
    await restarted.tick(); expect(f.invokeFn).toHaveBeenCalledTimes(1);
    const again = new MonitorService(f.deps); await again.init(); cleanups.push(() => again.stop());
    await again.tick(); expect(f.invokeFn).toHaveBeenCalledTimes(1);
    expect((await again.getMonitor(monitor.id)).next_run_at).toBe('2026-11-02T12:06:00.000Z');
  });
  it('stops disabled/deleted rules and protects referenced channels', async () => {
    const f = await fixture(); const monitor = await f.service.createMonitor(f.input);
    await expect(f.service.deleteChannel(f.channel.id)).rejects.toMatchObject({ code: 'CHANNEL_IN_USE' });
    await f.service.setEnabled(monitor.id, false);
    await expect(f.service.run(monitor.id)).rejects.toMatchObject({ code: 'MONITOR_DISABLED' });
    f.setNow('2026-11-02T12:05:00Z'); await f.service.tick(); expect(f.invokeFn).not.toHaveBeenCalled();
    await f.service.setEnabled(monitor.id, true);
    expect((await f.service.getMonitor(monitor.id)).next_run_at).toBe('2026-11-02T12:06:00.000Z');
    await f.service.deleteMonitor(monitor.id); await f.service.deleteChannel(f.channel.id);
    expect(await f.service.listMonitors()).toEqual([]); expect(await f.service.listChannels()).toEqual([]);
  });
  it('uses the production unified invoke gate with client visibility and only mails explicitly selected non-secret fields', async () => {
    const f = await fixture();
    const services: InvokeServices = { capabilities: { get: () => cap }, connections: { get: () => conn }, auth: { getClient: () => undefined, getGrants: () => [] },
      cache: { get: () => undefined, set: () => {}, invalidate: () => {} }, audit: { append: () => {} }, dispatch: { dispatch: async () => ok({ remaining: 3, email: 'private@example.invalid', secret: 'upstream-secret' }, SOURCE) } };
    f.deps.invoke = async (request) => invoke(request, services, { hashToken: (token) => token, redactOutput: (data, capability) => redact(data, capability.output).data }, { kind: 'admin', user_id: 'monitor-fixture' });
    const service = new MonitorService(f.deps); await service.init(); cleanups.push(() => service.stop());
    const monitor = await service.createMonitor({ ...f.input, email_fields: ['remaining', 'email'] });
    await service.run(monitor.id);
    expect(f.messages[0]!.text).toContain('remaining：3'); expect(f.messages[0]!.text).toContain('email：[redacted]');
    expect(JSON.stringify(f.messages)).not.toContain('private@example.invalid'); expect(JSON.stringify(f.messages)).not.toContain('upstream-secret');
    await expect(service.createMonitor({ ...f.input, email_fields: ['secret'] })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(service.createMonitor({ ...f.input, input: { account: 'wrong' } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
  it('evaluates a separate status failure rule and restores after two successful queries', async () => {
    const f = await fixture(); const monitor = await f.service.createMonitor({ ...f.input, mode: 'failure', condition: 'status != ok' });
    f.setEnvelope(fail(err('AUTH_EXPIRED', 'fixture upstream message'), SOURCE));
    expect((await f.service.run(monitor.id)).result.delivery).toBe('sent');
    expect(f.messages[0]!.text).not.toContain('fixture upstream message');
    f.setEnvelope(ok({ remaining: 3 }, SOURCE)); await f.service.run(monitor.id); await f.service.run(monitor.id);
    expect(f.messages).toHaveLength(2); expect(f.messages[1]!.subject).toContain('已恢复');
  });
  it('marks interrupted execution without persisting result data', async () => {
    const f = await fixture(); const monitor = await f.service.createMonitor(f.input);
    await f.db.rawRun('UPDATE monitor_runtime SET state=? WHERE monitor_id=?', [JSON.stringify(f.vault.encryptJSON({ ...monitor.runtime, last_result: 'running' }, vaultContext.monitor(monitor.id, 'state'))), monitor.id]);
    const restarted = new MonitorService(f.deps); await restarted.init(); cleanups.push(() => restarted.stop());
    expect((await restarted.getMonitor(monitor.id)).runtime.last_error).toBe('RUN_INTERRUPTED');
    expect(f.audit).toHaveBeenCalledWith({ action: 'monitor.interrupted', target: monitor.id, detail: {} });
  });
  it('restores channels, encrypted passwords and active alert state after closing and reopening the DB worker', async () => {
    const temp = tempDbPath('owngate-monitor-reopen-'); cleanups.push(() => temp.cleanup());
    const original = await fixture({ path: temp.path });
    const monitor = await original.service.createMonitor(original.input);
    await original.service.run(monitor.id);
    await original.service.stop(); await original.db.close();
    const db = new DbClient(temp.path); const restored = new MonitorService({ ...original.deps, db });
    cleanups.push(async () => { await restored.stop(); await db.close(); });
    await restored.init();
    expect((await restored.listChannels())[0]).toMatchObject({ id: original.channel.id, has_password: true });
    expect((await restored.run(monitor.id)).result.delivery).toBe('suppressed');
    original.setEnvelope(ok({ remaining: 8 }, SOURCE));
    await restored.run(monitor.id); const result = await restored.run(monitor.id);
    expect(result.monitor.runtime.active).toBe(false); expect(result.result.delivery).toBe('sent');
    expect(original.messages).toHaveLength(2);
  });
  it('rejects overlapping manual runs and waits for an active run before disabling the rule', async () => {
    const f = await fixture(); const monitor = await f.service.createMonitor(f.input);
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.deps.invoke = async () => { entered(); await gate; return ok({ remaining: 3 }, SOURCE); };
    const running = f.service.run(monitor.id); await started;
    await expect(f.service.run(monitor.id)).rejects.toMatchObject({ code: 'MONITOR_BUSY' });
    const disabled = f.service.setEnabled(monitor.id, false);
    release(); await running; await disabled;
    expect((await f.service.getMonitor(monitor.id)).enabled).toBe(false);
    await expect(f.service.run(monitor.id)).rejects.toMatchObject({ code: 'MONITOR_DISABLED' });
    expect(f.messages).toHaveLength(1);
  });
});

describe('SMTP and HTTP boundary integration', () => {
  it('enforces real admin sessions and recent second-factor verification in buildServer', async () => {
    const { buildServer } = await import('../src/main.js');
    const temp = tempDbPath('owngate-monitor-gate-');
    const server = await buildServer({ dbPath: temp.path });
    cleanups.push(async () => { await server.app.close(); temp.cleanup(); });
    const unauthenticated = await server.app.inject({ method: 'GET', url: '/admin/monitors' });
    expect(unauthenticated.statusCode).toBe(401);
    const admin = await loginAdmin(server.app);
    expect((await server.app.inject({ method: 'GET', url: '/admin/monitors', headers: admin.headers })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'POST', url: '/admin/notification-channels', headers: admin.headers, payload: channelInput })).statusCode).toBe(403);
    const verified = await stepUp(server.app, admin);
    const created = await server.app.inject({ method: 'POST', url: '/admin/notification-channels', headers: verified.headers, payload: channelInput });
    expect(created.statusCode).toBe(201); expect(created.body).not.toContain(channelInput.pass);
    // No transport is invoked: the existence check happens only after the real gate.
    expect((await server.app.inject({ method: 'POST', url: '/admin/monitors/nonexistent/run', headers: verified.headers })).statusCode).toBe(404);
    const freshSession = await loginAdmin(server.app, verified.totpSecret);
    expect((await server.app.inject({ method: 'POST', url: `/admin/notification-channels/${created.json().id}/test`, headers: freshSession.headers })).statusCode).toBe(403);
  });
  it('sends a real authenticated test message only after verified STARTTLS to a local SMTP fixture', async () => {
    const smtp = await smtpFixture(); cleanups.push(smtp.close);
    const sendMail: SendMail = (options, message) => {
      // Only the test sender trusts this local CA; product channel config cannot
      // provide tls.ca or turn off certificate verification.
      const trusted = { ...options, tls: { ca: smtp.certificate } };
      return sendSmtpMail(trusted, message);
    };
    const f = await fixture({ sendMail });
    const channel = await f.service.createChannel({ ...channelInput, port: smtp.port });
    await expect(f.service.testChannel(channel.id)).resolves.toEqual({ ok: true, status: 'sent' });
    expect(smtp.commands.some(({ encrypted, line }) => !encrypted && /^STARTTLS\b/.test(line))).toBe(true);
    expect(smtp.commands.some(({ encrypted, line }) => encrypted && /^AUTH PLAIN\b/.test(line))).toBe(true);
    expect(smtp.commands.some(({ encrypted, line }) => !encrypted && /^(AUTH|MAIL|RCPT|DATA)\b/.test(line))).toBe(false);
    expect(smtp.received.join('\n')).toContain('recipient@example.invalid');
    expect(smtp.received.join('\n')).not.toContain(channelInput.pass);
  });
  it('opts every mutation and email send into the admin step-up gate and never exposes stored secrets', async () => {
    const f = await fixture(); const app: FastifyInstance = Fastify(); cleanups.push(() => app.close());
    const routes: Array<{ method: unknown; url: string; stepUp: unknown }> = [];
    app.addHook('onRoute', (route) => { routes.push({ method: route.method, url: route.url, stepUp: route.config?.stepUp }); });
    await registerMonitorRoutes(app, { service: f.service });
    const listing = await app.inject({ method: 'GET', url: '/admin/notification-channels' });
    expect(listing.statusCode).toBe(200); expect(listing.body).not.toContain(channelInput.pass); expect(listing.body).not.toContain('ciphertext');
    const mutations = routes.filter((route) => route.method !== 'GET' && route.method !== 'HEAD');
    expect(mutations.length).toBe(9); expect(mutations.every((route) => route.stepUp === true)).toBe(true);
    const created = await app.inject({ method: 'POST', url: '/admin/monitors', payload: f.input }); expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await app.inject({ method: 'POST', url: `/admin/monitors/${id}/run` })).json().result.delivery).toBe('sent');
    expect((await app.inject({ method: 'PATCH', url: `/admin/monitors/${id}`, payload: { enabled: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/admin/monitors/${id}/run` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/admin/monitors/${id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/admin/monitors/${id}/run` })).statusCode).toBe(404);
  });
});
