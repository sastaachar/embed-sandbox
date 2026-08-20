import React, { useEffect, useState } from 'react';
import { PID } from './api';

/*
 * The site at a glance: a box per page, an arrow wherever one leads to another, and a
 * dashed line wherever two pages meet over the same value-store key.
 *
 * Site chrome is a link from EVERY page to every target, so including it by default
 * turns any navbar into a full mesh that says nothing. It is off until asked for.
 */

interface Node {
  path: string; title: string; embeds: number; blocks: number;
  writes: string[]; reads: string[];
}
interface Edge { from: string; to: string; kind: 'nav' | 'var'; via: string; source?: string }
interface Graph { nodes: Node[]; edges: Edge[]; danglingLinks: Array<{ from: string; to: string; via: string }> }

const BOX_W = 190;
const BOX_H = 78;
const GAP_X = 110;
const GAP_Y = 64;

/** Laid out in rows by path depth, so a nested page sits below its parent. */
function layout(nodes: Node[]) {
  const rows = new Map<number, Node[]>();
  for (const n of nodes) {
    const depth = n.path === '/' ? 0 : n.path.split('/').filter(Boolean).length;
    (rows.get(depth) ?? rows.set(depth, []).get(depth)!).push(n);
  }
  const at = new Map<string, { x: number; y: number }>();
  const widest = Math.max(...[...rows.values()].map((r) => r.length), 1);
  for (const [depth, row] of [...rows].sort((a, b) => a[0] - b[0])) {
    const rowWidth = row.length * BOX_W + (row.length - 1) * GAP_X;
    const fullWidth = widest * BOX_W + (widest - 1) * GAP_X;
    row.forEach((n, i) => {
      at.set(n.path, {
        x: (fullWidth - rowWidth) / 2 + i * (BOX_W + GAP_X),
        y: depth * (BOX_H + GAP_Y),
      });
    });
  }
  return {
    at,
    width: widest * BOX_W + (widest - 1) * GAP_X,
    height: (rows.size || 1) * (BOX_H + GAP_Y),
  };
}

/** A curve, so two edges between the same pair stay distinguishable. */
function path(a: { x: number; y: number }, b: { x: number; y: number }, lift: number) {
  const x1 = a.x + BOX_W / 2, y1 = a.y + BOX_H / 2;
  const x2 = b.x + BOX_W / 2, y2 = b.y + BOX_H / 2;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  return `M ${x1} ${y1} Q ${mx - (dy / len) * lift} ${my + (dx / len) * lift} ${x2} ${y2}`;
}

export function MapPanel(props: { onClose: () => void; onOpenPage: (path: string) => void }) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [err, setErr] = useState('');
  const [showChrome, setShowChrome] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/projects/${PID}/graph`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('could not load the map'))))
      .then(setGraph)
      .catch((e) => setErr((e as Error).message));
  }, []);

  if (err) return <section className="pane map-pane"><p className="dlg-err">{err}</p></section>;
  if (!graph) return <section className="pane map-pane"><p className="dlg-note">reading the site…</p></section>;

  const edges = graph.edges.filter((e) => showChrome || e.source !== 'chrome');
  const { at, width, height } = layout(graph.nodes);
  const navCount = graph.edges.filter((e) => e.kind === 'nav' && e.source !== 'chrome').length;
  const varCount = graph.edges.filter((e) => e.kind === 'var').length;
  const chromeCount = graph.edges.filter((e) => e.source === 'chrome').length;

  const pairSeen = new Map<string, number>();
  const lifted = edges.map((e) => {
    const key = [e.from, e.to].sort().join('|');
    const n = (pairSeen.get(key) ?? 0) + 1;
    pairSeen.set(key, n);
    return { edge: e, lift: (n - 1) * 26 * (n % 2 === 0 ? 1 : -1) };
  });

  const dim = (e: Edge) => focus !== null && e.from !== focus && e.to !== focus;

  return (
    <section className="pane map-pane" id="mapPane">
      <div className="map-head">
        <h2>Map</h2>
        <span className="map-legend">
          <i className="k-nav" /> {navCount} link{navCount === 1 ? '' : 's'}
          <i className="k-var" /> {varCount} shared value{varCount === 1 ? '' : 's'}
        </span>
        <span className="sp" />
        <label className="checkline" title="Site chrome links from every page to every target">
          <input type="checkbox" checked={showChrome} onChange={(e) => setShowChrome(e.target.checked)} />
          Site nav ({chromeCount})
        </label>
        <button onClick={props.onClose}>Close</button>
      </div>

      {graph.danglingLinks.length > 0 && (
        <p className="dlg-err" id="mapDangling">
          {graph.danglingLinks.length} link{graph.danglingLinks.length === 1 ? '' : 's'} to a page that
          does not exist: {graph.danglingLinks.map((d) => `${d.from} → ${d.to}`).join(', ')}
        </p>
      )}

      <div className="map-scroll">
        <svg width={width + 40} height={height + 40} className="map-svg">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          <g transform="translate(20,20)">
            {lifted.map(({ edge, lift }, i) => {
              const a = at.get(edge.from), b = at.get(edge.to);
              if (!a || !b) return null;
              return (
                <g key={i} className={`edge ${edge.kind}${dim(edge) ? ' dim' : ''}`}>
                  <path d={path(a, b, lift)} markerEnd={edge.kind === 'nav' ? 'url(#arrow)' : undefined} />
                  <title>{edge.kind === 'nav' ? `${edge.from} → ${edge.to} via “${edge.via}”` : `both use {{${edge.via}}}`}</title>
                </g>
              );
            })}
            {graph.nodes.map((n) => {
              const p = at.get(n.path)!;
              return (
                <g
                  key={n.path}
                  className={`node${focus === n.path ? ' on' : ''}`}
                  transform={`translate(${p.x},${p.y})`}
                  onMouseEnter={() => setFocus(n.path)}
                  onMouseLeave={() => setFocus(null)}
                  onClick={() => props.onOpenPage(n.path)}
                >
                  <rect width={BOX_W} height={BOX_H} rx="10" />
                  <text className="t" x="12" y="24">{n.title}</text>
                  <text className="p" x="12" y="43">{n.path}</text>
                  <text className="m" x="12" y="62">
                    {n.embeds} embed{n.embeds === 1 ? '' : 's'} · {n.blocks} block{n.blocks === 1 ? '' : 's'}
                    {n.writes.length ? ` · writes ${n.writes.join(', ')}` : ''}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <p className="hint">Click a page to open it. Hover to isolate what it touches.</p>
    </section>
  );
}
