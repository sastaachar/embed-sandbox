import type { EmbedSpec, ProjectConfig } from './types';
import { clusterFingerprint, clusterReady, clusterToken } from './cluster';
import { PID } from './api';
import { effectiveProject } from '../../common/theme';

/*
 * A pre-rendered embed lives in the SDK's body-level wrapper, so re-rendering or
 * dragging the host never remounts it, and the wrapper is positioned from the host's
 * rect AT CALL TIME — hence the resync after any layout change. That is nicer to edit
 * against, but the canvas follows spec.preRender rather than forcing it on: a preview
 * that pre-renders when the page will not is a preview of a different page.
 */

type AnyLib = any;

let ready: Promise<AnyLib> | null = null;
let usedKey: string | null = null;
/** False when the loaded SDK has no AuthStatus.SUCCESS to listen for. */
let authObservable = true;
let embedDefaults: Record<string, unknown> = {};

export function authIsObservable(): boolean {
  return authObservable;
}

const CLASS_FOR: Record<string, string> = {
  liveboard: 'LiveboardEmbed', viz: 'LiveboardEmbed', search: 'SearchEmbed',
  searchbar: 'SearchBarEmbed', app: 'AppEmbed', spotter: 'SpotterEmbed',
  conversation: 'ConversationEmbed',
};

export interface Slot { embed: any; host: HTMLElement; prerendered: boolean; connected?: boolean }
const slots: Record<string, Slot> = {};

/** The same mint the published page does, so the canvas matches what visitors get. */
async function mintFromConfig(
  host: string,
  auth: { username: string; secret: string; secretType?: string; validitySeconds?: number },
): Promise<string> {
  const body: Record<string, unknown> = {
    username: auth.username,
    validity_time_in_sec: auth.validitySeconds ?? 300,
  };
  body[auth.secretType === 'secret_key' ? 'secret_key' : 'password'] = auth.secret;
  const res = await fetch(`${sameHost(host)}/api/rest/2.0/auth/token/full`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !(json as any).token) {
    throw new Error(
      `the cluster refused the published credentials (${res.status})` +
        (res.status === 401 || res.status === 403 ? ' — check the username and secret' : ''),
    );
  }
  return (json as any).token as string;
}

/** Auth types that redirect or carry their own session: no token needed from us. */
const SELF_AUTH = new Set(['EmbeddedSSO', 'SAMLRedirect', 'OIDCRedirect']);
/** Auth types that cannot init without a getAuthToken. */
const NEEDS_TOKEN = new Set(['TrustedAuthToken', 'TrustedAuthTokenCookieless']);

/**
 * The statuses that actually mean "not authenticated". Enumerated from the 1.51.0
 * bundle, whose AuthStatus is FAILURE, SDK_SUCCESS, SESSION_INFO_SUCCESS, SUCCESS,
 * LOGOUT, WAITING_FOR_POPUP, SAML_POPUP_CLOSED_NO_AUTH. Everything not listed here is
 * progress — SDK_SUCCESS fires on a perfectly healthy init — so an unrecognised status
 * is reported, never treated as failure.
 */
const AUTH_FAILED = new Set(['FAILURE', 'LOGOUT', 'SAML_POPUP_CLOSED_NO_AUTH']);
/** A failure whose reason is expiry is a refresh, not a rejection. */
const EXPIRY_REASON = /expir/i;

/**
 * Whether init() has anything to authenticate with yet. Without this the builder inits
 * at load as AuthType.None with no getAuthToken, and since init() is cached that
 * tokenless call is the one every embed keeps.
 */
export function canInit(config: ProjectConfig): boolean {
  if (!config.thoughtSpotHost) return false;
  if (clusterReady()) return true;
  if (config.auth?.tokenSource === 'credentials' && config.auth.username && config.auth.secret) return true;
  if (config.auth?.tokenSource === 'endpoint') return true;
  return SELF_AUTH.has(config.authType || '');
}

/** The server stores the host with a trailing slash; the dialog does not. Same cluster. */
function sameHost(raw: string | undefined): string {
  return (raw || '').replace(/\/+$/, '');
}

export function ensureSdk(
  config: ProjectConfig,
  onAuth: (msg: string, kind: 'ok' | 'err' | 'info') => void,
) {
  const host = config.thoughtSpotHost || '';
  // A changed host means a different cluster, a changed auth type means a different
  // init(), and gaining or losing this tab's credential changes whether init() gets a
  // getAuthToken at all. All three go in the key: leaving the credential out meant
  // connecting never re-inited, so the embeds kept a tokenless init.
  const key = [
    sameHost(host),
    config.authType || 'None',
    config.auth?.tokenSource || '',
    clusterFingerprint(),
  ].join('\u0000');
  if (ready && usedKey === key) return ready;
  releaseAll();
  usedKey = key;
  // What the RENDERED site builds embeds from: project-level embedDefaults, with the
  // theme folded in as --ts-var-*. The canvas used only the block's own config, which is
  // why customisations set on the project never showed up here.
  embedDefaults = (effectiveProject(config as any).embedDefaults ?? {}) as Record<string, unknown>;

  ready = new Promise((resolve, reject) => {
    const lib = (window as any).tsembed;
    if (!lib) return reject(new Error('SDK failed to load'));
    if (!host) return reject(new Error('no thoughtSpotHost on this project — connect a cluster'));

    const named = config.authType || 'None';

    // Whatever can produce a token, most direct first: the credential this tab holds,
    // otherwise the one the project publishes. The second is what the rendered page uses,
    // so the canvas showing something the site cannot is not a preview worth having.
    let getAuthToken: (() => Promise<string>) | null = null;
    if (clusterReady()) {
      getAuthToken = () => clusterToken();
    } else if (config.auth?.tokenSource === 'credentials' && config.auth.username && config.auth.secret) {
      const auth = config.auth as { username: string; secret: string; secretType?: string; validitySeconds?: number };
      getAuthToken = () => mintFromConfig(host, auth);
    }

    // A project set to None still authenticates when this tab holds a credential —
    // that is what makes the canvas show real content against a locked-down cluster.
    const resolved = named === 'None' && getAuthToken ? 'TrustedAuthTokenCookieless' : named;

    // The SDK rejects a token auth type with no way to get a token, and the message it
    // gives ("Either auth endpoint or getAuthToken function must be provided") does not
    // say which of ours is missing. Refuse here instead, naming the fix.
    if (NEEDS_TOKEN.has(resolved) && !getAuthToken) {
      return reject(new Error(
        `${resolved} needs a token — open init() and connect a cluster so this tab can ` +
        'mint one, or tick “Let the published site log in with these credentials”',
      ));
    }

    const init: Record<string, unknown> = {
      thoughtSpotHost: host,
      authType: lib.AuthType?.[resolved] ?? lib.AuthType.None,
    };
    if (getAuthToken) init.getAuthToken = getAuthToken;

    // init() returns an event emitter. Embeds already wait for auth internally, so this
    // does not gate the mount — it is the only place the outcome is visible at all.
    const authEE = lib.init(init);
    const S = lib.AuthStatus || {};
    // Older SDKs expose no SUCCESS event; without it a successful init is unobservable.
    authObservable = Boolean(authEE?.on && S.SUCCESS);
    if (authEE?.on) {
      for (const [name, event] of Object.entries(S)) {
        if (typeof event !== 'string' && typeof event !== 'number') continue;
        try {
          authEE.on(event, (reason: any) => {
            if (event === S.SUCCESS) {
              onAuth('embeds authenticated', 'ok');
              return;
            }
            const why = typeof reason === 'string' ? reason : reason?.type || name;
            // FAILURE also carries the token expiring, which is the SDK about to mint a
            // new one — the system working. Only the reason tells the two apart.
            if (AUTH_FAILED.has(name) && !EXPIRY_REASON.test(String(why))) {
              onAuth(`init did not authenticate — AuthStatus.${name}: ${why}`, 'err');
              return;
            }
            if (AUTH_FAILED.has(name)) {
              onAuth(`AuthStatus.${name}: ${why} — refreshing, not a failure`, 'info');
              return;
            }
            // Progress, not a verdict. Reported, but it must not repaint the button:
            // SDK_SUCCESS fires on every healthy init.
            onAuth(`AuthStatus.${name}`, 'info');
          });
        } catch { /* an SDK that rejects a status it advertises: nothing to report */ }
      }
    }
    resolve(lib);
  });
  return ready;
}

export function mount(loc: string, spec: EmbedSpec, host: HTMLElement, lib: AnyLib): string | null {
  const existing = slots[loc];
  if (existing) {
    if (existing.host !== host || existing.prerendered !== Boolean(spec.preRender)) {
      release(loc);
    } else {
      if (existing.connected) {
        try { existing.embed.showPreRender(); } catch { /* not yet rendered */ }
      }
      return null;
    }
  }
  const Cls = lib[CLASS_FOR[spec.type]];
  if (!Cls) return `this SDK has no ${spec.type} embed`;

  const prerendered = Boolean(spec.preRender);
  const cfg: Record<string, unknown> = { ...embedDefaults, ...spec.config };
  // No invented id: preRender requires one, so if it is missing that is the author's
  // to fix and the schema says so.
  if (!cfg.fullHeight && !cfg.frameParams) {
    cfg.frameParams = { height: spec.height || '340px' };
  }
  try {
    const embed = new Cls(`#${host.id}`, cfg);
    // preRender() for the background copy; a connecting embed (has a preRenderId) is
    // shown with showPreRender(), which attaches to the shared pre-rendered iframe by
    // id — render() does NOT call showPreRender() under the hood, so it would reveal
    // nothing. A plain embed builds its own iframe with render(). Mirrors the SDK guard:
    //   if (preRenderId) { tsEmbed.showPreRender(); return; }  else tsEmbed.render();
    const connected = !prerendered && Boolean(cfg.preRenderId);
    if (prerendered) embed.preRender();
    else if (connected) embed.showPreRender();
    else embed.render();
    slots[loc] = { embed, host, prerendered, connected };
    return null;
  } catch (err) {
    return `could not mount: ${(err as Error).message}`;
  }
}

export function release(loc: string) {
  const slot = slots[loc];
  if (!slot) return;
  if (slot.connected) {
    // Connected to a PreRendered iframe: hide, never destroy — same as the wrapper.
    try { slot.embed.hidePreRender(); } catch { /* never rendered */ }
  } else if (!slot.prerendered) {
    try { slot.embed.destroy?.(); } catch { /* older SDKs have no destroy */ }
  }
  // A PreRendered slot keeps its iframe alive by design; only our bookkeeping goes.
  delete slots[loc];
}

export function releaseAll() {
  Object.keys(slots).forEach(release);
}

/*
 * The wrapper is positioned from the host's rect at call time, so it goes stale on any
 * layout change — including a plain scroll, which moves the host without re-rendering
 * anything. syncPreRenderStyle() re-reads that rect and is the cheap path; SDKs older
 * than it only expose showPreRender().
 */
function syncNow() {
  Object.keys(slots).forEach((k) => {
    const { embed, connected } = slots[k];
    // Only a CONNECTED embed has a body-level wrapper tracking a host rect.
    if (!connected) return;
    try {
      if (typeof embed.syncPreRenderStyle === 'function') embed.syncPreRenderStyle();
      else embed.showPreRender();
    } catch { /* not rendered yet */ }
  });
}

export function resync() {
  requestAnimationFrame(syncNow);
}

let watching = false;

/** Capture phase: the canvas scrolls in a pane, and scroll does not bubble. */
export function watchLayout() {
  if (watching) return;
  watching = true;
  let queued = false;
  const onLayoutChange = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncNow(); });
  };
  window.addEventListener('scroll', onLayoutChange, { capture: true, passive: true });
  window.addEventListener('resize', onLayoutChange, { passive: true });
}

/** A class on body, not a style on each wrapper: wrappers appear asynchronously. */
export function setInteractive(on: boolean) {
  document.body.classList.toggle('interactive', on);
}
