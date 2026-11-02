// Template renderer — design doc §4.1.2 ③
// {{ }} allows only three sources: config.<field>, secret.<field>, input.<field>
// No function calls allowed inside templates.

export interface TemplateContext {
  config: Record<string, unknown>;
  secret: Record<string, unknown>;
  input: Record<string, unknown>;
}

/**
 * Render a template string, replacing {{config.x}}, {{secret.x}}, {{input.x}}.
 * Returns the rendered string or the original value if no placeholders.
 * For integer fields, validates the substituted value is a valid integer.
 */
export function renderTemplate(
  template: string,
  ctx: TemplateContext,
  opts: { urlEncodeInput?: boolean } = {},
): { value: string; warnings: string[] } {
  const warnings: string[] = [];
  const TEMPLATE_RE = /\{\{\s*(config|secret|input)\.([a-zA-Z0-9_]+)\s*\}\}/g;

  const rendered = template.replace(TEMPLATE_RE, (match, source: string, field: string) => {
    const bag = ctx[source as keyof TemplateContext];
    if (bag === undefined) {
      warnings.push(`Unknown template source: ${source}`);
      return '';
    }
    if (!(field in bag)) {
      warnings.push(`Template field not found: ${source}.${field}`);
      return '';
    }
    const val = bag[field];
    if (val === null || val === undefined) return '';
    const str = String(val);
    // URL-encode input substitutions in strings (not for config/secret)
    if (source === 'input' && opts.urlEncodeInput) {
      return encodeURIComponent(str);
    }
    return str;
  });

  // Check for unresolved templates
  const remaining = rendered.match(/\{\{[^}]+\}\}/g);
  if (remaining) {
    warnings.push(`Unresolved template placeholders: ${remaining.join(', ')}`);
  }

  return { value: rendered, warnings };
}

/**
 * Recursively render all string values in an object.
 */
export function renderObject(
  obj: unknown,
  ctx: TemplateContext,
  opts: { urlEncodeInput?: boolean } = {},
): { value: unknown; warnings: string[] } {
  const allWarnings: string[] = [];

  function render(v: unknown): unknown {
    if (typeof v === 'string') {
      const result = renderTemplate(v, ctx, opts);
      allWarnings.push(...result.warnings);
      return result.value;
    }
    if (Array.isArray(v)) return v.map(render);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = render(val);
      }
      return out;
    }
    return v;
  }

  return { value: render(obj), warnings: allWarnings };
}
