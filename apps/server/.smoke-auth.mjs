import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbClient } from '/home/chenghongxu/Workspace/webridge/packages/db/dist/client.js';
import { Vault } from '/home/chenghongxu/Workspace/webridge/packages/vault/dist/vault.js';
import { createAuthService } from '/home/chenghongxu/Workspace/webridge/apps/server/dist/auth/service.js';
import { registerAuthRoutes } from '/home/chenghongxu/Workspace/webridge/apps/server/dist/routes/auth.js';
import { totpAt } from '/home/chenghongxu/Workspace/webridge/apps/server/dist/auth/totp.js';

const dir = mkdtempSync(join(tmpdir(), 'wrsmoke-'));
const db = new DbClient(join(dir, 't.db'));
const vault = new Vault('11'.repeat(32));
const auth = createAuthService({ db, vault, rpID: 'localhost', rpName: 'webridge', origin: 'http://localhost:3000' });
const app = Fastify();
await registerAuthRoutes(app, { auth, db });

const j = (r) => r.json();
const rawCookie = (r) => { const v = r.headers['set-cookie']; return Array.isArray(v) ? v[0] : v; };
const cookieOf = (r) => (rawCookie(r) ?? '').split(';')[0].split('=')[1];

let r = await app.inject({ method: 'GET', url: '/auth/status' });
console.log('1 status fresh:', r.statusCode, j(r));

r = await app.inject({ method: 'POST', url: '/auth/bootstrap', payload: { username: 'admin', password: 'hunter2hunter2' } });
console.log('2 bootstrap:', r.statusCode, j(r), 'cookie:', cookieOf(r).slice(0, 12));
const sess = cookieOf(r);

r = await app.inject({ method: 'POST', url: '/auth/bootstrap', payload: { username: 'x', password: 'hunter2hunter2' } });
console.log('3 bootstrap again:', r.statusCode, j(r));

r = await app.inject({ method: 'GET', url: '/auth/status', cookies: { wr_session: sess } });
console.log('4 status authed:', r.statusCode, j(r));

r = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'wrong' } });
console.log('5 bad login:', r.statusCode, j(r));

r = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'hunter2hunter2' } });
console.log('6 good login:', r.statusCode, j(r), 'cookie set:', Boolean(r.headers['set-cookie']));
const sess2 = cookieOf(r);

r = await app.inject({ method: 'POST', url: '/auth/totp/enroll', cookies: { wr_session: sess2 } });
const enroll = j(r);
console.log('7 totp enroll:', r.statusCode, { secret: enroll.secretBase32?.slice(0, 6) + '...', url: enroll.otpauthUrl?.slice(0, 40), enabled: enroll.enabled });

const code = totpAt(enroll.secretBase32, Math.floor(Date.now() / 1000));
r = await app.inject({ method: 'POST', url: '/auth/totp/confirm', payload: { code }, cookies: { wr_session: sess2 } });
console.log('8 totp confirm:', r.statusCode, j(r));

r = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'hunter2hunter2' } });
console.log('9 login w/o totp:', r.statusCode, j(r));

r = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'hunter2hunter2', totp: '000000' } });
console.log('10 login bad totp:', r.statusCode, j(r));

r = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'admin', password: 'hunter2hunter2', totp: totpAt(enroll.secretBase32, Math.floor(Date.now() / 1000)) } });
console.log('11 login good totp:', r.statusCode, j(r));
const sess3 = cookieOf(r);

r = await app.inject({ method: 'GET', url: '/auth/status', cookies: { wr_session: sess3 } });
console.log('12 status after totp login:', j(r));

r = await app.inject({ method: 'POST', url: '/auth/step-up/totp', payload: { code: totpAt(enroll.secretBase32, Math.floor(Date.now() / 1000)) }, cookies: { wr_session: sess3 } });
console.log('13 step-up totp:', r.statusCode, j(r));
r = await app.inject({ method: 'GET', url: '/auth/status', cookies: { wr_session: sess3 } });
console.log('14 status stepUp:', j(r).stepUp);

r = await app.inject({ method: 'POST', url: '/auth/step-up/passkey/begin', cookies: { wr_session: sess3 } });
console.log('15 step-up begin no passkey:', r.statusCode, j(r));

r = await app.inject({ method: 'GET', url: '/auth/passkeys', cookies: { wr_session: sess3 } });
console.log('16 passkeys:', r.statusCode, j(r));

r = await app.inject({ method: 'POST', url: '/auth/passkeys/register/begin', cookies: { wr_session: sess3 } });
const opts = j(r);
console.log('17 passkey reg begin:', r.statusCode, { challenge: typeof opts.challenge, rp: opts.rp, uvp: opts.authenticatorSelection?.userVerification });

const orig = await app.inject({ method: 'POST', url: '/auth/passkeys/register/begin', cookies: { wr_session: sess3 } });
r = await app.inject({ method: 'POST', url: '/auth/passkeys/register/finish', payload: { response: { id: 'xx', rawId: 'xx', type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: 'e30', attestationObject: 'e30' } } }, cookies: { wr_session: sess3 } });
console.log('18 passkey reg finish garbage:', r.statusCode, j(r));

r = await app.inject({ method: 'POST', url: '/auth/totp/disable', payload: { code: '111111' }, cookies: { wr_session: sess3 } });
console.log('19 totp disable bad code:', r.statusCode, j(r));

r = await app.inject({ method: 'GET', url: '/auth/passkeys' });
console.log('20 unauthenticated passkeys:', r.statusCode, j(r));

r = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { wr_session: sess3 } });
console.log('21 logout:', r.statusCode, j(r));
r = await app.inject({ method: 'GET', url: '/auth/status', cookies: { wr_session: sess3 } });
console.log('22 status after logout:', j(r));

const audit = await db.rawQuery('SELECT action, target FROM audit_log ORDER BY seq');
console.log('23 audit entries:', audit.length);
for (const a of audit) console.log('   ', a.action, '|', a.target);
const chain = await db.rawQuery('SELECT prev_hash, entry_hash FROM audit_log ORDER BY seq');
let okChain = true;
for (let i = 1; i < chain.length; i++) if (chain[i].prev_hash !== chain[i-1].entry_hash) okChain = false;
console.log('24 audit chain linked:', okChain, '| first prev:', chain[0]?.prev_hash);

r = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { wr_session: sess3 } });
console.log('25 double logout:', r.statusCode, j(r));

await db.close();
process.exit(0);
