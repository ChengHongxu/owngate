import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ResultEnvelope } from '@owngate/core';
import type { HttpJob, RuntimeResponse } from './types.js';

interface Child { process: ChildProcess; pending: Map<string, { resolve: (result: ResultEnvelope) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> }
export class HttpRuntimeHost {
  private children = new Map<string, Child>();
  private next = 0;
  private closed = false;
  constructor(private readonly options: { childPath?: string; maxConnectors?: number; dropPrivileges?: boolean } = {}) {
    if (options.dropPrivileges && process.getuid?.() !== 0) throw new Error('HTTP runtime must start as uid 0 to drop adapter privileges');
  }
  private child(connectorId: string): Child {
    const existing = this.children.get(connectorId); if (existing) return existing;
    if (this.children.size >= (this.options.maxConnectors ?? 32)) throw new Error('CONNECTOR_CRASHED');
    const drop = this.options.dropPrivileges && process.getuid?.() === 0;
    const childProcess = fork(this.options.childPath ?? fileURLToPath(new URL('./worker.js', import.meta.url)), [], {
      env: { NODE_ENV: 'production', LANG: 'C.UTF-8' }, execArgv: ['--max-old-space-size=128'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], ...(drop ? { uid: 65534, gid: 65534 } : {}), serialization: 'json',
    });
    const child: Child = { process: childProcess, pending: new Map() }; this.children.set(connectorId, child);
    const failed = () => {
      if (this.children.get(connectorId) === child) this.children.delete(connectorId);
      for (const pending of child.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CONNECTOR_CRASHED')); }
      child.pending.clear();
    };
    childProcess.on('error', failed); childProcess.on('exit', failed);
    childProcess.on('message', (message: RuntimeResponse | null) => {
      if (!message || typeof message.id !== 'string') return;
      const pending = child.pending.get(message.id); if (!pending) return;
      if (JSON.stringify(message).length > 4 * 1024 * 1024) { child.process.kill('SIGKILL'); failed(); return; }
      child.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.result) pending.resolve(message.result); else pending.reject(new Error(message.error ?? 'CONNECTOR_CRASHED'));
    });
    return child;
  }
  execute(job: HttpJob): Promise<ResultEnvelope> {
    if (this.closed) return Promise.reject(new Error('CONNECTOR_CRASHED'));
    const child = this.child(job.connection.connector_id);
    if (child.pending.size >= 16) return Promise.reject(new Error('CONNECTOR_CRASHED'));
    const id = String(++this.next);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.pending.delete(id); reject(new Error('UPSTREAM_TIMEOUT')); child.process.kill('SIGKILL'); }, Math.max(100, Math.min(60_000, job.timeout_ms)));
      child.pending.set(id, { resolve, reject, timer });
      child.process.send({ id, job }, (error) => { if (error) { child.pending.delete(id); clearTimeout(timer); reject(new Error('CONNECTOR_CRASHED')); } });
    });
  }
  async close() {
    this.closed = true;
    const children = [...this.children.values()]; this.children.clear();
    await Promise.all(children.map(async (child) => {
      if (child.process.exitCode !== null || child.process.signalCode !== null) return;
      await new Promise<void>((resolve) => { child.process.once('exit', () => resolve()); child.process.kill('SIGKILL'); });
    }));
  }
}
