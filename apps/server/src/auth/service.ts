// Session, MFA and recovery flows. Challenges are single-use and scoped to a
// session/purpose; credential changes revoke earlier proofs by revision.
import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON, WebAuthnCredential } from '@simplewebauthn/server';
import type { DbClient, RawStatement } from '@owngate/db';
import { vaultContext, type Vault } from '@owngate/vault';
import { buildOtpauthUrl, generateTotpSecret, verifyTotpCode } from './totp.js';

export interface AuthDeps { db: DbClient; vault: Vault; rpID: string; rpName: string; origin: string }
export class AuthFlowError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 403) { super(message); this.name = 'AuthFlowError'; }
}
const SESSION_TTL_MS = 12 * 60 * 60_000;
const STEP_UP_TTL_MS = 15 * 60_000;
const FLOW_TTL_MS = 5 * 60_000;
const ENROLL_TTL_MS = 10 * 60_000;
const MAX_PENDING = 128;
type MfaMethod = 'passkey' | 'totp';
interface Proof { userId: string; revision: string; expiresAt: number }
interface Challenge extends Proof { challenge: string }
interface LoginChallenge extends Challenge { bindingHash: string }
interface PendingTotp extends Proof { secretBase32: string; attempts: number }
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
const expired = (iso: string) => !Number.isFinite(Date.parse(iso)) || Date.parse(iso) <= Date.now();
function transports(value: unknown): AuthenticatorTransportFuture[] {
  return Array.isArray(value) ? value.filter((v): v is AuthenticatorTransportFuture => typeof v === 'string') : [];
}

export class AuthService {
  private readonly db: DbClient;
  private readonly vault: Vault;
  private readonly rpID: string;
  private readonly rpName: string;
  readonly origin: string;
  private readonly stepUps = new Map<string, Proof & { method: MfaMethod }>();
  private readonly setupProofs = new Map<string, Proof>();
  private readonly registrationChallenges = new Map<string, Challenge>();
  private readonly authenticationChallenges = new Map<string, Challenge>();
  private readonly loginChallenges = new Map<string, LoginChallenge>();
  private readonly pendingTotp = new Map<string, PendingTotp>();
  private readonly securityLocks = new Map<string, Promise<void>>();

  constructor(deps: AuthDeps) {
    this.db = deps.db; this.vault = deps.vault; this.rpID = deps.rpID; this.rpName = deps.rpName; this.origin = deps.origin;
    void this.db.deleteExpiredLoginSessions(new Date().toISOString()).catch(() => {});
  }
  private audit(action: string, target: string, detail: Record<string, unknown> = {}) { return this.db.appendAuditLog({ action, target, detail }); }
  private async auditMutation(action: string, target: string, detail: Record<string, unknown>, writes: RawStatement[]): Promise<void> {
    // Append-only hash chains can race with ordinary query audit entries.
    // A CAS on the previous link retries the entire rolled-back mutation.
    for (let attempt = 0; attempt < 5; attempt++) {
      const [last] = await this.db.rawQuery('SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1') as Array<{ entry_hash: string }>;
      const previous = last?.entry_hash ?? '0', at = new Date().toISOString();
      const entry = { action, client_id: null, target, detail, at };
      const hash = fingerprint(`${previous}|${JSON.stringify(entry)}`);
      try {
        await this.db.rawTransaction([{ sql: `INSERT INTO audit_log(action,client_id,target,detail,prev_hash,entry_hash,at)
          SELECT ?,NULL,?,?,?,?,? WHERE COALESCE((SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1),'0')=?`,
          params: [action, target, JSON.stringify(detail), previous, hash, at, previous], expectChanges: 1 }, ...writes]);
        return;
      } catch (error) {
        const [current] = await this.db.rawQuery('SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1') as Array<{ entry_hash: string }>;
        if ((current?.entry_hash ?? '0') === previous || attempt === 4) throw error;
      }
    }
  }
  private async locked<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.securityLocks.get(userId) ?? Promise.resolve();
    const work = previous.then(operation), tail = work.then(() => {}, () => {});
    this.securityLocks.set(userId, tail);
    try { return await work; } finally { if (this.securityLocks.get(userId) === tail) this.securityLocks.delete(userId); }
  }
  private cleanup(): void {
    for (const map of [this.stepUps, this.setupProofs, this.registrationChallenges, this.authenticationChallenges, this.loginChallenges, this.pendingTotp]) {
      for (const [id, pending] of map) if (pending.expiresAt <= Date.now()) map.delete(id);
    }
  }
  private reserve<T extends Proof>(map: Map<string, T>, id: string, value: T): void {
    this.cleanup();
    const count = this.setupProofs.size + this.registrationChallenges.size + this.authenticationChallenges.size + this.loginChallenges.size + this.pendingTotp.size;
    if (!map.has(id) && count >= MAX_PENDING) throw new AuthFlowError('AUTH_FLOW_LIMIT', '待完成的验证过多，请稍后再试。', 429);
    map.set(id, value);
  }
  private take<T extends Proof>(map: Map<string, T>, id: string): T | undefined {
    const pending = map.get(id); map.delete(id);
    return pending && pending.expiresAt > Date.now() ? pending : undefined;
  }
  private clearSessionProofs(id: string) {
    this.stepUps.delete(id); this.setupProofs.delete(id); this.registrationChallenges.delete(id); this.authenticationChallenges.delete(id); this.pendingTotp.delete(id);
  }
  private clearUserProofs(userId: string): void {
    for (const map of [this.stepUps, this.setupProofs, this.registrationChallenges, this.authenticationChallenges, this.loginChallenges, this.pendingTotp]) {
      for (const [id, proof] of map) if (proof.userId === userId) map.delete(id);
    }
  }
  private async securityState(userId: string) {
    const [user, totp, passkeys] = await Promise.all([this.db.getAdminById(userId), this.db.getTotpSecret(userId), this.db.listWebauthnCredentials(userId)]);
    if (!user) throw new AuthFlowError('NO_SESSION', '管理员不存在，请重新登录。', 401);
    const revision = fingerprint(JSON.stringify([user.username, user.password_hash, user.totp_enabled, totp?.ciphertext ?? null,
      passkeys.map((key) => [key.id, key.credential_id, key.public_key]).sort(([a], [b]) => String(a).localeCompare(String(b)))]));
    return { user, passkeys, revision, totpCiphertext: totp?.ciphertext ?? null };
  }
  private async boundSession(userId: string, sessionId: string): Promise<void> {
    if ((await this.getSession(sessionId))?.userId !== userId) throw new AuthFlowError('SESSION_EXPIRED', '登录已过期，请重新登录。', 401);
  }
  private async verifyUserPassword(userId: string, password: string): Promise<boolean> {
    const user = await this.db.getAdminById(userId);
    return user ? argon2.verify(user.password_hash, password).catch(() => false) : false;
  }
  private sessionFence(userId: string, sessionId: string, authorizedUntil?: number) {
    const proof = this.setupProofs.get(sessionId) ?? this.stepUps.get(sessionId);
    return { sql: `UPDATE login_sessions SET expires_at=expires_at WHERE id=? AND user_id=?
        AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      params: [sessionId, userId, new Date(authorizedUntil ?? proof?.expiresAt ?? 0).toISOString()], expectChanges: 1 };
  }
  private accountStateFence(state: Awaited<ReturnType<AuthService['securityState']>>): RawStatement {
    // A second worker/CLI may change security state while Argon2 is running.
    // Compare the complete revision inside the audit/mutation transaction.
    return {
      sql: `UPDATE admin_users SET username=username WHERE id=? AND username=? AND password_hash=? AND totp_enabled=?
        AND (SELECT ciphertext FROM totp_secrets WHERE user_id=?) IS ?
        AND (SELECT COUNT(*) FROM webauthn_credentials WHERE user_id=?)=?
        ${state.passkeys.map(() => 'AND EXISTS (SELECT 1 FROM webauthn_credentials WHERE id=? AND user_id=? AND credential_id=? AND public_key=?)').join('\n')}`,
      params: [state.user.id, state.user.username, state.user.password_hash, state.user.totp_enabled ? 1 : 0,
        state.user.id, state.totpCiphertext, state.user.id, state.passkeys.length,
        ...state.passkeys.flatMap((key) => [key.id, state.user.id, key.credential_id, key.public_key])],
      expectChanges: 1,
    };
  }
  async hasAnyUser(): Promise<boolean> { return (await this.db.countAdminUsers()) > 0; }
  async bootstrap(username: string, password: string): Promise<{ id: string }> {
    const id = randomBytes(16).toString('hex'), hash = await argon2.hash(password);
    try { await this.auditMutation('auth.bootstrap', username, { user_id: id }, [{ sql: `INSERT INTO admin_users(id,username,password_hash) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM admin_users)`, params: [id, username, hash], expectChanges: 1 }]); }
    catch { throw new AuthFlowError('ALREADY_BOOTSTRAPPED', '管理员已存在，请登录。', 409); }
    return { id };
  }
  async verifyPassword(username: string, password: string): Promise<{ id: string } | null> {
    const user = await this.db.getAdminByUsername(username);
    if (!user) { await argon2.hash(password).catch(() => {}); return null; }
    return await argon2.verify(user.password_hash, password).catch(() => false) ? { id: user.id } : null;
  }
  async loginWithPassword(username: string, password: string, totp?: string) {
    const user = await this.db.getAdminByUsername(username);
    if (!user) { await argon2.hash(password).catch(() => {}); throw new AuthFlowError('INVALID_CREDENTIALS', '用户名或密码不正确。', 401); }
    return this.locked(user.id, async () => {
      if ((await this.db.getAdminById(user.id))?.username !== username || !await this.verifyUserPassword(user.id, password)) throw new AuthFlowError('INVALID_CREDENTIALS', '用户名或密码不正确。', 401);
      if (await this.isTotpEnabled(user.id)) {
        if (!totp) throw new AuthFlowError('TOTP_REQUIRED', '此账号需要 TOTP 验证码或已注册的 Passkey。', 401);
        if (!await this.verifyTotp(user.id, totp)) throw new AuthFlowError('TOTP_INVALID', '验证码不正确或已过期。', 401);
      }
      return this.createSession(user.id);
    });
  }
  async resetPassword(userId: string, password: string): Promise<void> {
    await this.locked(userId, async () => {
      const hash = await argon2.hash(password);
      await this.auditMutation('auth.password.reset', userId, { via: 'cli' }, [{ sql: 'UPDATE admin_users SET password_hash=? WHERE id=?', params: [hash, userId], expectChanges: 1 }, { sql: 'DELETE FROM login_sessions WHERE user_id=?', params: [userId] }]);
    });
  }
  async setPassword(username: string, password: string): Promise<boolean> {
    const user = await this.db.getAdminByUsername(username); if (!user) return false;
    await this.resetPassword(user.id, password); return true;
  }
  async getAccount(userId: string, sessionId: string): Promise<{ id: string; username: string; createdAt: string }> {
    await this.boundSession(userId, sessionId);
    const { user } = await this.securityState(userId);
    return { id: user.id, username: user.username, createdAt: user.created_at };
  }
  async updateAccount(userId: string, sessionId: string, username: string, currentPassword: string) {
    const normalized = username.trim();
    if (!normalized || [...normalized].length > 128 || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
      throw new AuthFlowError('INVALID_USERNAME', '用户名需为 1–128 个字符，且不能包含控制字符。', 400);
    }
    return this.changeAccount(userId, sessionId, currentPassword, { username: normalized });
  }
  async changeAccountPassword(userId: string, sessionId: string, currentPassword: string, newPassword: string) {
    if ([...newPassword].length < 8 || [...newPassword].length > 1024) throw new AuthFlowError('INVALID_PASSWORD', '密码需为 8–1024 个字符。', 400);
    return this.changeAccount(userId, sessionId, currentPassword, { password: newPassword });
  }
  private async changeAccount(userId: string, sessionId: string, currentPassword: string, change: { username: string } | { password: string }) {
    return this.locked(userId, async () => {
      await this.boundSession(userId, sessionId);
      const state = await this.securityState(userId);
      if (!await argon2.verify(state.user.password_hash, currentPassword).catch(() => false)) throw new AuthFlowError('INVALID_CURRENT_PASSWORD', '当前密码不正确。');
      // Password-only authorization is scoped to this call. It cannot become
      // a setup/step-up proof for issuing tokens or changing platform access.
      const hasMfa = state.passkeys.length > 0 || state.user.totp_enabled;
      if (hasMfa) await this.requireCredentialManagement(userId, sessionId);
      await this.boundSession(userId, sessionId);
      if ((await this.securityState(userId)).revision !== state.revision) throw new AuthFlowError('ACCOUNT_CHANGED', '账户验证信息已变化，请重新验证后再试。', 409);
      const unchanged = 'username' in change ? change.username === state.user.username : change.password === currentPassword;
      if (unchanged) return { ok: true as const, changed: false, requiresLogin: false };

      const proof = this.stepUps.get(sessionId);
      if (hasMfa && (!proof || proof.expiresAt <= Date.now())) throw new AuthFlowError('STEP_UP_REQUIRED', '请重新验证身份。');
      const authorizedUntil = hasMfa ? proof!.expiresAt : Date.now() + FLOW_TTL_MS;
      const usernameChange = 'username' in change;
      const value = usernameChange ? change.username : await argon2.hash(change.password);
      try {
        await this.auditMutation(usernameChange ? 'auth.account.username.change' : 'auth.password.change', userId, { sessions_revoked: true }, [
          this.accountStateFence(state), this.sessionFence(userId, sessionId, authorizedUntil),
          { sql: `UPDATE admin_users SET ${usernameChange ? 'username' : 'password_hash'}=? WHERE id=?`, params: [value, userId], expectChanges: 1 },
          { sql: 'DELETE FROM login_sessions WHERE user_id=?', params: [userId] },
        ]);
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed: admin_users.username')) throw new AuthFlowError('USERNAME_TAKEN', '此用户名已被使用。', 409);
        if (error instanceof Error && error.message.includes('Atomic statement changed an unexpected number of rows')) throw new AuthFlowError('ACCOUNT_CHANGED', '账户或登录状态已变化，请重新登录后再试。', 409);
        throw error;
      }
      this.clearUserProofs(userId);
      return { ok: true as const, changed: true, requiresLogin: true };
    });
  }
  async createSession(userId: string, ttlMs = SESSION_TTL_MS): Promise<{ sessionId: string; expiresAt: string }> {
    const sessionId = randomBytes(32).toString('hex'), expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await this.auditMutation('auth.session.create', userId, { expires_at: expiresAt }, [{ sql: 'INSERT INTO login_sessions(id,user_id,expires_at) VALUES(?,?,?)', params: [sessionId, userId, expiresAt], expectChanges: 1 }]);
    return { sessionId, expiresAt };
  }
  async getSession(sessionId: string): Promise<{ userId: string } | null> {
    const row = await this.db.getLoginSession(sessionId);
    if (!row || expired(row.expires_at)) { if (row) await this.db.deleteLoginSession(sessionId); this.clearSessionProofs(sessionId); return null; }
    return { userId: row.user_id };
  }
  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId); await this.db.deleteLoginSession(sessionId); this.clearSessionProofs(sessionId);
    if (session) await this.audit('auth.session.delete', session.userId);
  }
  async proveInitialSetup(userId: string, sessionId: string, password: string): Promise<boolean> {
    return this.locked(userId, async () => {
      await this.boundSession(userId, sessionId); const state = await this.securityState(userId);
      if (state.passkeys.length || state.user.totp_enabled) throw new AuthFlowError('STEP_UP_REQUIRED', '请使用当前已配置的验证方式。');
      if (!await this.verifyUserPassword(userId, password)) return false;
      await this.boundSession(userId, sessionId);
      this.stepUps.delete(sessionId);
      this.reserve(this.setupProofs, sessionId, { userId, revision: state.revision, expiresAt: Date.now() + FLOW_TTL_MS });
      try { await this.audit('auth.mfa.setup_verified', userId); }
      catch (error) { this.setupProofs.delete(sessionId); throw error; }
      return true;
    });
  }
  async requireCredentialManagement(userId: string, sessionId: string): Promise<void> {
    await this.boundSession(userId, sessionId); const state = await this.securityState(userId);
    if (state.passkeys.length || state.user.totp_enabled) {
      if (await this.stepUpMethod(sessionId) !== (state.passkeys.length ? 'passkey' : 'totp')) throw new AuthFlowError('STEP_UP_REQUIRED', state.passkeys.length ? '请重新使用 Passkey 验证身份。' : '请重新输入密码及 TOTP 验证码。');
    } else {
      const proof = this.setupProofs.get(sessionId);
      if (!proof || proof.userId !== userId || proof.revision !== state.revision || proof.expiresAt <= Date.now()) throw new AuthFlowError('MFA_SETUP_REQUIRED', '首次配置验证方式前，请再次输入密码。');
    }
  }
  async markStepUp(sessionId: string, method: MfaMethod = 'totp'): Promise<void> {
    const session = await this.getSession(sessionId); if (!session) throw new AuthFlowError('SESSION_EXPIRED', '登录已过期。', 401);
    const state = await this.securityState(session.userId); this.cleanup();
    await this.audit('auth.stepup', session.userId, { method });
    await this.boundSession(session.userId, sessionId);
    this.setupProofs.delete(sessionId);
    this.stepUps.set(sessionId, { userId: session.userId, revision: state.revision, expiresAt: Date.now() + STEP_UP_TTL_MS, method });
  }
  async hasStepUp(sessionId: string): Promise<boolean> { return await this.stepUpMethod(sessionId) !== null; }
  async stepUpMethod(sessionId: string): Promise<MfaMethod | null> {
    const proof = this.stepUps.get(sessionId);
    if (!proof || proof.expiresAt <= Date.now()) { this.stepUps.delete(sessionId); return null; }
    const session = await this.getSession(sessionId); if (!session || session.userId !== proof.userId) return null;
    const state = await this.securityState(session.userId), required = state.passkeys.length ? 'passkey' : state.user.totp_enabled ? 'totp' : null;
    if (state.revision !== proof.revision || proof.method !== required) { this.stepUps.delete(sessionId); return null; }
    return proof.method;
  }
  async stepUpWithTotp(userId: string, sessionId: string, password: string, code: string): Promise<boolean> {
    return this.locked(userId, async () => {
      await this.boundSession(userId, sessionId); const state = await this.securityState(userId);
      if (state.passkeys.length) throw new AuthFlowError('PASSKEY_REQUIRED', '此账号已注册 Passkey，请使用 Passkey 验证。');
      if (!state.user.totp_enabled || !await this.verifyUserPassword(userId, password) || !await this.verifyTotp(userId, code)) return false;
      await this.boundSession(userId, sessionId); await this.markStepUp(sessionId, 'totp'); return true;
    });
  }
  async isTotpEnabled(userId: string): Promise<boolean> { return (await this.db.getAdminById(userId))?.totp_enabled === true; }
  private async readTotpSecret(userId: string): Promise<string | null> {
    const row = await this.db.getTotpSecret(userId); if (!row) return null;
    try { return this.vault.decryptJSON<{ secretBase32: string }>(row, vaultContext.totp(userId)).secretBase32; } catch { return null; }
  }
  async verifyTotp(userId: string, code: string): Promise<boolean> {
    const secret = await this.readTotpSecret(userId), valid = secret !== null && verifyTotpCode(secret, code);
    await this.audit(valid ? 'auth.totp.verify.success' : 'auth.totp.verify.failure', userId); return valid;
  }
  async enrollTotp(userId: string, sessionId: string): Promise<{ secretBase32: string; otpauthUrl: string }> {
    return this.locked(userId, async () => {
      await this.requireCredentialManagement(userId, sessionId); const state = await this.securityState(userId), secretBase32 = generateTotpSecret();
      this.reserve(this.pendingTotp, sessionId, { userId, revision: state.revision, expiresAt: Date.now() + ENROLL_TTL_MS, secretBase32, attempts: 0 });
      await this.audit('auth.totp.enroll', userId);
      await this.requireCredentialManagement(userId, sessionId);
      return { secretBase32, otpauthUrl: buildOtpauthUrl({ issuer: 'OwnGate', accountName: state.user.username, secretBase32 }) };
    });
  }
  async confirmTotp(userId: string, code: string, sessionId: string): Promise<boolean> {
    return this.locked(userId, async () => {
      await this.requireCredentialManagement(userId, sessionId); const pending = this.pendingTotp.get(sessionId), state = await this.securityState(userId);
      if (!pending || pending.userId !== userId || pending.revision !== state.revision || pending.expiresAt <= Date.now()) {
        this.pendingTotp.delete(sessionId); throw new AuthFlowError('TOTP_ENROLLMENT_EXPIRED', '绑定流程已过期或认证配置已改变，请重新开始。', 409);
      }
      if (!verifyTotpCode(pending.secretBase32, code)) {
        if (++pending.attempts >= 5) this.pendingTotp.delete(sessionId);
        await this.audit('auth.totp.confirm.failure', userId); return false;
      }
      const blob = this.vault.encryptJSON({ secretBase32: pending.secretBase32 }, vaultContext.totp(userId));
      await this.auditMutation('auth.totp.confirm.success', userId, {}, [this.sessionFence(userId, sessionId), { sql: 'DELETE FROM totp_secrets WHERE user_id=?', params: [userId] },
        { sql: 'INSERT INTO totp_secrets(user_id,ciphertext,iv,auth_tag) VALUES(?,?,?,?)', params: [userId, blob.ciphertext, blob.iv, blob.auth_tag], expectChanges: 1 },
        { sql: 'UPDATE admin_users SET totp_enabled=1 WHERE id=?', params: [userId], expectChanges: 1 }]);
      this.pendingTotp.delete(sessionId); this.setupProofs.delete(sessionId); return true;
    });
  }
  async disableTotp(userId: string, sessionId: string): Promise<void> {
    await this.locked(userId, async () => {
      await this.requireCredentialManagement(userId, sessionId);
      await this.auditMutation('auth.totp.disable.success', userId, {}, [this.sessionFence(userId, sessionId), { sql: 'UPDATE admin_users SET totp_enabled=0 WHERE id=?', params: [userId], expectChanges: 1 }, { sql: 'DELETE FROM totp_secrets WHERE user_id=?', params: [userId] }]);
      this.pendingTotp.delete(sessionId);
    });
  }
  private async authenticationOptions(userId: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const keys = await this.db.listWebauthnCredentials(userId); if (!keys.length) throw new AuthFlowError('NO_PASSKEY', '还没有注册 Passkey。', 409);
    return generateAuthenticationOptions({ rpID: this.rpID, allowCredentials: keys.map((key) => ({ id: key.credential_id, transports: transports(key.transports) })), userVerification: 'required' });
  }
  async beginPasskeyRegistration(userId: string, username: string, sessionId: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    await this.requireCredentialManagement(userId, sessionId); const state = await this.securityState(userId);
    const options = await generateRegistrationOptions({ rpName: this.rpName, rpID: this.rpID, userName: username, userDisplayName: username,
      userID: new TextEncoder().encode(userId), attestationType: 'none', excludeCredentials: state.passkeys.map((key) => ({ id: key.credential_id, transports: transports(key.transports) })), authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } });
    await this.requireCredentialManagement(userId, sessionId);
    this.reserve(this.registrationChallenges, sessionId, { userId, revision: state.revision, challenge: options.challenge, expiresAt: Date.now() + FLOW_TTL_MS }); return options;
  }
  async finishPasskeyRegistration(userId: string, response: RegistrationResponseJSON, sessionId: string): Promise<{ verified: boolean }> {
    return this.locked(userId, async () => {
      await this.requireCredentialManagement(userId, sessionId); const pending = this.take(this.registrationChallenges, sessionId);
      if (!pending || pending.userId !== userId || pending.revision !== (await this.securityState(userId)).revision) return { verified: false };
      const result = await verifyRegistrationResponse({ response, expectedChallenge: pending.challenge, expectedOrigin: this.origin, expectedRPID: this.rpID, requireUserVerification: true }).catch(() => null);
      await this.requireCredentialManagement(userId, sessionId);
      if (!result?.verified || pending.expiresAt <= Date.now() || pending.revision !== (await this.securityState(userId)).revision) { await this.audit('auth.passkey.register.failure', userId); return { verified: false }; }
      const { credential } = result.registrationInfo;
      await this.auditMutation('auth.passkey.register', userId, {}, [this.sessionFence(userId, sessionId), { sql: 'INSERT INTO webauthn_credentials(id,user_id,credential_id,public_key,counter,transports) VALUES(?,?,?,?,?,?)',
        params: [randomBytes(16).toString('hex'), userId, credential.id, Buffer.from(credential.publicKey).toString('base64'), credential.counter, JSON.stringify(transports(response.response.transports))], expectChanges: 1 }]);
      this.setupProofs.delete(sessionId); return { verified: true };
    });
  }
  async beginPasskeyAuthentication(userId: string, sessionId: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    await this.boundSession(userId, sessionId); const state = await this.securityState(userId), options = await this.authenticationOptions(userId);
    this.reserve(this.authenticationChallenges, sessionId, { userId, revision: state.revision, challenge: options.challenge, expiresAt: Date.now() + FLOW_TTL_MS }); return options;
  }
  private async verifyAssertion(userId: string, response: AuthenticationResponseJSON, pending: Challenge): Promise<boolean> {
    if (pending.expiresAt <= Date.now() || pending.userId !== userId || pending.revision !== (await this.securityState(userId)).revision || typeof response.id !== 'string') return false;
    const row = await this.db.getWebauthnCredentialByCredentialId(response.id); if (!row || row.user_id !== userId) return false;
    const credential: WebAuthnCredential = { id: row.credential_id, publicKey: Buffer.from(row.public_key, 'base64'), counter: row.counter, transports: transports(row.transports) };
    const result = await verifyAuthenticationResponse({ response, expectedChallenge: pending.challenge, expectedOrigin: this.origin, expectedRPID: this.rpID, credential, requireUserVerification: true }).catch(() => null);
    if (!result?.verified || pending.expiresAt <= Date.now() || pending.revision !== (await this.securityState(userId)).revision) { await this.audit('auth.passkey.authenticate.failure', userId); return false; }
    const changed = await this.db.rawRun('UPDATE webauthn_credentials SET counter=? WHERE credential_id=? AND public_key=? AND counter=?', [result.authenticationInfo.newCounter, row.credential_id, row.public_key, row.counter]);
    if (changed.changes !== 1) return false;
    await this.audit('auth.passkey.authenticate.success', userId); return true;
  }
  async finishPasskeyAuthentication(userId: string, response: AuthenticationResponseJSON, sessionId: string): Promise<{ verified: boolean }> {
    return this.locked(userId, async () => {
      await this.boundSession(userId, sessionId); const pending = this.take(this.authenticationChallenges, sessionId);
      if (!pending || !await this.verifyAssertion(userId, response, pending)) return { verified: false };
      await this.boundSession(userId, sessionId); await this.markStepUp(sessionId, 'passkey'); return { verified: true };
    });
  }
  async beginPasskeyLogin(username: string, password: string, browserBinding: string) {
    const user = await this.db.getAdminByUsername(username);
    if (!user) { await argon2.hash(password).catch(() => {}); throw new AuthFlowError('INVALID_CREDENTIALS', '用户名或密码不正确。', 401); }
    return this.locked(user.id, async () => {
      if ((await this.db.getAdminById(user.id))?.username !== username || !await this.verifyUserPassword(user.id, password)) throw new AuthFlowError('INVALID_CREDENTIALS', '用户名或密码不正确。', 401);
      const state = await this.securityState(user.id), options = await this.authenticationOptions(user.id), ticket = randomBytes(32).toString('hex');
      this.reserve(this.loginChallenges, fingerprint(ticket), { userId: user.id, revision: state.revision, challenge: options.challenge, expiresAt: Date.now() + FLOW_TTL_MS, bindingHash: fingerprint(browserBinding) }); return { ticket, options };
    });
  }
  async finishPasskeyLogin(ticket: string, browserBinding: string, response: AuthenticationResponseJSON) {
    const pending = this.take(this.loginChallenges, fingerprint(ticket)); if (!pending || pending.bindingHash !== fingerprint(browserBinding)) return null;
    return this.locked(pending.userId, async () => {
      if (!await this.verifyAssertion(pending.userId, response, pending)) return null;
      const session = await this.createSession(pending.userId); await this.markStepUp(session.sessionId, 'passkey'); return session;
    });
  }
  async listPasskeys(userId: string): Promise<{ id: string; createdAt: string }[]> { return (await this.db.listWebauthnCredentials(userId)).map((key) => ({ id: key.id, createdAt: key.created_at })); }
  async deletePasskey(userId: string, credentialRowId: string, sessionId: string): Promise<void> {
    await this.locked(userId, async () => {
      await this.requireCredentialManagement(userId, sessionId);
      await this.auditMutation('auth.passkey.delete', userId, { credential_row_id: credentialRowId }, [this.sessionFence(userId, sessionId), { sql: 'DELETE FROM webauthn_credentials WHERE id=? AND user_id=?', params: [credentialRowId, userId], expectChanges: 1 }]);
    });
  }
}
export function createAuthService(deps: AuthDeps): AuthService { return new AuthService(deps); }
