import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Block, Doc, EmbedType, Loc } from './types';
import { blockAt, deepClone, indexAt, listAt, listFromKey, listKey, locOf, setEmbedType } from './blocks';
import { getToken, loadDoc, PID, projectVersion, saveDoc, setToken, verifyToken } from './api';
import { clearCluster, clusterUsername } from './cluster';
import { useBuilder } from './store';
import { Canvas, wireResize } from './Canvas';
import { PropsPanel, typeSpec } from './Props';
import {
  BuildWithAiDialog, ConfirmDialog, ConnectDialog, MetadataPicker, PromptDialog, TypePicker,
} from './dialogs';
import { JsonPanel } from './JsonPanel';
import { MapPanel } from './MapPanel';
import * as sdk from './sdk';
import spec from './spec.json';

const PALETTE = (spec as any).palette as Array<{ label: string; chooseType?: boolean; block: Block }>;
const REMEMBER_KEY = `sb.tok.${PID}`;

/** Same cadence the published pages poll at. */
const LIVE_POLL_MS = 4000;


type Dialog =
  | { kind: 'type'; onPick: (t: EmbedType) => void }
  | { kind: 'metadata'; metadataType: string; onPick: (id: string) => void }
  | { kind: 'connect' }
  | { kind: 'buildAi' }
  | { kind: 'newPage' }
  | { kind: 'delPage' }
  | null;

export function App() {
  const [ready, setReady] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [lib, setLib] = useState<any>(null);
  const [interactive, setInteractive] = useState(false);
  // Sortable moves real DOM nodes, which leaves React's fiber tree pointing at the
  // wrong elements — later renders then write into the wrong nodes. Bumping this key
  // after a drag rebuilds the canvas from data instead of trying to reconcile with a
  // tree something else has edited. The iframes survive: they live in the SDK's
  // body-level pre-render wrappers, not in the hosts being rebuilt.
  const [canvasEpoch, setCanvasEpoch] = useState(0);
  const [showJson, setShowJson] = useState(false);
  const [showMap, setShowMap] = useState(false);
  // null until init() reports: AuthStatus.SUCCESS -> 'ok', any other status -> 'bad'.
  const [authState, setAuthState] = useState<'ok' | 'bad' | null>(null);
  // Bumped whenever this tab's cluster credential changes, so init() is rebuilt: the
  // host and auth type can both be unchanged while what init() needs is not.
  const [connectEpoch, setConnectEpoch] = useState(0);
  // Bumped on every edit so the JSON view re-reads instead of showing a stale snapshot.
  const [docEpoch, setDocEpoch] = useState(0);
  const b = useBuilder();
  const { doc, page, path, sel, setSel, setStatus, touched, render } = b;

  // ---------------------------------------------------------------- loading
  const reload = useCallback(async () => {
    const d = await loadDoc();
    if (typeof d.updatedAt === 'number') seenVersion.current = d.updatedAt;
    doc.current = d;
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
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const tick = async () => {
      const v = await projectVersion().catch(() => null);
      if (!live || v === null) return;
      if (seenVersion.current === null) { seenVersion.current = v; return; }
      if (v === seenVersion.current) return;
      seenVersion.current = v;
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

  useEffect(() => {
    if (!ready) return;
    wireResize((loc, height, width) => {
      const block = blockAt(page(), loc);
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

  useEffect(() => { sdk.setInteractive(interactive); });

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
  const current = page();
  const selected = blockAt(current, sel);

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
        onPick: (t) => {
          setEmbedType(block, t);
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
        <select
          id="pageSel"
          value={path}
          onChange={(e) => { b.setPath(e.target.value); setSel(null); sdk.releaseAll(); render(); }}
        >
          {pages.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button id="newPage" onClick={() => setDialog({ kind: 'newPage' })}>+ Page</button>
        <button id="delPage" onClick={() => setDialog({ kind: 'delPage' })}>Delete page</button>
        <button
          id="connect"
          // Colour is the outcome of init(), not the presence of a saved row: nothing
          // when there is no host to init with, blue once there is, green only on
          // AuthStatus.SUCCESS, red on any other status.
          className={!initFilled ? '' : authState === 'ok' ? 'linked' : authState === 'bad' ? 'failed' : 'filled'}
          title={
            !initFilled
              ? 'Set the host and auth the SDK inits with, and log in so objects can be listed'
              : authState === 'ok'
                ? `init() authenticated against ${initHost}${initAs}`
                : authState === 'bad'
                  ? `init() did not authenticate against ${initHost}${initAs} — see the status line`
                  : `init() configured for ${initHost}${initAs} — no AuthStatus reported yet`
          }
          onClick={() => setDialog({ kind: 'connect' })}
        >
          {authState === 'ok' ? '✓ Init' : 'Init'}
        </button>
        <button
          id="map"
          aria-pressed={showMap}
          title="Every page, and how they reach each other"
          onClick={() => { setShowMap((v) => !v); setShowJson(false); }}
        >
          Map
        </button>
        <button
          id="buildAi"
          title="Point an agent at this project over MCP"
          onClick={() => setDialog({ kind: 'buildAi' })}
        >
          Build with AI
        </button>
        <button
          id="interact"
          aria-pressed={interactive}
          onClick={() => setInteractive((v) => !v)}
          title="Let clicks reach the embeds instead of selecting cards"
        >
          Interact
        </button>
        <span className="sp" />
        <a href={`/p/${PID}/`} target="_blank" rel="noopener">Site ↗</a>
        <button
          id="forget"
          title="Remove this project's edit token from this browser"
          onClick={() => {
            try { localStorage.removeItem(REMEMBER_KEY); } catch { /* private mode */ }
            setStatus('token forgotten — this browser will ask again', 'ok');
          }}
        >
          Forget token
        </button>
        <button
          id="json"
          aria-pressed={showJson}
          className={showJson ? 'linked' : ''}
          title="Edit this page as JSON, right here"
          onClick={() => { setDocEpoch((n) => n + 1); setShowJson((v) => !v); }}
        >
          JSON
        </button>
        <span id="status" className={b.status.kind}>{b.status.text}</span>
        <button id="save" className="primary" onClick={() => void save()}>Save</button>
      </header>

      <div className="panes">
        <section className="pane palette" id="palette">
          <h2>Add</h2>
          {PALETTE.map((entry) => (
            <button key={entry.label} onClick={() => addBlock(entry)}>+ {entry.label}</button>
          ))}
        </section>

        {showMap ? (
          <MapPanel
            onClose={() => setShowMap(false)}
            onOpenPage={(p) => { setShowMap(false); b.setPath(p); setSel(null); render(); }}
          />
        ) : showJson ? (
          <JsonPanel
            doc={d}
            path={path}
            page={current}
            dirtyKey={docEpoch}
            onClose={() => setShowJson(false)}
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
          <Canvas
            key={canvasEpoch}
            blocks={current.blocks}
            sel={sel}
            onSelect={(loc) => { setSel(loc); render(); }}
            onMove={move}
            onResize={() => { /* wired once via interact.js */ }}
            lib={lib}
            mountError={null}
          />
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
          onSave={async (host, hostChanged, loggedIn, authType, publishCredential, sdkVersion) => {
            if (host === null) clearCluster();
            // Connecting or disconnecting changes what init() should be built from.
            setConnectEpoch((n) => n + 1);
            const authChanged = Boolean(host) && (d.config.authType || 'None') !== authType;
            // A different bundle cannot replace one already on the page, so this is the
            // one setting that genuinely needs a reload. Safe now that the cluster
            // credential survives one in sessionStorage.
            const versionChanged = Boolean(host) && String(d.config.sdkVersion || '') !== sdkVersion;
            if (host) {
              // The app's own config is all the backend holds. A credential normally
              // stays in this tab — unless it is deliberately published below, which
              // puts it in the page for the published site to mint with.
              d.config.thoughtSpotHost = host;
              d.config.authType = authType;
              if (sdkVersion) d.config.sdkVersion = sdkVersion; else delete d.config.sdkVersion;
              if (publishCredential) {
                d.config.auth = {
                  ...(d.config.auth || {}),
                  tokenSource: 'credentials',
                  ...publishCredential,
                };
              } else if (d.config.auth?.tokenSource === 'credentials') {
                d.config.auth = undefined;
              }
            }
            await save();
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
      {dialog?.kind === 'buildAi' && (
        <BuildWithAiDialog
          projectId={PID}
          editToken={getToken()}
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
      {dialog?.kind === 'delPage' && (
        <ConfirmDialog
          title={`Delete ${path}?`}
          confirmLabel="Delete"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const gone = path;
            delete d.pages[gone];
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
  // The token stays under a per-project key, and Forget token clears it.
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const tried = useRef(false);
  // Decided on the FIRST render, synchronously: verifying a remembered token is async,
  // and rendering the form meanwhile is the flash of the gate you see on reload.
  const [checking, setChecking] = useState(() => {
    try { return Boolean(localStorage.getItem(REMEMBER_KEY)); } catch { return false; }
  });

  // A remembered token is per project, so one token cannot unlock another.
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    let stored: string | null = null;
    try { stored = localStorage.getItem(REMEMBER_KEY); } catch { /* private mode */ }
    if (!stored) { setChecking(false); return; }
    void (async () => {
      if (await verifyToken(stored!)) { await onOpen(stored!, false); }
      else { try { localStorage.removeItem(REMEMBER_KEY); } catch { /* ignore */ } }
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
      setErr('That edit token is not valid for this project.');
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
          placeholder="edit token"
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
