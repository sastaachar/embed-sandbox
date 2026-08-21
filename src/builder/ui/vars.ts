import type { Doc } from './types';

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
