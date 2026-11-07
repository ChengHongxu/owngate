import { describe, expect, it, vi } from 'vitest';
import { invoke, type Capability, type Connection, type ExecutionStep, type InvokeServices, type InvokeOptions } from '@owngate/core';
import { SecretRedactor } from '@owngate/vault';
import type { BrowserClient } from '../src/browser-client.js';
import { dispatchBrowser } from '../src/dispatchers/browser.js';
import { invokeAdminWithTrace, observeExecution } from '../src/execution-trace.js';

const capability: Capability = { id: 'feed.list', kind: 'query', effect: 'read', title: 'Fixture', description: '',
  input: { type: 'object', additionalProperties: false }, output: { type: 'object' }, cache: { ttl: 30 },
  long_running: false, cancel: 'none', idempotency: 'none', verify: null, transport: 'browser',
  approval: 'never', support: { status: 'supported' } };
const connection = (id: string): Connection => ({ id, connector_id: 'bilibili', label: 'Fixture', config: {}, capability_states: {},
  created_at: '2026-11-03T00:00:00.000Z', updated_at: '2026-11-03T00:00:00.000Z' });
const request = (id: string) => ({ connection_id: id, capability_id: capability.id, input: {} });
const caller = { kind: 'admin' as const, user_id: 'fixture-administrator' };
const options: InvokeOptions = { hashToken: token => token, redactOutput: value => value };
function services(browser: BrowserClient, connections = [connection('fixture-one')]): InvokeServices {
  return { capabilities: { get: () => capability }, connections: { get: id => connections.find(item => item.id === id) },
    auth: { getClient: () => ({ id: 'fixture-client', label: 'Fixture', revoked: false, created_at: '2026-11-03' }),
      getGrants: () => connections.map(item => ({ client_id: 'fixture-client', connection_id: item.id, capabilities: [capability.id] })) },
    cache: { get: () => undefined, set: vi.fn(), invalidate: vi.fn() }, audit: { append: vi.fn() },
    dispatch: { dispatch: (conn, cap, input) => observeExecution('transport.browser', '调用浏览器执行服务', () => dispatchBrowser(browser, conn, cap, input)) } };
}

describe('administrator execution traces', () => {
  it('returns the actual worker failure stage and recovery hint without inventing later stages', async () => {
    const check = vi.fn<BrowserClient['check']>().mockResolvedValue({ status: 'error', error: {
      code: 'RATE_LIMITED', what_happened: '账号尚在冷却期', next_step: '等待后再查询', retryable: false },
      diagnostics: [{ id: 'browser.guard', label: '检查账号冷却与预算', status: 'error', duration_ms: 2, code: 'RATE_LIMITED', detail: '账号尚在冷却期' }] });
    const svc = services({ check } as unknown as BrowserClient);
    const result = await invokeAdminWithTrace(request('fixture-one'), svc, options, caller);
    expect(check.mock.calls[0]?.[0].diagnostics).toBe(true);
    expect(result.error).toMatchObject({ code: 'RATE_LIMITED', retryable: false, details: { next_step: '等待后再查询' } });
    expect(result.execution?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'browser.guard', status: 'error', code: 'RATE_LIMITED' }),
    ]));
    expect(result.execution?.steps.some(step => ['browser.navigate', 'browser.capture', 'browser.parse', 'request.output'].includes(step.id))).toBe(false);
    expect(svc.cache.set).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(svc.audit.append).mock.calls)).not.toContain('browser.guard');
  });

  it('isolates overlapping administrator observations and keeps each cache write trace-free', async () => {
    let releaseFirst!: () => void;
    const firstWait = new Promise<void>(done => { releaseFirst = done; });
    const check = vi.fn<BrowserClient['check']>().mockImplementation(async req => {
      if (req.connection_id === 'fixture-one') await firstWait;
      else releaseFirst();
      const duration = req.connection_id === 'fixture-one' ? 11 : 22;
      return { status: 'ok', data: {}, diagnostics: [
        { id: 'browser.capture', label: '捕获预期响应', status: 'success', duration_ms: duration },
      ] };
    });
    const svc = services({ check } as unknown as BrowserClient, [connection('fixture-one'), connection('fixture-two')]);
    const [first, second] = await Promise.all([
      invokeAdminWithTrace(request('fixture-one'), svc, options, caller),
      invokeAdminWithTrace(request('fixture-two'), svc, options, caller),
    ]);
    expect(first.execution?.id).not.toBe(second.execution?.id);
    expect(first.execution?.steps.filter(step => step.id === 'browser.capture').map(step => step.duration_ms)).toEqual([11]);
    expect(second.execution?.steps.filter(step => step.id === 'browser.capture').map(step => step.duration_ms)).toEqual([22]);
    expect(svc.cache.set).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(svc.cache.set).mock.calls) expect(call[1]).not.toHaveProperty('execution');
  });

  it('does not request, expose or cache administrator diagnostics for token callers', async () => {
    const check = vi.fn<BrowserClient['check']>().mockResolvedValue({ status: 'ok', data: {}, diagnostics: [
      { id: 'browser.capture', label: '捕获预期响应', status: 'success', duration_ms: 3 },
    ] });
    const svc = services({ check } as unknown as BrowserClient);
    const result = await invoke({ ...request('fixture-one'), token: 'fixture-token' }, svc, options);
    expect(check.mock.calls[0]?.[0]).not.toHaveProperty('diagnostics');
    expect(result).not.toHaveProperty('execution');
    expect(JSON.stringify(result)).not.toContain('browser.capture');
    expect(vi.mocked(svc.cache.set).mock.calls[0]?.[1]).not.toHaveProperty('execution');
  });

  it('cannot enable diagnostics through an empty administrator identity', async () => {
    const check = vi.fn<BrowserClient['check']>().mockResolvedValue({ status: 'ok', data: {} });
    const result = await invokeAdminWithTrace({ ...request('fixture-one'), token: 'fixture-token' },
      services({ check } as unknown as BrowserClient), options, { kind: 'admin', user_id: '' });
    expect(result.outcome).toBe('success');
    expect(check.mock.calls[0]?.[0]).not.toHaveProperty('diagnostics');
    expect(result).not.toHaveProperty('execution');
  });

  it.each(['worker', 'transport'] as const)('does not copy a private %s error message into execution observations', async (stage) => {
    const privateText = 'x.com/private-account-name Error: private-exception-detail';
    const check = vi.fn<BrowserClient['check']>();
    if (stage === 'worker') check.mockResolvedValue({ status: 'error', error: {
      code: 'CAPTCHA_PRESENT', what_happened: privateText, next_step: '请人工处理验证', retryable: false,
    } });
    else check.mockRejectedValue(new Error(privateText));
    const result = await invokeAdminWithTrace(request('fixture-one'), services({ check } as unknown as BrowserClient), options, caller);
    expect(result.outcome).toBe('error');
    expect(result.error?.message).toContain(privateText);
    const observations = JSON.stringify(result.execution);
    expect(observations).not.toContain('private-account-name');
    expect(observations).not.toContain('private-exception-detail');
    expect(result.execution?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'request.execute', status: 'error', code: result.error?.code }),
      expect.objectContaining({ id: 'transport.browser', status: 'error', code: result.error?.code }),
    ]));
  });

  it('bounds worker observations, ignores malformed entries and strips extra fields, URLs and secrets', async () => {
    const redactor = new SecretRedactor(); redactor.register('fixture-one', ['fixture-private-control-key']);
    const diagnostics = [
      { id: 'browser.capture', label: '捕获响应', status: 'error', duration_ms: 2, detail: '缺少响应 fixture-private-control-key https://example.invalid/account?token=fixture-url-secret', headers: { authorization: 'never-forward-this' } },
      { id: 'arbitrary-content', label: 'never-forward-this', status: 'success', duration_ms: 3 },
      { id: 'browser.parse', label: '解析', status: 'success', duration_ms: -1 },
    ] as unknown as ExecutionStep[];
    const check = vi.fn<BrowserClient['check']>().mockResolvedValue({ status: 'error',
      error: { code: 'PARSE_FAILED', what_happened: '缺少响应', next_step: '检查站点页面', retryable: false }, diagnostics });
    const result = await invokeAdminWithTrace(request('fixture-one'), services({ check } as unknown as BrowserClient),
      { ...options, sanitize: value => redactor.redact(value) }, caller);
    const json = JSON.stringify(result.execution);
    expect(json).not.toContain('fixture-private-control-key');
    expect(json).not.toContain('fixture-url-secret');
    expect(json).not.toContain('never-forward-this');
    expect(result.execution?.steps.filter(step => step.id.startsWith('browser.')).map(step => step.id)).toEqual(['browser.capture']);
  });

  it('preserves diagnostic warnings even when the worker returns a failed envelope', async () => {
    const check = vi.fn<BrowserClient['check']>().mockResolvedValue({ status: 'error',
      error: { code: 'PARSE_FAILED', what_happened: '条目无法解析', next_step: '检查适配器', retryable: false },
      warnings: ['响应已读取，内容不完整'], item_errors: [{ index: 1, code: 'ITEM_PARSE_FAILED', reason: '缺少已知条目标识' }] });
    const result = await invokeAdminWithTrace(request('fixture-one'), services({ check } as unknown as BrowserClient), options, caller);
    expect(result.warnings).toEqual(['响应已读取，内容不完整', 'ITEM_PARSE_FAILED · 第 2 条：缺少已知条目标识']);
  });
});
