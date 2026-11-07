import nodemailer from 'nodemailer';
import type { SendMail } from './types.js';

/** No unbounded network wait and no raw SMTP errors cross the service API. */
export const sendSmtpMail: SendMail = async (options, message) => {
  const transport = nodemailer.createTransport({
    ...options,
    // Port 465 starts inside TLS; all other SMTP connections must upgrade
    // before authentication or delivery, even if STARTTLS is not advertised.
    requireTLS: !options.secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    const result = await transport.sendMail(message);
    if (result.rejected?.length || !result.accepted?.length) throw new Error('SMTP recipient rejected');
  } finally { transport.close(); }
};
