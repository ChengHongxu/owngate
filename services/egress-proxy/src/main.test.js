// Tests for egress-proxy SSRF blocking (design doc §4.4.6).
// Spawns the proxy on a free port and attempts requests through it.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { isBlockedAddress, resolveAndCheck } from './main.js'

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
