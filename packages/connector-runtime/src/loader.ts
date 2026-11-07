// Manifest loader — design doc §4.1.1
// Parses a YAML connector manifest, validates it, and compiles it into
// Capability objects ready for the runtime.

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { isKnownTransform } from './transforms.js';
import { compilePresentation } from './presentation.js';
import { compileConnectorViews, compileVerification } from './connector-views.js';
import type { Capability, ComparisonView, JSONSchema, Transport, VerificationPlan } from '@owngate/core';

// ── Public types ───────────────────────────────────────────────────────────

/** Login success condition — design doc §4.4.3 (`login.success_when.any[0]`). */
export type LoginCondition =
  | { type: 'cookie'; name: string; domain: string }
  | { type: 'url_not_contains'; pattern: string };

/** Remote-login settings from the manifest `login:` block — design doc §4.4.3. */
export interface LoginConfig {
  url: string;
  successWhen: LoginCondition[];
  whoami?: string;
  allowedDomains?: string[];
  qrSelector?: string;
}

export interface CompiledConnector {
  id: string;
  version: string;
  title: string;
  transport: Transport;
  capabilities: Record<string, Capability>;
  views?: ComparisonView[];
  verification?: VerificationPlan;
  login?: LoginConfig;
  // Manifest blocks preserved for runtime use (dispatcher, registry)
  config?: Record<string, unknown>;
  auth?: { type: string; fields?: Record<string, unknown> };
  discovery?: { quota_ratio: { path: string; from: string } };
  http?: {
    base: string;
    headers?: Record<string, string>;
    rate_limit?: { rpm: number };
    timeout_ms?: number;
  };
  // Per-capability runtime definitions (request, output mapping, conditions)
  capabilityDefs?: Record<string, {
    roles?: Array<'user' | 'admin'>;
    request: { method: string; path: string; query?: Record<string, string>; readonly_paths?: string[] };
    output?: Record<string, OutputFieldDef>;
    success_when?: string;
    auth_failed_when?: string;
    data_time?: { now: true };
  }>;
}

// ── Internal manifest shapes ───────────────────────────────────────────────

type AccessKind = 'official_api' | 'private_api' | 'browser';
type SensitivityKind = 'pii' | 'financial' | 'content';

export interface OutputFieldDef {
  from: string;
  type?: string;
  schema?: JSONSchema;
  transform?: string;
  unit?: string;
  scope?: string;
  sensitivity?: SensitivityKind;
}

interface CapabilityDef {
  id: string;
  kind: 'query' | 'action';
  effect: string;
  approval?: string;
  cache: { ttl: number } | null;
  title: string;
  description: string;
  input?: JSONSchema;
  roles?: Array<'user' | 'admin'>;
  request: { method: string; path: string; query?: Record<string, string>; readonly_paths?: string[] };
  success_when?: string;
  auth_failed_when?: string;
  output?: Record<string, OutputFieldDef>;
  presentation?: unknown;
  data_time?: { now: true };
}

interface ManifestRaw {
  connector: string;
  version: string;
  title: string;
  access: AccessKind;
  config?: Record<string, unknown>;
  auth?: { type: string; fields?: Record<string, unknown> };
  discovery?: { quota_ratio: { path: string; from: string } };
  http?: {
    base: string;
    headers?: Record<string, string>;
    rate_limit?: { rpm: number };
    timeout_ms?: number;
  };
  capabilities: CapabilityDef[];
  views?: unknown;
  verification?: unknown;
  login?: LoginConfig;
}

// ── Validation constants ───────────────────────────────────────────────────

const ACCESS_KINDS = new Set<string>(['official_api', 'private_api', 'browser']);
const EFFECT_VALUES = new Set<string>(['read', 'write', 'destructive', 'external_send', 'financial']);
const KIND_VALUES = new Set<string>(['query', 'action']);
const SENSITIVITY_VALUES = new Set<string>(['pii', 'financial', 'content']);

const APPROVAL_BY_KIND: Record<'query' | 'action', string> = {
  query: 'never',
  action: 'always',
};

function transportForAccess(access: AccessKind): Transport {
  return access === 'browser' ? 'browser' : 'http';
}

// ── Field-level validation helpers ──────────────────────────────────────────

function asObject(v: unknown, ctx: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`${ctx}: expected an object, got ${JSON.stringify(v)}`);
  }
  return v as Record<string, unknown>;
}

function asRecord(v: unknown, ctx: string): Record<string, unknown> {
  const obj = asObject(v, ctx);
  for (const key of Object.keys(obj)) {
    const field = obj[key];
    if (field === null || typeof field !== 'object' || Array.isArray(field)) {
      throw new Error(`${ctx}: field "${key}" must be an object, got ${JSON.stringify(field)}`);
    }
  }
  return obj;
}

function requireString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${ctx}: "${key}" must be a non-empty string, got ${JSON.stringify(v)}`);
  }
  return v;
}

function requireEnum(
  obj: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
  ctx: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string' || !allowed.has(v)) {
    throw new Error(
      `${ctx}: "${key}" must be one of ${[...allowed].join(' | ')}, got ${JSON.stringify(v)}`,
    );
  }
  return v;
}

// ── Output field compilation ───────────────────────────────────────────────

function compileOutputSchema(
  defs: Record<string, OutputFieldDef> | undefined,
  capId: string,
): JSONSchema {
  if (!defs || Object.keys(defs).length === 0) {
    return {};
  }

  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  for (const [name, def] of Object.entries(defs)) {
    if (typeof def.from !== 'string' || def.from.length === 0) {
      throw new Error(
        `capability "${capId}" output field "${name}": "from" must be a non-empty JSONPath string`,
      );
    }
    if (def.transform !== undefined) {
      if (typeof def.transform !== 'string' || def.transform.length === 0) {
        throw new Error(
          `capability "${capId}" output field "${name}": "transform" must be a string`,
        );
      }
      if (!isKnownTransform(def.transform)) {
        throw new Error(
          `capability "${capId}" output field "${name}": unknown transform "${def.transform}"`,
        );
      }
    }
    if (def.sensitivity !== undefined && !SENSITIVITY_VALUES.has(def.sensitivity)) {
      throw new Error(
        `capability "${capId}" output field "${name}": "sensitivity" must be one of ${[...SENSITIVITY_VALUES].join(' | ')}, got ${JSON.stringify(def.sensitivity)}`,
      );
    }

    const numeric = ['quota_to_usd', 'seconds_to_ms', 'ms_to_seconds', 'iso_to_unix', 'number_or_null'];
    const prop: JSONSchema = {
      ...(def.schema ?? { type: [def.type ?? (numeric.includes(def.transform ?? '') ? 'number' : 'string'), 'null'] }),
      'x-from': def.from,
    };
    if (def.transform !== undefined) prop['x-transform'] = def.transform;
    if (def.unit !== undefined) prop['x-unit'] = def.unit;
    if (def.scope !== undefined) prop['x-scope'] = def.scope;
    prop['x-sensitivity'] = def.sensitivity ?? def.schema?.['x-sensitivity'] ?? 'content';
    properties[name] = prop;
    required.push(name);
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

// ── Capability compilation ──────────────────────────────────────────────────

function compileCapability(def: CapabilityDef, transport: Transport): Capability {
  const id = def.id;
  const kind = def.kind;
  const effect = def.effect;

  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('capability "id" must be a non-empty string');
  }
  if (!KIND_VALUES.has(kind)) {
    throw new Error(
      `capability "${id}": "kind" must be one of ${[...KIND_VALUES].join(' | ')}, got ${JSON.stringify(kind)}`,
    );
  }
  if (!EFFECT_VALUES.has(effect)) {
    throw new Error(
      `capability "${id}": "effect" must be one of ${[...EFFECT_VALUES].join(' | ')}, got ${JSON.stringify(effect)}`,
    );
  }

  // cache: query → {ttl} allowed or null; action → must be null
  if (kind === 'action' && def.cache !== null) {
    throw new Error(`capability "${id}": "cache" must be null for actions`);
  }
  let cache: { ttl: number } | null = null;
  if (def.cache !== null) {
    const ttl = def.cache.ttl;
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(`capability "${id}": "cache.ttl" must be a positive number`);
    }
    cache = { ttl };
  }

  const approval = def.approval ?? APPROVAL_BY_KIND[kind];
  if (approval !== 'never' && approval !== 'always' && approval !== 'policy') {
    throw new Error(
      `capability "${id}": "approval" must be one of never | always | policy, got ${JSON.stringify(approval)}`,
    );
  }

  if (typeof def.title !== 'string' || def.title.length === 0) {
    throw new Error(`capability "${id}": "title" must be a non-empty string`);
  }
  if (typeof def.description !== 'string') {
    throw new Error(`capability "${id}": "description" must be a string`);
  }

  const req = def.request;
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    throw new Error(`capability "${id}": "request" must be an object`);
  }
  if (typeof req.method !== 'string' || req.method.length === 0) {
    throw new Error(`capability "${id}": "request.method" must be a non-empty string`);
  }
  if (typeof req.path !== 'string' || req.path.length === 0) {
    throw new Error(`capability "${id}": "request.path" must be a non-empty string`);
  }

  const outputSchema = compileOutputSchema(def.output, id);
  const presentation = compilePresentation(def.presentation, outputSchema, `capability "${id}" presentation`);

  return {
    id,
    kind,
    title: def.title,
    description: def.description,
    effect: effect as Capability['effect'],
    approval: approval as Capability['approval'],
    input: def.input ?? { type: 'object', additionalProperties: false },
    output: outputSchema,
    ...(presentation ? { presentation } : {}),
    cache,
    long_running: false,
    cancel: 'none',
    idempotency: 'none',
    verify: null,
    transport,
    support: kind === 'action' ? { status: 'disabled' } : transport === 'browser' ? { status: 'unverified', reason: '尚未在当前连接中验证' } : { status: 'supported' },
    ...(def.roles ? { roles: def.roles } : {}),
  };
}

// ── Login block (§4.4.3) ───────────────────────────────────────────────────

function optionalString(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${path} must be a non-empty string, got ${JSON.stringify(v)}`);
  }
  return v;
}

function parseLoginCondition(v: unknown, path: string): LoginCondition {
  const obj = asObject(v, path);
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    throw new Error(
      `${path} must have exactly one condition key (cookie | url_not_contains), got ${JSON.stringify(keys)}`,
    );
  }
  const key = keys[0];
  if (key === 'cookie') {
    const cookie = asObject(obj['cookie'], `${path}.cookie`);
    const name = cookie['name'];
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`${path}.cookie.name must be a non-empty string, got ${JSON.stringify(name)}`);
    }
    const domain = cookie['domain'];
    if (typeof domain !== 'string' || domain.length === 0) {
      throw new Error(`${path}.cookie.domain must be a non-empty string, got ${JSON.stringify(domain)}`);
    }
    return { type: 'cookie', name, domain };
  }
  if (key === 'url_not_contains') {
    const pattern = obj['url_not_contains'];
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error(`${path}.url_not_contains must be a non-empty string, got ${JSON.stringify(pattern)}`);
    }
    return { type: 'url_not_contains', pattern };
  }
  throw new Error(`${path}: unknown condition type "${key}" (expected cookie | url_not_contains)`);
}

function parseLogin(v: unknown, rootQrSelector: unknown): LoginConfig {
  const login = asObject(v, 'manifest.login');

  const url = login['url'];
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`manifest.login.url must be a non-empty string, got ${JSON.stringify(url)}`);
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`manifest.login.url must be an absolute URL, got ${JSON.stringify(url)}`);
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error(`manifest.login.url must use http or https, got ${JSON.stringify(url)}`);
  }

  const sw = asObject(login['success_when'], 'manifest.login.success_when');
  for (const key of Object.keys(sw)) {
    if (key !== 'any') {
      throw new Error(`manifest.login.success_when: unsupported key "${key}" (expected any)`);
    }
  }
  const any = sw['any'];
  if (!Array.isArray(any) || any.length === 0) {
    throw new Error('manifest.login.success_when.any must be a non-empty array');
  }
  // Validate every entry so typos surface at load time; every condition is kept
  // (design §4.4.3: "保留 any 里全部条件，现在只取第一条，其余被丢" → now keep all).
  const conditions = any.map((c, i) => parseLoginCondition(c, `manifest.login.success_when.any[${i}]`));
  const successWhen = conditions;

  const whoami = optionalString(login['whoami'], 'manifest.login.whoami');

  let allowedDomains: string[] | undefined;
  if (login['allowed_domains'] !== undefined) {
    const ad = login['allowed_domains'];
    if (!Array.isArray(ad)) {
      throw new Error(`manifest.login.allowed_domains must be an array of strings, got ${JSON.stringify(ad)}`);
    }
    allowedDomains = ad.map((d, i) => {
      if (typeof d !== 'string' || d.length === 0) {
        throw new Error(`manifest.login.allowed_domains[${i}] must be a non-empty string, got ${JSON.stringify(d)}`);
      }
      return d;
    });
  }

  // qr_selector may sit inside login or at manifest top level; login wins.
  const loginQr = optionalString(login['qr_selector'], 'manifest.login.qr_selector');
  const topQr = optionalString(rootQrSelector, 'manifest.qr_selector');
  const qrSelector = loginQr ?? topQr;

  return {
    url,
    successWhen,
    ...(whoami !== undefined ? { whoami } : {}),
    ...(allowedDomains !== undefined ? { allowedDomains } : {}),
    ...(qrSelector !== undefined ? { qrSelector } : {}),
  };
}

// ── Manifest validation & compilation ──────────────────────────────────────

function validateManifest(raw: unknown): ManifestRaw {
  const root = asObject(raw, 'manifest');
  const connector = requireString(root, 'connector', 'manifest');
  const version = requireString(root, 'version', 'manifest');
  const title = requireString(root, 'title', 'manifest');
  const access = requireEnum(root, 'access', ACCESS_KINDS, 'manifest') as AccessKind;

  let config: Record<string, unknown> | undefined;
  if (root["config"] !== undefined) {
    config = asRecord(root["config"], 'manifest.config');
  }

  let auth: ManifestRaw['auth'];
  if (root["auth"] !== undefined) {
    const authObj = asObject(root["auth"], 'manifest.auth');
    const authType = requireString(authObj, 'type', 'manifest.auth');
    auth = { type: authType };
    if (authObj["fields"] !== undefined) {
      auth.fields = asRecord(authObj["fields"], 'manifest.auth.fields') as Record<string, unknown>;
    }
  }

  let http: ManifestRaw['http'];
  if (root["http"] !== undefined) {
    const httpObj = asObject(root["http"], 'manifest.http');
    http = {
      base: requireString(httpObj, 'base', 'manifest.http'),
    };
    if (httpObj["headers"] !== undefined) {
      // Headers are string values (templates), not nested objects — validate accordingly.
      const hdrsObj = asObject(httpObj["headers"], 'manifest.http.headers');
      const headers: Record<string, string> = {};
      for (const k of Object.keys(hdrsObj)) {
        const hv = hdrsObj[k];
        if (typeof hv !== 'string') {
          throw new Error(`manifest.http.headers: header "${k}" must be a string, got ${JSON.stringify(hv)}`);
        }
        headers[k] = hv;
      }
      http["headers"] = headers;
    }
    if (httpObj["rate_limit"] !== undefined) {
      const rl = asObject(httpObj["rate_limit"], 'manifest.http["rate_limit"]');
      const rpm = rl["rpm"];
      if (typeof rpm !== 'number' || !Number.isFinite(rpm) || rpm <= 0) {
        throw new Error('manifest.http["rate_limit"].rpm must be a positive number');
      }
      http["rate_limit"] = { rpm };
    }
    if (httpObj["timeout_ms"] !== undefined) {
      if (typeof httpObj["timeout_ms"] !== 'number' || httpObj["timeout_ms"] <= 0) {
        throw new Error('manifest.http["timeout_ms"] must be a positive number');
      }
      http["timeout_ms"] = httpObj["timeout_ms"];
    }
  }

  let discovery: ManifestRaw['discovery'];
  if (root['discovery'] !== undefined) {
    const block = asObject(root['discovery'], 'manifest.discovery');
    const ratio = asObject(block['quota_ratio'], 'manifest.discovery.quota_ratio');
    discovery = { quota_ratio: {
      path: requireString(ratio, 'path', 'manifest.discovery.quota_ratio'),
      from: requireString(ratio, 'from', 'manifest.discovery.quota_ratio'),
    } };
  }

  if (!Array.isArray(root["capabilities"]) || root["capabilities"].length === 0) {
    throw new Error('manifest.capabilities must be a non-empty array');
  }

  const capabilities: CapabilityDef[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < root["capabilities"].length; i++) {
    const capRaw = asObject(root["capabilities"][i], `manifest.capabilities[${i}]`);
    const capId = requireString(capRaw, 'id', `manifest.capabilities[${i}]`);
    if (seenIds.has(capId)) {
      throw new Error(`manifest.capabilities[${i}]: duplicate capability id "${capId}"`);
    }
    seenIds.add(capId);

    const kind = requireEnum(capRaw, 'kind', KIND_VALUES, `manifest.capabilities[${i}]`) as
      | 'query'
      | 'action';
    const effect = requireEnum(
      capRaw,
      'effect',
      EFFECT_VALUES,
      `manifest.capabilities[${i}]`,
    );

    // cache: null or { ttl: number }; undefined treated as null.
    let cache: { ttl: number } | null = null;
    if (capRaw["cache"] === null || capRaw["cache"] === undefined) {
      cache = null;
    } else {
      const cacheObj = asObject(capRaw["cache"], `manifest.capabilities[${i}].cache`);
      const ttl = cacheObj["ttl"];
      if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
        throw new Error(`manifest.capabilities[${i}].cache.ttl must be a positive number`);
      }
      cache = { ttl };
    }

    const capTitle = requireString(capRaw, 'title', `manifest.capabilities[${i}]`);
    if (capRaw["description"] !== undefined && typeof capRaw["description"] !== 'string') {
      throw new Error(`manifest.capabilities[${i}].description must be a string`);
    }
    const capDesc = typeof capRaw["description"] === 'string' ? capRaw["description"] : '';

    const requestObj = asObject(capRaw["request"], `manifest.capabilities[${i}].request`);
    const method = requireString(requestObj, 'method', `manifest.capabilities[${i}].request`);
    const path = requireString(requestObj, 'path', `manifest.capabilities[${i}].request`);
    let query: Record<string, string> | undefined;
    if (requestObj['query'] !== undefined) {
      const rawQuery = asObject(requestObj['query'], `manifest.capabilities[${i}].request.query`);
      query = {};
      for (const [field, name] of Object.entries(rawQuery)) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) || typeof name !== 'string' || !name || name.length > 100 || /[\r\n\0]/.test(name)) throw new Error(`capability "${capId}": invalid query mapping`);
        query[field] = name;
      }
    }
    let readonlyPaths: string[] | undefined;
    if (requestObj['readonly_paths'] !== undefined) {
      const paths = requestObj['readonly_paths'];
      if (method !== 'ADAPTER' || kind !== 'query' || effect !== 'read') throw new Error(`capability "${capId}": readonly_paths is only allowed for a read-only ADAPTER query`);
      if (!Array.isArray(paths) || paths.length > 10 || paths.some((value) => typeof value !== 'string')) throw new Error(`capability "${capId}": readonly_paths must contain at most 10 paths`);
      readonlyPaths = [];
      for (const value of paths as string[]) {
        if (!value.startsWith('/') || value.startsWith('//') || value.length > 2000 || /[\\\r\n\0#]/.test(value)) throw new Error(`capability "${capId}": readonly_paths requires same-origin absolute paths`);
        const plain = value.replace(/\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, '/placeholder');
        if (/[{}]/.test(plain)) throw new Error(`capability "${capId}": readonly_paths only supports input field templates`);
        const input = capRaw['input'] === undefined ? {} : asObject(capRaw['input'], `capability ${capId} input`);
        const properties = input['properties'] === undefined ? {} : asObject(input['properties'], `capability ${capId} input properties`);
        for (const match of value.matchAll(/\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
          const field = properties[match[1]!];
          const type = typeof field === 'object' && field !== null ? (field as Record<string, unknown>)['type'] : undefined;
          const types = Array.isArray(type) ? type.filter((entry) => entry !== 'null') : [type];
          if (types.length !== 1 || !['string', 'number', 'integer', 'boolean'].includes(String(types[0]))) throw new Error(`capability "${capId}": readonly_paths requires a declared scalar input field`);
        }
        if (readonlyPaths.includes(value)) throw new Error(`capability "${capId}": readonly_paths contains duplicate paths`);
        readonlyPaths.push(value);
      }
    }

    // output fields
    let output: Record<string, OutputFieldDef> | undefined;
    if (capRaw["output"] !== undefined) {
      const outObj = asRecord(capRaw["output"], `manifest.capabilities[${i}].output`);
      output = {};
      for (const [name, fieldRaw] of Object.entries(outObj)) {
        const fieldObj = asObject(fieldRaw, `manifest.capabilities[${i}].output.${name}`);
        const from = requireString(
          fieldObj,
          'from',
          `manifest.capabilities[${i}].output.${name}`,
        );
        const def: OutputFieldDef = { from };
        if (fieldObj['type'] !== undefined) {
          const type = fieldObj['type'];
          if (typeof type !== 'string' || !['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(type)) {
            throw new Error(`capability "${capId}" output field "${name}": invalid type`);
          }
          def.type = type;
        }
        if (fieldObj['schema'] !== undefined) def.schema = asObject(fieldObj['schema'], `capability ${capId} output ${name} schema`);
        if (fieldObj["transform"] !== undefined) {
          if (typeof fieldObj["transform"] !== 'string' || fieldObj["transform"].length === 0) {
            throw new Error(
              `manifest.capabilities[${i}].output.${name}.transform must be a string`,
            );
          }
          def.transform = fieldObj["transform"];
        }
        if (fieldObj["unit"] !== undefined) {
          if (typeof fieldObj["unit"] !== 'string') {
            throw new Error(
              `manifest.capabilities[${i}].output.${name}.unit must be a string`,
            );
          }
          def.unit = fieldObj["unit"];
        }
        if (fieldObj["scope"] !== undefined) {
          if (typeof fieldObj["scope"] !== 'string') {
            throw new Error(
              `manifest.capabilities[${i}].output.${name}.scope must be a string`,
            );
          }
          def.scope = fieldObj["scope"];
        }
        if (fieldObj["sensitivity"] !== undefined) {
          if (
            typeof fieldObj["sensitivity"] !== 'string' ||
            !SENSITIVITY_VALUES.has(fieldObj["sensitivity"])
          ) {
            throw new Error(
              `manifest.capabilities[${i}].output.${name}.sensitivity must be one of ${[...SENSITIVITY_VALUES].join(' | ')}`,
            );
          }
          def.sensitivity = fieldObj["sensitivity"] as SensitivityKind;
        }
        output[name] = def;
      }
    }

    const capDef: CapabilityDef = {
      id: capId,
      kind,
      effect,
      cache,
      title: capTitle,
      description: capDesc,
      request: { method, path, ...(query ? { query } : {}), ...(readonlyPaths ? { readonly_paths: readonlyPaths } : {}) },
      ...(capRaw['input'] !== undefined ? { input: asObject(capRaw['input'], `capability ${capId} input`) } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(capRaw['presentation'] !== undefined ? { presentation: capRaw['presentation'] } : {}),
    };
    if (capRaw['roles'] !== undefined) {
      const roles = capRaw['roles'];
      if (!Array.isArray(roles) || !roles.length || roles.some((role) => role !== 'user' && role !== 'admin')) {
        throw new Error(`capability "${capId}": roles must be a non-empty array of user | admin`);
      }
      capDef.roles = [...new Set(roles)] as Array<'user' | 'admin'>;
    }
    if (typeof capRaw['approval'] === 'string') capDef.approval = capRaw['approval'];
    if (typeof capRaw["success_when"] === 'string') capDef.success_when = capRaw["success_when"];
    if (typeof capRaw["auth_failed_when"] === 'string') capDef.auth_failed_when = capRaw["auth_failed_when"];
    if (capRaw["data_time"] !== undefined) capDef.data_time = capRaw["data_time"] as { now: true };
    capabilities.push(capDef);
  }

  const login = root['login'] !== undefined ? parseLogin(root['login'], root['qr_selector']) : undefined;

  return {
    connector,
    version,
    title,
    access,
    ...(config !== undefined ? { config } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(http !== undefined ? { http } : {}),
    ...(discovery !== undefined ? { discovery } : {}),
    capabilities,
    ...(root['views'] !== undefined ? { views: root['views'] } : {}),
    ...(root['verification'] !== undefined ? { verification: root['verification'] } : {}),
    ...(login !== undefined ? { login } : {}),
  };
}

export function loadManifest(yamlString: string): CompiledConnector {
  const raw = parseYaml(yamlString);
  const manifest = validateManifest(raw);

  const transport = transportForAccess(manifest.access);
  const capabilities: Record<string, Capability> = {};
  const capabilityDefs: Record<string, {
    roles?: Array<'user' | 'admin'>;
    request: { method: string; path: string; query?: Record<string, string>; readonly_paths?: string[] };
    output?: Record<string, OutputFieldDef>;
    success_when?: string;
    auth_failed_when?: string;
    data_time?: { now: true };
  }> = {};

  for (const def of manifest.capabilities) {
    capabilities[def.id] = compileCapability(def, transport);
    capabilityDefs[def.id] = {
      ...(def.roles ? { roles: def.roles } : {}),
      request: def.request,
      ...(def.output ? { output: def.output } : {}),
      ...(def.success_when ? { success_when: def.success_when } : {}),
      ...(def.auth_failed_when ? { auth_failed_when: def.auth_failed_when } : {}),
      ...(def.data_time ? { data_time: def.data_time } : {}),
    };
  }

  const views = compileConnectorViews(manifest.views, capabilities, manifest.config);
  const verification = compileVerification(manifest.verification, capabilities);

  return {
    id: manifest.connector,
    version: manifest.version,
    title: manifest.title,
    transport,
    capabilities,
    ...(views !== undefined ? { views } : {}),
    ...(verification !== undefined ? { verification } : {}),
    ...(manifest.login !== undefined ? { login: manifest.login } : {}),
    ...(manifest.config !== undefined ? { config: manifest.config } : {}),
    ...(manifest.auth !== undefined ? { auth: manifest.auth } : {}),
    ...(manifest.http !== undefined ? { http: manifest.http } : {}),
    ...(manifest.discovery !== undefined ? { discovery: manifest.discovery } : {}),
    capabilityDefs,
  };
}

export function loadManifestFile(path: string): CompiledConnector {
  const contents = readFileSync(path, 'utf8');
  return loadManifest(contents);
}
