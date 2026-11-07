import { readConfig } from './config.js'
import { CliResponseError, CliUsageError } from './errors.js'
import { apiCall, type ApiCallOptions } from './http.js'

/** A connection visible through the current client token; never contains config. */
export interface GrantedConnection {
  id: string
  connector_id: string
  label: string
  granted: string[]
}

export class ConnectionSelectionError extends CliUsageError {
  constructor(message: string, nextStep: string) {
    super(message, nextStep)
    this.name = 'ConnectionSelectionError'
  }
}

export async function listGrantedConnections(options: ApiCallOptions = {}): Promise<GrantedConnection[]> {
  const data = await apiCall('/api/connections', 'GET', undefined, options)
  const connections = typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)['connections'] : undefined
  if (!Array.isArray(connections) || !connections.every((value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const item = value as Record<string, unknown>
    return typeof item['id'] === 'string' && item['id'] !== '' && typeof item['label'] === 'string'
      && typeof item['connector_id'] === 'string' && item['connector_id'] !== ''
      && Array.isArray(item['granted']) && item['granted'].every((grant: unknown) => typeof grant === 'string')
  })) throw new CliResponseError('服务器未返回有效的连接列表。', '检查服务器地址是否指向 owngate；运行 owngate config show 查看当前地址。')
  return connections as GrantedConnection[]
}

function choices(connections: GrantedConnection[]): string {
  const visible = connections.slice(0, 6).map((connection) => `${JSON.stringify(connection.label)} (${connection.connector_id}, id:${connection.id})`)
  return visible.join('; ') + (connections.length > visible.length ? '; …' : '')
}

function selectUnique(selector: string, matches: GrantedConnection[]): GrantedConnection | undefined {
  if (matches.length > 1) {
    throw new ConnectionSelectionError(
      `连接 ${JSON.stringify(selector)} 对应多个已授权连接。`,
      `使用完整 ID 选择一个连接：${choices(matches)}。`,
    )
  }
  return matches[0]
}

/** Resolve against fresh grants each time; an ambiguous name never submits an invocation. */
export async function resolveConnection(selector?: string, options: ApiCallOptions = {}): Promise<GrantedConnection> {
  if (selector !== undefined && !selector.trim()) throw new ConnectionSelectionError('连接名称或 ID 不能为空。', '运行 owngate conn ls 查看名称，或省略连接以使用默认值。')
  const connections = await listGrantedConnections(options)
  if (selector === undefined) {
    const defaultId = (options.config ?? readConfig()).defaultConnection
    if (defaultId) {
      const connection = connections.find((item) => item.id === defaultId)
      if (connection) return connection
      throw new ConnectionSelectionError(
        '默认连接已不存在或未授权给当前客户端。',
        '运行 `owngate conn ls` 查看，再用 `owngate conn use <名称>` 选择；也可用 `owngate conn use --clear` 清除默认值。',
      )
    }
    if (connections.length === 1) return connections[0]!
    if (connections.length > 1) {
      throw new ConnectionSelectionError(
        '当前有多个连接，请选择一个。',
        `运行 \`owngate conn use <名称>\` 设置默认值，或在命令中指定名称。可选连接：${choices(connections)}。`,
      )
    }
  }
  if (connections.length === 0) {
    throw new ConnectionSelectionError(
      '当前客户端尚未获准访问任何连接。',
      '在后台「客户端」中授予连接权限，再运行 `owngate conn ls`。',
    )
  }

  const value = selector!
  let selected: GrantedConnection | undefined
  if (value.startsWith('id:')) {
    selected = connections.find((connection) => connection.id === value.slice(3))
  } else if (value.startsWith('name:')) {
    selected = selectUnique(value, connections.filter((connection) => connection.label.toLowerCase() === value.slice(5).toLowerCase()))
  } else if (value.startsWith('connector:')) {
    selected = selectUnique(value, connections.filter((connection) => connection.connector_id.toLowerCase() === value.slice(10).toLowerCase()))
  } else {
    selected = connections.find((connection) => connection.id === value)
    selected ??= selectUnique(value, connections.filter((connection) => connection.label.toLowerCase() === value.toLowerCase()))
    selected ??= selectUnique(value, connections.filter((connection) => connection.connector_id.toLowerCase() === value.toLowerCase()))
    if (!selected && value.length >= 4) selected = selectUnique(value, connections.filter((connection) => connection.id.startsWith(value)))
  }
  if (selected) return selected
  throw new ConnectionSelectionError(
    `没有匹配 ${JSON.stringify(value)} 的已授权连接。`,
    '运行 `owngate conn ls` 查看；可用完整名称、连接器类型、完整 ID 或至少四位的唯一 ID 前缀。显式格式：name:<名称>、connector:<类型>、id:<完整ID>。',
  )
}
