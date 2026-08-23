import React, { useState } from 'react';
import type { Doc, EmbedAction, Page } from './types';
import { CommitInput, Field } from './Modal';

/*
 * One editor for the one action vocabulary, used by buttons and by embed event handlers.
 * The difference between them is a single field: a `set` on a button writes the literal
 * you type, while a `set` in a handler reads a path out of the event payload — or, when
 * its source is "literal", writes an exact value. The field is labelled for what it
 * actually does in each place.
 */

export type ActionContext = 'button' | 'event';

const TYPES: Array<{ type: EmbedAction['type']; label: string; blurb: string }> = [
  { type: 'nav', label: 'Go to page', blurb: 'Navigate within this site' },
  { type: 'HostEvent', label: 'Host event', blurb: 'Send a HostEvent to one or more embeds' },
  { type: 'set', label: 'Set value', blurb: 'Write into the value store' },
  { type: 'open-modal', label: 'Open modal', blurb: 'Show a modal defined on this page' },
  { type: 'close-modal', label: 'Close modal', blurb: 'Close whatever is open' },
  { type: 'open-url', label: 'Open URL', blurb: 'Leave the site' },
];

/** Falls back to the names worth offering when the SDK has not loaded yet. */
const COMMON_HOST_EVENTS = [
  'Reload', 'Edit', 'Save', 'Pin', 'Print', 'DownloadAsPdf', 'DownloadAsPng', 'DownloadAsCsv',
  'UpdateFilters', 'SetVisibleVizs', 'Navigate', 'GetTML', 'UpdateParameters',
];

function hostEventNames(lib: any): string[] {
  const fromSdk = lib?.HostEvent ? Object.keys(lib.HostEvent) : [];
  return fromSdk.length ? fromSdk.sort() : COMMON_HOST_EVENTS;
}

function emptyAction(type: EmbedAction['type']): EmbedAction {
  switch (type) {
    case 'nav': return { type, params: { to: '/' } };
    case 'HostEvent': return { type, params: { type: 'Reload' } };
    case 'set': return { type, params: { key: '', value: '' } };
    case 'open-modal': return { type, params: { name: '' } };
    case 'close-modal': return { type, params: {} };
    default: return { type, params: { url: 'https://' } };
  }
}

/** Every embed on the page that can be addressed, so targets are picked not typed. */
function embedTargets(page: Page): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const walk = (blocks: any[] | undefined) => {
    for (const b of blocks ?? []) {
      if (b.type === 'embed') {
        const idx = out.length;
        out.push({
          value: b.embed?.name || String(idx),
          label: b.embed?.name ? `${b.embed.name} (${b.embed.type})` : `#${idx} — ${b.embed?.type} (unnamed)`,
        });
      } else if (b.type === 'row') {
        for (const col of b.columns ?? []) walk(col.blocks);
      }
    }
  };
  walk(page.blocks);
  return out;
}

function JsonField({ label, value, onCommit, hint }: {
  label: string; value: unknown; onCommit: (v: unknown) => void; hint?: string;
}) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [err, setErr] = useState('');
  return (
    <Field label={label}>
      <textarea
        rows={6}
        className="mono"
        value={text}
        placeholder="(none)"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!text.trim()) { setErr(''); onCommit(undefined); return; }
          try { onCommit(JSON.parse(text)); setErr(''); } catch (e) { setErr((e as Error).message); }
        }}
      />
      {err ? <p className="dlg-err">{err}</p> : hint ? <p className="hint">{hint}</p> : null}
    </Field>
  );
}

function ActionRow(props: {
  action: EmbedAction;
  context: ActionContext;
  doc: Doc;
  page: Page;
  lib: any;
  variables: string[];
  onChange: () => void;
  onRemove: () => void;
  onMove: (by: number) => void;
}) {
  const { action, context, page, lib } = props;
  const p = action.params as Record<string, any>;
  const set = (patch: Record<string, unknown>) => {
    Object.assign(action.params, patch);
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete action.params[k];
    props.onChange();
  };
  const targets: string[] = Array.isArray(p.targets) ? p.targets.map(String) : [];
  const options = embedTargets(page);

  return (
    <div className="action">
      <div className="action-head">
        <select
          className="action-type"
          value={action.type}
          onChange={(e) => {
            const next = emptyAction(e.target.value as EmbedAction['type']);
            action.type = next.type;
            action.params = next.params;
            props.onChange();
          }}
        >
          {TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
        <span className="sp" />
        <button title="Move up" onClick={() => props.onMove(-1)}>↑</button>
        <button title="Move down" onClick={() => props.onMove(1)}>↓</button>
        <button className="danger" title="Remove" onClick={props.onRemove}>✕</button>
      </div>

      {action.type === 'nav' && (
        <Field label="Page">
          <select value={String(p.to ?? '/')} onChange={(e) => set({ to: e.target.value })}>
            {Object.keys(props.doc.pages).sort().map((path) => (
              <option key={path} value={path}>{path}</option>
            ))}
          </select>
        </Field>
      )}

      {action.type === 'HostEvent' && (
        <>
          <Field label="HostEvent">
            <select value={String(p.type ?? 'Reload')} onChange={(e) => set({ type: e.target.value })}>
              {hostEventNames(lib).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
          <Field label="Send to">
            <select
              multiple
              size={Math.min(4, Math.max(2, options.length + 1))}
              value={targets.length ? targets : ['']}
              onChange={(e) => {
                const picked = [...e.target.selectedOptions].map((o) => o.value).filter(Boolean);
                set({ targets: picked.length ? picked : undefined });
              }}
            >
              <option value="">First embed (default)</option>
              <option value="all">All embeds on the page</option>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <JsonField
            label="Payload (optional)"
            value={p.payload}
            hint='Leave empty for events that take none. UpdateFilters wants {"filters":[{"columnName":"Color","operator":"IN","values":["blue"]}]}'
            onCommit={(v) => set({ payload: v })}
          />
        </>
      )}

      {action.type === 'set' && (
        <>
          <Field label="Value key">
            <input
              list="sb-var-keys"
              value={String(p.key ?? '')}
              placeholder="e.g. region"
              onChange={(e) => set({ key: e.target.value })}
            />
          </Field>
          {context === 'event' ? (
            <>
              <Field label="Source">
                <select
                  value={'literal' in p ? 'literal' : 'payload'}
                  onChange={(e) => {
                    if (e.target.value === 'literal') set({ literal: '', value: undefined });
                    else set({ value: '', literal: undefined });
                  }}
                >
                  <option value="payload">From the event payload</option>
                  <option value="literal">A literal value</option>
                </select>
              </Field>
              {'literal' in p ? (
                <JsonField
                  label="Value"
                  value={p.literal}
                  hint='Written as given when the event fires — e.g. "Liveboard is loaded".'
                  onCommit={(v) => set({ literal: v === undefined ? '' : v })}
                />
              ) : (
                <Field label="From payload">
                  <input
                    value={String(p.value ?? '')}
                    placeholder="payload.data.id — blank for the whole payload"
                    onChange={(e) => set({ value: e.target.value })}
                  />
                </Field>
              )}
            </>
          ) : (
            <JsonField label="Value" value={p.value} hint="A literal: a string, number, or JSON."
              onCommit={(v) => set({ value: v })} />
          )}
        </>
      )}

      {(action.type === 'open-modal' || action.type === 'close-modal') && (
        <Field label={action.type === 'open-modal' ? 'Modal' : 'Modal (optional)'}>
          <select value={String(p.name ?? '')} onChange={(e) => set({ name: e.target.value || undefined })}>
            <option value="">{action.type === 'open-modal' ? '(pick one)' : 'whatever is open'}</option>
            {Object.keys({ ...(props.doc.config.modals as object || {}), ...(page.modals || {}) })
              .map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
      )}

      {action.type === 'open-url' && (
        <>
          <Field label="URL">
            <CommitInput value={String(p.url ?? '')} onCommit={(v) => set({ url: v })} />
          </Field>
          <Field label="Target">
            <select value={String(p.target ?? '_blank')} onChange={(e) => set({ target: e.target.value })}>
              <option value="_blank">New tab</option>
              <option value="_self">This tab</option>
            </select>
          </Field>
        </>
      )}
    </div>
  );
}

export function ActionsEditor(props: {
  actions: EmbedAction[] | undefined;
  context: ActionContext;
  doc: Doc;
  page: Page;
  lib: any;
  variables: string[];
  onChange: (next: EmbedAction[]) => void;
  onRerender: () => void;
}) {
  const list = props.actions ?? [];
  const commit = (next: EmbedAction[]) => { props.onChange(next); props.onRerender(); };

  return (
    <div className="actions-editor">
      {/* Shared by every key input, so a variable is picked rather than remembered. */}
      <datalist id="sb-var-keys">
        {props.variables.map((v) => <option key={v} value={v} />)}
      </datalist>

      {list.length === 0 && <p className="hint">Does nothing yet — add an action.</p>}
      {list.map((action, i) => (
        <ActionRow
          key={i}
          action={action}
          context={props.context}
          doc={props.doc}
          page={props.page}
          lib={props.lib}
          variables={props.variables}
          onChange={props.onRerender}
          onRemove={() => commit(list.filter((_, j) => j !== i))}
          onMove={(by) => {
            const to = i + by;
            if (to < 0 || to >= list.length) return;
            const next = [...list];
            [next[i], next[to]] = [next[to], next[i]];
            commit(next);
          }}
        />
      ))}
      <div className="dlg-row">
        {TYPES.slice(0, 3).map((t) => (
          <button key={t.type} title={t.blurb} onClick={() => commit([...list, emptyAction(t.type)])}>
            + {t.label}
          </button>
        ))}
        <select
          className="add-more"
          value=""
          onChange={(e) => { if (e.target.value) commit([...list, emptyAction(e.target.value as EmbedAction['type'])]); }}
        >
          <option value="">+ more…</option>
          {TYPES.slice(3).map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
      </div>
    </div>
  );
}
