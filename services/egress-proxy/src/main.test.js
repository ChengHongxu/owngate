// Tests for egress-proxy SSRF blocking (design doc §4.4.6).
// Spawns the proxy on a free port and attempts requests through it.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { isBlockedAddress, resolveAndCheck, sanitizeHeaders, createProxyServer } from './main.js'

// In-process proxies below log through the same module; keep test output quiet.
process.env['LOG_LEVEL'] = 'error'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 13999
const AUTH = 'Basic ' + Buffer.from('conn-test:secret').toString('base64')

const PW_PORT = 13998
const children = []

async function startProxy(port, extraEnv = {}) {
  const child = spawn('node', [resolve(__dirname, 'main.js')], {
    env: { ...process.env, EGRESS_PROXY_PORT: String(port), LOG_LEVEL: 'error', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  // Wait for the proxy to accept connections
  for (let i = 0; i < 40; i++) {
    const ok = await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1', () => { s.end(); res(true) })
      s.on('error', () => res(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('egress-proxy did not start')
}

before(async () => {
  await startProxy(PORT)
  await startProxy(PW_PORT, { EGRESS_REQUIRE_PASSWORD: '1' })
})

after(() => {
  for (const child of children) child.kill('SIGTERM')
})

/** Send a plain HTTP proxy request (absolute-form URL). */
function proxyRequest(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method: 'GET', path: url, headers: { host: new URL(url).host, ...headers } },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** Send a CONNECT tunnel request. */
function connectRequest(target, { port = PORT, auth = AUTH } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`,
      )
    })
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('latin1')
      if (buf.includes('\r\n\r\n')) {
        sock.destroy()
        const m = /^HTTP\/1\.1 (\d{3})/.exec(buf)
        resolve(m ? Number(m[1]) : 0)
      }
    })
    sock.on('error', () => resolve(0))
    sock.on('close', () => resolve(0))
    setTimeout(() => { sock.destroy(); resolve(0) }, 5000)
  })
}

test('rejects CONNECT to loopback', async () => {
  assert.equal(await connectRequest('127.0.0.1:443'), 403)
})

test('rejects CONNECT to RFC1918 address', async () => {
  assert.equal(await connectRequest('192.168.1.10:443'), 403)
})

test('rejects CONNECT to link-local / metadata address', async () => {
  assert.equal(await connectRequest('169.254.169.254:80'), 403)
})

test('rejects CONNECT to 10/8 address', async () => {
  assert.equal(await connectRequest('10.0.0.5:443'), 403)
})

test('rejects plain HTTP to a blocked private address', async () => {
  assert.equal(await proxyRequest('http://127.0.0.1:8080/', { 'proxy-authorization': AUTH }), 403)
})

test('requires Proxy-Authorization', async () => {
  assert.equal(await proxyRequest('http://example.com/'), 407)
})

test('allows CONNECT to a public host', async () => {
  const code = await connectRequest('example.com:443')
  assert.ok(code === 200, `expected 200, got ${code}`)
})

test('rejects CONNECT to 0.0.0.0', async () => {
  assert.equal(await connectRequest('0.0.0.0:443'), 403)
})

test('rejects CONNECT to bracketed IPv6 loopback', async () => {
  assert.equal(await connectRequest('[::1]:443'), 403)
})

test('isBlockedAddress blocks private / reserved IPv6', () => {
  for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:0.0.0.0']) {
    assert.equal(isBlockedAddress(ip), true, ip)
  }
})

test('isBlockedAddress allows public addresses', () => {
  for (const ip of ['2606:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '1.1.1.1', '93.184.215.14']) {
    assert.equal(isBlockedAddress(ip), false, ip)
  }
})

test('isBlockedAddress covers IPv4 boundaries and rejects non-IPs', () => {
  for (const ip of ['0.0.0.0', '0.255.255.255', '172.31.255.255', '100.127.255.255', '255.255.255.255']) {
    assert.equal(isBlockedAddress(ip), true, ip)
  }
  for (const ip of ['1.0.0.0', '172.32.0.0', '100.128.0.0', '223.255.255.255']) {
    assert.equal(isBlockedAddress(ip), false, ip)
  }
  for (const ip of ['', 'localhost', '1.2.3', '::g', undefined]) {
    assert.equal(isBlockedAddress(ip), true, String(ip))
  }
})

test('resolveAndCheck rejects IPv6 literals in private ranges', async () => {
  assert.equal((await resolveAndCheck('[::1]')).allowed, false)
  assert.equal((await resolveAndCheck('fe80::1')).allowed, false)
  assert.equal((await resolveAndCheck('')).allowed, false)
})

test('EGRESS_REQUIRE_PASSWORD: short password gets 407', async () => {
  const short = 'Basic ' + Buffer.from('conn-test:secret').toString('base64')
  assert.equal(await connectRequest('example.com:443', { port: PW_PORT, auth: short }), 407)
})

test('EGRESS_REQUIRE_PASSWORD: long password passes auth', async () => {
  const long = 'Basic ' + Buffer.from('conn-test:' + 'a'.repeat(32)).toString('base64')
  // Blocked target gives 403 without network access, proving auth succeeded.
  assert.equal(await connectRequest('127.0.0.1:443', { port: PW_PORT, auth: long }), 403)
  assert.equal(await connectRequest('example.com:443', { port: PW_PORT, auth: long }), 200)
})

// ── Special-purpose address table (IANA registries) ───────────────────────

test('isBlockedAddress blocks IPv4 special-purpose ranges', () => {
  for (const ip of ['192.0.0.8', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.255',
    '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '100.64.0.1']) {
    assert.equal(isBlockedAddress(ip), true, ip)
  }
  for (const ip of ['192.0.1.1', '192.0.3.0', '198.17.255.255', '198.20.0.0', '203.0.114.0', '8.8.8.8']) {
    assert.equal(isBlockedAddress(ip), false, ip)
  }
})

test('isBlockedAddress blocks IPv6 prefixes that embed or reach IPv4', () => {
  for (const ip of [
    '::127.0.0.1', '::7f00:1', '::a00:1',     // IPv4-compatible ::/96
    '64:ff9b::7f00:1', '64:ff9b::8.8.8.8',     // NAT64 well-known, blocked whole
    '64:ff9b:1::1',                             // NAT64 local-use
    '2002:7f00:1::1', '2002:808:808::1',        // 6to4, blocked whole
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',     // Teredo
    '::ffff:0:127.0.0.1', '::ffff:0:8.8.8.8',  // SIIT ::ffff:0:0:0/96
    '[::ffff:0:7f00:1]',
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip)
  }
})

test('isBlockedAddress blocks other IPv6 special-purpose ranges', () => {
  for (const ip of ['fec0::1', 'feff::1', '100::1', '2001:2::1', '2001:10::1', '2001:20::1',
    '2001:db8::1', '3fff::1', '5f00::1', 'ff0e::1', '::2', '4000::1', 'e000::1']) {
    assert.equal(isBlockedAddress(ip), true, ip)
  }
  // Global unicast neighbours of the blocked prefixes stay reachable.
  for (const ip of ['2001:4860:4860::8888', '2001:db9::1', '2003::1', '2a00:1450:4001::1', '2400:cb00::1']) {
    assert.equal(isBlockedAddress(ip), false, ip)
  }
})

// ── resolveAndCheck with an injected resolver ─────────────────────────────

function fakeResolver({ a = [], aaaa = [] } = {}) {
  const answer = (list) => async () => {
    if (list.length === 0) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' })
    return list
  }
  return { resolve4: answer(a), resolve6: answer(aaaa) }
}

test('resolveAndCheck rejects a name that only has a private AAAA', async () => {
  for (const ip of ['::1', 'fd00::5', 'fe80::1', '::ffff:10.0.0.1', '64:ff9b::a00:1']) {
    const r = await resolveAndCheck('internal.example', fakeResolver({ aaaa: [ip] }))
    assert.equal(r.allowed, false, ip)
    assert.equal(r.ip, ip)
  }
})

test('resolveAndCheck rejects public A mixed with private AAAA', async () => {
  const r = await resolveAndCheck('mixed.example', fakeResolver({ a: ['93.184.215.14'], aaaa: ['fd00::1'] }))
  assert.equal(r.allowed, false)
  assert.match(r.reason, /fd00::1/)
})

test('resolveAndCheck allows an all-public answer and returns a checked address', async () => {
  const r = await resolveAndCheck('public.example',
    fakeResolver({ a: ['93.184.215.14'], aaaa: ['2606:2800:21f:cb07:6820:80da:af6b:8b2c'] }))
  assert.deepEqual(r, { allowed: true, ip: '93.184.215.14' })
  const v6only = await resolveAndCheck('v6.example', fakeResolver({ aaaa: ['2606:4700::1111'] }))
  assert.deepEqual(v6only, { allowed: true, ip: '2606:4700::1111' })
})

test('resolveAndCheck fails closed on resolver errors and junk answers', async () => {
  assert.equal((await resolveAndCheck('none.example', fakeResolver())).allowed, false)
  const throwing = { resolve4: () => { throw new Error('boom') }, resolve6: () => { throw new Error('boom') } }
  assert.equal((await resolveAndCheck('throw.example', throwing)).allowed, false)
  const junk = await resolveAndCheck('junk.example', fakeResolver({ a: ['not-an-ip'] }))
  assert.equal(junk.allowed, false)
})

// ── Header sanitizing ─────────────────────────────────────────────────────

test('sanitizeHeaders keeps framing fields even when Connection lists them', () => {
  const out = sanitizeHeaders({
    connection: 'content-length, transfer-encoding, host, x-a',
    'content-length': '3', host: 'h', 'x-a': '1', 'x-b': '2',
  })
  assert.deepEqual(out, { 'content-length': '3', host: 'h', 'x-b': '2' })
  // Duplicate "chunked" collapses so the next hop decodes the body once.
  assert.equal(sanitizeHeaders({ 'transfer-encoding': 'chunked, chunked' })['transfer-encoding'], 'chunked')
  assert.equal(sanitizeHeaders({ 'transfer-encoding': 'gzip, chunked' })['transfer-encoding'], 'gzip, chunked')
})

// In-process proxy + local target. The default check always blocks loopback,
// so these tests inject a check that maps the unresolvable name `target.test`
// to 127.0.0.1. A request reaching the target also proves the proxy connects
// to the checked address and does not resolve the name again.
const target = { server: null, port: 0, last: null }
const badTarget = { server: null, port: 0 }
const inproc = { server: null, port: 0, checked: [] }

before(async () => {
  target.server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      target.last = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }
      res.end('ok')
    })
  })
  await new Promise((r) => target.server.listen(0, '127.0.0.1', r))
  target.port = target.server.address().port

  // Raw TCP target: Node's own http server refuses to send this response.
  // Trailer without chunked framing used to make the proxy's writeHead throw.
  badTarget.server = net.createServer((sock) => {
    sock.once('data', () => {
      sock.end([
        'HTTP/1.1 200 OK', 'Content-Length: 2', 'Connection: x-internal, close', 'X-Internal: leak',
        'Keep-Alive: timeout=5', 'Trailer: x-foo', 'X-Public: yes', '', 'ok',
      ].join('\r\n'))
    })
  })
  await new Promise((r) => badTarget.server.listen(0, '127.0.0.1', r))
  badTarget.port = badTarget.server.address().port

  inproc.server = createProxyServer({
    requirePassword: false,
    check: async (hostname) => {
      inproc.checked.push(hostname)
      return hostname === 'target.test'
        ? { allowed: true, ip: '127.0.0.1' }
        : { allowed: false, ip: null, reason: 'test: blocked' }
    },
  })
  await new Promise((r) => inproc.server.listen(0, '127.0.0.1', r))
  inproc.port = inproc.server.address().port
})

after(() => {
  for (const s of [inproc.server, target.server]) {
    s?.closeAllConnections()
    s?.close()
  }
  badTarget.server?.close()
})

/** Write a raw request to the in-process proxy and collect the full response. */
function rawProxy(head, body = '') {
  if (!/\r\nProxy-Authorization:/i.test(head)) head += `\r\nProxy-Authorization: ${AUTH}`
  return new Promise((resolve, reject) => {
    const sock = net.connect(inproc.port, '127.0.0.1', () => sock.write(head + '\r\n\r\n' + body))
    const chunks = []
    sock.on('data', (d) => chunks.push(d))
    sock.on('end', () => {
      const text = Buffer.concat(chunks).toString('latin1')
      const [rawHead = '', ...rest] = text.split('\r\n\r\n')
      const [statusLine = '', ...lines] = rawHead.split('\r\n')
      const headers = {}
      for (const l of lines) {
        const i = l.indexOf(':')
        headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim()
      }
      resolve({ status: Number(statusLine.split(' ')[1]), headers, body: rest.join('\r\n\r\n') })
    })
    sock.on('error', reject)
    setTimeout(() => { sock.destroy(); reject(new Error('raw proxy request timed out')) }, 5000)
  })
}

const targetUrl = (path) => `http://target.test:${target.port}${path}`

test('HTTP forwarding strips proxy credentials and hop-by-hop headers', async () => {
  const res = await rawProxy([
    `GET ${targetUrl('/h?q=1')} HTTP/1.1`,
    `Host: target.test:${target.port}`,
    `Proxy-Authorization: ${AUTH}`,
    'Proxy-Connection: keep-alive',
    'Connection: close, X-Hop-Secret',
    'X-Hop-Secret: s3cret',
    'Keep-Alive: timeout=5',
    'TE: trailers',
    'Trailer: X-Foo',
    'Upgrade: h2c',
    'X-Keep: yes',
    'Cookie: a=1',
  ].join('\r\n'))
  assert.equal(res.status, 200)
  const h = target.last.headers
  for (const name of ['proxy-authorization', 'proxy-connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'x-hop-secret']) {
    assert.equal(h[name], undefined, name)
  }
  assert.doesNotMatch(h['connection'] ?? '', /x-hop-secret/i)
  assert.equal(h['x-keep'], 'yes')
  assert.equal(h['cookie'], 'a=1')
  assert.equal(h['host'], `target.test:${target.port}`)
  assert.equal(target.last.url, '/h?q=1')
  assert.ok(inproc.checked.includes('target.test'))
})

test('HTTP forwarding keeps a Content-Length body intact', async () => {
  const body = 'hello=world&x=1'
  const res = await rawProxy([
    `POST ${targetUrl('/cl')} HTTP/1.1`,
    `Host: target.test:${target.port}`,
    'Connection: close',
    'Content-Type: application/x-www-form-urlencoded',
    `Content-Length: ${body.length}`,
  ].join('\r\n'), body)
  assert.equal(res.status, 200)
  assert.equal(target.last.body, body)
  assert.equal(target.last.headers['content-length'], String(body.length))
})

test('HTTP forwarding re-frames a chunked body', async () => {
  const res = await rawProxy([
    `POST ${targetUrl('/chunked')} HTTP/1.1`,
    `Host: target.test:${target.port}`,
    'Connection: close',
    'Transfer-Encoding: chunked',
  ].join('\r\n'), '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n')
  assert.equal(res.status, 200)
  assert.equal(target.last.body, 'hello world')
  assert.equal(target.last.headers['transfer-encoding'], 'chunked')
  assert.equal(target.last.headers['content-length'], undefined)
})

test('HTTP forwarding strips hop-by-hop response headers and survives a bad Trailer', async () => {
  const res = await rawProxy([
    `GET http://target.test:${badTarget.port}/ HTTP/1.1`,
    `Host: target.test:${badTarget.port}`,
    'Connection: close',
  ].join('\r\n'))
  assert.equal(res.status, 200)
  assert.equal(res.body, 'ok')
  assert.equal(res.headers['x-public'], 'yes')
  for (const name of ['x-internal', 'keep-alive', 'trailer']) assert.equal(res.headers[name], undefined, name)
  // The proxy is still serving.
  const again = await rawProxy([`GET ${targetUrl('/')} HTTP/1.1`, `Host: target.test:${target.port}`, 'Connection: close'].join('\r\n'))
  assert.equal(again.status, 200)
})

test('in-process proxy still blocks hosts the check rejects', async () => {
  const res = await rawProxy([`GET http://other.test/ HTTP/1.1`, 'Host: other.test', 'Connection: close'].join('\r\n'))
  assert.equal(res.status, 403)
})
