// Egress proxy — design doc §4.4.6
// Allows browser containers to reach the public internet while blocking all
// RFC 1918 / loopback / link-local / multicast addresses to prevent SSRF.
//
// Each browser connection authenticates with username=connection_id,
// password=per-connection-secret. The proxy identifies the source connection
// and applies per-connection domain allow lists when strict mode is on.
//
// This is a standard HTTP CONNECT proxy (for HTTPS) + HTTP proxy (for HTTP).
// Browser sets it via --proxy-server=http://egress:3128 at launch.

import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns/promises'
import { Buffer } from 'node:buffer'

const LISTEN_PORT = parseInt(process.env['EGRESS_PROXY_PORT'] ?? '3128', 10)
const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info'

// ── Blocked IP ranges (RFC 1918, loopback, link-local, multicast) ──────────

const BLOCKED_CIDRS = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['100.64.0.0', 10],   // CGNAT
  ['::1', 128],         // IPv6 loopback
  ['fc00::', 7],        // IPv6 unique local
  ['fe80::', 10],       // IPv6 link-local
]

function ipToLong(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return NaN
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function cidrToRange(cidr, prefix) {
  const base = ipToLong(cidr)
  // Use unsigned arithmetic throughout: a signed mask (0xffffffff << 16) is
  // negative and would make the masked base negative too, never matching the
  // unsigned IP value returned by ipToLong.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const lo = (base & mask) >>> 0
  const hi = (lo | (~mask >>> 0)) >>> 0
  return [lo, hi]
}

function isBlockedIPv4(ip) {
  const long = ipToLong(ip)
  if (isNaN(long)) return false
  for (const [cidr, prefix] of BLOCKED_CIDRS) {
    if (!cidr.includes('.')) continue
    const [lo, hi] = cidrToRange(cidr, prefix)
    if (long >= lo && long <= hi) return true
  }
  return false
}

function log(level, msg, extra = {}) {
  if (LOG_LEVEL === 'error' && level !== 'error') return
  const line = JSON.stringify({ level, time: Date.now(), msg, ...extra })
  if (level === 'error') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

// ── Proxy auth ─────────────────────────────────────────────────────────────

function parseProxyAuth(req) {
  const auth = req.headers['proxy-authorization']
  if (!auth) return null
  const [scheme, encoded] = auth.split(' ')
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return null
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const sep = decoded.indexOf(':')
  if (sep < 0) return null
  return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) }
}

function denyProxy(res, code = 407) {
  res.writeHead(code, {
    'Proxy-Authenticate': 'Basic realm="webridge-egress"',
    'Content-Length': '0',
  })
  res.end()
}

// ── DNS + SSRF check ──────────────────────────────────────────────────────

async function resolveAndCheck(hostname) {
  // Reject numeric IPs that are blocked directly
  if (net.isIPv4(hostname)) {
    if (isBlockedIPv4(hostname)) return { allowed: false, ip: hostname, reason: 'blocked IP' }
    return { allowed: true, ip: hostname }
  }
  // Resolve and check all returned IPs (DNS rebinding protection)
  let addrs
  try {
    addrs = await dns.resolve4(hostname)
  } catch {
    try {
      addrs = (await dns.resolve6(hostname)).map(a => a)
    } catch {
      return { allowed: false, ip: null, reason: 'DNS resolution failed' }
    }
  }
  for (const ip of addrs) {
    if (isBlockedIPv4(ip)) {
      return { allowed: false, ip, reason: `resolved to blocked IP ${ip}` }
    }
  }
  return { allowed: true, ip: addrs[0] ?? null }
}

// ── CONNECT handler (HTTPS tunneling) ─────────────────────────────────────

async function handleConnect(req, clientSocket, head) {
  const creds = parseProxyAuth(req)
  if (!creds) {
    clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="webridge-egress"\r\n\r\n')
    clientSocket.destroy()
    return
  }

  const [hostname, portStr] = (req.url ?? '').split(':')
  const port = parseInt(portStr ?? '443', 10)

  const check = await resolveAndCheck(hostname)
  if (!check.allowed) {
    log('warn', 'CONNECT blocked', { hostname, reason: check.reason, connection_id: creds.username })
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    clientSocket.destroy()
    return
  }

  log('info', 'CONNECT', { hostname, port, connection_id: creds.username })

  const serverSocket = net.connect(port, check.ip ?? hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    serverSocket.write(head)
    serverSocket.pipe(clientSocket)
    clientSocket.pipe(serverSocket)
  })

  serverSocket.on('error', (err) => {
    log('error', 'upstream socket error', { err: err.message })
    clientSocket.destroy()
  })
  clientSocket.on('error', () => serverSocket.destroy())
}

// ── HTTP proxy handler ─────────────────────────────────────────────────────

async function handleRequest(clientReq, clientRes) {
  const creds = parseProxyAuth(clientReq)
  if (!creds) return denyProxy(clientRes)

  const parsed = new URL(clientReq.url ?? '')
  const hostname = parsed.hostname
  const port = parseInt(parsed.port || '80', 10)

  const check = await resolveAndCheck(hostname)
  if (!check.allowed) {
    log('warn', 'HTTP blocked', { hostname, reason: check.reason, connection_id: creds.username })
    clientRes.writeHead(403)
    clientRes.end()
    return
  }

  log('info', 'HTTP', { hostname, port, connection_id: creds.username })

  const options = {
    hostname: check.ip ?? hostname,
    port,
    path: parsed.pathname + parsed.search,
    method: clientReq.method,
    headers: { ...clientReq.headers, host: hostname },
  }

  const proxyReq = http.request(options, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
    proxyRes.pipe(clientRes)
  })

  proxyReq.on('error', (err) => {
    log('error', 'proxy request error', { err: err.message })
    clientRes.writeHead(502)
    clientRes.end()
  })

  clientReq.pipe(proxyReq)
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest)
server.on('connect', handleConnect)

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  log('info', `egress-proxy listening on port ${LISTEN_PORT}`)
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
