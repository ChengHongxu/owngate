import { request } from './api'

export interface ExtensionInput { source: string; format: 'manifest' | 'openapi'; id?: string }
export interface ExtensionOperation { id: string; title: string; method: string; path: string; eligible: boolean; reason: string }
export interface ExtensionPreview {
  id: string; title: string; version: string; transport: string; fingerprint: string;
  config: Record<string, unknown>; auth: { type: string; fields?: Record<string, unknown> } | null;
  operations: Array<ExtensionOperation & { status: 'disabled' }>;
  views?: import('@owngate/core').ComparisonView[];
  verification?: import('@owngate/core').VerificationPlan;
}
export interface InstalledExtension {
  id: string; title: string; version: string; transport: string; fingerprint: string; enabled_capabilities: string[];
  operations: ExtensionOperation[]; status: 'installed' | 'unavailable'; error?: string;
}
export const extensionsApi = {
  list: () => request<{ extensions: InstalledExtension[] }>('/admin/extensions'),
  preview: (input: ExtensionInput) => request<ExtensionPreview>('/admin/extensions/preview', { method: 'POST', body: input }),
  install: (input: ExtensionInput & { enabled_capabilities: string[]; preview_fingerprint: string }) => request<InstalledExtension>('/admin/extensions', { method: 'POST', body: input }),
}
export function enabledSelection(preview: ExtensionPreview, selected: string[]): string[] {
  return preview.operations.filter((operation) => operation.eligible && selected.includes(operation.id)).map((operation) => operation.id)
}
export const EXAMPLE_EXTENSION = `connector: my_service
version: 1.0.0
title: 我的服务
access: official_api
config:
  base_url: { type: string, format: uri, required: true, label: 站点网址, default: 'https://example.com' }
auth:
  type: bearer
  fields:
    access_token: { type: string, secret: true, label: 访问令牌 }
http:
  base: '{{config.base_url}}'
  headers:
    Authorization: 'Bearer {{secret.access_token}}'
capabilities:
  - id: account.balance
    title: 账户余额
    description: 读取账户余额
    kind: query
    effect: read
    request: { method: GET, path: /api/balance }
    output:
      balance: { from: $.balance, type: number, unit: USD, sensitivity: financial }
`
