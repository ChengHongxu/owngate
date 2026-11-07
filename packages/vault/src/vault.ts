// Every persisted record has its own data key. The master key only wraps it;
// both layers bind the record's purpose and identity through AES-GCM AAD.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const PREFIX = 'og2:';

export type VaultContext = readonly [namespace: string, recordId: string, field: string];
export const vaultContext = {
  credential: (id: string, field: string): VaultContext => ['credential', id, field],
  totp: (id: string): VaultContext => ['totp', id, 'secret'],
  cache: (id: string): VaultContext => ['cache', id, 'result'],
  task: (id: string, field: 'input' | 'result'): VaultContext => ['task', id, field],
  action: (id: string, field: 'input' | 'result'): VaultContext => ['action', id, field],
  notification: (id: string): VaultContext => ['notification', id, 'config'],
  notificationPassword: (id: string): VaultContext => ['notification', id, 'pass'],
  monitor: (id: string, field: 'config' | 'state'): VaultContext => ['monitor', id, field],
  keyCheck: (): VaultContext => ['vault', 'primary', 'key_check'],
};

export interface EncryptedBlob {
  /** v1: base64 ciphertext. v2: og2:<base64url envelope including wrapped DEK>. */
  ciphertext: string;
  iv: string;
  auth_tag: string;
}
interface EnvelopeV2 { version: 2; algorithm: 'AES-256-GCM'; payload: string; wrapped_key: EncryptedBlob }

export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (!value || typeof value !== 'object') return false;
  const blob = value as Record<string, unknown>;
  return typeof blob['ciphertext'] === 'string' && typeof blob['iv'] === 'string' && typeof blob['auth_tag'] === 'string';
}
export function isLegacyBlob(blob: EncryptedBlob): boolean { return !blob.ciphertext.startsWith(PREFIX); }

function deriveKey(value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('Master key must be exactly 32 bytes encoded as 64 hexadecimal characters');
  return Buffer.from(value, 'hex');
}
function aad(context: VaultContext, layer: 'payload' | 'key'): Buffer {
  if (!Array.isArray(context) || context.length !== 3 || context.some((part) => typeof part !== 'string' || part.length === 0)) {
    throw new Error('Vault encryption requires a record context');
  }
  return Buffer.from(JSON.stringify(['owngate', 2, layer, ...context]));
}
function decoded(value: string, size?: number): Buffer {
  const buffer = Buffer.from(value, 'base64');
  if (buffer.toString('base64') !== value || (size !== undefined && buffer.length !== size)) throw new Error('Invalid encrypted record encoding');
  return buffer;
}
function seal(key: Buffer, plaintext: Buffer, associated?: Buffer): EncryptedBlob {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  if (associated) cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), auth_tag: cipher.getAuthTag().toString('base64') };
}
function open(key: Buffer, blob: EncryptedBlob, associated?: Buffer): Buffer {
  const decipher = createDecipheriv(ALGO, key, decoded(blob.iv, IV_LEN));
  if (associated) decipher.setAAD(associated);
  decipher.setAuthTag(decoded(blob.auth_tag, 16));
  return Buffer.concat([decipher.update(decoded(blob.ciphertext)), decipher.final()]);
}

export class Vault {
  private key: Buffer;
  constructor(masterKeyHex: string) { this.key = deriveKey(masterKeyHex); }

  encrypt(plaintext: string, context: VaultContext): EncryptedBlob {
    const payloadAad = aad(context, 'payload');
    const keyAad = aad(context, 'key');
    const dataKey = randomBytes(KEY_LEN);
    try {
      const payload = seal(dataKey, Buffer.from(plaintext, 'utf8'), payloadAad);
      const envelope: EnvelopeV2 = { version: 2, algorithm: 'AES-256-GCM', payload: payload.ciphertext,
        wrapped_key: seal(this.key, dataKey, keyAad) };
      return { ...payload, ciphertext: PREFIX + Buffer.from(JSON.stringify(envelope)).toString('base64url') };
    } finally { dataKey.fill(0); }
  }

  decrypt(blob: EncryptedBlob, context: VaultContext): string {
    try {
      const payloadAad = aad(context, 'payload');
      if (!isEncryptedBlob(blob)) throw new Error('Invalid encrypted blob');
      // Legacy direct encryption is read for migration only. All new writes
      // use per-record keys and callers must always supply the record context.
      if (isLegacyBlob(blob)) return open(this.key, blob).toString('utf8');
      const encoded = blob.ciphertext.slice(PREFIX.length);
      const buffer = Buffer.from(encoded, 'base64url');
      if (buffer.toString('base64url') !== encoded) throw new Error('Invalid envelope encoding');
      const envelope = JSON.parse(buffer.toString('utf8')) as EnvelopeV2;
      if (envelope.version !== 2 || envelope.algorithm !== 'AES-256-GCM' || typeof envelope.payload !== 'string' || !isEncryptedBlob(envelope.wrapped_key)) throw new Error('Invalid envelope');
      const dataKey = open(this.key, envelope.wrapped_key, aad(context, 'key'));
      try {
        if (dataKey.length !== KEY_LEN) throw new Error('Invalid data key');
        return open(dataKey, { ...blob, ciphertext: envelope.payload }, payloadAad).toString('utf8');
      } finally { dataKey.fill(0); }
    } catch {
      throw new Error('Unable to decrypt vault record: wrong key, context, or corrupted ciphertext');
    }
  }

  encryptJSON(value: unknown, context: VaultContext): EncryptedBlob { return this.encrypt(JSON.stringify(value), context); }
  decryptJSON<T = unknown>(blob: EncryptedBlob, context: VaultContext): T { return JSON.parse(this.decrypt(blob, context)) as T; }
  static hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
}
