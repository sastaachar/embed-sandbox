import {
  countPages,
  createProject,
  forkProject,
  deletePage,
  getPage,
  getProject,
  listPages,
  putPage,
  setProjectConfig,
  updateProjectConfig,
  verifyToken,
  type Env,
} from './common/db';
import { type Flavor, generateCode } from './common/codegen';
import { buildGraph } from './common/graph';
import { publicUrls } from './common/urls';
import { renderEditor } from './builder/editor';
import { renderBuilder } from './builder/shell';
import { renderForkPage } from './builder/fork';
import { buildOutline } from './common/outline';
import { handleMcp } from './common/mcp';
import {
  ValidationError,
  normalizePath,
  validatePageConfig,
  validateProjectConfig,
  type PageConfig,
} from './common/schema';
import { RUNTIME_VERSION, buildManifest, renderNotFound, renderShell } from './live/shell';
import { sdkUrl } from './common/sdkUrl';
import { contrastOf, effectiveProject, resolveTheme, tsVarsFor } from './common/theme';

const MAX_PAGES_PER_PROJECT = 200;
const PROJECT_ID_RE = /^[a-z0-9]{8,24}$/;

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

  // /api/projects/:id
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
    return json({ updatedAt: project.updatedAt });
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
    const code = generateCode(
      effectiveProject(project.config),
      page.config,
      path,
      flavourParam as Flavor,
      url.searchParams.get('init') !== '0',
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
    return json({ path, flavor: flavourParam, code });
  }

  // /api/projects/:id/connection — design-time login to the cluster. Verifies by
  // actually minting a token, so a bad credential fails here and not later.
  // /api/projects/:id/graph — the site as pages and the links between them. Public,
  // like the outline: it is derived from a document that is already public.
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
<style>
body{margin:0;padding:48px 24px;font:15px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
color:#15181d;background:#fff;display:flex;justify-content:center}
main{max-width:660px;width:100%}
h1{font-size:1.6rem;letter-spacing:-.02em;margin:0 0 8px}
p{color:#5c6470}
pre{background:#f6f7f9;border:1px solid #e3e6ea;border-radius:8px;padding:14px 16px;
overflow-x:auto;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#15181d}
ol{color:#5c6470;padding-left:20px}
li{margin:8px 0}
code{background:#f6f7f9;border:1px solid #e3e6ea;border-radius:4px;padding:1px 5px;font-size:.9em}
</style></head><body><main>
<h1>embed-sandbox</h1>
<p>Shareable ThoughtSpot embed showcases. Start a project, get a project id and an
edit token, point an AI agent at the MCP endpoint, and it builds your pages.</p>
<ol>
<li>Create a project:</li>
</ol>
<pre>curl -X POST ${origin}/api/projects \\
  -H 'content-type: application/json' \\
  -d '{"name":"My demo","thoughtSpotHost":"https://your.thoughtspot.cloud","sdkVersion":"1.51.0"}'</pre>
<ol start="2">
<li>Keep the <code>editToken</code> from the response — it is only shown once.</li>
<li>Your site is live at <code>${origin}/p/&lt;projectId&gt;/</code> — share that link.</li>
<li>Connect an agent to <code>${origin}/mcp/&lt;projectId&gt;</code> with
<code>Authorization: Bearer &lt;editToken&gt;</code> and ask it to build pages.</li>
</ol>
</main></body></html>`;
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

      if (segments[0] === 'mcp') {
        // /mcp        — added once, every call names its project and token
        // /mcp/<id>    — pinned to one project, token in the Authorization header
        const projectId = segments[1] || '';
        if (!projectId) return await handleMcp(request, env, null);
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

      if (segments[0] === 'edit') {
        const projectId = segments[1] || '';
        if (!PROJECT_ID_RE.test(projectId)) {
          return html(renderNotFound('That project id is not valid.'), 404);
        }
        if (!(await getProject(env, projectId))) {
          return html(renderNotFound(`No project with id "${projectId}".`), 404);
        }
        return html(renderEditor(projectId), 200, 'no-store');
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
