import { Command } from 'commander'
import { CliUsageError } from '../errors.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
  ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema,
  McpError, ErrorCode,
} from '@modelcontextprotocol/sdk/types.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { readConfig } from '../config.js'
import { DEFAULT_TIMEOUT_MS } from '../http.js'
import { durationMs } from './task.js'

/** A transport bridge: all schemas, results and authorization come from server. */
export async function runMcpStdio(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const config = readConfig()
  const endpoint = new URL(`${config.server.replace(/\/$/, '')}/mcp`)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('The MCP server must be an HTTP(S) URL without embedded credentials.')
  }
  const shutdown = new AbortController()
  const remote = new Client({ name: 'owngate-stdio-bridge', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${config.token}` } },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
    fetch: async (url, init) => {
      // Bound response headers without aborting a healthy SSE body after every
      // request deadline. SDK requests retain their own total timeout below.
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), timeoutMs)
      try { return await fetch(url, { ...init, signal: AbortSignal.any([
        shutdown.signal, deadline.signal, ...(init?.signal ? [init.signal] : []),
      ]) }) } finally { clearTimeout(timer) }
    },
  })
  let local: Server | undefined
  let closeStarted = false
  let finished!: () => void
  const stopped = new Promise<void>((resolve) => { finished = resolve })
  const close = async () => {
    if (closeStarted) return
    closeStarted = true
    shutdown.abort()
    await Promise.allSettled([remote.close(), local?.close()])
    finished()
  }
  const stop = () => { void close() }
  process.stdin.once('end', stop)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const options = (signal?: AbortSignal): RequestOptions => ({ timeout: timeoutMs, maxTotalTimeout: timeoutMs,
    signal: signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal })
  const forward = async <T>(request: () => Promise<T>): Promise<T> => {
    try { return await request() }
    catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        throw new McpError(ErrorCode.RequestTimeout, `The remote MCP request exceeded ${timeoutMs} ms`)
      }
      throw new McpError(ErrorCode.InternalError, 'The remote MCP request failed. Check the server and current client grant.')
    }
  }
  try {
    await remote.connect(transport, options())
    if (closeStarted) return
    const capabilities = remote.getServerCapabilities()
    const instructions = remote.getInstructions()
    local = new Server({ name: 'owngate', version: '0.1.0' }, { capabilities: {
      ...(capabilities?.tools ? { tools: { listChanged: Boolean(capabilities.tools.listChanged) } } : {}),
      ...(capabilities?.resources ? { resources: { listChanged: Boolean(capabilities.resources.listChanged) } } : {}),
    }, ...(instructions ? { instructions } : {}) })
    let initialized = false
    let pendingToolsChanged = false, pendingResourcesChanged = false
    const notifyTools = async () => { if (initialized) await local?.sendToolListChanged(); else pendingToolsChanged = true }
    const notifyResources = async () => { if (initialized) await local?.sendResourceListChanged(); else pendingResourcesChanged = true }
    if (capabilities?.tools?.listChanged) remote.setNotificationHandler(ToolListChangedNotificationSchema, notifyTools)
    if (capabilities?.resources?.listChanged) remote.setNotificationHandler(ResourceListChangedNotificationSchema, notifyResources)
    local.oninitialized = () => {
      initialized = true
      if (pendingToolsChanged) void notifyTools().catch(() => {})
      if (pendingResourcesChanged) void notifyResources().catch(() => {})
    }
    local.onclose = stop
    remote.onclose = stop
    if (capabilities?.tools) {
      local.setRequestHandler(ListToolsRequestSchema, (request, extra) => forward(() => remote.listTools(request.params, options(extra.signal))))
      local.setRequestHandler(CallToolRequestSchema, (request, extra) => forward(() => remote.callTool(request.params, undefined, options(extra.signal))))
    }
    if (capabilities?.resources) {
      local.setRequestHandler(ListResourcesRequestSchema, (request, extra) => forward(() => remote.listResources(request.params, options(extra.signal))))
      local.setRequestHandler(ReadResourceRequestSchema, (request, extra) => forward(() => remote.readResource(request.params, options(extra.signal))))
    }
    await local.connect(new StdioServerTransport())
    await stopped
  } catch {
    throw new Error(`Cannot connect to owngate MCP at ${endpoint.origin}. Check the server address and client token.`)
  } finally {
    await close()
    process.stdin.off('end', stop)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

export function createMcpCommand(): Command {
  return new Command('mcp')
  .description('将当前服务器转发为 MCP stdio，供本地客户端使用')
  .option('--transport <transport>', 'Local MCP transport (stdio)', 'stdio')
  .option('--timeout <duration>', 'Maximum time per remote request', '30s')
  .action(async (options: { transport: string; timeout: string }) => {
    if (options.transport !== 'stdio') throw new CliUsageError('本地 MCP 桥接仅支持 stdio。', '使用 owngate mcp；Streamable HTTP 客户端直接连接服务器的 /mcp。')
    await runMcpStdio(durationMs(options.timeout, '--timeout'))
  })

}
