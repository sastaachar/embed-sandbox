import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Block, Doc, EmbedType, Loc } from './types';
import { blockAt, deepClone, indexAt, listAt, listFromKey, listKey, locOf, setEmbedType } from './blocks';
import { getToken, loadDoc, PID, projectVersion, rotateToken, saveConnection, saveDoc, setToken, verifyToken, type EditLock } from './api';
import { clearCluster, clusterUsername } from './cluster';
import { useBuilder } from './store';
import { Canvas, wireResize } from './Canvas';
import { PropsPanel, typeSpec } from './Props';
import {
  BuildWithAiDialog, ConfirmDialog, ConnectDialog, MetadataPicker, PromptDialog, TypePicker,
} from './dialogs';
import { JsonPanel } from './JsonPanel';
import { PageTree } from './PageTree';
import { MapPanel } from './MapPanel';
import { variableDefaults } from './vars';
import { CodePanel } from './CodePanel';
import * as sdk from './sdk';
import spec from './spec.json';

const PALETTE = (spec as any).palette as Array<{ label: string; chooseType?: boolean; block: Block }>;
const REMEMBER_KEY = `sb.tok.${PID}`;

const NAME_KEY = `sb.name.${PID}`;

/**
 * A link can carry its own way in: `/build/<id>#t=<buildId>&connect=1` opens the
 * builder already unlocked, with the Connect dialog up. That is how a cluster gets
 * connected now — there is no separate connect page, so there is one form to keep right.
 *
 * The fragment is the carrier because a fragment is never sent to the server. It is read
 * ONCE, here at module load, and wiped from the address bar in the same breath, so the
 * token does not survive into history, a bookmark, or a screenshot of the tab.
 */
const LINK = (function readLink(): { token: string; connect: boolean } {
  try {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return { token: '', connect: false };
    const p = new URLSearchParams(raw);
    const found = { token: (p.get('t') || '').trim(), connect: p.get('connect') === '1' };
    if (found.token || found.connect) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    return found;
  } catch {
    return { token: '', connect: false };
  }
})();

/**
 * The landing page lists this browser's builds from sb.tok.* + sb.name.*. Only a REAL
 * name is stored: falling back to the id wrote the id in as the name, and the list then
 * showed it twice.
 */
function syncSavedName(name: string | undefined) {
  try {
    if (!localStorage.getItem(REMEMBER_KEY)) return;
    const trimmed = (name || '').trim();
    if (trimmed && trimmed !== PID) localStorage.setItem(NAME_KEY, trimmed);
    else localStorage.removeItem(NAME_KEY);
  } catch { /* private mode */ }
}

/** prerender-1, -2, … skipping any the document already uses. */
function nextPreRenderId(doc: Doc): string {
  const taken = new Set<string>();
  const walk = (blocks: Block[] | undefined) => {
    for (const b of blocks ?? []) {
      if (b.type === 'embed' && b.embed?.config?.preRenderId) taken.add(String(b.embed.config.preRenderId));
      if (b.type === 'row') for (const col of b.columns ?? []) walk(col.blocks);
    }
  };
  for (const page of Object.values(doc.pages)) walk(page.blocks);
  for (let n = 1; ; n += 1) if (!taken.has(`prerender-${n}`)) return `prerender-${n}`;
}

/** Same cadence the published pages poll at. */
const LIVE_POLL_MS = 4000;


type Dialog =
  | { kind: 'type'; onPick: (t: EmbedType, preRender: boolean) => void }
  | { kind: 'metadata'; metadataType: string; onPick: (id: string) => void }
  | { kind: 'connect' }
  | { kind: 'buildAi' }
  | { kind: 'rotate' }
  | { kind: 'newPage' }
  | { kind: 'delPage' }
  | { kind: 'newModal' }
  | { kind: 'delModal'; scope: { site: boolean; name: string } }
  | null;

export function App() {
  const [ready, setReady] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [lib, setLib] = useState<any>(null);
  // Sortable moves real DOM nodes, which leaves React's fiber tree pointing at the
  // wrong elements — later renders then write into the wrong nodes. Bumping this key
  // after a drag rebuilds the canvas from data instead of trying to reconcile with a
  // tree something else has edited. The iframes survive: they live in the SDK's
  // body-level pre-render wrappers, not in the hosts being rebuilt.
  const [canvasEpoch, setCanvasEpoch] = useState(0);
  // Build, JSON, Map and Code are four states of the same document — one control.
  const [view, setView] = useState<BuilderView>('build');
  // The advisory agent lock: warn, never block — Edit anyway stands until the lock clears.
  const [agentLock, setAgentLock] = useState<EditLock | null>(null);
  const [lockDismissed, setLockDismissed] = useState(false);
  // null until init() reports: AuthStatus.SUCCESS -> 'ok', any other status -> 'bad'.
  const [authState, setAuthState] = useState<'ok' | 'bad' | null>(null);
  // Bumped whenever this tab's cluster credential changes, so init() is rebuilt: the
  // host and auth type can both be unchanged while what init() needs is not.
  const [connectEpoch, setConnectEpoch] = useState(0);
  // Bumped on every edit so the JSON view re-reads instead of showing a stale snapshot.
  const [docEpoch, setDocEpoch] = useState(0);

  // JSON re-reads the document on entry so it is never a stale snapshot.
  const switchView = useCallback((next: BuilderView) => {
    setView((prev) => {
      if (next === 'json' && prev !== 'json') setDocEpoch((n) => n + 1);
      return next;
    });
  }, []);
  const b = useBuilder();
  const { doc, page, path, sel, setSel, setStatus, touched, render } = b;

  // ---------------------------------------------------------------- loading
  const reload = useCallback(async () => {
    const d = await loadDoc();
    if (typeof d.updatedAt === 'number') seenVersion.current = d.updatedAt;
    doc.current = d;
    syncSavedName(d.config.name);
    const paths = Object.keys(d.pages).sort();
    if (!paths.includes(path)) b.setPath(paths[0] || '/');
    setSel(null);
    b.setDirty(false);
    render();
  }, [path]);

  // An agent editing over MCP writes straight to the document, so the canvas has to
  // notice. Poll the same /version the published pages poll, and pull the document when
  // it moves — but never on top of unsaved edits: say so and let the user decide.
  const seenVersion = useRef<number | null>(null);
  const prevLock = useRef<EditLock | null>(null);
  // The container the canvas is editing NOW (page or modal) — for callbacks wired once.
  const containerRef = useRef<ReturnType<typeof page> | null>(null);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const tick = async () => {
      const v = await projectVersion().catch(() => null);
      if (!live || v === null) return;
      if (Boolean(v.lock) !== Boolean(prevLock.current)) setLockDismissed(false);
      prevLock.current = v.lock;
      setAgentLock(v.lock);
      if (seenVersion.current === null) { seenVersion.current = v.updatedAt; return; }
      if (v.updatedAt === seenVersion.current) return;
      seenVersion.current = v.updatedAt;
      if (b.dirty) {
        setStatus('changed elsewhere — save or reload to pick it up', 'err');
        return;
      }
      await reload();
      setStatus('updated — picked up a change made over MCP', 'ok');
    };
    const id = setInterval(tick, LIVE_POLL_MS);
    void tick();
    return () => { live = false; clearInterval(id); };
  }, [ready, reload, b.dirty]);

  // Our own save moves the clock too; adopt it so it does not read as someone else's.
  const adoptVersion = (v: number | undefined) => {
    if (typeof v === 'number') seenVersion.current = v;
  };

  const openWith = useCallback(async (token: string, remember: boolean) => {
    setToken(token);
    if (remember) { try { localStorage.setItem(REMEMBER_KEY, token); } catch { /* private mode */ } }
    await reload();
    setReady(true);
  }, [reload]);

  // A "connect your cluster" link asked for the dialog, so put it up once the document
  // is in — the dialog reads the host and auth type off it.
  useEffect(() => {
    if (ready && LINK.connect) setDialog({ kind: 'connect' });
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    wireResize((loc, height, width) => {
      const block = blockAt(containerRef.current ?? page(), loc);
      if (!block || block.type !== 'embed') return;
      if (!block.embed!.config.fullHeight) block.embed!.height = height;
      if (width) block.embed!.width = width; else delete block.embed!.width;
      sdk.release(loc);
      touched();
      render();
      setStatus(`resized to ${width ? `${width} × ` : ''}${height}`, 'ok');
    });
  }, [ready]);

  // The SDK init depends on the project's host and auth, so it is re-derived whenever
  // the document changes rather than cached for the life of the tab.
  useEffect(() => {
    if (!ready || !doc.current) return;
    const cfg = doc.current.config;
    // Do not init with nothing to authenticate with. init() runs once per host+auth+
    // credential, so a load-time call with no credential produced a tokenless init that
    // the embeds then kept. Wait for Connect instead.
    if (!sdk.canInit(cfg)) {
      setLib(null);
      setAuthState(null);
      setStatus('not initialised — connect a cluster to init()', '');
      return;
    }
    setAuthState(null);
    sdk.ensureSdk(cfg, (msg, kind) => {
      // 'info' is a progress status such as SDK_SUCCESS: worth saying, not a verdict,
      // and it must leave the button's colour alone.
      setStatus(msg, kind === 'info' ? '' : kind);
      if (kind !== 'info') setAuthState(kind === 'ok' ? 'ok' : 'bad');
    })
      .then(setLib)
      .catch((err) => { setStatus(err.message, 'err'); setAuthState('bad'); });
  }, [ready, doc.current?.config?.thoughtSpotHost, doc.current?.config?.authType, connectEpoch]);


  // ---------------------------------------------------------------- saving
  const save = useCallback(async (extra?: Parameters<typeof saveDoc>[2]) => {
    const d = doc.current!;
    setStatus('saving…');
    try {
      const saved = await saveDoc(d.config, d.pages, extra);
      adoptVersion(saved.updatedAt);
      d.config = saved.config;
      b.setDirty(false);
      setStatus('saved', 'ok');
      syncSavedName(doc.current?.config.name);
      return saved;
    } catch (err) {
      setStatus((err as Error).message, 'err');
      throw err;
    }
  }, []);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        if (ready) void save();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ready, save]);

  useEffect(() => {
    const warn = (ev: BeforeUnloadEvent) => { if (b.dirty) { ev.preventDefault(); ev.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [b.dirty]);

  const bump = () => { setDocEpoch((n) => n + 1); render(); };

  if (!ready) return <Gate onOpen={openWith} />;

  const d = doc.current!;
  const pageCfg = page();
  // A modal is edited with the whole canvas — same blocks, same panel, its own scope.
  let current = pageCfg;
  if (b.modal) {
    const store = ((b.modal.site ? d.config.modals : pageCfg.modals) ?? {}) as Record<string, any>;
    const m = store[b.modal.name];
    if (m) {
      if (!m.blocks) m.blocks = [];
      current = m as unknown as typeof pageCfg;
    }
  }
  const selected = blockAt(current, sel);
  containerRef.current = current;

  const leaveModal = () => {
    b.setModal(null);
    setSel(null);
    sdk.releaseAll();
    setCanvasEpoch((n) => n + 1);
    render();
  };
  const openModalScope = (pagePath: string | null, name: string) => {
    if (pagePath !== null && pagePath !== path) b.setPath(pagePath);
    b.setModal({ site: pagePath === null, name });
    setSel(null);
    sdk.releaseAll();
    setCanvasEpoch((n) => n + 1);
    render();
  };

  // ---------------------------------------------------------------- editing
  const addBlock = (entry: { label: string; chooseType?: boolean; block: Block }) => {
    const target = sel != null ? listAt(current, sel) || current.blocks : current.blocks;
    const block = deepClone(entry.block);
    if (block.type === 'row' && target !== current.blocks) {
      setStatus('rows cannot nest inside a column', 'err');
      return;
    }
    target.push(block);
    touched();
    const loc = locOf(current, block);
    setSel(loc);
    render();
    if (entry.chooseType) {
      setDialog({
        kind: 'type',
        onPick: (t, preRender) => {
          setEmbedType(block, t);
          if (preRender) {
            block.embed!.preRender = true;
            // An id is required, so give it one that is valid immediately and obvious
            // to change — an unsaveable block would be a worse first impression.
            block.embed!.config.preRenderId = nextPreRenderId(doc.current!);
            if (!block.embed!.name) block.embed!.name = 'prerender';
          }
          setDialog(null);
          touched();
          render();
        },
      });
    }
  };

  const move = (fromLoc: Loc, destKey: string, destIndex: number) => {
    const srcList = listAt(current, fromLoc);
    if (!srcList) return;
    const block = srcList[indexAt(fromLoc)];
    const destList = listFromKey(current, destKey);
    if (!block || !destList) return;
    if (block.type === 'row' && destKey !== '') {
      setStatus('rows cannot nest', 'err');
      render();
      return;
    }
    srcList.splice(indexAt(fromLoc), 1);
    destList.splice(destIndex, 0, block);
    setSel(null);
    touched();
    setCanvasEpoch((n) => n + 1);
    render();
  };

  /** Wraps a block in a row so something can sit beside it. */
  const sideBySide = () => {
    if (sel == null || !selected) return;
    if (listKey(sel) !== '') {
      // already inside a row: widen that row instead of nesting another one
      const rowIndex = Number(sel.split('.')[0]);
      const row = current.blocks[rowIndex];
      if ((row.columns || []).length >= 4) { setStatus('a row holds at most 4 columns', 'err'); return; }
      row.columns!.push({ blocks: selected.type === 'embed' ? [newEmbedLike(selected)] : [] });
      touched();
      render();
      setStatus('column added', 'ok');
      return;
    }
    const i = indexAt(sel);
    const beside: Block[] = selected.type === 'embed' ? [newEmbedLike(selected)] : [];
    current.blocks[i] = { type: 'row', columns: [{ blocks: [selected] }, { blocks: beside }] };
    sdk.releaseAll();
    setSel(null);
    touched();
    render();
    setStatus('side by side', 'ok');
  };

  const fullWidth = () => {
    if (sel == null || !selected) return;
    const key = listKey(sel);
    if (key === '') { setStatus('already full width'); return; }
    const [r, c] = key.split('.').map(Number);
    const row = current.blocks[r];
    const col = row.columns![c];
    col.blocks.splice(indexAt(sel), 1);
    current.blocks.splice(r + 1, 0, selected);
    if (row.columns!.every((x) => (x.blocks || []).length === 0)) current.blocks.splice(r, 1);
    sdk.releaseAll();
    setSel(null);
    touched();
    render();
    setStatus('moved out of the row — it now spans the full width', 'ok');
  };

  const del = () => {
    if (sel == null) return;
    const list = listAt(current, sel);
    list?.splice(indexAt(sel), 1);
    sdk.releaseAll();
    setSel(null);
    touched();
    render();
  };

  const pages = Object.keys(d.pages).sort();
  const initHost = d.config.thoughtSpotHost || '';
  const initFilled = Boolean(initHost);
  // Who THIS TAB is logged in as: the only place a credential exists at all.
  const initUser = clusterUsername();
  const initAs = initUser ? ` as ${initUser}` : '';

  return (
    <div className="shell on" id="work">
      <header className="toolbar">
        {/* The title IS the project name — a separate field wrapped the toolbar onto a
            second row, which pushed the canvas down and took drop targets off-screen. */}
        <input
          id="projName"
          className="proj-name"
          value={d.config.name || ''}
          placeholder="Untitled project"
          title="Project name — Save to persist it"
          onChange={(e) => {
            if (e.target.value) d.config.name = e.target.value; else delete d.config.name;
            touched();
            render();
          }}
        />
        <span className="pid" title="Project id">{PID}</span>
        <button
          id="connect"
          // Colour is the outcome of init(), not the presence of a saved row: nothing
          // when there is no host to init with, blue once there is, green only on
          // AuthStatus.SUCCESS, red on any other status.
          className={!initFilled ? '' : authState === 'ok' ? 'linked' : authState === 'bad' ? 'failed' : 'filled'}
          title={
            !initFilled
              ? 'Connect a cluster: the host + auth here are what the SDK init()s with, and the login lists your objects'
              : authState === 'ok'
                ? `Connected — init() authenticated against ${initHost}${initAs}`
                : authState === 'bad'
                  ? `init() did not authenticate against ${initHost}${initAs} — see the status line`
                  : `Connected to ${initHost}${initAs} — init() configured, no AuthStatus reported yet`
          }
          onClick={() => setDialog({ kind: 'connect' })}
        >
          {authState === 'ok' ? '✓ Connected' : 'Connect'}
        </button>
        <ViewSlider view={view} onChange={switchView} />
        <button
          id="buildAi"
          title="Point an agent at this project over MCP"
          onClick={() => setDialog({ kind: 'buildAi' })}
        >
          Build with AI
        </button>
        <span className="sp" />
        <a href={`/p/${PID}/`} target="_blank" rel="noopener">Site ↗</a>
        <button
          id="copyToken"
          title="Copy this project's build id"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(getToken());
              setStatus('build id copied', 'ok');
            } catch {
              setStatus('could not copy — Build with AI shows it as text', 'err');
            }
          }}
        >
          Copy build id
        </button>
        <button
          id="rotate"
          title="Issue a new build id and stop the old one working everywhere"
          onClick={() => setDialog({ kind: 'rotate' })}
        >
          Rotate build id
        </button>
        <button
          id="forget"
          title="Remove this project's build id from this browser"
          onClick={() => {
            try { localStorage.removeItem(REMEMBER_KEY); localStorage.removeItem(NAME_KEY); } catch { /* private mode */ }
            setStatus('build id forgotten — this browser will ask again', 'ok');
          }}
        >
          Forget build id
        </button>
        {agentLock && !lockDismissed && (
          <span
            className="lock-chip"
            id="lockChip"
            title={`${agentLock.note ? `“${agentLock.note}” — ` : ''}your changes might be overwritten by the AI overlords`}
          >
            <span className="lc-dot" />
            {agentLock.holder} is editing
            <button id="lockEditAnyway" title="Hide until the lock changes" onClick={() => setLockDismissed(true)}>✕</button>
          </span>
        )}
        <span id="status" className={b.status.kind}>{b.status.text}</span>
        <button id="save" className="primary" onClick={() => void save()}>Save</button>
      </header>

      <div className="panes">
        <section className="pane palette" id="palette">
          <PageTree
            paths={pages}
            modalsOf={(p) => Object.keys(d.pages[p]?.modals ?? {})}
            siteModals={Object.keys(d.config.modals ?? {})}
            current={path}
            currentModal={b.modal}
            onOpen={(p) => { b.setModal(null); b.setPath(p); setSel(null); sdk.releaseAll(); render(); }}
            onOpenModal={openModalScope}
            onNew={() => setDialog({ kind: 'newPage' })}
            onDelete={() => setDialog({ kind: 'delPage' })}
            onNewModal={() => setDialog({ kind: 'newModal' })}
            onDeleteModal={(scope) => setDialog({ kind: 'delModal', scope })}
          />
          <div className="pal-add">
            <h2>Add</h2>
            {PALETTE.map((entry) => (
              <button key={entry.label} onClick={() => addBlock(entry)}>+ {entry.label}</button>
            ))}
          </div>
        </section>

        {view === 'code' ? (
          <CodePanel
            path={path}
            codeOverride={doc.current?.pages?.[path]?.codeOverride as Record<string, unknown> | undefined}
            onClose={() => switchView('build')}
          />
        ) : view === 'map' ? (
          <MapPanel
            onClose={() => switchView('build')}
            onOpenPage={(p) => { switchView('build'); b.setModal(null); b.setPath(p); setSel(null); render(); }}
          />
        ) : view === 'json' ? (
          <JsonPanel
            doc={d}
            path={path}
            page={pageCfg}
            dirtyKey={docEpoch}
            onClose={() => switchView('build')}
            onApply={async (scope, parsed) => {
              if (scope === 'page') {
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  throw new Error('a page must be a JSON object');
                }
                d.pages[path] = parsed as typeof current;
              } else {
                if (!parsed || typeof parsed !== 'object') throw new Error('expected { config, pages }');
                if (parsed.config) d.config = parsed.config;
                if (parsed.pages) d.pages = parsed.pages;
              }
              sdk.releaseAll();
              setSel(null);
              await save();
              await reload();
              setCanvasEpoch((n) => n + 1);
              setDocEpoch((n) => n + 1);
            }}
          />
        ) : (
          <div className="pane stage-wrap">
            {b.modal && (
              <div className="modal-crumb" id="modalCrumb">
                <span>
                  editing modal <b>“{b.modal.name}”</b>
                  {b.modal.site ? ' (site-wide)' : <> on <span className="mono">{path}</span></>}
                </span>
                <button id="backToPage" onClick={leaveModal}>← Back to page</button>
              </div>
            )}
            <Canvas
              key={`${canvasEpoch}:${b.modal ? `${b.modal.site ? '@site' : path}#${b.modal.name}` : path}`}
              blocks={current.blocks}
              sel={sel}
              onSelect={(loc) => { setSel(loc); render(); }}
              onMove={move}
              onResize={() => { /* wired once via interact.js */ }}
              lib={lib}
              mountError={null}
              vars={variableDefaults(d)}
            />
          </div>
        )}

        <PropsPanel
          doc={d}
          lib={lib}
          page={current}
          block={selected}
          sel={sel}
          onChange={touched}
          onRerender={() => { sdk.releaseAll(); touched(); render(); }}
          onDelete={del}
          onSideBySide={sideBySide}
          onFullWidth={fullWidth}
          onTitleChange={(title) => { current.title = title; touched(); render(); }}
          onPickMetadata={(metadataType, onPick) =>
            setDialog({ kind: 'metadata', metadataType, onPick: (id) => { onPick(id); setDialog(null); } })}
        />
      </div>

      {dialog?.kind === 'type' && (
        <TypePicker onPick={dialog.onPick} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'metadata' && (
        <MetadataPicker
          metadataType={dialog.metadataType}
          onPick={dialog.onPick}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'connect' && (
        <ConnectDialog
          defaultHost={d.config.thoughtSpotHost || ''}
          defaultAuthType={d.config.authType || 'None'}
          publishedCredential={d.config.auth?.tokenSource === 'credentials'}
          defaultSdkVersion={String(d.config.sdkVersion || '')}
          onCredentialChange={() => setConnectEpoch((n) => n + 1)}
          onClose={() => setDialog(null)}
          onSync={async (items) => {
            d.config.catalog = { items, syncedAt: Date.now() };
            await save();
            render();
          }}
          onSave={async (host, hostChanged, loggedIn, authType, publishCredential, sdkVersion, serverCredential) => {
            if (host === null) clearCluster();
            // Connecting or disconnecting changes what init() should be built from.
            setConnectEpoch((n) => n + 1);
            const authChanged = Boolean(host) && (d.config.authType || 'None') !== authType;
            // A different bundle cannot replace one already on the page, so this is the
            // one setting that genuinely needs a reload. Safe now that the cluster
            // credential survives one in sessionStorage.
            const versionChanged = Boolean(host) && String(d.config.sdkVersion || '') !== sdkVersion;
            const tokenAuth = authType === 'TrustedAuthTokenCookieless' || authType === 'TrustedAuthToken';
            // Only a token auth type has anything to mint, so that is the only place
            // publishing means something — and the backend agrees, which matters because
            // it settles config.auth after this save.
            const publishing = Boolean(publishCredential) && tokenAuth;
            if (host) {
              // The app's own config is all the backend holds. A credential normally
              // stays in this tab — unless it is deliberately published below, which
              // puts it in the page for the published site to mint with.
              d.config.thoughtSpotHost = host;
              d.config.authType = authType;
              if (sdkVersion) d.config.sdkVersion = sdkVersion; else delete d.config.sdkVersion;
              const objectId = d.config.auth?.objectId;
              const keep = objectId ? { objectId } : {};
              if (publishing) {
                d.config.auth = { ...keep, tokenSource: 'credentials', ...publishCredential };
              } else if (tokenAuth && (serverCredential || d.config.auth?.tokenSource === 'proxy')) {
                // No secret in the page: the published site calls the token proxy,
                // which mints from the server-side connection saved below.
                d.config.auth = { ...keep, tokenSource: 'proxy' };
              } else if (d.config.auth?.tokenSource === 'credentials' || d.config.auth?.tokenSource === 'proxy') {
                d.config.auth = undefined;
              }
            }
            await save();
            if (host && serverCredential) {
              const stored = await saveConnection(
                host, serverCredential.username, serverCredential.secret,
                serverCredential.secretType, authType, publishing,
              ).catch((e) => ({ ok: false, error: (e as Error).message }));
              if (!stored.ok) setStatus(`connection not stored server-side: ${stored.error}`, 'err');
            }
            await reload();
            if (versionChanged) {
              setStatus(`SDK ${sdkVersion || 'latest'} — reloading to load that bundle`, 'ok');
              setTimeout(() => location.reload(), 700);
            } else if (hostChanged || authChanged) {
              // Re-init in place rather than location.reload(): the cluster credential
              // lives in this tab only, and a reload throws it away — which is what left
              // "Pick…" saying it was not connected right after connecting.
              sdk.releaseAll();
              render();
              setStatus(hostChanged ? 'cluster host changed — embeds re-initialised'
                : 'auth type changed — embeds re-initialised', 'ok');
            } else if (!host) {
              setStatus('disconnected', 'ok');
            } else {
              setStatus(loggedIn ? 'connected — Pick… lists real objects' : 'saved (not logged in)',
                loggedIn ? 'ok' : '');
            }
          }}
        />
      )}
      {dialog?.kind === 'rotate' && (
        <ConfirmDialog
          title="Rotate the build id?"
          body={
            'A new token replaces this one immediately. Every existing copy stops working: '
            + 'other browsers, any MCP connector it was added to, and any /build link still '
            + 'carrying it. The new one is copied to your clipboard and kept in this browser.'
          }
          confirmLabel="Rotate it"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            setDialog(null);
            try {
              const fresh = await rotateToken();
              try { localStorage.setItem(REMEMBER_KEY, fresh); } catch { /* private mode */ }
              try {
                await navigator.clipboard.writeText(fresh);
                setStatus('build id rotated and copied — update anywhere the old one was pasted', 'ok');
              } catch {
                setStatus('build id rotated — Copy build id puts the new one on your clipboard', 'ok');
              }
            } catch (err) {
              setStatus((err as Error).message, 'err');
            }
          }}
        />
      )}
      {dialog?.kind === 'buildAi' && (
        <BuildWithAiDialog
          projectId={PID}
          buildId={getToken()}
          catalogCount={d.config.catalog?.items?.length || 0}
          syncedAt={d.config.catalog?.syncedAt ?? null}
          onClose={() => setDialog(null)}
          onSync={async (items) => {
            d.config.catalog = { items, syncedAt: Date.now() };
            await save();
            render();
          }}
        />
      )}
      {dialog?.kind === 'newPage' && (
        <PromptDialog
          title="New page"
          initial="/new-page"
          confirmLabel="Create"
          onClose={() => setDialog(null)}
          onConfirm={async (value) => {
            let p = value.trim();
            if (!p) return;
            if (!p.startsWith('/')) p = `/${p}`;
            d.pages[p] = { title: p, blocks: [] };
            setDialog(null);
            await save();
            b.setPath(p);
            await reload();
            setStatus(`created ${p}`, 'ok');
          }}
        />
      )}
      {dialog?.kind === 'newModal' && (
        <PromptDialog
          title={`New modal on ${path}`}
          initial="detail"
          confirmLabel="Create"
          onClose={() => setDialog(null)}
          onConfirm={async (value) => {
            const name = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
            if (!name) return;
            const pg = pageCfg as any;
            pg.modals = pg.modals || {};
            if (!pg.modals[name]) pg.modals[name] = { title: name, blocks: [] };
            setDialog(null);
            touched();
            openModalScope(path, name);
            setStatus(`modal “${name}” — add blocks, then Save`, 'ok');
          }}
        />
      )}
      {dialog?.kind === 'delModal' && (
        <ConfirmDialog
          title={`Delete modal “${dialog.scope.name}”?`}
          confirmLabel="Delete"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const store = (dialog.scope.site ? d.config.modals : pageCfg.modals) as
              Record<string, unknown> | undefined;
            if (store) delete store[dialog.scope.name];
            setDialog(null);
            leaveModal();
            touched();
            setStatus('modal deleted — Save to persist', 'ok');
          }}
        />
      )}
      {dialog?.kind === 'delPage' && (
        <ConfirmDialog
          title={`Delete ${path}?`}
          confirmLabel="Delete"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const gone = path;
            delete d.pages[gone];
            b.setModal(null);
            setDialog(null);
            const left = Object.keys(d.pages).sort();
            b.setPath(left[0] || '/');
            await save();
            await reload();
            setStatus(`deleted ${gone}`, 'ok');
          }}
        />
      )}
    </div>
  );
}

function newEmbedLike(source: Block): Block {
  const t = typeSpec(source.embed!.type);
  return { type: 'embed', embed: { type: t.type, config: {} } };
}

function Gate({ onOpen }: { onOpen: (token: string, remember: boolean) => Promise<void> }) {
  const [value, setValue] = useState('');
  // On by default: this is a personal build tool behind a per-project token, and being
  // asked to paste 64 hex characters on every visit is the thing people actually hate.
  // The build id stays under a per-project key, and Forget build id clears it.
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const tried = useRef(false);
  // Decided on the FIRST render, synchronously: verifying a remembered token is async,
  // and rendering the form meanwhile is the flash of the gate you see on reload.
  const [checking, setChecking] = useState(() => {
    if (LINK.token) return true;
    try { return Boolean(localStorage.getItem(REMEMBER_KEY)); } catch { return false; }
  });

  // A remembered token is per project, so one token cannot unlock another.
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    let stored: string | null = null;
    try { stored = localStorage.getItem(REMEMBER_KEY); } catch { /* private mode */ }
    if (!LINK.token && !stored) { setChecking(false); return; }
    void (async () => {
      // A token in the link wins: it is the newer intent, and it is how a project gets
      // handed to a second browser. Remembered, because the address bar has already been
      // wiped — not remembering it would send a refresh straight back to this gate.
      if (LINK.token) {
        if (await verifyToken(LINK.token)) { await onOpen(LINK.token, true); setChecking(false); return; }
        setErr('The build id in that link is not valid for this project.');
      }
      // A bad link must not cost a good remembered token, so this is checked separately.
      if (stored) {
        if (await verifyToken(stored)) { await onOpen(stored, false); setChecking(false); return; }
        try { localStorage.removeItem(REMEMBER_KEY); localStorage.removeItem(NAME_KEY); } catch { /* ignore */ }
      }
      setChecking(false);
    })();
  }, [onOpen]);

  // Deliberately empty, not a spinner: the builder is usually one request away, and a
  // spinner that flashes is the same complaint as a form that flashes.
  if (checking) return <div className="gate" id="gate" data-checking="1" />;

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const candidate = value.trim();
    if (!candidate) return;
    setBusy(true);
    setErr('');
    if (await verifyToken(candidate)) {
      await onOpen(candidate, remember);
    } else {
      setErr('That build id is not valid for this project.');
      setBusy(false);
    }
  };

  return (
    <div className="gate" id="gate">
      <form className="gate-card" id="gateForm" onSubmit={submit}>
        <h1>Build</h1>
        <p>This project is edit-token gated. Paste the token you were given when it was created.</p>
        <input
          id="token"
          type="password"
          value={value}
          placeholder="build id"
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <div className="row">
          <button className="primary" type="submit" disabled={busy}>Open builder</button>
          <label className="remember">
            <input
              id="remember"
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Remember this token in this browser
          </label>
        </div>
        <p className="gate-err" id="gateErr">{err}</p>
      </form>
    </div>
  );
}

type BuilderView = 'build' | 'json' | 'map' | 'code';

const VIEWS: Array<{ id: BuilderView; label: string; title: string }> = [
  { id: 'build', label: 'Build', title: 'The canvas — arrange blocks, live embeds' },
  { id: 'json', label: 'JSON', title: 'The same page as an editable document' },
  { id: 'map', label: 'Map', title: 'Every page, and how they reach each other' },
  { id: 'code', label: 'Code', title: 'The same page as SDK code for your own app' },
];

/**
 * Build, JSON, Map and Code are four views of one document, so they are one control:
 * a segmented slider. Click a segment, or drag the thumb — the view follows the
 * pointer live while sliding.
 */
function ViewSlider({ view, onChange }: { view: BuilderView; onChange: (v: BuilderView) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const idx = Math.max(0, VIEWS.findIndex((v) => v.id === view));
  const pick = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const i = Math.min(VIEWS.length - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * VIEWS.length)));
    if (VIEWS[i].id !== view) onChange(VIEWS[i].id);
  };
  return (
    <div
      className="viewslider"
      id="viewSlider"
      ref={ref}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        pick(e.clientX);
      }}
      onPointerMove={(e) => { if (e.buttons & 1) pick(e.clientX); }}
    >
      <span className="vs-thumb" style={{ transform: `translateX(${idx * 100}%)` }} aria-hidden />
      {VIEWS.map((v) => (
        <button
          key={v.id}
          id={`view-${v.id}`}
          type="button"
          className={view === v.id ? 'on' : ''}
          aria-pressed={view === v.id}
          title={v.title}
          onClick={() => onChange(v.id)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
