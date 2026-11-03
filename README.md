# embed-sandbox

Shareable ThoughtSpot embed showcases that an AI agent can build for you.

Start a project, get a `projectId` and an `editToken`, point an agent at the MCP
endpoint, and it writes your pages. What a visitor opens is the finished site —
header, embed, footer, buttons — not an editor.

```
POST /api/projects            ->  projectId + editToken
GET  /p/<projectId>/...       ->  the live site (share this)
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
  fork.ts                 the /fork landing page (one button, into the builder)
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

And one that ends a project:

```
DELETE /api/projects/<id>?confirm=<id>     # the project, its pages, its connection
```

Token-gated like any write, and it takes the id twice on purpose: the edit token is the
only proof of ownership and it dies with the row, so there is nothing to recover
afterwards and no undo to reach for. Missing or wrong `confirm` is a 400.

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
2. **`/build/<projectId>`** — the visual builder. `‹/›` shows the JSON behind any
   block, so hand-editing is a panel away rather than a separate page.
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
remounts. A page polls twice at 30s and then stops, leaving a **See latest** pill; a
change found by either path restarts the two polls. Each poll is a Worker invocation,
and the free tier allows 100k a day, which a 4s poll from a few open tabs exhausted.

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

The panel also carries a **dev mode** toggle. With it on, the page logs every host
event it fires, the reply that came back, and every embed event received — each row
saying which embed it belongs to. It gets its own **›_ button at the bottom left**,
opposite ⚙ and ‹/›, which opens and closes the console: closing keeps the log, and
only the dev-mode switch throws it away. A dot on the button means something arrived
while it was shut. Off by default, and it costs nothing when off.

Only **host** and **embed** are on by default — what this page sent, and what came
back out of the embed. `reply`, `wire` and `code` are the same traffic seen closer up,
and leaving them on buried the two lines anyone was actually looking for.

**The direction boxes gate recording, not display.** They began as a display filter, and
that was wrong in a way that only shows up on a busy page: unticked traffic was still
recorded, so it spent the 400-entry budget and evicted the `host` and `embed` rows you
were watching. From the outside that looks exactly like the log clearing itself — which is
how it was reported. The split that holds up: the boxes are coarse and sticky, so they
decide what is captured; the text query is retyped constantly, so it only ever decides
what is shown. The cost is that ticking a direction back on starts recording from that
moment and cannot recover what already fired — the same caveat dev mode itself has, and
the legend says so. A count sitting at 400 is now a signal in its own right: something
chatty is pushing your rows out, so untick it.

The head's **?** opens a legend, because nothing in the panel explains itself on
sight: what each direction means (and which start off), what the columns and badges
are, what the count is counting, and the whole filter grammar. The count reads
`shown/received` — rows the filter lets through out of everything received — and the
log keeps the last 400 events.

The **filter box** is a comma-separated list, and **where the `*` is** says what a
term means. That is the entire grammar:

| term | means |
| --- | --- |
| `Update` | plain text — matches anywhere: the event name, the embed, or the payload |
| `Update*` | starts with Update |
| `*Filters` | ends with Filters |
| `*Filter*` | contains Filter — the same as plain text |
| `Up*Filters` | starts with Up **and** ends with Filters |
| `!Subscribed` | a leading `!` or `-` drops those rows; `!Sub*` drops anything starting with Sub |
| `/^Update/` | a regex, for the rare pattern that needs more; flags optional, `i` by default |

So `Update*, Navigate*, !Subscribed` reads exactly as it sounds: those two, but never
a Subscribed. There is **no Only/Hide switch** — one box, one meaning: plain terms say
what to show, `!` terms say what to drop, and with no plain terms everything the `!`
terms left behind stays. A half-typed regex is ignored (and the box turns red) rather
than blanking the log. Right-click any row for **Only** / **Also show** / **Hide**
that event — Hide writes `!Name`, the same grammar you would type, and accumulates —
**Only this direction**, copy payload, or log it to the console. The filter is
remembered per project.

**One event is one row.** Two things used to double every line and are both fixed:

- Several classes in the SDK's chain own their own `trigger()` and each delegates up
  to the next (a `LiveboardEmbed` call lands on `V1Embed`'s, which calls `TsEmbed`'s).
  Both have to be patched — `SpotterEmbed` inherits only the second — so a re-entrancy
  guard means only the outermost call logs.
- One iframe message becomes one `EmbedEvent`, so the wire row and the embed row
  behind it were the same event twice. The pair folds into the embed row (real member
  name, real embed label) marked ⇄; a wire row nothing claims stays on its own, which
  is the only wire traffic worth a line.

A genuine burst — the same event, same payload, again — counts up on one row as `×N`
instead of scrolling the log away. A row that just arrived **flashes amber and fades out
from the first frame** over 1.8s, with a darker amber bar down its left edge, so a burst
reads as a band of rows at different stages rather than a wall of identical text. Amber is
the one fixed colour here that earns being fixed: nothing else in the panel is warm, so it
never competes with the site's palette the way an accent wash does, and it is what every
tool uses for *this just changed*. At 28% alpha it lifts a light surface and warms a dark
one — no per-theme variant, and the row's own text is left completely alone. There is no
`prefers-reduced-motion` override either: a colour cross-fade involves no movement, and it
is what that setting asks you to use *instead* of movement. Only rows that arrive **live**
are marked; a redraw or a filter change rebuilds every row, and flashing the whole log
then would mean the opposite.

**The log keeps going as you move around the site**, and a reload starts it fresh — it
lives in the page and is mirrored nowhere. Moving around used to clear it, and the cause
was a broken link rather than the log: the click handler caught only the nav links the
runtime generates itself (`a[data-sb-to]`), so a **Markdown** link into the same site was
a full document load — and since authors write the project-relative `/two`, the same
spelling `nav: [{ to }]` takes, it was a real load of a bare root path that is a page of
nothing. Those links were already broken; the lost log is what surfaced it.
`internalPath()` accepts both spellings, routes only paths this project actually has, and
leaves queries, hashes, `/build`, `/fork` and everything external as real navigations.

Three sources, because one alone leaves gaps:

- **`trigger` is patched on the prototype** that all embed classes inherit, so the
  log includes the SDK's *own* host events — `UpdateEmbedParams` on a pre-render
  reveal, `Navigate`, `DestroyEmbed`, `VisibleEmbedCoordinates` — which never pass
  through this project's code.
- **`EmbedEvent.ALL`**, one listener per embed, for events the SDK surfaces.
- **A capture-phase `message` listener** for the raw wire: everything the iframe
  posts to the page, whatever the SDK does with it. Only this direction is
  interceptable — host → iframe goes through `postMessage` on a cross-origin
  `contentWindow`, and the only hook for that is the `contentWindow` getter, which
  would break the `event.source === iframe.contentWindow` identity the SDK routes
  incoming events by.

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
    { "type": "text", "text": "**Markdown** copy.\n\n- a bullet\n- another" },
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

### Markdown in text blocks — and only Markdown

The `text` block renders **Markdown**. Every other place text appears — `heading`,
button labels, `value` labels and placeholders, header and footer text, page
titles — is literal text, and Markdown written there shows its own asterisks.

This is the whole grammar. Nothing outside it does anything:

| | |
|---|---|
| `**bold**` `__bold__` | bold |
| `*italic*` `_italic_` | italic |
| `~~struck~~` | strikethrough |
| `` `code` `` | inline code |
| `[label](url)` | link |
| `![alt](url)` | image |
| `# h1` … `###### h6` | headings |
| `-` `*` `+` | bullets, nested by indenting two spaces |
| `1.` `1)` | numbered lists |
| `>` | blockquote |
| ` ```lang ` … ` ``` ` | fenced code block |
| `---` | horizontal rule |
| `\*` | escapes the next character |

A single newline is a line break; a blank line starts a new paragraph.

**HTML is not supported.** Not a subset, not "safe tags", not behind a flag. There
is no sanitiser to defeat because there is nothing to defeat: `markdown.js` builds
DOM nodes for the Markdown it recognises and every other character becomes text.
Write `<b>hi</b>` and the page shows the eight characters `<b>hi</b>` — likewise
`<script>`, `<iframe>`, `<br>`, `<img onerror=…>` and HTML entities (`&amp;` stays
`&amp;`). Structure comes from blocks; one-off styling from a block's `style`;
anything wider from page or site `css`.

Also **not** supported, deliberately: tables, task lists, footnotes, autolinks
(`<https://x>`), reference-style links, setext (`===`) headings, heading ids.

Links only resolve for `http:`, `https:`, `mailto:`, `tel:` and relative or
`#anchor` targets. `javascript:`, `data:` and anything else render as the literal
text that was typed, link syntax and all.

`{{key}}` is interpolated **before** the Markdown is parsed, so a variable's value
can carry formatting of its own — and still cannot carry markup.

The rendered block is `<div class="sb-text sb-md">`, so `.sb-md p`, `.sb-md ul`,
`.sb-md code` and friends are reachable from page or site `css`. (It was a `<p>`
before Markdown landed; a `<p>` cannot legally contain a list or a code block.)

One renderer serves both surfaces. `public/_static/live/markdown.js` is loaded by
the published shell *and* by the builder, so the canvas preview is the same DOM the
visitor gets rather than a second implementation drifting quietly out of step.

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

Measured locally with `e2e/browser-check.mjs`:

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

Every end-to-end suite lives in **`e2e/`**; `scripts/` holds the one thing that
isn't a test (`demo.sh`, which seeds a project). Each suite is a standalone file
run directly — there is no runner and no framework to learn.

```bash
npm run dev                                  # terminal 1
BASE=http://127.0.0.1:8899 ./e2e/smoke.sh    # API + MCP + validation + cache
BASE=http://127.0.0.1:8899 ./scripts/demo.sh # seed a demo project, prints its URLs
node e2e/browser-check.mjs                   # real Chrome: routing, pre-render, timings
node e2e/builder-check.mjs                   # real Chrome: the visual builder end to end
node e2e/editor-check.mjs                    # real Chrome: the /edit UI end to end
node e2e/buttons-check.mjs                   # real Chrome: button->HostEvent, multi-embed
node e2e/markdown-check.mjs                  # text blocks: Markdown renders, HTML never does
node e2e/variables-check.mjs                 # the canvas resolves {{key}} from declared defaults
node e2e/fork-check.mjs                      # fork copy fidelity + token isolation
node e2e/store-check.mjs                     # value store, {{bindings}}, Ether.init
node e2e/modal-check.mjs                     # modals, custom-action rules, error surface
node e2e/theme-check.mjs                     # palette derivation, contrast, --ts-var push
node e2e/codegen-check.mjs                   # code flavours, init separation, downloads
node e2e/outline-check.mjs                   # structural outline, handler sources
node e2e/graph-check.mjs                     # site map: nav edges, shared values, dangling links
node e2e/auth-check.mjs                      # token gate, hashing, constant-time compare
node e2e/lock-check.mjs                      # the advisory edit lock and its banner
node e2e/connect-check.mjs                   # tokenised connect link + publish-credential toggle
node e2e/layout-check.mjs                    # rows/columns, stacking, embedIndex
node e2e/config-check.mjs                    # the whole-app document API
node e2e/live-check.mjs                      # a published page updating itself
node e2e/reload-check.mjs                    # HostEvent.Reload never pins the host page
node e2e/dev-check.mjs                       # the dev console: its button, the legend, the filter
```

The Chrome-driven checks need `playwright` resolvable; point `PW_ROOT` at any repo
that has it installed. All of them are hermetic and self-provisioning — they create
their own projects and aim the SDK at the local worker, so they need no live
cluster and are safe to re-run.

`e2e/browser-check.mjs` covers 18 assertions (chrome render, client-side routing,
pre-render wrapper creation, host moving content↔attic, back button, timings).
`editor-check.mjs` covers 22 (token gate accept/reject, token never persisted,
load/save round-trip, cache invalidation, client- and server-side validation
errors, create, delete, site-config merge semantics). `buttons-check.mjs` covers
20 (every button action resolving to the correct HostEvent with the right
payload, unknown host events refused rather than forwarded, and two embed blocks
on one page each getting their own iframe and pre-render slot) — it spies on
`Embed.prototype.trigger` rather than trusting the code to be wired right.

## Security notes

- **No `eval`, no `new Function`, no user `<script>` — anywhere.** Pages are JSON
  and nothing that renders a page turns author text into markup. Page HTML is
  never accepted or evaluated. `grep -rE 'eval\(|new Function' src public` returns
  nothing.
- **One `innerHTML` in the whole codebase**, and it never touches page content:
  the ‹/› code overlay assigns `Prism.highlight()`'s output to the `<pre>` it just
  filled with `textContent`. Prism escapes `<` and `&` before wrapping tokens in
  spans, and its input is generated SDK code, not raw block text. If the CDN is
  unreachable the plain-text version stands. `grep -rn innerHTML src public`
  should return that one line and no other — a second hit is a regression.
- **Markdown is rendered by construction, not by sanitising.**
  `public/_static/live/markdown.js` creates elements with `document.createElement`
  and text with `document.createTextNode`; it has no API that takes an HTML string,
  so there is no code path from a text block to an element the parser did not
  itself decide to make. `<script>` in a text block is six-plus characters of text,
  not a tag — which is why "we support Markdown, not HTML" is a property of the
  renderer and not a filter someone can find a hole in. Link and image URLs are
  restricted to `http:`, `https:`, `mailto:`, `tel:` and scheme-less targets;
  `javascript:` and `data:` fall back to literal text rather than becoming an
  `href`. External links get `rel="noopener noreferrer"`.
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
