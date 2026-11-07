import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { createSecureContext, createServer as createTlsServer, TLSSocket } from 'node:tls';

const key = readFileSync(new URL('../fixtures/smtp/test-key.pem', import.meta.url));
const certificate = readFileSync(new URL('../fixtures/smtp/test-cert.pem', import.meta.url));
type Mode = 'starttls' | 'implicit' | 'unavailable' | 'rejected';

/** Loopback-only SMTP fixture; records which side of the TLS upgrade sees AUTH. */
export async function smtpFixture(mode: Mode = 'starttls') {
  const sockets = new Set<Socket>();
  const commands: Array<{ encrypted: boolean; line: string }> = [];
  const received: string[] = [];
  const context = createSecureContext({ key, cert: certificate });
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // A client rejecting the deliberately untrusted certificate is expected.
    socket.on('error', () => {});
  };
  const attach = (socket: Socket, encrypted: boolean, greeting: boolean) => {
    track(socket);
    if (greeting) socket.write('220 local TLS fixture SMTP\r\n');
    let buffer = '', data = false;
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') { data = false; socket.write('250 accepted\r\n'); }
          else received.push(line);
          continue;
        }
        commands.push({ encrypted, line });
        if (/^(EHLO|HELO)\b/i.test(line)) {
          socket.write('250-fixture\r\n' + (!encrypted && mode !== 'unavailable' ? '250-STARTTLS\r\n' : '') + '250 AUTH PLAIN\r\n');
        } else if (/^STARTTLS\b/i.test(line)) {
          if (mode === 'unavailable') socket.write('502 STARTTLS unavailable\r\n');
          else if (mode === 'rejected') socket.write('454 TLS temporarily unavailable\r\n');
          else {
            socket.removeListener('data', onData);
            socket.write('220 Begin TLS\r\n');
            const tls = new TLSSocket(socket, { isServer: true, secureContext: context });
            attach(tls, true, false);
            return;
          }
        } else if (/^AUTH PLAIN\b/i.test(line)) socket.write('235 authentication accepted\r\n');
        else if (/^DATA\b/i.test(line)) { data = true; socket.write('354 go ahead\r\n'); }
        else if (/^QUIT\b/i.test(line)) socket.end('221 goodbye\r\n');
        else socket.write('250 ok\r\n');
      }
    };
    socket.on('data', onData);
  };
  const server = mode === 'implicit'
    ? createTlsServer({ key, cert: certificate }, (socket) => attach(socket, true, true))
    : createServer((socket) => attach(socket, false, true));
  if (mode === 'implicit') server.on('connection', track);
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as { port: number }).port, certificate, commands, received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
