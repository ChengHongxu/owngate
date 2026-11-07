import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { HttpRuntimeHost } from './host.js';
import { RuntimeAuth } from './auth.js';
import type { HttpJob } from './types.js';

const secretFile = process.env['HTTP_RUNTIME_SECRET_FILE'];
const secret = process.env['HTTP_RUNTIME_SECRET'] ?? (secretFile ? readFileSync(secretFile, 'utf8').trim() : '');
if (secretFile) { const stat = statSync(secretFile); if ((stat.mode & 0o077) !== 0 || stat.uid === 65534) throw new Error('Runtime control secret must be private and unreadable by adapter uid 65534'); }
if (secret.length < 32) throw new Error('HTTP runtime requires an independent control secret');
const brokerOrigin = new URL(process.env['HTTP_BROKER_ORIGIN'] ?? 'http://server:3000').origin;
const auth = new RuntimeAuth(secret), host = new HttpRuntimeHost({ dropPrivileges: true });
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') { response.end('{"ok":true}'); return; }
  if (request.method !== 'POST' || request.url !== '/v1/execute') { response.writeHead(404); response.end(); return; }
  const buffers: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 256 * 1024) { response.writeHead(413); response.end(); return; } buffers.push(buffer); }
  const body = Buffer.concat(buffers).toString('utf8');
  if (!auth.verify(request.headers, 'POST', '/v1/execute', body)) { response.writeHead(401); response.end(); return; }
  let job: HttpJob;
  try {
    job = JSON.parse(body) as HttpJob;
    const callback = new URL(job.broker_url);
    if (callback.origin !== brokerOrigin || callback.username || callback.password || !/^\/internal\/http-runtime\/[a-f0-9]{64}$/.test(callback.pathname) || callback.search || callback.hash) throw new Error('Invalid callback');
    if (!job.connection?.connector_id || !['GET', 'HEAD', 'ADAPTER'].includes(job.definition?.request?.method) || job.capability?.effect !== 'read' || job.capability.kind !== 'query' || JSON.stringify(job.definition.http.headers ?? {}) !== '{}') throw new Error('Invalid read job');
  } catch { response.writeHead(400); response.end(); return; }
  response.setHeader('content-type', 'application/json');
  try { response.end(JSON.stringify(await host.execute(job))); }
  catch (error) { response.writeHead(502); response.end(JSON.stringify({ code: error instanceof Error && error.message === 'UPSTREAM_TIMEOUT' ? 'UPSTREAM_TIMEOUT' : 'CONNECTOR_CRASHED' })); }
});
server.headersTimeout = 5000; server.requestTimeout = 60_000;
server.listen(Number(process.env['HTTP_RUNTIME_PORT'] ?? 5000), '0.0.0.0');
let closing = false;
const close = () => { if (closing) return; closing = true; server.closeAllConnections(); server.close(() => { void host.close().then(() => process.exit(0)); }); };
process.once('SIGTERM', close); process.once('SIGINT', close);
