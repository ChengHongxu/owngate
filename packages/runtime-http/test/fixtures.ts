import type { HttpJob } from '../src/types.js';

export function job(connector = 'fixture', input: unknown = {}, timeout = 4000): HttpJob {
  return {
    connection: { id: `${connector}-connection`, connector_id: connector, label: 'Fixture', config: {}, capability_states: {}, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    capability: { id: 'fixture.read', title: 'Read', description: '', kind: 'query', effect: 'read', approval: 'never', input: { type: 'object' }, output: { type: 'object' }, transport: 'http', cache: null, support: { status: 'supported' }, long_running: false, cancel: 'none', idempotency: 'native', verify: null },
    input, definition: { http: { base: 'https://upstream.invalid', headers: {} }, request: { method: 'GET', path: '/balance' }, output: { value: { from: '$.value', type: 'number' } } },
    broker_url: 'http://127.0.0.1/internal/http-runtime/' + 'a'.repeat(64), timeout_ms: timeout,
  };
}
