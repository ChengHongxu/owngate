import { describe, it, expect } from 'vitest'
import {
  ProxyCredentialStore,
  proxyServerFlag,
  proxyServerFlagWithAuth,
} from '../src/proxy.js'

describe('ProxyCredentialStore', () => {
  it('keeps credentials stable across calls for the same connection', () => {
    const store = new ProxyCredentialStore()
    const first = store.get('con_a')
    const second = store.get('con_a')
    expect(second).toEqual(first)
  })

  it('uses the connection id as the username', () => {
    const store = new ProxyCredentialStore()
    expect(store.get('con_a').username).toBe('con_a')
  })

  it('generates a 32-byte hex password', () => {
    const store = new ProxyCredentialStore()
    expect(store.get('con_a').password).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gives different connections different passwords', () => {
    const store = new ProxyCredentialStore()
    expect(store.get('con_a').password).not.toBe(store.get('con_b').password)
  })

  it('does not hand out a reference to its internal record', () => {
    const store = new ProxyCredentialStore()
    const creds = store.get('con_a')
    creds.password = 'tampered'
    expect(store.get('con_a').password).not.toBe('tampered')
  })

  it('delete clears the credentials', () => {
    const store = new ProxyCredentialStore()
    const before = store.get('con_a')
    store.delete('con_a')
    expect(store.get('con_a').password).not.toBe(before.password)
  })

  it('delete leaves other connections alone', () => {
    const store = new ProxyCredentialStore()
    const kept = store.get('con_b')
    store.delete('con_a')
    expect(store.get('con_b')).toEqual(kept)
  })

  it('basicAuth produces Basic base64(user:pass) that decodes back', () => {
    const store = new ProxyCredentialStore()
    const { username, password } = store.get('con_a')
    const header = store.basicAuth('con_a')

    expect(header.startsWith('Basic ')).toBe(true)
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
    expect(decoded).toBe(`${username}:${password}`)
  })

  it('basicAuth decodes with the proxy’s first-colon split', () => {
    // services/egress-proxy/src/main.js parses the username as everything left
    // of the first ':' — the password must not introduce an earlier split.
    const store = new ProxyCredentialStore()
    const decoded = Buffer.from(
      store.basicAuth('con_a').slice('Basic '.length),
      'base64',
    ).toString('utf8')
    const sep = decoded.indexOf(':')
    expect(decoded.slice(0, sep)).toBe('con_a')
  })
})

describe('proxyServerFlag', () => {
  it('passes the proxy server URL through', () => {
    expect(proxyServerFlag('http://egress:3128')).toBe('http://egress:3128')
  })
})

describe('proxyServerFlagWithAuth', () => {
  it('preserves the scheme and port', () => {
    const url = proxyServerFlagWithAuth({
      proxyServer: 'http://egress:3128',
      username: 'con_a',
      password: 'secret',
    })
    expect(url).toBe('http://con_a:secret@egress:3128')
  })

  it('URL-encodes a password containing @, : and /', () => {
    const url = proxyServerFlagWithAuth({
      proxyServer: 'http://egress:3128',
      username: 'con_a',
      password: 'p@ss:w/rd',
    })
    expect(url).toBe('http://con_a:p%40ss%3Aw%2Frd@egress:3128')

    // The embedded form must round-trip: unescaped delimiters would move the
    // host boundary and send the connection to the wrong place.
    const parsed = new URL(url)
    expect(parsed.hostname).toBe('egress')
    expect(parsed.port).toBe('3128')
    expect(decodeURIComponent(parsed.username)).toBe('con_a')
    expect(decodeURIComponent(parsed.password)).toBe('p@ss:w/rd')
  })

  it('URL-encodes a username containing delimiters', () => {
    const url = proxyServerFlagWithAuth({
      proxyServer: 'http://egress:3128',
      username: 'con a@1:2',
      password: 'secret',
    })
    const parsed = new URL(url)
    expect(parsed.hostname).toBe('egress')
    expect(decodeURIComponent(parsed.username)).toBe('con a@1:2')
  })

  it('works with an https proxy server and a non-default port', () => {
    expect(
      proxyServerFlagWithAuth({
        proxyServer: 'https://proxy.internal:8443',
        username: 'u',
        password: 'p',
      }),
    ).toBe('https://u:p@proxy.internal:8443')
  })

  it('defaults the port from the scheme when the URL omits it', () => {
    expect(
      proxyServerFlagWithAuth({ proxyServer: 'http://egress', username: 'u', password: 'p' }),
    ).toBe('http://u:p@egress:80')
    expect(
      proxyServerFlagWithAuth({ proxyServer: 'https://egress', username: 'u', password: 'p' }),
    ).toBe('https://u:p@egress:443')
  })
})
