// Per-connection egress proxy credentials (design §4.4.6):
// username = connection id, password = per-connection random secret.
//
// The egress-proxy (services/egress-proxy/src/main.js) demands
// `Proxy-Authorization: Basic base64(user:pass)` and keys its per-connection
// rules off that username, so a browser that reaches the network without these
// credentials is refused with 407. Design §4.4.1 requires all browser egress to
// pass through that proxy — hence these modules exist.

import { randomBytes } from 'node:crypto'

export interface ProxyConfig {
  /** e.g. 'http://egress:3128' */
  proxyServer: string
  username: string
  password: string
}

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
}

/**
 * Per-process credential store, keyed by connection id.
 *
 * Credentials are generated lazily on first use and kept in memory until the
 * connection is deleted, so a browser that is closed (idle timeout, crash) and
 * relaunched presents the same identity to the proxy and keeps whatever
 * per-connection state the proxy holds for it.
 */
export class ProxyCredentialStore {
  private readonly entries = new Map<string, { username: string; password: string }>()

  /**
   * Returns the credentials for a connection, generating them on first use.
   * Password is 32 random bytes hex. Stable for the lifetime of the process so a
   * reconnecting browser keeps the same identity at the proxy.
   */
  get(connectionId: string): { username: string; password: string } {
    const existing = this.entries.get(connectionId)
    if (existing) return { ...existing }

    // The proxy splits the decoded Basic credential at the first ':'; the left
    // half is the identity, so the username must be the connection id verbatim.
    const creds = { username: connectionId, password: randomBytes(32).toString('hex') }
    this.entries.set(connectionId, creds)
    return { ...creds }
  }

  /** Remove credentials when a connection is deleted. */
  delete(connectionId: string): void {
    this.entries.delete(connectionId)
  }

  /** Authorization header value for testing/diagnostics. */
  basicAuth(connectionId: string): string {
    const { username, password } = this.get(connectionId)
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  }
}

/**
 * Build the Chromium --proxy-server flag value from a proxy server URL.
 *
 * Returns the URL unchanged (whitespace trimmed). It carries no credentials:
 * Chromium rejects credentials in --proxy-server outright — passing
 * `http://user:pass@host:port` makes it discard the proxy and fail requests
 * with ERR_NO_SUPPORTED_PROXIES (verified against the bundled Chromium 1248).
 * Supply credentials through Playwright's `proxy: { server, username, password }`
 * launch option instead, which answers the 407 challenge via CDP; see
 * BrowserPool. Never build an auth-bearing flag string for --proxy-server.
 */
export function proxyServerFlag(proxyServer: string): string {
  return proxyServer.trim()
}

/**
 * Server URL with credentials embedded in the userinfo section, for contexts
 * that accept them (tests, diagnostics, proxy-side tooling).
 *
 *   http://<urlencoded user>:<urlencoded pass>@<host>:<port>
 *
 * Encoding both halves is load-bearing: an unescaped `@`, `:`, or `/` in the
 * password would otherwise be parsed as host/port/path delimiters and silently
 * redirect the connection.
 *
 * NOT a valid --proxy-server value — see proxyServerFlag.
 */
export function proxyServerFlagWithAuth(cfg: ProxyConfig): string {
  const url = new URL(cfg.proxyServer)
  const port = url.port || DEFAULT_PORTS[url.protocol] || '80'
  const user = encodeURIComponent(cfg.username)
  const pass = encodeURIComponent(cfg.password)
  return `${url.protocol}//${user}:${pass}@${url.hostname}:${port}`
}
