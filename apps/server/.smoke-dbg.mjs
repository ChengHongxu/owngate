import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbClient } from '/home/chenghongxu/Workspace/webridge/packages/db/dist/client.js';
import { Vault } from '/home/chenghongxu/Workspace/webridge/packages/vault/dist/vault.js';
import { createAuthService } from '/home/chenghongxu/Workspace/webridge/apps/server/dist/auth/service.js';
import { registerAuthRoutes } from '/home/chenghongxu/Workspace/webridge/apps/server/dist/routes/auth.js';

const dir = mkdtempSync(join(tmpdir(), 'wrdbg-'));
const db = new DbClient(join(dir, 't.db'));
const vault = new Vault('11'.repeat(32));
const auth = createAuthService({ db, vault, rpID: 'localhost', rpName: 'webridge', origin: 'http://localhost:3000' });
const app = Fastify();
await registerAuthRoutes(app, { auth, db });

const r = await app.inject({ method: 'POST', url: '/auth/bootstrap', payload: { username: 'admin', password: 'hunter2hunter2' } });
console.log('set-cookie raw:', r.headers['set-cookie']);
const val = (Array.isArray(r.headers['set-cookie']) ? r.headers['set-cookie'][0] : r.headers['set-cookie']).split(';')[0].split('=')[1];
console.log('parsed value:', val, 'len', val.length);
const rows = await db.rawQuery('SELECT id, user_id, expires_at FROM login_sessions');
console.log('db sessions:', rows.length, rows[0] && { id: rows[0].id.slice(0,8), expires: rows[0].expires_at });
console.log('getSession direct:', await auth.getSession(val));

const r2 = await app.inject({ method: 'GET', url: '/auth/status', headers: { cookie: `wr_session=${val}` } });
console.log('status via header cookie:', r2.statusCode, r2.json());
const r3 = await app.inject({ method: 'GET', url: '/auth/status', cookies: { wr_session: val } });
console.log('status via inject cookies:', r3.statusCode, r3.json());
await db.close(); process.exit(0);
