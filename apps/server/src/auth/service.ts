// AuthService — admin authentication: password, sessions, TOTP, passkeys, step-up.
// Design doc §8.2 (recovery), §8.9 (audit), §7.2 (sensitive operations require
// user-presence verification), D8 (password + passkey + optional TOTP).

import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';
import type { DbClient } from '@webridge/db';
import type { Vault } from '@webridge/vault';
import {
  buildOtpauthUrl,
  generateTotpSecret,
  verifyTotpCode,
} from './totp.js';

export interface AuthDeps {
  db: DbClient;
  vault: Vault;
  /** WebAuthn relying party config */
  rpID: string;
  rpName: string;
  origin: string;
}

/** Default session lifetime: 12 hours. */
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Step-up grant lifetime (design §7.2: approval valid ~15 minutes). */
const STEP_UP_TTL_MS = 15 * 60 * 1000;
/** WebAuthn challenge lifetime. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const TOTP_ISSUER = 'webridge';

interface PendingChallenge {
  challenge: string;
  expiresAt: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isExpired(iso: string, now = Date.now()): boolean {
  const t = Date.parse(iso);
  return Number.isNaN(t) || t <= now;
}

function parseTransports(value: unknown): AuthenticatorTransportFuture[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is AuthenticatorTransportFuture => typeof t === 'string');
}

export class AuthService {
  private readonly db: DbClient;
  private readonly vault: Vault;
  private readonly rpID: string;
  private readonly rpName: string;
  private readonly origin: string;

  // Step-up grants live in memory (acceptable for a single-admin deployment:
  // a server restart revokes all step-up grants, sessions survive in SQLite).
  private readonly stepUps = new Map<string, number>();

  // WebAuthn challenges, per user, between begin and finish.
  private readonly registrationChallenges = new Map<string, PendingChallenge>();
  private readonly authenticationChallenges = new Map<string, PendingChallenge>();

  constructor(deps: AuthDeps) {
    this.db = deps.db;
    this.vault = deps.vault;
    this.rpID = deps.rpID;
    this.rpName = deps.rpName;
    this.origin = deps.origin;
    // Opportunistic cleanup; ignore failures (table may be empty or worker busy).
    this.db.deleteExpiredLoginSessions(nowIso()).catch(() => undefined);
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  /**
   * Append an audit entry (§8.9). The hash chain links each entry to its
   * predecessor so deleted or rewritten rows are detectable.
   */
  private async audit(action: string, target: string, detail: Record<string, unknown> = {}): Promise<void> {
    const last = await this.db.getLastAuditEntry();
    const prev = (last as { entry_hash?: string } | undefined)?.entry_hash ?? '0';
    const at = nowIso();
    const entryHash = createHash('sha256')
      .update(`${prev}|${JSON.stringify({ action, target, detail, at })}`)
      .digest('hex');
    await this.db.appendAuditLog({
      action,
      target,
      detail,
      prev_hash: prev,
      entry_hash: entryHash,
    });
  }

  // ── Password ───────────────────────────────────────────────────────────────

  async hasAnyUser(): Promise<boolean> {
    return (await this.db.countAdminUsers()) > 0;
  }

  /** Create the first admin. Rejects if any user already exists (§8.2: no second account). */
  async bootstrap(username: string, password: string): Promise<{ id: string }> {
    if (await this.hasAnyUser()) {
      throw new Error('ADMIN_ALREADY_EXISTS');
    }
    const id = randomBytes(16).toString('hex');
    const passwordHash = await argon2.hash(password);
    await this.db.createAdminUser({ id, username, password_hash: passwordHash });
    await this.audit('auth.bootstrap', username, { user_id: id });
    return { id };
  }

  async verifyPassword(username: string, password: string): Promise<{ id: string } | null> {
    const user = await this.db.getAdminByUsername(username);
    if (!user) {
      // Hash anyway so response time does not reveal whether the username exists.
      await argon2.hash(password).catch(() => undefined);
      return null;
    }
    const ok = await argon2.verify(user.password_hash, password).catch(() => false);
    if (!ok) return null;
    return { id: user.id };
  }

  /** Escape hatch used by `webridge admin reset-password` (§8.2). Audited. */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    const passwordHash = await argon2.hash(newPassword);
    await this.db.updateAdminPassword({ id: userId, password_hash: passwordHash });
    // Any stolen session becomes useless after a reset.
    await this.db.deleteExpiredLoginSessions(nowIso()).catch(() => undefined);
    await this.audit('auth.password.reset', userId, { via: 'cli' });
  }

  async setPassword(username: string, newPassword: string): Promise<boolean> {
    const user = await this.db.getAdminByUsername(username);
    if (!user) return false;
    const passwordHash = await argon2.hash(newPassword);
    await this.db.updateAdminPassword({ id: user.id, password_hash: passwordHash });
    await this.audit('auth.password.set', username, { user_id: user.id });
    return true;
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  async createSession(
    userId: string,
    ttlMs: number = DEFAULT_SESSION_TTL_MS,
  ): Promise<{ sessionId: string; expiresAt: string }> {
    const sessionId = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await this.db.insertLoginSession({ id: sessionId, user_id: userId, expires_at: expiresAt });
    await this.audit('auth.session.create', userId, { expires_at: expiresAt });
    return { sessionId, expiresAt };
  }

  async getSession(sessionId: string): Promise<{ userId: string } | null> {
    const row = await this.db.getLoginSession(sessionId);
    if (!row) return null;
    if (isExpired(row.expires_at)) {
      await this.db.deleteLoginSession(sessionId);
      this.stepUps.delete(sessionId);
      return null;
    }
    return { userId: row.user_id };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const row = await this.db.getLoginSession(sessionId);
    await this.db.deleteLoginSession(sessionId);
    this.stepUps.delete(sessionId);
    if (row) await this.audit('auth.session.delete', row.user_id, {});
  }

  // ── TOTP ───────────────────────────────────────────────────────────────────

  async isTotpEnabled(userId: string): Promise<boolean> {
    const user = await this.db.getAdminById(userId);
    return user?.totp_enabled === true;
  }

  private async readTotpSecret(userId: string): Promise<string | null> {
    const row = await this.db.getTotpSecret(userId);
    if (!row) return null;
    try {
      const blob = { ciphertext: row.ciphertext, iv: row.iv, auth_tag: row.auth_tag };
      const payload = this.vault.decryptJSON<{ secretBase32: string }>(blob);
      return payload.secretBase32;
    } catch {
      // Wrong master key or corrupted row — treat as absent, never crash auth.
      return null;
    }
  }

  /**
   * Generate a new TOTP secret and store it encrypted, but do NOT enable it:
   * the caller must confirm one valid code first (§8.2 users lose phones).
   */
  async enrollTotp(userId: string): Promise<{ secretBase32: string; otpauthUrl: string }> {
    const user = await this.db.getAdminById(userId);
    if (!user) throw new Error('ADMIN_NOT_FOUND');

    const secretBase32 = generateTotpSecret();
    const blob = this.vault.encryptJSON({ secretBase32 });
    await this.db.upsertTotpSecret({
      user_id: userId,
      ciphertext: blob.ciphertext,
      iv: blob.iv,
      auth_tag: blob.auth_tag,
    });
    await this.audit('auth.totp.enroll', user.username, { user_id: userId });

    const otpauthUrl = buildOtpauthUrl({
      issuer: TOTP_ISSUER,
      accountName: user.username,
      secretBase32,
    });
    return { secretBase32, otpauthUrl };
  }

  /** Check a code against the stored secret. Does not change enabled state. */
  async verifyTotp(userId: string, code: string): Promise<boolean> {
    const secret = await this.readTotpSecret(userId);
    if (!secret) return false;
    const ok = verifyTotpCode(secret, code);
    await this.audit(ok ? 'auth.totp.verify.success' : 'auth.totp.verify.failure', userId, {});
    return ok;
  }

  /** Verify a code and enable TOTP for the user. */
  async confirmTotp(userId: string, code: string): Promise<boolean> {
    const secret = await this.readTotpSecret(userId);
    if (!secret || !verifyTotpCode(secret, code)) {
      await this.audit('auth.totp.confirm.failure', userId, {});
      return false;
    }
    await this.db.setTotpEnabled({ id: userId, totp_enabled: true });
    await this.audit('auth.totp.confirm.success', userId, {});
    return true;
  }

  /** Verify a code, disable TOTP and drop the stored secret. */
  async disableTotp(userId: string, code: string): Promise<boolean> {
    const secret = await this.readTotpSecret(userId);
    if (!secret || !verifyTotpCode(secret, code)) {
      await this.audit('auth.totp.disable.failure', userId, {});
      return false;
    }
    await this.db.setTotpEnabled({ id: userId, totp_enabled: false });
    await this.db.deleteTotpSecret(userId);
    await this.audit('auth.totp.disable.success', userId, {});
    return true;
  }

  // ── WebAuthn ───────────────────────────────────────────────────────────────

  private cleanupChallenges(map: Map<string, PendingChallenge>): void {
    const now = Date.now();
    for (const [key, value] of map) {
      if (value.expiresAt <= now) map.delete(key);
    }
  }

  private takeChallenge(map: Map<string, PendingChallenge>, userId: string): string | null {
    const entry = map.get(userId);
    map.delete(userId);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry.challenge;
  }

  async beginPasskeyRegistration(
    userId: string,
    username: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    this.cleanupChallenges(this.registrationChallenges);

    const existing = await this.db.listWebauthnCredentials(userId);
    const excludeCredentials = existing.map((row) => {
      const transports = parseTransports(row.transports);
      return transports.length > 0
        ? { id: row.credential_id, transports }
        : { id: row.credential_id };
    });

    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userName: username,
      userDisplayName: username,
      // Stable per-user handle; never the username (WebAuthn recommends an opaque id).
      userID: new TextEncoder().encode(userId),
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });

    this.registrationChallenges.set(userId, {
      challenge: options.challenge,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return options;
  }

  async finishPasskeyRegistration(
    userId: string,
    response: RegistrationResponseJSON,
  ): Promise<{ verified: boolean }> {
    const expectedChallenge = this.takeChallenge(this.registrationChallenges, userId);
    if (!expectedChallenge) return { verified: false };

    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      requireUserVerification: true,
    });
    if (!result.verified) {
      await this.audit('auth.passkey.register.failure', userId, {});
      return { verified: false };
    }

    const { credential, credentialDeviceType } = result.registrationInfo;
    await this.db.insertWebauthnCredential({
      id: randomBytes(16).toString('hex'),
      user_id: userId,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter,
      transports: parseTransports(response.response.transports),
    });
    await this.audit('auth.passkey.register', userId, {
      credential_id: credential.id,
      device_type: credentialDeviceType,
    });
    return { verified: true };
  }

  async beginPasskeyAuthentication(userId: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    this.cleanupChallenges(this.authenticationChallenges);

    const rows = await this.db.listWebauthnCredentials(userId);
    const allowCredentials = rows.map((row) => {
      const transports = parseTransports(row.transports);
      return transports.length > 0
        ? { id: row.credential_id, transports }
        : { id: row.credential_id };
    });

    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials,
      // §7.2: sensitive-operation approval requires a user-presence-verified passkey.
      userVerification: 'required',
    });

    this.authenticationChallenges.set(userId, {
      challenge: options.challenge,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return options;
  }

  async finishPasskeyAuthentication(
    userId: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ verified: boolean }> {
    const expectedChallenge = this.takeChallenge(this.authenticationChallenges, userId);
    if (!expectedChallenge) return { verified: false };

    const row = await this.db.getWebauthnCredentialByCredentialId(response.id);
    // The credential must exist AND belong to this user.
    if (!row || row.user_id !== userId) {
      await this.audit('auth.passkey.authenticate.failure', userId, { reason: 'unknown_credential' });
      return { verified: false };
    }

    const credential: WebAuthnCredential = {
      id: row.credential_id,
      publicKey: Buffer.from(row.public_key, 'base64'),
      counter: row.counter,
      transports: parseTransports(row.transports),
    };

    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      credential,
      requireUserVerification: true,
    }).catch(() => null);

    if (!result || !result.verified) {
      await this.audit('auth.passkey.authenticate.failure', userId, { credential_id: response.id });
      return { verified: false };
    }

    await this.db.updateWebauthnCounter({
      credential_id: row.credential_id,
      counter: result.authenticationInfo.newCounter,
    });
    await this.audit('auth.passkey.authenticate.success', userId, { credential_id: row.credential_id });
    return { verified: true };
  }

  async listPasskeys(userId: string): Promise<{ id: string; createdAt: string }[]> {
    const rows = await this.db.listWebauthnCredentials(userId);
    return rows.map((row) => ({ id: row.id, createdAt: row.created_at }));
  }

  async deletePasskey(userId: string, credentialRowId: string): Promise<void> {
    await this.db.deleteWebauthnCredential({ id: credentialRowId, user_id: userId });
    await this.audit('auth.passkey.delete', userId, { credential_row_id: credentialRowId });
  }

  // ── Sensitive-op step-up (§7.2) ────────────────────────────────────────────

  /** Marks the session as having passed step-up auth for the step-up window. */
  async markStepUp(sessionId: string): Promise<void> {
    this.cleanupStepUps();
    this.stepUps.set(sessionId, Date.now() + STEP_UP_TTL_MS);
  }

  async hasStepUp(sessionId: string): Promise<boolean> {
    const expiresAt = this.stepUps.get(sessionId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.stepUps.delete(sessionId);
      return false;
    }
    return true;
  }

  private cleanupStepUps(): void {
    const now = Date.now();
    for (const [sessionId, expiresAt] of this.stepUps) {
      if (expiresAt <= now) this.stepUps.delete(sessionId);
    }
  }
}

export function createAuthService(deps: AuthDeps): AuthService {
  return new AuthService(deps);
}
