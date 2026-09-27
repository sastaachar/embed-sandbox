import type { Doc } from './types';

/** The runtime's token grammar, character for character — see runtime.js TOKEN. */
const TOKEN_FULL = /\{\{\s*([A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z0-9_$-]+)*)\s*\}\}/g;

/**
 * What a FRESH VISITOR sees: the value the project declares, and nothing else.
 *
 * The published runtime resolves a key as session > this browser's saved value >
 * declared default. The builder has no session and no visitor, so it stops at the
 * default — which is exactly the state a first-time visitor lands in, and therefore
 * the honest thing for the canvas to preview.
 */
export function variableDefaults(doc: Doc): Record<string, string> {
  const declared = (doc.config?.variables ?? {}) as Record<string, { default?: string }>;
  const out: Record<string, string> = {};
  for (const [key, spec] of Object.entries(declared)) {
    if (spec && typeof spec.default === 'string') out[key] = spec.default;
  }
  return out;
}

/** Dotted path into a value, like the runtime's lookup(). */
function lookup(path: string, values: Record<string, unknown>): unknown {
  const parts = path.split('.');
  let cur: unknown = values[parts[0]];
  for (let i = 1; i < parts.length; i += 1) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  return cur;
}

/**
 * {{key}} -> its value. An unresolved key becomes the empty string, because that is
 * what the published page does — a canvas that left the braces showing would be
 * previewing a page nobody gets.
 */
export function interpolate(tpl: string, values: Record<string, unknown>): string {
  return String(tpl).replace(TOKEN_FULL, (_, path: string) => {
    const v = lookup(path, values);
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** True if anything in here would change once variables are applied. */
export function hasToken(value: string): boolean {
  TOKEN_FULL.lastIndex = 0;
  const found = TOKEN_FULL.test(value);
  TOKEN_FULL.lastIndex = 0;
  return found;
}

/**
 * Deep copy with every string interpolated — how an embed's config reaches the SDK on
 * the published page, so it is how the canvas has to build one too. A liveboardId of
 * "{{liveboardId}}" is a real guid to a visitor and was a literal 16-character string
 * to the builder, which is why such an embed rendered nothing here.
 */
export function resolveTokens<T>(value: T, values: Record<string, unknown>): T {
  if (typeof value === 'string') return interpolate(value, values) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => resolveTokens(v, values)) as unknown as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = resolveTokens(v, values);
  }
  return out as unknown as T;
}

/**
 * Every value-store key the document mentions, so a key is offered rather than recalled.
 * Reads and writes both count: what matters is that the name already exists somewhere.
 */
export function variableKeys(doc: Doc): string[] {
  const keys = new Set<string>();
  const TOKEN = /\{\{\s*([A-Za-z_$][A-Za-z0-9_$-]*)/g;

  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(TOKEN)) keys.add(m[1]);
      return;
    }
    if (Array.isArray(value)) { for (const v of value) walk(v); return; }
    if (!value || typeof value !== 'object') return;
    const o = value as Record<string, unknown>;
    if (o.type === 'value' && typeof o.key === 'string') keys.add(o.key);
    if (o.type === 'set' && o.params && typeof (o.params as any).key === 'string') {
      keys.add((o.params as any).key);
    }
    for (const v of Object.values(o)) walk(v);
  };

  walk(doc.pages);
  walk(doc.config);
  return [...keys].sort();
}
