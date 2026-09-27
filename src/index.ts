import {
  clearLock,
  countPages,
  createProject,
  deleteProject,
  forkProject,
  deletePage,
  getConnectionSecret,
  getPage,
  getProject,
  listPages,
  putPage,
  setConnection,
  setLock,
  setProjectConfig,
  updateProjectConfig,
  verifyToken,
  type Env,
} from './common/db';
import { type Flavor, generateCode, generateMarkup } from './common/codegen';
import { buildGraph } from './common/graph';
import { publicUrls } from './common/urls';
import { renderBuilder } from './builder/shell';
import { renderForkPage } from './builder/fork';
import { buildOutline } from './common/outline';
import { handleMcp, manualMarkdown } from './common/mcp';
import { TarballError, fileFromTarball } from './common/tarball';
import { TsRestError, mintFreshToken, mintToken } from './common/tsrest';
import {
  ValidationError,
  normalizePath,
  validatePageConfig,
  validateProjectConfig,
  type PageConfig,
} from './common/schema';
import { RUNTIME_VERSION, buildManifest, renderNotFound, renderShell } from './live/shell';
import { prTarballUrl, sdkUrl } from './common/sdkUrl';
import { contrastOf, effectiveProject, resolveTheme, tsVarsFor } from './common/theme';

const MAX_PAGES_PER_PROJECT = 200;
const PROJECT_ID_RE = /^[a-z0-9]{8,24}$/;

// The token auth types. Since the token proxy, the credential NEVER ships in the page:
// these types point config.auth at tokenSource "proxy" and the published site fetches
// /api/projects/<id>/token, minted server-side from the write-only connection.
const SHIPS_PAGE_CREDENTIAL = new Set(['TrustedAuthTokenCookieless', 'TrustedAuthToken']);

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', ...headers },
  });
}

function badRequest(message: string) {
  return json({ error: message }, 400);
}

function html(body: string, status = 200, cacheControl = 'no-store') {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });
}

async function requireToken(request: Request, env: Env, projectId: string): Promise<Response | null> {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match ? match[1].trim() : null;
  if (!token || !(await verifyToken(env, projectId, token))) {
    return json({ error: 'invalid or missing bearer token' }, 401, { 'www-authenticate': 'Bearer' });
  }
  return null;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (contentLength > 512_000) throw new ValidationError('request body too large');
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ValidationError('body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------- render

async function serveShell(request: Request, env: Env, projectId: string): Promise<Response> {
  const project = await getProject(env, projectId);
  if (!project) {
    return html(renderNotFound(`No project with id "${projectId}".`), 404);
  }

  const runtimeSrc = `/_static/live/runtime.js?v=${RUNTIME_VERSION}`;
  const cache = caches.default;
  // One shell serves every path in a project — the runtime routes client-side —
  // so the cache key is the project version, not the request URL.
  const cacheKey = new Request(
    `https://shell.invalid/${projectId}/${project.updatedAt}/${RUNTIME_VERSION}`,
    { method: 'GET' },
  );

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const pages = await listPages(env, projectId);
  const body = renderShell({
    project: { ...project, config: effectiveProject(project.config) },
    pages,
    basePath: `/p/${projectId}`,
    runtimeSrc,
  });

  const response = html(body, 200, 'public, max-age=0, s-maxage=300, must-revalidate');
  await cache.put(cacheKey, response.clone());
  return response;
}

// ------------------------------------------------------------------------- api

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const segments = url.pathname.split('/').filter(Boolean); // ['api','projects',...]

  if (segments[1] !== 'projects') return json({ error: 'not found' }, 404);

  if (segments.length === 2) {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const body = await readJson(request).catch((err) => err as ValidationError);
    if (body instanceof ValidationError) return badRequest(body.message);
    const config = validateProjectConfig(body.config ?? body);
    const { project, token } = await createProject(env, config);
    return json(
      {
        projectId: project.id,
        editToken: token,
        ...publicUrls(url.origin, project.id),
        note: 'Save editToken now — it is not stored in recoverable form and cannot be shown again.',
      },
      201,
    );
  }

  const projectId = segments[2];
  if (!PROJECT_ID_RE.test(projectId)) return json({ error: 'malformed project id' }, 400);

  const project = await getProject(env, projectId);
  if (!project) return json({ error: 'project not found' }, 404);

  // /api/projects/:id — GET the project, PATCH its config, DELETE the whole thing
  if (segments.length === 3) {
    if (request.method === 'GET') {
      const pages = await listPages(env, projectId);
      const theme = resolveTheme(project.config.theme);
      return json({
        projectId,
        config: project.config,
        // Derived at serve time, so changing colorPrimary re-derives everything.
        // Stored config stays sparse; anything set there wins over these.
        resolvedTheme: theme,
        tsVars: project.config.themeEmbed === false ? null : tsVarsFor(theme),
        contrast: {
          primaryTextOnPrimary: contrastOf(theme.colorPrimaryText, theme.colorPrimary),
          textOnBg: contrastOf(theme.colorText, theme.colorBg),
          mutedOnBg: contrastOf(theme.colorMuted, theme.colorBg),
        },
        forkedFrom: project.forkedFrom,
        pages: pages.map((p) => p.path),
        ...publicUrls(url.origin, projectId),
      });
    }
    if (request.method === 'PATCH') {
      const denied = await requireToken(request, env, projectId);
      if (denied) return denied;
      const body = await readJson(request);
      const patch = validateProjectConfig(body.config ?? body);
      const updated = await updateProjectConfig(env, projectId, patch);
      return json({ ok: true, config: updated?.config });
    }
    if (request.method === 'DELETE') {
      const denied = await requireToken(request, env, projectId);
      if (denied) return denied;
      // Irreversible and unrecoverable — the token is the only proof of ownership and
      // it dies with the row — so the caller has to mean it in the query string.
      if (url.searchParams.get('confirm') !== projectId) {
        return badRequest(`add ?confirm=${projectId} to delete this project and its pages`);
      }
      const gone = await deleteProject(env, projectId);
      return json({ ok: gone.deleted, projectId, deletedPages: gone.deletedPages }, gone.deleted ? 200 : 404);
    }
    return json({ error: 'method not allowed' }, 405);
  }

  // /api/projects/:id/config — the whole app as ONE JSON document: site config,
  // every page, and the cluster connection. GET it, edit it, PUT it back. The
  // per-page and per-connection endpoints below are conveniences over this.
  if (segments.length === 4 && segments[3] === 'config') {
    if (request.method === 'GET') {
      const pages = await listPages(env, projectId);
      return json({
        projectId,
        config: project.config,
        pages: Object.fromEntries(pages.map((p) => [p.path, p.config])),
        updatedAt: project.updatedAt,
      });
    }
    if (request.method !== 'PUT') return json({ error: 'method not allowed' }, 405);
    const denied = await requireToken(request, env, projectId);
    if (denied) return denied;
    const body = await readJson(request);

    // Everything is validated before anything is written, so a bad page cannot
    // leave the document half-saved.
    const nextConfig = body.config === undefined ? null : validateProjectConfig(body.config);
    let nextPages: Array<[string, PageConfig]> | null = null;
    if (body.pages !== undefined) {
      const raw = body.pages;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return badRequest('pages must be an object keyed by path, e.g. {"/": {...}}');
      }
      const entries = Object.entries(raw as Record<string, unknown>);
      if (entries.length > MAX_PAGES_PER_PROJECT) {
        return json({ error: `project is limited to ${MAX_PAGES_PER_PROJECT} pages` }, 409);
      }
      nextPages = entries.map(([path, page]) => [normalizePath(path), validatePageConfig(page ?? {})]);
    }
    if (nextConfig) await setProjectConfig(env, projectId, nextConfig);
    if (nextPages) {
      const kept = new Set(nextPages.map(([path]) => path));
      const existing = await listPages(env, projectId);
      for (const [path, config] of nextPages) await putPage(env, projectId, path, config);
      for (const page of existing) {
        if (!kept.has(page.path)) await deletePage(env, projectId, page.path);
      }
    }
    const saved = await getProject(env, projectId);
    const pages = await listPages(env, projectId);
    return json({
      ok: true,
      projectId,
      config: saved?.config,
      pages: Object.fromEntries(pages.map((p) => [p.path, p.config])),
      updatedAt: saved?.updatedAt,
    });
  }

  // /api/projects/:id/version and /manifest — what a published page polls so it can
  // update itself when an agent or the builder changes the document. Public, like the
  // page itself; `version` is deliberately tiny because it is the one that repeats.
  if (segments.length === 4 && segments[3] === 'version') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    // lock rides along so a page can show/clear the overlay without a manifest fetch.
    return json({ updatedAt: project.updatedAt, lock: project.lock });
  }

  // /api/projects/:id/token — the token proxy: the published page calls this instead
  // of carrying a credential, so the secret stays in the write-only server-side
  // connection and never reaches the browser. Public by design (the page must call
  // it), which means whoever has the link can mint a token for that embed user —
  // mitigate with a low-privilege user, auth.objectId scoping and short validity.
  // The Worker must be able to reach the cluster: a public host or a plain-HTTP
  // port; it cannot skip a self-signed certificate.
  if (segments.length === 4 && segments[3] === 'token') {
    const cors = { 'access-control-allow-origin': '*' };
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, cors);
    const cred = await getConnectionSecret(env, projectId);
    if (!cred) {
      return json({
        error: `no cluster connection stored — open /build/${projectId}#connect=1 (edit token in the #t= fragment) and save one`,
      }, 409, cors);
    }
    const hints = project.config.auth as Record<string, any> | undefined;
    try {
      const token = await mintFreshToken(`proxy:${projectId}:${cred.host}:${cred.username}`, {
        host: cred.host,
        username: cred.username,
        secret: cred.secret,
        secretType: cred.secretType,
        ...(hints?.objectId ? { objectId: String(hints.objectId) } : {}),
        ...(hints?.orgId !== undefined ? { orgId: hints.orgId } : {}),
        ...(hints?.validitySeconds ? { validitySeconds: hints.validitySeconds } : {}),
      });
      return json({ token }, 200, cors);
    } catch (err) {
      const msg = err instanceof TsRestError ? err.message : 'could not mint a token';
      if (!(err instanceof TsRestError)) console.error('[token]', err);
      return json({ error: msg }, 502, cors);
    }
  }

  // /api/projects/:id/cluster/<path> — an authenticated relay to the project's cluster,
  // for custom code (run-code) that must re-issue a call it intercepted. The sandbox
  // iframe is cross-origin to both this site and the cluster, and a cluster with no CORS
  // hosts configured cannot be called from a browser at all — so the call is forwarded
  // here instead, with a token minted from the write-only connection.
  //
  // OFF unless the project sets config.clusterProxy. Like the token proxy it is public by
  // necessity, and it is strictly more reach than a token: anyone with the link can send
  // requests as the connection user. Only two path prefixes are forwarded, and the same
  // mitigations apply — a low-privilege user, short validity, and turning it off when the
  // demo is done.
  if (segments.length >= 5 && segments[3] === 'cluster') {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!project.config.clusterProxy) {
      return json({ error: 'cluster relay is off for this project — set config.clusterProxy: true' }, 403, cors);
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405, cors);
    }
    const cred = await getConnectionSecret(env, projectId);
    if (!cred) return json({ error: 'no cluster connection stored' }, 409, cors);

    // Rebuilt from the segments rather than sliced off the raw URL, so ".." and encoded
    // separators cannot walk outside the allow-listed prefixes.
    // filter(Boolean) above drops a trailing empty segment, but "/prism/" and "/prism"
    // are different URLs to the cluster — so the trailing slash is put back.
    const targetPath = '/' + segments.slice(4).map((s) => encodeURIComponent(decodeURIComponent(s))).join('/')
      + (url.pathname.endsWith('/') ? '/' : '');
    const allowed = ['/prism/', '/api/rest/2.0/'];
    if (!allowed.some((prefix) => (targetPath + '/').startsWith(prefix))) {
      return json({ error: `only ${allowed.join(' and ')} are forwarded` }, 403, cors);
    }
    let token: string;
    try {
      token = await mintToken(`proxy:${projectId}:${cred.host}:${cred.username}`, {
        host: cred.host, username: cred.username, secret: cred.secret, secretType: cred.secretType,
      });
    } catch (err) {
      const msg = err instanceof TsRestError ? err.message : 'could not mint a token';
      return json({ error: msg }, 502, cors);
    }
    const target = cred.host.replace(/\/+$/, '') + targetPath + url.search;
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'user-agent': 'embed-sandbox/1.0 (+https://embed-sandbox.spotz.workers.dev)',
          ...(request.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        body: request.method === 'POST' ? await request.text() : undefined,
      });
    } catch (err) {
      console.error('[cluster relay]', err);
      return json({ error: 'the cluster could not be reached' }, 502, cors);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
        ...cors,
      },
    });
  }

  // /api/projects/:id/lock — the advisory edit lock. An agent acquires it before
  // editing so the builder can warn a human editor. Nothing is ever blocked by it;
  // it expires on its own (LOCK_TTL_MS).
  if (segments.length === 4 && segments[3] === 'lock') {
    if (request.method === 'GET') {
      return json({ locked: !!project.lock, lock: project.lock });
    }
    if (request.method !== 'POST' && request.method !== 'DELETE') {
      return json({ error: 'method not allowed' }, 405);
    }
    const denied = await requireToken(request, env, projectId);
    if (denied) return denied;
    if (request.method === 'DELETE') {
      await clearLock(env, projectId);
      return json({ ok: true, locked: false });
    }
    const body = await readJson(request);
    const holder = String(body.holder ?? 'an AI agent').slice(0, 80).trim() || 'an AI agent';
    const note = typeof body.note === 'string' ? body.note.slice(0, 200) : undefined;
    const lock = await setLock(env, projectId, holder, note);
    return json({ ok: true, locked: true, lock });
  }

  if (segments.length === 4 && segments[3] === 'manifest') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const pages = await listPages(env, projectId);
    return json(buildManifest(
      { ...project, config: effectiveProject(project.config) },
      pages,
      `/p/${projectId}`,
    ));
  }

  // /api/projects/:id/code — generated SDK code for a page. Public, like reads:
  // it only restates config that is already visible at /p/<id>/.
  if (segments.length === 4 && segments[3] === 'code') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const path = normalizePath(url.searchParams.get('path') || '/');
    const flavourParam = url.searchParams.get('flavor') || 'cdn';
    if (flavourParam !== 'cdn' && flavourParam !== 'esm' && flavourParam !== 'react') {
      return badRequest('flavor must be cdn, esm or react');
    }
    const page = await getPage(env, projectId, path);
    if (!page) return json({ error: 'page not found' }, 404);
    // The JS flavour's markup half: real copyable HTML, its own view in the switcher.
    if (url.searchParams.get('part') === 'html') {
      return json({ path, flavor: flavourParam, part: 'html', code: generateMarkup(page.config, path) });
    }
    // A page may carry hand-written code for this flavour — a demo usually wants the few
    // lines that make the point rather than the faithful export. Anything not overridden
    // still comes from the generator.
    const override = page.config.codeOverride?.[flavourParam as 'cdn' | 'esm' | 'react'];
    const code = override ?? generateCode(
      effectiveProject(project.config),
      page.config,
      path,
      flavourParam as Flavor,
      url.searchParams.get('init') !== '0',
      `${url.origin}/api/projects/${projectId}/token`,
      url.origin,
    );

    if (url.searchParams.get('download') === '1') {
      const base = (path === '/' ? 'index' : path.slice(1).replace(/\//g, '-')) || 'index';
      const ext = flavourParam === 'esm' ? 'js' : 'html';
      return new Response(code, {
        headers: {
          'content-type': flavourParam === 'esm'
            ? 'text/javascript; charset=utf-8'
            : 'text/html; charset=utf-8',
          'content-disposition': `attachment; filename="${base}.${ext}"`,
          'cache-control': 'no-store',
        },
      });
    }
    return json({
      path,
      flavor: flavourParam,
      code,
      // The note explains a hand-written snippet, so it only travels with one. Attaching
      // it to a generated flavour would describe code the reader is not looking at.
      ...(override
        ? { overridden: true, ...(page.config.codeOverride?.note ? { note: page.config.codeOverride.note } : {}) }
        : {}),
    });
  }

  // /api/projects/:id/connection — design-time login to the cluster. Verifies by
  // actually minting a token, so a bad credential fails here and not later.
  // /api/projects/:id/graph — the site as pages and the links between them. Public,
  // like the outline: it is derived from a document that is already public.
  // /api/projects/:id/connection — the design-time cluster connection. The secret is
  // stored server-side only (never in the public config) and is never read back. For
  // cookieless auth the same credentials are ALSO written to config.auth so the page can
  // mint its own token; for every other auth type they stay server-side, used only by the
  // builder and search_metadata.
  if (segments.length === 4 && segments[3] === 'connection') {
    if (request.method === 'GET') {
      // Non-secret readout for prefilling the connect page. Token required: usernames and
      // host are not public.
      const denied = await requireToken(request, env, projectId);
      if (denied) return denied;
      return json({
        host: project.connection?.host ?? project.config.thoughtSpotHost ?? '',
        username: project.connection?.username ?? project.config.auth?.username ?? '',
        secretType: project.connection?.secretType ?? project.config.auth?.secretType ?? 'password',
        authType: project.config.authType ?? 'TrustedAuthTokenCookieless',
        hasSecret: project.connection?.hasSecret ?? false,
      });
    }
    if (request.method !== 'PUT') return json({ error: 'method not allowed' }, 405);
    const denied = await requireToken(request, env, projectId);
    if (denied) return denied;
    const body = await readJson(request);
    const host = String(body.host ?? '').trim();
    const username = String(body.username ?? '').trim();
    const secret = typeof body.secret === 'string' ? body.secret : '';
    const secretType = body.secretType === 'secret_key' ? 'secret_key' : 'password';
    const authType = String(body.authType ?? 'TrustedAuthTokenCookieless').trim();
    // The builder states outright whether the published page should carry the
    // credential; the connect page never asks, and its silence keeps the safe default.
    // Without this the proxy was forced unconditionally, so the builder's "let the
    // published site log in with these credentials" was overwritten by the very same
    // Connect click that set it.
    const publishInPage = body.publishCredential === true;
    if (!/^https:\/\/.+/i.test(host) && !/^https?:\/\/localhost(:\d+)?/i.test(host)) {
      return badRequest('host must be an https URL (http is allowed only for localhost)');
    }
    if (!username) return badRequest('username is required');
    // A secret is required the first time; on a later save a blank secret keeps the
    // stored one, so the user can change host/username without re-typing the password.
    if (!secret && !project.connection?.hasSecret) return badRequest('a password or secret key is required');
    if (secret) {
      await setConnection(env, projectId, { host, username, secret, secretType });
    }

    // Reflect the choice in the public config: host + authType always. A token auth
    // type points the page at the TOKEN PROXY — the secret stays server-side and the
    // published site never downloads it — unless publishing was asked for outright.
    const nextConfig = { ...project.config, thoughtSpotHost: host, authType } as typeof project.config;
    if (SHIPS_PAGE_CREDENTIAL.has(authType)) {
      const keep = project.config.auth?.objectId ? { objectId: project.config.auth.objectId } : {};
      if (publishInPage) {
        // Deliberate and demo-only: the page mints for itself, so it needs the secret.
        // A blank one here means only the server holds it — read it back out rather
        // than writing an auth block with an empty secret.
        const pageSecret = secret || (await getConnectionSecret(env, projectId))?.secret || '';
        nextConfig.auth = {
          ...keep, tokenSource: 'credentials', username, secret: pageSecret, secretType,
        } as typeof project.config.auth;
      } else {
        nextConfig.auth = { ...keep, tokenSource: 'proxy' } as typeof project.config.auth;
      }
    } else if (nextConfig.auth?.tokenSource === 'credentials' || nextConfig.auth?.tokenSource === 'proxy') {
      // Switched away from a token auth type: the page needs no auth block at all.
      delete nextConfig.auth;
    }
    await setProjectConfig(env, projectId, nextConfig);

    const shipsCredentialInPage = publishInPage && SHIPS_PAGE_CREDENTIAL.has(authType);
    return json({
      ok: true,
      authType,
      shipsCredentialInPage,
      tokenProxy: SHIPS_PAGE_CREDENTIAL.has(authType) && !shipsCredentialInPage,
      connection: { host, username, secretType, hasSecret: true },
    });
  }

  if (segments.length === 4 && segments[3] === 'graph') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const pages = await listPages(env, projectId);
    return json(buildGraph(
      effectiveProject(project.config),
      pages.map((p) => ({ path: p.path, config: p.config })),
    ));
  }

  // /api/projects/:id/outline — the structural view the editor renders
  if (segments.length === 4 && segments[3] === 'outline') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    const path = normalizePath(url.searchParams.get('path') || '/');
    const page = await getPage(env, projectId, path);
    if (!page) return json({ error: 'page not found' }, 404);
    return json(buildOutline(effectiveProject(project.config), page.config, path));
  }

  // /api/projects/:id/fork — no token required: a fork only copies data that is
  // already public at /p/<id>/, and requiring the owner's token would defeat the
  // point of sharing a showcase for others to build on.
  if (segments.length === 4 && segments[3] === 'fork') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const forked = await forkProject(env, projectId);
    if (!forked) return json({ error: 'project not found' }, 404);
    return json(
      {
        projectId: forked.project.id,
        editToken: forked.token,
        forkedFrom: projectId,
        copiedPages: forked.copiedPages,
        ...publicUrls(url.origin, forked.project.id),
        note: 'Save editToken now — it is not stored in recoverable form and cannot be shown again.',
      },
      201,
    );
  }

  // /api/projects/:id/verify — lets the editor check a token without writing
  if (segments.length === 4 && segments[3] === 'verify') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const denied = await requireToken(request, env, projectId);
    if (denied) return denied;
    return json({ ok: true });
  }

  // /api/projects/:id/pages
  if (segments.length === 4 && segments[3] === 'pages') {
    const pathParam = url.searchParams.get('path');

    if (request.method === 'GET') {
      if (pathParam) {
        const page = await getPage(env, projectId, normalizePath(pathParam));
        if (!page) return json({ error: 'page not found' }, 404);
        return json({ path: page.path, page: page.config, updatedAt: page.updatedAt });
      }
      const pages = await listPages(env, projectId);
      return json({ pages });
    }

    if (request.method === 'PUT') {
      const denied = await requireToken(request, env, projectId);
      if (denied) return denied;
      const body = await readJson(request);
      const path = normalizePath(String(body.path ?? pathParam ?? ''));
      const config = validatePageConfig(body.page ?? {});
      const existing = await getPage(env, projectId, path);
      if (!existing && (await countPages(env, projectId)) >= MAX_PAGES_PER_PROJECT) {
        return json({ error: `project is limited to ${MAX_PAGES_PER_PROJECT} pages` }, 409);
      }
      const page = await putPage(env, projectId, path, config);
      return json({ ok: true, path: page.path, updatedAt: page.updatedAt });
    }

    if (request.method === 'DELETE') {
      const denied = await requireToken(request, env, projectId);
      if (denied) return denied;
      if (!pathParam) return badRequest('?path= is required');
      const removed = await deletePage(env, projectId, normalizePath(pathParam));
      return json({ ok: removed }, removed ? 200 : 404);
    }

    return json({ error: 'method not allowed' }, 405);
  }

  return json({ error: 'not found' }, 404);
}

// -------------------------------------------------------------------- landing

function landing(origin: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>embed-sandbox</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{
  --bg:#f6f7f9; --surface:#fff; --ink:#16181d; --muted:#6b7280; --line:#e3e6ec;
  --accent:#2f6df6; --accent-soft:#e8effe; --accent-ink:#fff; --accent-strong:#1f55d0;
  --mark:#1f55d0; --switch:#2f6df6; --danger:#c8372d;
  --shadow-lg:0 12px 32px rgba(16,24,40,.16);
  --r-lg:14px; --r:10px; --r-sm:6px; --pill:999px; --pad:clamp(14px,1.6vw,22px);
  --sans:'Archivo','Helvetica Neue',Helvetica,Arial,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0b1118; --surface:#161f2b; --ink:#e8e4da; --muted:#93a2b4; --line:#24303f;
  --accent:#5b8dfa; --accent-soft:#1a2740; --accent-ink:#0b1017; --accent-strong:#8fb4ff;
  --mark:#d9a441; --switch:#d9a441; --danger:#ef7a6d;
  --shadow-lg:0 18px 44px rgba(0,0,0,.58);
}}
:root[data-theme="dark"]{
  --bg:#0b1118; --surface:#161f2b; --ink:#e8e4da; --muted:#93a2b4; --line:#24303f;
  --accent:#5b8dfa; --accent-soft:#1a2740; --accent-ink:#0b1017; --accent-strong:#8fb4ff;
  --mark:#d9a441; --switch:#d9a441; --danger:#ef7a6d;
  --shadow-lg:0 18px 44px rgba(0,0,0,.58);
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;padding:var(--pad);gap:clamp(14px,2vw,26px);
background:var(--bg);color:var(--ink);font:400 15px/1.6 var(--sans);
display:grid;grid-template-columns:minmax(0,1.12fr) minmax(0,.88fr)}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:var(--r-sm)}

.make{padding:clamp(18px,3.2vw,46px) clamp(10px,2.2vw,30px) 56px;min-width:0}
.eyebrow{margin:0;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
h1{margin:14px 0 0;font-weight:800;font-size:clamp(40px,7.4vw,86px);line-height:.94;letter-spacing:-.04em}
.deck{margin:20px 0 0;max-width:24ch;font-weight:500;font-size:clamp(19px,2.1vw,28px);
line-height:1.3;letter-spacing:-.015em;color:var(--ink)}
.deck em{font-style:normal;color:var(--muted)}

h2.sec{margin:50px 0 0;padding-top:14px;border-top:1px solid var(--line);
font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
#createCard{margin-top:44px;padding-top:6px;border-top:1px solid var(--line)}

.field{margin-top:18px}
label{display:block;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin-bottom:7px}
input{width:100%;font:400 16px/1.4 var(--sans);padding:12px 14px;color:var(--ink);
background:var(--surface);border:1px solid var(--line);border-radius:var(--r)}
input::placeholder{color:var(--muted);opacity:.75}
input:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
@media (max-width:520px){.grid2{grid-template-columns:1fr}}

details.adv{margin-top:16px}
details.adv>summary{cursor:pointer;list-style:none;font-size:13px;font-weight:600;color:var(--muted)}
details.adv>summary::-webkit-details-marker{display:none}
details.adv>summary::before{content:"+";display:inline-block;width:1.1em;font-weight:700;color:var(--muted)}
details.adv[open]>summary::before{content:"\\2212"}

button{font:600 15px/1 var(--sans);cursor:pointer;border-radius:var(--r);padding:13px 19px;
border:1px solid var(--line);background:var(--surface);color:var(--ink);
display:inline-flex;align-items:center;justify-content:center;gap:8px}
button:hover{border-color:var(--accent);color:var(--accent-strong)}
.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.primary:hover{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);filter:brightness(1.07)}
button:disabled{opacity:.6;cursor:progress}
#createBtn{margin-top:24px;width:100%;padding:17px;font-size:17px;letter-spacing:-.01em}
.fine{margin:13px 0 0;font-size:12.5px;color:var(--muted)}
.err{margin:14px 0 0;font-size:14px;font-weight:600;color:var(--danger)}

.copyrow{display:flex;align-items:stretch;border:1px solid var(--line);
border-radius:var(--r);background:var(--surface);overflow:hidden}
.copyrow code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap;border:0;background:transparent;
font:400 13px/1.5 var(--mono);padding:11px 13px;color:var(--ink)}
.copyrow button{flex:0 0 auto;padding:0 15px;font-size:11px;font-weight:700;
letter-spacing:.09em;text-transform:uppercase;color:var(--muted);
border:0;border-left:1px solid var(--line);border-radius:0;background:transparent}
.copyrow button:hover{background:var(--accent-soft);color:var(--accent-strong)}

.mine-row{display:flex;align-items:baseline;gap:14px;padding:14px 0;border-bottom:1px solid var(--line)}
.mine-row:last-child{border-bottom:0}
.mine-name{flex:1;min-width:0}
.mine-name b{display:block;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mine-name code{font:400 11.5px/1.4 var(--mono);color:var(--muted)}
.mine-row a{font-size:13px;font-weight:600;color:var(--accent-strong);text-decoration:none;white-space:nowrap;
padding:5px 11px;border-radius:var(--pill);background:var(--accent-soft)}
.mine-row a:hover{filter:brightness(.96)}
.mine-x{border:0;padding:4px 7px;font-size:13px;color:var(--muted);background:none;border-radius:var(--pill)}
.mine-x:hover{border:0;color:var(--danger);background:var(--bg)}

.agent{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);
box-shadow:var(--shadow-lg);color:var(--ink);
padding:clamp(26px,3.4vw,44px) clamp(20px,2.6vw,38px) 42px;min-width:0;
position:sticky;top:var(--pad);align-self:start;
min-height:calc(100vh - var(--pad) * 2);max-height:calc(100vh - var(--pad) * 2);overflow-y:auto}
.agent .eyebrow{color:var(--mark)}
.agent h2{margin:14px 0 0;font-weight:800;font-size:clamp(30px,3.2vw,40px);
line-height:1.05;letter-spacing:-.03em}
.agent .pl{margin:14px 0 0;max-width:40ch;font-size:15px;color:var(--muted)}
.agent .pl b{color:var(--ink);font-weight:600}
.steps{list-style:none;margin:30px 0 0;padding:0;counter-reset:s}
.steps li{display:grid;grid-template-columns:30px minmax(0,1fr);gap:14px;
padding:22px 0;border-top:1px solid var(--line)}
.steps li::before{counter-increment:s;content:counter(s,decimal-leading-zero);
font:500 12px/1.6 var(--mono);color:var(--mark);letter-spacing:.06em}
.steps h3{margin:0 0 10px;font-size:14px;font-weight:700;letter-spacing:-.005em}
.steps p{margin:9px 0 0;font-size:13px;line-height:1.6;color:var(--muted)}
.steps p.also{margin:15px 0 8px;font-size:12px}
.steps a{color:var(--accent-strong);text-underline-offset:3px}
.agent .copyrow{background:var(--bg)}
.agent .copyrow code{white-space:pre-wrap;overflow-x:visible;word-break:break-word}
.how{display:inline-flex;margin:0 0 14px;padding:3px;border-radius:var(--pill);
background:var(--bg);border:1px solid var(--line)}
.how button{padding:8px 17px;font:700 11px/1 var(--sans);letter-spacing:.08em;text-transform:uppercase;
border:0;border-radius:var(--pill);background:transparent;color:var(--muted)}
.how button:hover{border:0;background:transparent;color:var(--ink)}
.how button[aria-pressed="true"]{background:var(--switch);color:var(--accent-ink)}
.howline{display:grid;grid-template-columns:16px minmax(0,1fr);gap:8px;
margin:0 0 8px;font-size:13px;line-height:1.6;color:var(--muted)}
.hn{font:500 12px/1.6 var(--mono);color:var(--mark)}
.howline b{color:var(--ink);font-weight:600}
code.inline{font:400 .88em/1 var(--mono);background:var(--bg);
border:1px solid var(--line);border-radius:var(--r-sm);padding:2px 6px}
details.api{margin-top:28px;border-top:1px solid var(--line);padding-top:20px}
details.api>summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--muted)}
details.api>summary:hover{color:var(--ink)}
pre{margin:14px 0 0;background:var(--bg);border:1px solid var(--line);
border-radius:var(--r);padding:15px;overflow-x:auto;font:400 12px/1.6 var(--mono);color:var(--ink)}

@media (max-width:940px){
  body{grid-template-columns:1fr;align-content:start}
  .agent{position:static;min-height:0;max-height:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head><body>

<main class="make">
  <p class="eyebrow">ThoughtSpot · Visual Embed SDK</p>
  <h1>embed-sandbox</h1>
  <p class="deck">Create a project, <em>or connect an AI agent and let it build one.</em></p>

  <section id="createCard">
    <div class="field">
      <label for="name">Project name</label>
      <input id="name" placeholder="My demo" autocomplete="off">
    </div>
    <details class="adv">
      <summary>ThoughtSpot host &amp; SDK version</summary>
      <div class="grid2">
        <div>
          <label for="host">ThoughtSpot host</label>
          <input id="host" placeholder="https://your.thoughtspot.cloud" autocomplete="off">
        </div>
        <div>
          <label for="sdk">SDK version</label>
          <input id="sdk" placeholder="latest" autocomplete="off">
        </div>
      </div>
    </details>
    <button id="createBtn" class="primary">Create project</button>
    <p class="err" id="err" hidden></p>
    <p class="fine">Free · the edit token is copied to your clipboard on the way in.</p>
  </section>

  <section id="mineCard" hidden>
    <h2 class="sec">Your builds</h2>
    <div id="mineList"></div>
  </section>
</main>

<aside class="agent">
  <p class="eyebrow">Model Context Protocol</p>
  <h2>Build it with an AI agent</h2>
  <p class="pl">Claude, ChatGPT, Cursor. Any MCP client.</p>

  <ol class="steps">
    <li>
      <div>
        <h3>Connect your agent</h3>
        <div class="how">
          <button data-how="claude" aria-pressed="true">Claude</button>
          <button data-how="chatgpt" aria-pressed="false">ChatGPT</button>
        </div>
        <div id="how-claude">
          <div class="copyrow"><code id="mcpAddTop"></code><button data-copy="mcpAddTop">Copy</button></div>
          <p>Claude Desktop or claude.ai: Settings → Connectors → Add custom connector,
          with the URL below.</p>
        </div>
        <div id="how-chatgpt" hidden>
          <p class="howline"><span class="hn">1</span><span>Settings → turn on <b>Developer
          mode</b>. On a Business or Enterprise workspace an admin enables it under
          Permissions &amp; Roles.</span></p>
          <p class="howline"><span class="hn">2</span><span><b>Apps &amp; connectors → +</b>,
          then create an app.</span></p>
          <p class="howline"><span class="hn">3</span><span>Paste the URL below, including the
          <code class="inline">/mcp</code> path. No authentication.</span></p>
          <p>The menu keeps moving. <a href="https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt"
          target="_blank" rel="noopener">OpenAI's guide</a> is canonical.</p>
        </div>
        <p class="also">MCP server URL for any client:</p>
        <div class="copyrow"><code id="mcpTop"></code><button data-copy="mcpTop">Copy</button></div>
      </div>
    </li>
    <li>
      <div>
        <h3>Build a ThoughtSpot embed project</h3>
        <p>Ask for the demo you want. No token to start. The agent creates the project,
        and the server hands it the <a href="/mcp/manual.md">manual</a>.</p>
      </div>
    </li>
    <li>
      <div>
        <h3>Share the live link</h3>
        <p>Every project publishes at <code class="inline">/p/&lt;id&gt;/</code>. Viewers see the
        finished site, never an editor, and it re-renders within ~5s of any edit.</p>
      </div>
    </li>
  </ol>

  <details class="api">
    <summary>Prefer plain HTTP?</summary>
    <pre>curl -X POST ${origin}/api/projects \\
  -H 'content-type: application/json' \\
  -d '{"name":"My demo","thoughtSpotHost":"https://your.thoughtspot.cloud","sdkVersion":"1.51.0"}'</pre>
  </details>
</aside>

<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var btn = $('createBtn'), err = $('err');

  function fail(msg){ err.textContent = msg; err.hidden = false; btn.disabled = false; btn.textContent = 'Create project'; }

  btn.addEventListener('click', function(){
    err.hidden = true;
    btn.disabled = true; btn.textContent = 'Creating…';
    var body = { name: ($('name').value || 'Untitled demo').trim() };
    var host = $('host').value.trim(); if (host) body.thoughtSpotHost = host;
    var sdk = $('sdk').value.trim(); if (sdk) body.sdkVersion = sdk;
    fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        if (!res.ok) { fail(res.j && res.j.error ? res.j.error : 'Could not create the project.'); return; }
        var d = res.j;
        try {
          localStorage.setItem('sb.tok.' + d.projectId, d.editToken);
          var typed = ($('name').value || '').trim();
          if (typed) localStorage.setItem('sb.name.' + d.projectId, typed);
        } catch (e) { /* private mode: the clipboard copy is the only surviving copy */ }
        // The token rides in the fragment, which never reaches the server; the builder
        // reads it and strips it from the address bar.
        var open = function(){ location.replace('/build/' + d.projectId + '#t=' + encodeURIComponent(d.editToken)); };
        try { navigator.clipboard.writeText(d.editToken).then(open, open); } catch (e2) { open(); }
      })
      .catch(function(){ fail('Network error. Please try again.'); });
  });

  document.addEventListener('click', function(ev){
    var b = ev.target.closest && ev.target.closest('button[data-copy]');
    if (!b) return;
    var text = $(b.getAttribute('data-copy')).textContent;
    navigator.clipboard.writeText(text).then(function(){
      var was = b.textContent; b.textContent = 'Copied'; setTimeout(function(){ b.textContent = was; }, 1300);
    });
  });

  var mcpUrlTop = location.origin + '/mcp';
  $('mcpTop').textContent = mcpUrlTop;
  $('mcpAddTop').textContent = 'claude mcp add --transport http embed-sandbox ' + mcpUrlTop;

  function myBuilds(){
    var out = [];
    try {
      for (var n = 0; n < localStorage.length; n++) {
        var k = localStorage.key(n);
        if (k && k.indexOf('sb.tok.') === 0) {
          var id = k.slice(7);
          var name = '';
          try { name = localStorage.getItem('sb.name.' + id) || ''; } catch (e2) {}
          if (name === id) name = '';
          out.push({ id: id, name: name });
        }
      }
    } catch (e) {}
    out.sort(function(a, b){ return (a.name || a.id).localeCompare(b.name || b.id); });
    return out;
  }
  function renderMine(){
    var list = myBuilds();
    var box = $('mineList');
    while (box.firstChild) box.removeChild(box.firstChild);
    list.forEach(function(p){
      var row = document.createElement('div'); row.className = 'mine-row';
      var nm = document.createElement('div'); nm.className = 'mine-name';
      var b = document.createElement('b');
      b.textContent = p.name || 'Untitled';
      if (!p.name) b.style.opacity = '.6';
      var idc = document.createElement('code'); idc.textContent = p.id;
      nm.appendChild(b); nm.appendChild(idc); row.appendChild(nm);
      var build = document.createElement('a');
      build.href = '/build/' + p.id; build.textContent = 'Builder';
      var live = document.createElement('a');
      live.href = '/p/' + p.id + '/'; live.target = '_blank'; live.rel = 'noopener'; live.textContent = 'Live site';
      var x = document.createElement('button'); x.className = 'mine-x';
      x.textContent = '\\u2715'; x.title = 'Forget this build (removes the token from this browser)';
      x.addEventListener('click', function(){
        try { localStorage.removeItem('sb.tok.' + p.id); localStorage.removeItem('sb.name.' + p.id); } catch (e) {}
        renderMine();
      });
      row.appendChild(build); row.appendChild(live); row.appendChild(x);
      box.appendChild(row);
    });
    $('mineCard').hidden = list.length === 0;
  }
  renderMine();

  var how = document.querySelectorAll('.how button');
  Array.prototype.forEach.call(how, function(t){
    t.addEventListener('click', function(){
      Array.prototype.forEach.call(how, function(o){
        var on = o === t;
        o.setAttribute('aria-pressed', on ? 'true' : 'false');
        $('how-' + o.getAttribute('data-how')).hidden = !on;
      });
    });
  });
})();
</script>
</body></html>`;
}

// ------------------------------------------------------------------- connect

/**
 * Connecting a cluster is a builder dialog, not a page of its own — one form, one set of
 * rules, one place for the bugs to hide. This route only forwards: it moves the edit
 * token out of this URL's fragment and into the builder's, where the builder reads it,
 * strips it from the address bar and opens the Connect dialog. The fragment never
 * reaches the server, so the hand-off has to happen in the browser.
 */
function renderConnectRedirect(projectId: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Connect a cluster</title>
</head><body>
<noscript>Open <a href="/build/${projectId}">/build/${projectId}</a> and press Connect.</noscript>
<script>
(function () {
  var token = '';
  try {
    token = new URLSearchParams(location.hash.replace(/^#/, '')).get('t') || '';
  } catch (e) { /* an unreadable fragment just means there is no token to carry over */ }
  // replace(), not assign(): Back should leave the builder, not bounce through here.
  location.replace('/build/${projectId}#'
    + (token ? 't=' + encodeURIComponent(token) + '&' : '') + 'connect=1');
})();
</script>
</body></html>`;
}

// -------------------------------------------------------------------- routing

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);

    try {
      if (url.pathname === '/' || url.pathname === '') {
        return html(landing(url.origin), 200, 'public, max-age=300');
      }

      if (segments[0] === 'api') {
        return await handleApi(request, env, url);
      }

      // /sdk/pr/<ref>/tsembed.js — the SDK straight off a PR or commit. pkg.pr.new
      // publishes a continuous release per PR as an npm TARBALL, which no <script src>
      // can load, so this does what `npm i <that url>` does: fetch, gunzip, take
      // dist/tsembed.js. Only pkg.pr.new is fetched — this is not an open proxy.
      if (segments[0] === 'sdk') {
        if (segments[1] !== 'pr' || !segments[2] || segments[3] !== 'tsembed.js') {
          return json({ error: 'use /sdk/pr/<pr-number-or-commit>/tsembed.js' }, 404);
        }
        const ref = segments[2];
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(ref)) return json({ error: 'malformed ref' }, 400);
        // A PR number follows the PR's latest commit, so it may only be cached briefly.
        // A commit ref can never change.
        const immutable = !/^\d+$/.test(ref);
        const cache = caches.default;
        const cacheKey = new Request(`https://sdk.invalid/pr/${ref}/tsembed.js`, { method: 'GET' });
        const hit = await cache.match(cacheKey);
        if (hit) return hit;
        try {
          const file = await fileFromTarball(prTarballUrl(ref), 'package/dist/tsembed.js');
          const response = new Response(file, {
            headers: {
              'content-type': 'application/javascript; charset=utf-8',
              'cache-control': immutable
                ? 'public, max-age=3600, s-maxage=31536000, immutable'
                : 'public, max-age=0, s-maxage=300, must-revalidate',
              'x-sdk-source': prTarballUrl(ref),
              'access-control-allow-origin': '*',
            },
          });
          await cache.put(cacheKey, response.clone());
          return response;
        } catch (err) {
          const msg = err instanceof TarballError ? err.message : 'could not unpack that SDK build';
          if (!(err instanceof TarballError)) console.error('[sdk]', err);
          // JS, not JSON: this is loaded by a <script>, and a thrown message is the only
          // thing a page author will actually see.
          return new Response(`console.error(${JSON.stringify(`[embed-sandbox] SDK pr:${ref} — ${msg}`)});`, {
            status: 502,
            headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' },
          });
        }
      }

      if (segments[0] === 'mcp') {
        // /mcp            — added once, every call names its project and token
        // /mcp/manual.md  — the manual as a markdown file (also GET /mcp, read_manual)
        // /mcp/<id>       — pinned to one project, token in the Authorization header
        const projectId = segments[1] || '';
        if (!projectId) return await handleMcp(request, env, null);
        if (projectId === 'manual.md') {
          return new Response(manualMarkdown(url.origin), {
            headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' },
          });
        }
        if (!PROJECT_ID_RE.test(projectId)) return json({ error: 'malformed project id' }, 400);
        return await handleMcp(request, env, projectId);
      }

      if (segments[0] === 'fork') {
        const projectId = segments[1] || '';
        if (!PROJECT_ID_RE.test(projectId)) {
          return html(renderNotFound('That project id is not valid.'), 404);
        }
        const project = await getProject(env, projectId);
        if (!project) {
          return html(renderNotFound(`No project with id "${projectId}".`), 404);
        }
        const pageCount = await countPages(env, projectId);
        const name = project.config.name || 'Embed sandbox';
        return html(renderForkPage(projectId, name, pageCount), 200, 'no-store');
      }

      if (segments[0] === 'build') {
        const projectId = segments[1] || '';
        if (!PROJECT_ID_RE.test(projectId)) {
          return html(renderNotFound('That project id is not valid.'), 404);
        }
        const project = await getProject(env, projectId);
        if (!project) return html(renderNotFound(`No project with id "${projectId}".`), 404);
        const render = renderBuilder;
        return html(render(projectId, sdkUrl(project.config.sdkVersion)), 200, 'no-store');
      }

      if (segments[0] === 'connect') {
        const projectId = segments[1] || '';
        if (!PROJECT_ID_RE.test(projectId)) {
          return html(renderNotFound('That project id is not valid.'), 404);
        }
        if (!(await getProject(env, projectId))) {
          return html(renderNotFound(`No project with id "${projectId}".`), 404);
        }
        return html(renderConnectRedirect(projectId), 200, 'no-store');
      }

      if (segments[0] === 'p') {
        const projectId = segments[1] || '';
        if (!PROJECT_ID_RE.test(projectId)) {
          return html(renderNotFound('That project id is not valid.'), 404);
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return new Response('method not allowed', { status: 405 });
        }
        return await serveShell(request, env, projectId);
      }

      return html(renderNotFound('Nothing is served at this path.'), 404);
    } catch (err) {
      if (err instanceof ValidationError) return badRequest(err.message);
      console.error('[worker]', err);
      return json({ error: 'internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
