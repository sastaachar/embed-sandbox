import React, { useEffect, useState } from 'react';
import { PID } from './api';

/*
 * The page as SDK code you could paste into your own app. Generated from the same
 * document the canvas renders, so it cannot drift from what you are looking at.
 */

type Flavor = 'react' | 'esm';

const LABEL: Record<Flavor, string> = { react: 'React', esm: 'JavaScript' };
const BLURB: Record<Flavor, string> = {
  react: 'Components from @thoughtspot/visual-embed-sdk/react, with useEmbedRef for host events.',
  esm: 'The plain SDK: construct an embed, call render(), trigger() from your own buttons.',
};

export function CodePanel(props: { path: string; onClose: () => void }) {
  const [flavor, setFlavor] = useState<Flavor>('react');
  const [code, setCode] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    setCode(null);
    setErr('');
    fetch(`/api/projects/${PID}/code?path=${encodeURIComponent(props.path)}&flavor=${flavor}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('could not generate the code'))))
      .then((body) => { if (live) setCode(body.code ?? ''); })
      .catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [flavor, props.path]);

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

      <pre className="code-out" id="codeOut">{code === null ? 'generating…' : code}</pre>
    </section>
  );
}
