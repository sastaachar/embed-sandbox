import React from 'react';

interface Node {
  path: string;
  name: string;
  /** False for an intermediate segment with no page of its own ("/sales" when only "/sales/q3" exists). */
  exists: boolean;
  children: Node[];
}

function buildTree(paths: string[]): Node[] {
  const root: Node = { path: '', name: '', exists: false, children: [] };
  const byPath = new Map<string, Node>([['', root]]);
  const ensure = (path: string): Node => {
    const hit = byPath.get(path);
    if (hit) return hit;
    const cut = path.lastIndexOf('/');
    const parent = ensure(cut <= 0 ? '' : path.slice(0, cut));
    const node: Node = { path, name: path.slice(cut + 1) || '/', exists: false, children: [] };
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const p of [...paths].sort()) ensure(p);
  for (const p of paths) {
    const node = byPath.get(p);
    if (node) node.exists = true;
  }
  return root.children;
}

export function PageTree(props: {
  paths: string[];
  current: string;
  onOpen: (path: string) => void;
  onNew: () => void;
  onDelete: () => void;
}) {
  const rows = (nodes: Node[], depth: number): React.ReactNode[] =>
    nodes.flatMap((n) => [
      <div
        key={n.path}
        className={'pt-row' + (n.path === props.current ? ' on' : '')}
        style={{ paddingLeft: depth * 13 }}
      >
        {n.exists ? (
          <button className="pt-open" title={n.path} onClick={() => props.onOpen(n.path)}>
            {n.name}
          </button>
        ) : (
          <span className="pt-ghost" title={`No page at ${n.path} — it only exists as a parent path`}>
            {n.name}
          </span>
        )}
        {n.exists && n.path === props.current && (
          <button className="pt-del" title={`Delete ${n.path}`} onClick={props.onDelete}>✕</button>
        )}
      </div>,
      ...rows(n.children, depth + 1),
    ]);

  return (
    <div id="pageTree">
      <div className="pt-head">
        <h2>Pages</h2>
        <button id="newPage" title="Create a page" onClick={props.onNew}>+</button>
      </div>
      {rows(buildTree(props.paths), 0)}
    </div>
  );
}
