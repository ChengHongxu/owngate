import { describe, expect, it } from 'vitest'
import { clientUsage } from '../src/lib/client-usage'

describe('public client setup instructions', () => {
  it('uses the current server origin without propagating unrelated paths, queries or fragments', () => {
    const usage = clientUsage('https://owngate.example.com:8443/clients?token=private-query#private-fragment')
    expect(usage?.server).toBe('https://owngate.example.com:8443')
    expect(usage?.mcpUrl).toBe('https://owngate.example.com:8443/mcp')
    expect(usage?.listConnectionsCommand).toContain("'https://owngate.example.com:8443/api/connections'")
    expect(usage?.listCapabilitiesCommand).toContain("'https://owngate.example.com:8443/api/connections/<连接ID>/capabilities'")
    expect(usage?.invokeCommand).toContain("'https://owngate.example.com:8443/api/invoke'")
    expect(JSON.stringify(usage)).not.toContain('private')
    expect(usage?.loginCommand).toBe("owngate login --server 'https://owngate.example.com:8443'")
  })

  it('rejects missing addresses, non HTTP servers and URLs containing embedded credentials', () => {
    for (const address of ['', '/clients', 'javascript:alert(1)', 'file:///tmp/owngate', 'https://user:password@example.com']) {
      expect(clientUsage(address)).toBeUndefined()
    }
    expect(clientUsage('http://localhost:3000')?.mcpUrl).toBe('http://localhost:3000/mcp')
  })

  it('quotes server addresses in shell examples and uses generic connection and capability placeholders', () => {
    const usage = clientUsage("https://a'b.example.com")
    expect(usage?.loginCommand).toContain("'https://a'\\''b.example.com'")
    expect(usage?.listConnectionsCommand).toContain("'https://a'\\''b.example.com/api/connections'")
    expect(usage?.listCapabilitiesCommand).toContain("'https://a'\\''b.example.com/api/connections/<连接ID>/capabilities'")
    expect(usage?.invokeCommand).toContain("'https://a'\\''b.example.com/api/invoke'")
    expect(usage?.discoverCommands).toBe("owngate conn\nowngate conn use '<连接名称>'\nowngate cap ls\nowngate cap show '<能力ID>'")
    expect(usage?.queryCommand).toBe("owngate query '<能力ID>' --json")
    expect(usage?.stdioCommand).toBe('owngate mcp')
    expect(JSON.stringify(usage)).not.toMatch(/account\.balance|bilibili|newapi/)
  })

  it('provides authenticated HTTP discovery and a valid generic invocation body without embedding a token', () => {
    const usage = clientUsage('http://localhost:3000')!
    for (const command of [usage.listConnectionsCommand, usage.listCapabilitiesCommand, usage.invokeCommand]) {
      expect(command).toContain("-H 'Authorization: Bearer <客户端令牌>'")
      expect(command).toContain(' \\\n')
      expect(command).not.toContain('\\n')
    }
    expect(usage.invokeCommand).toContain("-H 'Content-Type: application/json'")
    const body = usage.invokeCommand.match(/-d '([\s\S]+)'$/)?.[1]
    expect(JSON.parse(body!)).toEqual({ connection_id: '<连接ID>', capability_id: '<能力ID>', input: {} })
  })
})
