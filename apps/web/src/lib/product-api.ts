import { request, type Connection, type Envelope } from './api'

export interface TaskView {
  id: string; task_id: string; connection_id: string; capability_id: string; status: string;
  created_at: string; started_at?: string; finished_at?: string; attempts: number;
  input: unknown; result: Envelope | null;
  cancellation: null | { state: string; may_continue_remote: boolean; remote_confirmed: false }
}
export interface Proposal {
  id: string; connection_id: string; capability_id: string; normalized_hash: string; status: string;
  input: unknown; result: unknown; target: { label: string; connector_id: string }; effect: string; expires_at: string;
}
export interface Batch { status: string; results: Envelope[]; items?: { source: Envelope['source']; item: unknown }[] }
export const productApi = {
  overview: () => request<{ connections: Pick<Connection, 'id' | 'label' | 'health'>[]; tasks: TaskView[]; pending_proposals: number; alerts: { action: string; target: string; at: string }[]; actions_enabled: false }>('/admin/overview'),
  tasks: () => request<{ tasks: TaskView[] }>('/admin/tasks'),
  task: (id: string) => request<TaskView>(`/admin/tasks/${encodeURIComponent(id)}`),
  taskEvents: (id: string) => request<{ events: { id: number; event: string; at: string; detail: unknown }[] }>(`/admin/tasks/${encodeURIComponent(id)}/events`),
  submitTask: (body: { connection_id: string; capability_id: string; input: unknown }) => request<{ task_id: string; status: string }>('/admin/tasks', { method: 'POST', body }),
  cancelTask: (id: string) => request<TaskView>(`/admin/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  queryMany: (body: { connection_ids?: string[]; capability_id: string; input: unknown }) => request<Batch>('/admin/query', { method: 'POST', body }),
  proposals: () => request<{ proposals: Proposal[] }>('/admin/proposals'),
  approve: (proposal: Proposal) => request<Proposal>(`/admin/proposals/${encodeURIComponent(proposal.id)}/approve`, { method: 'POST', body: { hash: proposal.normalized_hash } }),
  reject: (id: string) => request<Proposal>(`/admin/proposals/${encodeURIComponent(id)}/reject`, { method: 'POST' }),
  pauseActions: () => request<{ paused: boolean }>('/admin/actions/pause', { method: 'POST' }),
  connectionState: (id: string, body: { paused?: boolean; scope?: 'personal' | 'organization'; confirm_organization?: boolean; tags?: string[] }) => request(`/admin/connections/${encodeURIComponent(id)}/state`, { method: 'PATCH', body }),
  audit: (query: { client?: string; connection?: string; before?: string }) => {
    const search = new URLSearchParams()
    if (query.client) search.set('client_id', query.client)
    if (query.connection) search.set('connection_id', query.connection)
    if (query.before) search.set('before', query.before)
    return request<{ entries: { seq: number; action: string; target: string; client_id: string; at: string; detail: unknown; entry_hash: string }[] }>(`/admin/audit?${search}`)
  },
}
