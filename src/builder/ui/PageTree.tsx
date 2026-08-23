import React from 'react';

/**
 * The page list in the left nav. Deliberately FLAT — full paths, sorted — after the
 * indented-tree version was rejected on sight ("nested pages will suck"): a path like
 * /sales/q3 already says where it lives, and ghost parent nodes said nothing.
 */
export function PageTree(props: {
  paths: string[];
  current: string;
  onOpen: (path: string) => void;
  onNew: () => void;
  onDelete: () => void;
}) {
  return (
    <div id="pageTree">
      <div className="pt-head">
        <h2>Pages</h2>
        <button id="newPage" title="Create a page" onClick={props.onNew}>+</button>
      </div>
      {[...props.paths].sort().map((p) => (
        <div key={p} className={'pt-row' + (p === props.current ? ' on' : '')}>
          <button className="pt-open" title={p} onClick={() => props.onOpen(p)}>{p}</button>
          {p === props.current && (
            <button className="pt-del" title={`Delete ${p}`} onClick={props.onDelete}>✕</button>
          )}
        </div>
      ))}
    </div>
  );
}
