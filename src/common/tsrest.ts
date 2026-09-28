/*
 * The only place anything server-side talks to a ThoughtSpot cluster. It works when the
 * Worker can actually reach the cluster — a public cloud instance. It cannot reach a
 * private IP or skip a self-signed certificate, so the caller must be ready to fall
 * back; that is not a bug to fix here, it is what a Worker at the edge can do.
 */

import { tokenApiMessage } from './tsError';

export type SecretType = 'password' | 'secret_key';

export interface MintOptions {
  host: string;
  username: string;
  secret: string;
  secretType: SecretType;
  validitySeconds?: number;
  objectId?: string;
  orgId?: number;
}

export interface MetadataItem {
  id: string;
  name: string;
  type: string;
}

export class TsRestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TsRestError';
  }
}

function base(host: string): string {
  return String(host).replace(/\/+$/, '');
}

async function read(res: Response, what: string): Promise<unknown> {
  if (res.ok) return res.json();
  const detail = await res.text().catch(() => '');
  // A 401 really is the credential. A 403 on a mint is usually something else, and the old
  // message sent people to re-check a password that was already right.
  const hint =
    res.status === 401
      ? ' — the cluster rejected this username/secret outright'
      : res.status === 403 && what === 'Login'
        ? ' — the cluster answered and refused to mint. Retrying will not help. Causes, ' +
          'roughly in order: this is not that user\'s password; trusted authentication is ' +
          'off on the cluster (Develop > Customizations > Security Settings), so no secret ' +
          'key works; the user is not allowed to mint tokens; or secretType is the wrong ' +
          'one, a secret_key sent as a password or the reverse. Check by making the same ' +
          'call yourself: POST <host>/api/rest/2.0/auth/token/full with ' +
          '{username, password, validity_time_in_sec}. If that fails from your own machine ' +
          'too, the cluster is the problem, not this server'
        : res.status === 403
          ? ' — the cluster refused this request'
          : res.status === 404
            ? ' — check the host'
            : '';
  const nice = tokenApiMessage(detail);
  throw new TsRestError(
    `${what} failed (${res.status})${hint}${nice ? `: ${nice}` : detail ? `: ${detail.slice(0, 200)}` : ''}`,
    res.status,
  );
}

/**
 * Tokens are cached per project for as long as the cluster says they are good, minus a
 * safety margin. The cache lives in the isolate, so it survives a burst of tool calls
 * and nothing more — which is exactly the case worth optimising.
 */
const tokens = new Map<string, { token: string; expiresAt: number }>();

/**
 * A token nobody has seen before. The SDK rejects a repeat outright — "Duplicate token.
 * Please issue a new token every time getAuthToken callback is called" — and it calls the
 * callback again on every expiry and retry, so a cached answer breaks the embed rather
 * than saving work. The cache is still worth keeping for the burst it was built for
 * (search_metadata and friends), so it is bypassed here and not removed.
 *
 * The route that calls this is public, so minting stays capped: past `cap` mints a minute
 * for one project the last token is served again, which the SDK may refuse — better than
 * handing anyone with the link an unbounded lever on the cluster's login endpoint.
 */
const mintWindows = new Map<string, { start: number; count: number }>();

export async function mintFreshToken(key: string, opts: MintOptions, cap = 30): Promise<string> {
  const now = Date.now();
  const win = mintWindows.get(key);
  if (!win || now - win.start > 60_000) {
    mintWindows.set(key, { start: now, count: 1 });
  } else {
    win.count += 1;
    if (win.count > cap) {
      const cached = tokens.get(key);
      if (cached && now < cached.expiresAt) return cached.token;
    }
  }
  tokens.delete(key);
  return mintToken(key, opts);
}

export async function mintToken(key: string, opts: MintOptions): Promise<string> {
  const cached = tokens.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const validity = opts.validitySeconds ?? 300;
  const body: Record<string, unknown> = {
    username: opts.username,
    validity_time_in_sec: validity,
  };
  body[opts.secretType] = opts.secret;
  if (opts.objectId) body.object_id = opts.objectId;
  if (opts.orgId !== undefined) body.org_id = opts.orgId;

  const path = opts.objectId ? '/api/rest/2.0/auth/token/object' : '/api/rest/2.0/auth/token/full';
  let res: Response;
  try {
    res = await fetch(base(opts.host) + path, {
      method: 'POST',
      // A Worker sends no User-Agent by default and some clusters' nginx answers a bare
      // 403 to that, so one is set explicitly.
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'embed-sandbox/1.0 (+https://embed-sandbox.spotz.workers.dev)',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new TsRestError(
      `could not reach ${base(opts.host)}: ${(err as Error).message}. A Worker cannot ` +
        'reach a private-IP cluster or skip a self-signed certificate.',
    );
  }
  const json = (await read(res, 'Login')) as { token?: string; expiration_time_in_millis?: number };
  if (!json?.token) throw new TsRestError('the cluster returned no token');

  tokens.set(key, {
    token: json.token,
    expiresAt: typeof json.expiration_time_in_millis === 'number'
      ? json.expiration_time_in_millis - 5000
      : Date.now() + (validity - 5) * 1000,
  });
  return json.token;
}

export function forgetToken(key: string): void {
  tokens.delete(key);
}

export async function searchMetadata(
  host: string,
  token: string,
  type: string,
  opts: { search?: string; limit?: number } = {},
): Promise<MetadataItem[]> {
  const body = {
    metadata: [opts.search ? { type, name_pattern: `%${opts.search}%` } : { type }],
    record_offset: 0,
    record_size: opts.limit ?? 50,
    sort_options: { field_name: 'MODIFIED', order: 'DESC' },
  };
  let res: Response;
  try {
    res = await fetch(base(host) + '/api/rest/2.0/metadata/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new TsRestError(`could not reach ${base(host)}: ${(err as Error).message}`);
  }
  const rows = await read(res, 'Metadata search');
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r: Record<string, any>) => ({
      id: String(r.metadata_id ?? r.metadata_header?.id ?? ''),
      name: String(r.metadata_name ?? r.metadata_header?.name ?? '(unnamed)'),
      type,
    }))
    .filter((r) => r.id);
}
