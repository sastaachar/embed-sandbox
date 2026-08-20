import React, { useEffect, useState } from 'react';
import type { Doc, Page } from './types';

type Scope = 'page' | 'app';

/**
 * The same JSON the document API stores, edited in place. Everything needed to
 * recreate what is on the canvas is in here — rows with their columns and spans, each
 * block's position in document order, embed sizes — so this view round-trips: copy it
 * out, paste it back, and you get the same page.
 */
export function JsonPanel(props: {
  doc: Doc;
  path: string;
  page: Page;
  dirtyKey: number;
  onApply: (scope: Scope, parsed: any) => Promise<void>;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<Scope>('page');

  const source = (sc: Scope = scope) =>
    sc === 'page'
      ? JSON.stringify(props.page, null, 2)
      : JSON.stringify({ config: props.doc.config, pages: props.doc.pages }, null, 2);

  // Seeded on first render, not from the effect below: an effect leaves one paint where
  // the textarea is empty, and reading it in that window yields "".
  const [text, setText] = useState(() => source('page'));
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');

  // Re-read whenever the canvas changes underneath it, so the JSON is never a stale
  // snapshot of a page you have since edited.
  useEffect(() => { setText(source()); setErr(''); }, [scope, props.path, props.dirtyKey]);

  const apply = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text || (scope === 'page' ? '{}' : '{}'));
    } catch (e) {
      setErr((e as Error).message);
      return;
    }
    setErr('');
    try {
      await props.onApply(scope, parsed);
      setSaved('applied');
      setTimeout(() => setSaved(''), 1500);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <section className="pane json-pane" id="jsonPane">
      <div className="json-head">
        <h2>JSON</h2>
        <div className="json-scope">
          <button
            className={scope === 'page' ? 'on' : ''}
            onClick={() => setScope('page')}
          >
            This page
          </button>
          <button
            className={scope === 'app' ? 'on' : ''}
            onClick={() => setScope('app')}
          >
            Whole app
          </button>
        </div>
        <span className="sp" />
        <span className="json-path mono">{scope === 'page' ? props.path : 'config + every page'}</span>
        <button onClick={() => setText(source())}>Revert</button>
        <button className="primary" id="jsonApply" onClick={apply}>Apply</button>
        <button onClick={props.onClose}>Close</button>
      </div>
      {err && <p className="dlg-err" id="jsonErr">{err}</p>}
      {saved && <p className="dlg-ok">{saved}</p>}
      <textarea
        id="jsonText"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            e.stopPropagation();
            void apply();
          }
        }}
      />
    </section>
  );
}
