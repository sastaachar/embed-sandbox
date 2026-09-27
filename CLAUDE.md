# embed-sandbox — working notes for agents

Read this before editing. Architecture and history live in
`~/Documents/source/pa/tasks/embed-sandbox/task.md`; this file is only the rules that
repeated mistakes have earned.

## Text budget — read this first

I have repeatedly written too much prose, in the wrong places, and Justin has had to ask for
it to be cut. Verbatim, so it is not softened: *"why do you keep adding stupid comments
everywhere"*, *"why all this crap needs to be there i simply dont get"*, *"we can remove this
shit comment"*.

The rule is about **placement**, not word count. Each surface has one job:

| Surface | What belongs | What does not |
|---|---|---|
| **Generated code** (`src/common/codegen.ts`) | A label only where the *position* of a line is the surprise, e.g. `// Runs before the page renders.` | Anything explaining the sandbox, or contrasting "on the sandbox" with "in your app". A customer pastes this into their codebase. |
| **Builder UI labels and hints** | The shortest phrase that identifies the field. `payload: { path, variables }` beats a sentence about what the hook is for. | Teaching. A hint is a label, not a paragraph. |
| **Default code stubs** | The minimal working line, e.g. `return payload;` | Commented tutorials the user has to delete before typing. |
| **Demo page copy** | What the page does, flatly. "`GetPriorityList` ran before this page rendered." | Framing, selling, or explaining why the feature exists. |
| **The MCP manual** (`src/common/mcp.ts`) | Everything. Contracts, gotchas, worked examples, the reasoning. | — this is the one place where length is correct, because agents read it once instead of guessing. |
| **Source comments** | Why a non-obvious choice was made, especially where the obvious thing is wrong. | Restating what the next line plainly does. |

Before adding a sentence anywhere else, ask whether it belongs in the manual instead. It
usually does.

## Cache knobs — bump or the deploy silently no-ops

- `RUNTIME_VERSION` in `src/live/shell.ts` keys the edge-cached published shell.
- `BUILDER_VERSION` in `src/builder/shell.ts` busts the builder bundle.
- The shell edge-caches per `projectId:updatedAt` with `s-maxage=300`; cache-bust URLs when
  verifying a deploy.

## API semantics that have bitten

- `PUT /api/projects/:id/config` **replaces**. Sending `{config:{oneFlag:true}}` wipes theme,
  header and auth. Read the document, edit it, write it whole. (`set_site` over MCP merges;
  the REST endpoint does not.)
- `PUT /api/projects/:id/pages` replaces that one page.
- `url.pathname.split('/').filter(Boolean)` drops a trailing empty segment, so `/prism/`
  becomes `/prism` — different URLs to a cluster. Put the slash back.
- A Worker sends no `User-Agent` and some clusters' nginx answers a bare 403 to that.

## Custom code (`run-code`)

- Every block carries a **`name`**, a JS identifier. A block's four names —
  `payload`, `context`, `getVariable`, `setVariable` — must be **in scope** in both
  places, but not by the same route, and that distinction is the whole point:

      sandbox:  async function <name>({ payload, context, getVariable, setVariable })
      export:   async function <name>(payload)      // the other three are module scope

  The sandbox injects all four because eval-sandbox is a cross-origin iframe with nothing
  of its own. The export has `context`, `getVariable` and `setVariable` declared once at
  module level, so the call site passes only the payload — the one thing that varies per
  call. Re-injecting the other three per call is what `codeArgs(payload)` used to do, and
  Justin's verdict on reading it was *"this is wierd af, the architecure is wrong"*: the
  wrapper existed so the two surfaces could share one parameter list, which was never the
  requirement. Without a name one is derived from the block's position, which is worse —
  hence the builder's Name field. `payload`, `context` and `variables` are refused as names.
- `context` is *only* the environment: `path`, `project.{thoughtSpotHost,sdkVersion}`,
  `tokenUrl`, `clusterUrl`. The same four keys on every run, identical in the runtime and in
  the generated `context`. What varies per run is the `payload`. Sandbox-only markers
  (`hook`, `event`, `button`, `responding`) used to be merged in and were removed: code
  branching on one worked in the sandbox and silently did nothing in the export. Anything
  per-run belongs in the payload, and the dev-log label is a separate argument.
- There is **one way to read a variable**: `await getVariable(key)`. A synchronous
  `variables` snapshot used to sit alongside it and was removed — it duplicated the same
  job and went stale mid-run, so two reads of one key could disagree. Do not reintroduce it,
  in the signature, in `context`, or in a hook payload.
- The function-name registry is per generated flavour. The imperative pass runs before the
  React branch and its output is discarded there, so React clears the registry first or
  every name collides with itself and gains a `2` suffix.

- Runs in `eval-sandbox`: a cross-origin iframe. A relative `fetch` there resolves against
  the sandbox page, so anything pointing at this site must be absolute — hence
  `context.tokenUrl` / `context.clusterUrl`.
- `getVariable` / `setVariable` are a **postMessage round trip** to the page, which owns the
  store: the code asks, the page reads or writes, the page answers. So both are **async** —
  `await getVariable("x")` — a write takes effect immediately, and a read sees writes from
  earlier runs. The host listener accepts a message only from the sandbox iframe's own
  window *and* its origin. (An earlier version buffered writes and applied them at the end;
  that was wrong, because nothing could read the live store.)
- The sandbox serialises runs (one at a time). A burst of intercepts queues while every
  queued run's own timeout keeps counting.
- An embed's `interceptTimeout` must **exceed** the `respond` code's `timeout`, or the app
  abandons the intercept at the instant the code answers.
- Only a *synchronous* result crosses the iframe boundary, which is why the runtime wraps
  code in an async function that logs a marked result and then `[DONE]`. If `eval-sandbox`
  ever awaits a returned Promise natively, delete that workaround.
- `clusterProxy` opens a public, authenticated relay to the project's cluster. Off by
  default. Anyone with the link can call the cluster as the connection user — use a
  low-privilege one, and turn it off when a demo is done.

## Re-applying an embed config: two actions, one supported

- `remount` — destroy the instance, build it again in place. Public SDK only. Loses the
  frame's scroll and state.
- `update-embed` — re-run `beforeRender` and push the result into the *running* frame:
  assign onto `embed.viewConfig`, then fire `HostEvent.UpdateEmbedParams`. Keeps state, but
  **none of those three are public API** (`viewConfig` and `getUpdateEmbedParamsObject()`
  are TypeScript-`protected`; the host event is marked hidden). Verified toggling
  `disabledActions` both ways on SDK 1.51.2. Falls back to `remount` when the SDK does not
  expose the members. Both take the config from the same `beforeRender` hook, so they never
  disagree about *what* to apply — only about how.

## A re-apply inside an ApiIntercept handler MUST be conditional

`remount` and `update-embed` rebuild or re-configure the embed. A rebuilt embed loads the
page again and re-issues the very calls the handler is watching — so an unguarded re-apply
in an ApiIntercept handler is an infinite reload. It happened on the `/limit` demo: the
handler read the watchlist from the app's own `GetPriorityList`, then remounted, which made
the app ask again.

Both actions take **`when`**, naming a variable that must be truthy. Have the respond code
set a flag only when its answer actually *changes* (keep the applied state beside the value)
and point `when` at that. `update-embed` alone happens not to loop, because it mutates the
running frame instead of replacing it — do not rely on that.

The lesson underneath: the snippet in that page's code view already had the guard while the
running document did not, because the action vocabulary could not express it. **If the code
view and the document disagree, the document is the bug** — either the vocabulary is missing
something or the snippet is lying.

## Two ordering rules that are not obvious

- A handler's `respond` runs **before** its `actions`. The embed is blocked until it hears
  back, and an action with a side effect (a `remount`) would otherwise destroy the frame the
  reply is owed to.
- `remount` re-runs `beforeRender`. Generated code must therefore rebuild its config through
  the emitted `<var>BuildConfig()` rather than reuse the object built at load, or the export
  drifts from the sandbox.

## One store: config seeds it, everything reads it

`config.variables` is **not** a second place a value can come from — it is the store's
starting content. The runtime has always worked this way (`hydrateVars()` writes the
declared defaults into `values` at boot, applying session > saved > default once, and
every reader — `interpolate`, `resolveTokens`, value blocks, `getVariable` — reads
`values` afterwards). `readVar` exists only to compute that seed and to recompute it on a
write or a `reset`.

The **export** used to break the model three ways, and no longer does: its `appVariables`
Map started empty, `{{tokens}}` were emitted as quoted braces that resolved to nothing,
and code blocks got the accessors handed to them per call. Now codegen emits
`setVariable(key, default)` for every declared variable with a default, and every token
in an embed config or a host-event payload becomes `getVariable("key")` —
`literalReads()` / `readExpr()` in `codegen.ts`, and `jsxProp` for the React flavour.
Justin: *"config -> setVariable, all usage -> getVariable"*.

The export's accessors are deliberately **synchronous**: `async` only ever existed for the
sandbox's postMessage round trip, an authored `await getVariable(x)` still works on a
plain return, and sync is what lets a token be read inside an ordinary object literal or a
JSX prop with no async plumbing in the React and CDN flavours. They resolve dotted paths
(`{{boot.greeting}}`) the way the runtime's `lookup` does.

## Visitor configs are namespaced localStorage keys

A visitor may keep several named configs (host + auth + variables), one per cluster. Rather
than a parallel store, the active name is folded into the **same** keys everything already
reads: `sb.var.<pid>.<key>` / `sb.init.<pid>` for the unnamed default, `…<pid>@<name>.<key>`
for a named one. So `readVar`, `writeInitOverride` and the rest needed no changes, and a
project with no configs behaves exactly as before. The registry is `sb.cfg.<pid>`.

Two things that bit while building it:
- **Delete must derive its key prefix from the name being deleted**, not from the prefix
  captured at page load — if the active config changed since, the module-scope prefix is
  someone else's and the wrong config gets wiped.
- **`?config=<name>` has to strip itself** from the URL after it applies. Left in place it
  re-pins that config on every load, and since switching and deleting both reload, neither
  could ever stick.

## The code view can be hand-written

`page.codeOverride: { react?, esm?, cdn?, note? }` replaces what the `‹/›` view shows for
that flavour — demos usually want the few lines that make the point, not the faithful export.
Anything not overridden still comes from the generator. The `note` only travels with an
actual override: attaching it to a generated flavour would describe code the reader is not
looking at. The endpoint answers both surfaces (published overlay and builder Code tab), so
the override lands in both at once.

Both views **open on the flavour that is hand-written** (marked with a •). They used to open
on React regardless, so a page whose only override was the JavaScript one showed a 300-line
generated export and the authored version looked absent — which is exactly how it was
reported.

## The builder does not run custom code

The canvas renders embeds live, but `run-code` blocks execute only in the **published**
runtime — there is no evaluator in the builder. So an ApiIntercept `respond` that filters a
response does nothing on `/build/<id>`, and the embed there shows unfiltered data. Check
behaviour on `/p/<id>/<path>`. (`/build/<id>/anything` also ignores the trailing path and
opens the builder at `/`.)

## Testing

`e2e/*.mjs` run against a live instance: `BASE=http://127.0.0.1:8898 node e2e/code-check.mjs`.
Browser suites take Playwright from `PW_ROOT` (defaults to the theme-builder checkout).
Run `code-check` plus the suites for whatever you touched before deploying.

With `waitUntil: 'commit'` a Playwright poll can run before the DOM is parsed, so guard every
polling function with `!!document.body`.

**Never wait for text to be absent.** `!/waiting for the app/` is true before the page has
rendered anything, so the wait returns instantly and every assertion after it reads an empty
page — a working page then reports five failures. Wait for the positive signal the change
produces (`/narrowed to Liveboards/`), which can only appear once it has actually happened.

## The settings panel's config tabs (8 Sep)

Justin: *"the add new config ui is so bad, i want the add button next to settings, add plus
next to it and show tabs wuthout botton"*. The first version was a `<select>` + a name box +
an **Add** button + a **Delete** button, sitting in the panel body under a "Config" heading —
four controls and two lines of prose for what is a choice between two names.

Now: the configs are tabs in the panel head, right after the title, with a `+` at the end.
Clicking a tab switches (which reloads, since `init()` cannot be re-pointed). `+` replaces
itself with a name box in place — Enter creates, Escape or blur puts the `+` back. The active
named tab carries a `×` that deletes it. The body has no Config section at all any more, and
no explanatory note: a tab strip does not need one.

`×` is deliberately only on the **active** tab. Deletion derives its localStorage keys from
the name being deleted, and being active is what makes "delete this one, fall back to
Default" unambiguous.

## SDK version in the settings panel (8 Sep)

*"have sdk version as well in the settings"* — a field beside the host, so a visitor can
point the page at another published SDK, or a `pr:<n>` build, from their own browser. It
joins the same browser-only override as host and auth, and `applyInitOverride` recomputes
`M.sdkUrl` through `sdkUrlFor()`, which mirrors the worker's `sdkUrl()` (a `pr:` ref is an npm
tarball, so it goes via `/sdk/pr/<ref>/tsembed.js`, not the CDN).

The field is prefilled with the effective pin, so **clearing it** is how a visitor hands the
override back to the site. `apply()` only writes the override when the text differs from
`siteSdkVersion`, captured before any override touches `M.project` — otherwise a page pinned
to `latest` would freeze at whatever `latest` was the day someone opened the panel.

**The bundle keeps its own version private** (`var version$1="1.51.2"` is internal, nothing
on `window.tsembed` exposes it), so the resolved version comes from jsDelivr's data API
(`/v1/packages/npm/@thoughtspot/visual-embed-sdk/resolved?specifier=latest`, CORS open) and
is only asked for a range, never a fixed version or a `pr:` ref.

Known waste: the shell still preloads the **site's** pin, so a visitor with an override
downloads a bundle nobody uses. Unavoidable — the override is in their browser, and the
preload is decided on the server.

### Two follow-ups on those tabs, same evening

*"cant add new tf"* — the name box cancelled on blur, so typing a name and then reaching for
the mouse threw it away, and the only working gesture was Enter, which nothing advertised.
Blur now **commits** (empty blur restores the `+`, Escape still cancels), and the placeholder
says `name, then Enter`. A `done` flag keeps blur and Enter from both firing.

*"the blue sticks out like a sore thumb / it should be blending it"*, then a screenshot of
classic folder tabs — *"wanted like this"*. They are folder tabs now, not pills: the strip
hangs off the bottom edge of the head (`align-self:flex-end; margin-bottom:-10px`, which is
the head's 9px padding plus its 1px border), each tab is `border-radius:8px 8px 0 0` with no
bottom border, and the **active** one is `--sb-bg` — the body's own background — so it paints
over the head's `border-bottom` and reads as one surface with the panel below. Descendants
paint above a parent's border, which is what makes that work without any z-index.

Inactive tabs are a flat grey (`color-mix(in srgb, var(--sb-text) 7%, var(--sb-surface))`,
with an `rgba(0,0,0,.05)` line before it as the fallback) and keep a 1px `margin-bottom` so
the head's line still runs beneath them. The `+` is a small tab of the same kind, and the
name box takes the same shape while it is open.

### Aligning the tab row (9 Sep)

*"this is good, just its not aligned"* — with folder tabs the head is as tall as the tallest
tab, so a vertically centred "Settings" floated about 5px above the tab labels. The settings
head now bottom-aligns (`align-items:flex-end`) and its title and Close carry
`margin-bottom:-5px`, which drops their text onto the tab labels' line — bottom alignment plus
padding can only push text *up*, so a negative margin is the only way down. Inactive tabs got
`padding-bottom:6px` (against the active tab's 7px plus its extra 1px offset) so every label,
active or not, sits on the same line.

Measure this with a `Range` over the text node, not `getBoundingClientRect` on the button: the
button boxes are deliberately different heights, and it is the text that has to line up.

## The fork page, and the JSON editor's removal (9 Sep)

*"the fork page just dumps a lot of detail, the fork it button should just take you too the
build page with token, also there should be a copy token option, remove the edit page its
useless, and the info dump page after fork"*.

`/fork/<id>` is now a heading, one sentence and a **Fork it** button — 181 characters of copy.
Forking POSTs, writes the new token to the clipboard as a courtesy, and `location.replace`s to
`/build/<newId>#t=<token>`, so you land in the builder already holding the token; the fragment
never reaches the server and the builder strips it from the address bar. The post-fork detail
dump is gone with it.

**Copy token** is a header button in the builder, beside Forget token. The token was only
reachable through the Build with AI dialog before, which is not where anyone looks for it.

**`/edit/<projectId>` is deleted** — route, `src/builder/editor.ts` (610 lines),
`e2e/editor-check.mjs`, the `editUrl` field of `publicUrls()`, and the README's three mentions.
The builder's `‹/›` panel covers the same ground. `builderUrl` was already in `publicUrls`, so
nothing needed repointing; anything reading `editUrl` from the API now gets nothing, which is
the intended break.

## The token proxy handed out the same token twice (9 Sep)

Symptom, from a Liveboard embed that would not load:

```
[vesdk-1.51.2] Received invalid token from getAuthToken callback or authToken endpoint.
Error : Duplicate token. Please issue a new token every time getAuthToken callback is called.
```

`mintToken()` caches per project for the token's whole validity (300s by default), which is
right for `search_metadata` and the other server-side callers, and wrong for `/token`: the SDK
calls `getAuthToken` again on every expiry and retry and **rejects a token it has already
seen**, so the cache turned a slow path into a broken one.

`/token` now calls `mintFreshToken()`, which drops the cache entry and mints. The route is
public, so it keeps a cap — past 30 mints a minute for one project it serves the last token
again (which the SDK may refuse) rather than handing anyone with the link an unbounded lever on
the cluster's login endpoint. The cache itself stays for the callers it was built for.

## The React flavour did not wire "<HostEvent> Subscribed" handlers (10 Sep)

Justin, on a project of his own: *"check the json and code that it made, its all messed up"* …
*"js is fine react is fcked"*. He was right, and it was two faults in the React branch of
`codegen.ts`:

**It refused to wire the handler.** A composed event name — `"edit Subscribed"` — has no
`on<EmbedEvent>` prop, because the name only exists at runtime, so the generator emitted a
comment telling the reader to do it themselves and dropped the handler on the floor. The esm
flavour wired the same handler correctly, which is why only React looked broken. Now the
handlers are collected with the ref of the embed they belong to and emitted as a real effect:

```jsx
const embedRef = useEmbedRef();
useEffect(() => {
  const embed = embedRef.current;
  if (!embed) return;
  embed.on("edit Subscribed", (payload) => embed.trigger(HostEvent.Edit));
}, []);
```

The ordering trap: the `ref={}` prop is emitted while walking the blocks, which happens
*before* the handlers are collected, so "does this page need a ref" has to be computed up
front (`refWiredHandlers`) rather than read off the collected list.

**It emitted custom-code scaffolding on pages with no custom code.** `codeContext`,
`getVariable`, `setVariable` and `codeArgs` were gated on `codeDefs.length`, and `codeDefs`
also collects things that are not custom code (a `beforeRender` base config, those comments).
Gated on `usesCode` now, which is the real signal.

11 new checks in `e2e/codegen-check.mjs` (92 total, all passing).

**Verification gotcha:** `/api/projects/:id/code` answers from an edge cache. I read a stale
body twice and thought a fix had not deployed. Add a throwaway query param (`&cb=$RANDOM`)
when checking generated code by hand.
