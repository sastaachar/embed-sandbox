import React from 'react';

/**
 * The page list in the left nav. Deliberately FLAT for pages — full paths, sorted —
 * after the indented-tree version was rejected on sight. Modals are the one nesting
 * that earns its indent: they belong to a page (or the site) and are edited on the
 * same canvas by clicking them here.
 */
export function PageTree(props: {
  paths: string[];
  modalsOf: (path: string) => string[];
  siteModals: string[];
  current: string;
  currentModal: { site: boolean; name: string } | null;
  onOpen: (path: string) => void;
  onOpenModal: (pagePath: string | null, name: string) => void;
  onNew: () => void;
  onDelete: () => void;
  onNewModal: () => void;
  onDeleteModal: (scope: { site: boolean; name: string }) => void;
}) {
  const modalRow = (pagePath: string | null, name: string) => {
    const on = props.currentModal
      && props.currentModal.name === name
      && props.currentModal.site === (pagePath === null)
      && (pagePath === null || pagePath === props.current);
    return (
      <div key={`${pagePath ?? '@site'}#${name}`} className={'pt-row pt-modal' + (on ? ' on' : '')}>
        <button className="pt-open" title={`modal “${name}”`} onClick={() => props.onOpenModal(pagePath, name)}>
          ◇ {name}
        </button>
        {on && (
          <button className="pt-del" title={`Delete modal “${name}”`}
            onClick={() => props.onDeleteModal({ site: pagePath === null, name })}>✕</button>
        )}
      </div>
    );
  };

  return (
    <div id="pageTree">
      <div className="pt-head">
        <h2>Pages</h2>
        <button id="newPage" title="Create a page" onClick={props.onNew}>+</button>
      </div>
      {[...props.paths].sort().map((p) => (
        <React.Fragment key={p}>
          <div className={'pt-row' + (p === props.current && !props.currentModal ? ' on' : '')}>
            <button className="pt-open" title={p} onClick={() => props.onOpen(p)}>{p}</button>
            {p === props.current && !props.currentModal && (
              <button className="pt-del" title={`Delete ${p}`} onClick={props.onDelete}>✕</button>
            )}
          </div>
          {props.modalsOf(p).map((name) => modalRow(p, name))}
          {p === props.current && (
            <div className="pt-row pt-modal">
              <button className="pt-open pt-add" id="newModal" title={`Add a modal to ${p}`}
                onClick={props.onNewModal}>+ modal</button>
            </div>
          )}
        </React.Fragment>
      ))}
      {props.siteModals.length > 0 && (
        <>
          <div className="pt-site">site modals</div>
          {props.siteModals.map((name) => modalRow(null, name))}
        </>
      )}
    </div>
  );
}
