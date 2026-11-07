export interface ClientUsage {
  server: string
  mcpUrl: string
  loginCommand: string
  discoverCommands: string
  queryCommand: string
  stdioCommand: string
  listConnectionsCommand: string
  listCapabilitiesCommand: string
  invokeCommand: string
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Public setup examples only. This helper never receives a client token. */
export function clientUsage(serverUrl: string): ClientUsage | undefined {
  let server: string
  try {
    const url = new URL(serverUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    server = url.origin
  } catch { return undefined }
  const authorizationHeader = shellQuote('Authorization: Bearer <客户端令牌>')
  return {
    server,
    mcpUrl: `${server}/mcp`,
    loginCommand: `owngate login --server ${shellQuote(server)}`,
    discoverCommands: "owngate conn\nowngate conn use '<连接名称>'\nowngate cap ls\nowngate cap show '<能力ID>'",
    queryCommand: "owngate query '<能力ID>' --json",
    stdioCommand: 'owngate mcp',
    listConnectionsCommand: `curl ${shellQuote(`${server}/api/connections`)} \\\n  -H ${authorizationHeader}`,
    listCapabilitiesCommand: `curl ${shellQuote(`${server}/api/connections/<连接ID>/capabilities`)} \\\n  -H ${authorizationHeader}`,
    invokeCommand: `curl ${shellQuote(`${server}/api/invoke`)} \\\n  -H ${authorizationHeader} \\\n  -H 'Content-Type: application/json' \\\n  -d '{\n    "connection_id": "<连接ID>",\n    "capability_id": "<能力ID>",\n    "input": {}\n  }'`,
  }
}
