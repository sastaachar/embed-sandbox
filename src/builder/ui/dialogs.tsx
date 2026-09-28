import React, { useEffect, useState } from 'react';
import type { Connection, EmbedType } from './types';
import { Field, Modal } from './Modal';
import {
  clearCluster, clusterHint, clusterHost, clusterReady, clusterSearch, clusterSecret,
  clusterSecretType, clusterToken, clusterUsername, setCluster,
} from './cluster';
import { type MetadataItem } from './api';
import spec from './spec.json';

const EMBED_TYPES = (spec as any).embedTypes as Array<{ type: EmbedType; label: string; blurb: string }>;
const AUTH_TYPES = ((spec as any).siteFields as Array<any>)
  .find((f) => f.key === 'authType').options as Array<[string, string]>;

export function TypePicker(props: {
  onPick: (t: EmbedType, preRender: boolean) => void;
  onClose: () => void;
}) {
  // A pre-render block is a PreRendered<X>Embed: it warms an id and shows nothing.
  // Same type list, different component — so it is a mode here, not a second grid.
  const [preRender, setPreRender] = useState(false);
  return (
    <Modal onClose={props.onClose}>
      <h3>Choose an embed type</h3>
      <p className="dlg-note">Each type asks for different details, so this comes first.</p>
      <div className="type-grid pick">
        {EMBED_TYPES.map((t) => (
          <button key={t.type} id={`type-${t.type}`} onClick={() => props.onPick(t.type, preRender)}>
            <span className="nm">{preRender ? `Background ${t.label}` : t.label}</span>
            <span className="bl">{preRender ? 'PreRendered…Embed — loads invisibly, shows nothing' : t.blurb}</span>
          </button>
        ))}
      </div>
      <label className="checkline">
        <input
          id="asPreRender"
          type="checkbox"
          checked={preRender}
          onChange={(e) => setPreRender(e.target.checked)}
        />
        Load in background only (PreRendered…Embed)
      </label>
      <p className="hint">
        {preRender
          ? 'Shows nothing itself. A normal embed carrying the same preRenderId shows it instantly.'
          : 'Set a Pre-render id on this embed to connect it to a background loader that already exists.'}
      </p>
      <div className="dlg-row"><button onClick={props.onClose}>Cancel</button></div>
    </Modal>
  );
}

export function MetadataPicker(props: {
  metadataType: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<MetadataItem[] | null>(null);
  const [note, setNote] = useState('loading…');
  const [q, setQ] = useState('');

  useEffect(() => {
    let live = true;
    const run = async () => {
      setItems(null);
      setNote('loading…');
      // Straight at the cluster from this tab, always. A Worker at the edge cannot reach
      // a private-IP or self-signed cluster, so there is no server-side path to fall back to.
      if (!clusterReady()) {
        if (live) {
          setItems([]);
          setNote('Not connected to a cluster yet — use “Connect cluster” in the toolbar, then this ' +
            'lists your real objects. Meanwhile you can paste an id.');
        }
        return;
      }
      try {
        const found = await clusterSearch(props.metadataType, q);
        if (live) { setItems(found); setNote(found.length ? '' : 'nothing found'); }
      } catch (err) {
        if (!live) return;
        setItems([]);
        setNote(clusterHint(err));
      }
    };
    const t = setTimeout(run, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q, props.metadataType]);

  return (
    <Modal onClose={props.onClose}>
      <h3>Pick a {props.metadataType.toLowerCase().replace('_', ' ')}</h3>
      <input placeholder="filter by name…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="pick">
        {items === null || note ? <p className="dlg-note">{note}</p> : null}
        {(items || []).map((item) => (
          <button key={item.id} onClick={() => { props.onPick(item.id); props.onClose(); }}>
            <div className="nm">{item.name}</div>
            <div className="gid">{item.id}</div>
          </button>
        ))}
      </div>
      <div className="dlg-row"><button onClick={props.onClose}>Cancel</button></div>
    </Modal>
  );
}

const CATALOG_TYPES = ['LIVEBOARD', 'ANSWER', 'LOGICAL_TABLE'];

export function ConnectDialog(props: {
  defaultHost: string;
  defaultAuthType: string;
  /** Forgetting the credential changes what init() needs, same as connecting. */
  onCredentialChange: () => void;
  /** Only the host reaches the backend — the credential never leaves this tab. */
  publishedCredential: boolean;
  defaultSdkVersion: string;
  onSync: (items: Array<{ id: string; name: string; type: string }>) => Promise<void>;
  onSave: (
    host: string | null,
    hostChanged: boolean,
    loggedIn: boolean,
    authType: string,
    /** Put username+secret in the public page config so it can mint for itself. */
    publishCredential: { username: string; secret: string; secretType: string } | null,
    sdkVersion: string,
    /** Stored write-only on the server; enables the token proxy and search_metadata. */
    serverCredential: { username: string; secret: string; secretType: string } | null,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const conn = clusterReady();
  const [host, setHost] = useState(clusterHost() || props.defaultHost || '');
  const [username, setUsername] = useState(clusterUsername());
  // Prefilled from the tab's stored credential so a saved connection reads as saved.
  // Blank with a *** placeholder means only the server holds it — type to replace.
  const [secret, setSecret] = useState(clusterSecret());
  const [secretType, setSecretType] = useState<'password' | 'secret_key'>(clusterSecretType());
  const [authType, setAuthType] = useState(props.defaultAuthType || 'None');
  // Off by default: turning it on publishes the secret to everyone with the link.
  const [publish, setPublish] = useState(props.publishedCredential);
  const [sdkVersion, setSdkVersion] = useState(props.defaultSdkVersion || '');
  const [msg, setMsg] = useState<{ text: string; kind: string }>({ text: '', kind: 'dlg-note' });
  const [busy, setBusy] = useState(false);
  // Publishing a credential only means something for the auth types that mint a token.
  const tokenAuth = authType === 'TrustedAuthToken' || authType === 'TrustedAuthTokenCookieless';

  const go = async () => {
    if (!host || !username || (!secret && !conn)) {
      setMsg({ text: 'Host, username and the password/secret key are all needed.', kind: 'dlg-err' });
      return;
    }
    setBusy(true);
    setMsg({ text: 'logging in…', kind: 'dlg-note' });
    const hostChanged = trim(props.defaultHost) !== trim(host);
    // The login happens from this tab, which is what can actually see the cluster.
    // Saving to the Worker is separate and does not gate on it.
    if (secret) setCluster(host, username, secret, secretType);
    let loggedIn = false;
    try {
      if (secret) { await clusterToken(); loggedIn = true; }
    } catch (err) {
      setMsg({ text: `Could not log in: ${clusterHint(err)}`, kind: 'dlg-note' });
    }
    try {
      const publishing = publish && tokenAuth && username && (secret || clusterSecret());
      const effectiveSecret = secret || clusterSecret();
      await props.onSave(host, hostChanged, loggedIn, authType, publishing
        ? { username, secret: effectiveSecret, secretType }
        : null, sdkVersion.trim(),
        username && effectiveSecret ? { username, secret: effectiveSecret, secretType } : null);
      if (loggedIn) {
        // The login just proved this tab can read the cluster, which is the only thing the
        // catalog sync needs. Doing it here means search_metadata works straight after
        // connecting, instead of returning nothing until someone finds the Sync button in
        // another dialog. Best effort: a failed sync must not undo a good connection.
        setMsg({ text: `Connected as ${username}. Reading the catalog…`, kind: 'dlg-note' });
        let cached = 0;
        try {
          const found: Array<{ id: string; name: string; type: string }> = [];
          for (const type of CATALOG_TYPES) {
            const rows = await clusterSearch(type, '');
            rows.forEach((r) => found.push({ id: r.id, name: r.name, type }));
          }
          await props.onSync(found);
          cached = found.length;
        } catch { /* the connection stands; Sync from cluster can be retried by hand */ }
        setMsg({
          text: cached
            ? `Connected as ${username}. Cached ${cached} objects.`
            : `Connected as ${username}.`,
          kind: 'dlg-ok',
        });
        setTimeout(props.onClose, cached ? 1100 : 700);
      }
    } catch (err) {
      setMsg({ text: (err as Error).message, kind: 'dlg-err' });
    }
    setBusy(false);
  };

  return (
    <Modal onClose={props.onClose}>
      <h3>{conn ? 'Connect' : 'Connect a cluster'}</h3>
      <p className="dlg-note">
        Saved as soon as you click Connect. These details drive the SDK{'’'}s init(): the host
        becomes the demo{'’'}s ThoughtSpot host (changing it repoints the embeds) and the auth type
        is what init() runs with. The username and secret are used to log in from this tab so
        objects can be listed; the secret is stored server-side and is never returned to the browser.
      </p>
      <Field label="Cluster host">
        <input value={host} placeholder="https://acme.thoughtspot.cloud"
          onChange={(e) => setHost(e.target.value)} />
      </Field>
      <Field label="Username">
        <input value={username} placeholder="embed_user" onChange={(e) => setUsername(e.target.value)} />
      </Field>
      <Field label="SDK version">
        <input
          id="sdkVersion"
          list="sb-sdk-versions"
          value={sdkVersion}
          placeholder="latest"
          onChange={(e) => setSdkVersion(e.target.value)}
        />
      </Field>
      <datalist id="sb-sdk-versions">
        {SDK_VERSIONS.map((v) => <option key={v} value={v} />)}
      </datalist>
      <p className="hint">
        Any version on jsDelivr, or a range like <code>1.51.x</code>. Changing it reloads
        the builder — a bundle already on the page cannot be swapped for another.
      </p>
      <Field label="Auth type">
        <select value={authType} onChange={(e) => setAuthType(e.target.value)}>
          {AUTH_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Field>
      <Field label="Credential type">
        <select value={secretType} onChange={(e) => setSecretType(e.target.value as 'password' | 'secret_key')}>
          <option value="password">Password</option>
          <option value="secret_key">Secret key</option>
        </select>
      </Field>
      <Field label="Password or secret key">
        <input type="password" value={secret}
          placeholder={conn ? '***' : ''}
          onChange={(e) => setSecret(e.target.value)} />
      </Field>
      {clusterReady() && (
        <p className="dlg-note">
          This tab is logged in, so the pickers list real objects. It is remembered for
          this tab only.{' '}
          <button className="linky" onClick={() => {
            clearCluster();
            setSecret('');
            props.onCredentialChange();
            setMsg({ text: 'Cluster credential forgotten for this tab.', kind: 'dlg-note' });
          }}>
            Forget cluster
          </button>
        </p>
      )}
      <label className="checkline">
        <input
          id="publishCred"
          type="checkbox"
          checked={publish && tokenAuth}
          disabled={!tokenAuth}
          onChange={(e) => setPublish(e.target.checked)}
        />
        Let the published site log in with these credentials
      </label>
      {(!tokenAuth || !publish) && (
        <p className="dlg-note">
          {!tokenAuth
            ? `${authType} mints no token, so there is nothing for the page to log in with — pick TrustedAuthToken or TrustedAuthTokenCookieless to publish a credential.`
            : 'Without publishing, the secret stays server-side and the published site fetches tokens from this site\u2019s token proxy instead.'}
        </p>
      )}
      {msg.text && <p className={msg.kind}>{msg.text}</p>}
      <div className="dlg-row">
        <button onClick={props.onClose}>Cancel</button>
        {conn && (
          <button className="danger" onClick={async () => { await props.onSave(null, false, false, authType, null, sdkVersion.trim(), null); props.onClose(); }}>
            Disconnect
          </button>
        )}
        <button className="primary" disabled={busy} onClick={go}>Connect</button>
      </div>
    </Modal>
  );
}

function trim(u: string) {
  let h = String(u || '');
  while (h.endsWith('/')) h = h.slice(0, -1);
  return h;
}

export function PromptDialog(props: {
  title: string;
  initial: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <Modal onClose={props.onClose}>
      <h3>{props.title}</h3>
      <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      <div className="dlg-row">
        <button onClick={props.onClose}>Cancel</button>
        <button className={props.danger ? 'danger' : 'primary'} onClick={() => props.onConfirm(value)}>
          {props.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function ConfirmDialog(props: {
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={props.onClose}>
      <h3>{props.title}</h3>
      <div className="dlg-row">
        <button onClick={props.onClose} autoFocus>Cancel</button>
        <button className="danger" onClick={props.onConfirm}>{props.confirmLabel}</button>
      </div>
    </Modal>
  );
}

/** Offered, not enforced: any version jsDelivr serves works, including a range. */
const SDK_VERSIONS = [
  'latest', '1.51.0', '1.50.0', '1.49.1', '1.48.0', '1.45.0', '1.41.0', '1.36.3',
];


/**
 * Everything an agent needs to take over this project, in one place: where to point its
 * MCP client, the token that authorises writes, and a catalog sync — because the agent
 * has no browser and nothing server-side can reach the cluster, so real ids can only
 * come from here.
 */
/**
 * A value you take, never one you type. These three are facts about the project — the
 * server URL, its id, its token — and rendering them as plain inputs made them look
 * editable, so people tried. Read-only styling plus the button they actually wanted.
 */
function CopyRow(props: { id: string; value: string; onCopy: () => void }) {
  return (
    <div className="row">
      <input
        id={props.id}
        readOnly
        aria-readonly="true"
        spellCheck={false}
        value={props.value}
        onFocus={(e) => e.currentTarget.select()}
        onClick={(e) => e.currentTarget.select()}
      />
      <button title="Copy to clipboard" onClick={props.onCopy}>Copy</button>
    </div>
  );
}

export function BuildWithAiDialog(props: {
  projectId: string;
  editToken: string;
  catalogCount: number;
  syncedAt: number | null;
  onSync: (items: Array<{ id: string; name: string; type: string }>) => Promise<void>;
  onClose: () => void;
}) {
  const [msg, setMsg] = useState<{ text: string; kind: string }>({ text: '', kind: 'dlg-note' });
  const [busy, setBusy] = useState(false);
  // One server for every project: added once, then each call names its project.
  const mcpUrl = `${location.origin}/mcp`;
  const prompt =
    `Add this MCP server: ${mcpUrl}\n` +
    `First call read_manual once and follow it (also at ${mcpUrl}/manual.md).\n` +
    `Then build a ThoughtSpot embed demo in project ${props.projectId}.\n` +
    `Pass projectId "${props.projectId}" and token "${props.editToken}" with every call.\n` +
    `Use search_metadata for real ids, get_config to read, save_config to write,\n` +
    `and lock_project before editing / unlock_project when done.`;

  const copy = (what: string, text: string) => {
    navigator.clipboard.writeText(text).then(
      () => setMsg({ text: `${what} copied.`, kind: 'dlg-ok' }),
      () => setMsg({ text: `Could not copy — select it by hand.`, kind: 'dlg-err' }),
    );
  };

  const sync = async () => {
    if (!clusterReady()) {
      setMsg({ text: 'Connect a cluster in init() first — the sync runs from this tab.', kind: 'dlg-err' });
      return;
    }
    setBusy(true);
    setMsg({ text: 'reading the cluster…', kind: 'dlg-note' });
    try {
      const found: Array<{ id: string; name: string; type: string }> = [];
      for (const type of CATALOG_TYPES) {
        const rows = await clusterSearch(type, '');
        rows.forEach((r) => found.push({ id: r.id, name: r.name, type }));
      }
      await props.onSync(found);
      setMsg({ text: `Cached ${found.length} objects. Agents can read them now.`, kind: 'dlg-ok' });
    } catch (err) {
      setMsg({ text: clusterHint(err), kind: 'dlg-err' });
    }
    setBusy(false);
  };

  return (
    <Modal onClose={props.onClose}>
      <h3>Build with AI</h3>
      <p className="dlg-note">
        Point an agent at this project over MCP and ask it to build the pages. It edits the
        same document the builder does, and the canvas follows along live.
      </p>

      <Field label="MCP server (add once, works for every project)">
        <CopyRow id="mcpUrl" value={mcpUrl} onCopy={() => copy('MCP server', mcpUrl)} />
      </Field>
      <Field label="Project id">
        <CopyRow id="mcpProject" value={props.projectId} onCopy={() => copy('Project id', props.projectId)} />
      </Field>
      <Field label="Edit token">
        <CopyRow id="mcpToken" value={props.editToken} onCopy={() => copy('Edit token', props.editToken)} />
      </Field>
      <div className="dlg-row">
        <button className="primary" onClick={() => copy('Prompt', prompt)}>Copy prompt</button>
      </div>

      <p className="dlg-note">
        {props.catalogCount
          ? `${props.catalogCount} objects cached${props.syncedAt ? ` — synced ${new Date(props.syncedAt).toLocaleString()}` : ''}.`
          : 'No objects cached yet. Without this an agent has no way to learn real ids: it has no browser, and nothing server-side can reach your cluster.'}
      </p>
      {msg.text && <p className={msg.kind}>{msg.text}</p>}
      <div className="dlg-row">
        <button onClick={props.onClose}>Close</button>
        <button className="primary" id="syncCatalog" disabled={busy} onClick={sync}>
          {props.catalogCount ? 'Re-sync from cluster' : 'Sync from cluster'}
        </button>
      </div>
    </Modal>
  );
}
