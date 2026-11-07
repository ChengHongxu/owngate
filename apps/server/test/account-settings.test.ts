import Fastify, { type LightMyRequestResponse } from 'fastify';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbClient } from '@owngate/db';
import { Vault, vaultContext } from '@owngate/vault';
import { AuthService } from '../src/auth/service.js';
import { createAdminGate } from '../src/auth/guard.js';
import { totpAt } from '../src/auth/totp.js';
import { registerAuthRoutes } from '../src/routes/auth.js';
import { tempDbPath } from './helpers/admin.js';

// Routes/cookies/password hashes/TOTP/SQLite are real. Only authenticator
// hardware signatures are replaced, as in the existing recovery integration.
vi.mock('@simplewebauthn/server', async (original) => {
  const sdk = await original<typeof import('@simplewebauthn/server')>();
  const valid = (options: { response: { response: { clientDataJSON: string } }; expectedChallenge: unknown; expectedOrigin: unknown; expectedRPID: string; requireUserVerification: boolean }, type: string) => {
    const data = JSON.parse(Buffer.from(options.response.response.clientDataJSON, 'base64url').toString()) as { challenge: string; type: string; origin: string };
    return data.challenge === options.expectedChallenge && data.type === type && data.origin === options.expectedOrigin
      && options.expectedRPID === 'localhost' && options.requireUserVerification;
  };
  return { ...sdk,
    verifyRegistrationResponse: vi.fn(async (options) => ({ verified: valid(options, 'webauthn.create'),
      registrationInfo: { credential: { id: options.response.id, publicKey: Buffer.from('settings-synthetic-public-key'), counter: 0 }, credentialDeviceType: 'singleDevice' } })),
    verifyAuthenticationResponse: vi.fn(async (options) => ({ verified: valid(options, 'webauthn.get'), authenticationInfo: { newCounter: options.credential.counter + 1 } })),
  };
});

const password = 'settings-private-current-password';
const newPassword = 'settings-private-replacement-password';
const key = '66'.repeat(32);
const origin = 'http://localhost:3000';
const cleanup: Array<() => void | Promise<void>> = [];
const code = (secret: string) => totpAt(secret, Math.floor(Date.now() / 1000));
const sessionCookie = (response: LightMyRequestResponse) => `og_session=${response.cookies.find((cookie) => cookie.name === 'og_session')!.value}`;
const authenticator = (challenge: string, type = 'webauthn.get') => ({ id: 'settings-synthetic-key', response: {
  transports: ['internal'], clientDataJSON: Buffer.from(JSON.stringify({ type, origin, challenge })).toString('base64url'),
} });
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(options: { path?: string; bootstrap?: boolean } = {}) {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DEV_SKIP_AUTH', '0');
  const temporary = options.path ? undefined : tempDbPath('owngate-account-settings-');
  if (temporary) cleanup.push(temporary.cleanup);
  const path = options.path ?? temporary!.path;
  let logs = '';
  const stream = new Writable({ write(chunk, _encoding, done) { logs += String(chunk); done(); } });
  const app = Fastify({ logger: { level: 'trace', stream } }), db = new DbClient(path), vault = new Vault(key);
  const auth = new AuthService({ db, vault, rpID: 'localhost', rpName: 'Settings fixture', origin });
  await registerAuthRoutes(app, { db, auth });
  app.addHook('onRequest', createAdminGate(auth));
  app.post('/admin/sensitive', { config: { stepUp: true } }, async () => ({ ok: true }));
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); await db.close(); } };
  cleanup.push(close);
  let cookie = '', userId = '';
  if (options.bootstrap !== false) {
    const bootstrap = await app.inject({ method: 'POST', url: '/auth/bootstrap', payload: { username: 'admin', password } });
    expect(bootstrap.statusCode).toBe(201);
    cookie = sessionCookie(bootstrap); userId = (bootstrap.json() as { id: string }).id;
  }
  const post = (url: string, payload?: unknown, useCookie = cookie) => app.inject({ method: 'POST', url, headers: { cookie: useCookie }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { cookie: useCookie, 'content-type': 'application/json' } }) });
  const rename = (username: string, current_password = password, useCookie = cookie) => app.inject({ method: 'PATCH', url: '/auth/account', headers: { cookie: useCookie }, payload: { username, current_password } });
  const changePassword = (next = newPassword, current = password, useCookie = cookie) => post('/auth/account/password', { current_password: current, new_password: next }, useCookie);
  const enableTotp = async () => {
    expect((await post('/auth/mfa/setup', { password })).statusCode).toBe(200);
    const enroll = await post('/auth/totp/enroll'); expect(enroll.statusCode).toBe(200);
    const secret = (enroll.json() as { secretBase32: string }).secretBase32;
    expect((await post('/auth/totp/confirm', { code: code(secret) })).statusCode).toBe(200);
    return secret;
  };
  const stepTotp = async (secret: string) => { expect((await post('/auth/step-up/totp', { password, code: code(secret) })).statusCode).toBe(200); };
  const addPasskey = async () => {
    const begin = await post('/auth/passkeys/register/begin'); expect(begin.statusCode).toBe(200);
    expect((await post('/auth/passkeys/register/finish', { response: authenticator(begin.json().challenge as string, 'webauthn.create') })).statusCode).toBe(201);
  };
  const stepPasskey = async () => {
    const begin = await post('/auth/step-up/passkey/begin'); expect(begin.statusCode).toBe(200);
    expect((await post('/auth/step-up/passkey/finish', { response: authenticator(begin.json().challenge as string) })).statusCode).toBe(200);
  };
  return { app, db, auth, vault, path, cookie, userId, post, rename, changePassword, enableTotp, stepTotp, addPasskey, stepPasskey, close, logs: () => logs };
}

describe('self-service administrator account settings', () => {
  it('authenticates reads and both writes before reporting schema errors', async () => {
    const f = await fixture();
    for (const method of ['GET', 'PATCH', 'POST'] as const) {
      const response = await f.app.inject({ method, url: method === 'POST' ? '/auth/account/password' : '/auth/account', ...(method === 'GET' ? {} : { payload: {} }) });
      expect(response.statusCode).toBe(401); expect(response.json().code).toBe('NO_SESSION');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const account = await f.app.inject({ url: '/auth/account', headers: { cookie: f.cookie } });
    expect(account.json()).toEqual({ id: f.userId, username: 'admin', createdAt: expect.any(String) });
    expect(account.body).not.toContain('password_hash'); expect(account.body).not.toContain('totp');
  });

  it('requires the current password, preserves no-op sessions and never grants ordinary step-up', async () => {
    const f = await fixture(), before = await f.db.getAdminById(f.userId);
    for (const response of [await f.rename('new-admin', 'private-wrong-password'), await f.changePassword(newPassword, 'private-wrong-password')]) {
      expect(response.statusCode).toBe(403); expect(response.json().code).toBe('INVALID_CURRENT_PASSWORD');
    }
    for (const response of [await f.rename('  admin  '), await f.changePassword(password)]) {
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ ok: true, changed: false, requiresLogin: false });
      expect(response.cookies).toEqual([]);
    }
    expect(await f.db.getAdminById(f.userId)).toEqual(before);
    expect((await f.post('/admin/sensitive')).statusCode).toBe(403);
    expect((await f.post('/auth/totp/enroll')).json().code).toBe('MFA_SETUP_REQUIRED');
    expect((await f.app.inject({ url: '/auth/status', headers: { cookie: f.cookie } })).json().authenticated).toBe(true);
    expect(await f.db.rawQuery("SELECT * FROM audit_log WHERE action IN ('auth.account.username.change','auth.password.change')")).toEqual([]);
  });

  it('rejects empty, long, control-character, coerced and additional account inputs', async () => {
    const f = await fixture();
    for (const payload of [
      { username: '  ', current_password: password }, { username: 'a'.repeat(129), current_password: password },
      { username: 'admin\u0000name', current_password: password }, { username: 'admin\u200bname', current_password: password },
      { username: 123, current_password: password }, { username: 'admin', current_password: password, role: 'other' },
    ]) expect((await f.app.inject({ method: 'PATCH', url: '/auth/account', headers: { cookie: f.cookie }, payload })).statusCode).toBe(400);
    expect((await f.db.getAdminById(f.userId))?.username).toBe('admin');
    const other = await fixture();
    for (const payload of [
      { current_password: password, new_password: 'short' }, { current_password: password, new_password: 'a'.repeat(1025) },
      { current_password: '', new_password: newPassword }, { current_password: 'a'.repeat(1025), new_password: newPassword },
      { current_password: password, new_password: 12345678 }, { current_password: password, new_password: newPassword, password: 'extra' },
    ]) expect((await other.post('/auth/account/password', payload)).statusCode).toBe(400);
    expect((await other.post('/auth/login', { username: 'admin', password })).statusCode).toBe(200);
  });

  it('uses the configured public origin and rate-limits current-password checks per account', async () => {
    const f = await fixture();
    for (const headers of [{ origin: 'http://evil.invalid', host: 'evil.invalid' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await f.app.inject({ method: 'PATCH', url: '/auth/account', headers: { cookie: f.cookie, ...headers }, payload: { username: 'new-admin', current_password: password } });
      expect(response.statusCode).toBe(403); expect(response.json().code).toBe('INVALID_ORIGIN');
    }
    const valid = await f.app.inject({ method: 'PATCH', url: '/auth/account', headers: { cookie: f.cookie, origin, host: 'internal-proxy:9999' }, payload: { username: 'admin', current_password: password } });
    expect(valid.statusCode).toBe(200);
    for (let index = 0; index < 9; index++) expect((await f.rename('admin', 'wrong-password')).json().code).toBe('INVALID_CURRENT_PASSWORD');
    const limited = await f.rename('admin'); expect(limited.statusCode).toBe(429); expect(limited.json().code).toBe('ACCOUNT_RATE_LIMIT');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 61_000);
    expect((await f.rename('admin')).statusCode).toBe(200);
  });

  it('renames the account, revokes every session and pending initial setup without touching platform ciphertext', async () => {
    const f = await fixture();
    await f.db.upsertConnector({ id: 'fixture', title: 'Fixture', version: '1', transport: 'http', manifest: {} });
    await f.db.createConnection({ id: 'fixture-connection', connector_id: 'fixture', label: 'Fixture', config: {} });
    const blob = f.vault.encrypt('private-fixture-platform-token', vaultContext.credential('fixture-connection', 'token'));
    await f.db.upsertCredential({ connection_id: 'fixture-connection', key: 'token', ...blob });
    const platform = await f.db.listCredentials('fixture-connection'), before = await f.db.getAdminById(f.userId);
    const other = await f.post('/auth/login', { username: 'admin', password }), otherCookie = sessionCookie(other);
    await f.post('/auth/mfa/setup', { password });
    const enroll = await f.post('/auth/totp/enroll'), begin = await f.post('/auth/passkeys/register/begin');
    const renamed = await f.rename('  renamed-admin  ');
    expect(renamed.json()).toEqual({ ok: true, changed: true, requiresLogin: true });
    expect(renamed.cookies.map((cookie) => cookie.name).sort()).toEqual(['og_login_flow', 'og_session']);
    expect(renamed.cookies.every((cookie) => cookie.value === '')).toBe(true);
    expect(await f.db.rawQuery('SELECT * FROM login_sessions WHERE user_id=?', [f.userId])).toEqual([]);
    for (const cookie of [f.cookie, otherCookie]) expect((await f.app.inject({ url: '/auth/account', headers: { cookie } })).statusCode).toBe(401);
    expect((await f.post('/auth/totp/confirm', { code: code(enroll.json().secretBase32 as string) })).statusCode).toBe(401);
    expect((await f.post('/auth/passkeys/register/finish', { response: authenticator(begin.json().challenge as string, 'webauthn.create') })).statusCode).toBe(401);
    expect((await f.post('/auth/login', { username: 'admin', password })).statusCode).toBe(401);
    const login = await f.post('/auth/login', { username: 'renamed-admin', password }); expect(login.statusCode).toBe(200);
    expect((await f.post('/auth/totp/confirm', { code: code(enroll.json().secretBase32 as string) }, sessionCookie(login))).statusCode).toBe(403);
    expect(await f.db.getTotpSecret(f.userId)).toBeUndefined(); expect(await f.db.listWebauthnCredentials(f.userId)).toEqual([]);
    const after = await f.db.getAdminById(f.userId);
    expect(after).toEqual({ ...before, username: 'renamed-admin' });
    expect(await f.db.listCredentials('fixture-connection')).toEqual(platform);
    expect(f.vault.decrypt(platform[0]!, vaultContext.credential('fixture-connection', 'token'))).toBe('private-fixture-platform-token');
  });

  it('requires TOTP step-up, including no-op changes, while always verifying the current password', async () => {
    const f = await fixture(), secret = await f.enableTotp(), stored = await f.db.getTotpSecret(f.userId);
    for (const response of [await f.rename('admin'), await f.changePassword()]) {
      expect(response.statusCode).toBe(403); expect(response.json().code).toBe('STEP_UP_REQUIRED');
    }
    await f.stepTotp(secret);
    expect((await f.rename('new-admin', 'private-wrong-password')).json().code).toBe('INVALID_CURRENT_PASSWORD');
    expect((await f.rename('admin')).json().requiresLogin).toBe(false);
    expect((await f.rename('totp-admin')).json().requiresLogin).toBe(true);
    expect(await f.db.getTotpSecret(f.userId)).toEqual(stored);
    expect((await f.post('/auth/login', { username: 'totp-admin', password })).json().code).toBe('TOTP_REQUIRED');
    expect((await f.post('/auth/login', { username: 'totp-admin', password, totp: code(secret) })).statusCode).toBe(200);
  });

  it('prefers Passkey over TOTP and invalidates pending login/step-up/enrollment challenges after a password change', async () => {
    const f = await fixture(), secret = await f.enableTotp(); await f.stepTotp(secret); await f.addPasskey();
    expect((await f.changePassword()).json().code).toBe('STEP_UP_REQUIRED');
    expect((await f.post('/auth/step-up/totp', { password, code: code(secret) })).json().code).toBe('PASSKEY_REQUIRED');
    await f.stepPasskey();
    const stored = await f.db.getTotpSecret(f.userId), keys = await f.db.listWebauthnCredentials(f.userId);
    const beginLogin = await f.post('/auth/login/passkey/begin', { username: 'admin', password });
    const loginFlow = beginLogin.json() as { ticket: string; options: { challenge: string } };
    const flowCookie = `og_login_flow=${beginLogin.cookies.find((cookie) => cookie.name === 'og_login_flow')!.value}`;
    const beginStep = await f.post('/auth/step-up/passkey/begin'), enroll = await f.post('/auth/totp/enroll');
    const changed = await f.changePassword(); expect(changed.statusCode).toBe(200); expect(changed.json().requiresLogin).toBe(true);
    expect((await f.post('/auth/login/passkey/finish', { ticket: loginFlow.ticket, response: authenticator(loginFlow.options.challenge) }, flowCookie)).statusCode).toBe(401);
    expect((await f.post('/auth/step-up/passkey/finish', { response: authenticator(beginStep.json().challenge as string) })).statusCode).toBe(401);
    expect((await f.post('/auth/totp/confirm', { code: code(enroll.json().secretBase32 as string) })).statusCode).toBe(401);
    expect(await f.db.getTotpSecret(f.userId)).toEqual(stored); expect(await f.db.listWebauthnCredentials(f.userId)).toEqual(keys);
    expect((await f.post('/auth/login/passkey/begin', { username: 'admin', password })).statusCode).toBe(401);
    expect((await f.post('/auth/login/passkey/begin', { username: 'admin', password: newPassword })).statusCode).toBe(200);
  });

  it('allows only one concurrent account change and rejects an old-name login delayed behind a rename', async () => {
    const f = await fixture();
    const other = sessionCookie(await f.post('/auth/login', { username: 'admin', password }));
    const changed = await Promise.all([f.rename('parallel-one'), f.rename('parallel-two', password, other)]);
    expect(changed.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    expect(await f.db.rawQuery("SELECT * FROM audit_log WHERE action='auth.account.username.change'")).toHaveLength(1);

    const g = await fixture();
    const lookup = g.db.getAdminByUsername.bind(g.db);
    let release!: () => void, started!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; }), lookupStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(g.db, 'getAdminByUsername').mockImplementationOnce(async (username) => { const user = await lookup(username); started(); await released; return user; });
    const login = g.post('/auth/login', { username: 'admin', password }).then((response) => response);
    await lookupStarted;
    try { expect((await g.rename('renamed-admin')).statusCode).toBe(200); } finally { release(); }
    expect((await login).statusCode).toBe(401);
    expect(await g.db.rawQuery('SELECT * FROM login_sessions')).toEqual([]);
  });

  it('rolls back the account and session revocation if audit fails or security state races the transaction', async () => {
    const f = await fixture(), before = await f.db.getAdminById(f.userId);
    await f.db.rawRun("CREATE TRIGGER reject_account_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.password.change' BEGIN SELECT RAISE(ABORT,'synthetic account audit failure'); END");
    expect((await f.changePassword()).statusCode).toBe(500);
    expect(await f.db.getAdminById(f.userId)).toEqual(before); expect(await f.auth.getSession(f.cookie.slice('og_session='.length))).not.toBeNull();
    await f.db.rawRun('DROP TRIGGER reject_account_audit');
    const original = f.db.rawTransaction.bind(f.db);
    vi.spyOn(f.db, 'rawTransaction').mockImplementationOnce(async (statements) => {
      await f.db.rawRun('UPDATE admin_users SET username=? WHERE id=?', ['external-rename', f.userId]);
      return original(statements);
    });
    const stale = await f.rename('stale-rename'); expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe('ACCOUNT_CHANGED');
    expect((await f.db.getAdminById(f.userId))?.username).toBe('external-rename');
    expect(await f.db.rawQuery("SELECT * FROM audit_log WHERE action IN ('auth.password.change','auth.account.username.change')")).toEqual([]);
  });

  it('persists changes across a real HTTP server/SQLite close and restart without leaking passwords or hashes', async () => {
    const f = await fixture(), before = (await f.db.getAdminById(f.userId))!;
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/auth/account/password`, { method: 'POST', headers: { cookie: f.cookie, 'content-type': 'application/json', origin }, body: JSON.stringify({ current_password: password, new_password: newPassword }) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, changed: true, requiresLogin: true });
    const after = (await f.db.getAdminById(f.userId))!;
    expect(after.password_hash).not.toBe(before.password_hash);
    expect(after.password_hash).toMatch(/^\$argon2/);
    const audit = await f.db.rawQuery("SELECT action,target,detail FROM audit_log WHERE action='auth.password.change'");
    expect(audit).toEqual([{ action: 'auth.password.change', target: f.userId, detail: JSON.stringify({ sessions_revoked: true }) }]);
    const observable = JSON.stringify({ audit, logs: f.logs() });
    for (const secret of [password, newPassword, before.password_hash, after.password_hash]) expect(observable).not.toContain(secret);
    await f.close();
    const restarted = await fixture({ path: f.path, bootstrap: false });
    const restartedAddress = await restarted.app.listen({ host: '127.0.0.1', port: 0 });
    const requestLogin = (value: string) => fetch(`${restartedAddress}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: value }) });
    expect((await requestLogin(password)).status).toBe(401);
    expect((await requestLogin(newPassword)).status).toBe(200);
    expect((await restarted.app.inject({ url: '/auth/account', headers: { cookie: f.cookie } })).statusCode).toBe(401);
    expect((await restarted.db.getAdminById(f.userId))?.password_hash).toBe(after.password_hash);
  });
});
