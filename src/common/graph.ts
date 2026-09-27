import type { Block, Chrome, PageConfig, ProjectConfig } from './schema';

/*
 * The site as a graph: one node per page, an edge wherever one page can lead to another
 * or where two pages meet over the same value-store key. It is derived, never stored —
 * a map that disagrees with the document would be worse than no map.
 */

export interface GraphNode {
  path: string;
  title: string;
  embeds: number;
  blocks: number;
  /** Value-store keys this page writes, via a set action on a button or an event. */
  writes: string[];
  /** Keys it reads, via {{token}}, a value block, or an embed config token. */
  reads: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'nav' | 'var';
  /** For nav, the label that navigates. For var, the key they share. */
  via: string;
  /**
   * Site chrome appears on every page, so it produces an edge between every pair — true
   * but ambient. Tagged so a reader can separate it from a link this page actually has.
   */
  source?: 'button' | 'handler' | 'chrome';
}

export interface SiteGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Nav targets that do not resolve to a page — a broken link is worth seeing. */
  danglingLinks: Array<{ from: string; to: string; via: string }>;
}

const TOKEN = /\{\{\s*([A-Za-z_$][A-Za-z0-9_$-]*)(?:\.[A-Za-z0-9_$-]+)*\s*\}\}/g;

function tokensIn(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(TOKEN)) out.add(m[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) tokensIn(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) tokensIn(v, out);
  }
}

function chromeLinks(chrome: Chrome | undefined, out: Scan['navs']): void {
  for (const link of [...(chrome?.nav ?? []), ...(chrome?.links ?? [])]) {
    if (link.to) out.push({ to: link.to, via: link.label, source: 'chrome' });
  }
}

interface Scan {
  writes: Set<string>;
  reads: Set<string>;
  navs: Array<{ to: string; via: string; source: 'button' | 'handler' | 'chrome' }>;
  embeds: number;
}

function scanBlocks(blocks: Block[] | undefined, s: Scan): void {
  for (const block of blocks ?? []) {
    // Any {{token}} anywhere in the block is a read — including inside an embed config,
    // which is how a liveboard id gets driven by a value set on another page.
    tokensIn(block, s.reads);

    if (block.type === 'value') s.reads.add(block.key);

    if (block.type === 'embed') {
      s.embeds += 1;
      for (const handler of block.embed?.embedEventHandlers ?? []) {
        for (const action of handler.actions ?? []) {
          const p = action.params as Record<string, unknown>;
          if (action.type === 'set' && typeof p.key === 'string') s.writes.add(p.key);
          if (action.type === 'run-code' && typeof p.store === 'string') s.writes.add(p.store);
          if (action.type === 'nav' && typeof p.to === 'string') {
            s.navs.push({ to: p.to, via: `${handler.type} handler`, source: 'handler' });
          }
        }
        const respondStore = (handler.respond?.params as Record<string, unknown> | undefined)?.store;
        if (typeof respondStore === 'string') s.writes.add(respondStore);
      }
      for (const action of block.embed?.beforeRender ?? []) {
        const p = action.params as Record<string, unknown>;
        if (action.type === 'run-code' && typeof p.store === 'string') s.writes.add(p.store);
        if (action.type === 'set' && typeof p.key === 'string') s.writes.add(p.key);
      }
    }

    if (block.type === 'buttons') {
      for (const item of block.items ?? []) {
        for (const action of item.actions ?? []) {
          const p = action.params as Record<string, unknown>;
          if (action.type === 'set' && typeof p.key === 'string') s.writes.add(p.key);
          if (action.type === 'run-code' && typeof p.store === 'string') s.writes.add(p.store);
          if (action.type === 'nav' && typeof p.to === 'string') {
            s.navs.push({ to: p.to, via: item.label, source: 'button' });
          }
        }
      }
    }

    if (block.type === 'row') {
      for (const col of block.columns ?? []) scanBlocks(col.blocks, s);
    }
  }
}

function countBlocks(blocks: Block[] | undefined): number {
  let n = 0;
  for (const block of blocks ?? []) {
    n += 1;
    if (block.type === 'row') for (const col of block.columns ?? []) n += countBlocks(col.blocks);
  }
  return n;
}

export function buildGraph(
  project: ProjectConfig,
  pages: Array<{ path: string; config: PageConfig }>,
): SiteGraph {
  const known = new Set(pages.map((p) => p.path));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const danglingLinks: SiteGraph['danglingLinks'] = [];
  const seenEdge = new Set<string>();

  const addEdge = (edge: GraphEdge) => {
    const key = `${edge.kind}|${edge.from}|${edge.to}|${edge.via}|${edge.source ?? ''}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push(edge);
  };

  const scans = new Map<string, Scan>();

  for (const page of pages) {
    const scan: Scan = { writes: new Set(), reads: new Set(), navs: [], embeds: 0 };
    for (const action of page.config.beforeLoad ?? []) {
      const p = action.params as Record<string, unknown>;
      if (action.type === 'run-code' && typeof p.store === 'string') scan.writes.add(p.store);
      if (action.type === 'set' && typeof p.key === 'string') scan.writes.add(p.key);
    }
    scanBlocks(page.config.blocks, scan);
    // A modal is part of the page it hangs off, so its blocks count as the page's.
    for (const modal of Object.values(page.config.modals ?? {})) scanBlocks(modal.blocks, scan);
    // Site chrome links from every page, which is what makes the nav visible as edges.
    chromeLinks(project.header, scan.navs);
    chromeLinks(project.footer, scan.navs);
    chromeLinks(page.config.header, scan.navs);
    chromeLinks(page.config.footer, scan.navs);
    scans.set(page.path, scan);

    nodes.push({
      path: page.path,
      title: page.config.title || page.path,
      embeds: scan.embeds,
      blocks: countBlocks(page.config.blocks),
      writes: [...scan.writes].sort(),
      reads: [...scan.reads].sort(),
    });
  }

  for (const [path, scan] of scans) {
    for (const nav of scan.navs) {
      if (nav.to === path) continue;
      if (!known.has(nav.to)) {
        danglingLinks.push({ from: path, to: nav.to, via: nav.via });
        continue;
      }
      addEdge({ from: path, to: nav.to, kind: 'nav', via: nav.via, source: nav.source });
    }
  }

  // A shared key is drawn writer -> reader, because that is the direction the value
  // actually travels. Two pages that only read the same key still share it, so they get
  // an edge too — undirected in meaning, drawn once.
  for (const [from, a] of scans) {
    for (const [to, b] of scans) {
      if (from === to) continue;
      for (const key of a.writes) {
        if (b.reads.has(key)) addEdge({ from, to, kind: 'var', via: key });
      }
      if (from < to) {
        for (const key of a.reads) {
          if (!b.reads.has(key)) continue;
          if (a.writes.has(key) || b.writes.has(key)) continue;
          addEdge({ from, to, kind: 'var', via: key });
        }
      }
    }
  }

  return { nodes: nodes.sort((x, y) => x.path.localeCompare(y.path)), edges, danglingLinks };
}
