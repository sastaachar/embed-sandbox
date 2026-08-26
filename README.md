# embed-sandbox

Shareable ThoughtSpot embed showcases that an AI agent can build for you.

Start a project, get a `projectId` and an `editToken`, point an agent at the MCP
endpoint, and it writes your pages. What a visitor opens is the finished site —
header, embed, footer, buttons — not an editor.

```
POST /api/projects            ->  projectId + editToken
GET  /p/<projectId>/...       ->  the live site (share this)
GET  /edit/<projectId>        ->  JSON editor, gated on the edit token
GET  /fork/<projectId>        ->  "fork this showcase" page, no token needed
POST /mcp/<projectId>         ->  MCP endpoint an agent edits through
GET  /mcp/manual.md           ->  the full manual as markdown: document shape,
                                  when-to-call-what flow, generated tool reference
```

Agents are told (in the server instructions, the entry tools, and the
`read_manual` tool listed first) to read the manual once per session before
using anything else — the tool reference in it is generated from the live tool
definitions, so it cannot drift.

## How it works

One Cloudflare Worker, one D1 database, no build step at runtime.

A page is **JSON**, not HTML. The Worker inlines the whole project manifest into a
7KB shell; a 14KB vanilla-JS runtime renders the chrome immediately, then loads the
ThoughtSpot SDK from the jsDelivr CDN at the version the project pins and mounts
the embeds. Nested paths are routed client-side, so pre-rendered iframes survive
navigation.

The code is split three ways along that seam — **build the JSON**, **run the JSON**,
and the **shared** pieces both sides need:

```
src/index.ts              Worker entry & router — wires the three together
src/common/               shared by builder, live and the backend
  schema.ts               page/site schema + validation
  theme.ts                theme tokens → CSS vars + --ts-var-* customizations
  urls.ts  sdkUrl.ts       public URL builder · SDK version → CDN URL
  codegen.ts graph.ts outline.ts   derive React/JS code, a graph, an outline from the JSON
  db.ts  tsrest.ts         D1 queries · ThoughtSpot REST (token mint, metadata)
  mcp.ts                  MCP server (JSON-RPC over HTTP, bearer auth) — the agent backend
src/builder/              builds the JSON
  shell.ts                serves the builder page (loads the React bundle)
  editor.ts fork.ts       the /edit JSON editor · the /fork landing page
  ui/                     the React builder app (bundled by `npm run build:ui`)
src/live/
  shell.ts                the published-site shell HTML, theme tokens, critical CSS
public/_static/
  live/runtime.js         the renderer that runs a site from its JSON (no framework)
  builder/builder.js|css  the bundled React builder
```

### The whole app is one JSON document

```
GET  /api/projects/<id>/config     # the entire app: site config + every page + connection
PUT  /api/projects/<id>/config     # write it back
```

That is the editing API. `GET` hands you one object, you change whatever you like
in it, you `PUT` it back — the builder does exactly this and nothing else, so a
save is always the same call whether you moved a block, renamed the site, added a
page or connected a cluster.

```jsonc
{
  "config":  { "thoughtSpotHost": "…", "theme": {…}, "header": {…} },
  "pages":   { "/": {…}, "/sales/q3": {…} },     // keyed by path
  "connection": { "host": "…", "username": "…", "secretType": "password" }
}
```

Semantics worth knowing, because they are all "replace", not "merge":

- **`config` is replaced.** A key you drop is really dropped.
- **`pages` is replaced.** A path missing from the document is deleted.
- **`connection.secret` is write-only.** It goes in through this endpoint and never
  comes back out, so `GET` returns the connection without it — and a `PUT` that
  omits `secret` keeps the stored one. Round-tripping the document therefore
  cannot wipe a credential the browser was never allowed to read.
- **Nothing is half-written.** Every page is validated before anything is saved,
  so one bad block rejects the whole request.

The narrower endpoints (`PUT …/pages`, `PATCH …/:id`, `POST …/connection`) still
exist and still work; they are conveniences over this one.

### Why JSON pages instead of HTML

Because the runtime owns the SDK lifecycle. Pre-render in particular *cannot* be
done from inside page markup — the SDK's container has to be created at document
root before the page mounts. Keeping pages declarative means an agent can't get
pre-render, full-height, or init ordering wrong, which is most of the value here.
Anything the schema doesn't name is still reachable: every unrecognised key on an
`embed` block is passed straight through to the SDK constructor.

## Setup

```bash
npm install
npx wrangler d1 create embed-sandbox        # copy the database_id it prints
#   -> paste it into wrangler.jsonc
npm run db:init                             # local
npm run dev
```

Deploy:

```bash
npm run db:init:remote
npm run deploy
```

### Create a project

```bash
curl -X POST https://<your-worker>/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"Acme demo",
       "thoughtSpotHost":"https://acme.thoughtspot.cloud",
       "sdkVersion":"1.51.0"}'
```

Keep the `editToken` — only its SHA-256 is stored, so it cannot be shown again.
Lose it and the project is read-only forever.

### Connect an agent

```bash
claude mcp add --transport http embed-sandbox \
  https://<your-worker>/mcp/<projectId> \
  --header "Authorization: Bearer <editToken>"
```

Then just ask: *"add a /sales page with our Q3 liveboard, full height, and a
button that filters to West"*. Every tool carries the schema in its description, so
the agent doesn't need this README:

| tool | what it does |
|---|---|
| `get_config` / `save_config` | the whole app as one document — the same one the builder and the REST API use. Prefer these for anything beyond a single edit |
| `lock_project` / `unlock_project` | announce an edit session; the builder warns any human editing meanwhile |
| `search_metadata` | real liveboards/answers/worksheets, so an id is never guessed |
| `get_site` / `set_site` | site config only, merge semantics |
| `list_pages` / `get_page` / `set_page` / `delete_page` | one page at a time |
| `get_code` | the real SDK code a page produces |
| `fork_site` | copy the project into a new one with its own token |

An agent that edits the document sees its change appear on any open page within a
few seconds — see **Live updates**.

## The visual builder

`/build/<projectId>` is a **React app** (React 19, bundled by esbuild to
`public/_static/builder/builder.js`). The public site is deliberately *not*: it stays
framework-free at 14 KB so a shared demo still paints in ~50 ms. A design-time tool
and a published page have opposite constraints, so they get opposite answers.

```
npm run build:ui     # bundle src/builder/ui -> public/_static/builder/builder.js + .css
npm run dev:ui       # same, watching
npm run typecheck    # worker tsconfig + src/builder/ui tsconfig
```

```
src/builder/ui/spec.json     the single source of truth for the editable surface
src/builder/ui/App.tsx       gate, toolbar, state, dialog orchestration
src/builder/ui/Canvas.tsx    sheet, cards, rows/columns, SortableJS, interact.js resizing
src/builder/ui/Props.tsx     the properties panel — rendered FROM spec.json, not hardcoded
src/builder/ui/dialogs.tsx   embed-type picker, metadata picker, connect, prompt, confirm
src/builder/ui/sdk.ts        SDK init + pre-render lifecycle for the canvas
src/builder/ui/cluster.ts    browser-side cluster login and metadata search
src/builder/ui/api.ts        the document API client
src/builder/shell.ts         the Worker only serves the shell — no UI lives in the Worker
```

### One JSON file controls the editable surface

`src/builder/ui/spec.json` defines the palette, the embed types, and every field the
properties panel shows — per type, with its kind (`text`, `select`, `checkbox`,
`length`, `metadata`, `json`). Nothing about those panels is hardcoded in the
components: adding an SDK parameter is a JSON edit, and it shows up in the UI
immediately. `blockFields`, `embedCommon` and `siteFields` do the same for
non-embed blocks, the shared embed options, and site config.

### Two libraries, for two things that are not our problem

- **SortableJS** — drag and drop. It moves real DOM nodes, which React does not
  tolerate: leaving a node where Sortable put it makes React's next `removeChild`
  throw, and reconciling into a tree something else edited silently writes into the
  wrong elements. So `onEnd` puts the node back and bumps a `key` on the canvas,
  which rebuilds it from data. The iframes survive, because they live in the SDK's
  body-level pre-render wrappers, not in the hosts being rebuilt.
- **interact.js** — resizing. It binds to a *selector*, so unlike Sortable it needs
  no re-initialisation after each render.


`/build/<projectId>` — three panes: palette, live canvas, properties.

```
POST /api/projects        ->  projectId + editToken
GET  /build/<projectId>   ->  visual builder   ← start here
GET  /edit/<projectId>    ->  JSON editor + outline/code (escape hatch)
GET  /p/<projectId>/...   ->  the finished site
```

The flow: **create page → + Embed → choose a type → fill in the details.** Choosing
a type is its own step with descriptions, and the properties panel then asks only for
what that type needs — `liveboardId` for a liveboard, `dataSource` for search,
`pageId` for the full app — plus a **Pick…** button that lists real objects from
`metadata/search` when a cluster connection exists. Anything the panel doesn't name
goes in an *Advanced SDK config (JSON)* box, so the long tail is never blocked.

### Putting embeds side by side

Two ways, and the first is one click:

1. Select an embed → **+ Embed beside**. It wraps the block in a Row and drops a
   second embed into column two. On a block already inside a row, it adds another
   column instead of wrapping again (up to 4).
2. **+ Row: 2 side by side** from the palette, then drag embeds into the columns.

Column widths are 12-grid `span` values, editable in the properties panel.

### How dragging works

Grab the ⠿ grip. Dragging is **SortableJS** (pinned, from jsDelivr) rather than
hand-rolled HTML5 drag-and-drop: the whole card is a target, neighbours animate out
of the way, and the ghost shows where the block will land. The sheet and every
column are registered drop containers; `group.put` refuses a row into a column,
because rows may not nest.

Things that had to be true for this to feel right, each of which was a bug first:

- **Nothing may keep `draggable = true`.** The grip carried it over from the
  pre-SortableJS implementation, so the browser started a *native* drag on
  mousedown and Sortable's fallback drag never ran. Worse, the native drag never
  ended cleanly, which left the whole canvas deaf to clicks afterwards — dragging
  did nothing *and* selection stopped working, which looked like two bugs and was
  one.
- The SDK's pre-render wrapper is a `<body>`-level element with `z-index: auto`, so it
  paints above anything inside a card and swallowed clicks. Embeds are therefore
  **click-through while building**, with an **Interact** toggle in the toolbar for when
  you do want to click inside one.
- `showPreRender()` positions that wrapper from the host's rect *at call time*, so any
  later layout change leaves it stale. Wrappers are hidden during a drag and re-synced
  on the next animation frame after a render, on drag end, and on resize.

**The canvas mounts real embeds.** It works because every canvas embed is
force-pre-rendered: the iframe lives in the SDK's body-level wrapper, so a drag moves
only the lightweight host div and `showPreRender()` re-syncs on drop — reordering
never remounts an iframe. One consequence to know: a live iframe covers its card, so
each embed gets a **header strip** carrying its type, id, and the drag grip. That
strip is the click target; the embed itself stays interactive.

### Resizing a box

Drag the bottom-right corner of any embed on the canvas, or type into **Height** and
**Width** in the properties panel. Both write `height` / `width` onto the embed block,
both are CSS lengths, and both reach the rendered site — `height` becomes the SDK's
`frameParams.height`, `width` caps the host with `max-width`. `fullHeight` wins over
`height` and the panel says so instead of letting you set a value that does nothing.

Resizing is **interact.js**, loaded from jsDelivr next to SortableJS. Two things that
were tried first and did not survive contact:

- **CSS `resize: both`** — the platform's own handle, and the obvious answer. It works
  in isolation but not here: it writes inline width/height that our re-render cycle
  then overwrites, and the mousedown it needs is contested by the drag layer. Native
  first was right; keeping it after it failed would not have been.
- **A hand-rolled pointer-drag grip** — deleted. This is a solved problem and the
  library handles pointer capture, touch, and constraints better than a bespoke one.

interact.js binds to a **selector**, not to elements, so unlike Sortable it needs no
re-initialising after each render — it is wired once at startup.

### Remembering the token

The gate remembers the edit token **by default**, under a per-project `localStorage`
key so one project's token cannot unlock another. **Forget token** in the toolbar
clears it, the checkbox on the gate opts out before you sign in, and a token that has
stopped working is dropped automatically rather than failing silently.

This reverses the original no-storage stance deliberately: this is a personal build
tool behind a per-project token, and being asked to paste 64 hex characters on every
visit is the part people actually hate. The public site stores nothing either way.

## Editing

Three ways in, all gated on the same per-project edit token:

1. **An agent over MCP** — the intended path. Ask for what you want in English.
2. **`/edit/<projectId>`** — a two-pane JSON editor for when you want to poke at
   it by hand. Left pane lists the site config and every page; right pane is the
   raw JSON with `⌘S`/`Ctrl+S` to save. Add and delete pages from the sidebar.
   Client-side JSON parse errors and server-side validation errors both surface
   inline, so a bad `embed.type` tells you the allowed values instead of failing
   silently.
3. **The document API** — `GET`/`PUT /api/projects/:id/config`, the whole app as
   one JSON object. The per-page (`PUT …/pages`) and per-config (`PATCH …/:id`)
   endpoints remain for narrower edits.

The editor uses **no native browser dialogs**. Deleting a page opens an in-page
confirmation with focus on Cancel, dismissable with Escape or a backdrop click —
`window.confirm()` is unstyleable, blocks the event loop, and is suppressed
outright in some embedded contexts. `grep -rE '\b(alert|confirm|prompt)\s*\('
src public` finds nothing but that explanation.

The editor is deliberately on its own route and nothing on the public site links
to it. `/p/<projectId>/` never renders an editor, per the "visitors see the
finished site" requirement.

Note the asymmetry: **saving a page replaces it wholesale**, while **saving the
site config merges** — keys you omit are left alone. The editor states which
you're doing above the textarea.

The edit token is held in a closure variable for the life of the tab. It is never
written to `localStorage`, `sessionStorage`, or a cookie, so a refresh asks
again — verified by the browser check, which asserts the token appears in none of
the three.

## Seeing the structure

The editor's **Code** tab opens on an **outline** — the page as components, not a
code dump:

```
PROJECT — RUNS ONCE
▸ <init host="https://acme.thoughtspot.cl…" authType="None" />

PAGE /
▸ <Header title="Acme" nav={1} />
  <H1 "Sales" />
▾ <Buttons {3} />
    ▸ <Button "Reload" action="reload" />
▾ <LiveboardEmbed liveboardId="lb-123" fullHeight preRender />
    { "liveboardId": "lb-123", "fullHeight": true, "preRender": true }
    ▸ theme variables (38)
    ▸ onRouteChange
    ▾ onCustomAction
        (payload) => {
          if (payload?.data?.id !== "open-detail") return;
          Ether.set("answerId", payload.data.embedAnswerData.sessionId);
          Ether.openModal("detail");
        }
▸ <SearchEmbed dataSource="ws-9" />
▸ <Footer text="© Acme" />
```

Three things it deliberately does:

- **`init` appears once**, under the project, because it runs once per project —
  not repeated per page.
- **Bulk collapses.** The 38 `--ts-var-*` values sit behind one line instead of
  drowning the config you actually care about.
- **Handlers show the function that runs.** A `capture` entry or an `on` rule is
  rendered as its real equivalent source, so a declarative rule is still legible
  as code. Once a page has a `script`, that shows here verbatim too.

`GET /api/projects/<id>/outline?path=/sales` returns it as JSON. The `outline` /
`cdn` / `esm` button cycles between the outline and the full generated code below.

## Seeing the code

Authoring stays abstracted — you edit config, not markup. But you can always read
the SDK code your config produces:

```
GET /api/projects/<id>/code?path=/sales             -> { code }
GET /api/projects/<id>/code?path=/sales&flavor=esm  -> npm + import snippet
GET /api/projects/<id>/code?path=/sales&init=0      -> esm, page code only
GET /api/projects/<id>/code?path=/sales&download=1  -> downloads it as a file
```

### init() is app-level, and the generated code says so

`init()` is global to the app, not to a page. The runtime honours this — it caches
one promise, so **init runs exactly once per project** no matter how many pages,
embeds or modals ask for it, and client-side navigation reuses it.

The generated code reflects that per flavour:

- **`cdn`** — the file *is* the whole app, so init lives in it, with a comment
  saying that isn't how a real app should look.
- **`esm`** — init is emitted in its own clearly-labelled *"once per app, at
  bootstrap — NOT per page"* block, with its own `import`, separate from the
  per-page classes.
- **`esm` + `init=0`** — page code only, for when your app already calls init at
  bootstrap. The `AuthType` import is dropped too, since nothing needs it. The
  editor's Code tab has a `with init` / `no init` toggle for this.

`init=0` is ignored for `cdn`, because a standalone page without init cannot work.

The editor has a **Code** tab next to Config, with a cdn/esm toggle, Copy and
Download. An agent can read the same thing via the `get_code` MCP tool. It is
generated and read-only, so it always matches the config — including
`preRender`/`showPreRender` ordering and the HostEvent wiring for each button.

`flavor=cdn` (default) emits a complete standalone HTML page with no build step.
`flavor=esm` emits an `npm install` + `import` snippet for pasting into a real app.

**Why not just author in HTML, with Tailwind?** Because it moves attention onto
markup and styling, when the point of a showcase is the embed config. The numbers
also matter: Tailwind's no-build option is a CSS compiler in the critical path at
**120 KB gzipped** — 26× this project's entire runtime. Config in, code out gets
you the readable code without paying either cost.

## The demo API — a value store

Every site gets one global object, named by `namespace` in the site config
(default `Sandbox`). If your builder is `tse-ether`, set `"namespace": "Ether"`
and the page exposes `window.Ether`:

```js
Ether.set('answerId', 'abc')   // store a value, re-renders anything bound to it
Ether.get('answerId')          // read it; dotted paths work: Ether.get('route.data.id')
Ether.all() / Ether.keys()     // everything currently set
Ether.on('answerId', fn)       // subscribe; returns an unsubscribe function
Ether.clear('answerId')        // or clear() for everything

await Ether.init()             // the project's SINGLE SDK init, idempotent
Ether.initialized              // has it run
Ether.config                   // { thoughtSpotHost, authType, sdkVersion, ... }
Ether.sdk                      // the loaded SDK library

Ether.embed                    // this page's first embed instance
Ether.embeds()                 // all of this page's embeds, in block order
Ether.embeds('modal:detail')   // an open modal's embeds
Ether.go('/sales')             // client-side navigation
Ether.openModal('detail') / Ether.closeModal() / Ether.modal
```

`init()` takes no arguments on purpose — host, authType and sdkVersion are
project settings, and init runs **exactly once per project** no matter how many
pages, embeds or modals ask for it. Every caller shares one promise.

### Showing values in the page

Any user-visible text supports `{{key}}`, including dotted paths:

```json
{ "type": "heading", "text": "Viewing {{route.data.currentPath}}" }
{ "type": "value", "key": "answerId", "label": "Session" }
```

A `value` block is a labelled live readout; it shows `—` until the key is set.
Objects render as JSON rather than `[object Object]`.

**`{{...}}` is not an expression language.** It is a dotted property lookup and
nothing else — no calls, no operators. See Security notes.

### Capturing values from the embed

```json
"embed": {
  "type": "liveboard", "liveboardId": "...",
  "capture": { "ROUTE_CHANGE": "route", "Data": "lastData" }
}
```

`capture` maps an EmbedEvent name to a store key and stores the whole payload.
An EmbedEvent the pinned SDK doesn't define is **not** subscribed — it warns
instead of failing silently.

### Reacting to events: rules and modals

A page (or the site) can declare **modals** — the third component alongside
header and footer:

```json
"modals": {
  "detail": {
    "title": "Answer detail",
    "width": "820px",
    "blocks": [
      { "type": "value", "key": "answerId", "label": "Session" },
      { "type": "embed", "embed": { "type": "search", "answerId": "{{answerId}}" } },
      { "type": "buttons", "items": [{ "label": "Close", "action": "close-modal" }] }
    ]
  }
}
```

and wire an embed event to it:

```json
"embed": {
  "type": "liveboard", "liveboardId": "...",
  "on": {
    "CustomAction": [
      { "id": "open-detail",
        "set": { "answerId": "data.embedAnswerData.sessionId" },
        "openModal": "detail" }
    ]
  }
}
```

That is the full custom-action flow: the user clicks a custom action on the
liveboard, the rule copies fields out of the payload into the store, and opens a
modal whose embed is configured from those values. **Embed config supports
`{{key}}` too** — that is how `answerId: "{{answerId}}"` works.

If a `{{key}}` an embed needs is not set yet, the block renders *"Waiting for a
value"* and mounts itself the moment `set()` provides it, rather than
constructing an embed with a blank id.

Modals close on Escape, backdrop click, the ✕, or a `close-modal` button.
Modal embeds are built on open and destroyed on close, and never pre-render.
Buttons inside a modal act on that modal's embeds, not the page's.

### Embed errors, including CORS

By default (`showEmbedErrors`, default true) an `EmbedEvent.Error` opens a modal
with the payload, and the error is stored at `Ether.get('embedError')`. When the
error looks like a CSP/CORS refusal, the modal explains the fix and prints **the
exact origin to allowlist** plus the cluster it must be added to. Define a modal
named `embed-error` to replace the built-in one, or set `showEmbedErrors: false`.

An error arriving while another modal is open does not replace it.

## Connecting to a cluster

Creating a demo starts by connecting. Two *separate* things, deliberately:

| | what it is | who may use it |
|---|---|---|
| **`connection`** | how *you* reach the cluster while building | edit token only |
| **`auth`** | how the *demo's embed* authenticates at runtime | the public page |

Keeping them apart is what makes the pickers work at all. If the pickers used the
demo's own auth they would only function for credentials-based trusted auth — with
`EmbeddedSSO`, `SSO`, `OIDC` or `None` the Worker holds nothing and cannot call any
API. With a separate design-time connection you can browse liveboards regardless of
how the finished demo authenticates.

```bash
curl -X POST https://<worker>/api/projects/<id>/connection \
  -H "authorization: Bearer <editToken>" -H 'content-type: application/json' \
  -d '{"host":"https://acme.thoughtspot.cloud","username":"demo_user",
       "secret":"…","secretType":"password"}'   # or "secret_key"
```

It **saves first, then checks**, and the check is not fatal: `{ saved: true,
verified: false, verifyError: "…" }`. A cluster the Worker cannot reach — private
IP, self-signed cert, VPN-only — is still a connection worth keeping, because it
is what the *deployed* demo will use to mint runtime tokens. (It also travels in
the document: `PUT …/config` with a `connection` key does the same thing.)

What the builder shows you, though, comes from the browser logging in directly —
see below. Then:

### The pickers call the cluster from your browser

`Pick…` does **not** proxy through the Worker. The builder logs in against
`POST {host}/api/rest/2.0/auth/token/full` and lists objects with
`POST {host}/api/rest/2.0/metadata/search`, both straight from the tab you have
open, with the credential you typed into Connect held in memory for that tab only.

That is not a preference, it is where the network is. Your browser sits on the
network that can see `https://172.32.1.120:8443`; a Worker at Cloudflare's edge
does not, and cannot skip a self-signed certificate either. Proxying design-time
calls through the server breaks exactly the clusters you test against.

Two things the cluster still has to allow, and the picker names both when a call
fails, because a cross-origin fetch failure is otherwise opaque:

- **The certificate**, if self-signed — open the host in a tab once and accept it.
- **The origin**, in the cluster's CORS allowlist (Develop → Customizations →
  Security settings).

```
GET /api/projects/<id>/metadata?type=LIVEBOARD&q=sales   # edit token required
```

That endpoint still exists and is used as a fallback when the tab has no
credential — a reachable cloud cluster works fine through it. `type` accepts
`LIVEBOARD`, `ANSWER`, `LOGICAL_TABLE`, `CONNECTION`, and returns `{ id, name }`
pairs, so a GUID never has to be pasted.

### Where the secret lives

Not in `config`. `config` is public and is inlined into every rendered page, so a
credential there would be served to every visitor. It lives in its own columns, and
`getProject()` **does not select it** — `readConnectionSecret()` is the only reader,
kept separate so a secret cannot leak into a response by accident. Reads report
`hasSecret: true` and nothing more. Forks inherit **no** connection.
A `password` or `secretKey` inside `auth` is rejected outright rather than stored.

### Runtime tokens

With `auth: { tokenSource: "connection", objectId, validitySeconds }` the Worker
mints the embed's token itself and the browser only ever sees a short-lived token:

```
POST /api/projects/<id>/token   ->   { token, expiresAt, scoped }
```

**This endpoint is necessarily public** — the rendered site is public, so
`getAuthToken` has to be able to call it. That means anyone with the share link can
obtain a token for that embed user. That is inherent to trusted auth behind a public
page, not a defect here, and it is why the defaults matter: set `objectId` so the
token is scoped to a single object via `/auth/token/object`, use a low-privilege
user, and keep `validitySeconds` short (300 by default).

### Why not the REST SDK

`@thoughtspot/rest-api-sdk` carries a ThoughtSpot EULA rather than a permissive
licence, and resolves only from internal Artifactory — which would make this Worker
unbuildable outside the corp network. Both calls it would wrap are a single JSON POST
(`src/tsrest.ts`), verified against `rest-api-sdk/api-spec/openapiSpecv3-2_0.json`.

## Live updates

A published page is not an editor, but the document behind it can change at any
moment — an agent over MCP, someone in the builder, another tab. So the page watches
its own version and re-renders in place:

```
GET /api/projects/<id>/version    -> { updatedAt, lock } # tiny, and the one that repeats
GET /api/projects/<id>/manifest   -> the full manifest   # fetched only when it moves
```

The manifest endpoint returns exactly what the shell inlines (same `buildManifest`),
so theme derivation stays server-side and a live update cannot drift from a fresh
load. An embed whose config is byte-identical keeps its iframe; only what changed
remounts. Polling pauses while the tab is hidden and catches up on focus.

`live: false` in site config opts a project out entirely.

### Variables, and the visitor's own settings

Every variable goes through one resolution order — **what this page load set, then
what the visitor saved in their own browser, then the project's declared default** —
so `{{liveboardId}}` in an embed's config can be a variable rather than a hard-coded
guid. `config.variables` declares them (label, default, placeholder); anything a page
already interpolates is offered too.

The published page carries a **⚙ settings panel** next to the ‹/› code button. A
visitor can fill in the `thoughtSpotHost`/auth the project doesn't have — stored in
their browser, never sent to us — and set any variable. Until init() has what it
needs, embeds say *"Settings needed"* and the panel opens itself rather than the page
failing silently. `showSettings: false` and `showCode: false` hide either button.

### The advisory edit lock

An agent editing over MCP announces itself first (`lock_project`, or
`POST /api/projects/<id>/lock` with the edit token), and the builder veils the
canvas — *"… is vibe-coding this demo — your changes might be overwritten by the
AI overlords"* — with an **Edit anyway** escape hatch. The published page is not
touched. `unlock_project` /
`DELETE …/lock` clears it immediately; otherwise it expires 5 minutes after the
agent's last save (each MCP save refreshes it), so a dead agent cannot wedge a
demo. It is advisory only: nothing is ever blocked, and the lock state rides on
the `/version` poll the page already makes. `GET …/lock` is public (holder and
note are display strings, never a credential).

## Forking

Anyone you share a showcase with can take their own copy:

```bash
curl -X POST https://<your-worker>/api/projects/<projectId>/fork
```

or send them `/fork/<projectId>`, which is a single button. An agent can do it
too, via the `fork_site` MCP tool.

A fork copies the site config and every page verbatim, and mints a **new** edit
token. The two projects are then fully independent — neither token works on the
other, and editing the fork cannot touch the original. `forkedFrom` records the
immediate parent, so forks of forks keep their lineage.

**Forking deliberately requires no token.** It only ever copies data that is
already publicly readable at `/p/<projectId>/`, and demanding the owner's token
would defeat the point of sharing something for others to build on. The
consequence to be aware of: like `POST /api/projects`, this is an unauthenticated
way to create rows, so it belongs behind the same rate-limiting rule.

## Page schema

```json
{
  "title": "Q3 Sales",
  "header": { "title": "Acme", "nav": [{ "label": "Home", "to": "/" }] },
  "footer": { "text": "© Acme" },
  "css": "optional page-scoped CSS",
  "blocks": [
    { "type": "heading", "text": "Q3", "level": 1 },
    { "type": "text", "text": "Paragraph copy." },
    { "type": "divider" },
    { "type": "spacer", "size": "32px" },
    { "type": "buttons", "align": "left", "items": [
      { "label": "Reload",  "action": "reload", "variant": "primary" },
      { "label": "West",    "action": "set-filter", "column": "Region", "values": ["West"] },
      { "label": "Detail",  "action": "nav", "to": "/sales/q3" },
      { "label": "Pin",     "action": "host-event", "hostEvent": "Pin" }
    ]},
    { "type": "embed", "embed": {
      "type": "liveboard",
      "liveboardId": "<guid>",
      "fullHeight": true,
      "preRender": true,
      "hiddenActions": ["download"]
    }}
  ]
}
```

`embed.type`: `liveboard` · `viz` · `search` · `searchbar` · `app` · `spotter` ·
`conversation`. Button actions: `nav` · `open-url` · `reload` · `edit` · `save` ·
`download-pdf` · `set-filter` · `set-value` · `open-modal` · `close-modal` ·
`host-event`.

Every block accepts an optional `style` string — inline CSS, for the rare layout
tokens can't express. Header and footer accept it too. `<`, `>`, `javascript:`
and `expression()` are refused.

With several embeds on a page, a button targets index 0 unless it sets
`"embedIndex": 1`.

`host-event` reaches any of the SDK's ~92 HostEvents by name, which is how you do
anything the named actions don't cover. There is deliberately **no**
`reset-filters` action: no such HostEvent exists in the SDK. Use `host-event`
with a real name — `ResetLiveboardPersonalisedView`, `ResetSearch`,
`ResetSpotterConversation`. A `hostEvent` the pinned SDK version doesn't define is
**not sent**: the button disables itself and logs why, rather than firing a string
the SDK silently ignores.

A page may declare **several embed blocks**; each gets its own iframe and its own
pre-render slot. Buttons act on the **first** embed block on the page.

Nesting is by path — `/sales` is the parent of `/sales/q3`. Header and footer set
on a page override the site-level ones for that page only.

### Site config

```json
{
  "name": "Acme demo",
  "thoughtSpotHost": "https://acme.thoughtspot.cloud",
  "sdkVersion": "1.51.0",
  "authType": "None",
  "theme": { "colorPrimary": "#7b3fe4", "radius": "12px", "maxWidth": "1180px" },
  "header": { "title": "Acme", "logoUrl": "https://...", "sticky": true, "nav": [] },
  "footer": { "text": "© Acme" },
  "css": "site-wide CSS",
  "embedDefaults": { "customizations": { "style": { "customCSS": {} } } }
}
```

Full theme tokens: `colorPrimary`, `colorPrimaryText`, `colorBg`, `colorSurface`,
`colorText`, `colorMuted`, `colorBorder`, `fontFamily`, `fontHeading`, `radius`,
`maxWidth`, `headerHeight`, `space`.

### One colour is enough

Set `colorPrimary` alone and the rest of the palette is derived from it in OKLCH,
so the steps are perceptually even rather than evenly spaced in sRGB (`culori`):

```json
"theme": { "colorPrimary": "#7b3fe4" }
```
```
bg #fefdff · surface #f5f3fd · border #e0ddeb · text #1c1a25 · muted #6c697a
```

Neutrals are tinted toward the primary's hue, scaled by its chroma — an
achromatic primary gives untinted greys rather than a wrong-looking cast.

`colorPrimaryText` is **computed, not guessed**: it is whichever of white or
near-black has the better WCAG contrast against `colorPrimary`. CSS cannot do this
(`color-contrast()` isn't shipped anywhere), which is the main reason a library is
involved at all. A yellow primary flips it to dark automatically.

Derivation happens at **serve time**, so stored config stays sparse and changing
`colorPrimary` re-derives everything. **Any token you set explicitly wins.**
`GET /api/projects/:id` returns `resolvedTheme`, `tsVars` and measured `contrast`
so you can check the result without loading the page.

### The palette reaches the embed too

By default the derived palette is pushed into the embed as **38 `--ts-var-*` CSS
variables**, via `customizations.style.customCSS.variables`, so the iframe matches
the surrounding site:

| token | drives |
|---|---|
| `colorBg` | root, viz, tile, search bar, menu, dialog backgrounds |
| `colorText` | root, viz title, liveboard header, menu, dialog text |
| `colorMuted` | viz description, axis titles and data labels |
| `colorPrimary` | primary button, active chip, active tab border, `application-color` |
| `colorPrimaryText` | primary button text |
| `colorSurface` | secondary button, chip, list/menu hover |
| `colorBorder` | tile border, checkbox border |
| `radius` / `fontFamily` | button/viz/chip radius, root font |

Every name is verified against `css-variables.d.ts` in the pinned SDK — that file
declares **242** `--ts-var-*` names; this maps a deliberately small slice rather
than asserting an opinion on every surface. Set `"themeEmbed": false` to stop the
push entirely, or override individual variables under
`embedDefaults.customizations.style.customCSS.variables` — authored values always
win over the defaults. The generated code in the Code tab includes them, so what
you read matches what runs.

## SDK versions

`sdkVersion` is resolved at page load from
`cdn.jsdelivr.net/npm/@thoughtspot/visual-embed-sdk@<version>/dist/tsembed.js`,
so any published version works with no rebuild — that's the point of the URL
build. Use an exact version to reproduce a customer's setup, or `latest`.

The runtime degrades honestly: if a pinned version has no class for the embed
type on the page (e.g. `spotter` on an old SDK), that block renders a note saying
so rather than failing silently. `spotter` falls back to `ConversationEmbed`
where that's the available name.

## Performance

Measured locally with `scripts/browser-check.mjs`:

| | |
|---|---|
| HTML transferred | 2.6 KB gzipped (7.6 KB raw) |
| Runtime JS | 14 KB raw, ~4 KB gzipped |
| First contentful paint | 52 ms |
| Chrome painted | 71 ms |

Levers, in case you change something and it regresses:

- Manifest, theme tokens and critical CSS are **inlined** — nothing blocks first paint.
- `preconnect` + `preload` for the CDN and your ThoughtSpot host are in `<head>`,
  so the SDK starts downloading before the runtime executes.
- The shell is **edge-cached per project version** (`projectId:updatedAt`), so
  repeat visits cost one D1 read. A write bumps `updatedAt` and invalidates it.
- One shell serves every path in a project, because routing is client-side.
- Pre-render for the *visible* page happens first; other pages warm in
  `requestIdleCallback`.

## Pre-render and full height

`preRender: true` builds the iframe on first load and keeps it warm, so
navigating to that page is instant. The SDK's pre-render wrapper lives at body
level and syncs its rect to the host element, which is why inactive hosts are
parked in an off-screen "attic" with real dimensions rather than
`display: none` — a zero-size host is what causes the 0×0 pre-render stall.

Note that `preRender` + `fullHeight` together is a known-rough combination in the
SDK itself (see SCAL-307017, SCAL-325120 — the pre-render wrapper's height
handling). This sandbox exposes both so you can reproduce it; if a page looks
clipped, that pairing is the first thing to test.

## Testing

```bash
npm run dev                                    # terminal 1
BASE=http://127.0.0.1:8899 ./scripts/smoke.sh  # API + MCP + validation + cache
BASE=http://127.0.0.1:8899 ./scripts/demo.sh   # seed a demo project, prints its URLs
node scripts/browser-check.mjs                 # real Chrome: routing, pre-render, timings
node scripts/editor-check.mjs                  # real Chrome: the /edit UI end to end
node scripts/buttons-check.mjs                 # real Chrome: button->HostEvent, multi-embed
node scripts/fork-check.mjs                    # fork copy fidelity + token isolation
node scripts/store-check.mjs                   # value store, {{bindings}}, Ether.init
node scripts/modal-check.mjs                   # modals, custom-action rules, error surface
node scripts/theme-check.mjs                   # palette derivation, contrast, --ts-var push
node scripts/codegen-check.mjs                 # code flavours, init separation, downloads
node scripts/outline-check.mjs                 # structural outline, handler sources
node scripts/auth-check.mjs                    # token gate, hashing, constant-time compare
node scripts/layout-check.mjs                  # rows/columns, stacking, embedIndex
node scripts/connection-check.mjs              # cluster login + pickers, against a stub cluster
node scripts/builder-check.mjs                 # real Chrome: the visual builder end to end
node scripts/config-check.mjs                  # the whole-app document API
node scripts/live-check.mjs                    # a published page updating itself
```

The two `.mjs` checks need `playwright` resolvable; point `PW_ROOT` at any repo
that has it installed. Both are hermetic and self-provisioning — they create
their own projects and aim the SDK at the local worker, so they need no live
cluster and are safe to re-run.

`browser-check.mjs` covers 18 assertions (chrome render, client-side routing,
pre-render wrapper creation, host moving content↔attic, back button, timings).
`editor-check.mjs` covers 22 (token gate accept/reject, token never persisted,
load/save round-trip, cache invalidation, client- and server-side validation
errors, create, delete, site-config merge semantics). `buttons-check.mjs` covers
20 (every button action resolving to the correct HostEvent with the right
payload, unknown host events refused rather than forwarded, and two embed blocks
on one page each getting their own iframe and pre-render slot) — it spies on
`Embed.prototype.trigger` rather than trusting the code to be wired right.

## Security notes

- **No `eval`, no `new Function`, no `innerHTML`, no user `<script>` — anywhere.**
  Pages are JSON and the renderer writes text through `textContent`, so stored
  page content cannot inject script. Page HTML is never accepted or evaluated.
  `grep -rE 'eval\(|new Function|innerHTML' src public` returns nothing.
- `{{key}}` is a **dotted property lookup against the value store**, not an
  expression evaluator. Its grammar
  (`[A-Za-z_$][\w$-]*(\.[\w$-]+)*`) cannot express a function call or an
  operator. It resolves to a string written via `textContent`.
- Inline `style` values are length-capped and reject `<`, `>`, `javascript:` and
  `expression()`. Values reach the DOM as a style attribute, never as markup.
- `css` fields are neutered for `</` and `@import` before being written into a
  `<style>` element, and theme values are only ever emitted as CSS custom
  properties — never raw declarations.
- Edit tokens are stored as SHA-256 and compared in constant time. Nothing in the
  API returns a token after creation. 32 bytes from `crypto.getRandomValues`, so
  guessing is not a threat model worth engineering against.
- The editor keeps the token in memory only — never `localStorage`,
  `sessionStorage`, or a cookie. `POST /api/projects/:id/verify` exists so the
  editor can check a token without performing a write.
- Reads are public by design (sharing is the point). Writes need the bearer token.
- No CORS headers are set — the API is for agents and scripts, not browser pages
  on other origins. Don't add a wildcard origin to "fix" a browser call.
- **Rate limiting is not implemented in the Worker.** `POST /api/projects` and
  `POST /api/projects/:id/fork` are the only unauthenticated writes. Put a Cloudflare rate-limiting rule on that path
  before this is publicly reachable; that's the right layer for it and it's free
  on the dashboard.
- If you ever extend this to accept raw HTML or user `<script>`, move rendered
  pages to a **separate origin** from the API first. Same-origin arbitrary script
  plus shared sessions is the failure mode this design currently avoids entirely.

## Limits

200 pages per project, 60 blocks per page, 512 KB request bodies, 60 KB of CSS
per scope. D1's free tier (5 GB, 5M reads/day) is far above what this needs.
