import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Capability, Client, Connection, InvokeServices } from '@owngate/core';
import { registerMcpRoutes } from '../src/routes/mcp.js';

const cap: Capability = {
  id: 'account.balance', kind: 'query', title: 'Balance', description: 'Account balance', effect: 'read', approval: 'never',
  input: { type: 'object', properties: { limit: { type: 'integer' } } }, output: { type: 'object', properties: { balance: { type: 'number', 'x-unit': 'USD' } } },
  cache: { ttl: 60 }, long_running: false, cancel: 'none', idempotency: 'none', verify: null, transport: 'http', support: { status: 'supported' },
};
const client: Client = { id: 'client-1', label: 'AI', revoked: false, created_at: '2026-11-02' };
const connection: Connection = {
  id: 'conn-1', connector_id: 'fixture', label: 'Fixture', config: {},
  capability_states: { [cap.id]: { status: 'needs_auth', reason: 'Please sign in', probed_at: '2026-11-07T00:00:00Z' } }, created_at: '2026-11-02', updated_at: '2026-11-02',
};
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function fixture() {
  const app = Fastify();
  apps.push(app);
  const hidden = { ...cap, id: 'private.capability' };
  const services: InvokeServices = {
    auth: { getClient: (token) => token === 'valid' ? client : undefined, getGrants: () => [{ client_id: client.id, connection_id: connection.id, capabilities: [cap.id] }] },
    capabilities: { get: (_connector, id) => id === cap.id ? cap : hidden, list: () => [cap, hidden] },
    connections: { get: (id) => id === connection.id ? connection : undefined },
    audit: { append: () => {} }, cache: { get: () => undefined, set: () => {}, invalidate: () => {} }, dispatch: { dispatch: vi.fn() },
  };
  await registerMcpRoutes(app, { services, invokeOpts: { hashToken: (token) => token, redactOutput: (data) => data } });
  return { app, services };
}

async function call(app: FastifyInstance, name: string, args: unknown, token = 'valid') {
  const res = await app.inject({ method: 'POST', url: '/mcp', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
  }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  const data = res.body.split('\n').find((line) => line.startsWith('data:'));
  const parsed = JSON.parse(data ? data.replace(/^data:\s*/, '') : res.body);
  const result = parsed.result;
  return { isError: result?.isError, value: JSON.parse(result.content[0].text) };
}

describe('MCP capability discovery', () => {
  it('lists only granted capabilities with their real input/output schemas and connection state', async () => {
    const { app } = await fixture();
    const result = await call(app, 'list_capabilities', { connection_id: connection.id });
    expect(result.isError).not.toBe(true);
    expect(result.value.capabilities).toHaveLength(1);
    expect(result.value.capabilities[0]).toMatchObject({ id: cap.id, input: cap.input, output: cap.output, support: connection.capability_states[cap.id] });
  });

  it('describes a granted capability without executing it', async () => {
    const { app, services } = await fixture();
    const result = await call(app, 'describe_capability', { connection_id: connection.id, capability_id: cap.id });
    expect(result.value.capability).toMatchObject({ id: cap.id, input: cap.input, output: cap.output, cache: cap.cache, support: connection.capability_states[cap.id] });
    expect(services.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('does not fall back to manifest support when a connection has no observation yet', async () => {
    const previous = connection.capability_states[cap.id];
    delete connection.capability_states[cap.id];
    try {
      const { app } = await fixture();
      const result = await call(app, 'list_capabilities', { connection_id: connection.id });
      expect(result.value.capabilities[0].support).toEqual({ status: 'unverified' });
      await app.close();
      apps.splice(apps.indexOf(app), 1);
    } finally {
      if (previous) connection.capability_states[cap.id] = previous;
    }
  });

  it('does not describe a capability outside the current grant', async () => {
    const { app } = await fixture();
    const result = await call(app, 'describe_capability', { connection_id: connection.id, capability_id: 'private.capability' });
    expect(result.isError).toBe(true);
    expect(result.value.error.code).toBe('PERMISSION_DENIED');
    expect(result.value.capability).toBeUndefined();
  });

  it('checks current revocation rather than revealing previously discoverable schemas', async () => {
    const { app, services } = await fixture();
    services.auth.getClient = () => ({ ...client, revoked: true });
    const result = await call(app, 'list_capabilities', { connection_id: connection.id });
    expect(result.isError).toBe(true);
    expect(result.value.error.code).toBe('CLIENT_REVOKED');
  });
});
