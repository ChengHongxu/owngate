// JSONPath subset evaluator — design doc §4.1.2 ①
// Supports: $, .name, ['name'], [n] (negative from tail), [*] / .*
// Does NOT support: .., [?(...)], script expressions

export type JsonPathResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string; warnings: string[] };

/** Parse a JSONPath string like "$.data.quota" into segments. */
export function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  let i = 0;

  if (path[i] === '$') i++;

  while (i < path.length) {
    if (path[i] === '.') {
      i++;
      // .name (could be .*)
      if (path[i] === '*') {
        segments.push({ type: 'wildcard' });
        i++;
        continue;
      }
      let name = '';
      while (i < path.length && path[i] !== '.' && path[i] !== '[') {
        name += path[i];
        i++;
      }
      segments.push({ type: 'member', name });
    } else if (path[i] === '[') {
      i++; // skip [
      if (path[i] === '*') {
        segments.push({ type: 'wildcard' });
        i += 2; // skip *]
        continue;
      }
      if (path[i] === "'" || path[i] === '"') {
        const quote = path[i];
        i++;
        let name = '';
        while (i < path.length && path[i] !== quote) {
          name += path[i];
          i++;
        }
        i += 2; // skip quote and ]
        segments.push({ type: 'member', name });
      } else {
        // numeric index
        let num = '';
        while (i < path.length && path[i] !== ']') {
          num += path[i];
          i++;
        }
        i++; // skip ]
        const idx = parseInt(num, 10);
        if (isNaN(idx)) {
          throw new Error(`Invalid array index: [${num}]`);
        }
        segments.push({ type: 'index', index: idx });
      }
    } else {
      // bare name after $
      let name = '';
      while (i < path.length && path[i] !== '.' && path[i] !== '[') {
        name += path[i];
        i++;
      }
      if (name) segments.push({ type: 'member', name });
    }
  }

  return segments;
}

export type PathSegment =
  | { type: 'member'; name: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' };

/** Evaluate a parsed path against a root object. */
export function evalPath(root: unknown, segments: PathSegment[]): unknown[] {
  let current: unknown[] = [root];

  for (const seg of segments) {
    const next: unknown[] = [];
    for (const val of current) {
      if (seg.type === 'member') {
        if (val !== null && typeof val === 'object' && seg.name in (val as object)) {
          next.push((val as Record<string, unknown>)[seg.name]);
        }
      } else if (seg.type === 'index') {
        if (Array.isArray(val)) {
          const len = val.length;
          let idx = seg.index;
          if (idx < 0) idx = len + idx; // negative from tail
          if (idx >= 0 && idx < len) next.push(val[idx]);
        }
      } else if (seg.type === 'wildcard') {
        if (Array.isArray(val)) {
          next.push(...val);
        } else if (val !== null && typeof val === 'object') {
          next.push(...Object.values(val as Record<string, unknown>));
        }
      }
    }
    current = next;
  }

  return current;
}

/** Convenience: parse + evaluate, returning first match or undefined. */
export function pathGet(root: unknown, pathStr: string): unknown {
  const segs = parsePath(pathStr);
  const results = evalPath(root, segs);
  return results[0];
}

/** Convenience: parse + evaluate, returning all matches. */
export function pathGetAll(root: unknown, pathStr: string): unknown[] {
  const segs = parsePath(pathStr);
  return evalPath(root, segs);
}
