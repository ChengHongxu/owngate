import { parseDocument } from 'yaml';
import { loadManifest, type CompiledConnector } from './loader.js';

export interface ExtensionOperation { id: string; title: string; method: string; path: string; eligible: boolean; reason: string }
export interface ExtensionDraft {
  id: string; title: string; version: string; compiled: CompiledConnector; manifest: Record<string, unknown>; operations: ExtensionOperation[];
}
const BAD_KEY = new Set(['__proto__', 'constructor', 'prototype']);
const METHODS = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'trace']);
const WRITE_WORD = /(?:^|[\/?&=_ .\-])(?:add|create|update|delete|remove|send|publish|buy|purchase|checkout|set|save|reset|revoke|rotate|transfer|trigger|execute|run|flush|clear|disable|enable|test|refresh|sync|login|logout|upload|notify)(?:$|[\/?&=_ .\-])/i;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function object(value: unknown, name: string): Record<string, unknown> { if (!isObject(value)) throw new Error(`${name} 必须是对象`); return value; }
function walk(value: unknown, depth = 0): void {
  if (depth > 24) throw new Error('文档结构最多嵌套 24 层');
  if (typeof value === 'string' && value.length > 32000) throw new Error('单个字段过长');
  if (Array.isArray(value)) { if (value.length > 200) throw new Error('列表最多 200 项'); for (const entry of value) walk(entry, depth + 1); }
  else if (isObject(value)) for (const [key, entry] of Object.entries(value)) {
    if (BAD_KEY.has(key)) throw new Error('内容包含不允许的对象键');
    if (['x-code', 'x-javascript', 'x-script', 'adapter_code'].includes(key.toLowerCase())) throw new Error('不支持 JavaScript 或可执行脚本');
    if (key === '$ref' && (typeof entry !== 'string' || !entry.startsWith('#/components/schemas/'))) throw new Error('只允许本地 #/components/schemas 引用，不读取远程或文件引用');
    walk(entry, depth + 1);
  }
}
export function parseExtensionSource(source: string): Record<string, unknown> {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 128 * 1024 || !source.trim()) throw new Error('粘贴内容需要 1 到 128 KiB');
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Error('YAML / JSON 无效、包含重复字段或不支持的标签');
  let parsed: unknown;
  try { parsed = doc.toJS({ maxAliasCount: 20 }); } catch { throw new Error('YAML 别名过多或循环引用'); }
  walk(parsed);
  return object(parsed, '导入内容');
}
function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{2,63}$/.test(value)) throw new Error('连接器 ID 需要 3 到 64 个小写字母、数字、下划线或短横线，且以字母开头');
  return value;
}
function cleanSchema(raw: unknown, root: Record<string, unknown>, seen: Set<string> = new Set(), depth = 0): Record<string, unknown> {
  if (depth > 8) throw new Error('解析后的 schema 最多嵌套 8 层');
  const source = object(raw, 'schema');
  if (source['$ref'] !== undefined) {
    const ref = String(source['$ref']);
    if (!/^#\/components\/schemas\/[A-Za-z0-9_.-]+$/.test(ref) || seen.has(ref)) throw new Error('schema 引用不受支持或存在循环');
    const schemas = object(object(root['components'], 'components')['schemas'], 'schemas');
    return cleanSchema(schemas[ref.split('/').at(-1)!], root, new Set([...seen, ref]), depth + 1);
  }
  if (source['oneOf'] || source['anyOf'] || source['allOf'] || source['not'] || source['patternProperties'] || source['additionalProperties'] === true || isObject(source['additionalProperties'])) throw new Error('此版本不支持组合 schema 或动态对象，请先简化定义');
  const allowed = new Set(['$ref', 'type', 'title', 'description', 'enum', 'default', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'x-sensitivity', 'x-unit', 'x-secret', 'writeOnly', 'readOnly', 'format', 'example', 'examples', 'deprecated', 'xml', 'externalDocs', 'nullable', 'properties', 'required', 'additionalProperties', 'items']);
  if (Object.keys(source).some((key) => !allowed.has(key) && !key.startsWith('x-'))) throw new Error('schema 包含暂不支持的约束，请先简化定义');
  let type = source['type'];
  let nullable = source['nullable'] === true;
  if (Array.isArray(type) && type.length === 2 && type.includes('null')) { nullable = true; type = type.find((entry) => entry !== 'null'); }
  if (!type && source['properties']) type = 'object';
  if (!['string', 'integer', 'number', 'boolean', 'object', 'array'].includes(String(type))) throw new Error('schema 需要明确的受支持 type');
  const result: Record<string, unknown> = { type: nullable ? [type, 'null'] : type };
  for (const key of ['title', 'description', 'format', 'enum', 'default', 'minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'x-sensitivity', 'x-unit', 'x-secret', 'x-untrusted', 'x-scope', 'x-dimension', 'x-unknown-reason', 'writeOnly']) if (source[key] !== undefined) result[key] = source[key];
  for (const [flag, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
    if (typeof source[flag!] === 'number') result[flag!] = source[flag!];
    else if (source[flag!] === true && typeof source[bound!] === 'number') { result[flag!] = source[bound!]; delete result[bound!]; }
  }
  if (type === 'object') {
    const properties = object(source['properties'] ?? {}, 'properties');
    result['properties'] = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, cleanSchema(value, root, seen, depth + 1)]));
    result['additionalProperties'] = false;
    if (source['required'] !== undefined) {
      if (!Array.isArray(source['required']) || !source['required'].every((entry) => typeof entry === 'string' && Object.hasOwn(properties, entry))) throw new Error('required 必须引用已声明字段');
      result['required'] = [...new Set(source['required'])];
    }
  }
  if (type === 'array') result['items'] = cleanSchema(source['items'], root, seen, depth + 1);
  return result;
}
function safeRead(method: string, path: string, operation: Record<string, unknown>): { eligible: boolean; reason: string } {
  if (method !== 'GET') return { eligible: false, reason: '本期只允许明确的 GET 查询，写操作保持禁用' };
  if (operation['requestBody']) return { eligible: false, reason: 'GET 带 requestBody，未确认只读语义' };
  const operationId = String(operation['operationId'] ?? '').replace(/([a-z])([A-Z])/g, '$1_$2');
  if (WRITE_WORD.test(path) || WRITE_WORD.test(operationId) || ['write', 'destructive', 'external_send', 'financial'].includes(String(operation['x-effect'] ?? operation['effect']))) return { eligible: false, reason: '路径或操作描述存在写入语义，保持禁用' };
  return { eligible: true, reason: '可选择启用 GET 只读查询；仍需为连接配置并验证授权' };
}
function manifestDraft(raw: Record<string, unknown>): ExtensionDraft {
  const id = safeId(raw['connector']);
  if (['adapter', 'entrypoint', 'runtime', 'code', 'script', 'javascript', 'discovery'].some((key) => raw[key] !== undefined)) throw new Error('导入仅支持声明式请求，不支持代码适配器或额外发现请求');
  if (!Array.isArray(raw['capabilities']) || raw['capabilities'].length === 0 || raw['capabilities'].length > 50) throw new Error('每次导入需要 1 到 50 个能力');
  // Templates may refer to secrets, but literal credential headers are rejected.
  const http = raw['http'] === undefined ? undefined : object(raw['http'], 'http');
  const validateUrl = (value: unknown) => {
    if (typeof value !== 'string') throw new Error('站点 URL 必须是字符串');
    let url: URL; try { url = new URL(value); } catch { throw new Error('站点 URL 必须是绝对 HTTP 地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('站点 URL 必须是不含凭据、查询和片段的 HTTP 地址');
  };
  if (raw['access'] !== 'browser' && !http) throw new Error('HTTP 连接器需要声明 http.base');
  const config = raw['config'] === undefined ? {} : object(raw['config'], 'config');
  for (const [name, rawField] of Object.entries(config)) {
    const field = object(rawField, 'config field');
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || !['string', 'number', 'integer', 'boolean'].includes(String(field['type']))) throw new Error('连接配置只支持有明确类型的单值字段');
    if (/(password|secret|token|api[-_]?key)/i.test(name) || field['secret'] === true) throw new Error('秘密字段需要放在 auth.fields，在创建连接时单独填写');
    if (name === 'base_url' && field['default'] !== undefined) validateUrl(field['default']);
  }
  if (http) {
    if (http['base'] !== '{{config.base_url}}') validateUrl(http['base']);
    if (http['base'] === '{{config.base_url}}' && !isObject(config['base_url'])) throw new Error('http.base 引用的 base_url 配置不存在');
  }
  const auth = raw['auth'] === undefined ? undefined : object(raw['auth'], 'auth');
  const authFields = auth?.['fields'] === undefined ? {} : object(auth['fields'], 'auth.fields');
  for (const [name, field] of Object.entries(authFields)) {
    const definition = object(field, 'auth field');
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || definition['type'] !== 'string') throw new Error('授权字段只支持字符串');
    if (['default', 'value', 'example', 'examples'].some((key) => definition[key] !== undefined)) throw new Error('导入定义不能包含凭据值，请在创建连接时单独填写');
  }
  if (http?.['headers']) for (const [name, value] of Object.entries(object(http['headers'], 'headers'))) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /^(host|proxy-authorization|content-length|transfer-encoding|connection)$/i.test(name) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('请求头名称或内容不受支持');
    if (/(authorization|cookie|token|api[-_]?key)/i.test(name) && (typeof value !== 'string' || !/^(?:Bearer\s+)?\{\{secret\.[A-Za-z0-9_]+\}\}$/.test(value))) throw new Error('认证请求头必须引用 secret 模板，不接受粘贴的实际凭据');
    for (const match of value.matchAll(/\{\{secret\.([A-Za-z0-9_]+)\}\}/g)) if (!Object.hasOwn(authFields, match[1]!)) throw new Error('请求头引用的授权字段不存在');
  }
  const operations: ExtensionOperation[] = [];
  const capabilities = raw['capabilities'].map((value) => {
    const capability = object(value, 'capability'); const request = object(capability['request'], 'request');
    if (typeof capability['id'] !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(capability['id'])) throw new Error('能力 ID 需要以字母开头，并且只含字母、数字、点、下划线或短横线，最多 128 字符');
    if (['adapter', 'code', 'script', 'javascript'].some((key) => capability[key] !== undefined)) throw new Error('不支持代码适配器');
    if (Object.keys(request).some((key) => !['method', 'path', 'query'].includes(key))) throw new Error('request 只支持 method、path 和单值 query 参数');
    const method = String(request['method']).toUpperCase(); const path = String(request['path']);
    if (!METHODS.has(method.toLowerCase())) throw new Error('HTTP method 不受支持');
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n\0#]/.test(path) || path.length > 2000 || /\{\{(?:secret|config)\./.test(path)) throw new Error('请求路径必须是同源的绝对路径，不能包含凭据模板');
    if (/[{}]/.test(path.replace(/\{\{input\.[A-Za-z0-9_]+\}\}/g, '')) || /[?&](?:access_token|token|secret|password|api[-_]?key)=/i.test(path)) throw new Error('路径模板或查询字符串凭据不受支持');
    const input = cleanSchema(capability['input'] ?? { type: 'object', properties: {}, additionalProperties: false }, raw);
    if (input['type'] !== 'object') throw new Error('能力 input 需要是对象');
    let supportedInput = true;
    const properties = object(input['properties'] ?? {}, 'input properties');
    const checkField = (name: string) => {
      const definition = properties[name];
      if (!isObject(definition) || !['string', 'integer', 'number', 'boolean'].includes(String(definition['type']))) supportedInput = false;
    };
    for (const match of path.matchAll(/\{\{input\.([A-Za-z0-9_]+)\}\}/g)) checkField(match[1]!);
    if (request['query']) for (const [field, name] of Object.entries(object(request['query'], 'query'))) {
      checkField(field);
      if (typeof name !== 'string' || /(token|secret|password|api[-_]?key)/i.test(name)) throw new Error('查询字符串不能携带凭据');
    }
    const output: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(capability['output'] === undefined ? {} : object(capability['output'], 'output'))) {
      const field = object(value, 'output field');
      output[name] = { ...field, ...(field['schema'] === undefined ? {} : { schema: cleanSchema(field['schema'], raw) }) };
    }
    const read = safeRead(method, path, { ...capability, operationId: capability['id'] });
    const supported = supportedInput && Object.keys(output).length > 0;
    const eligible = raw['access'] !== 'browser' && capability['kind'] === 'query' && capability['effect'] === 'read' && read.eligible && supported;
    operations.push({ id: String(capability['id']), title: String(capability['title'] ?? capability['id']), method, path, eligible, reason: raw['access'] === 'browser' ? '未知浏览器站点需要适配器（needs_adapter），本次不能启用' : capability['kind'] !== 'query' || capability['effect'] !== 'read' || !supported ? '未确认只读语义或参数/响应不受支持，保持禁用' : read.reason });
    const kind = method === 'GET' && capability['kind'] === 'query' ? 'query' : 'action';
    return { ...capability, input, output, request: { ...request, method }, kind, effect: eligible ? 'read' : capability['effect'] ?? 'write', cache: kind === 'query' ? capability['cache'] ?? null : null };
  });
  const manifest: Record<string, unknown> = { ...raw, connector: id, capabilities };
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > 128 * 1024) throw new Error('展开后的连接器超过 128 KiB，请精简 schema 或操作数');
  const compiled = loadManifest(JSON.stringify(manifest));
  // Persist the same normalized declarations that the runtime will execute.
  // Optional blocks stay absent for existing drafts, preserving their hashes.
  if (compiled.views !== undefined) manifest['views'] = compiled.views;
  if (compiled.verification !== undefined) manifest['verification'] = compiled.verification;
  for (const cap of Object.values(compiled.capabilities)) cap.support = { status: 'disabled', reason: '导入草稿尚未选择启用' };
  return { id, title: compiled.title, version: compiled.version, compiled, manifest, operations };
}

export function compileExtension(source: string, format: 'manifest' | 'openapi', requestedId?: string): ExtensionDraft {
  const raw = parseExtensionSource(source);
  if (format === 'manifest') {
    if (JSON.stringify(raw).includes('"$ref"')) throw new Error('原生清单需要展开 schema 引用后导入');
    return manifestDraft({ ...raw, ...(requestedId ? { connector: requestedId } : {}) });
  }
  if (!/^3\.0\./.test(String(raw['openapi'] ?? ''))) throw new Error('当前只支持 OpenAPI 3.0，其他版本请转换后导入');
  const info = object(raw['info'], 'info'); const id = safeId(requestedId);
  const servers = raw['servers']; const server = Array.isArray(servers) ? servers[0] : undefined;
  const serverUrl = isObject(server) ? server['url'] : undefined;
  if (typeof serverUrl !== 'string' || serverUrl.includes('{')) throw new Error('OpenAPI 需要一个不含变量的绝对 servers URL');
  const url = new URL(serverUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务器 URL 必须是无凭据的 HTTP 地址');
  const prefix = url.pathname.replace(/\/$/, '');
  const manifest: Record<string, unknown> = { connector: id, version: typeof info['version'] === 'string' ? info['version'] : '1.0.0', title: info['title'] ?? id,
    access: 'official_api', config: { base_url: { type: 'string', format: 'uri', required: true, default: url.origin, label: '站点网址' } },
    http: { base: '{{config.base_url}}', timeout_ms: 10000, rate_limit: { rpm: 30 } }, capabilities: [] };
  if (raw['x-owngate-config'] !== undefined) {
    const extra = object(raw['x-owngate-config'], 'x-owngate-config');
    if (Object.hasOwn(extra, 'base_url')) throw new Error('x-owngate-config 不能覆盖自动生成的 base_url');
    manifest['config'] = { ...(manifest['config'] as Record<string, unknown>), ...extra };
  }
  if (raw['x-owngate-views'] !== undefined) manifest['views'] = raw['x-owngate-views'];
  if (raw['x-owngate-verification'] !== undefined) manifest['verification'] = raw['x-owngate-verification'];
  const schemes = isObject(raw['components']) && isObject(raw['components']['securitySchemes']) ? raw['components']['securitySchemes'] : {};
  const secrets: Record<string, unknown> = {}; const headers: Record<string, string> = {};
  const security = raw['security'];
  const applySecurity = (securityValue: unknown) => {
    if (!Array.isArray(securityValue) || !securityValue.length) return;
    if (securityValue.length > 1) throw new Error('当前不支持多组选一的认证，请保留一组');
    const names = Object.keys(object(securityValue[0], 'security'));
    if (names.length > 1) throw new Error('当前每个连接器只支持一种认证');
    for (const name of names) {
      const scheme = object(schemes[name], 'security scheme');
      if (scheme['type'] === 'http' && String(scheme['scheme']).toLowerCase() === 'bearer') { secrets['access_token'] = { type: 'string', secret: true, label: '访问令牌' }; headers['Authorization'] = 'Bearer {{secret.access_token}}'; }
      else if (scheme['type'] === 'apiKey' && scheme['in'] === 'header' && typeof scheme['name'] === 'string') { secrets['api_key'] = { type: 'string', secret: true, label: 'API 密钥' }; headers[scheme['name']] = '{{secret.api_key}}'; }
      else throw new Error('仅支持 Bearer 或请求头 API Key 认证，不支持 Cookie、查询字符串凭据或 OAuth 流程');
    }
  };
  applySecurity(security);
  const definitions: Array<Record<string, unknown>> = [];
  for (const [path, rawPath] of Object.entries(object(raw['paths'], 'paths'))) {
    const pathItem = object(rawPath, 'path item');
    if (pathItem['servers'] !== undefined) throw new Error('当前不支持路径级 servers，请拆分后导入');
    for (const [methodName, rawOperation] of Object.entries(pathItem)) {
      if (!METHODS.has(methodName.toLowerCase())) continue;
      if (definitions.length >= 50) throw new Error('每次最多导入 50 个操作');
      const operation = object(rawOperation, 'operation');
      if (operation['servers'] !== undefined) throw new Error('当前不支持操作级 servers，请拆分后导入');
      if (operation['security'] !== undefined && JSON.stringify(operation['security']) !== JSON.stringify(security ?? [])) throw new Error('操作认证与全局认证不同，请按认证方式拆分后导入');
      const method = methodName.toUpperCase(); const read = safeRead(method, path, operation);
      const operationId = typeof operation['operationId'] === 'string' ? operation['operationId'].replace(/[^A-Za-z0-9_.-]/g, '_') : `operation.${definitions.length + 1}`;
      const parameters = [...(Array.isArray(pathItem['parameters']) ? pathItem['parameters'] : []), ...(Array.isArray(operation['parameters']) ? operation['parameters'] : [])];
      const properties: Record<string, unknown> = {}; const required: string[] = []; const query: Record<string, string> = {};
      let targetPath = prefix + path; let unsupported = false;
      for (const rawParameter of parameters) {
        const parameter = object(rawParameter, 'parameter'); const name = String(parameter['name']); const location = parameter['in'];
        if (!['path', 'query'].includes(String(location)) || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) || /(token|secret|password|api[-_]?key)/i.test(name)) { unsupported = true; continue; }
        if (parameter['style'] !== undefined && parameter['style'] !== (location === 'query' ? 'form' : 'simple') || parameter['allowReserved'] === true || parameter['content'] !== undefined) { unsupported = true; continue; }
        const alias = `${location}_${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
        const schema = cleanSchema(parameter['schema'], raw);
        if (!['string', 'integer', 'number', 'boolean'].includes(String(schema['type']))) { unsupported = true; continue; }
        if (properties[alias]) throw new Error('参数名称在规范化后发生冲突');
        properties[alias] = { ...schema, title: name, ...(typeof parameter['description'] === 'string' ? { description: parameter['description'] } : {}) };
        if (parameter['required'] === true || location === 'path') required.push(alias);
        if (location === 'query') query[alias] = name;
        else targetPath = targetPath.replaceAll(`{${name}}`, `{{input.${alias}}}`);
      }
      if (/[{}]/.test(targetPath.replace(/\{\{input\.[A-Za-z0-9_]+\}\}/g, ''))) throw new Error('路径含有未定义参数');
      const responses = object(operation['responses'] ?? {}, 'responses');
      const response = isObject(responses['200']) ? responses['200'] : isObject(responses['201']) ? responses['201'] : undefined;
      const content = response && isObject(response['content']) ? response['content'] : {};
      const json = isObject(content['application/json']) ? content['application/json'] : undefined;
      let output: Record<string, unknown> = {};
      if (json?.['schema']) output = { result: { from: '$', schema: cleanSchema(json['schema'], raw) } };
      else unsupported = true;
      definitions.push({ id: operationId, title: operation['summary'] ?? operationId, description: typeof operation['description'] === 'string' ? operation['description'] : '',
        kind: read.eligible && !unsupported ? 'query' : 'action', effect: read.eligible && !unsupported ? 'read' : 'write', cache: null,
        input: { type: 'object', properties, required, additionalProperties: false }, request: { method, path: targetPath, ...(Object.keys(query).length ? { query } : {}) }, output,
        ...(operation['x-owngate-presentation'] !== undefined ? { presentation: operation['x-owngate-presentation'] } : {}) });
    }
  }
  if (Object.keys(secrets).length) { manifest['auth'] = { type: 'bearer', fields: secrets }; (manifest['http'] as Record<string, unknown>)['headers'] = headers; }
  manifest['capabilities'] = definitions;
  return manifestDraft(manifest);
}
