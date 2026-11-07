import { afterEach, describe, expect, it } from 'vitest';
import { sendSmtpMail } from '../src/monitors/smtp.js';
import { smtpFixture } from './helpers/smtp.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const message = { from: 'sender@example.invalid', to: ['recipient@example.invalid'], subject: 'TLS fixture', text: 'Local test message' };
const auth = { user: 'fixture', pass: 'fixture-smtp-password' };

describe('SMTP TLS transport', () => {
  it('delivers with verified implicit TLS and only authenticates inside the encrypted stream', async () => {
    const smtp = await smtpFixture('implicit'); cleanups.push(smtp.close);
    // Trust exists only in this in-process test wrapper; ChannelInput has no TLS bypass.
    const options = { host: '127.0.0.1', port: smtp.port, secure: true, auth, tls: { ca: smtp.certificate } };
    await expect(sendSmtpMail(options, message)).resolves.toBeUndefined();
    expect(smtp.commands.some(({ encrypted, line }) => encrypted && /^AUTH PLAIN\b/.test(line))).toBe(true);
    expect(smtp.commands.every(({ encrypted }) => encrypted)).toBe(true);
    expect(smtp.received.join('\n')).toContain('Local test message');
  });

  it.each(['unavailable', 'rejected'] as const)('refuses STARTTLS %s without sending credentials or falling back to plaintext delivery', async (mode) => {
    const smtp = await smtpFixture(mode); cleanups.push(smtp.close);
    await expect(sendSmtpMail({ host: '127.0.0.1', port: smtp.port, secure: false, auth }, message)).rejects.toThrow();
    expect(smtp.commands.some(({ line }) => /^STARTTLS\b/.test(line))).toBe(true);
    expect(smtp.commands.some(({ line }) => /^(AUTH|MAIL|RCPT|DATA)\b/.test(line))).toBe(false);
    expect(smtp.received).toEqual([]);
    expect(JSON.stringify(smtp.commands)).not.toContain(auth.pass);
    expect(JSON.stringify(smtp.commands)).not.toContain(Buffer.from(`\0${auth.user}\0${auth.pass}`).toString('base64'));
  });

  it('rejects an untrusted STARTTLS certificate before authentication or delivery', async () => {
    const smtp = await smtpFixture(); cleanups.push(smtp.close);
    await expect(sendSmtpMail({ host: '127.0.0.1', port: smtp.port, secure: false, auth }, message)).rejects.toThrow();
    expect(smtp.commands.some(({ line }) => /^STARTTLS\b/.test(line))).toBe(true);
    expect(smtp.commands.some(({ line }) => /^(AUTH|MAIL|RCPT|DATA)\b/.test(line))).toBe(false);
    expect(smtp.received).toEqual([]);
  });
});
