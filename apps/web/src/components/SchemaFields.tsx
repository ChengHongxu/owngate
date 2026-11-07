import { useId } from 'react'
import { fieldText, fieldType, type FormField } from '../lib/schema-fields'
import { HelpTip } from './HelpTip'

export function SchemaFields({ fields, values, onChange, disabled = false }: {
  fields: FormField[]
  values: Record<string, string>
  onChange: (values: Record<string, string>) => void
  disabled?: boolean
}) {
  const id = useId()
  return <>{fields.map((field) => {
    const schema = field.schema
    const type = fieldType(schema)
    const value = values[field.name] ?? fieldText(schema.default)
    const change = (next: string) => onChange({ ...values, [field.name]: next })
    const help = schema.help ?? schema.description
    const label = schema.label ?? schema.title ?? field.name
    const controlId = `${id}-${field.name}`
    return <div className="schema-field" key={field.name}>
      <div className="field-label"><label htmlFor={controlId}>{label}{field.required ? ' *' : ''}</label>{help && <HelpTip label={`${label}说明`}>{help}</HelpTip>}</div>
      {schema.enum ? <select id={controlId} value={value} required={field.required} disabled={disabled} onChange={(event) => change(event.target.value)}>
        <option value="">请选择</option>
        {schema.enum.map((option) => <option key={fieldText(option)} value={fieldText(option)}>{fieldText(option)}</option>)}
      </select> : type === 'boolean' ? <select id={controlId} value={value} required={field.required} disabled={disabled} onChange={(event) => change(event.target.value)}>
        <option value="">不设置</option><option value="true">是</option><option value="false">否</option>
      </select> : type === 'object' || type === 'array' ? <textarea id={controlId} value={value} required={field.required} disabled={disabled} rows={3} spellCheck={false} onChange={(event) => change(event.target.value)} /> :
        <input id={controlId} type={schema.secret ? 'password' : type === 'number' || type === 'integer' ? 'number' : schema.format === 'uri' || schema.format === 'url' ? 'url' : 'text'} value={value}
          required={field.required} disabled={disabled} min={schema.minimum} max={schema.maximum} step={type === 'integer' ? 1 : 'any'} minLength={schema.minLength} maxLength={schema.maxLength}
          autoComplete={schema.secret ? 'new-password' : 'off'} spellCheck={false} onChange={(event) => change(event.target.value)} />}
    </div>
  })}</>
}
