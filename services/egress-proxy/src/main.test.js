// Tests for egress-proxy SSRF blocking (design doc §4.4.6).
// Spawns the proxy on a free port and attempts requests through it.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 13999
const AUTH = 'Basic ' + Buffer.from('conn-test:secret').toString('base64')

let child

before(async () => {
  child = spawn('node', [resolve(__dirname, 'main.js')], {
    env: { ...process.env, EGRESS_PROXY_PORT: String(PORT), LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Wait for the proxy to accept connections
  for (let i = 0; i < 40; i++) {
    const ok = await new Promise((res) => {
      const s = net.connect(PORT, '127.0.0.1', () => { s.end(); res(true) })
      s.on('error', () => res(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('egress-proxy did not start')
})

after(() => {
  if (child) child.kill('SIGTERM')
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
function connectRequest(target) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${AUTH}\r\n\r\n`,
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
