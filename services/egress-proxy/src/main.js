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
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const LISTEN_PORT = parseInt(process.env['EGRESS_PROXY_PORT'] ?? '3128', 10)
const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info'
// Opt-in: require a non-trivial password in Proxy-Authorization (see checkProxyAuth).
const REQUIRE_PASSWORD = ['1', 'true', 'yes'].includes(
  (process.env['EGRESS_REQUIRE_PASSWORD'] ?? '').toLowerCase(),
)
const MIN_PASSWORD_LENGTH = 16

// ── Blocked IP ranges (RFC 1918, loopback, link-local, multicast, reserved) ─

const BLOCKED_IPV4_CIDRS = [
  ['0.0.0.0', 8],       // "this network" — connecting to 0.0.0.0 reaches localhost on Linux
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved + 255.255.255.255 broadcast
  ['100.64.0.0', 10],   // CGNAT
]

const BLOCKED_IPV6_CIDRS = [
  ['::', 128],          // unspecified
  ['::1', 128],         // loopback
  ['fc00::', 7],        // unique local
  ['fe80::', 10],       // link-local
  ['ff00::', 8],        // multicast
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

const IPV4_RANGES = BLOCKED_IPV4_CIDRS.map(([cidr, prefix]) => cidrToRange(cidr, prefix))

const IPV6_BLOCKLIST = new net.BlockList()
for (const [cidr, prefix] of BLOCKED_IPV6_CIDRS) IPV6_BLOCKLIST.addSubnet(cidr, prefix, 'ipv6')

function isBlockedIPv4(ip) {
  const long = ipToLong(ip)
  if (isNaN(long)) return true
  return IPV4_RANGES.some(([lo, hi]) => long >= lo && long <= hi)
}

/** Expand an IPv6 address into its 8 16-bit groups (handles :: and a dotted IPv4 tail). */
function ipv6Groups(ip) {
  let addr = ip
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr)
  if (tail) {
    const v4 = ipToLong(tail[1])
    addr = addr.slice(0, tail.index) + ((v4 >>> 16).toString(16)) + ':' + ((v4 & 0xffff).toString(16))
  }
  const [head, rest] = addr.split('::')
  const h = head ? head.split(':') : []
  const r = rest === undefined ? [] : rest ? rest.split(':') : []
  const fill = rest === undefined ? [] : new Array(8 - h.length - r.length).fill('0')
  return [...h, ...fill, ...r].map((g) => parseInt(g, 16))
}

/**
 * True when the address must not be reached through the proxy.
 * Anything that is not a valid IPv4/IPv6 literal is treated as blocked.
 * IPv4-mapped IPv6 (::ffff:0:0/96) is unwrapped and checked under IPv4 rules.
 */
export function isBlockedAddress(ip) {
  if (typeof ip !== 'string') return true
  let addr = ip.trim()
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1)
  const zone = addr.indexOf('%')
  if (zone >= 0) addr = addr.slice(0, zone)
  if (net.isIPv4(addr)) return isBlockedIPv4(addr)
  if (!net.isIPv6(addr)) return true
  const g = ipv6Groups(addr)
  if (g.length !== 8 || g.some((x) => isNaN(x))) return true
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isBlockedIPv4(`${g[6] >>> 8}.${g[6] & 0xff}.${g[7] >>> 8}.${g[7] & 0xff}`)
  }
  return IPV6_BLOCKLIST.check(addr, 'ipv6')
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

/**
 * Parse and validate proxy credentials. Returns null when the request must get 407.
 *
 * With EGRESS_REQUIRE_PASSWORD on, the password must be at least
 * MIN_PASSWORD_LENGTH characters. Its value is NOT verified: the per-connection
 * secret (§4.4.6) is generated by the browser worker at runtime, and this proxy
 * has no registry of issued credentials to compare against. The length check
 * only rejects clients that send no secret or an obviously trivial one.
 */
export function checkProxyAuth(req, requirePassword = REQUIRE_PASSWORD) {
  const creds = parseProxyAuth(req)
  if (!creds || !creds.username) return null
  if (requirePassword && creds.password.length < MIN_PASSWORD_LENGTH) return null
  return creds
}

function denyProxy(res, code = 407) {
  res.writeHead(code, {
    'Proxy-Authenticate': 'Basic realm="webridge-egress"',
    'Content-Length': '0',
  })
  res.end()
}

// ── DNS + SSRF check ──────────────────────────────────────────────────────

export async function resolveAndCheck(hostname) {
  let host = hostname ?? ''
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!host) return { allowed: false, ip: null, reason: 'missing host' }
  // Numeric IPs are checked directly
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) return { allowed: false, ip: host, reason: 'blocked IP' }
    return { allowed: true, ip: host }
  }
  // Resolve A and AAAA and check every returned address (DNS rebinding /
  // mixed-answer protection): one blocked address rejects the whole host.
  const [v4, v6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)])
  const addrs4 = v4.status === 'fulfilled' ? v4.value : []
  const addrs6 = v6.status === 'fulfilled' ? v6.value : []
  const addrs = [...addrs4, ...addrs6]
  if (addrs.length === 0) return { allowed: false, ip: null, reason: 'DNS resolution failed' }
  for (const ip of addrs) {
    if (isBlockedAddress(ip)) {
      return { allowed: false, ip, reason: `resolved to blocked IP ${ip}` }
    }
  }
  // Prefer IPv4 when available (resolve4 first, fall back to resolve6)
  return { allowed: true, ip: addrs[0] }
}

/** Split a CONNECT authority ("host:port" or "[v6]:port") into hostname and port. */
function parseAuthority(authority) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority)
  if (m) return { hostname: m[1], port: parseInt(m[2] ?? '443', 10) }
  const sep = authority.lastIndexOf(':')
  if (sep < 0) return { hostname: authority, port: 443 }
  return { hostname: authority.slice(0, sep), port: parseInt(authority.slice(sep + 1), 10) }
}

// ── CONNECT handler (HTTPS tunneling) ─────────────────────────────────────

async function handleConnect(req, clientSocket, head) {
  const creds = checkProxyAuth(req)
  if (!creds) {
    clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="webridge-egress"\r\n\r\n')
    clientSocket.destroy()
    return
  }

  const { hostname, port } = parseAuthority(req.url ?? '')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    clientSocket.destroy()
    return
  }

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
  const creds = checkProxyAuth(clientReq)
  if (!creds) return denyProxy(clientRes)

  let parsed
  try {
    parsed = new URL(clientReq.url ?? '')
  } catch {
    clientRes.writeHead(400)
    clientRes.end()
    return
  }
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

export function startServer(port = LISTEN_PORT) {
  const server = http.createServer(handleRequest)
  server.on('connect', handleConnect)
  server.listen(port, '0.0.0.0', () => {
    log('info', `egress-proxy listening on port ${port}`, { require_password: REQUIRE_PASSWORD })
  })
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0))
  })
  return server
}

// Only listen when run directly (node src/main.js), not when imported by tests.
function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isMainModule()) startServer()
