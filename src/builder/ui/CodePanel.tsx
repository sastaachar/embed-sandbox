import React, { useEffect, useState } from 'react';
import { PID } from './api';

/*
 * The page as SDK code you could paste into your own app. Generated from the same
 * document the canvas renders, so it cannot drift from what you are looking at.
 */

type Flavor = 'react' | 'esm';

// Same lazy Prism the published site's ‹/› overlay uses: loaded from jsDelivr only
// when the panel first needs it, so the builder never pays for it up front.
const PRISM_BASE = 'https://cdn.jsdelivr.net/npm/prismjs@1.29.0';
let prismReady: Promise<any> | null = null;

function ensurePrism(): Promise<any> {
  if (prismReady) return prismReady;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = `${PRISM_BASE}/themes/prism-tomorrow.min.css`;
  document.head.appendChild(css);
  const parts = ['/components/prism-core.min.js', '/components/prism-markup.min.js',
    '/components/prism-clike.min.js', '/components/prism-javascript.min.js',
    '/components/prism-jsx.min.js'];
  prismReady = parts
    .reduce(
      (chain, part) => chain.then(() => new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PRISM_BASE + part;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('prism failed to load'));
        document.head.appendChild(s);
      })),
      Promise.resolve(),
    )
    .then(() => (window as any).Prism);
  return prismReady;
}

const LABEL: Record<Flavor, string> = { react: 'React', esm: 'JavaScript' };
const BLURB: Record<Flavor, string> = {
  react: 'Components from @thoughtspot/visual-embed-sdk/react, with useEmbedRef for host events.',
  esm: 'The plain SDK: construct an embed, call render(), trigger() from your own buttons.',
};

/** A page may ship hand-written code for one flavour; open on that one. */
function authoredFlavor(over: Record<string, unknown> | undefined): Flavor | null {
  if (!over) return null;
  for (const f of ['react', 'esm'] as Flavor[]) if (over[f]) return f;
  return null;
}

export function CodePanel(props: {
  path: string;
  onClose: () => void;
  codeOverride?: Record<string, unknown>;
}) {
  const [flavor, setFlavor] = useState<Flavor>(authoredFlavor(props.codeOverride) ?? 'react');
  const [note, setNote] = useState('');
  // The JS flavour has two halves: the code, and the markup it targets.
  const [part, setPart] = useState<'js' | 'html'>('js');
  const [code, setCode] = useState<string | null>(null);
  // Prism's output, or null when it has not loaded (CDN blocked) — plain text then.
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  const htmlPart = flavor === 'esm' && part === 'html';

  useEffect(() => {
    let live = true;
    setCode(null);
    setHtml(null);
    setErr('');
    const q = htmlPart ? '&part=html' : '';
    fetch(`/api/projects/${PID}/code?path=${encodeURIComponent(props.path)}&flavor=${flavor}${q}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('could not generate the code'))))
      .then((body) => {
        if (!live) return;
        setCode(body.code ?? '');
        setNote(body.overridden
          ? (body.note || 'Hand-written for this page, not the generated export.')
          : '');
      })
      .catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [flavor, htmlPart, props.path]);

  useEffect(() => {
    if (code === null) return;
    let live = true;
    // Prism escapes what it tokenizes, so its output is safe to inject.
    ensurePrism()
      .then((P) => {
        if (!live) return;
        const lang = htmlPart ? 'markup' : 'jsx';
        setHtml(P.highlight(code, P.languages[lang], lang));
      })
      .catch(() => { /* CDN unreachable: the plain <pre> below already shows the code */ });
    return () => { live = false; };
  }, [code]);

  const copy = () => {
    if (!code) return;
    navigator.clipboard.writeText(code).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => setErr('could not copy — select it by hand'),
    );
  };

  return (
    <section className="pane code-pane" id="codePane">
      <div className="code-head">
        <h2>Code</h2>
        <div className="seg">
          {(['react', 'esm'] as Flavor[]).map((f) => (
            <button
              key={f}
              className={flavor === f ? 'on' : ''}
              title={props.codeOverride?.[f] ? 'Hand-written for this page' : undefined}
              id={`flavor-${f}`}
              onClick={() => { setFlavor(f); setPart('js'); }}
            >
              {LABEL[f]}{props.codeOverride?.[f] ? ' •' : ''}
            </button>
          ))}
        </div>
        {flavor === 'esm' && (
          <div className="seg" id="jsPartSeg">
            <button className={part === 'js' ? 'on' : ''} id="part-js" onClick={() => setPart('js')}>JS</button>
            <button className={part === 'html' ? 'on' : ''} id="part-html" onClick={() => setPart('html')}>HTML</button>
          </div>
        )}
        <span className="code-path mono">{props.path}</span>
        <span className="sp" />
        <button onClick={copy} disabled={!code}>{copied ? 'Copied' : 'Copy'}</button>
        <button onClick={props.onClose}>Close</button>
      </div>

      <p className="hint">
        {note || (htmlPart
          ? 'The elements the JS selectors point at — paste this beside the code.'
          : BLURB[flavor])}
      </p>
      {err && <p className="dlg-err">{err}</p>}

      {html !== null ? (
        <pre className="code-out" id="codeOut" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-out" id="codeOut">{code === null ? 'generating…' : code}</pre>
      )}
    </section>
  );
}
