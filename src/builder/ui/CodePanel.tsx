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

export function CodePanel(props: { path: string; onClose: () => void }) {
  const [flavor, setFlavor] = useState<Flavor>('react');
  const [code, setCode] = useState<string | null>(null);
  // Prism's output, or null when it has not loaded (CDN blocked) — plain text then.
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    setCode(null);
    setHtml(null);
    setErr('');
    fetch(`/api/projects/${PID}/code?path=${encodeURIComponent(props.path)}&flavor=${flavor}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('could not generate the code'))))
      .then((body) => { if (live) setCode(body.code ?? ''); })
      .catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [flavor, props.path]);

  useEffect(() => {
    if (code === null) return;
    let live = true;
    // Prism escapes what it tokenizes, so its output is safe to inject.
    ensurePrism()
      .then((P) => { if (live) setHtml(P.highlight(code, P.languages.jsx, 'jsx')); })
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
              id={`flavor-${f}`}
              onClick={() => setFlavor(f)}
            >
              {LABEL[f]}
            </button>
          ))}
        </div>
        <span className="code-path mono">{props.path}</span>
        <span className="sp" />
        <button onClick={copy} disabled={!code}>{copied ? 'Copied' : 'Copy'}</button>
        <button onClick={props.onClose}>Close</button>
      </div>

      <p className="hint">{BLURB[flavor]}</p>
      {err && <p className="dlg-err">{err}</p>}

      {html !== null ? (
        <pre className="code-out" id="codeOut" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-out" id="codeOut">{code === null ? 'generating…' : code}</pre>
      )}
    </section>
  );
}
