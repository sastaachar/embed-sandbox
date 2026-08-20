import React from 'react';
import type { Block, Doc, EmbedAction, EmbedSpec, EmbedType, Loc, Page } from './types';
import { DEFAULT_EMBED_HEIGHT } from './types';
import { listKey, setEmbedType } from './blocks';
import { CommitInput, Field } from './Modal';
import spec from './spec.json';
import { ActionsEditor } from './Actions';
import { variableKeys } from './vars';

type FieldSpec = {
  key: string; label: string; kind: string; options?: [string, string][];
  number?: boolean; note?: string; hideWhen?: string; placeholder?: string;
  default?: string; advanced?: boolean; metadataType?: string; max?: number; in?: string;
};

const EMBED_TYPES = (spec as any).embedTypes as Array<{
  type: EmbedType; label: string; blurb: string; idKey: string;
  metadataType: string | null; fields: FieldSpec[];
}>;
const EMBED_COMMON = (spec as any).embedCommon as FieldSpec[];
const BLOCK_FIELDS = (spec as any).blockFields as Record<string, FieldSpec[]>;

export function typeSpec(type: string) {
  return EMBED_TYPES.find((t) => t.type === type) || EMBED_TYPES[0];
}

interface PropsPanelProps {
  doc: Doc;
  lib: any;
  page: Page;
  block: Block | null;
  sel: Loc | null;
  onChange: () => void;
  onRerender: () => void;
  onDelete: () => void;
  onSideBySide: () => void;
  onFullWidth: () => void;
  onPickMetadata: (metadataType: string, onPick: (id: string) => void) => void;
  onTitleChange: (title: string) => void;
}

export function PropsPanel(p: PropsPanelProps) {
  if (!p.block || p.sel == null) {
    return (
      <section className="pane props" id="props">
        <h2>Page</h2>
        <Field label="Page title">
          <CommitInput value={p.page.title || ''} onCommit={p.onTitleChange} />
        </Field>
        <p className="hint">Select a block to edit it, or add one from the left.</p>
      </section>
    );
  }

  const block = p.block;
  const inColumn = listKey(p.sel) !== '';

  return (
    <section className="pane props" id="props">
      <h2>{block.type === 'embed' ? `${block.embed!.type} embed` : block.type}</h2>
      <div className="prop-actions">
        <button className="danger" onClick={p.onDelete}>Delete</button>
        <button onClick={p.onSideBySide}>
          {block.type === 'embed' ? '+ Embed beside' : 'Side by side'}
        </button>
        {inColumn && <button onClick={p.onFullWidth}>Full width</button>}
      </div>

      {block.type === 'embed'
        ? <EmbedFields {...p} spec={block.embed!} />
        : <BlockFields {...p} block={block} />}
    </section>
  );
}

function BlockFields(p: PropsPanelProps & { block: Block }) {
  const fields = BLOCK_FIELDS[p.block.type] || [];
  if (p.block.type === 'buttons') return <ButtonsFields {...p} block={p.block} />;
  return (
    <>
      {fields.map((f) => (
        <GenericField key={f.key} field={f} target={p.block as Record<string, unknown>} {...p} />
      ))}
    </>
  );
}

/** Each button is a label and a list of actions — the same list an event handler runs. */
function ButtonsFields(p: PropsPanelProps & { block: Block }) {
  const items = (p.block.items ?? []) as Array<Record<string, any>>;
  const vars = variableKeys(p.doc);
  const commit = () => { p.onChange(); p.onRerender(); };
  return (
    <>
      <Field label="Alignment">
        <select
          value={String((p.block as any).align ?? '')}
          onChange={(e) => {
            if (e.target.value) (p.block as any).align = e.target.value;
            else delete (p.block as any).align;
            commit();
          }}
        >
          <option value="">left</option>
          <option value="center">center</option>
          <option value="right">right</option>
        </select>
      </Field>

      {items.map((item, i) => (
        <div className="button-card" key={i}>
          <div className="action-head">
            <strong>{item.label || '(no label)'}</strong>
            <span className="sp" />
            <button className="danger" title="Remove this button"
              onClick={() => { items.splice(i, 1); commit(); }}>✕</button>
          </div>
          <Field label="Label">
            <CommitInput value={String(item.label ?? '')} onCommit={(v) => { item.label = v; commit(); }} />
          </Field>
          <Field label="Style">
            <select value={String(item.variant ?? '')}
              onChange={(e) => { if (e.target.value) item.variant = e.target.value; else delete item.variant; commit(); }}>
              <option value="">default</option>
              <option value="primary">primary</option>
              <option value="secondary">secondary</option>
              <option value="ghost">ghost</option>
            </select>
          </Field>
          <ActionsEditor
            actions={item.actions as EmbedAction[]}
            context="button"
            doc={p.doc}
            page={p.page}
            lib={p.lib}
            variables={vars}
            onChange={(next) => { item.actions = next; }}
            onRerender={commit}
          />
        </div>
      ))}

      <div className="dlg-row">
        <button onClick={() => { items.push({ label: 'Button', actions: [] }); (p.block as any).items = items; commit(); }}>
          + Button
        </button>
      </div>
    </>
  );
}

function EmbedFields(p: PropsPanelProps & { spec: EmbedSpec }) {
  const s = p.spec;
  const t = typeSpec(s.type);
  const shown = t.fields.filter((f) => !f.advanced);
  // Type fields are SDK params, so they edit spec.config; the common ones are the
  // runtime's own, except fullHeight which the spec marks with in: "config".
  const targetFor = (f: FieldSpec) =>
    (f.in === 'config' ? s.config : (s as unknown as Record<string, unknown>));

  return (
    <>
      <Field label="Embed type">
        <select
          value={s.type}
          onChange={(e) => {
            setEmbedType(p.block!, e.target.value as EmbedType);
            p.onRerender();
          }}
        >
          {EMBED_TYPES.map((t2) => <option key={t2.type} value={t2.type}>{t2.label}</option>)}
        </select>
      </Field>

      <Field label="Name">
        <input
          value={s.name || ''}
          placeholder="(addressed by index)"
          onChange={(e) => {
            if (e.target.value) s.name = e.target.value; else delete s.name;
            p.onRerender();
          }}
        />
      </Field>

      {shown.map((f) => (
        <GenericField key={f.key} field={f} target={s.config} {...p} />
      ))}

      {EMBED_COMMON.map((f) => {
        if (f.hideWhen && s.config[f.hideWhen]) {
          return <p className="hint" key={f.key}>{noteFor(f.hideWhen)}</p>;
        }
        return <GenericField key={f.key} field={f} target={targetFor(f)} {...p} />;
      })}

      <p className="hint">Or drag the bottom-right corner of the box on the canvas.</p>

      <EmbedHandlers {...p} spec={s} />

      <Field label="SDK config (JSON)">
        <JsonBox
          value={s.config}
          onCommit={(parsed) => {
            s.config = parsed && typeof parsed === 'object' ? parsed : {};
            p.onRerender();
          }}
        />
      </Field>
    </>
  );
}

const COMMON_EMBED_EVENTS = [
  'Data', 'CustomAction', 'VizPointClick', 'VizPointDoubleClick', 'FilterChanged',
  'RouteChange', 'Drilldown', 'Save', 'Error', 'Load',
];

function embedEventNames(lib: any): string[] {
  const fromSdk = lib?.EmbedEvent ? Object.keys(lib.EmbedEvent) : [];
  return fromSdk.length ? fromSdk.sort() : COMMON_EMBED_EVENTS;
}

/** What the embed does when it emits something — the other half of the action picker. */
function EmbedHandlers(p: PropsPanelProps & { spec: EmbedSpec }) {
  const handlers = p.spec.embedEventHandlers ?? [];
  const vars = variableKeys(p.doc);
  const commit = () => { p.onChange(); p.onRerender(); };
  const write = (next: typeof handlers) => {
    if (next.length) p.spec.embedEventHandlers = next;
    else delete p.spec.embedEventHandlers;
    commit();
  };

  return (
    <>
      <h3 className="props-sub">When this embed emits…</h3>
      {handlers.length === 0 && (
        <p className="hint">Nothing wired. Add a handler to react to an event from the embed.</p>
      )}
      {handlers.map((h, i) => (
        <div className="button-card" key={i}>
          <div className="action-head">
            <select
              value={h.type}
              onChange={(e) => { h.type = e.target.value; commit(); }}
            >
              {embedEventNames(p.lib).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span className="sp" />
            <button className="danger" title="Remove this handler"
              onClick={() => write(handlers.filter((_, j) => j !== i))}>✕</button>
          </div>
          <Field label="Only when action id is">
            <CommitInput
              value={h.id ?? ''}
              onCommit={(v) => { if (v) h.id = v; else delete h.id; commit(); }}
            />
          </Field>
          <ActionsEditor
            actions={h.actions}
            context="event"
            doc={p.doc}
            page={p.page}
            lib={p.lib}
            variables={vars}
            onChange={(next) => { h.actions = next; }}
            onRerender={commit}
          />
        </div>
      ))}
      <div className="dlg-row">
        <button id="addHandler" onClick={() => write([...handlers, { type: 'Data', actions: [] }])}>
          + Handler
        </button>
      </div>
    </>
  );
}

function noteFor(key: string): string {
  const f = EMBED_COMMON.find((x) => x.key === key);
  return f?.note || '';
}

function GenericField(p: PropsPanelProps & { field: FieldSpec; target: Record<string, unknown> }) {
  const { field: f, target } = p;
  const value = target[f.key];

  switch (f.kind) {
    case 'checkbox':
      return (
        <label className="checkline">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => {
              if (e.target.checked) target[f.key] = true; else delete target[f.key];
              p.onRerender();
            }}
          />
          {f.label}
        </label>
      );

    case 'select':
      return (
        <Field label={f.label}>
          <select
            value={String(value ?? (f.options?.[0]?.[0] ?? ''))}
            onChange={(e) => {
              const v: string | number = f.number ? Number(e.target.value) : e.target.value;
              if (v === '') delete target[f.key]; else target[f.key] = v;
              p.onRerender();
            }}
          >
            {(f.options || []).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </Field>
      );

    case 'textarea':
      return (
        <Field label={f.label}>
          <textarea
            rows={4}
            value={String(value ?? '')}
            onChange={(e) => { target[f.key] = e.target.value; p.onChange(); }}
          />
        </Field>
      );

    case 'length':
      return (
        <Field label={f.label}>
          <CommitInput
            value={String(value ?? (f.default ?? ''))}
            placeholder={f.placeholder}
            onCommit={(v) => {
              const next = v.trim();
              if (!next || next === f.placeholder) delete target[f.key];
              else target[f.key] = /^[0-9.]+$/.test(next) ? `${next}px` : next;
              p.onRerender();
            }}
          />
        </Field>
      );

    case 'metadata':
      return (
        <Field label={f.label}>
          <div className="row">
            <CommitInput
              value={String(value ?? '')}
              onInput={(v) => { target[f.key] = v; p.onChange(); }}
              onCommit={() => p.onRerender()}
            />
            <button
              className="pick-btn"
              onClick={() => p.onPickMetadata(f.metadataType || 'LIVEBOARD', (id) => {
                target[f.key] = id;
                p.onRerender();
              })}
            >
              Pick…
            </button>
          </div>
        </Field>
      );

    case 'json':
      return (
        <Field label={f.label}>
          <JsonBox value={value} onCommit={(parsed) => { target[f.key] = parsed; p.onRerender(); }} />
        </Field>
      );

    case 'columns':
      return (
        <Field label={f.label}>
          <select
            value={String(((target.columns as unknown[]) || []).length)}
            onChange={(e) => {
              const n = Number(e.target.value);
              const cols = (target.columns as Array<{ blocks: Block[] }>) || [];
              while (cols.length < n) cols.push({ blocks: [] });
              while (cols.length > n) {
                const dropped = cols.pop();
                (dropped?.blocks || []).forEach((b) => cols[cols.length - 1].blocks.push(b));
              }
              target.columns = cols;
              p.onRerender();
            }}
          >
            {['1', '2', '3', '4'].slice(0, f.max || 4).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
      );

    default:
      return (
        <Field label={f.label}>
          <CommitInput
            value={String(value ?? '')}
            onInput={(v) => { target[f.key] = v; p.onChange(); }}
            onCommit={() => p.onRerender()}
          />
        </Field>
      );
  }
}

function JsonBox({ value, onCommit }: { value: unknown; onCommit: (parsed: any) => void }) {
  const initial = value === undefined ? '{}' : JSON.stringify(value, null, 2);
  const [text, setText] = React.useState(initial);
  const [err, setErr] = React.useState('');
  React.useEffect(() => { setText(initial); }, [initial]);
  return (
    <>
      <textarea
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            onCommit(JSON.parse(text || '{}'));
            setErr('');
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
      />
      {err && <p className="dlg-err">{err}</p>}
    </>
  );
}
