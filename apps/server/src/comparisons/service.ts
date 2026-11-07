import { err, fail, validateCapabilityInput, type Capability, type ComparisonView, type Connection, type InvokeRequest, type JSONSchema, type ResultEnvelope } from '@owngate/core';
import { defaultInput, parseStaticPath, readStaticPath, schemaAtPath } from '@owngate/connector-runtime';
import type { MonitorDb } from '../monitors/types.js';

export interface ComparisonLink { connection_id: string; view_id: string; item_id: string; target_connection_id: string; created_at: string }
export interface ComparisonRow {
  item_id: string;
  label: string;
  source_value: { value: number | null; unit: string; updated_at: string | null };
  target_connection_id: string | null;
  target: ResultEnvelope | null;
  comparison: { status: 'comparable' | 'unlinked' | 'unknown_unit' | 'unavailable'; unit?: string; difference?: number; reason: string };
}
export interface ComparisonResult { outcome: 'success' | 'partial' | 'error'; source: ResultEnvelope; rows: ComparisonRow[] }
export interface ComparisonDeps {
  db: Pick<MonitorDb, 'rawQuery' | 'rawRun'>;
  getConnection: (id: string) => Connection | undefined;
  getView: (connectionId: string, viewId: string) => ComparisonView | undefined;
  getCapability: (connectionId: string, capabilityId: string) => Capability | undefined;
  /** Runs once through the shared verifier and the normal authorized boundary. */
  invoke: (request: InvokeRequest, userId: string) => Promise<ResultEnvelope>;
  audit: (entry: { action: string; target?: string; detail?: unknown }) => void | Promise<void>;
}
export class ComparisonError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const MAX_ITEMS = 100;
const MAX_RUN_MS = 60_000;
const SECRET_KEY = /^(?:password|passwd|secret|token|.*_token|.*_secret|api[_-]?key|authorization|cookie|set-cookie)$/i;
const types = (schema: JSONSchema): unknown[] => Array.isArray(schema['type']) ? schema['type'].filter(type => type !== 'null') : [schema['type']];
const numeric = (schema: JSONSchema | undefined): boolean => !!schema && types(schema).length > 0 && types(schema).every(type => type === 'number' || type === 'integer');
const protectedSchema = (schema: JSONSchema): boolean => schema['x-secret'] === true || schema['writeOnly'] === true || schema['x-sensitivity'] === 'secret';

function visibleSchema(root: JSONSchema, path: string): JSONSchema | undefined {
  let current: JSONSchema | undefined = root;
  if (protectedSchema(root)) return undefined;
  for (const part of parseStaticPath(path)) {
    if (SECRET_KEY.test(part)) return undefined;
    current = schemaAtPath(current, part);
    if (!current || protectedSchema(current)) return undefined;
  }
  return current;
}
function identity(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? String(value) : undefined;
  if (typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\r\n\0]/.test(value)) return value;
  return undefined;
}
function routeIdentity(value: string, schema: JSONSchema): string | number {
  const allowed = types(schema);
  // An ambiguous union must not turn a distinct string ID into a number.
  if (allowed.length !== 1) throw new ComparisonError('INVALID_PARAMS', '记录 ID 类型不明确');
  const parsed = allowed[0] === 'string' ? value : ['number', 'integer'].includes(String(allowed[0])) ? Number(value) : undefined;
  if (identity(parsed) !== value || (allowed[0] === 'integer' && !Number.isInteger(parsed))) throw new ComparisonError('INVALID_PARAMS', '记录 ID 无效或不是规范格式');
  return parsed as string | number;
}
function withInput(schema: JSONSchema, path: string, value: unknown): unknown {
  const parts = parseStaticPath(path);
  if (!parts.length) return value;
  const input = structuredClone(defaultInput({}, schema));
  let current = input;
  for (const part of parts.slice(0, -1)) {
    const old = current[part];
    if (!old || typeof old !== 'object' || Array.isArray(old)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
  return input;
}
/** Any hidden/unknown ancestor makes a descendant unavailable as well. */
function visibleValue(envelope: ResultEnvelope, path: string): unknown {
  const root = envelope.fields['$'];
  if (root && root.status !== 'ok') return undefined;
  const parts = path === '$' ? [] : path.replace(/^\$\./, '').split('.');
  for (let i = 1; i <= parts.length; i++) {
    const key = parts.slice(0, i).join('.');
    const meta = envelope.fields[key];
    if (meta && meta.status !== 'ok') return undefined;
    const bracket = key.replace(/(^|\.)(\d+)(?=\.|$)/g, '[$2]');
    const indexed = envelope.fields[bracket];
    if (indexed && indexed.status !== 'ok') return undefined;
  }
  let current: unknown = envelope.data;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
function time(value: unknown, format: ComparisonView['source']['updated_at_format']): string | null {
  if (format === 'unix_seconds' ? typeof value !== 'number' || !Number.isFinite(value) || value <= 0 : typeof value !== 'string' || !value.trim()) return null;
  const stamp = new Date(format === 'unix_seconds' ? (value as number) * 1000 : value as string);
  return Number.isFinite(stamp.getTime()) ? stamp.toISOString() : null;
}

export class ComparisonService {
  constructor(private readonly deps: ComparisonDeps) {}

  private capability(connectionId: string, capabilityId: string): Capability {
    const connection = this.deps.getConnection(connectionId);
    const capability = this.deps.getCapability(connectionId, capabilityId);
    const state = connection?.capability_states[capabilityId] ?? capability?.support;
    if (!connection || connection.paused || !capability || capability.kind !== 'query' || capability.effect !== 'read' || !state || ['disabled', 'unsupported'].includes(state.status)) {
      throw new ComparisonError('PERMISSION_DENIED', '当前连接没有此视图所需的只读能力', 403);
    }
    return capability;
  }
  private context(id: string, viewId: string) {
    const connection = this.deps.getConnection(id);
    if (!connection) throw new ComparisonError('CONNECTION_NOT_FOUND', '连接不存在', 404);
    const view = this.deps.getView(id, viewId);
    if (!view) throw new ComparisonError('VIEW_NOT_FOUND', '比较视图不存在', 404);
    const source = this.capability(id, view.source.capability);
    const detail = this.capability(id, view.detail.capability);
    const array = visibleSchema(source.output, view.source.items);
    const row = array?.['items'];
    const rowSchema = row && typeof row === 'object' && !Array.isArray(row) ? row as JSONSchema : undefined;
    if (!array || !types(array).includes('array') || !rowSchema || protectedSchema(rowSchema) ||
      !visibleSchema(rowSchema, view.source.id) || !numeric(visibleSchema(rowSchema, view.source.value)) || !visibleSchema(rowSchema, view.source.updated_at) ||
      (view.source.label && !visibleSchema(rowSchema, view.source.label)) || !visibleSchema(detail.output, view.detail.id)) {
      throw new ComparisonError('INVALID_VIEW', '比较视图引用了未声明或受保护的数据字段', 403);
    }
    return { connection, view, source, detail, rowSchema };
  }
  private target(id: string, view: ComparisonView, targetId: string): Capability {
    if (id === targetId || !this.deps.getConnection(targetId)) throw new ComparisonError('INVALID_TARGET', '请选择另一个现有连接');
    const capability = this.capability(targetId, view.target.capability);
    if (!numeric(visibleSchema(capability.output, view.target.value)) || validateCapabilityInput(capability, defaultInput({}, capability.input))) {
      throw new ComparisonError('INVALID_TARGET', '目标连接没有声明可读取的数值字段，或查询还需要额外参数');
    }
    return capability;
  }
  async listLinks(id: string, viewId: string): Promise<ComparisonLink[]> {
    this.context(id, viewId);
    return this.deps.db.rawQuery('SELECT connection_id,view_id,item_id,target_connection_id,created_at FROM comparison_links WHERE connection_id=? AND view_id=? ORDER BY item_id', [id, viewId]) as Promise<ComparisonLink[]>;
  }
  async setLink(id: string, viewId: string, itemId: string, targetId: string, userId: string): Promise<ComparisonLink> {
    const { connection, view, source, detail, rowSchema } = this.context(id, viewId);
    const targetCapability = this.target(id, view, targetId);
    const targetConnection = this.deps.getConnection(targetId)!;
    const targetConfig = JSON.stringify(targetConnection.config);
    const value = routeIdentity(itemId, visibleSchema(rowSchema, view.source.id)!);
    const input = withInput(detail.input, view.detail.input, value);
    if (validateCapabilityInput(detail, input)) throw new ComparisonError('INVALID_PARAMS', '记录 ID 不符合详情查询参数');
    const config = JSON.stringify(connection.config);
    const response = await this.deps.invoke({ connection_id: id, capability_id: view.detail.capability, input, no_cache: true }, userId);
    const responseId = visibleValue(response, view.detail.id);
    if (response.outcome === 'error' || typeof responseId !== typeof value || responseId !== value) throw new ComparisonError('ITEM_NOT_VERIFIED', '详情查询未确认对应记录，未保存关联', 409);
    const latest = this.context(id, viewId);
    if (this.target(id, latest.view, targetId) !== targetCapability || this.deps.getConnection(targetId) !== targetConnection || JSON.stringify(targetConnection.config) !== targetConfig || latest.connection !== connection || latest.view !== view || latest.source !== source || latest.detail !== detail || JSON.stringify(connection.config) !== config) throw new ComparisonError('CONNECTION_CHANGED', '连接或视图已改变，请重新确认记录', 409);
    await this.deps.db.rawRun('INSERT INTO comparison_links(connection_id,view_id,item_id,target_connection_id) VALUES(?,?,?,?) ON CONFLICT(connection_id,view_id,item_id) DO UPDATE SET target_connection_id=excluded.target_connection_id', [id, viewId, itemId, targetId]);
    await this.deps.audit({ action: 'comparison.link_saved', target: id, detail: { view_id: viewId, item_id: itemId, target_connection_id: targetId } });
    return (await this.listLinks(id, viewId)).find(link => link.item_id === itemId)!;
  }
  async deleteLink(id: string, viewId: string, itemId: string): Promise<void> {
    const { view, rowSchema } = this.context(id, viewId);
    routeIdentity(itemId, visibleSchema(rowSchema, view.source.id)!);
    await this.deps.db.rawRun('DELETE FROM comparison_links WHERE connection_id=? AND view_id=? AND item_id=?', [id, view.id, itemId]);
    await this.deps.audit({ action: 'comparison.link_deleted', target: id, detail: { view_id: viewId, item_id: itemId } });
  }
  async run(id: string, viewId: string, input: Record<string, unknown>, userId: string): Promise<ComparisonResult> {
    const { connection, view, source: capability } = this.context(id, viewId);
    const config = JSON.stringify(connection.config);
    const assertSource = () => {
      const latest = this.context(id, viewId);
      if (latest.connection !== connection || latest.view !== view || latest.source !== capability || JSON.stringify(connection.config) !== config) throw new ComparisonError('CONNECTION_CHANGED', '来源连接或视图已改变，请重新查询', 409);
    };
    const values = defaultInput(input, capability.input);
    if (validateCapabilityInput(capability, values)) throw new ComparisonError('INVALID_PARAMS', '查询参数不符合此视图的来源能力');
    const deadline = Date.now() + MAX_RUN_MS;
    const invoke = async (connectionId: string, capabilityId: string, queryInput: unknown): Promise<ResultEnvelope> => {
      const timeoutResult = () => fail(err('UPSTREAM_TIMEOUT', '比较查询已达到本次运行时限'), { connection_id: connectionId,
        connection_label: this.deps.getConnection(connectionId)?.label ?? connectionId, capability_id: capabilityId,
        support: this.deps.getConnection(connectionId)?.capability_states[capabilityId] ?? { status: 'needs_adapter' } });
      if (Date.now() >= deadline) return timeoutResult();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([this.deps.invoke({ connection_id: connectionId, capability_id: capabilityId, input: queryInput, no_cache: true }, userId),
        new Promise<ResultEnvelope>(resolve => { timeout = setTimeout(() => resolve(timeoutResult()), Math.max(1, deadline - Date.now())); })]); }
      finally { if (timeout) clearTimeout(timeout); }
    };
    const source = await invoke(id, view.source.capability, values);
    assertSource();
    if (source.outcome === 'error') return { outcome: 'error', source, rows: [] };
    const raw = visibleValue(source, view.source.items);
    if (!Array.isArray(raw)) return { outcome: 'partial', source, rows: [] };
    const links = await this.listLinks(id, viewId);
    const targets = new Map<string, { result: Promise<ResultEnvelope>; connection: Connection; config: string; capability: Capability }>();
    const rows: ComparisonRow[] = [];
    const seen = new Set<string>();
    for (const [index, item] of raw.slice(0, MAX_ITEMS).entries()) {
      const itemId = identity(readStaticPath(item, view.source.id));
      if (!itemId || seen.has(itemId)) continue;
      seen.add(itemId);
      const rowPath = (path: string) => [...parseStaticPath(view.source.items), String(index), ...parseStaticPath(path)].join('.');
      if (visibleValue(source, rowPath(view.source.id)) === undefined) continue;
      const link = links.find(entry => entry.item_id === itemId);
      const value = visibleValue(source, rowPath(view.source.value));
      const unitValue = readStaticPath(connection.config, view.source.unit.config);
      const unit = typeof unitValue === 'string' && view.source.unit.allowed.includes(unitValue) ? unitValue : '';
      const label = view.source.label ? visibleValue(source, rowPath(view.source.label)) : itemId;
      const row: ComparisonRow = { item_id: itemId, label: typeof label === 'string' ? label : itemId,
        source_value: { value: typeof value === 'number' && Number.isFinite(value) ? value : null, unit,
          updated_at: time(visibleValue(source, rowPath(view.source.updated_at)), view.source.updated_at_format) },
        target_connection_id: link?.target_connection_id ?? null, target: null,
        comparison: { status: 'unlinked', reason: '尚未明确选择目标连接' } };
      if (link) {
        try {
          const targetCapability = this.target(id, view, link.target_connection_id);
          let pending = targets.get(link.target_connection_id);
          if (!pending) {
            const targetConnection = this.deps.getConnection(link.target_connection_id)!;
            pending = { result: invoke(link.target_connection_id, view.target.capability, defaultInput({}, targetCapability.input)), connection: targetConnection,
              config: JSON.stringify(targetConnection.config), capability: targetCapability };
            targets.set(link.target_connection_id, pending);
          }
          const targetResult = await pending.result;
          assertSource();
          if (this.deps.getConnection(link.target_connection_id) !== pending.connection || JSON.stringify(pending.connection.config) !== pending.config || this.target(id, view, link.target_connection_id) !== pending.capability) throw new ComparisonError('CONNECTION_CHANGED', '目标连接已改变，请重新查询', 409);
          row.target = targetResult;
          const targetValue = visibleValue(row.target, view.target.value);
          const targetMeta = row.target.fields[view.target.value];
          if (row.target.outcome === 'error' || typeof targetValue !== 'number' || !Number.isFinite(targetValue) || targetMeta?.status !== 'ok' || row.source_value.value === null || !row.source_value.updated_at) {
            row.comparison = { status: 'unavailable', reason: '数值、更新时间或可见字段状态不完整，保留各自结果' };
          } else if (!unit || !targetMeta.unit || unit !== targetMeta.unit) {
            row.comparison = { status: 'unknown_unit', reason: '来源单位未明确确认或两端单位不同，不计算差额' };
          } else {
            const difference = row.source_value.value - targetValue;
            row.comparison = Number.isFinite(difference) ? { status: 'comparable', unit, difference, reason: '差额为来源值减去目标值；采样时间不同，不自动判断异常' }
              : { status: 'unavailable', reason: '差额不是有限数值，保留各自结果' };
          }
        } catch (error) { row.comparison = { status: 'unavailable', reason: error instanceof ComparisonError ? error.message : '目标连接不可用或查询失败，保留来源结果' }; }
      }
      assertSource();
      rows.push(row);
    }
    await this.deps.audit({ action: 'comparison.run', target: id, detail: { view_id: viewId, rows: rows.length, comparable: rows.filter(row => row.comparison.status === 'comparable').length } });
    return { outcome: source.outcome === 'partial' || raw.length > MAX_ITEMS || rows.length !== raw.length || rows.some(row => row.comparison.status !== 'comparable') ? 'partial' : 'success', source, rows };
  }
}
