import React, { useEffect, useRef } from 'react';
import type { Block, EmbedSpec, Loc } from './types';
import { DEFAULT_EMBED_HEIGHT } from './types';
import { indexAt, listFromKey, listKey } from './blocks';
import { hasToken, interpolate } from './vars';
import * as sdk from './sdk';
import spec from './spec.json';

declare const Sortable: any;
declare const interact: any;
/** /_static/live/markdown.js — the published page's renderer, loaded by the shell. */
declare const SBMarkdown: { render: (node: HTMLElement, src: string) => void } | undefined;

interface CanvasProps {
  blocks: Block[];
  sel: Loc | null;
  onSelect: (loc: Loc) => void;
  onMove: (fromLoc: Loc, destKey: string, destIndex: number) => void;
  onResize: (loc: Loc, height: string, width: string | null) => void;
  lib: any;
  mountError: string | null;
  /** The project's declared variable defaults — what a first-time visitor resolves. */
  vars: Record<string, string>;
}

const TYPE_OF = (b: Block) => (b.type === 'embed' ? `${b.embed!.type}Embed` : b.type);

export function Canvas(props: CanvasProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const sortables = useRef<any[]>([]);
  const dragFrom = useRef<Loc | null>(null);

  useEffect(() => { sdk.watchLayout(); }, []);

  // Sortable binds to ELEMENTS, so it is re-wired after every render. interact.js binds
  // to a selector and is wired once, in App.
  //
  // Never while a drag is in flight, though: destroying the instance mid-drag drops the
  // drop. Any render can land there — an SDK auth event resolving is enough — and the
  // symptom is a drag that simply does nothing.
  useEffect(() => {
    if (typeof Sortable === 'undefined') return;
    if (dragFrom.current !== null) return;
    const wire = (container: HTMLElement, key: string) => {
      container.dataset.key = key;
      sortables.current.push(Sortable.create(container, {
        group: {
          name: 'sb-blocks',
          put: (to: any, _from: any, dragEl: HTMLElement) =>
            !(dragEl.dataset.type === 'row' && to.el.dataset.key !== ''),
        },
        draggable: '.card',
        handle: '.grip, .embed-head .g',
        animation: 150,
        swapThreshold: 0.7,
        emptyInsertThreshold: 14,
        forceFallback: true,
        fallbackTolerance: 4,
        fallbackOnBody: true,
        onStart: (evt: any) => {
          dragFrom.current = evt.item.dataset.loc;
          document.body.classList.add('dragging-any');
          document.querySelectorAll('.col-wrap').forEach((c) => c.classList.add('drop-hint'));
        },
        onEnd: (evt: any) => {
          document.body.classList.remove('dragging-any');
          document.querySelectorAll('.drop-hint').forEach((c) => c.classList.remove('drop-hint'));
          const from = dragFrom.current;
          dragFrom.current = null;
          if (from == null) { sdk.resync(); return; }

          const destKey = evt.to.dataset.key as string;
          let destIndex = 0;
          for (const child of Array.from(evt.to.children) as HTMLElement[]) {
            if (child === evt.item) break;
            if (child.classList.contains('card')) destIndex++;
          }

          // Sortable has already moved the node, but React owns this DOM: leaving the
          // node where Sortable put it makes React's next removeChild throw NotFoundError.
          // Put it back and let the re-render from data place it.
          const home = evt.from as HTMLElement;
          const at = home.children[evt.oldIndex] || null;
          evt.item.parentNode?.removeChild(evt.item);
          home.insertBefore(evt.item, at);

          if (destKey === listKey(from) && destIndex === indexAt(from)) { sdk.resync(); return; }
          props.onMove(from, destKey, destIndex);
        },
      }));
    };

    const sheet = sheetRef.current;
    if (sheet) wire(sheet, '');
    document.querySelectorAll<HTMLElement>('.col-wrap[data-colkey]').forEach((el) => {
      wire(el, el.dataset.colkey!);
    });
    return () => {
      if (dragFrom.current !== null) return;
      sortables.current.forEach((s) => { try { s.destroy(); } catch { /* already gone */ } });
      sortables.current = [];
    };
  });

  return (
    <section className="pane stage">
      <div className="sheet" id="sheet" ref={sheetRef}>
        {props.blocks.map((b, i) => (
          <Card key={i} block={b} loc={String(i)} {...props} />
        ))}
      </div>
      {props.blocks.length === 0 && (
        <p className="empty-hint" id="emptyHint">Nothing on this page yet — add a block from the left.</p>
      )}
    </section>
  );
}

function Card(props: CanvasProps & { block: Block; loc: Loc }) {
  const { block, loc, sel, onSelect } = props;
  return (
    <div
      className={`card${loc === sel ? ' sel' : ''}`}
      data-loc={loc}
      data-type={block.type}
      onClick={(ev) => { ev.stopPropagation(); onSelect(loc); }}
    >
      <span className="tag">{TYPE_OF(block)}</span>
      <span className="grip" title="drag">⠿</span>
      <Body {...props} />
    </div>
  );
}

function Body(props: CanvasProps & { block: Block; loc: Loc }) {
  const { block, loc, vars } = props;
  switch (block.type) {
    case 'heading': {
      const H = `h${block.level || 2}` as 'h1' | 'h2' | 'h3';
      return <H className="b">{interpolate(block.text || '', vars) || '(heading)'}</H>;
    }
    case 'text':
      return <Markdown text={interpolate(block.text || '', vars) || '(text)'} />;
    case 'divider':
      return <hr />;
    case 'spacer':
      return <div className="ph">spacer {block.size || '24px'}</div>;
    case 'value': {
      // A declared default is what a visitor sees before anything sets the key; without
      // one the block genuinely shows the runtime's placeholder, so say so.
      const declared = vars[block.key as string];
      const shown = declared !== undefined ? declared : (block.placeholder as string) || '—';
      return (
        <div className="ph">
          {block.label ? `${block.label}: ` : ''}{shown}
          <span className="ph-key">{`{{${block.key}}}`}</span>
        </div>
      );
    }
    case 'buttons':
      return (
        <div className="btns">
          {(block.items || []).map((it, i) => <span key={i}>{it.label || '(button)'}</span>)}
        </div>
      );
    case 'embed':
      return <EmbedBox {...props} spec={block.embed!} />;
    case 'row': {
      const cols = block.columns || [];
      const rowIndex = indexAt(loc);
      return (
        <div
          className="row-wrap"
          style={{ gridTemplateColumns: cols.map((c) => `${c.span || 1}fr`).join(' ') }}
        >
          {cols.map((col, j) => {
            const blocks = col.blocks || [];
            return (
              <div
                key={j}
                className={`col-wrap${blocks.length ? '' : ' empty'}`}
                data-colkey={`${rowIndex}.${j}`}
              >
                {blocks.length === 0 && 'drop an embed here'}
                {blocks.map((b, k) => (
                  <Card {...props} key={k} block={b} loc={`${rowIndex}.${j}.${k}`} />
                ))}
              </div>
            );
          })}
        </div>
      );
    }
    default:
      return <div className="ph">{block.type}</div>;
  }
}

/**
 * A text block previews through the SAME markdown.js the published page loads, so what
 * you see here is what a visitor gets. Imperative on purpose: the renderer builds DOM
 * nodes (never markup), which is exactly why HTML in a text block stays literal text —
 * writing a React version would be a second implementation to keep honest.
 */
function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof SBMarkdown === 'undefined') { node.textContent = text; return; }
    SBMarkdown.render(node, text);
  }, [text]);
  return <div className="b" ref={ref} />;
}

function idKeyFor(type: string): string {
  const entry = (spec as any).embedTypes.find((t: any) => t.type === type);
  return entry ? entry.idKey : 'liveboardId';
}

function EmbedBox(props: CanvasProps & { block: Block; loc: Loc; spec: EmbedSpec }) {
  const { loc, spec: embedSpec, lib, vars } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const idKey = idKeyFor(embedSpec.type);
  // The id AS THE SDK WILL SEE IT. "{{liveboardId}}" is a real guid once the project's
  // default is applied — testing the raw config called that a valid id and handed the
  // braces to the SDK, which is why an embed driven by a variable stayed blank here
  // while the published page rendered it fine.
  const rawId = embedSpec.config[idKey];
  const resolvedId = typeof rawId === 'string' ? interpolate(rawId, vars) : rawId;
  const hasId = Boolean(resolvedId);
  const [error, setError] = React.useState<string | null>(null);
  // Bumping this re-runs the mount effect, which is how the frame is rebuilt on demand:
  // the canvas has no other way to make an embed load again after a cluster hiccup.
  const [reloads, setReloads] = React.useState(0);

  useEffect(() => {
    if (!hasId || !lib || !hostRef.current) return;
    setError(sdk.mount(loc, embedSpec, hostRef.current, lib, vars));
    sdk.resync();
  });

  const reload = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    sdk.release(loc);
    setError(null);
    setReloads((n) => n + 1);
  };

  useEffect(() => () => sdk.release(loc), [loc]);

  const style: React.CSSProperties = {
    height: embedSpec.config.fullHeight ? undefined : (embedSpec.height || DEFAULT_EMBED_HEIGHT),
    width: embedSpec.width || undefined,
  };

  return (
    <div data-embed={hasId ? loc : undefined}>
      <div
        className="embed-head"
        onClick={(ev) => { ev.stopPropagation(); props.onSelect(loc); }}
      >
        <span>{embedSpec.type}Embed</span>
        <span className="eid" title={typeof rawId === 'string' && hasToken(rawId) ? `${idKey}: ${rawId}` : undefined}>
          {(resolvedId as string) || `(no ${idKey})`}
        </span>
        <span className="sp2" />
        {hasId && (
          <button className="embed-reload" title="Reload this frame" onClick={reload}>↻</button>
        )}
        <span className="g" title="drag">⠿</span>
      </div>
      <div
        key={reloads}
        className="embed-host"
        id={`bslot-${loc.replace(/\./g, '_')}`}
        data-loc={loc}
        ref={hostRef}
        style={style}
      >
        {!hasId && (
          <div className="embed-note">
            {typeof rawId === 'string' && hasToken(rawId)
              // The id IS set — to a variable nothing fills in. Saying "choose a
              // liveboardId" here sends people to a field that already looks right.
              ? <>{idKey} is <code>{rawId}</code>, and no default is declared for it.
                Give that variable a default in Site → Variables, or a visitor’s
                settings panel will have to supply it.</>
              : <>{embedSpec.type}: choose a {idKey} on the right to render it live.</>}
          </div>
        )}
        {error && <div className="embed-note">{error}</div>}
      </div>
    </div>
  );
}

/** Wired once for the whole app: interact.js binds to a selector, not to elements. */
export function wireResize(onResize: (loc: Loc, height: string, width: string | null) => void) {
  if (typeof interact === 'undefined') return;
  interact('.embed-host[data-loc]').resizable({
    edges: { right: true, bottom: true },
    inertia: false,
    modifiers: [
      interact.modifiers.restrictSize({ min: { width: 180, height: 120 }, max: { width: 4000, height: 3000 } }),
    ],
    listeners: {
      start: () => document.body.classList.add('dragging-any'),
      move: (event: any) => {
        event.target.style.height = `${Math.round(event.rect.height)}px`;
        event.target.style.width = `${Math.round(event.rect.width)}px`;
      },
      end: (event: any) => {
        document.body.classList.remove('dragging-any');
        // Clear interact's interaction state. Left running, it swallows the pointer
        // events of the NEXT Sortable drag — a resize would silently break dragging.
        try { interact.stop(); } catch { /* older builds have no stop() */ }
        const host = event.target as HTMLElement;
        const loc = host.dataset.loc!;
        const r = host.getBoundingClientRect();
        const parentW = (host.parentElement?.getBoundingClientRect().width) || r.width;
        const width = Math.abs(r.width - parentW) < 4 ? null : `${Math.round(r.width)}px`;
        onResize(loc, `${Math.round(r.height)}px`, width);
      },
    },
  });
}

export { listFromKey };
