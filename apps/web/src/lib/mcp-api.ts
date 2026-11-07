import { request } from './api'

export interface McpPinnedTool {
  id: string
  client_id: string
  name: string
  connection_id: string
  capability_id: string
  created_at: string
  available: boolean
}
export const mcpApi = {
  list: () => request<{ tools: McpPinnedTool[] }>('/admin/mcp-tools'),
  create: (input: Pick<McpPinnedTool, 'client_id' | 'name' | 'connection_id' | 'capability_id'>) => request<McpPinnedTool>('/admin/mcp-tools', { method: 'POST', body: input }),
  remove: (id: string) => request<{ ok: boolean }>(`/admin/mcp-tools/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
