import { describe, expect, it, vi } from 'vitest';
import { err, fail, ok, type Capability, type Connection } from '@owngate/core';
import { ExecutionLimits } from '../src/execution-limits.js';

const capability = { id: 'query', support: { status: 'supported' } } as Capability;
const connection = { id: 'one', label: 'One', capability_states: {} } as Connection;
const source = { connection_id: 'one', connection_label: 'One', capability_id: 'query', support: capability.support };

describe('connection execution limits', () => {
  it('bounds actual requests and isolates other connections', async () => {
    let now = 1_000_000;
    const limits = new ExecutionLimits({ now: () => now }), run = vi.fn(async () => ok({ value: 1 }, source));
    await limits.run(connection, capability, 2, run); await limits.run(connection, capability, 2, run);
    expect((await limits.run(connection, capability, 2, run)).error?.code).toBe('RATE_LIMITED');
    expect(run).toHaveBeenCalledTimes(2);
    expect((await limits.run({ ...connection, id: 'two' }, capability, 2, run)).outcome).toBe('success');
    now += 60_001;
    expect((await limits.run(connection, capability, 2, run)).outcome).toBe('success');
  });
  it('opens after transient failures and permits only one recovery probe', async () => {
    let now = 1_000_000;
    const limits = new ExecutionLimits({ now: () => now, failureThreshold: 2, cooldownMs: 1000 });
    const error = vi.fn(async () => fail(err('UPSTREAM_TIMEOUT', 'Fixture timeout'), source));
    await limits.run(connection, capability, 60, error); await limits.run(connection, capability, 60, error);
    expect((await limits.run(connection, capability, 60, error)).error?.code).toBe('CIRCUIT_OPEN');
    expect(error).toHaveBeenCalledTimes(2);
    now += 1001;
    let finish!: () => void;
    const recovery = limits.run(connection, capability, 60, async () => { await new Promise<void>((resolve) => { finish = resolve; }); return ok({}, source); });
    expect((await limits.run(connection, capability, 60, error)).error?.code).toBe('CIRCUIT_OPEN');
    finish(); await recovery;
    expect(limits.snapshot(connection.id).circuit).toBe('closed');
    expect((await limits.run(connection, capability, 60, async () => ok({}, source))).outcome).toBe('success');
  });
  it('does not count invalid credentials as transient outages and supports manual reset', async () => {
    const limits = new ExecutionLimits({ failureThreshold: 1 });
    await limits.run(connection, capability, 60, async () => fail(err('AUTH_REJECTED', 'Fixture rejected'), source));
    expect(limits.snapshot(connection.id).failures).toBe(0);
    await limits.run(connection, capability, 60, async () => fail(err('UPSTREAM_ERROR', 'Fixture down'), source));
    expect(limits.snapshot(connection.id).circuit).toBe('open'); limits.reset(connection.id);
    expect(limits.snapshot(connection.id).circuit).toBe('closed');
  });
});
