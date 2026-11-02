import { Worker } from 'node:worker_threads';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = '/tmp/test-worker-direct.db';
if (existsSync(DB_PATH)) rmSync(DB_PATH);

const worker = new Worker(resolve(__dirname, '../dist/worker.js'), {
  workerData: { dbPath: DB_PATH },
});

worker.on('error', (e) => { console.error('WORKER ERROR:', e.message, e.stack); process.exit(1); });
worker.on('online', () => console.log('WORKER ONLINE'));
worker.on('exit', (code) => { console.log('WORKER EXIT', code); });

worker.on('message', (m) => {
  console.log('MSG:', JSON.stringify(m, null, 2));
  worker.terminate();
});

setTimeout(() => {
  console.log('sending request...');
  worker.postMessage({ id: 1, method: 'listConnectors', args: {} });
}, 300);

setTimeout(() => {
  console.error('TIMEOUT - no response from worker');
  worker.terminate();
  process.exit(1);
}, 5000);
