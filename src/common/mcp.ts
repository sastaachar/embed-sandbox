import { generateCode, generateMarkup } from './codegen';
import { buildGraph } from './graph';
import { connectLink, publicUrls } from './urls';
import { effectiveProject, resolveTheme, tsVarsFor } from './theme';
import {
  clearLock,
  deletePage,
  forkProject,
  getPage,
  getProject,
  listPages,
  createProject,
  putPage,
  refreshLock,
  setLock,
  setProjectConfig,
  updateProjectConfig,
  verifyToken,
  type Env,
  getConnectionSecret,
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
    { "type": "text", "text": "**Markdown** copy — *emphasis*, \`code\`, [links](/sales), and\\n- bullets\\n\\nMARKDOWN ONLY: HTML is never rendered, tags come out as literal text." },
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
Any block's "style" may carry {{key}} tokens; it is re-applied whenever that variable changes,
so a "set" in an event handler can show or hide a block (e.g. a loader until LiveboardRendered).
embed.name is how a host-event action addresses this embed; without one it is its index.
embed.embedEventHandlers is a list of { type, id?, actions } where type is an EmbedEvent
name and each action is { type, params }:
  set          params { key, value }   value is a path into the payload, e.g. "payload.id";
               use params { key, literal } to write an exact value instead — e.g.
               { "key": "status", "literal": "Liveboard is loaded" }
  open-modal   params { name }
  close-modal  params { name? }
  host-event   params { hostEvent, data?, targets? }
  remount      params { targets? } — rebuild the embed in place, re-running beforeRender
  update-embed params { targets? } — same, but pushed into the running frame via
               UpdateEmbedParams (not public SDK API; see "Actions")
  run-code     params { name, code, store?, timeout?, fallback? } — JavaScript run in an
               isolated sandbox with payload / variables / context in scope; \`return\` a JSON
               value and it lands in store. \`name\` is a JS identifier: generated code
               declares the block as \`async function <name>(payload, context)\`. See
               "Custom code" in the manual.
A handler may also carry respond: { type: "run-code", params: { code, fallback? } } — for
events the embed WAITS on (ApiIntercept), the code's return value is the reply.
embed.beforeRender: [actions] runs before the embed is constructed; payload.config is the
resolved SDK config and an object a run-code action returns is merged into it.
page.beforeLoad: [actions] runs before any block renders; payload is { path }.
page.codeOverride: { react?, esm?, cdn?, note? } replaces what the \`‹/›\` view shows for
this page, per flavour — a demo usually wants the few lines that make the point rather than
the faithful export. Anything not overridden still comes from the generator, and the view
says the code is hand-written (with \`note\` if you set one).
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
An UNRELEASED build works too: "pr:641" (a pkg.pr.new PR, follows its latest commit)
or "pr:<commit>" (immutable). This site unwraps that tarball and serves
dist/tsembed.js itself, so the published page loads it like any other version. A
pkg.pr.new URL pasted from package.json is accepted and stored as the same pin.
authType: None | EmbeddedSSO | Cookieless | TrustedAuthTokenCookieless.
embedDefaults is merged underneath every page's embed config.
codeSandboxSrc: https URL of a self-hosted eval-sandbox page for run-code actions (optional).
clusterProxy: true opens /api/projects/<id>/cluster/<path>, the authenticated relay custom
  code uses to re-issue an intercepted call. Off by default; see "Custom code".`;

/**
 * The whole contract, written for an agent with NO other context. Served on GET /mcp
 * and summarised in initialize.instructions — if knowledge matters, it lives here.
 */
export const MANUAL = `# embed-sandbox MCP server

READ THIS ONCE PER SESSION BEFORE USING ANY OTHER TOOL. The full manual — this
document, plus a generated reference for every tool — is the read_manual tool, and is
also served as markdown at GET /mcp/manual.md. Everything an agent gets wrong when it
guesses (the document shape, the pre-render contract, the UpdateFilters payload, the
auth trade-offs) is written down here.

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
2. Connect a cluster — username + password are REQUIRED for search_metadata and anything
   cluster-backed. Read get_config.connection; if connected is false, PUT ALL THE ROUTES IN
   FRONT OF THE HUMAN and let them choose. Never leave them with "connect the sandbox" and
   no link. That is a dead end, and it is the one failure this section exists to prevent.
   Every tool result that hits a connection problem carries a connectionHelp block with the
   link already built from your own edit token; relay it verbatim.
     a. THE CONNECT LINK: /build/<id>#t=<editToken>&connect=1, ready-made in
        connectionHelp.theLink. Opens the builder with the Connect dialog up; they type the
        cluster address, username, password and auth type. The credential is stored
        server-side. The fragment never reaches the server and the builder strips it from
        the address bar.
     b. THE DETAILS HERE IN CHAT: entirely allowed. If they hand you a username and
        password, SAVE THEM. Do not save the host alone and tell them to finish in the
        builder, and do not decline on their behalf: they picked this route, and a half-done
        connection is a project that cannot load. set_site { thoughtSpotHost, authType, auth:
        { tokenSource: "credentials", username, secret, secretType } }, then verify with
        search_metadata. Mention once afterwards, without arguing, that the credential sits
        in the page config where anyone with the site link can read it, so a low-privilege
        user suits a shared demo.
     c. IDS ONLY: they press Sync in the builder's "Build with AI" dialog and their browser
        fills the catalog. search_metadata then answers with source: "catalog".
   Verify with get_config / search_metadata.

   IF THE CLUSTER IS UNREACHABLE FROM THIS SERVER (clusterReached: false) say so plainly:
   it is almost always VPN-only or otherwise private, NOT a bad password, and retrying will
   not fix it. Two consequences, both of which you must tell the human about:
     - METADATA. You cannot read ids from here at all. They connect once in the builder and
       press "Sync from cluster" in the "Build with AI" dialog; their browser is on the VPN,
       so it fetches the liveboards, answers and worksheets and caches them here for you.
       search_metadata then answers with source: "catalog". Until that happens, ask them for
       the ids rather than guessing.
     - DO NOT USE THE TOKEN PROXY. auth.tokenSource "proxy" mints from THIS SERVER, which is
       exactly what cannot reach the cluster, so the published page will not load for
       anyone. On a VPN-only cluster the page must mint for itself out of the viewer's
       browser: auth { tokenSource: "credentials", username, secret, secretType }. It does
       ship the secret in the public page, so use a low-privilege user and say so. "proxy"
       stays the right default for any cluster this server CAN reach.
   WHICH KIND OF CLUSTER IS THIS? It decides everything above, so work it out before you
   debug anything. search_metadata tells you: source "cluster" means this server reached it,
   and on a failure clusterReached says whether it answered at all.

   | kind | how you can tell | what to do |
   |---|---|---|
   | Public SaaS (*.thoughtspot.cloud and friends) | source: "cluster" | Nothing special. Keep auth.tokenSource "proxy" so the secret stays server-side. search_metadata reads ids live. |
   | Dev / Nebula SaaS cluster | public https, but leases expire and clusters hibernate | Same as public while it is up. If it worked before and clusterReached is suddenly false, suspect an expired lease or a hibernating cluster BEFORE you suspect the password. |
   | Internal or VPN-only (*.internal.*, private DNS, an RFC1918 address) | clusterReached: false, "could not reach" | This server will never reach it. Send the connect link, have them press "Sync from cluster" for ids, and set auth.tokenSource "credentials", because "proxy" cannot work. |
   | On their own machine (http://localhost:<port>) | host starts http://localhost | Same as VPN-only, plus one thing you must say out loud: the published link will only work in THEIR browser. Nobody else can open the demo. |
   | Untrusted TLS (self-signed, expired, wrong name) | clusterReached: false, a TLS error in clusterError | Same as VPN-only. If the cluster also serves a plain HTTP port, that one does work from here. |
   | Reachable but refusing (401 / 403) | clusterReached: true | The network is fine and the credentials are not. Say which username was tried and send the connect link so they re-enter it. Do not switch auth types to get around it. |

3. lock_project → announce yourself BEFORE the first edit. The builder warns the human
   ("being vibe-coded", with an Edit anyway escape); every save refreshes the lock, and
   it expires 5 minutes after your last edit anyway.
4. search_metadata → real liveboard/answer/worksheet ids, never guess ids.
5. save_config with the whole document: config + pages keyed by path.
6. get_graph → check pages connect and nothing dangles. get_code → show the human
   real SDK code. get_urls → hand over links.
7. unlock_project → done editing; the builder warning clears immediately.

Small edits: get_page / set_page (replace, not merge). Whole-document edits:
get_config / save_config. set_site merges config; save_config and set_page replace.

## Not sure about the SDK? Ask spotter-code, do not guess

This server knows its own document format. It does NOT know the whole Visual Embed SDK, and a
guessed viewConfig key, EmbedEvent name or HostEvent name produces a demo that silently does
nothing: the page renders, the handler never fires, and nobody notices until a customer does.

ThoughtSpot runs a second MCP server for exactly this:

    https://spottercode.thoughtspot.app/mcp

Add it alongside this one and ask it whenever you are unsure: SDK APIs and their options,
event and action names, auth types, REST endpoints, version differences. Call its own
tools/list first rather than assuming what it offers. Prefer its answer to your training data,
which is older than the SDK you are pinning. If the human has not added it, say that is where
the answer lives rather than guessing and hoping.

## When to call what

| Situation | Call |
|---|---|
| first tool call of the session | read_manual (this document) |
| starting a brand-new demo | create_project → lock_project → connect a cluster → search_metadata → save_config → get_graph → get_urls → unlock_project |
| editing an existing demo | get_config → lock_project → save_config → unlock_project |
| tweaking one page | get_page → set_page (replaces the whole page) |
| site-wide restyle / rename / SDK pin | set_site (merges, so send only what changes) |
| you need a liveboard/answer/worksheet id | search_metadata — NEVER guess ids |
| unsure of an SDK API, event, action or auth type | ask the spotter-code MCP (https://spottercode.thoughtspot.app/mcp). Guessing here fails silently |
| handing the links over | get_urls, and read its cluster field: if it is present, no cluster is connected and every embed renders empty. Send cluster.connectUrl |
| about to make the first edit of a session | lock_project — the builder warns the human |
| done editing | unlock_project — the banner clears immediately |
| explaining the config to the human | get_code (real SDK code) or get_urls (links) |
| checking the site hangs together | get_graph (nav + shared-value edges, dangling links) |
| the human wants their own copy | fork_site |
| cluster not connected yet | offer BOTH: the ready link in connectionHelp.theLink, or the details in chat via set_site. Never say "connect it" with no link |
| creds given in chat but clusterReached: false | VPN/private host. Stop retrying. Send connectionHelp.theLink, have them Sync from cluster for ids, and switch auth off "proxy" to "credentials" |
| cluster answered 401 | wrong username/secret. Say so and send connectionHelp.theLink so they can re-enter them |

## The document

{ config: {...}, pages: { "/": {...}, "/sales/q3": {...} } } — paths nest freely.

config: name, thoughtSpotHost, sdkVersion (any npm version, default latest), authType,
auth, theme, css, header, footer, embedDefaults, modals, catalog, showEmbedErrors,
showCode (default true: a \u2039/\u203A toggle on the published site shows each page's SDK
code with a fork-and-edit link), themeEmbed (default true: pushes the theme into embeds as --ts-var-*), live
(default true: published pages poll /version and re-render on change).

page.codeOverride replaces the \`‹/›\` code view per flavour — see the page schema above.

config.variables: { liveboardId: { label, default, placeholder } } — variables a
VISITOR may set from the site's own settings panel (the gear, beside the ‹/› code
button). {{name}} reads one anywhere, including inside an embed's config and inside a
HostEvent payload, so a liveboard id or a filter value can be a variable with a
default instead of a hard-coded guid or literal.
ONE STORE, and config.variables is its STARTING CONTENT, not a second place a value
comes from: the declared defaults are written into the store at boot and every reader
reads the store afterwards — {{tokens}}, value blocks, and getVariable alike. The code
a page exports says the same thing out loud: a declared default is a setVariable() call
at the top, and every {{token}} in a config or payload is a getVariable("key") read.
Resolution order, everywhere: what this page load set > what the visitor saved in
their own browser > the declared default > unset. Set with setVariable(key, value)
for this load, or setVariable(key, value, { persist: true }) to keep it in their
browser; reset(key) drops theirs. The panel also lets a visitor supply the
thoughtSpotHost/auth the project lacks — kept in their browser, never sent here —
and a page that cannot init() yet says "Settings needed" instead of failing
silently. showSettings:false hides the gear, showCode:false the ‹/›.
NAMED CONFIGS: the panel keeps several sets of host/auth/variables — one per cluster, say —
and switches between them. Each is stored under its own localStorage keys in the visitor's
browser (the unnamed \"Default\" keeps the original keys), so a demo can be loaded against
cluster A, then reloaded against cluster B without retyping anything. They show as tabs
beside the panel title: click one to switch, \`+\` to name a new one, \`\u00d7\` on the active
tab to delete it. \`?config=<name>\` opens the page on one, then strips itself from the
address bar so switching and deleting still stick. Adding a config seeds it from whatever is
on screen, so it means \"branch from here\". Nothing about a config reaches the server.
The panel also carries an SDK version field: a visitor can point the page at another
published SDK (or a \`pr:<n>\` build) in their own browser without touching config.sdkVersion,
and the label shows what a range like \`latest\` resolves to today.

The settings panel also has a DEV MODE toggle (per visitor): it opens a log of every
host event this page fires, the reply that came back, and every embed event received —
each row naming which embed it belongs to. Nothing is logged when it is off. The console
gets its own \u203a_ button at the bottom LEFT, opposite \u2699 and \u2039/\u203a, which opens and closes it;
closing keeps the log, only the dev-mode switch throws it away. Only host and embed are
ticked by default; reply, wire and code are the same traffic seen closer up. The boxes gate
RECORDING, not display \u2014 an unticked direction costs nothing and does not eat the 400-event
budget, but ticking it back on starts from that moment. Its ? explains
all five directions, the badges, and the count, which reads shown/received out of the last
400 events. In the filter box, comma-separated, WHERE THE * IS says what a term means:
Update (anywhere), Update* (starts with), *Filters (ends with), *Filter* (contains, the
same as plain text), Up*Filters (starts with Up and ends with Filters), /^Update/ (regex),
and a leading ! or - drops those rows \u2014 so \"Update*, Navigate*, !Subscribed\" reads as
it sounds. There is no Only/Hide mode. One event is one row: the wire copy of an EmbedEvent
folds into it (marked \u21c4) and a repeat counts up as \u00d7N. A row that just arrived goes dark
and fades back, so a burst is readable. The log keeps going as you move around the site; a
reload starts it fresh, and so does Clear.
Related: a link to a page of this project routes in place now however it is written \u2014 a
Markdown \"[x](/two)\" is the same project-relative path as nav's \"to\", and used to be a
full load of a bare /two that is a page of nothing.

theme tokens: colorPrimary, colorPrimaryText, colorBg, colorSurface, colorText,
colorMuted, colorBorder, fontFamily, fontHeading, radius, maxWidth, headerHeight,
space. css (site) and page.css are raw CSS; useful classes: .sb-header, .sb-nav,
.sb-footer, .sb-heading, .sb-text (a text block; also carries .sb-md, so .sb-md p /
.sb-md ul / .sb-md code reach its Markdown), .sb-embed, .sb-value,
.sb-btn[data-variant], .sb-divider, .sb-row, .sb-col, .sb-note.

header/footer: { show, title, subtitle, logoUrl, sticky, align: left|center|split,
nav: [{ label, to|url }], links: [...], text }.

page: { title, css, modals, blocks: [...] }.

## Blocks

heading { text, level 1|2|3 } — literal text, no formatting
text { text } — MARKDOWN, and Markdown only. See the next section.
divider · spacer { size }
value { key, label, placeholder } — shows a variable, updates live;
      placeholder shows until the key is first set (default "—") — use it for
      loading states ("Loading the Liveboard…")
buttons { align, items: [{ label, variant primary|secondary|ghost, actions: [...] }] }
row { gap, align, columns: [{ span, blocks }] } — rows cannot nest inside columns
embed — see below. Any block takes style (inline CSS escape hatch).
{{key}} interpolates the value store into any text, dotted paths allowed.

## Markdown in text blocks — MARKDOWN ONLY, NEVER HTML

The text block is the only block that formats, and it renders Markdown. This is the
whole grammar; nothing outside it does anything:

  **bold** · __bold__ · *italic* · _italic_ · ~~strike~~ · \`code\`
  [label](url) · ![alt](url) · \\* to escape a character
  # h1 … ###### h6
  - * +  bullets, nested by indenting two spaces
  1.  1)  numbered lists
  >  blockquote
  \`\`\`lang  fenced code block  \`\`\`
  ---  horizontal rule
  a single newline is a line break; a blank line starts a new paragraph

HTML IS NOT SUPPORTED. Not a subset of it, not "safe tags", not with an escape hatch.
There is no sanitiser to get past because there is nothing to get past: the renderer
builds DOM nodes for the Markdown it recognises and turns every other character into
text. Send "<b>hi</b>" and the page shows the eight characters <b>hi</b>. The same is
true of <script>, <iframe>, <img onerror=…>, <br>, HTML entities (&amp; stays &amp;)
and every other markup form. Do NOT try to smuggle layout in through a text block —
use blocks for structure, the block's \`style\` for one-offs, and page/site \`css\` for
anything wider.

Also not supported, so do not emit it: tables, task lists, footnotes, autolinks
(<https://x>), reference-style links, setext (===) headings, heading ids, and any
inline HTML.

Links: only http:, https:, mailto:, tel: and relative or #anchor targets become links.
javascript:, data: and anything else render as the literal text that was written.
{{key}} is interpolated BEFORE the Markdown is parsed, so a variable's value can carry
formatting of its own — and still cannot carry markup.

Every other place text appears — heading, value label/placeholder, button labels,
header/footer text, page titles — is LITERAL text. Markdown there shows its asterisks.

CSS: the rendered wrapper is .sb-text.sb-md, so .sb-md p, .sb-md ul, .sb-md code and
friends are reachable from page or site css.

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
same preRenderId connects to that iframe on plain render() — the SDK does the
connecting; nothing extra is ever called. In React that is <PreRendered<X>Embed> plus
an ordinary <<X>Embed>; in JS it is preRender() on the background instance and render()
on the visible one. With liveboardId on the preRender block it pre-fetches that board;
without, it loads the generic shell and the visible embed navigates it. One preRenderId
can be shared by embeds on different pages (that is the point, and also how
filter-state bugs are reproduced).

## Actions — one vocabulary for buttons and events

{ type, params }:
  nav         { to }
  open-url    { url, target? }
  set         { key, value } — on a BUTTON value is a literal; in an EVENT HANDLER it
              is a path into the event payload ("payload.data.id", blank = whole payload).
              In an event handler, { key, literal } writes the exact value given instead
              — the way to flip a status on Load: { key: "status", literal: "Loaded" }
  open-modal  { name } · close-modal { name? }
  HostEvent   { type, payload?, targets?, store? }
    targets: embed names/indices, "all", or omitted = first embed on the page
    store: value-store key that receives the RESPONSE — GetFilters, GetParameters and
    GetTML answer, and this is the only way to surface it on the page.
    payload: {{tokens}} are resolved out of the value store first, at any depth, so a
    filter can be driven by a variable the visitor sets:
      { "type": "UpdateRuntimeFilters", "payload": [{ "columnName": "{{filterColumn}}",
        "operator": "EQ", "values": ["{{filterValue}}"] }] }
    A token with NO value refuses the whole fire (console + dev log) rather than send
    an empty string, so declare a default in config.variables for anything a payload
    reads. Button labels and a set action's \`literal\` are NOT interpolated.
  run-code    { name, code, store?, timeout?, fallback? } — see "Custom code" below.
  remount     { targets?, when? } — destroy an embed and build it again in place, WITHOUT
              reloading the page. Its beforeRender hook runs afresh, so anything that hook
              decides (disabledActions and the like) is re-decided. Same targets as a host
              event. This is the SUPPORTED way to re-apply an embed config.
  update-embed { targets?, when? } — the same re-decision, pushed into the RUNNING frame instead of
              rebuilding it, so scroll and state survive. Re-runs beforeRender, assigns the
              result onto the instance's viewConfig, and fires UpdateEmbedParams.
              NOT PUBLIC SDK API — \`viewConfig\`, \`getUpdateEmbedParamsObject()\` and the
              UpdateEmbedParams host event are all internal, and it falls back to a rebuild
              on an SDK that does not expose them. Verified on SDK 1.51.2; use \`remount\`
              where a rebuild is acceptable.

  \`when\` on either names a variable that must be TRUTHY for it to fire, and inside an
  ApiIntercept handler it is **required in practice**: rebuilding or re-configuring an embed
  makes the app re-issue the very calls the handler is watching, so an unconditional
  re-apply reloads the page forever. Have the respond code set a flag only when its answer
  actually changes, and point \`when\` at that.

UpdateFilters payload — verified against a live cluster; the embed's own error message
describes { column, oper } and then REJECTS it, so use exactly:
  { "filters": [{ "columnName": "Color", "operator": "IN", "values": ["blue"] }] }

## Event handlers

embedEventHandlers: [{ type: "Data"|"CustomAction"|any EmbedEvent, id?, actions }] —
id filters CustomAction by its callback id. A set action then reads the payload:
  { type: "Data", actions: [{ type: "set", params: { key: "orderId",
    value: "payload.data.id" } }] }
or writes a literal (a load flag, a status string) with { key, literal }:
  { type: "Load", actions: [{ type: "set", params: { key: "status",
    literal: "Liveboard is loaded" } }] }
Read back anywhere with {{orderId}}, a value block, or window.<namespace>.getVariable().

Loading states, the recommended pattern: Load fires when the iframe is up, well before
anything is drawn; LiveboardRendered fires when rendering completes and is what
ThoughtSpot's own examples use to hide a spinner. So: a value block with a placeholder
("Loading…"), a Load handler setting an interim literal ("Rendering…"), and a
LiveboardRendered handler setting the final one ("✓ Ready"). Do NOT surface AuthExpire
or map Error to a status literal — AuthExpire-shaped payloads arrive on the Error
channel every ~5 minutes on a healthy embed and will flip your status spuriously; the
runtime already modals genuinely fatal errors.

## Custom code — run-code, hooks, responders

When the declarative vocabulary is not enough, a run-code action runs JavaScript. It
executes in eval-sandbox: a cross-origin iframe that cannot touch the page, its globals
or its cookies, so a published page stays safe to share.

Your code is the body of a function whose signature names everything it is given:

  async function <name>({ payload, context, getVariable, setVariable }) {
    // your code
  }

What each one is:
  payload    what this hook or event hands over — the only thing that varies per run.
             See the four hook points below for its shape in each.
  context    where the code is running and what it may call. The same four keys every
             time, and the generated code declares them as \`codeContext\`:
               path                     the page path, e.g. "/limit"
               project.thoughtSpotHost  the cluster this site embeds
               project.sdkVersion       the pinned SDK version
               tokenUrl                 GET it for a token for the embed user (the same
                                        proxy the published page itself uses)
               clusterUrl               authenticated relay to the cluster: POST
                                        \`context.clusterUrl + "/prism/?op=X"\` and the
                                        Worker forwards it with a token. Requires the site
                                        to set \`clusterProxy: true\`.
  getVariable(key)        reads the live store — the ONLY way to read a variable
  setVariable(key, value) writes it
                          BOTH ARE ASYNC — \`await getVariable("x")\`. The sandbox is a
                          cross-origin iframe, so each call is a postMessage round trip to
                          the page, which owns the store; a write takes effect immediately
                          and a read sees writes made by earlier runs. Use them instead of
                          params.store when a block writes several keys or writes
                          conditionally. Generated code declares both as async over a Map
                          for you to swap for your own state.
                        The relay exists because the sandbox iframe is cross-origin to the cluster, and a
             cluster with no CORS hosts cannot be called from a browser at all. It is public
             like the token proxy — anyone with the link can send requests as the connection
             user — so use a low-privilege one and turn it off when the demo is done.
\`await\` works (the code runs inside an async function); \`return\` a JSON value.

Give every block a \`name\` — a JS identifier. Generated code declares the function under it
and calls it where the hook fires, so the export reads like code someone wrote. Without one a
name is derived from the position, which is worse. Libraries
via \`await import("https://esm.sh/<pkg>")\`. \`fetch\` is allowed; there are no cookies, so
send a bearer token yourself if you call the cluster. Default timeout 30000 ms
(params.timeout, 100–120000). A run that throws or times out logs to the console and
the dev log and never breaks the page.

Two timing rules, both learned the hard way:
  - An embed's \`interceptTimeout\` must be LONGER than the run-code \`timeout\` of the
    \`respond\` that answers it. The code replies through the responder, so equal values
    mean the app gives up at the same instant the code does and the reply is wasted.
  - Runs are SERIALISED — the sandbox executes one at a time — so a burst of intercepts
    queues, and every run in the queue is counting against its own timeout. Leave slack.

Where it can hook in — four places, one action:
  1. page.beforeLoad: [ { type: "run-code", params: { code, store } } ]
     Runs before any block of the page renders. payload = { path }.
     Return an object and read it back as {{store.field}} anywhere on the page.
  2. embed.beforeRender: [ { type: "run-code", params: { code } } ]
     Runs before THAT embed is constructed. payload = { config, type, name, path } where
     config is the resolved SDK config. An object the code returns is deep-merged into
     the config — the way to decide disabledActions, filters or an id from data fetched
     first. (Pre-flight a REST call, then disable an action with a reason.)
  3. In any actions list — a button, or an embedEventHandler's actions:
     { type: "run-code", params: { code, store } }. In a handler payload is the event
     payload; on a button it is { variables }. Actions run in order and a run-code is
     awaited before the next action starts.
  4. embedEventHandlers[].respond: { type: "run-code", params: { code, fallback } }
     A handler with a respond ANSWERS FIRST, then runs its \`actions\` — the embed is
     blocked until it hears back, and an action with a side effect (a remount) would
     otherwise tear down the frame the reply is owed to.
     For events the embed WAITS on — ApiIntercept, OnBeforeGetVizDataIntercept — the
     return value is passed to the SDK responder as the reply. \`fallback\` is sent
     instead if the code throws or times out, so the app is never left hanging.
     ApiIntercept example — filter a list response to Liveboards only:
       { "type": "ApiIntercept", "respond": { "type": "run-code", "params": {
         "fallback": { "data": { "execute": true } },
         "code": "const op = new URL(payload.input, context.project.thoughtSpotHost).searchParams.get('op');\n
                  if (op !== 'GetMetadataWithStats') return { data: { execute: true } };\n
                  const r = await fetch(new URL(payload.input, context.project.thoughtSpotHost), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + variables.token }, body: JSON.stringify(payload.init.body) });\n
                  const body = await r.json();\n
                  body.data.getMetadataWithStats.objects = body.data.getMetadataWithStats.objects.filter(o => o.type === 'PINBOARD_ANSWER_BOOK');\n
                  return { data: { execute: false, response: { status: r.status, body } } };" } } }
     The embed needs interceptUrls in its config for ApiIntercept to fire at all.

Generated code (get_code) carries every block as a real async function at the place it
runs — awaited before render for hooks, inside the on(...) callback for handlers, as the
responder argument for respond — so the export is the same program without the sandbox.
config.codeSandboxSrc (site) points the sandbox iframe at your own hosted copy of
eval-sandbox's sandbox page; the default is the package's public one.

## Auth — what a PUBLISHED page can use

The page is public; the backend stores app config only and never talks to a cluster.
  authType None — works if the cluster allows anonymous embed.
  EmbeddedSSO / SAMLRedirect / OIDCRedirect — the visitor authenticates.
  TrustedAuthToken(Cookieless) + auth: { tokenSource: "proxy" } — RECOMMENDED. The page
    calls this site's own /api/projects/<id>/token, which mints server-side from the
    write-only connection (saved from the Connect dialog) — NO credential in the page. Set
    automatically when the human saves that dialog with a token auth type, unless they
    tick "let the published site log in with these credentials". Needs a
    cluster the server can reach (public host or plain-HTTP port; not self-signed
    HTTPS — fall back to "credentials" there). Anyone with the link can call the proxy,
    so use a low-privilege user, auth.objectId scoping, short validity.
  … + auth: { tokenSource: "credentials", username, secret, secretType } — THE PAGE
    mints straight from the cluster. The secret is in the public config, readable by
    anyone with the link: demo-only, say so to the human.
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
    name: 'read_manual',
    description:
      'READ FIRST — call this once per session before any other tool. Returns the complete ' +
      'manual as markdown: the document shape, every block/action/embed type, the verified ' +
      'UpdateFilters payload, the pre-render contract, auth trade-offs for a public page, ' +
      'the edit-lock etiquette, an ideal when-to-call-what flow, and a reference for every ' +
      'tool generated from these very definitions. No token needed. The same document is ' +
      'served at GET /mcp/manual.md.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
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
        part: {
          type: 'string',
          enum: ['code', 'html'],
          description: '"html" returns the markup the esm flavour targets (containers, buttons, value spans) instead of the code.',
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
      'Read the WHOLE app as one JSON document: site config, every page keyed by path, and the cluster connection (never its secret). This is the same document save_config writes back, so get it, change what you want, and send it back. Prefer this over get_site/get_page when you are making more than one change. If you have not called read_manual yet this session, do that first.',
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
    name: 'lock_project',
    description:
      'Announce that you are editing: take the advisory edit lock BEFORE your first save. ' +
      'The builder warns any human editing this project (they can still choose Edit anyway) ' +
      'until you unlock_project or the lock expires — 5 minutes after your last save_config/set_page/set_site, each of ' +
      'which refreshes it. Nothing is ever blocked; this is a courtesy signal. Call it again ' +
      'any time to refresh or to change the holder text.',
    inputSchema: {
      type: 'object',
      properties: {
        holder: {
          type: 'string',
          description: 'Who is editing, shown to viewers — e.g. "Claude". Defaults to "an AI agent".',
        },
        note: { type: 'string', description: 'Optional: what you are working on, e.g. "adding a Search page".' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'unlock_project',
    description:
      'Release the advisory edit lock when you are done editing, so the builder stops ' +
      'warning the human immediately instead of after the 5-minute expiry.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_project',
    description:
      'Make a new demo site and return its id, its edit token, and the URLs to open it. The token is shown once and never again — hand it back to the human. No token is needed to call this. If you have not called read_manual yet this session, do that first.',
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
      'Where this project can be opened: the public site, the builder, its fork link and its API root. Use it to hand a human a link.',
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
      "Real ids from the cluster: liveboards, answers, worksheets/tables, so an id is never guessed. Asks the cluster directly, minting a token from the credentials stored for this project. Answers with the source: \"cluster\" means this server reached it; \"catalog\" means it fell back to what the builder cached from the human's browser. On a failure, clusterReached tells you which kind of problem you have: false is an internal/VPN-only host, a localhost cluster or an untrusted certificate, and no amount of retrying will fix it; true with a 401 is simply the wrong credentials. Either way the result carries a connectionHelp block with a ready-to-send connect link and a whichKindOfCluster guide, so relay it rather than guessing.",
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

/**
 * The manual as one markdown file: the hand-written MANUAL plus a tool reference
 * generated from the live TOOLS array, so the file can never drift from the
 * definitions an agent actually receives.
 */
/**
 * Prepended only when this document is served over HTTP, i.e. a human pasted the URL at an
 * agent that is not connected yet. An agent that got here through read_manual already has
 * the tools and does not need to be told to add the server.
 */
function addTheServerFirst(origin: string): string {
  const url = `${origin}/mcp`;
  return [
    '# Someone pasted this URL at you',
    '',
    'This is an **MCP server**, not a web page. Fetching it again just hands you this same',
    'document. Its tools only exist once your client is connected to it, so add it through',
    'your own connector flow first, then start at "The workflow that works" below.',
    '',
    `- **Claude Code**: \`claude mcp add --transport http embed-sandbox ${url}\``,
    `- **Claude Desktop or claude.ai**: Settings, Connectors, Add custom connector, URL \`${url}\``,
    `- **ChatGPT**: open the new-connector dialog at https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins , paste \`${url}\`, Authentication: No authentication. Developer mode must be on first; on a Business or Enterprise workspace an admin turns it on under Permissions & Roles.`,
    `- **Cursor, Windsurf, Zed and the rest**: add a streamable-HTTP MCP server with URL \`${url}\``,
    `- **Anything else**: streamable HTTP at \`${url}\`. Writes send \`Authorization: Bearer <edit token>\`; reads need no token.`,
    '',
    '## Adding it is plumbing, not the task',
    '',
    'Connecting is step zero. The moment it is connected, call read_manual and carry on with',
    'whatever the human actually asked for. Do not stop and report the connection as if it',
    'were the result.',
    '',
    'In particular:',
    '',
    '- **Do not print connector or plugin ids, release ids or "Status: Created" at the human.**',
    '  A plugin id like `plugins_6ab93...` is your client\'s own bookkeeping. It means nothing',
    '  here, nobody can use it, and it reads as though the demo were finished when nothing has',
    '  been built yet. One short line ("connected, building it now") is the whole report.',
    '- **The connector has no pages, no config and no version of the demo.** It is a URL your',
    '  client can call. If the human asked for a Liveboard page and an App page, those are',
    '  pages in a PROJECT you have not created yet: create_project, then save_config. Never',
    '  describe the connector as though it were configured with their pages.',
    '- **A connected server is not a connected cluster.** They are separate steps and they',
    '  fail separately. See the connect section below.',
    '',
    'If your client cannot add MCP servers at all, tell the human that plainly rather than',
    'trying to drive the HTTP API by hand, and point them at the "Prefer plain HTTP?" section',
    `of ${origin} instead.`,
    '',
    '---',
    '',
  ].join('\n');
}

export function manualMarkdown(addServerOrigin?: string | null): string {
  const ref = TOOLS.map((t) => {
    const schema = t.inputSchema as unknown as {
      properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
      required?: string[];
    };
    const args = Object.entries(schema.properties ?? {}).map(([key, spec]) => {
      const req = schema.required?.includes(key) ? ' (required)' : '';
      const kind = spec.enum ? spec.enum.join(' | ') : spec.type ?? '';
      return `- \`${key}\`${req}${kind ? ` — ${kind}` : ''}${spec.description ? `. ${spec.description}` : ''}`;
    });
    return `### ${t.name}\n\n${t.description}\n${args.length ? `\nArguments:\n\n${args.join('\n')}\n` : '\nNo arguments.\n'}`;
  }).join('\n');
  return (
    (addServerOrigin ? addTheServerFirst(addServerOrigin) : '') +
    `${MANUAL}\n\n## Tool reference\n\n` +
    'Generated from the live tool definitions, so it cannot drift. Mounted at /mcp ' +
    '(not pinned to a project), every tool except read_manual and create_project also ' +
    'takes `projectId` and `token`; at /mcp/<projectId> both are implied.\n\n' +
    `${ref}`
  );
}

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

function textResult(id: RpcRequest['id'], payload: unknown, structured?: unknown) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  // A tool that declares an outputSchema has to answer with structuredContent too, and the
  // text block stays for clients that never look at it.
  const sc = structured !== undefined
    ? structured
    : (payload && typeof payload === 'object' ? payload : undefined);
  return result(id, sc === undefined
    ? { content: [{ type: 'text', text }] }
    : { content: [{ type: 'text', text }], structuredContent: sc });
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

/**
 * A non-secret readout of the cluster connection. `connected` means search_metadata can
 * mint server-side (host + credentials present); the secret itself is never returned.
 * This is what an agent reads after a human fills the details on the site, to pull them.
 */
function connectionStatus(
  cfg: ProjectConfig,
  connection: { host: string; username: string; hasSecret: boolean } | null,
  origin: string,
  projectId: string,
  editToken?: string | null,
) {
  const auth = cfg.auth;
  const host = connection?.host || cfg.thoughtSpotHost || null;
  // A server-side connection works for every auth type; a public credentials block is the
  // legacy fallback. Either one lets search_metadata mint.
  const hasServerSecret = !!connection?.hasSecret;
  const hasPublicSecret = !!(auth && auth.tokenSource === 'credentials' && auth.username && auth.secret);
  return {
    connected: hasServerSecret || hasPublicSecret,
    thoughtSpotHost: host,
    authType: cfg.authType || null,
    username: connection?.username || auth?.username || null,
    credentialStoredServerSide: hasServerSecret,
    credentialShippedInPage: hasPublicSecret,
    // With the caller's own token spliced in, so it can be sent as-is. Without a token
    // (a public read) it is the tokenless form, which prompts for one.
    connectUrl: editToken
      ? connectLink(origin, projectId, editToken)
      : publicUrls(origin, projectId).connectUrl,
  };
}

/**
 * The two ways a human connects a cluster, handed to the agent so it can relay them. Both
 * store the credential server-side so search_metadata can mint. For cookieless auth the
 * credential ALSO ships in the public page (the page mints its own token); for every other
 * auth type it stays server-side only.
 */
function connectionHelp(origin: string, projectId: string, editToken?: string | null) {
  // Built with the token the caller already authenticated with, so it is ready to paste
  // rather than a placeholder the agent has to fill in. ChatGPT could not fill it in and
  // ended up telling the human to "connect the sandbox" with no link at all.
  const link = editToken
    ? connectLink(origin, projectId, editToken)
    : connectLink(origin, projectId, '<editToken>').replace('%3CeditToken%3E', '<editToken>');
  const ready = !!editToken;
  return {
    sendBothOptions:
      'Give the human BOTH routes and let them pick. Do not decide for them, and do not ' +
      'tell them off for offering the password here: (1) open the connect link below and ' +
      'fill the dialog in themselves, or (2) give you the cluster address, username and ' +
      'password in chat and you store them with set_site. Either way, say what each one ' +
      'does with the credential (see note) and let them choose.',
    theLink: ready
      ? link
      : link + ' (substitute the real edit token for <editToken> before sending)',
    optionOnThePage:
      `Send them this link: ${link}` + (ready ? '' : ' (with the real edit token in the #t= ' +
      'fragment)') + '. It opens the builder with the Connect dialog already up; they fill ' +
      'in the cluster address, username, password and auth type, and the credential is ' +
      'stored server-side. The token rides in the fragment, which never leaves their ' +
      'browser, and the builder strips it from the address bar. Then call get_config and ' +
      'check connection.connected.',
    optionHereInChat:
      'IF THEY HAVE GIVEN YOU THE USERNAME AND PASSWORD, SAVE THEM. Do not save only the ' +
      'host and send them to the builder to finish: they already chose this route, and ' +
      'stopping half way leaves a project that cannot load and a human who has to redo the ' +
      'work. set_site: { thoughtSpotHost, authType: "TrustedAuthTokenCookieless", auth: ' +
      '{ tokenSource: "credentials", username, secret, secretType: "password" } }, then ' +
      'verify with search_metadata. Afterwards mention once, plainly and without arguing, ' +
      'that this route puts the credential in the page config, which anyone with the site ' +
      'link can read, so a low-privilege user suits a shared demo. Saying it once is the ' +
      'whole job; the decision was theirs and they have made it.',
    optionSyncFromTheirBrowser:
      'Only ids needed, not a live connection? They can press Sync in the builder\'s ' +
      '"Build with AI" dialog and their browser fills the catalog; search_metadata then ' +
      'answers from it with source: "catalog". Works when this server cannot reach the ' +
      'cluster at all.',
    ifTheClusterIsUnreachable:
      'clusterReached: false means THIS SERVER cannot route to the cluster. Nearly always ' +
      'a VPN-only or otherwise private host, or a self-signed HTTPS port. It is not a bad ' +
      'password, and retrying will not fix it. The human\'s browser IS on that VPN, so ' +
      'everything has to happen from their side: ' +
      `send them ${link} to connect, then have them press "Sync from cluster" in the ` +
      'builder\'s "Build with AI" dialog. That one sync pulls the liveboard, answer and ' +
      'worksheet ids through their browser and caches them here, and search_metadata ' +
      'answers from the cache afterwards with source: "catalog". Until they do it, you ' +
      'have no ids and must ask them for the ones they want.',
    doNotUseTheProxyOnAVpnCluster:
      'IMPORTANT for an unreachable cluster: do NOT leave auth.tokenSource as "proxy". The ' +
      'proxy mints the embed token from THIS SERVER, which is the very thing that cannot ' +
      'reach the cluster, so the published page will fail to load for everyone. On a ' +
      'VPN-only cluster the page has to mint for itself from the viewer\'s browser, which ' +
      'is on the VPN: set auth { tokenSource: "credentials", username, secret, secretType }. ' +
      'That does ship the secret in the public page, so use a low-privilege user and say so ' +
      'out loud. Keep "proxy" for any cluster this server CAN reach, where it is the safer ' +
      'default because the secret never leaves the server.',
    whichKindOfCluster: {
      publicSaaS:
        'search_metadata returns source "cluster". Everything works. Keep auth.tokenSource ' +
        '"proxy": the secret stays on this server and never reaches a visitor.',
      devOrNebula:
        'Public https, but these clusters expire and hibernate. If it worked before and ' +
        'clusterReached is suddenly false, suspect the lease before the password.',
      internalOrVpn:
        'clusterReached: false, "could not reach". This server will never reach it. Connect ' +
        'link, then "Sync from cluster" for ids, and auth.tokenSource "credentials" rather ' +
        'than "proxy".',
      onTheirMachine:
        'host is http://localhost:<port>. Same as VPN-only, and say out loud that the ' +
        'published link only works in THEIR browser. Nobody else can open the demo.',
      untrustedTls:
        'clusterReached: false with a TLS error. Self-signed, expired or wrong-name ' +
        'certificate. Same as VPN-only; a plain HTTP port on the same cluster does work ' +
        'from here.',
      reachableButRefusing:
        'clusterReached: true with 401 or 403. The network is fine, the credentials are ' +
        'not. Name the username that was tried and send the link so they re-enter it. Do ' +
        'not change auth types to get around it.',
    },
    note: 'Username + password are required for search_metadata and any cluster-backed ' +
      'feature. For auth types other than TrustedAuthTokenCookieless/TrustedAuthToken the ' +
      'connect link keeps them server-side (not shipped to visitors). For token auth ' +
      'types it also sets auth.tokenSource "proxy": the published site fetches tokens ' +
      "from this site's /token endpoint and never downloads the credential.",
  };
}

/**
 * A project with no cluster renders empty frames, and the agent that built it is the one
 * who has to say so. This rides on create_project, get_urls and save_config, because those
 * are the calls made at hand-over time. It used to live only on search_metadata, and an
 * agent that never needed an id therefore never saw it: ChatGPT built project yxiqu9yr43bi,
 * handed over both links, and told the user to "configure a cluster" with no link at all.
 */
function clusterNotice(origin: string, projectId: string, editToken: string | null, connected: boolean) {
  if (connected) return undefined;
  return {
    connected: false,
    connectUrl: editToken
      ? connectLink(origin, projectId, editToken)
      : publicUrls(origin, projectId).connectUrl,
    tellTheHuman:
      'No cluster is connected, so every embed on this site renders empty. Do not hand the ' +
      'links over without saying so, and do not just ask them to "configure a cluster": give ' +
      'them connectUrl, which opens the builder with the Connect dialog already up. They can ' +
      'also give you the cluster address, username and password here and you save them with ' +
      'set_site. Offer both and let them pick.',
  };
}

async function callTool(
  env: Env,
  projectId: string,
  name: string,
  args: Record<string, unknown>,
  origin: string,
  editToken: string | null,
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
      await refreshLock(env, projectId);
      return { ok: true, config: updated.config };
    }
    case 'lock_project': {
      const holder = String(args.holder ?? 'an AI agent').slice(0, 80).trim() || 'an AI agent';
      const note = typeof args.note === 'string' ? args.note.slice(0, 200) : undefined;
      const lock = await setLock(env, projectId, holder, note);
      return {
        ok: true,
        lock,
        note: 'The builder now warns anyone editing this project. It clears on unlock_project, or 5 minutes after your last edit.',
      };
    }
    case 'unlock_project': {
      await clearLock(env, projectId);
      return { ok: true, locked: false };
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
      await refreshLock(env, projectId);
      return { ok: true, path };
    }
    case 'get_code': {
      const path = normalizePath(String(args.path ?? ''));
      const flavor = args.flavor === 'esm' ? 'esm' : 'cdn';
      const project = await getProject(env, projectId);
      if (!project) throw new ValidationError('project no longer exists');
      const page = await getPage(env, projectId, path);
      if (!page) throw new ValidationError(`no page at ${path}`);
      if (args.part === 'html') {
        return { path, part: 'html', code: generateMarkup(page.config, path) };
      }
      return {
        path,
        flavor,
        code: generateCode(
          effectiveProject(project.config),
          page.config,
          path,
          flavor,
          args.includeInit !== false,
          `${origin}/api/projects/${projectId}/token`,
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
        // A non-secret readout of the cluster connection, so you can tell whether a human
        // has filled it in (on the site or via you) and pull what they entered. When
        // `connected` is false, ask them to connect — see connectionHelp.
        connection: connectionStatus(project.config, project.connection, origin, projectId, editToken),
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
      await refreshLock(env, projectId);
      const saved = await getProject(env, projectId);
      const pages = await listPages(env, projectId);
      const saveStatus = saved
        ? connectionStatus(saved.config, saved.connection, origin, projectId, editToken)
        : null;
      return {
        ok: true,
        config: saved?.config,
        pages: Object.fromEntries(pages.map((p) => [p.path, p.config])),
        cluster: clusterNotice(origin, projectId, editToken, !!saveStatus?.connected),
      };
    }
    case 'get_urls': {
      const project = await getProject(env, projectId);
      const status = project
        ? connectionStatus(project.config, project.connection, origin, projectId, editToken)
        : null;
      return {
        projectId,
        ...publicUrls(origin, projectId),
        // publicUrls has no token to give, so its connectUrl only prompts for one. Override
        // it with the caller's own, or the agent grabs the tokenless field sitting next to
        // the working one and hands over a link that asks the human for a token they do not
        // have.
        connectUrl: editToken
          ? connectLink(origin, projectId, editToken)
          : publicUrls(origin, projectId).connectUrl,
        cluster: clusterNotice(origin, projectId, editToken, !!status?.connected),
      };
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
      // Prefer the server-only connection (works for every auth type, and never ships the
      // secret). Fall back to a public auth.credentials block if that is all there is.
      const conn = await getConnectionSecret(env, projectId);
      const mintFrom = conn
        ? { host: conn.host, username: conn.username, secret: conn.secret, secretType: conn.secretType }
        : (auth?.tokenSource === 'credentials' && cfg.thoughtSpotHost && auth.username && auth.secret
            ? { host: cfg.thoughtSpotHost, username: auth.username, secret: auth.secret,
                secretType: (auth.secretType === 'secret_key' ? 'secret_key' : 'password') as 'password' | 'secret_key' }
            : null);
      const host = mintFrom?.host || cfg.thoughtSpotHost || '';

      if (mintFrom) {
        try {
          const token = await mintToken(projectId, {
            host: mintFrom.host,
            username: mintFrom.username,
            secret: mintFrom.secret,
            secretType: mintFrom.secretType,
            validitySeconds: auth?.validitySeconds ?? 300,
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
            // The link goes out whether or not the catalog saved us: a 401 from the
            // cluster is exactly when the human needs somewhere to go.
            connectionHelp: connectionHelp(origin, projectId, editToken),
            ...(cached.length ? {} : {
              note: answered
                ? 'The cluster answered but refused the credentials in auth.credentials — ' +
                  'check the username and secret. Nothing is cached to fall back on.'
                : 'The cluster could not be reached from the server — usually a VPN-only or ' +
                  'private host, or a self-signed HTTPS port. The human\'s browser CAN reach ' +
                  "it: do not keep retrying here; send them the connect link (see " +
                  "connectionHelp) so they connect from the dialog, or have them press Sync in " +
                  'the builder\'s "Build with AI" dialog. A plain HTTP port, if the cluster ' +
                  'has one, also works from this server.',
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
        connectionHelp: connectionHelp(origin, projectId, editToken),
        ...(cached.length ? {} : {
          note: 'No cluster is connected yet, so there is nothing to search. Offer the human ' +
            'BOTH routes in connectionHelp — the connect link, or the details here in chat — ' +
            'then call get_config and check connection.connected before retrying.',
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
const NO_PROJECT = new Set(['read_manual', 'create_project']);

/**
 * Declared per tool so a client can type the result instead of parsing prose; several warn
 * ("output schema recommended") without one. Every schema is `additionalProperties: true`
 * on purpose: failure paths bolt extra keys on (connectionHelp, note, clusterError) and a
 * closed schema would make an honest answer invalid. `required` lists only keys that are
 * present on every return of that tool.
 */
const OBJ = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const, properties, required, additionalProperties: true,
});
const STR = { type: 'string' } as const;
const BOOL = { type: 'boolean' } as const;
const NUM = { type: 'number' } as const;
const ANY_OBJ = { type: 'object', additionalProperties: true } as const;
const URLS = {
  siteUrl: STR, builderUrl: STR, connectUrl: STR, forkUrl: STR, mcpUrl: STR, apiUrl: STR,
};

const OUTPUT_SCHEMAS: Record<string, unknown> = {
  read_manual: OBJ({ manual: STR }, ['manual']),
  create_project: OBJ({ projectId: STR, editToken: STR, note: STR, ...URLS,
    cluster: OBJ({ connected: BOOL, connectUrl: STR, tellTheHuman: STR },
    ['connected', 'connectUrl']) }, ['projectId', 'editToken']),
  get_site: OBJ({ projectId: STR, config: ANY_OBJ, resolvedTheme: ANY_OBJ, tsVars: ANY_OBJ,
    pages: { type: 'array', items: STR } }, ['projectId', 'config', 'pages']),
  set_site: OBJ({ ok: BOOL, config: ANY_OBJ }, ['ok', 'config']),
  get_config: OBJ({ projectId: STR, config: ANY_OBJ, pages: ANY_OBJ, connection: ANY_OBJ,
    updatedAt: { type: 'number', description: 'Epoch milliseconds.' } },
    ['projectId', 'config', 'pages', 'connection']),
  save_config: OBJ({ ok: BOOL, config: ANY_OBJ, pages: ANY_OBJ,
    cluster: OBJ({ connected: BOOL, connectUrl: STR, tellTheHuman: STR },
    ['connected', 'connectUrl']) }, ['ok']),
  list_pages: OBJ({ pages: { type: 'array', items: OBJ({ path: STR, title: STR, blocks: NUM,
    embedType: STR, preRender: BOOL, fullHeight: BOOL }, ['path']) } }, ['pages']),
  get_page: OBJ({ path: STR, page: ANY_OBJ }, ['path', 'page']),
  set_page: OBJ({ ok: BOOL, path: STR }, ['ok', 'path']),
  delete_page: OBJ({ ok: BOOL, path: STR }, ['ok', 'path']),
  get_code: OBJ({ path: STR, part: STR, code: STR }, ['path']),
  get_urls: OBJ({ projectId: STR, ...URLS,
    cluster: OBJ({ connected: BOOL, connectUrl: STR, tellTheHuman: STR },
    ['connected', 'connectUrl']) }, ['projectId']),
  get_graph: OBJ({ nodes: { type: 'array', items: ANY_OBJ },
    edges: { type: 'array', items: ANY_OBJ },
    danglingLinks: { type: 'array', items: ANY_OBJ } }, ['nodes', 'edges', 'danglingLinks']),
  fork_site: OBJ({ ok: BOOL, projectId: STR, editToken: STR, forkedFrom: STR,
    copiedPages: NUM, note: STR }, ['ok', 'projectId', 'editToken']),
  lock_project: OBJ({ ok: BOOL, lock: ANY_OBJ, note: STR }, ['ok']),
  unlock_project: OBJ({ ok: BOOL, locked: BOOL }, ['ok', 'locked']),
  search_metadata: OBJ({ source: { type: 'string', enum: ['cluster', 'catalog'] }, count: NUM,
    items: { type: 'array', items: ANY_OBJ }, clusterReached: BOOL, clusterError: STR,
    syncedAt: STR, note: STR, connectionHelp: ANY_OBJ }, ['source', 'count', 'items']),
};

function toolsFor(pinned: string | null) {
  const withOutput = TOOLS.map((tool) => (
    OUTPUT_SCHEMAS[tool.name] ? { ...tool, outputSchema: OUTPUT_SCHEMAS[tool.name] } : tool
  ));
  if (pinned) return withOutput;
  return withOutput.map((tool) => {
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
    // Also mounted at /mcp/manual.md, the linkable spelling.
    return new Response(manualMarkdown(new URL(request.url).origin), {
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
      // The manual is public and project-free, like the GET that serves it.
      if (name === 'read_manual') {
        const manual = manualMarkdown();
        responses.push(textResult(id, manual, { manual }));
        continue;
      }
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
            connectUrl: connectLink(origin, project.id, fresh),
            cluster: clusterNotice(origin, project.id, fresh, false),
          }));
        } catch (err) {
          const msg = err instanceof ValidationError ? err.message : 'could not create the project';
          if (!(err instanceof ValidationError)) console.error('[mcp]', err);
          responses.push(toolError(id, msg));
        }
        continue;
      }

      let pid = projectId;
      // The token this call already authenticated with, so connect links come back ready
      // to send instead of carrying a <editToken> placeholder.
      let callToken: string | null = projectId ? headerToken : null;
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
        callToken = tok;
      }
      try {
        responses.push(textResult(id, await callTool(env, pid, name, args, origin, callToken)));
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
