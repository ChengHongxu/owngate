import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { HttpRuntimeHost } from '../src/host.js';
import { job } from './fixtures.js';

const hosts: HttpRuntimeHost[] = [];
function host(options: { maxConnectors?: number } = {}) {
  const value = new HttpRuntimeHost({ childPath: fileURLToPath(new URL('./fixtures/child.mjs', import.meta.url)), ...options }); hosts.push(value); return value;
}
afterEach(async () => { await Promise.all(hosts.splice(0).map(value => value.close())); vi.unstubAllEnvs(); });

describe('real connector subprocess isolation', () => {
  it('reuses only the same connector process and never inherits parent credentials', async () => {
    vi.stubEnv('MASTER_KEY_HEX', 'parent-only-secret'); vi.stubEnv('HTTP_RUNTIME_SECRET', 'parent-control-secret');
    const runtime = host();
    const first = await runtime.execute(job('first'));
    const repeated = await runtime.execute(job('first', 'malformed'));
    const other = await runtime.execute(job('other'));
    expect(first.data).toMatchObject({ connector: 'first', env: { NODE_ENV: 'production', LANG: 'C.UTF-8' } });
    expect(JSON.stringify(first)).not.toContain('parent-');
    expect(repeated.data).toMatchObject({ pid: (first.data as { pid: number }).pid });
    expect((other.data as { pid: number }).pid).not.toBe((first.data as { pid: number }).pid);
  });
  it('contains a crash and a timeout to that connector and starts a fresh process afterwards', async () => {
    const runtime = host();
    const [crashed, unaffected] = await Promise.allSettled([runtime.execute(job('bad', 'crash')), runtime.execute(job('good', 'wait'))]);
    expect(crashed.status).toBe('rejected'); expect(unaffected.status).toBe('fulfilled');
    await expect(runtime.execute(job('bad', 'hang', 500))).rejects.toThrow('UPSTREAM_TIMEOUT');
    await expect(runtime.execute(job('good'))).resolves.toMatchObject({ outcome: 'success' });
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    await expect(runtime.execute(job('bad'))).resolves.toMatchObject({ outcome: 'success' });
  });
  it('bounds connector allocation and refuses new work after close', async () => {
    const runtime = host({ maxConnectors: 1 });
    await runtime.execute(job('first'));
    expect(() => runtime.execute(job('second'))).toThrow('CONNECTOR_CRASHED');
    await runtime.close(); await expect(runtime.execute(job('first'))).rejects.toThrow('CONNECTOR_CRASHED');
  });
  it('refuses to promise privilege dropping when started as an unprivileged control process', () => {
    if (process.getuid?.() === 0) return; // The production root-to-nobody path is verified by Docker smoke.
    expect(() => new HttpRuntimeHost({ dropPrivileges: true })).toThrow('must start as uid 0');
  });
});
