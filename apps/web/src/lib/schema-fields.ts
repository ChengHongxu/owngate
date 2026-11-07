/** The small set of field types used by connector configuration and inputs. */
export interface FieldSchema {
  type?: string | string[]
  title?: string
  label?: string
  description?: string
  help?: string
  secret?: boolean
  default?: unknown
  enum?: unknown[]
  required?: boolean
  format?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
}

export interface FormField {
  name: string
  schema: FieldSchema
  required: boolean
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function configFields(schema: Record<string, unknown> = {}): FormField[] {
  return Object.entries(schema).map(([name, value]) => {
    const field = record(value) as FieldSchema
    return { name, schema: field, required: field.required === true }
  })
}

export function inputFields(schema: Record<string, unknown>): FormField[] {
  const required = Array.isArray(schema['required']) ? schema['required'] : []
  return Object.entries(record(schema['properties'])).map(([name, value]) => ({ name, schema: record(value) as FieldSchema, required: required.includes(name) }))
}

export function fieldType(schema: FieldSchema): string {
  return Array.isArray(schema.type) ? schema.type.find((type) => type !== 'null') ?? 'string' : schema.type ?? 'string'
}

export function fieldText(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

export function initialFields(fields: FormField[], values: Record<string, unknown> = {}): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.name, fieldText(values[field.name] ?? field.schema.default)]))
}

/** Parse form text once, preserving false and zero and rejecting NaN/invalid
 * JSON. The server remains the authority for full capability validation. */
export function parseFields(fields: FormField[], values: Record<string, string>, options: { partial?: boolean } = {}): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    const schema = field.schema
    const label = schema.label ?? schema.title ?? field.name
    const raw = values[field.name] ?? fieldText(schema.default)
    const text = schema.secret ? raw : raw.trim()
    if (text === '') {
      if (field.required && !options.partial) throw new Error(`请填写${label}`)
      continue
    }
    let value: unknown = text
    const type = fieldType(schema)
    if (type === 'number' || type === 'integer') {
      value = Number(text)
      if (!Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) throw new Error(`${label}需要填写${type === 'integer' ? '整数' : '有效数字'}`)
      if (schema.minimum !== undefined && (value as number) < schema.minimum) throw new Error(`${label}不能小于 ${schema.minimum}`)
      if (schema.maximum !== undefined && (value as number) > schema.maximum) throw new Error(`${label}不能大于 ${schema.maximum}`)
    } else if (type === 'boolean') {
      if (text !== 'true' && text !== 'false') throw new Error(`${label}请选择是或否`)
      value = text === 'true'
    } else if (type === 'object' || type === 'array') {
      try { value = JSON.parse(text) } catch { throw new Error(`${label}需要填写有效的 JSON`) }
      if (type === 'array' ? !Array.isArray(value) : typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label}需要填写${type === 'array' ? '数组' : '对象'}`)
    } else {
      if (schema.minLength !== undefined && text.length < schema.minLength) throw new Error(`${label}至少需要 ${schema.minLength} 个字符`)
      if (schema.maxLength !== undefined && text.length > schema.maxLength) throw new Error(`${label}最多允许 ${schema.maxLength} 个字符`)
      if (schema.format === 'uri' || schema.format === 'url') {
        let url: URL
        try { url = new URL(text) } catch { throw new Error(`${label}需要填写完整网址（包含 https://）`) }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${label}需要填写不含账号密码的 HTTP 或 HTTPS 网址`)
      }
    }
    if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) throw new Error(`${label}请选择列表中的值`)
    result[field.name] = value
  }
  return result
}
