import { PID, type MetadataItem } from './api';
import { tokenApiMessage } from '../../common/tsError';

/*
 * The cluster is called from the BROWSER. Your browser sits on the network that can
 * see the cluster; a Worker at Cloudflare's edge does not, and cannot skip a
 * self-signed certificate either.
 *
 * The credential is kept in sessionStorage, per project, so a refresh does not silently
 * log you out of the pickers — losing it on every reload is what made "Pick…" look
 * broken. That does put the secret in the browser: acceptable here because this is a
 * demo builder, and scoped to the tab so closing it clears the credential. "Forget
 * cluster" in Connect removes it immediately.
 */

interface ClusterState {
  host: string | null;
  username: string | null;
  secret: string | null;
  secretType: 'password' | 'secret_key';
  token: string | null;
  exp: number;
}

const STORE_KEY = `sb-cluster-${PID}`;

const cluster: ClusterState = {
  host: null, username: null, secret: null, secretType: 'password', token: null, exp: 0,
};

function persist() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({
      host: cluster.host, username: cluster.username,
      secret: cluster.secret, secretType: cluster.secretType,
    }));
  } catch { /* private mode, or storage full: the tab still works for this session */ }
}

(function restore() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || !saved.host || !saved.username || !saved.secret) return;
    cluster.host = saved.host;
    cluster.username = saved.username;
    cluster.secret = saved.secret;
    cluster.secretType = saved.secretType === 'secret_key' ? 'secret_key' : 'password';
  } catch { /* unreadable: start disconnected rather than throw on load */ }
})();

export function setCluster(host: string, username: string, secret: string, secretType: 'password' | 'secret_key') {
  cluster.host = host;
  cluster.username = username;
  cluster.secret = secret;
  cluster.secretType = secretType;
  cluster.token = null;
  cluster.exp = 0;
  persist();
}

export function clearCluster() {
  cluster.host = null; cluster.username = null; cluster.secret = null;
  cluster.token = null; cluster.exp = 0;
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* nothing to remove */ }
}

/**
 * Identity of the credential this tab holds. init() is built differently with one than
 * without, so this belongs in the SDK's cache key — otherwise connecting changes what
 * init() *would* produce without re-running it.
 */
export function clusterFingerprint(): string {
  return clusterReady() ? `${cluster.host}|${cluster.username}|${cluster.secretType}` : '';
}

/** For the Connect dialog, so a stored credential shows as filled rather than blank. */
export function clusterUsername(): string {
  return cluster.username || '';
}

export function clusterSecret(): string {
  return cluster.secret || '';
}

export function clusterSecretType(): 'password' | 'secret_key' {
  return cluster.secretType;
}

export function clusterReady(): boolean {
  return Boolean(cluster.host && cluster.username && cluster.secret);
}

export function clusterHost(): string {
  return cluster.host || '';
}

function url(path: string): string {
  let h = String(cluster.host || '');
  while (h.endsWith('/')) h = h.slice(0, -1);
  return h + path;
}

async function read(res: Response, what: string): Promise<any> {
  if (res.ok) return res.json();
  const text = await res.text().catch(() => '');
  const hint = res.status === 401 || res.status === 403
    ? ' — check the username and password/secret key'
    : res.status === 404 ? ' — check the host' : '';
  const nice = tokenApiMessage(text);
  throw new Error(`${what} failed (${res.status})${hint}${nice ? `: ${nice}` : text ? `: ${text.slice(0, 200)}` : ''}`);
}

/** A cross-origin fetch fails opaquely, so name the two things that actually block it. */
export function clusterHint(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (!/Failed to fetch|NetworkError|Load failed/i.test(m)) return m;
  return `the browser could not reach ${cluster.host}. If it uses a self-signed certificate, ` +
    `open ${cluster.host} in a tab and accept it once. Otherwise add ${location.origin} to the ` +
    "cluster's CORS allowlist (Develop → Customizations → Security settings).";
}

export async function clusterToken(): Promise<string> {
  if (cluster.token && Date.now() < cluster.exp - 5000) return cluster.token;
  const body: Record<string, unknown> = {
    username: cluster.username,
    validity_time_in_sec: 300,
  };
  body[cluster.secretType] = cluster.secret;
  const res = await fetch(url('/api/rest/2.0/auth/token/full'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await read(res, 'Login');
  if (!json || !json.token) throw new Error('the cluster returned no token');
  cluster.token = json.token as string;
  cluster.exp = typeof json.expiration_time_in_millis === 'number'
    ? json.expiration_time_in_millis
    : Date.now() + 250000;
  return cluster.token;
}

export async function clusterSearch(type: string, q: string): Promise<MetadataItem[]> {
  const token = await clusterToken();
  const body: Record<string, unknown> = {
    metadata: [q ? { type, name_pattern: `%${q}%` } : { type }],
    record_offset: 0,
    record_size: 50,
    sort_options: { field_name: 'MODIFIED', order: 'DESC' },
  };
  const res = await fetch(url('/api/rest/2.0/metadata/search'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const rows = await read(res, 'Metadata search');
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r: any) => ({
      id: String(r.metadata_id ?? r.metadata_header?.id ?? ''),
      name: String(r.metadata_name ?? r.metadata_header?.name ?? '(unnamed)'),
    }))
    .filter((r) => r.id);
}
