// Egress proxy — design doc §4.4.6
// Allows browser containers to reach the public internet while blocking
// private, loopback, link-local, multicast and other special-purpose addresses
// (IANA registries) to prevent SSRF.
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
// Opt-in: require a non-trivial password in Proxy-Authorization (see checkProxyAuth).
const REQUIRE_PASSWORD = ['1', 'true', 'yes'].includes(
  (process.env['EGRESS_REQUIRE_PASSWORD'] ?? '').toLowerCase(),
)
const MIN_PASSWORD_LENGTH = 16

// ── Blocked IP ranges ──────────────────────────────────────────────────────
// Based on the IANA IPv4 / IPv6 Special-Purpose Address Registries. Ranges
// that are partly globally reachable (192.0.0.0/24, 2001::/32) are blocked
// whole: a browser loading public sites never needs them.

const BLOCKED_IPV4_CIDRS = [
  ['0.0.0.0', 8],         // "this network"; connecting to 0.0.0.0 reaches localhost on Linux
  ['10.0.0.0', 8],        // RFC 1918
  ['100.64.0.0', 10],     // shared address space (CGNAT)
  ['127.0.0.0', 8],       // loopback
  ['169.254.0.0', 16],    // link-local (cloud metadata lives here)
  ['172.16.0.0', 12],     // RFC 1918
  ['192.0.0.0', 24],      // IETF protocol assignments
  ['192.0.2.0', 24],      // TEST-NET-1
  ['192.88.99.0', 24],    // deprecated 6to4 relay anycast
  ['192.168.0.0', 16],    // RFC 1918
  ['198.18.0.0', 15],     // benchmarking
  ['198.51.100.0', 24],   // TEST-NET-2
  ['203.0.113.0', 24],    // TEST-NET-3
  ['224.0.0.0', 4],       // multicast
  ['240.0.0.0', 4],       // reserved
  ['255.255.255.255', 32], // limited broadcast (inside 240/4, listed for clarity)
]

// IPv4-mapped addresses (::ffff:0:0/96) are not in this table: isBlockedAddress
// unwraps them and applies the IPv4 rules, because a dual-stack socket
// connecting to ::ffff:a.b.c.d reaches exactly a.b.c.d.
//
// Translation prefixes that embed an IPv4 address (IPv4-compatible ::/96,
// SIIT ::ffff:0:0:0/96, NAT64 64:ff9b::/96 and 64:ff9b:1::/48, Teredo
// 2001::/32, 6to4 2002::/16) are blocked as whole prefixes instead of
// extracting the embedded IPv4 and checking it. Extraction is easy to get
// wrong (Teredo stores the address XOR-ed, local NAT64 prefixes can use other
// prefix lengths), and with a matching route these prefixes lead to internal
// IPv4 hosts. Normal browsing of public sites never uses them.
const BLOCKED_IPV6_CIDRS = [
  ['::', 128],            // unspecified
  ['::1', 128],           // loopback
  ['::', 96],             // IPv4-compatible (deprecated), e.g. ::127.0.0.1
  ['::ffff:0:0:0', 96],   // IPv4-translated (SIIT), e.g. ::ffff:0:127.0.0.1
  ['64:ff9b::', 96],      // NAT64 well-known prefix
  ['64:ff9b:1::', 48],    // NAT64 local-use prefix
  ['100::', 64],          // discard-only
  ['2001::', 32],         // Teredo
  ['2001:2::', 48],       // benchmarking
  ['2001:10::', 28],      // ORCHID (deprecated)
  ['2001:20::', 28],      // ORCHIDv2
  ['2001:db8::', 32],     // documentation
  ['2002::', 16],         // 6to4
  ['3fff::', 20],         // documentation
  ['5f00::', 16],         // SRv6 SIDs
  ['fc00::', 7],          // unique local
  ['fe80::', 10],         // link-local
  ['fec0::', 10],         // site-local (deprecated)
  ['ff00::', 8],          // multicast
]

// Only 2000::/3 is allocated for global unicast. Anything outside it that the
// table above does not name (e.g. a future special-purpose prefix) is blocked.
const IPV6_GLOBAL_UNICAST = ['2000::', 3]

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

/** 8 16-bit groups as one 128-bit BigInt. */
function groupsToBigInt(groups) {
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n)
}

/** [network, mask] pair for a 128-bit prefix match. */
function ipv6Prefix(cidr, prefix) {
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix)
  return [groupsToBigInt(ipv6Groups(cidr)) & mask, mask]
}

const IPV6_RANGES = BLOCKED_IPV6_CIDRS.map(([cidr, prefix]) => ipv6Prefix(cidr, prefix))
const IPV6_GLOBAL = ipv6Prefix(...IPV6_GLOBAL_UNICAST)

function inIPv6Range(value, [net6, mask]) {
  return (value & mask) === net6
}

/**
 * True when the address must not be reached through the proxy.
 * Anything that is not a valid IPv4/IPv6 literal is treated as blocked.
 * IPv4-mapped IPv6 (::ffff:0:0/96) is unwrapped and checked under IPv4 rules;
 * any other IPv6 address must lie in 2000::/3 and outside BLOCKED_IPV6_CIDRS.
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
  const value = groupsToBigInt(g)
  if (IPV6_RANGES.some((range) => inIPv6Range(value, range))) return true
  return !inIPv6Range(value, IPV6_GLOBAL)
}

function log(level, msg, extra = {}) {
  if ((process.env['LOG_LEVEL'] ?? 'info') === 'error' && level !== 'error') return
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

const defaultResolver = {
  resolve4: (host) => dns.resolve4(host),
  resolve6: (host) => dns.resolve6(host),
}

/**
 * Resolve a hostname and decide whether the proxy may connect to it.
 * Returns { allowed, ip, reason? }. When allowed, callers must connect to
 * `ip` (the address that was checked) and never re-resolve the name, or a
 * DNS rebinding answer could slip in between the check and the connect.
 *
 * `resolver` defaults to node:dns/promises; tests inject a fake with the
 * same resolve4 / resolve6 shape.
 */
export async function resolveAndCheck(hostname, resolver = defaultResolver) {
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
  const [v4, v6] = await Promise.allSettled([
    (async () => resolver.resolve4(host))(),
    (async () => resolver.resolve6(host))(),
  ])
  const addrs4 = v4.status === 'fulfilled' && Array.isArray(v4.value) ? v4.value : []
  const addrs6 = v6.status === 'fulfilled' && Array.isArray(v6.value) ? v6.value : []
  const addrs = [...addrs4, ...addrs6]
  if (addrs.length === 0) return { allowed: false, ip: null, reason: 'DNS resolution failed' }
  for (const ip of addrs) {
    if (isBlockedAddress(ip)) {
      return { allowed: false, ip, reason: `resolved to blocked IP ${ip}` }
    }
  }
  // Prefer IPv4 when available (A answers come first)
  return { allowed: true, ip: addrs[0] }
}

// ── Header sanitizing (RFC 9110 §7.6.1) ───────────────────────────────────

// Hop-by-hop fields, plus the proxy's own credentials. Proxy-Authorization is
// meant for this proxy only; forwarding it would leak the connection secret
// to the target site.
const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
])

// Message framing is handled by Node on each side; these are never removed
// just because a client lists them in Connection (that would desync the body).
const FRAMING = new Set(['host', 'content-length', 'transfer-encoding'])

/**
 * Copy a parsed header object without hop-by-hop fields, Proxy-Authorization,
 * or any field named in Connection / Proxy-Connection.
 *
 * Transfer-Encoding is kept so Node re-frames the body: Node's parser has
 * already removed the incoming chunked framing, and an outgoing message with
 * a "chunked" Transfer-Encoding header is chunk-encoded again by Node.
 * Repeated "chunked" tokens are collapsed to one at the end so the next hop
 * decodes the body exactly once.
 */
export function sanitizeHeaders(headers) {
  const drop = new Set(HOP_BY_HOP)
  for (const field of ['connection', 'proxy-connection']) {
    const value = headers[field]
    const list = Array.isArray(value) ? value.join(',') : value ?? ''
    for (const token of list.split(',')) {
      const name = token.trim().toLowerCase()
      if (name && !FRAMING.has(name)) drop.add(name)
    }
  }
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || drop.has(name.toLowerCase())) continue
    out[name] = value
  }
  const te = out['transfer-encoding']
  if (te !== undefined) {
    const codings = (Array.isArray(te) ? te.join(',') : te)
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c && c.toLowerCase() !== 'chunked')
    out['transfer-encoding'] = [...codings, 'chunked'].join(', ')
    // Node's parser rejects TE + Content-Length; drop it anyway so the body
    // length can never be stated two ways.
    delete out['content-length']
  }
  return out
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

async function handleConnect(opts, req, clientSocket, head) {
  const creds = checkProxyAuth(req, opts.requirePassword)
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

  const check = await opts.check(hostname)
  if (!check.allowed) {
    log('warn', 'CONNECT blocked', { hostname, reason: check.reason, connection_id: creds.username })
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    clientSocket.destroy()
    return
  }

  log('info', 'CONNECT', { hostname, port, connection_id: creds.username })

  // Connect to the checked address only; never re-resolve the hostname.
  const serverSocket = net.connect(port, check.ip, () => {
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

async function handleRequest(opts, clientReq, clientRes) {
  const creds = checkProxyAuth(clientReq, opts.requirePassword)
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

  const check = await opts.check(hostname)
  if (!check.allowed) {
    log('warn', 'HTTP blocked', { hostname, reason: check.reason, connection_id: creds.username })
    clientRes.writeHead(403)
    clientRes.end()
    return
  }

  log('info', 'HTTP', { hostname, port, connection_id: creds.username })

  const options = {
    // Connect to the checked address only; never re-resolve the hostname.
    hostname: check.ip,
    port,
    path: parsed.pathname + parsed.search,
    method: clientReq.method,
    // parsed.host keeps a non-default port, as Host requires (RFC 9112 §3.2).
    headers: { ...sanitizeHeaders(clientReq.headers), host: parsed.host },
  }

  const proxyReq = http.request(options, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode ?? 200, sanitizeHeaders(proxyRes.headers))
    proxyRes.pipe(clientRes)
  })

  proxyReq.on('error', (err) => {
    log('error', 'proxy request error', { err: err.message })
    // After the response has started, a second writeHead would throw and
    // take the process down; cut the client connection instead.
    if (clientRes.headersSent) {
      clientRes.destroy()
      return
    }
    clientRes.writeHead(502)
    clientRes.end()
  })
  clientRes.on('close', () => {
    if (!clientRes.writableFinished) proxyReq.destroy()
  })

  clientReq.pipe(proxyReq)
}

// ── Server ─────────────────────────────────────────────────────────────────

/** Log and drop a handler failure instead of letting the rejection kill the process. */
function guard(handler, onError) {
  return (...args) => {
    handler(...args).catch((err) => {
      log('error', 'handler failed', { err: err instanceof Error ? err.message : String(err) })
      onError(...args)
    })
  }
}

/**
 * Build the proxy server without listening.
 * `check` defaults to resolveAndCheck; tests inject one to reach a local
 * target, which the default check always blocks.
 */
export function createProxyServer({ check = resolveAndCheck, requirePassword = REQUIRE_PASSWORD } = {}) {
  const opts = { check, requirePassword }
  const server = http.createServer(guard(
    (req, res) => handleRequest(opts, req, res),
    (_req, res) => {
      if (res.headersSent) res.destroy()
      else { res.writeHead(500); res.end() }
    },
  ))
  server.on('connect', guard(
    (req, socket, head) => handleConnect(opts, req, socket, head),
    (_req, socket) => socket.destroy(),
  ))
  return server
}

export function startServer(port = LISTEN_PORT) {
  const server = createProxyServer()
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
