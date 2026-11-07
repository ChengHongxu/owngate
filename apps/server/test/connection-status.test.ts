import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Capability, Connection, SupportState } from '@owngate/core';
import { effectiveCapabilityState, summarizeConnectionHealth } from '../src/connection-status.js';
import { buildServer } from '../src/main.js';
import { adminWithStepUp, tempDbPath, type AdminSession } from './helpers/admin.js';

function capability(id: string, status: SupportState['status'] = 'supported'): Capability {
  return { id, kind: 'query', title: id, description: id, effect: 'read', approval: 'never', input: { type: 'object' },
    output: { type: 'object' }, cache: null, long_running: false, cancel: 'none', idempotency: 'none', verify: null,
    transport: 'http', support: { status } };
}

function states(values: Record<string, SupportState['status']>): Pick<Connection, 'capability_states'> {
  return { capability_states: Object.fromEntries(Object.entries(values).map(([id, status]) => [id,
    { status, ...(status !== 'unverified' ? { probed_at: '2026-11-07T00:00:00Z' } : {}) }])) };
}

describe('connection health from relevant capability evidence', () => {
  const caps = [capability('identity'), capability('models'), capability('usage')];

  it('does not claim a destination was verified from its implementation defaults', () => {
    expect(summarizeConnectionHealth(states({}), caps, 'identity')).toEqual({ status: 'unverified', reason: '3 项待验证' });
    expect(summarizeConnectionHealth(states({}), [])).toEqual({ status: 'unverified' });
  });

  it('requires observed evidence for authentication or adaptation failure on an implemented query', () => {
    for (const status of ['needs_adapter', 'needs_auth'] as const) {
      expect(effectiveCapabilityState(capability('identity'), { status, reason: 'No observed check' })).toEqual({ status: 'unverified' });
      expect(effectiveCapabilityState(capability('identity'), { status, probed_at: '2026-11-07T00:00:00Z' })).toEqual({ status, probed_at: '2026-11-07T00:00:00Z' });
    }
    expect(effectiveCapabilityState(capability('identity', 'needs_adapter'))).toEqual({ status: 'needs_adapter' });
  });

  it('keeps a usable connection healthy while other capabilities await their first check', () => {
    expect(summarizeConnectionHealth(states({ identity: 'supported', models: 'unverified', usage: 'unverified' }), caps, 'identity'))
      .toEqual({ status: 'healthy', reason: '1 项可用 · 2 项待验证' });
  });

  it('does not mistake endpoint-specific authentication for an account-wide login failure', () => {
    const value = states({ identity: 'supported', models: 'needs_auth', usage: 'unverified' });
    value.capability_states['usage']!.reason = '授权已验证，请单独验证此能力';
    expect(summarizeConnectionHealth(value, caps, 'identity'))
      .toEqual({ status: 'partial', reason: '1 项可用 · 1 项待验证 · 1 项需要认证' });
  });

  it('does not let a public endpoint hide a failed designated authentication check', () => {
    expect(summarizeConnectionHealth(states({ identity: 'needs_auth', models: 'supported' }), caps, 'identity'))
      .toEqual({ status: 'needs_auth', reason: '认证检查未通过，请检查登录或凭据' });
  });

  it('ignores stored states belonging to hidden roles or removed capabilities', () => {
    const value = states({ identity: 'supported', 'admin.hidden': 'needs_auth', 'removed.query': 'needs_adapter' });
    expect(summarizeConnectionHealth(value, [capability('identity')], 'identity'))
      .toEqual({ status: 'healthy', reason: '1 项可用' });
  });

  it('keeps runtime failure, adaptation failure and unknown support distinct', () => {
    expect(summarizeConnectionHealth(states({}), [capability('models', 'needs_adapter')]))
      .toEqual({ status: 'needs_adapter', reason: '1 项适配异常' });
    expect(summarizeConnectionHealth(states({ models: 'unavailable' }), [capability('models')]))
      .toEqual({ status: 'unavailable', reason: '1 项暂不可用' });
    expect(summarizeConnectionHealth(states({ models: 'needs_adapter', usage: 'unverified' }), [capability('models'), capability('usage')]))
      .toEqual({ status: 'needs_adapter', reason: '1 项待验证 · 1 项适配异常' });
    expect(summarizeConnectionHealth(states({ identity: 'supported', models: 'unavailable' }), [capability('identity'), capability('models')]))
      .toEqual({ status: 'partial', reason: '1 项可用 · 1 项暂不可用' });
  });

  it('respects pause and implementation boundaries independently from previous query success', () => {
    expect(summarizeConnectionHealth({ ...states({ identity: 'supported' }), paused: true }, caps, 'identity')).toEqual({ status: 'paused' });
    expect(summarizeConnectionHealth(states({ identity: 'supported' }), [capability('identity', 'disabled')])).toEqual({ status: 'disabled' });
    expect(summarizeConnectionHealth(states({ identity: 'supported' }), [capability('identity', 'unsupported')]))
      .toEqual({ status: 'unsupported', reason: '1 项不支持' });
    const action = { ...capability('publish'), kind: 'action' as const, effect: 'write' as const };
    expect(summarizeConnectionHealth(states({ identity: 'supported', publish: 'disabled' }), [capability('identity'), action]))
      .toEqual({ status: 'healthy', reason: '1 项可用' });
  });

  it('uses capability-level failures in a mixed summary rather than promoting an arbitrary reason', () => {
    expect(summarizeConnectionHealth(states({ identity: 'supported', models: 'needs_plan', usage: 'partial' }), caps, 'identity'))
      .toEqual({ status: 'partial', reason: '1 项可用 · 1 项部分可用 · 1 项受套餐限制' });
    expect(summarizeConnectionHealth(states({ identity: 'unverified', models: 'needs_auth' }), [capability('identity'), capability('models')], 'identity'))
      .toEqual({ status: 'unavailable', reason: '1 项待验证 · 1 项需要认证' });
  });
});

describe('admin connection summary contract', () => {
  const temp = tempDbPath('owngate-health-');
  let server: Awaited<ReturnType<typeof buildServer>>;
  let admin: AdminSession;

  beforeAll(async () => { vi.stubEnv('MASTER_KEY_HEX', '77'.repeat(32)); server = await buildServer({ dbPath: temp.path }); admin = await adminWithStepUp(server.app); });
  afterAll(async () => { await server?.app.close(); temp.cleanup(); vi.unstubAllEnvs(); });

  it('returns the same role-aware health on creation, listing, overview and pause', async () => {
    const create = await server.app.inject({ method: 'POST', url: '/admin/connections', headers: admin.headers,
      payload: { connector_id: 'newapi', label: 'Summary fixture', config: { base_url: 'http://127.0.0.1:1', user_id: 'fixture', role: 'user' } } });
    expect(create.statusCode).toBe(201);
    expect(create.json().health.status).toBe('unverified');
    const connection = server.services.connections.get(create.json().id as string)!;
    connection.capability_states['account.balance'] = { status: 'supported', probed_at: '2026-11-07T00:00:00Z' };
    connection.capability_states['admin.users'] = { status: 'needs_auth', reason: 'Hidden administrator endpoint' };
    const list = await server.app.inject({ method: 'GET', url: '/admin/connections', headers: admin.headers });
    const item = list.json().connections.find((value: { id: string }) => value.id === connection.id);
    expect(item.health.status).toBe('healthy');
    expect(item.health.reason).not.toContain('认证');
    const overview = await server.app.inject({ method: 'GET', url: '/admin/overview', headers: admin.headers });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().connections.find((value: { id: string }) => value.id === connection.id).health).toEqual(item.health);
    const pause = await server.app.inject({ method: 'PATCH', url: `/admin/connections/${connection.id}/state`, headers: admin.headers, payload: { paused: true } });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().health).toEqual({ status: 'paused' });
  });

  it('restores unknown observations consistently without erasing real failures or changing the settings revision', async () => {
    const create = await server.app.inject({ method: 'POST', url: '/admin/connections', headers: admin.headers,
      payload: { connector_id: 'newapi', label: 'Restart fixture', config: { base_url: 'http://127.0.0.1:1', user_id: 'fixture', role: 'user' } } });
    const connection = server.services.connections.get(create.json().id as string)!;
    const revision = connection.updated_at;
    await server.db.updateConnectionStates(connection.id, {
      'account.balance': { status: 'supported', probed_at: '2026-11-07T00:00:00Z' },
      'model.list': { status: 'needs_adapter', reason: '授权已验证，请单独验证此能力' },
      'usage.logs': { status: 'needs_adapter', reason: 'Observed parse failure', probed_at: '2026-11-07T00:00:00Z' },
      'usage.summary': { status: 'needs_auth', reason: '配置已修改，请重新验证' },
    }, revision);
    await server.app.close();
    server = await buildServer({ dbPath: temp.path });
    const restored = server.services.connections.get(connection.id)!;
    expect(restored.updated_at).toBe(revision);
    expect(restored.capability_states['model.list']).toEqual({ status: 'unverified' });
    expect(restored.capability_states['usage.summary']).toEqual({ status: 'unverified' });
    expect(restored.capability_states['usage.logs']?.status).toBe('needs_adapter');
    expect(restored.capability_states['usage.logs']?.probed_at).toBe('2026-11-07T00:00:00Z');
    const list = await server.app.inject({ method: 'GET', url: '/admin/connections', headers: admin.headers });
    expect(list.statusCode).toBe(200);
    const view = list.json().connections.find((value: { id: string }) => value.id === connection.id);
    expect(view.capability_states).toEqual(restored.capability_states);
    expect(view.health.status).toBe('partial');
    const saved = (await server.db.listConnections()).find(value => value.id === connection.id)!;
    expect(saved.capability_states).toEqual(restored.capability_states);
  });
});
