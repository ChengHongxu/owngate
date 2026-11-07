import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import { compileExtension, type ExtensionDraft, type ExtensionOperation } from '@owngate/connector-runtime';
import type { CompiledConnector } from '@owngate/connector-runtime';
import type { ComparisonView, VerificationPlan } from '@owngate/core';
import type { ConnectorRegistry } from '../registry.js';

export interface ExtensionInput { source: string; format: 'manifest' | 'openapi'; id?: string }
export interface ExtensionPreview {
  id: string; title: string; version: string; transport: string; fingerprint: string;
  config: Record<string, unknown>; auth: { type: string; fields?: Record<string, unknown> } | null;
  operations: Array<ExtensionOperation & { status: 'disabled' }>;
  views?: ComparisonView[];
  verification?: VerificationPlan;
}
export interface InstalledExtension {
  id: string; title: string; version: string; transport: string; fingerprint: string;
  enabled_capabilities: string[]; operations: ExtensionOperation[]; status: 'installed' | 'unavailable'; error?: string;
}
interface StoredExtension {
  kind: 'owngate_extension'; manifest: Record<string, unknown>; enabled_capabilities: string[]; fingerprint: string;
}
interface ExtensionDb {
  rawQuery: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  rawRun: (sql: string, params?: unknown[]) => Promise<unknown>;
}
export interface ExtensionDeps {
  db: ExtensionDb;
  registry: Pick<ConnectorRegistry, 'getManifest' | 'register'>;
  invalidate: () => void | Promise<void>;
  audit: (entry: { action: string; target?: string; detail?: unknown }) => void | Promise<void>;
}
export class ExtensionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const validator = new Ajv({ strict: false, validateFormats: false, allErrors: false });
function fingerprint(draft: ExtensionDraft): string {
  return createHash('sha256').update(JSON.stringify(draft.manifest)).digest('hex');
}
function compile(input: ExtensionInput): ExtensionDraft {
  let draft: ExtensionDraft;
  try {
    draft = compileExtension(input.source, input.format, input.id);
    for (const capability of Object.values(draft.compiled.capabilities)) {
      if (!validator.validateSchema(capability.input) || !validator.validateSchema(capability.output)) throw new Error('输入或输出 schema 无效');
      validator.compile(capability.input); validator.compile(capability.output);
    }
  } catch (error) {
    throw new ExtensionError('INVALID_EXTENSION', error instanceof Error ? error.message : '扩展定义无效');
  }
  return draft;
}
function select(draft: ExtensionDraft, ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length > 50 || !ids.every((id) => typeof id === 'string')) throw new ExtensionError('INVALID_PARAMS', '请选择最多 50 个查询能力');
  const selected = [...new Set(ids as string[])];
  const allowed = new Set(draft.operations.filter((operation) => operation.eligible).map((operation) => operation.id));
  if (selected.some((id) => !allowed.has(id))) throw new ExtensionError('CAPABILITY_NOT_ELIGIBLE', '只能启用预览中允许的 GET 只读查询；写操作和需要适配器的能力保持禁用');
  return selected;
}
function activate(compiled: CompiledConnector, selected: string[]): void {
  for (const capability of Object.values(compiled.capabilities)) {
    capability.support = selected.includes(capability.id)
      ? { status: 'unverified' }
      : { status: 'disabled', reason: '导入时未启用；写操作始终禁用' };
  }
}
function installed(draft: ExtensionDraft, selected: string[]): InstalledExtension {
  return { id: draft.id, title: draft.title, version: draft.version, transport: draft.compiled.transport,
    fingerprint: fingerprint(draft), enabled_capabilities: selected, operations: draft.operations, status: 'installed' };
}

export class ExtensionService {
  private readonly extensions = new Map<string, InstalledExtension>();
  private installing: Promise<void> = Promise.resolve();
  constructor(private readonly deps: ExtensionDeps) {}

  /** Called after built-ins load, before connection state is restored. */
  async init(): Promise<void> {
    const rows = await this.deps.db.rawQuery('SELECT id,title,version,transport,manifest FROM connectors ORDER BY id');
    for (const raw of rows) {
      const row = raw as { id: string; title: string; version: string; transport: string; manifest: string };
      let value: unknown;
      try { value = JSON.parse(row.manifest); } catch { continue; }
      if (typeof value !== 'object' || value === null || (value as Record<string, unknown>)['kind'] !== 'owngate_extension') continue;
      // A newer release may introduce a built-in using an old extension ID.
      // Refuse startup before connection restoration rather than attach its
      // existing credentials/configuration to that unrelated implementation.
      if (this.deps.registry.getManifest(row.id)) throw new ExtensionError('EXTENSION_BUILTIN_CONFLICT', `扩展 ${row.id} 与内置连接器 ID 冲突，启动已停止；请先迁移该扩展及其连接到新 ID`, 409);
      try {
        const stored = value as StoredExtension;
        const draft = compile({ format: 'manifest', source: JSON.stringify(stored.manifest) });
        if (draft.id !== row.id || fingerprint(draft) !== stored.fingerprint) throw new Error('扩展内容或指纹不一致');
        const selected = select(draft, stored.enabled_capabilities);
        activate(draft.compiled, selected); this.deps.registry.register(draft.id, draft.compiled);
        this.extensions.set(draft.id, installed(draft, selected));
      } catch {
        this.extensions.set(row.id, { id: row.id, title: row.title, version: row.version, transport: row.transport,
          fingerprint: '', enabled_capabilities: [], operations: [], status: 'unavailable', error: '定义无效、内容已变更或 ID 与内置连接器冲突，未加载扩展能力' });
      }
    }
  }
  list(): InstalledExtension[] { return [...this.extensions.values()].map((value) => structuredClone(value)); }
  preview(input: ExtensionInput): ExtensionPreview {
    const draft = compile(input);
    return { id: draft.id, title: draft.title, version: draft.version, transport: draft.compiled.transport, fingerprint: fingerprint(draft),
      config: draft.compiled.config ?? {}, auth: draft.compiled.auth ?? null, operations: draft.operations.map((operation) => ({ ...operation, status: 'disabled' })),
      ...(draft.compiled.views !== undefined ? { views: draft.compiled.views } : {}),
      ...(draft.compiled.verification !== undefined ? { verification: draft.compiled.verification } : {}) };
  }
  async install(input: ExtensionInput & { enabled_capabilities: string[]; preview_fingerprint: string }): Promise<InstalledExtension> {
    let release!: () => void;
    const previous = this.installing; this.installing = new Promise<void>((done) => { release = done; });
    await previous;
    try {
      const draft = compile(input); const hash = fingerprint(draft);
      if (input.preview_fingerprint !== hash) throw new ExtensionError('PREVIEW_CHANGED', '内容已变更，请重新预览并选择要启用的查询', 409);
      const selected = select(draft, input.enabled_capabilities);
      if (this.deps.registry.getManifest(draft.id) || (await this.deps.db.rawQuery('SELECT id FROM connectors WHERE id=?', [draft.id])).length) throw new ExtensionError('CONNECTOR_EXISTS', '连接器 ID 已存在；当前版本锁定，请使用新的 ID 安装', 409);
      const stored: StoredExtension = { kind: 'owngate_extension', manifest: draft.manifest, enabled_capabilities: selected, fingerprint: hash };
      // Plain INSERT preserves the first accepted version even if another
      // server-side operation has created the same ID since the check above.
      try { await this.deps.db.rawRun('INSERT INTO connectors(id,version,title,transport,manifest) VALUES(?,?,?,?,?)', [draft.id, draft.version, draft.title, draft.compiled.transport, JSON.stringify(stored)]); }
      catch (error) {
        if ((await this.deps.db.rawQuery('SELECT id FROM connectors WHERE id=?', [draft.id])).length) throw new ExtensionError('CONNECTOR_EXISTS', '连接器 ID 已存在，请使用新的 ID 安装', 409);
        throw error;
      }
      activate(draft.compiled, selected); this.deps.registry.register(draft.id, draft.compiled);
      const result = installed(draft, selected); this.extensions.set(draft.id, result);
      await this.deps.invalidate();
      await this.deps.audit({ action: 'extension.installed', target: draft.id, detail: { version: draft.version, fingerprint: hash, enabled_capabilities: selected } });
      return structuredClone(result);
    } finally { release(); }
  }
}
