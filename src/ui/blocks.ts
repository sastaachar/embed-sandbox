import type { Block, EmbedType, Loc, Page } from './types';
import { ID_KEY } from './types';

/** "3" = blocks[3];  "1.0.2" = blocks[1].columns[0].blocks[2] */

export function listAt(page: Page, loc: Loc): Block[] | null {
  const p = loc.split('.');
  if (p.length === 1) return page.blocks;
  const row = page.blocks[+p[0]];
  const col = row?.columns?.[+p[1]];
  return col ? (col.blocks ||= []) : null;
}

export function indexAt(loc: Loc): number {
  const p = loc.split('.');
  return +p[p.length - 1];
}

/** '' for the sheet, '2.0' for row 2 column 0 — the key a drop container carries. */
export function listKey(loc: Loc): string {
  const p = loc.split('.');
  return p.length === 1 ? '' : `${p[0]}.${p[1]}`;
}

export function listFromKey(page: Page, key: string): Block[] | null {
  if (key === '') return page.blocks;
  const [r, c] = key.split('.');
  const col = page.blocks[+r]?.columns?.[+c];
  return col ? (col.blocks ||= []) : null;
}

export function blockAt(page: Page, loc: Loc | null): Block | null {
  if (loc == null) return null;
  const list = listAt(page, loc);
  return list ? list[indexAt(loc)] ?? null : null;
}

export function locOf(page: Page, block: Block): Loc | null {
  const top = page.blocks.indexOf(block);
  if (top >= 0) return String(top);
  for (let i = 0; i < page.blocks.length; i++) {
    const cols = page.blocks[i].columns || [];
    for (let j = 0; j < cols.length; j++) {
      const k = (cols[j].blocks || []).indexOf(block);
      if (k >= 0) return `${i}.${j}.${k}`;
    }
  }
  return null;
}

export function newEmbed(type: EmbedType = 'liveboard'): Block {
  return { type: 'embed', embed: { type, config: {} } };
}

/** Switching type must drop the previous type's id, or a stale one lingers unseen. */
export function setEmbedType(block: Block, type: EmbedType) {
  const spec = block.embed!;
  const oldKey = ID_KEY[spec.type];
  const nextKey = ID_KEY[type];
  if (oldKey !== nextKey) delete spec.config[oldKey];
  spec.type = type;
}

export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
