import { generateCode } from './codegen';
import { buildGraph } from './graph';
import { publicUrls } from './urls';
import { effectiveProject, resolveTheme, tsVarsFor } from './theme';
import {
  deletePage,
  forkProject,
  getPage,
  getProject,
  listPages,
  createProject,
  putPage,
  setProjectConfig,
  updateProjectConfig,
  verifyToken,
  type Env,
} from './db';
import { STARTER_PAGE } from './schema';
import type { PageConfig, ProjectConfig } from './schema';
import { TsRestError, forgetToken, mintToken, searchMetadata } from './tsrest';
import {
  ValidationError,
  normalizePath,
  validatePageConfig,
  validateProjectConfig,
} from './schema';

const PROTOCOL_VERSION = '2025-06-18';

const PAGE_SCHEMA_DOC = `A page is JSON:
{
  "title": "Q3 Sales",
  "header": { "title": "...", "nav": [{"label":"Home","to":"/"}], "show": true, "sticky": true, "align": "split" },
  "footer": { "text": "...", "links": [{"label":"Docs","url":"https://..."}] },
  "css": "optional page-scoped CSS string",
  "blocks": [
    { "type": "heading", "text": "Q3", "level": 1 },
    { "type": "text", "text": "Paragraph copy." },
    { "type": "divider" },
    { "type": "spacer", "size": "32px" },
    { "type": "buttons", "align": "left", "items": [
        { "label": "Reload", "variant": "primary", "actions": [
            { "type": "HostEvent", "params": { "type": "Reload", "payload": {} } }
        ]},
        { "label": "West", "actions": [
            { "type": "HostEvent", "params": { "type": "UpdateFilters", "targets": ["main", 1],
                "payload": { "filters": [{ "columnName": "Region", "operator": "IN", "values": ["West"] }] } } }
        ]},
        { "label": "Detail", "actions": [{ "type": "nav", "params": { "to": "/sales/q3" } }] }
    ]},
    { "type": "embed", "embed": {
        "type": "liveboard",
        "name": "main",
        "config": {
            "liveboardId": "<guid>",
            "fullHeight": true,
            "hiddenActions": ["download"]
        },
        "embedEventHandlers": [
            { "type": "Data", "actions": [
                { "type": "set", "params": { "key": "data-id", "value": "payload.id" } }
            ]}
        ]
    }}
  ]
}

embed.type: liveboard | viz | search | searchbar | app | spotter | conversation.
embed.config IS the SDK constructor config, passed through whole (liveboardId, vizId,
worksheetId, searchOptions, fullHeight, customizations, visibleActions, locale, ...), so
SDK params this schema predates still work.
embed.preRender marks the SDK's PreRendered*Embed: it renders nothing itself and REQUIRES
config.preRenderId. A normal embed carrying the same preRenderId attaches to it, which is
what makes showing it instant. Off unless set — every pre-rendered iframe is a live session.
embed.height / embed.width size the box on the page, not the SDK.
embed.name is how a host-event action addresses this embed; without one it is its index.
embed.embedEventHandlers is a list of { type, id?, actions } where type is an EmbedEvent
name and each action is { type, params }:
  set          params { key, value }   value is a path into the payload, e.g. "payload.id"
  open-modal   params { name }
  close-modal  params { name? }
  host-event   params { hostEvent, data?, targets? }
Read a value back anywhere with getVariable("<key>"), or {{<key>}} inside text.
targets is a list of embed names or indices, or "all"; omitted means the first embed.
Buttons use the SAME actions list: { label, variant?, actions: [{ type, params }] }, with
one extra type, open-url { url, target? }, and nav { to }. A "set" on a button writes the
literal value it is given; a "set" in an event handler reads a path out of the payload.
One button can therefore do several things, and drive several embeds via params.targets.
The older single "action" form still loads and is converted on read.

button actions: nav | open-url | reload | edit | save | download-pdf
| set-filter | host-event.
Use host-event with "hostEvent" for anything else the SDK supports — there are
~92 HostEvents. Note there is NO generic reset-filters host event; to clear
filters use host-event with a real name such as ResetLiveboardPersonalisedView
or ResetSearch. A hostEvent the pinned SDK does not define is not sent: the
button disables itself and says why.

A page may declare several embed blocks; buttons act on the FIRST one.

Header/footer set on a page override the site-level ones for that page only.
Nesting is by path: "/sales" is the parent of "/sales/q3". Create each path you want.`;

const SITE_SCHEMA_DOC = `Site config is JSON (all fields optional, merged into what exists):
{
  "name": "Acme demo",
  "thoughtSpotHost": "https://acme.thoughtspot.cloud",
  "sdkVersion": "1.51.0",
  "authType": "None",
  "theme": { "colorPrimary": "#2770ef", "colorBg": "#fff", "colorSurface": "#f6f7f9",
             "colorText": "#15181d", "colorMuted": "#5c6470", "colorBorder": "#e3e6ea",
             "fontFamily": "Inter, sans-serif", "radius": "8px", "maxWidth": "1180px",
             "headerHeight": "56px", "space": "20px" },
  "header": { "title": "Acme", "logoUrl": "https://...", "sticky": true,
              "nav": [{"label":"Home","to":"/"},{"label":"Sales","to":"/sales"}] },
  "footer": { "text": "© Acme" },
  "css": "site-wide CSS string",
  "embedDefaults": { "customizations": { "style": { "customCSS": {} } } }
}

theme: set colorPrimary alone and the rest of the palette is DERIVED from it in
OKLCH (background, surface, border, text, muted), with colorPrimaryText chosen by
WCAG contrast. Any token you set explicitly wins over the derived one. The derived
palette is also pushed into the embed as ~35 --ts-var-* CSS variables so the embed
matches the site; set themeEmbed:false to stop that, or override individual
variables under embedDefaults.customizations.style.customCSS.variables.
Call get_site to see resolvedTheme and tsVars.

sdkVersion is resolved from the jsDelivr CDN at page load, so any published
version works with no rebuild — use an exact version like "1.51.0", or "latest".
authType: None | EmbeddedSSO | Cookieless | TrustedAuthTokenCookieless.
embedDefaults is merged underneath every page's embed config.`;

/**
 * The whole contract, written for an agent with NO other context. Served on GET /mcp
 * and summarised in initialize.instructions — if knowledge matters, it lives here.
 */
export const MANUAL = `# embed-sandbox MCP server

Builds shareable ThoughtSpot embed demo sites. Pages are JSON documents rendered by a
14KB runtime — you never write HTML or JS. The published site updates live: viewers'
pages re-render within ~5s of any save, and the visual builder follows along too.

## Connecting

Added once at /mcp, this server works on every project: pass projectId and token with
each tool call. Mounted at /mcp/<projectId>, both are implied (token in the
Authorization header). Tokens are per project, shown once at create_project, and
required for every write; reads are public because sharing is the point.

## The workflow that works

1. create_project → returns projectId, editToken (SAVE IT — shown once), and every URL.
2. save_config with config.auth credentials if you have them (see Auth) — then
3. search_metadata → real liveboard/answer/worksheet ids, never guess ids.
4. save_config with the whole document: config + pages keyed by path.
5. get_graph → check pages connect and nothing dangles. get_code → show the human
   real SDK code. get_urls → hand over links.

Small edits: get_page / set_page (replace, not merge). Whole-document edits:
get_config / save_config. set_site merges config; save_config and set_page replace.

## The document

{ config: {...}, pages: { "/": {...}, "/sales/q3": {...} } } — paths nest freely.

config: name, thoughtSpotHost, sdkVersion (any npm version, default latest), authType,
auth, theme, css, header, footer, embedDefaults, modals, catalog, showEmbedErrors,
showCode (default true: a \u2039/\u203A toggle on the published site shows each page's SDK
code with a fork-and-edit link), themeEmbed (default true: pushes the theme into embeds as --ts-var-*), live
(default true: published pages poll /version and re-render on change).

theme tokens: colorPrimary, colorPrimaryText, colorBg, colorSurface, colorText,
colorMuted, colorBorder, fontFamily, fontHeading, radius, maxWidth, headerHeight,
space. css (site) and page.css are raw CSS; useful classes: .sb-header, .sb-nav,
.sb-footer, .sb-heading, .sb-text, .sb-embed, .sb-value, .sb-btn[data-variant],
.sb-divider, .sb-row, .sb-col, .sb-note.

header/footer: { show, title, subtitle, logoUrl, sticky, align: left|center|split,
nav: [{ label, to|url }], links: [...], text }.

page: { title, css, modals, blocks: [...] }.

## Blocks

heading { text, level 1|2|3 } · text { text } · divider · spacer { size }
value { key, label } — shows a value-store key, updates live
buttons { align, items: [{ label, variant primary|secondary|ghost, actions: [...] }] }
row { gap, align, columns: [{ span, blocks }] } — rows cannot nest inside columns
embed — see below. Any block takes style (inline CSS escape hatch).
{{key}} interpolates the value store into any text, dotted paths allowed.

## Embeds

{ type: liveboard|viz|search|searchbar|app|spotter|conversation,
  name,            // how actions address it; defaults to page index
  height, width,   // the box on the page; fullHeight goes in config
  preRender, config: {...}, embedEventHandlers: [...] }

config is the SDK constructor config passed through WHOLE — liveboardId, vizId,
worksheetId, dataSource, searchOptions, fullHeight, hiddenActions, visibleActions,
customizations, locale, anything the SDK takes now or later.

### Pre-render (exact contract)

preRender: true marks the SDK's PreRendered<X>Embed: it loads in the background,
renders nothing visible, and REQUIRES config.preRenderId. A normal embed carrying the
same preRenderId attaches to that iframe when shown — instant paint. With liveboardId
on the preRender block it pre-fetches that board; without, it loads the generic shell
and the visible embed navigates it. One preRenderId can be shared by embeds on
different pages (that is the point, and also how filter-state bugs are reproduced).

## Actions — one vocabulary for buttons and events

{ type, params }:
  nav         { to }
  open-url    { url, target? }
  set         { key, value } — on a BUTTON value is a literal; in an EVENT HANDLER it
              is a path into the event payload ("payload.data.id", blank = whole payload)
  open-modal  { name } · close-modal { name? }
  HostEvent   { type, payload?, targets?, store? }
    targets: embed names/indices, "all", or omitted = first embed on the page
    store: value-store key that receives the RESPONSE — GetFilters, GetParameters and
    GetTML answer, and this is the only way to surface it on the page.

UpdateFilters payload — verified against a live cluster; the embed's own error message
describes { column, oper } and then REJECTS it, so use exactly:
  { "filters": [{ "columnName": "Color", "operator": "IN", "values": ["blue"] }] }

## Event handlers

embedEventHandlers: [{ type: "Data"|"CustomAction"|any EmbedEvent, id?, actions }] —
id filters CustomAction by its callback id. A set action then reads the payload:
  { type: "Data", actions: [{ type: "set", params: { key: "orderId",
    value: "payload.data.id" } }] }
Read back anywhere with {{orderId}}, a value block, or window.<namespace>.getVariable().

## Auth — what a PUBLISHED page can use

The page is public; the backend stores app config only and never talks to a cluster.
  authType None — works if the cluster allows anonymous embed.
  EmbeddedSSO / SAMLRedirect / OIDCRedirect — the visitor authenticates.
  TrustedAuthToken(Cookieless) + auth: { tokenSource: "credentials", username, secret,
    secretType } — THE PAGE mints its own token from the cluster. The secret is in the
    public config, readable by anyone with the link: demo-only, say so to the human.
  auth: { tokenSource: "endpoint", tokenEndpoint, tokenMethod?, tokenField? } — the
    page fetches a token from the human's own service.

search_metadata mints server-side from auth.credentials — works when this server can
reach the cluster (public host, or plain-HTTP port for private/self-signed clusters;
a self-signed HTTPS port is unreachable from a Worker). Falls back to the catalog the
builder caches from the human's browser; result says which source answered via
"source" and "clusterReached". Empty both ways? Ask the human for ids, or to press
Sync in the builder's "Build with AI" dialog.

## Tools

create_project (no token) · get_urls · get_graph (nav + shared-value edges, dangling
links) · get_config / save_config (whole document) · get_site / set_site (config only;
set_site MERGES) · list_pages · get_page / set_page / delete_page · fork_site ·
get_code (path, flavor react|esm|cdn — real SDK code, PreRendered components included)
· search_metadata (type LIVEBOARD|ANSWER|LOGICAL_TABLE, q).

## Rules that bite

- preRender without config.preRenderId is refused.
- viz needs vizId beside liveboardId. liveboard/viz without an id show a placeholder.
- connection.host must be https (or localhost). Page saves REPLACE; site saves MERGE.
- rows cannot nest in columns. Modal names are simple identifiers.
- The value store is per browser tab, not shared between viewers.
`;

const TOOLS = [
  {
    name: 'get_site',
    description:
      'Read this project\'s site-level config (host, SDK version, theme, header, footer) plus the list of page paths that exist. Call this first to see the current state before changing anything.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_site',
    description:
      'Update site-level config. Fields you pass are merged into the existing config; fields you omit are left alone. Use this to set thoughtSpotHost, pin sdkVersion, restyle the whole site via theme, or change the site-wide header/footer.\n\n' +
      SITE_SCHEMA_DOC,
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'object', description: 'Partial site config to merge in.' },
      },
      required: ['config'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pages',
    description:
      'List every page in this project with its path, title, embed type and whether it pre-renders. Cheap overview — use get_page for one page\'s full config.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_page',
    description: 'Read one page\'s full JSON config by path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Page path, e.g. "/" or "/sales/q3".' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_page',
    description:
      'Create or replace a page at a path. This overwrites the whole page config, so send the complete page — call get_page first if you are editing rather than replacing.\n\n' +
      PAGE_SCHEMA_DOC,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Page path, e.g. "/" or "/sales/q3". Parent paths do not have to exist first.',
        },
        page: { type: 'object', description: 'The complete page config.' },
      },
      required: ['path', 'page'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_code',
    description:
      "Show the real ThoughtSpot SDK code a page's embed config produces — init(), the embed constructor with its full config, preRender/showPreRender ordering, and the HostEvent wiring for each button. Read-only and generated, so it always matches the config. Use it to explain to the user what their config actually does, or to hand them code to paste into their own app. flavor \"cdn\" returns a complete standalone HTML page (no build step); \"esm\" returns an npm/import snippet.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Page path, e.g. "/" or "/sales/q3".' },
        flavor: {
          type: 'string',
          enum: ['cdn', 'esm'],
          description: 'cdn = standalone HTML page (default). esm = npm import snippet.',
        },
        includeInit: {
          type: 'boolean',
          description:
            'esm only, default true. init() is global to the app, not per page — pass false to get just the page code when the app already calls init() once at bootstrap.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'fork_site',
    description:
      'Copy this entire project — site config and every page — into a brand-new project with its own edit token, leaving this one untouched. Use when someone wants their own version of a showcase to change freely. Returns the new project id, its edit token (shown once, unrecoverable), and its URLs. Hand the token to the user; they need it to edit the fork.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_config',
    description:
      'Read the WHOLE app as one JSON document: site config, every page keyed by path, and the cluster connection (never its secret). This is the same document save_config writes back, so get it, change what you want, and send it back. Prefer this over get_site/get_page when you are making more than one change.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'save_config',
    description:
      'Write the whole app in one call. REPLACE semantics: config replaces the stored config (a key you drop is dropped), and pages replaces the whole page set (a path missing from it is deleted) — so send the document you got from get_config with your edits applied, not a fragment. Every page is validated before anything is written, so one bad block rejects the whole call and nothing is half-saved.\n\n' +
      PAGE_SCHEMA_DOC,
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'object', description: 'The complete site config.' },
        pages: {
          type: 'object',
          description: 'Every page, keyed by path: {"/": {...}, "/sales/q3": {...}}.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_project',
    description:
      'Make a new demo site and return its id, its edit token, and the URLs to open it. The token is shown once and never again — hand it back to the human. No token is needed to call this.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        thoughtSpotHost: { type: 'string', description: 'https://acme.thoughtspot.cloud' },
        sdkVersion: { type: 'string', description: 'Defaults to latest.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_urls',
    description:
      'Where this project can be opened: the public site, the builder, the JSON editor, its fork link and its API root. Use it to hand a human a link.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_graph',
    description:
      'The site as pages and the links between them: an edge per nav action, and an edge wherever two pages share a value-store key, plus any nav pointing at a page that does not exist. Use it to check a site hangs together before handing it over.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_metadata',
    description:
      "Real ids from the cluster — liveboards, answers, worksheets/tables — so an id is never guessed. Asks the cluster directly, minting a token from the credentials in this project's config (auth.tokenSource \"credentials\"). If the cluster is unreachable from the server — a private IP, or a certificate it will not skip — it falls back to the catalog the builder cached from the browser, and says which source answered.",
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['LIVEBOARD', 'ANSWER', 'LOGICAL_TABLE'] },
        q: { type: 'string', description: 'Optional name filter, case-insensitive.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'delete_page',
    description: 'Delete the page at a path. Deleting "/" leaves the site with no landing page.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function result(id: RpcRequest['id'], value: unknown) {
  return { jsonrpc: '2.0', id, result: value };
}

function rpcError(id: RpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function textResult(id: RpcRequest['id'], payload: unknown) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return result(id, { content: [{ type: 'text', text }] });
}

function toolError(id: RpcRequest['id'], message: string) {
  return result(id, { content: [{ type: 'text', text: message }], isError: true });
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function filterCatalog(cfg: ProjectConfig, type: string, q: string) {
  const needle = q.toLowerCase();
  return (cfg.catalog?.items ?? [])
    .filter((i) => (type ? i.type === type : true))
    .filter((i) => (needle ? i.name.toLowerCase().includes(needle) : true));
}

async function callTool(
  env: Env,
  projectId: string,
  name: string,
  args: Record<string, unknown>,
  origin: string,
): Promise<unknown> {
  switch (name) {
    case 'get_site': {
      const project = await getProject(env, projectId);
      if (!project) throw new ValidationError('project no longer exists');
      const pages = await listPages(env, projectId);
      const theme = resolveTheme(project.config.theme);
      return {
        projectId,
        config: project.config,
        resolvedTheme: theme,
        tsVars: project.config.themeEmbed === false ? null : tsVarsFor(theme),
        pages: pages.map((p) => p.path),
      };
    }
    case 'set_site': {
      const patch = validateProjectConfig(args.config);
      const updated = await updateProjectConfig(env, projectId, patch);
      if (!updated) throw new ValidationError('project no longer exists');
      return { ok: true, config: updated.config };
    }
    case 'list_pages': {
      const pages = await listPages(env, projectId);
      return {
        pages: pages.map((page) => {
          const embed = (page.config.blocks || []).find((b) => b.type === 'embed');
          const spec = embed && embed.type === 'embed' ? embed.embed : null;
          return {
            path: page.path,
            title: page.config.title ?? null,
            blocks: (page.config.blocks || []).length,
            embedType: spec ? spec.type : null,
            preRender: spec ? Boolean(spec.preRender) : false,
            fullHeight: spec ? Boolean(spec.config.fullHeight) : false,
          };
        }),
      };
    }
    case 'get_page': {
      const path = normalizePath(String(args.path ?? ''));
      const page = await getPage(env, projectId, path);
      if (!page) throw new ValidationError(`no page at ${path}`);
      return { path: page.path, page: page.config };
    }
    case 'set_page': {
      const path = normalizePath(String(args.path ?? ''));
      const config = validatePageConfig(args.page);
      await putPage(env, projectId, path, config);
      return { ok: true, path };
    }
    case 'get_code': {
      const path = normalizePath(String(args.path ?? ''));
      const flavor = args.flavor === 'esm' ? 'esm' : 'cdn';
      const project = await getProject(env, projectId);
      if (!project) throw new ValidationError('project no longer exists');
      const page = await getPage(env, projectId, path);
      if (!page) throw new ValidationError(`no page at ${path}`);
      return {
        path,
        flavor,
        code: generateCode(
          effectiveProject(project.config),
          page.config,
          path,
          flavor,
          args.includeInit !== false,
        ),
      };
    }
    case 'fork_site': {
      const forked = await forkProject(env, projectId);
      if (!forked) throw new ValidationError('project no longer exists');
      return {
        ok: true,
        projectId: forked.project.id,
        editToken: forked.token,
        forkedFrom: projectId,
        copiedPages: forked.copiedPages,
        note: 'Give editToken to the user — it cannot be shown again, and without it the fork is read-only forever.',
      };
    }
    case 'get_config': {
      const project = await getProject(env, projectId);
      if (!project) throw new ValidationError('project no longer exists');
      const pages = await listPages(env, projectId);
      return {
        projectId,
        config: project.config,
        pages: Object.fromEntries(pages.map((p) => [p.path, p.config])),
        updatedAt: project.updatedAt,
      };
    }
    case 'save_config': {
      // Validate everything before writing anything: a bad page must not leave the
      // document half-saved.
      const nextConfig = args.config === undefined ? null : validateProjectConfig(args.config);
      let nextPages: Array<[string, PageConfig]> | null = null;
      if (args.pages !== undefined) {
        const raw = args.pages;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new ValidationError('pages must be an object keyed by path');
        }
        nextPages = Object.entries(raw as Record<string, unknown>)
          .map(([path, page]) => [normalizePath(path), validatePageConfig(page ?? {})] as [string, PageConfig]);
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
      return {
        ok: true,
        config: saved?.config,
        pages: Object.fromEntries(pages.map((p) => [p.path, p.config])),
      };
    }
    case 'get_urls': {
      return { projectId, ...publicUrls(origin, projectId) };
    }
    case 'get_graph': {
      const project = await getProject(env, projectId);
      if (!project) throw new ValidationError('project no longer exists');
      const pages = await listPages(env, projectId);
      return buildGraph(
        effectiveProject(project.config),
        pages.map((pg) => ({ path: pg.path, config: pg.config })),
      );
    }
    case 'search_metadata': {
      const project = await getProject(env, projectId);
      if (!project) throw new ValidationError('project no longer exists');
      const cfg = project.config;
      const wanted = args.type ? String(args.type).toUpperCase() : 'LIVEBOARD';
      const q = args.q ? String(args.q) : '';
      const auth = cfg.auth;
      const host = cfg.thoughtSpotHost || '';

      if (host && auth?.tokenSource === 'credentials' && auth.username && auth.secret) {
        try {
          const token = await mintToken(projectId, {
            host,
            username: auth.username,
            secret: auth.secret,
            secretType: auth.secretType === 'secret_key' ? 'secret_key' : 'password',
            validitySeconds: auth.validitySeconds ?? 300,
          });
          const items = await searchMetadata(host, token, wanted, { search: q || undefined });
          return { source: 'cluster', count: items.length, items };
        } catch (err) {
          // Fall through to the catalog rather than fail: unreachable is the normal case
          // for a private cluster, and a cached answer is better than none.
          forgetToken(projectId);
          const why = err instanceof TsRestError ? err.message : String((err as Error).message);
          // A status means the cluster answered and refused; no status means we never
          // got that far. Different problems, different fixes — do not conflate them.
          const answered = err instanceof TsRestError && err.status !== undefined;
          const cached = filterCatalog(cfg, wanted, q);
          return {
            source: 'catalog',
            clusterError: why,
            clusterReached: answered,
            count: cached.length,
            items: cached,
            ...(cached.length ? {} : {
              note: answered
                ? 'The cluster answered but refused the credentials in auth.credentials — ' +
                  'check the username and secret. Nothing is cached to fall back on.'
                : 'The cluster could not be reached from the server, and nothing is cached. ' +
                  'A private IP is fine, but a self-signed HTTPS port is not — try the plain ' +
                  'HTTP port if the cluster has one. Otherwise ask the human to open the ' +
                  'builder and press Sync in "Build with AI".',
            }),
          };
        }
      }

      const cached = filterCatalog(cfg, wanted, q);
      return {
        source: 'catalog',
        syncedAt: cfg.catalog?.syncedAt ?? null,
        count: cached.length,
        items: cached,
        ...(cached.length ? {} : {
          note: 'Nothing to search. Either set config.auth via save_config — ' +
            '{ tokenSource: "credentials", username, secret } — so this server can ask the ' +
            'cluster itself (note the secret then ships in the public page), or ask the ' +
            'human to open the builder and press Sync in "Build with AI", which reads the ' +
            'cluster from their browser. Until then, ask them for the ids.',
        }),
      };
    }
    case 'delete_page': {
      const path = normalizePath(String(args.path ?? ''));
      const removed = await deletePage(env, projectId, path);
      return { ok: removed, path };
    }
    default:
      throw new ValidationError(`unknown tool "${name}"`);
  }
}

const PROJECT_ID_RE = /^[a-z0-9]{8,24}$/;

/** Every tool takes these when the server is mounted once at /mcp for all projects. */
const SHARED_ARGS = {
  projectId: { type: 'string', description: 'Which project to act on.' },
  token: { type: 'string', description: 'That project’s edit token. Required for writes.' },
};

/** create_project is the one tool with no project yet, so it never takes those two. */
const NO_PROJECT = new Set(['create_project']);

function toolsFor(pinned: string | null) {
  if (pinned) return TOOLS;
  return TOOLS.map((tool) => {
    if (NO_PROJECT.has(tool.name)) return tool;
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: { ...SHARED_ARGS, ...(tool.inputSchema as any).properties },
        required: [...new Set([...(((tool.inputSchema as any).required as string[]) ?? []), 'projectId'])],
      },
    };
  });
}

/**
 * `projectId` is pinned when the URL carries one (/mcp/<id>, one server per project).
 * Mounted at /mcp it is null, and each call names its own project and token — which is
 * what lets an agent add this server once and then work on any project.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  projectId: string | null,
): Promise<Response> {
  if (request.method === 'GET') {
    // The manual, for a human in a browser or an agent probing before it connects.
    return new Response(MANUAL, {
      headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  if (request.method !== 'POST') {
    return new Response('MCP endpoint accepts POST or GET', { status: 405 });
  }

  const origin = new URL(request.url).origin;
  const headerToken = bearer(request);
  if (projectId) {
    if (!headerToken || !(await verifyToken(env, projectId, headerToken))) {
      return new Response(JSON.stringify({ error: 'invalid or missing bearer token' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
      });
    }
  }

  let body: RpcRequest | RpcRequest[];
  try {
    body = (await request.json()) as RpcRequest | RpcRequest[];
  } catch {
    return Response.json(rpcError(null, -32700, 'invalid JSON'), { status: 400 });
  }

  const batch = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];

  for (const message of batch) {
    const id = message.id ?? null;
    const method = message.method;

    if (method === 'initialize') {
      responses.push(
        result(id, {
          protocolVersion:
            typeof message.params?.protocolVersion === 'string'
              ? (message.params.protocolVersion as string)
              : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'embed-sandbox', version: '1.0.0' },
          instructions:
            MANUAL,
        }),
      );
      continue;
    }

    if (method === 'ping') {
      responses.push(result(id, {}));
      continue;
    }

    if (method && method.startsWith('notifications/')) continue;

    if (method === 'tools/list') {
      responses.push(result(id, { tools: toolsFor(projectId) }));
      continue;
    }

    if (method === 'tools/call') {
      const name = String(message.params?.name ?? '');
      const args = (message.params?.arguments as Record<string, unknown>) ?? {};
      // Creating a project cannot name one, and there is nothing yet to authorise
      // against — the same as POST /api/projects, which is also unauthenticated.
      if (name === 'create_project') {
        try {
          const config = validateProjectConfig({
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.thoughtSpotHost !== undefined ? { thoughtSpotHost: args.thoughtSpotHost } : {}),
            ...(args.sdkVersion !== undefined ? { sdkVersion: args.sdkVersion } : {}),
          });
          const { project, token: fresh } = await createProject(env, config);
          await putPage(env, project.id, '/', STARTER_PAGE);
          responses.push(textResult(id, {
            projectId: project.id,
            editToken: fresh,
            note: 'The edit token is shown once. Pass it as `token` on every later call, ' +
              'and give it to the human — it cannot be recovered.',
            ...publicUrls(origin, project.id),
          }));
        } catch (err) {
          const msg = err instanceof ValidationError ? err.message : 'could not create the project';
          if (!(err instanceof ValidationError)) console.error('[mcp]', err);
          responses.push(toolError(id, msg));
        }
        continue;
      }

      let pid = projectId;
      if (!pid) {
        pid = String(args.projectId ?? '');
        if (!PROJECT_ID_RE.test(pid)) {
          responses.push(toolError(id, 'projectId is required — pass the project you want to act on'));
          continue;
        }
        const tok = String(args.token ?? headerToken ?? '');
        if (!tok || !(await verifyToken(env, pid, tok))) {
          responses.push(toolError(id, `invalid or missing token for project ${pid}`));
          continue;
        }
      }
      try {
        responses.push(textResult(id, await callTool(env, pid, name, args, origin)));
      } catch (err) {
        const msg = err instanceof ValidationError ? err.message : 'internal error';
        if (!(err instanceof ValidationError)) console.error('[mcp]', err);
        responses.push(toolError(id, msg));
      }
      continue;
    }

    responses.push(rpcError(id, -32601, `method "${method}" not found`));
  }

  if (responses.length === 0) return new Response(null, { status: 202 });

  return Response.json(Array.isArray(body) ? responses : responses[0], {
    headers: { 'cache-control': 'no-store' },
  });
}
