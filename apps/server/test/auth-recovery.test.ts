import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbClient } from '@owngate/db';
import { Vault } from '@owngate/vault';
import { AuthService } from '../src/auth/service.js';
import { createAdminGate } from '../src/auth/guard.js';
import { registerAuthRoutes } from '../src/routes/auth.js';
import { totpAt } from '../src/auth/totp.js';

// Real Fastify/cookies/SQLite/encrypted seeds/password hashing/challenges and
// counters. Cryptographic authenticator assertions are mocked at the SDK seam;
// actual device/hardware support remains an HTTPS deployment acceptance check.
vi.mock('@simplewebauthn/server', async (original) => {
  const sdk = await original<typeof import('@simplewebauthn/server')>();
  const valid = (options: { response: { response: { clientDataJSON: string } }; expectedChallenge: unknown; expectedOrigin: unknown; expectedRPID: string; requireUserVerification: boolean }, type: string) => {
    const data = JSON.parse(Buffer.from(options.response.response.clientDataJSON, 'base64url').toString()) as { challenge: string; type: string; origin: string };
    return data.challenge === options.expectedChallenge && data.type === type && data.origin === options.expectedOrigin
      && options.expectedRPID === 'localhost' && options.requireUserVerification === true;
  };
  return { ...sdk,
    verifyRegistrationResponse: vi.fn(async (options) => ({ verified: valid(options, 'webauthn.create'),
      registrationInfo: { credential: { id: options.response.id, publicKey: Buffer.from('synthetic-public-key'), counter: 0 }, credentialDeviceType: 'singleDevice' } })),
    verifyAuthenticationResponse: vi.fn(async (options) => ({ verified: valid(options, 'webauthn.get'), authenticationInfo: { newCounter: options.credential.counter + 1 } })),
  };
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const close of cleanup.splice(0).reverse()) await close(); });
const password = 'private-password-for-recovery';
const code = (secret: string) => totpAt(secret, Math.floor(Date.now() / 1000));
const registration = (challenge: string, id = 'synthetic-key') => ({ id, response: { transports: ['internal'], clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', origin: 'http://localhost:3000', challenge })).toString('base64url') } });
const assertion = (challenge: string, id = 'synthetic-key') => ({ id, response: { clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.get', origin: 'http://localhost:3000', challenge })).toString('base64url') } });

async function fixture() {
  const app = Fastify(), db = new DbClient(':memory:'), auth = new AuthService({ db, vault: new Vault('55'.repeat(32)), rpID: 'localhost', rpName: 'Fixture', origin: 'http://localhost:3000' });
  await registerAuthRoutes(app, { auth, db });
  app.addHook('onRequest', createAdminGate(auth));
  app.get('/admin/private', async () => ({ private: 'fixture-admin-data' }));
  app.post('/admin/sensitive', { config: { stepUp: true } }, async () => ({ ok: true }));
  cleanup.push(async () => { await app.close(); await db.close(); });
  const bootstrap = await app.inject({ method: 'POST', url: '/auth/bootstrap', payload: { username: 'admin', password } });
  expect(bootstrap.statusCode).toBe(201);
  const cookie = `og_session=${bootstrap.cookies.find((cookie) => cookie.name === 'og_session')!.value}`;
  const userId = (bootstrap.json() as { id: string }).id;
  const post = (url: string, payload?: unknown, useCookie = cookie) => app.inject({ method: 'POST', url,
    headers: { cookie: useCookie, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
  const setup = async (useCookie = cookie) => {
    const result = await post('/auth/mfa/setup', { password }, useCookie);
    expect(result.statusCode).toBe(200);
  };
  const enroll = async (useCookie = cookie) => {
    const result = await post('/auth/totp/enroll', undefined, useCookie);
    expect(result.statusCode).toBe(200);
    return (result.json() as { secretBase32: string }).secretBase32;
  };
  const enableTotp = async () => {
    await setup(); const secret = await enroll();
    expect((await post('/auth/totp/confirm', { code: code(secret) })).statusCode).toBe(200);
    return secret;
  };
  const addPasskey = async (useCookie = cookie, id = 'synthetic-key') => {
    const begin = await post('/auth/passkeys/register/begin', undefined, useCookie);
    expect(begin.statusCode).toBe(200);
    const result = await post('/auth/passkeys/register/finish', { response: registration(begin.json().challenge as string, id) }, useCookie);
    expect(result.statusCode).toBe(201);
  };
  const stepPasskey = async (useCookie = cookie) => {
    const begin = await post('/auth/step-up/passkey/begin', undefined, useCookie);
    expect(begin.statusCode).toBe(200);
    const result = await post('/auth/step-up/passkey/finish', { response: assertion(begin.json().challenge as string) }, useCookie);
    expect(result.statusCode).toBe(200);
  };
  return { app, db, auth, cookie, userId, post, setup, enroll, enableTotp, addPasskey, stepPasskey };
}

describe('MFA management and recovery through real routes', () => {
  it('ignores the development auth bypass in production', async () => {
    const { app } = await fixture();
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('DEV_SKIP_AUTH', '1');
    const response = await app.inject('/admin/private');
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('fixture-admin-data');
  });

  it('a stolen ordinary session cannot enroll MFA and first-setup password proof does not authorize sensitive routes', async () => {
    const f = await fixture();
    for (const url of ['/auth/totp/enroll', '/auth/passkeys/register/begin']) {
      const result = await f.post(url);
      expect(result.statusCode).toBe(403);
      expect(result.json().code).toBe('MFA_SETUP_REQUIRED');
    }
    expect((await f.post('/auth/mfa/setup', { password: 'wrong-password' })).statusCode).toBe(401);
    await f.setup();
    expect((await f.post('/admin/sensitive')).statusCode).toBe(403);
    const secret = await f.enroll();
    expect(await f.db.getTotpSecret(f.userId)).toBeUndefined();
    expect((await f.post('/auth/totp/confirm', { code: code(secret) })).statusCode).toBe(200);
    expect((await f.post('/admin/sensitive')).statusCode).toBe(403);
    expect((await f.post('/auth/step-up/totp', { code: code(secret), password: 'wrong-password' })).statusCode).toBe(401);
    expect((await f.post('/auth/step-up/totp', { code: code(secret), password })).statusCode).toBe(200);
    expect((await f.post('/admin/sensitive')).statusCode).toBe(200);
  });

  it('binds first setup proofs and passkey registration challenges to the initiating session', async () => {
    const f = await fixture();
    const second = await f.post('/auth/login', { username: 'admin', password });
    const otherCookie = `og_session=${second.cookies[0]!.value}`;
    await f.setup();
    expect((await f.post('/auth/totp/enroll', undefined, otherCookie)).statusCode).toBe(403);
    const begin = await f.post('/auth/passkeys/register/begin');
    await f.setup(otherCookie);
    const cross = await f.post('/auth/passkeys/register/finish', { response: registration(begin.json().challenge as string) }, otherCookie);
    expect(cross.statusCode).toBe(400);
    expect(await f.db.listWebauthnCredentials(f.userId)).toEqual([]);
    expect((await f.post('/auth/passkeys/register/finish', { response: registration(begin.json().challenge as string) })).statusCode).toBe(201);
    expect((await f.post('/auth/totp/enroll', undefined, otherCookie)).statusCode).toBe(403);
  });

  it('requires an existing Passkey after registration; TOTP cannot create another or delete the stronger factor', async () => {
    const f = await fixture(), secret = await f.enableTotp();
    expect((await f.post('/auth/step-up/totp', { code: code(secret), password })).statusCode).toBe(200);
    await f.addPasskey();
    expect((await f.post('/admin/sensitive')).statusCode).toBe(403);
    expect((await f.post('/auth/step-up/totp', { code: code(secret), password })).json().code).toBe('PASSKEY_REQUIRED');
    expect((await f.post('/auth/passkeys/register/begin')).statusCode).toBe(403);
    const key = (await f.db.listWebauthnCredentials(f.userId))[0]!;
    const remove = await f.app.inject({ method: 'DELETE', url: `/auth/passkeys/${key.id}`, headers: { cookie: f.cookie } });
    expect(remove.statusCode).toBe(403);
    await f.stepPasskey();
    expect((await f.post('/admin/sensitive')).statusCode).toBe(200);
    await f.addPasskey(f.cookie, 'second-synthetic-key');
    expect((await f.post('/admin/sensitive')).statusCode).toBe(403);
  });

  it('keeps the active TOTP during rebind, rejects other-session confirmation and swaps only after confirming the new code', async () => {
    const f = await fixture(), oldSecret = await f.enableTotp();
    expect((await f.post('/auth/step-up/totp', { code: code(oldSecret), password })).statusCode).toBe(200);
    const stored = await f.db.getTotpSecret(f.userId), newSecret = await f.enroll();
    expect(await f.db.getTotpSecret(f.userId)).toEqual(stored);
    expect(await f.auth.verifyTotp(f.userId, code(oldSecret))).toBe(true);
    const login = await f.post('/auth/login', { username: 'admin', password, totp: code(oldSecret) });
    const other = `og_session=${login.cookies[0]!.value}`;
    expect((await f.post('/auth/step-up/totp', { code: code(oldSecret), password }, other)).statusCode).toBe(200);
    expect((await f.post('/auth/totp/confirm', { code: code(newSecret) }, other)).statusCode).toBe(409);
    expect((await f.post('/auth/totp/confirm', { code: 'invalid' })).statusCode).toBe(401);
    expect(await f.db.getTotpSecret(f.userId)).toEqual(stored);
    expect((await f.post('/auth/totp/confirm', { code: code(newSecret) })).statusCode).toBe(200);
    expect(await f.db.getTotpSecret(f.userId)).not.toEqual(stored);
    expect(await f.auth.verifyTotp(f.userId, code(newSecret))).toBe(true);
    expect((await f.post('/admin/sensitive')).statusCode).toBe(403);
  });

  it('expires setup and enrollment without modifying the active seed', async () => {
    const f = await fixture(), oldSecret = await f.enableTotp();
    expect((await f.post('/auth/step-up/totp', { code: code(oldSecret), password })).statusCode).toBe(200);
    const stored = await f.db.getTotpSecret(f.userId), secret = await f.enroll();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await f.post('/auth/totp/confirm', { code: code(secret) })).json().code).toBe('TOTP_ENROLLMENT_EXPIRED');
    expect(await f.db.getTotpSecret(f.userId)).toEqual(stored);
  });

  it('logs in with password + Passkey when TOTP is lost, only creates a session after verification and rejects replay', async () => {
    const f = await fixture(), oldSecret = await f.enableTotp();
    await f.post('/auth/step-up/totp', { code: code(oldSecret), password }); await f.addPasskey();
    expect((await f.post('/auth/login', { username: 'admin', password })).json().code).toBe('TOTP_REQUIRED');
    const begin = await f.post('/auth/login/passkey/begin', { username: 'admin', password });
    expect(begin.statusCode).toBe(200);
    expect(begin.headers['cache-control']).toBe('no-store');
    expect(begin.cookies.map((cookie) => cookie.name)).toEqual(['og_login_flow']);
    const before = await f.db.rawQuery('SELECT id FROM login_sessions');
    const flowCookie = `og_login_flow=${begin.cookies[0]!.value}`;
    const body = begin.json() as { ticket: string; options: { challenge: string } };
    const finish = await f.post('/auth/login/passkey/finish', { ticket: body.ticket, response: assertion(body.options.challenge) }, flowCookie);
    expect(finish.statusCode).toBe(200);
    expect(await f.db.rawQuery('SELECT id FROM login_sessions')).toHaveLength(before.length + 1);
    const recoveryCookie = `og_session=${finish.cookies.find((cookie) => cookie.name === 'og_session')!.value}`;
    const replacement = await f.enroll(recoveryCookie);
    expect(await f.auth.verifyTotp(f.userId, code(oldSecret))).toBe(true);
    expect((await f.post('/auth/totp/confirm', { code: code(replacement) }, recoveryCookie)).statusCode).toBe(200);
    expect((await f.post('/auth/login/passkey/finish', { ticket: body.ticket, response: assertion(body.options.challenge) }, flowCookie)).statusCode).toBe(401);
  });

  it('binds login tickets to a browser, purpose and authentication revision, and consumes failed attempts', async () => {
    const f = await fixture(); await f.setup(); await f.addPasskey();
    const begin = await f.post('/auth/login/passkey/begin', { username: 'admin', password });
    const flow = begin.json() as { ticket: string; options: { challenge: string } };
    const flowCookie = `og_login_flow=${begin.cookies[0]!.value}`;
    expect((await f.post('/auth/login/passkey/finish', { ticket: flow.ticket, response: assertion(flow.options.challenge) }, '')).statusCode).toBe(401);
    expect((await f.post('/auth/login/passkey/finish', { ticket: flow.ticket, response: assertion(flow.options.challenge) }, flowCookie)).statusCode).toBe(401);
    const second = await f.post('/auth/login/passkey/begin', { username: 'admin', password });
    const other = second.json() as { ticket: string; options: { challenge: string } };
    const step = await f.post('/auth/step-up/passkey/begin');
    expect((await f.post('/auth/step-up/passkey/finish', { response: assertion(other.options.challenge) })).statusCode).toBe(401);
    expect((await f.post('/auth/login/passkey/finish', { ticket: other.ticket, response: assertion(step.json().challenge as string) }, `og_login_flow=${second.cookies[0]!.value}`)).statusCode).toBe(401);
    const third = await f.post('/auth/login/passkey/begin', { username: 'admin', password });
    const pending = third.json() as { ticket: string; options: { challenge: string } };
    await f.db.rawRun("UPDATE admin_users SET password_hash='changed' WHERE id=?", [f.userId]);
    expect((await f.post('/auth/login/passkey/finish', { ticket: pending.ticket, response: assertion(pending.options.challenge) }, `og_login_flow=${third.cookies[0]!.value}`)).statusCode).toBe(401);
  });

  it('step-up challenges cannot be completed from another session, and logged-out proofs cannot mutate credentials', async () => {
    const f = await fixture(); await f.setup(); await f.addPasskey();
    const login = await f.post('/auth/login', { username: 'admin', password });
    const other = `og_session=${login.cookies[0]!.value}`;
    const begin = await f.post('/auth/step-up/passkey/begin');
    expect((await f.post('/auth/step-up/passkey/finish', { response: assertion(begin.json().challenge as string) }, other)).statusCode).toBe(401);
    expect((await f.post('/auth/step-up/passkey/finish', { response: assertion(begin.json().challenge as string) })).statusCode).toBe(200);
    expect((await f.post('/auth/logout')).statusCode).toBe(200);
    expect((await f.post('/auth/totp/enroll')).statusCode).toBe(401);
  });

  it('does not keep a changed credential when the audit transaction fails', async () => {
    const f = await fixture(), oldSecret = await f.enableTotp();
    await f.post('/auth/step-up/totp', { password, code: code(oldSecret) });
    const original = await f.db.getTotpSecret(f.userId), replacement = await f.enroll();
    await f.db.rawRun("CREATE TRIGGER reject_auth_audit BEFORE INSERT ON audit_log WHEN NEW.action='auth.totp.confirm.success' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
    expect((await f.post('/auth/totp/confirm', { code: code(replacement) })).statusCode).toBe(500);
    expect(await f.db.getTotpSecret(f.userId)).toEqual(original);
    expect((await f.post('/auth/login', { username: 'admin', password, totp: code(oldSecret) })).statusCode).toBe(200);
  });

  it('bounds temporary enrollment attempts and expires single-use login tickets', async () => {
    const f = await fixture(); await f.setup();
    const secret = await f.enroll();
    for (let i = 0; i < 5; i++) expect((await f.post('/auth/totp/confirm', { code: 'invalid' })).statusCode).toBe(401);
    expect((await f.post('/auth/totp/confirm', { code: code(secret) })).json().code).toBe('TOTP_ENROLLMENT_EXPIRED');
    await f.addPasskey();
    const begin = await f.post('/auth/login/passkey/begin', { username: 'admin', password });
    const pending = begin.json() as { ticket: string; options: { challenge: string } };
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 6 * 60_000);
    expect((await f.post('/auth/login/passkey/finish', { ticket: pending.ticket, response: assertion(pending.options.challenge) }, `og_login_flow=${begin.cookies[0]!.value}`)).statusCode).toBe(401);
    expect(await f.db.rawQuery('SELECT id FROM login_sessions')).toHaveLength(1);
  });
});
