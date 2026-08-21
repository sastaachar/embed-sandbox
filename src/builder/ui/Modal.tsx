import React, { useEffect } from 'react';

/**
 * No native dialogs anywhere: window.confirm is unstyleable, blocks the event loop and
 * is suppressed outright in some embedded contexts. Escape and a backdrop click close.
 */
export function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div id="mask" className="mask" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div id="maskBody" className="dlg" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

/**
 * Cheap update per keystroke, expensive commit on blur or Enter — remounting an iframe
 * on every character would be unusable and would steal focus.
 */
export function CommitInput(props: {
  value: string;
  onInput?: (v: string) => void;
  onCommit: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  const [local, setLocal] = React.useState(props.value);
  React.useEffect(() => { setLocal(props.value); }, [props.value]);
  return (
    <input
      type={props.type || 'text'}
      value={local}
      placeholder={props.placeholder}
      onChange={(e) => { setLocal(e.target.value); props.onInput?.(e.target.value); }}
      onBlur={() => props.onCommit(local)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}
