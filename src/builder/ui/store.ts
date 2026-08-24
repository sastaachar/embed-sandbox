import { useCallback, useRef, useState } from 'react';
import type { Doc, Loc, Page } from './types';

export type StatusKind = '' | 'ok' | 'err';

/**
 * The document is held mutable and edits are applied in place, with an explicit
 * re-render. Blocks are nested and edited by path; deep-cloning the tree on every
 * keystroke would cost more than it buys, and the SDK slots are keyed by path, so a
 * new object identity per edit would remount iframes for nothing.
 */
export function useBuilder() {
  const doc = useRef<Doc | null>(null);
  const [, force] = useState(0);
  const [path, setPath] = useState('/');
  // Non-null while the canvas edits a modal's blocks instead of the page's.
  const [modal, setModal] = useState<{ site: boolean; name: string } | null>(null);
  const [sel, setSel] = useState<Loc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatusState] = useState<{ text: string; kind: StatusKind }>({ text: '', kind: '' });

  const render = useCallback(() => force((n) => n + 1), []);

  const setStatus = useCallback((text: string, kind: StatusKind = '') => {
    setStatusState({ text, kind });
  }, []);

  const touched = useCallback(() => {
    setDirty(true);
    setStatusState({ text: 'unsaved changes', kind: '' });
  }, []);

  const page = useCallback((): Page => {
    const d = doc.current!;
    if (!d.pages[path]) d.pages[path] = { title: path, blocks: [] };
    const p = d.pages[path];
    if (!p.blocks) p.blocks = [];
    return p;
  }, [path]);

  return {
    doc, page, path, setPath, modal, setModal, sel, setSel, dirty, setDirty,
    status, setStatus, touched, render,
  };
}

export type Builder = ReturnType<typeof useBuilder>;
