import type { Block, ButtonSpec, EmbedSpec, PageConfig, ProjectConfig } from './schema';
import { sdkInstallSpec, sdkUrl } from './sdkUrl';

export type Flavor = 'cdn' | 'esm' | 'react';

/** The composed "<host event> Subscribed" event, or null for a plain EmbedEvent name. */
const subscribedBase = (type: string): string | null => {
  const m = /^(\S+) Subscribed$/.exec(type);
  return m ? m[1] : null;
};
/**
 * How a handler's event is written in generated code. The composed Subscribed name is
 * not an EmbedEvent member, so it goes out as the literal the SDK matches on — the same
 * string `embed.subscribedEvent(HostEvent.X)` builds.
 */
const eventExpr = (type: string): string =>
  (subscribedBase(type) ? JSON.stringify(type) : `EmbedEvent.${type}`);

const CLASS_FOR: Record<EmbedSpec['type'], string> = {
  liveboard: 'LiveboardEmbed',
  viz: 'LiveboardEmbed',
  search: 'SearchEmbed',
  searchbar: 'SearchBarEmbed',
  app: 'AppEmbed',
  spotter: 'SpotterEmbed',
  conversation: 'ConversationEmbed',
};

const HOST_EVENT_FOR: Record<string, string | null> = {
  reload: 'Reload',
  edit: 'Edit',
  save: 'Save',
  'download-pdf': 'DownloadAsPdf',
  'set-filter': 'UpdateFilters',
  'host-event': null,
  nav: null,
  'open-url': null,
};

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** JSON is valid JS, but unquoted keys read like code a person would write. */
function literal(value: unknown, indent: number): string {
  const json = JSON.stringify(value, null, 2) ?? 'undefined';
  return json
    .replace(/^(\s*)"([^"]+)":/gm, (m, pad: string, key: string) =>
      IDENT.test(key) ? `${pad}${key}:` : m,
    )
    .split('\n')
    .join('\n' + ' '.repeat(indent));
}

const TOKEN = /\{\{\s*([A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z0-9_$-]+)*)\s*\}\}/g;
const WHOLE_TOKEN = /^\{\{\s*([A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z0-9_$-]+)*)\s*\}\}$/;

/**
 * A {{token}} is a read out of the variable store, so it is emitted as one: the whole
 * string becomes getVariable("key"), and a token inside a longer string becomes a
 * template. Braces in the export would be a string nobody set — the export has the same
 * store the page does.
 */
function readExpr(s: string): string | null {
  const whole = s.match(WHOLE_TOKEN);
  if (whole) return `getVariable(${JSON.stringify(whole[1])})`;
  TOKEN.lastIndex = 0;
  if (!TOKEN.test(s)) return null;
  TOKEN.lastIndex = 0;
  const tpl = s
    .replace(/[\\`$]/g, (c) => '\\' + c)
    .replace(TOKEN, (_m, key: string) => '${getVariable(' + JSON.stringify(key) + ')}');
  return '`' + tpl + '`';
}

/** literal(), except {{token}} strings come out as store reads instead of quoted braces. */
function literalReads(value: unknown, indent: number): string {
  const exprs: string[] = [];
  const mark = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const expr = readExpr(v);
      if (!expr) return v;
      exprs.push(expr);
      return `\u0000${exprs.length - 1}\u0000`;
    }
    if (Array.isArray(v)) return v.map(mark);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = mark(val);
      return out;
    }
    return v;
  };
  const marked = mark(value);
  if (!exprs.length) return literal(value, indent);
  return literal(marked, indent).replace(/"\\u0000(\d+)\\u0000"/g, (_m, i: string) => exprs[Number(i)]);
}

/**
 * Rows nest their blocks in columns, so a flat scan misses every embed in a side-by-side
 * layout — and reports a page full of embeds as having none.
 */
function walk(blocks: Block[] | undefined, hit: (b: Block) => void): void {
  for (const block of blocks ?? []) {
    hit(block);
    if (block.type === 'row') for (const col of block.columns ?? []) walk(col.blocks, hit);
  }
}

function embedsIn(page: PageConfig): EmbedSpec[] {
  const out: EmbedSpec[] = [];
  walk(page.blocks, (b) => { if (b.type === 'embed') out.push(b.embed); });
  return out;
}

function buttonsIn(page: PageConfig): ButtonSpec[] {
  const out: ButtonSpec[] = [];
  walk(page.blocks, (b) => { if (b.type === 'buttons') out.push(...(b.items ?? [])); });
  return out;
}

/** k="str" for strings, bare for true, braces for everything else — plain JSX. */
function jsxProp(pad: string, key: string, value: unknown): string[] {
  if (value === true) return [`${pad}${key}`];
  if (typeof value === 'string') {
    const read = readExpr(value);
    return [read ? `${pad}${key}={${read}}` : `${pad}${key}=${JSON.stringify(value)}`];
  }
  const rendered = literalReads(value, 0).split('\n');
  if (rendered.length === 1) return [`${pad}${key}={${rendered[0]}}`];
  const out = [`${pad}${key}={${rendered[0]}`];
  for (const extra of rendered.slice(1)) out.push(`${pad}${extra}`);
  out[out.length - 1] += '}';
  return out;
}

/** Text is JSX children here, so the two characters that would break it are escaped. */
function escapeJsx(text: string | undefined): string {
  return String(text ?? '').replace(/[{}]/g, (c) => `{'${c}'}`);
}

/** Anything that would render differently as Markdown than as literal text. */
const MD_SYNTAX = /\*\*|~~|`|\[[^\]]*\]\(|^[ \t]*(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>|#{1,6}[ \t])/m;

/**
 * A text block is Markdown on the sandbox but plain children in generated JSX. Where
 * that actually changes the output, say so in the code rather than quietly dropping the
 * formatting into an export someone is about to paste into a real app.
 */
function textJsx(text: string | undefined, pad: string): string[] {
  const line = `${pad}<p>${escapeJsx(text)}</p>`;
  return MD_SYNTAX.test(String(text ?? ''))
    ? [`${pad}{/* Markdown in the sandbox — render with the Markdown component of your choice. */}`, line]
    : [line];
}

/** "data-id" is not an identifier; "dataId" is. */
function varName(key: string): string {
  return key.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^[0-9]/, (d) => `_${d}`);
}

type AnyAction = { type: string; params: Record<string, any> };

/**
 * A run-code action's source, as a real async function the host app owns. The block's
 * four names have to be in scope in both places, but not by the same route: the sandbox
 * injects them into an isolated iframe, while the export has `context`, `getVariable`
 * and `setVariable` at module scope and takes only the payload — the one thing that
 * varies per call. Passing the other three in per call is what `codeArgs` used to do.
 */
const CODE_PARAMS = 'payload';

function codeFnLines(name: string, code: string, pad = ''): string[] {
  const body = String(code ?? '').replace(/\r\n/g, '\n').split('\n');
  return [
    `${pad}async function ${name}(${CODE_PARAMS}) {`,
    ...body.map((l) => (l.trim().length ? `${pad}  ${l}` : '')),
    `${pad}}`,
  ];
}

/**
 * The block's own name wins; the derived one is only a fallback for documents written
 * before run-code carried a name. Collisions are suffixed rather than silently shadowed.
 */
function fnNameFor(
  params: Record<string, any> | undefined,
  taken: Set<string>,
  fallback: string,
): string {
  const wanted = typeof params?.name === 'string' && params.name ? params.name : fallback;
  let name = wanted;
  for (let n = 2; taken.has(name); n += 1) name = `${wanted}${n}`;
  taken.add(name);
  return name;
}

/** "embed", "Data" -> "embedOnDataCode"; "beforeRender" -> "embedBeforeRender". */
function codeName(base: string, suffix: string, n?: number): string {
  const cap = suffix.replace(/[^A-Za-z0-9]/g, '').replace(/^./, (c) => c.toUpperCase());
  return `${base}${cap}${n && n > 1 ? n : ''}`;
}

function hasRunCode(actions: AnyAction[] | undefined): boolean {
  return (actions ?? []).some((a) => a.type === 'run-code');
}

/** Matches what the sandbox runtime uses, so the snippet targets the same wrapper. */
function preRenderIdFor(path: string, index: number): string {
  const key = path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root';
  return `sb_${key}_${index}`;
}

/** "/sales/q3" -> "SalesQ3Page", so the snippet is pasteable as-is. */
function componentName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return 'HomePage';
  return parts
    .map((p) => p.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
      .replace(/^./, (c) => c.toUpperCase()))
    .join('') + 'Page';
}

/**
 * `omitDefaults` leaves out whatever the project already applies to every embed, so a
 * snippet shows what makes THIS embed different instead of repeating a theme blob per
 * block. The defaults are emitted once, separately, and spread back in.
 */
function embedConfigFor(
  spec: EmbedSpec,
  project: ProjectConfig,
  preRenderId: string | null,
  omitDefaults = false,
) {
  const cfg: Record<string, unknown> = omitDefaults
    ? { ...spec.config }
    : { ...(project.embedDefaults ?? {}), ...spec.config };
  if (!cfg.fullHeight && !cfg.frameParams) {
    cfg.frameParams = { height: spec.height ?? 640 };
  }
  if (preRenderId) cfg.preRenderId = preRenderId;
  return cfg;
}

export function generateCode(
  project: ProjectConfig,
  page: PageConfig,
  path: string,
  flavor: Flavor = 'cdn',
  /** esm only: emit the app-level init() block. Ignored for cdn, which is standalone. */
  includeInit = true,
  /** Absolute URL of this project's token proxy, for auth.tokenSource "proxy". */
  tokenProxyUrl?: string,
  /** This site's origin, so a pkg.pr.new pin resolves to an absolute script src. */
  origin = '',
): string {
  const embeds = embedsIn(page);
  // Every button, not only the ones that fire a host event: the React flavour renders
  // them all and needs a handler for each. The imperative flavours skip the rest.
  const buttons = buttonsIn(page);
  const hostEventButtons = buttons.filter((b) => (b.actions ?? []).some((a) => a.type === 'HostEvent'));
  const host = project.thoughtSpotHost || 'https://your-instance.thoughtspot.cloud';
  const authType = project.authType || 'None';
  const version = project.sdkVersion || 'latest';

  // A page with no embed block still generates: the React flavour emits the whole
  // page, cdn a standalone page without the SDK, esm the app-level init and a note.
  const hasEmbeds = embeds.length > 0;

  const classes = [...new Set(embeds.map((e) => CLASS_FOR[e.type]))];
  const usesUpdateEmbed = hasEmbeds && [
    ...buttons.flatMap((b) => (b.actions ?? []) as AnyAction[]),
    ...embeds.flatMap((e) => (e.embedEventHandlers ?? []).flatMap((h) => (h.actions ?? []) as AnyAction[])),
  ].some((a) => a.type === 'update-embed');
  const needsHostEvent = (hostEventButtons.length > 0 || usesUpdateEmbed) && hasEmbeds;
  const WIREABLE = new Set(['set', 'HostEvent', 'nav', 'open-url', 'run-code']);
  const handlerActions = embeds.flatMap((e) => (e.embedEventHandlers ?? []).flatMap((h) => h.actions ?? []));
  const hasResponders = hasEmbeds && embeds.some((e) => (e.embedEventHandlers ?? []).some((h) => h.respond));
  const hasWiredHandlers = hasEmbeds && (handlerActions.some((a) => WIREABLE.has(a.type)) || hasResponders);
  // Custom code anywhere on the page makes the snippet async: hooks are awaited before
  // the thing they guard, and a responder answers with an awaited value.
  const usesCode = hasRunCode(page.beforeLoad as AnyAction[] | undefined)
    || embeds.some((e) => hasRunCode(e.beforeRender as AnyAction[] | undefined))
    || hasRunCode(handlerActions as AnyAction[]) || hasResponders
    || buttons.some((b) => hasRunCode(b.actions as AnyAction[] | undefined));
  // A page that reads a {{token}} needs the store even with no code block in sight.
  const usesVars = [JSON.stringify(page), JSON.stringify(project.embedDefaults)]
    .some((s) => { TOKEN.lastIndex = 0; return TOKEN.test(s ?? ''); });
  const handlerHostEvent = hasEmbeds && handlerActions.some((a) => a.type === 'HostEvent');
  const initImports = ['init', 'AuthType'];
  const pageImports = [
    ...classes,
    ...(needsHostEvent || handlerHostEvent ? ['HostEvent'] : []),
    ...(hasWiredHandlers && embeds.some((e) => (e.embedEventHandlers ?? [])
      .some((h) => !subscribedBase(h.type))) ? ['EmbedEvent'] : []),
  ];
  const imports = [...initImports, ...pageImports];

  // init() is global to the app, not to a page. Kept separate so the esm flavour
  // can place it at bootstrap and the per-page snippet can omit it entirely.
  // The trusted-auth types refuse to init without a getAuthToken, so the generated
  // code carries the same one the runtime builds from the declarative `auth` block.
  const tokenAuth = authType === 'TrustedAuthTokenCookieless' || authType === 'TrustedAuthToken';
  const auth = project.auth as Record<string, any> | undefined;
  const getAuthTokenLines = (() => {
    if (!tokenAuth) return [];
    if (auth?.tokenSource === 'proxy') {
      const proxyUrl = tokenProxyUrl ?? '/api/projects/<projectId>/token';
      return [
        `  // Must return a valid token for the embed user. This site's token proxy`,
        `  // mints one server-side, so no credential lives in this code.`,
        `  getAuthToken: () => fetch(${JSON.stringify(proxyUrl)}).then((r) => r.json()).then((b) => b.token),`,
      ];
    }
    if (auth?.tokenSource === 'credentials') {
      // Placeholders, never the stored credential: this code is served publicly at
      // /p/<id>/ through the ‹/› overlay, and nobody should paste a real password
      // out of a snippet anyway.
      const secretKey = auth.secretType === 'secret_key' ? 'secret_key' : 'password';
      const mintBody: Record<string, unknown> = {
        username: '<your username>',
        [secretKey]: `<your ${secretKey === 'secret_key' ? 'secret key' : 'password'}>`,
        validity_time_in_sec: auth.validitySeconds ?? 300,
        ...(auth.objectId ? { object_id: auth.objectId } : {}),
      };
      const mintUrl = host.replace(/\/+$/, '') +
        (auth.objectId ? '/api/rest/2.0/auth/token/object' : '/api/rest/2.0/auth/token/full');
      return [
        `  // Must return a valid token for the embed user. Fill in your own credentials`,
        `  // — better, mint server-side so they never reach the browser.`,
        `  getAuthToken: () =>`,
        `    fetch(${JSON.stringify(mintUrl)}, {`,
        `      method: "POST",`,
        `      headers: { "content-type": "application/json" },`,
        `      body: JSON.stringify(${JSON.stringify(mintBody)}),`,
        `    }).then((r) => r.json()).then((b) => b.token),`,
      ];
    }
    if (auth?.tokenSource === 'endpoint') {
      const opts = auth.tokenMethod && auth.tokenMethod !== 'GET'
        ? `, { method: ${JSON.stringify(auth.tokenMethod)} }`
        : '';
      const read = auth.tokenField
        ? `.then((r) => r.json()).then((b) => b.${auth.tokenField})`
        : `.then((r) => r.text())`;
      return [
        `  // Must return a valid token for the embed user.`,
        `  getAuthToken: () => fetch(${JSON.stringify(auth.tokenEndpoint)}${opts})${read},`,
      ];
    }
    return [
      `  // Must return a valid token for the embed user.`,
      `  getAuthToken: () => fetch("/your-token-endpoint").then((r) => r.text()),`,
    ];
  })();
  const initLines = [
    `init({`,
    `  thoughtSpotHost: ${JSON.stringify(host)},`,
    `  authType: AuthType.${authType},`,
    ...getAuthTokenLines,
    `});`,
  ];

  const lines: string[] = [];

  // ---- one embed per block ----
  // Buttons address embeds by name or page index; generated variables must resolve the
  // same way, and a PreRender block is never a button's target by default.
  const visible = embeds.filter((e) => !e.preRender);
  const varOf = new Map<number, string>();
  {
    let pre = 0, vis = 0;
    embeds.forEach((spec, i) => {
      if (spec.preRender) {
        varOf.set(i, embeds.filter((e) => e.preRender).length === 1 ? 'preRenderEmbed' : `preRenderEmbed${++pre}`);
      } else {
        varOf.set(i, visible.length === 1 ? 'embed' : `embed${++vis}`);
      }
    });
  }
  const varForTarget = (tgt: unknown): string | null => {
    if (typeof tgt === 'number') return varOf.get(tgt) ?? null;
    const idx = embeds.findIndex((e) => e.name === tgt);
    return idx >= 0 ? varOf.get(idx)! : null;
  };
  const firstVisibleVar = varOf.get(embeds.findIndex((e) => !e.preRender)) ?? 'embed';

  // Value blocks give set-actions a real element to write into: <span id="out-…">.
  const valueOuts = new Map<string, { id: string; placeholder: string }>();
  walk(page.blocks, (b) => {
    if (b.type === 'value') {
      valueOuts.set(b.key, { id: `out-${varName(b.key)}`, placeholder: b.placeholder ?? '—' });
    }
  });

  /**
   * A re-apply inside an event handler must be conditional, or rebuilding the embed makes
   * the app re-issue the intercepted call and the page loops. `when` names the state that
   * has to be true.
   */
  const guardReapply = (when: unknown, body: string): string => {
    if (typeof when !== 'string' || !when) return body;
    const state = varName(when.split('.')[0]);
    return [
      `// Guarded: re-applying unconditionally would make the app re-issue the call this`,
      `// handler watches, and the page would loop.`,
      `if (${state}) {`,
      ...body.split('\n').map((l) => `  ${l}`),
      `}`,
    ].join('\n');
  };

  // Where a run-code result lands: the value block's span, like a set action.
  const sinkStmt = (storeKey: unknown, expr: string): string | null => {
    if (typeof storeKey !== 'string' || !storeKey) return null;
    const sel = JSON.stringify(`#${valueOuts.get(storeKey)?.id ?? `out-${varName(storeKey)}`}`);
    return `document.querySelector(${sel}).textContent = JSON.stringify(${expr});`;
  };

  // One translation for button clicks and embed events; `inHandler` is the set
  // semantic split (button set = literal given, handler set = payload path or literal).
  // A run-code action is emitted as `await <fn>(payload)` — the caller names the
  // function (codeFnLines) and makes its callback async.
  const actionStmt = (a: { type: string; params: Record<string, any> }, selfVar: string, inHandler: boolean, codeFn?: string): string | null => {
    const p = a.params ?? {};
    switch (a.type) {
      case 'run-code': {
        const call = `await ${codeFn ?? 'runCode'}(${inHandler ? "payload" : "{}"})`;
        const sink = sinkStmt(p.store, 'result');
        return sink ? `const result = ${call};\n${sink}` : `${call};`;
      }
      case 'set': {
        const sel = JSON.stringify(`#${valueOuts.get(String(p.key))?.id ?? `out-${varName(String(p.key))}`}`);
        let value: string;
        if (!inHandler) {
          value = typeof p.value === 'string' ? JSON.stringify(p.value) : `JSON.stringify(${JSON.stringify(p.value ?? '')})`;
        } else if ('literal' in p) {
          value = typeof p.literal === 'string' ? JSON.stringify(p.literal) : `JSON.stringify(${JSON.stringify(p.literal)})`;
        } else {
          value = p.value ? `payload.${p.value}` : 'JSON.stringify(payload)';
        }
        return `document.querySelector(${sel}).textContent = ${value};`;
      }
      case 'HostEvent': {
        if (!hasEmbeds) return null;
        const targets = Array.isArray(p.targets) ? p.targets : [];
        const target = (targets.length ? varForTarget(targets[0]) : null) ?? selfVar;
        const payload = p.payload === undefined ? '' : `, ${literalReads(p.payload, 2)}`;
        // A store key means the event ANSWERS (GetFilters…); land it in its span.
        const sink = p.store
          ? `.then((r) => { document.querySelector(${JSON.stringify(`#${valueOuts.get(String(p.store))?.id ?? `out-${varName(String(p.store))}`}`)}).textContent = JSON.stringify(r); })`
          : '';
        return `${target}.trigger(HostEvent.${p.type}${payload})${sink};`;
      }
      case 'remount': {
        if (!hasEmbeds) return null;
        const targets = Array.isArray(p.targets) ? p.targets : [];
        const idx = targets.length
          ? (typeof targets[0] === 'number' ? targets[0] : embeds.findIndex((e) => e.name === targets[0]))
          : embeds.findIndex((e) => !e.preRender);
        const i = idx >= 0 ? idx : 0;
        const target = varOf.get(i) ?? selfVar;
        const rebuilds = (embeds[i].beforeRender as AnyAction[] | undefined)?.length;
        // The SDK has no re-render, so a fresh instance in the same container is the way.
        // With a beforeRender hook the config is rebuilt first, as the sandbox does.
        const rebuild = rebuilds
          ? `${target}.destroy();\n${target}Live = await ${target}BuildConfig();\n${target} = new ${CLASS_FOR[embeds[i].type]}(${JSON.stringify(`#${target}`)}, ${target}Live);\n${target}.render();`
          : `${target}.destroy();\n${target} = new ${CLASS_FOR[embeds[i].type]}(${JSON.stringify(`#${target}`)}, ${target}Config);\n${target}.render();`;
        return guardReapply(p.when, rebuild);
      }
      case 'update-embed': {
        if (!hasEmbeds) return null;
        const targets = Array.isArray(p.targets) ? p.targets : [];
        const idx = targets.length
          ? (typeof targets[0] === 'number' ? targets[0] : embeds.findIndex((e) => e.name === targets[0]))
          : embeds.findIndex((e) => !e.preRender);
        const i = idx >= 0 ? idx : 0;
        const target = varOf.get(i) ?? selfVar;
        const rebuilds = (embeds[i].beforeRender as AnyAction[] | undefined)?.length;
        return guardReapply(p.when, [
          `// UpdateEmbedParams and these two members are NOT public SDK API.`,
          ...(rebuilds ? [`Object.assign(${target}.viewConfig, await ${target}BuildConfig());`] : []),
          `${target}.trigger(HostEvent.UpdateEmbedParams, await ${target}.getUpdateEmbedParamsObject());`,
        ].join('\n'));
      }
      case 'nav': return `location.href = ${JSON.stringify(p.to)};`;
      case 'open-url': return `window.open(${JSON.stringify(p.url)}, ${JSON.stringify(p.target || '_blank')});`;
      default: return null; // modals are this runtime's own furniture
    }
  };

  // The site-wide defaults once, not per instance — the theme blob would otherwise
  // repeat for every embed and bury the two lines that matter.
  if (!hasEmbeds) {
    lines.push(`// ${path} has no embed block yet — nothing here for the SDK to do.`);
    lines.push(`// Add an embed block and its constructor code appears in this spot.`);
    if (hostEventButtons.length) {
      lines.push(`// (This page has HostEvent buttons, but no embed for them to drive.)`);
    }
    lines.push('');
  }

  const sharedDefaults = project.embedDefaults ?? {};
  const hasSharedDefaults = Object.keys(sharedDefaults).length > 0 && hasEmbeds;
  if (hasSharedDefaults) {
    lines.push(`// Applied to every embed on the site — theme and customisations.`);
    lines.push(`const embedDefaults = ${literal(sharedDefaults, 0)};`);
    lines.push('');
  }

  // What every custom-code function sees besides its payload; the sandbox fills
  // `variables` from its value store, your app fills it from wherever state lives.
  const takenFnNames = new Set<string>();
  /**
   * A remount rebuilds an instance, so its variable cannot be `const` and its config has
   * to be a named object rather than an inline literal.
   */
  const remountTargets = new Set<number>();
  {
    const collect = (actions: AnyAction[] | undefined, selfIdx: number) => {
      for (const a of actions ?? []) {
        if (a.type !== 'remount') continue;
        const list = Array.isArray(a.params?.targets) ? a.params.targets : [];
        if (!list.length) { remountTargets.add(selfIdx); continue; }
        for (const t of list) {
          if (t === 'all') embeds.forEach((_, i) => remountTargets.add(i));
          else if (typeof t === 'number') remountTargets.add(t);
          else {
            const i = embeds.findIndex((e) => e.name === t);
            if (i >= 0) remountTargets.add(i);
          }
        }
      }
    };
    const firstVisibleIdx = Math.max(0, embeds.findIndex((e) => !e.preRender));
    embeds.forEach((e, i) => {
      for (const h of e.embedEventHandlers ?? []) collect(h.actions as AnyAction[], i);
    });
    for (const b of buttons) collect(b.actions as AnyAction[], firstVisibleIdx);
  }
  const apiBase = (tokenProxyUrl ?? '').replace(/\/token$/, '');
  const declared = Object.entries(project.variables ?? {})
    .filter(([, spec]) => spec?.default !== undefined);
  // One store: config.variables seeds it, every {{token}} and every code block reads it
  // back. Swap the Map for your own state and the reads below still hold.
  const storeLines = [
    `const appVariables = new Map();`,
    `function getVariable(key) {`,
    `  const [head, ...rest] = String(key).split('.');`,
    `  return rest.reduce((v, k) => (v == null ? v : v[k]), appVariables.get(head));`,
    `}`,
    `function setVariable(key, value) {`,
    `  appVariables.set(key, value);`,
    `  return value;`,
    `}`,
    ...(declared.length
      ? ['',
         `// config.variables — the store's starting values.`,
         ...declared.map(([key, spec]) => `setVariable(${JSON.stringify(key)}, ${JSON.stringify(spec!.default)});`)]
      : []),
  ];
  const contextLines = [
    `const context = {`,
    `  path: ${JSON.stringify(path)},`,
    `  project: { thoughtSpotHost: ${JSON.stringify(host)}, sdkVersion: ${JSON.stringify(version)} },`,
    ...(apiBase
      ? [`  tokenUrl: ${JSON.stringify(`${apiBase}/token`)},`,
         `  clusterUrl: ${JSON.stringify(`${apiBase}/cluster`)},`]
      : []),
    `};`,
  ];
  const codeContextLines = usesCode ? [...contextLines, '', ...storeLines] : storeLines;
  if (usesCode || usesVars) {
    lines.push(...codeContextLines);
    lines.push('');
  }

  // Emits a hook's actions as one awaited block over a payload the caller shapes.
  // Run-code functions are defined just above the block that awaits them.
  const hookBlock = (
    actions: AnyAction[] | undefined,
    fnBase: string,
    payloadExpr: string,
    selfVar: string,
    onCodeResult?: (resultVar: string) => string,
  ): string[] => {
    const out: string[] = [];
    let n = 0;
    const stmts: string[] = [];
    for (const a of actions ?? []) {
      if (a.type === 'run-code') {
        n += 1;
        const fn = fnNameFor(a.params, takenFnNames, codeName(fnBase, '', n));
        out.push(...codeFnLines(fn, String(a.params?.code ?? '')));
        const resultVar = n > 1 ? `result${n}` : 'result';
        stmts.push(`const ${resultVar} = await ${fn}(payload);`);
        const sink = sinkStmt(a.params?.store, resultVar);
        if (sink) stmts.push(sink);
        if (onCodeResult) stmts.push(onCodeResult(resultVar));
      } else {
        const st = actionStmt(a, selfVar, true);
        if (st) stmts.push(st);
      }
    }
    if (!stmts.length) return out;
    out.push(`await (async (payload) => {`);
    stmts.forEach((st) => st.split('\n').forEach((l) => out.push(`  ${l}`)));
    out.push(`})(${payloadExpr});`);
    out.push('');
    return out;
  };

  if (page.beforeLoad?.length) {
    lines.push(`// Runs before the page renders.`);
    lines.push(...hookBlock(page.beforeLoad as AnyAction[], 'beforeLoad', `{ path: ${JSON.stringify(path)} }`, firstVisibleVar));
  }

  embeds.forEach((spec, i) => {
    const varName = varOf.get(i)!;
    const cls = CLASS_FOR[spec.type];
    // The container carries the variable's name, so the HTML and the JS read as one.
    const container = `#${varName}`;
    const cfg = embedConfigFor(spec, project, null, true);

    if (spec.type === 'viz' && !cfg.vizId) {
      lines.push(`// NOTE: type "viz" needs a vizId alongside liveboardId.`);
    }
    if (spec.preRender) {
      lines.push(`// A separate instance for the background copy — never reuse the visible one.`);
    }
    const cfgLines = literalReads(cfg, 0).split('\n');
    const spread = hasSharedDefaults ? '  ...embedDefaults,' : null;
    const hooks = spec.beforeRender as AnyAction[] | undefined;
    const rebuildable = remountTargets.has(i);
    const decl = rebuildable ? 'let' : 'const';
    if (hooks?.length || rebuildable) {
      // The config is a named object so beforeRender code can amend it before the
      // constructor sees it: whatever the code returns is merged in (shallow here —
      // deep-merge yourself if it returns nested customizations).
      const cfgVar = `${varName}Config`;
      if (cfgLines.length === 1) {
        lines.push(`const ${cfgVar} = ${spread ? `{ ...embedDefaults, ...${cfgLines[0]} };` : `${cfgLines[0]};`}`);
      } else {
        lines.push(`const ${cfgVar} = {`);
        if (spread) lines.push(spread);
        lines.push(...cfgLines.slice(1, -1));
        lines.push(`};`);
      }
      if (hooks?.length && rebuildable) {
        // Called again on every remount, so the hook decides the config afresh.
        const build = `${varName}BuildConfig`;
        const hookLines = hookBlock(
          hooks,
          codeName(varName, 'beforeRender'),
          `{ config: next, type: ${JSON.stringify(spec.type)}, name: ${JSON.stringify(spec.name ?? null)}, path: ${JSON.stringify(path)} }`,
          varName,
          (r) => `if (${r} && typeof ${r} === 'object') Object.assign(next, ${r});`,
        );
        // The function declarations the hook emitted stay at this level; only the awaited
        // block belongs inside the builder.
        const awaitedAt = hookLines.findIndex((l) => l.startsWith('await (async (payload)'));
        lines.push(...hookLines.slice(0, awaitedAt));
        lines.push(`async function ${build}() {`);
        lines.push(`  const next = { ...${cfgVar} };`);
        lines.push(...hookLines.slice(awaitedAt).filter((l) => l !== '').map((l) => `  ${l}`));
        lines.push(`  return next;`);
        lines.push(`}`);
        lines.push(`${decl} ${varName}Live = await ${build}();`);
        lines.push(`${decl} ${varName} = new ${cls}(${JSON.stringify(container)}, ${varName}Live);`);
      } else {
        if (hooks?.length) {
          lines.push(`// Amends the config before the constructor sees it.`);
          lines.push(...hookBlock(
            hooks,
            codeName(varName, 'beforeRender'),
            `{ config: ${cfgVar}, type: ${JSON.stringify(spec.type)}, name: ${JSON.stringify(spec.name ?? null)}, path: ${JSON.stringify(path)} }`,
            varName,
            (r) => `if (${r} && typeof ${r} === 'object') Object.assign(${cfgVar}, ${r});`,
          ));
        }
        lines.push(`${decl} ${varName} = new ${cls}(${JSON.stringify(container)}, ${cfgVar});`);
      }
    } else if (cfgLines.length === 1) {
      lines.push(`const ${varName} = new ${cls}(${JSON.stringify(container)}, ` +
        (spread ? `{ ...embedDefaults, ...${cfgLines[0]} });` : `${cfgLines[0]});`));
    } else {
      lines.push(`const ${varName} = new ${cls}(${JSON.stringify(container)}, {`);
      if (spread) lines.push(spread);
      lines.push(...cfgLines.slice(1, -1));
      lines.push(`});`);
    }
    lines.push('');

    // Handlers go on before render(), so no early event is missed.
    for (const h of spec.embedEventHandlers ?? []) {
      const fnBase = codeName(varName, `on${h.type}`);
      let n = 0;
      const stmts: string[] = [];
      for (const a of h.actions ?? []) {
        if (a.type === 'run-code') {
          n += 1;
          const fn = fnNameFor(a.params as any, takenFnNames, codeName(fnBase, 'code', n));
          lines.push(...codeFnLines(fn, String((a.params as any)?.code ?? '')));
          const st = actionStmt(a as any, varName, true, fn);
          if (st) stmts.push(st);
        } else {
          const st = actionStmt(a as any, varName, true);
          if (st) stmts.push(st);
        }
      }
      const respond = h.respond as AnyAction | undefined;
      // The reply goes first: an action here may tear down the frame the reply is owed to.
      const replyFirst: string[] = [];
      if (respond?.type === 'run-code') {
        const fn = fnNameFor(respond.params, takenFnNames, codeName(fnBase, 'respond'));
        lines.push(`// ${h.type} answers through a responder.`);
        lines.push(...codeFnLines(fn, String(respond.params?.code ?? '')));
        const fallback = respond.params && 'fallback' in respond.params
          ? [`try {`, `  responder(await ${fn}(payload));`, `} catch (err) {`,
             `  console.error(${JSON.stringify(`${h.type} respond code failed`)}, err);`,
             `  responder(${literal(respond.params.fallback, 2)});`, `}`]
          : [`responder(await ${fn}(payload));`];
        replyFirst.push(fallback.join('\n'));
      }
      stmts.unshift(...replyFirst);
      if (!stmts.length) continue;
      const isAsync = n > 0 || !!respond;
      const params = respond ? '(payload, responder)' : '(payload)';
      if (subscribedBase(h.type)) {
        lines.push(`// Fires once the app has subscribed to HostEvent.${subscribedBase(h.type)} —`);
        lines.push(`// the race-free moment to trigger it. Same as ${varName}.subscribedEvent(HostEvent...).`);
      }
      lines.push(`${varName}.on(${eventExpr(h.type)}, ${isAsync ? 'async ' : ''}${params} => {`);
      if (h.id !== undefined) lines.push(`  if (payload?.data?.id !== ${JSON.stringify(h.id)}) return;`);
      stmts.forEach((s) => s.split('\n').forEach((l) => lines.push(`  ${l}`)));
      lines.push(`});`);
      lines.push('');
    }

    if (spec.preRender) {
      // The background instance. It renders nothing — its only job is loading the
      // iframe up front so the embed that shares its preRenderId paints instantly.
      lines.push(`${varName}.preRender();`);
    } else if (cfg.preRenderId) {
      // A connecting embed: showPreRender() attaches to the shared pre-rendered iframe
      // by id and reveals it. render() does not do this under the hood.
      lines.push(`${varName}.showPreRender();`);
    } else {
      lines.push(`${varName}.render();`);
    }
    lines.push('');
  });

  // ---- buttons ----
  {
    const wired: string[] = [];
    buttons.forEach((btn, i) => {
      let n = 0;
      const stmts = (btn.actions ?? [])
        .map((a) => {
          if (a.type === 'run-code') {
            n += 1;
            const fn = fnNameFor(a.params as any, takenFnNames, codeName(`button${i + 1}`, 'code', n));
            wired.push(...codeFnLines(fn, String((a.params as any)?.code ?? '')));
            return actionStmt(a as any, firstVisibleVar, false, fn);
          }
          return actionStmt(a as any, firstVisibleVar, false);
        })
        .filter(Boolean) as string[];
      if (!stmts.length) return;
      const asyncMark = n > 0 ? 'async ' : '';
      wired.push(`document.querySelector('#btn-${i + 1}') // ${JSON.stringify(btn.label)}`);
      if (stmts.length === 1 && !stmts[0].includes('\n')) {
        wired.push(`  .addEventListener('click', ${asyncMark}() => ${stmts[0].replace(/;$/, '')});`);
      } else {
        wired.push(`  .addEventListener('click', ${asyncMark}() => {`);
        stmts.forEach((s) => s.split('\n').forEach((l) => wired.push(`    ${l}`)));
        wired.push(`  });`);
      }
    });
    if (wired.length) {
      if (needsHostEvent) lines.push(`// Host events act on embed index 0 unless the action sets "targets".`);
      lines.push(...wired, '');
    }
  }

  const pageBody = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  const initBody = initLines.join('\n');

  // The standalone page is the whole app, so it always carries its own init. A classic
  // <script> has no top-level await, so custom code puts the page body in an async IIFE.
  const body = usesCode
    ? `${initBody}\n\n(async () => {\n${pageBody.split('\n').map((l) => (l.length ? '  ' + l : l)).join('\n')}\n})();`
    : `${initBody}\n\n${pageBody}`;

  if (flavor === 'react') {
    // The imperative pass above already ran and registered every function name; its
    // output is discarded for this flavour, so the registry starts clean here or each
    // name collides with itself and gets a "2" suffix.
    takenFnNames.clear();
    const pkg = '@thoughtspot/visual-embed-sdk/react';
    // The React wrappers take the same config as props, and useEmbedRef gives the
    // trigger() a button needs — so a page is a component, not a pile of imperative
    // constructor calls.
    const comps = [...new Set(visible.map((e) => CLASS_FOR[e.type]))];
    // A composed event name — "<HostEvent> Subscribed" — has no on<Event> prop, because
    // the name only exists at runtime. Those handlers are registered on the embed's ref
    // in an effect, which means the embed needs a ref whether or not a button wants one.
    const refWiredHandlers = visible.some((e) => (e.embedEventHandlers ?? []).some(
      (h) => subscribedBase(h.type) && ((h.actions ?? []).length > 0 || h.respond),
    ));
    const needsRef = needsHostEvent || refWiredHandlers;
    const refHandlers: Array<{ ref: string; type: string; body: string }> = [];
    const reactImports = [...comps, ...(needsRef ? ['useEmbedRef'] : [])];
    const preRenderImports = [...new Set(
      embeds.filter((e) => e.preRender).map((e) => `PreRendered${CLASS_FOR[e.type]}`),
    )];

    // Which embed a button drives is the point of `targets`; sending everything to the
    // first one would be a snippet that quietly does the wrong thing.
    const refFor = (i: number) => (visible.length === 1 ? 'embedRef' : `embedRef${i + 1}`);
    const refsForTargets = (targets: unknown): string[] => {
      const list = Array.isArray(targets) ? targets : targets === undefined ? [] : [targets];
      if (!list.length) return [refFor(0)];
      if (list.includes('all')) return visible.map((_, i) => refFor(i));
      return list
        .map((tgt) => {
          const idx = typeof tgt === 'number'
            ? visible.indexOf(embeds[tgt])
            : visible.findIndex((e) => e.name === tgt);
          return idx >= 0 ? refFor(idx) : null;
        })
        .filter(Boolean) as string[];
    };

    // EVERY action, not just host events: a button that navigates still needs its
    // handler, and emitting an onClick that points at nothing would not compile.
    let usesNav = false;
    let usesModalState = false;
    let usesRemount = false;
    // Custom code becomes named async functions above the component; hooks become
    // effects inside it. Collected while the JSX is walked, emitted once below.
    const codeDefs: string[] = [];
    const effectLines: string[] = [];
    const hookStateLines: string[] = [];
    let codeSeq = 0;
    const setterOf = (key: unknown) => `set${varName(String(key)).replace(/^./, (c) => c.toUpperCase())}`;
    const defineCode = (base: string, params: Record<string, any> | undefined, hint: string): string => {
      const fn = fnNameFor(params, takenFnNames, codeName(base, hint, ++codeSeq));
      codeDefs.push(...codeFnLines(fn, String(params?.code ?? '')), '');
      return fn;
    };
    const statementFor = (a: { type: string; params: Record<string, unknown> }): string | null => {
      const pr = a.params;
      switch (a.type) {
        case 'run-code': {
          const fn = defineCode('button', pr, 'code');
          const call = `await ${fn}({})`;
          return pr.store ? `${setterOf(pr.store)}(${call});` : `${call};`;
        }
        case 'HostEvent': {
          if (!visible.length) {
            return `console.warn('HostEvent.${pr.type} needs an embed block on this page');`;
          }
          const payload = pr.payload === undefined ? '' : `, ${literalReads(pr.payload, 4)}`;
          const targets = refsForTargets(pr.targets);
          // A store key means the event ANSWERS (GetFilters, GetParameters…): the
          // response lands in the matching state, or it is invisible.
          const sink = pr.store
            ? `.then(set${varName(String(pr.store)).replace(/^./, (c) => c.toUpperCase())})`
            : '';
          return targets.length === 1
            ? `${targets[0]}.current.trigger(HostEvent.${pr.type}${payload})${sink};`
            : `[${targets.join(', ')}].forEach((e) => e.current.trigger(HostEvent.${pr.type}${payload}));`;
        }
        case 'remount':
          usesRemount = true;
          return `setEmbedKey((n) => n + 1); // remount: React rebuilds the embed`;
        case 'nav':
          usesNav = true;
          return `goTo(${JSON.stringify(pr.to)});`;
        case 'set':
          return `set${varName(String(pr.key)).replace(/^./, (c) => c.toUpperCase())}(${literal(pr.value ?? '', 4)});`;
        case 'open-url':
          return `window.open(${JSON.stringify(pr.url)}, ${JSON.stringify(pr.target || '_blank')});`;
        case 'open-modal':
          usesModalState = true;
          return `setModal(${JSON.stringify(pr.name)});`;
        case 'close-modal':
          usesModalState = true;
          return `setModal(null);`;
        default:
          return null;
      }
    };


    // An embed's event handlers become on<Event> props — the state the page declares
    // is dead weight unless something actually sets it.
    const eventProps = (spec: EmbedSpec, pad: string, ref = 'embedRef'): string[] => {
      const out: string[] = [];
      for (const h of spec.embedEventHandlers ?? []) {
        const stmts: string[] = [];
        let isAsync = false;
        for (const a of h.actions ?? []) {
          const pr = a.params as Record<string, any>;
          if (a.type === 'set') {
            const setter = `set${varName(String(pr.key)).replace(/^./, (c) => c.toUpperCase())}`;
            const arg = 'literal' in pr
              ? literal(pr.literal, 0)
              : pr.value ? `payload.${pr.value}` : 'payload';
            stmts.push(`${setter}(${arg})`);
          } else if (a.type === 'run-code') {
            isAsync = true;
            const fn = defineCode(`on${h.type}`, pr, 'code');
            stmts.push(pr.store ? `${setterOf(pr.store)}(await ${fn}(payload))` : `await ${fn}(payload)`);
          } else {
            const s = statementFor(a as any);
            if (s) stmts.push(s.replace(/;$/, ''));
          }
        }
        const respond = h.respond as AnyAction | undefined;
        if (respond?.type === 'run-code') {
          isAsync = true;
          const fn = defineCode(`on${h.type}`, respond.params, 'respond');
          stmts.push(`responder(await ${fn}(payload))`);
        }
        if (!stmts.length) continue;
        const guard = h.id !== undefined ? `payload?.data?.id === ${JSON.stringify(h.id)} && ` : '';
        const params = respond ? '(payload, responder)' : '(payload)';
        const prefix = isAsync ? 'async ' : '';
        const body = stmts.length === 1 && !h.id
          ? `${prefix}${params} => ${stmts[0]}`
          : `${prefix}${params} => { ${guard ? `if (!(${guard.slice(0, -4)})) return; ` : ''}${stmts.join('; ')}; }`;
        if (subscribedBase(h.type)) {
          // No prop exists for the composed name, so this one is wired on the ref below.
          refHandlers.push({ ref, type: h.type, body });
          continue;
        }
        out.push(`${pad}on${h.type}={${body}}`);
      }
      return out;
    };

    // The whole page, not just its embeds. Chrome and blocks the SDK does not own
    // become placeholders named for what they are, so the shape is obvious and the
    // reader knows exactly which parts are theirs to write.
    let embedSeen = 0;
    const usedPreRender = new Set<string>();
    // A label becomes a handler name by capitalising its words, not by deleting the
    // spaces between them: "Ask the embed: GetFilters" is onAskTheEmbedGetFilters, not
    // onAsktheembedGetFilters. Long labels stop at four words — the name identifies the
    // button, it does not have to quote it.
    const btnName = (label: string, i: number) => {
      const words = (label || '').split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 4);
      const camel = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
      return `on${camel || `Btn${i + 1}`}`;
    };

    const jsxFor = (blocks: Block[] | undefined, pad: string): string[] => {
      const out: string[] = [];
      for (const block of blocks ?? []) {
        switch (block.type) {
          case 'heading':
            out.push(`${pad}<h${block.level || 2}>${escapeJsx(block.text)}</h${block.level || 2}>`);
            break;
          case 'text':
            out.push(...textJsx(block.text, pad));
            break;
          case 'divider':
            out.push(`${pad}<hr />`);
            break;
          case 'spacer':
            out.push(`${pad}<div style={{ height: ${JSON.stringify(block.size || '24px')} }} />`);
            break;
          case 'value':
            out.push(`${pad}<YourStat label={${JSON.stringify(block.label || block.key)}} value={${varName(block.key)}} />`);
            break;
          case 'buttons': {
            out.push(`${pad}<div className="buttons">`);
            (block.items ?? []).forEach((item, i) => {
              const runnable = (item.actions ?? []).some((a) =>
                ['HostEvent', 'nav', 'set', 'open-url', 'open-modal', 'close-modal'].includes(a.type));
              const handler = runnable ? ` onClick={${btnName(item.label, i)}}` : '';
              out.push(`${pad}  <button${handler}>${escapeJsx(item.label || 'Button')}</button>`);
            });
            out.push(`${pad}</div>`);
            break;
          }
          case 'row': {
            const cols = (block.columns ?? []).map((c) => `${c.span || 1}fr`).join(' ');
            out.push(`${pad}<div style={{ display: 'grid', gridTemplateColumns: ${JSON.stringify(cols)}, gap: 16 }}>`);
            for (const col of block.columns ?? []) {
              out.push(`${pad}  <div>`);
              out.push(...jsxFor(col.blocks, `${pad}    `));
              out.push(`${pad}  </div>`);
            }
            out.push(`${pad}</div>`);
            break;
          }
          case 'embed': {
            const spec = block.embed;
            const cls = CLASS_FOR[spec.type];
            const cfg = embedConfigFor(spec, project, null, true) as Record<string, unknown>;
            // A PreRendered<X>Embed is emitted once, above the page body. Emitting a
            // visible embed for it too would put content on the page the author never
            // asked for.
            if (spec.preRender) {
              usedPreRender.add(`PreRendered${cls}`);
              break;
            }
            // Everything else keeps its preRenderId — that id is how the SDK attaches
            // this embed to the pre-rendered one.
            const ref = visible.length === 1 ? 'embedRef' : `embedRef${embedSeen + 1}`;
            embedSeen += 1;
            const hooks = spec.beforeRender as AnyAction[] | undefined;
            if (hooks?.some((a) => a.type === 'run-code')) {
              // beforeRender: the config is state, filled by the code before the embed
              // mounts — so the component renders nothing for it until the code answers.
              const cfgVar = `${ref}Config`;
              const baseVar = `${ref}BaseConfig`;
              codeDefs.push(`const ${baseVar} = ${literalReads(cfg, 0)};`, '');
              const steps: string[] = [];
              for (const a of hooks) {
                if (a.type !== 'run-code') continue;
                const fn = defineCode(ref, a.params, 'beforeRender');
                steps.push(`      const patch = await ${fn}({ config: next, type: ${JSON.stringify(spec.type)}, name: ${JSON.stringify(spec.name ?? null)}, path: ${JSON.stringify(path)} });`);
                if (a.params?.store) steps.push(`      ${setterOf(a.params.store)}(patch);`);
                steps.push(`      if (patch && typeof patch === 'object') next = { ...next, ...patch };`);
              }
              hookStateLines.push(`  const [${cfgVar}, ${setterOf(cfgVar)}] = useState(null);`);
              effectLines.push(
                `  useEffect(() => {`,
                `    (async () => {`,
                `      let next = { ...${baseVar} };`,
                ...steps,
                `      ${setterOf(cfgVar)}(next);`,
                `    })();`,
                `  }, []);`,
              );
              out.push(`${pad}{${cfgVar} && (`);
              out.push(`${pad}  <${cls}`);
              if (needsRef) out.push(`${pad}    ref={${ref}}`);
              if (Object.keys(project.embedDefaults ?? {}).length) out.push(`${pad}    {...embedDefaults}`);
              out.push(`${pad}    {...${cfgVar}}`);
              out.push(...eventProps(spec, `${pad}    `, ref));
              out.push(`${pad}  />`);
              out.push(`${pad})}`);
              break;
            }
            out.push(`${pad}<${cls}`);
            if (needsRef) out.push(`${pad}  ref={${ref}}`);
            if (Object.keys(project.embedDefaults ?? {}).length) out.push(`${pad}  {...embedDefaults}`);
            for (const [k, v] of Object.entries(cfg)) out.push(...jsxProp(`${pad}  `, k, v));
            out.push(...eventProps(spec, `${pad}  `, ref));
            out.push(`${pad}/>`);
            break;
          }
          default:
            break;
        }
      }
      return out;
    };

    const jsxLines = jsxFor(page.blocks, '      ');

    // One PreRendered<X>Embed per preRender block, above the page body.
    const preRenderJsx: string[] = [];
    let preRenderSeen = 0;
    walk(page.blocks, (b) => {
      if (b.type !== 'embed' || !b.embed.preRender) return;
      const cls = CLASS_FOR[b.embed.type];
      const id = (b.embed.config.preRenderId as string) || preRenderIdFor(path, preRenderSeen);
      preRenderSeen += 1;
      // With a liveboardId it pre-fetches that board's data; without one it loads the
      // generic shell and the visible embed navigates it (both documented use cases).
      const lb = b.embed.config.liveboardId;
      const handlerProps = eventProps(b.embed, '        ');
      if (!lb && !handlerProps.length) {
        preRenderJsx.push(`      <PreRendered${cls} preRenderId=${JSON.stringify(id)} />`);
      } else {
        preRenderJsx.push(`      <PreRendered${cls}`);
        preRenderJsx.push(`        preRenderId=${JSON.stringify(id)}`);
        if (lb) preRenderJsx.push(`        liveboardId=${JSON.stringify(lb)}`);
        preRenderJsx.push(...handlerProps);
        preRenderJsx.push(`      />`);
      }
    });

    const handlers = buttons
      .map((btn, i) => {
        const stmts = (btn.actions ?? [])
          .map((a) => statementFor(a as any))
          .filter(Boolean) as string[];
        if (!stmts.length) return null;
        const name = btnName(btn.label, i);
        const asyncMark = stmts.some((st) => st.includes('await ')) ? 'async ' : '';
        if (stmts.length === 1) return `  const ${name} = ${asyncMark}() =>\n    ${stmts[0]}`;
        return [`  const ${name} = ${asyncMark}() => {`, ...stmts.map((s) => `    ${s}`), '  };'].join('\n');
      })
      .filter(Boolean) as string[];

    const refs = needsRef
      ? visible.map((_, i) => `  const ${visible.length === 1 ? 'embedRef' : `embedRef${i + 1}`} = useEmbedRef();`)
      : [];

    const defaults = project.embedDefaults ?? {};
    // Defaults exist to spread into embeds; a page without one has no use for them.
    const hasDefaults = Object.keys(defaults).length > 0 && hasEmbeds;
    const defaultLines = hasDefaults
      ? ['', `// Applied to every embed on the site — theme and customisations.`,
         `const embedDefaults = ${literal(defaults, 0)};`]
      : [];

    // Values are a store in the sandbox; in your app they are state. Declared where
    // the reader can see what a handler writes and what a stat displays.
    const readKeys = new Set<string>();
    const writeKeys = new Set<string>();
    const seedFor = new Map<string, string>();
    const collectState = (b: Block) => {
      if (b.type === 'value') {
        readKeys.add(b.key);
        if (b.placeholder) seedFor.set(b.key, b.placeholder);
      }
      const storeOf = (a: { type: string; params: Record<string, any> }) => {
        if (a.type === 'set' && typeof a.params?.key === 'string') writeKeys.add(a.params.key);
        if (a.type === 'run-code' && typeof a.params?.store === 'string') writeKeys.add(a.params.store);
      };
      if (b.type === 'buttons') {
        for (const item of b.items ?? []) for (const a of item.actions ?? []) storeOf(a as any);
      }
      if (b.type === 'embed') {
        for (const h of b.embed.embedEventHandlers ?? []) {
          for (const a of h.actions ?? []) storeOf(a as any);
          if (h.respond) storeOf(h.respond as any);
        }
        for (const a of b.embed.beforeRender ?? []) storeOf(a as any);
      }
    };
    for (const a of page.beforeLoad ?? []) {
      if (a.type === 'set' && typeof (a.params as any)?.key === 'string') writeKeys.add((a.params as any).key);
      if (a.type === 'run-code' && typeof (a.params as any)?.store === 'string') writeKeys.add((a.params as any).store);
    }
    walk(page.blocks, collectState);
    // Modals live in the same file, so their value blocks are page state too.
    const modalDefs: Record<string, { title?: string; blocks?: Block[] }> =
      { ...((project.modals as any) ?? {}), ...((page.modals as any) ?? {}) };
    for (const m of Object.values(modalDefs)) walk(m.blocks, collectState);
    const stateKeys = [...new Set([...readKeys, ...writeKeys])];
    const stateLines = stateKeys.map((k) =>
      `  const [${varName(k)}, set${varName(k).replace(/^./, (c) => c.toUpperCase())}] = useState(${JSON.stringify(seedFor.get(k) ?? '')});`);

    // beforeLoad: an effect on mount, awaited in order, results into state.
    const loadHooks = (page.beforeLoad ?? []) as AnyAction[];
    if (loadHooks.some((a) => a.type === 'run-code')) {
      const steps: string[] = [];
      for (const a of loadHooks) {
        if (a.type !== 'run-code') continue;
        const fn = defineCode('beforeLoad', a.params, '');
        const call = `await ${fn}({ path: ${JSON.stringify(path)} })`;
        steps.push(a.params?.store ? `      ${setterOf(a.params.store)}(${call});` : `      ${call};`);
      }
      effectLines.unshift(
        `  useEffect(() => {`,
        `    (async () => {`,
        ...steps,
        `    })();`,
        `  }, []);`,
      );
    }
    // Registered after mount, grouped per embed. The name is a string on purpose: the
    // composed "<HostEvent> Subscribed" event has no EmbedEvent member to import.
    if (refHandlers.length) {
      const byRef = new Map<string, typeof refHandlers>();
      for (const h of refHandlers) byRef.set(h.ref, [...(byRef.get(h.ref) ?? []), h]);
      for (const [ref, list] of byRef) {
        effectLines.push(
          `  useEffect(() => {`,
          `    const embed = ${ref}.current;`,
          `    if (!embed) return;`,
          ...list.flatMap(({ type, body }) => [
            `    embed.on(${JSON.stringify(type)}, ${body.replace(new RegExp(`${ref}\\.current\\??`, 'g'), 'embed')});`,
          ]),
          `  }, []);`,
        );
      }
    }

    const reactHooks = [
      ...(stateKeys.length || usesModalState || hookStateLines.length || usesRemount ? ['useState'] : []),
      ...(effectLines.length ? ['useEffect'] : []),
    ];

    const chrome = project.header?.show !== false || project.footer?.show !== false;
    // usesNav is set while building handlers, which happens below — recomputed there.
    const placeholders = [
      ...(readKeys.size ? ['YourStat'] : []),
      ...(Object.keys(modalDefs).length ? ['YourDialog'] : []),
      ...(project.header?.show !== false ? ['YourHeader'] : []),
      ...(project.footer?.show !== false ? ['YourFooter'] : []),
    ];

    const headerJsx = project.header?.show !== false
      ? [`      <YourHeader`,
         `        title=${JSON.stringify(project.header?.title ?? project.name ?? '')}`,
         ...(project.header?.nav?.length
           ? [`        nav={${literal(project.header.nav.map((n) => ({ label: n.label, to: n.to })), 8).trimStart()}}`]
           : []),
         `      />`]
      : [];
    const footerJsx = project.footer?.show !== false
      ? [`      <YourFooter text=${JSON.stringify(project.footer?.text ?? '')} />`]
      : [];

    // ---- modals: shown from one piece of page state, defined below in this file ----
    const modalComp = (name: string) =>
      `${varName(name).replace(/^./, (ch) => ch.toUpperCase())}Modal`;
    const modalNames = Object.keys(modalDefs);
    if (modalNames.length) usesModalState = true;
    const modalClasses = new Set<string>();

    const modalStmt = (a: { type: string; params: Record<string, any> }): string => {
      const pr = a.params ?? {};
      switch (a.type) {
        case 'close-modal': return 'props.onClose()';
        case 'open-modal': return `props.onClose() /* then open ${JSON.stringify(pr.name)} from page state */`;
        case 'nav': usesNav = true; return `goTo(${JSON.stringify(pr.to)})`;
        case 'open-url': return `window.open(${JSON.stringify(pr.url)}, ${JSON.stringify(pr.target || '_blank')})`;
        default: return `console.warn(${JSON.stringify(`wire ${a.type} to your modal embed`)})`;
      }
    };
    const modalJsx = (blocks: Block[] | undefined, pad: string, used: Set<string>): string[] => {
      const out: string[] = [];
      for (const block of blocks ?? []) {
        switch (block.type) {
          case 'heading':
            out.push(`${pad}<h${block.level || 2}>${escapeJsx(block.text)}</h${block.level || 2}>`);
            break;
          case 'text':
            out.push(...textJsx(block.text, pad));
            break;
          case 'divider':
            out.push(`${pad}<hr />`);
            break;
          case 'spacer':
            out.push(`${pad}<div style={{ height: ${JSON.stringify(block.size || '24px')} }} />`);
            break;
          case 'value':
            used.add(varName(block.key));
            out.push(`${pad}<YourStat label={${JSON.stringify(block.label || block.key)}} value={props.${varName(block.key)}} />`);
            break;
          case 'buttons': {
            out.push(`${pad}<div className="buttons">`);
            for (const item of block.items ?? []) {
              const stmts = (item.actions ?? []).map((a) => modalStmt(a as any));
              const onClick = stmts.length
                ? ` onClick={() => ${stmts.length === 1 ? stmts[0] : `{ ${stmts.join('; ')}; }`}}`
                : '';
              out.push(`${pad}  <button${onClick}>${escapeJsx(item.label || 'Button')}</button>`);
            }
            out.push(`${pad}</div>`);
            break;
          }
          case 'row': {
            const cols = (block.columns ?? []).map((cl) => `${cl.span || 1}fr`).join(' ');
            out.push(`${pad}<div style={{ display: 'grid', gridTemplateColumns: ${JSON.stringify(cols)}, gap: 16 }}>`);
            for (const col of block.columns ?? []) {
              out.push(`${pad}  <div>`);
              out.push(...modalJsx(col.blocks, `${pad}    `, used));
              out.push(`${pad}  </div>`);
            }
            out.push(`${pad}</div>`);
            break;
          }
          case 'embed': {
            const spec = block.embed;
            const cls = CLASS_FOR[spec.type];
            modalClasses.add(cls);
            const cfg = embedConfigFor(spec, project, null, true) as Record<string, unknown>;
            out.push(`${pad}<${cls}`);
            if (Object.keys(project.embedDefaults ?? {}).length) out.push(`${pad}  {...embedDefaults}`);
            for (const [k, v] of Object.entries(cfg)) out.push(...jsxProp(`${pad}  `, k, v));
            if (spec.embedEventHandlers?.length) {
              out.push(`${pad}  {/* embedEventHandlers: wire via on<Event> props, as on the page */}`);
            }
            out.push(`${pad}/>`);
            break;
          }
          default:
            break;
        }
      }
      return out;
    };

    const modalRenderLines: string[] = [];
    const modalComponentDefs: string[] = [];
    for (const name of modalNames) {
      const def = modalDefs[name];
      const used = new Set<string>();
      const body = modalJsx(def.blocks, '      ', used);
      const pass = [...used].map((k) => ` ${k}={${k}}`).join('');
      modalRenderLines.push(
        `      {modal === ${JSON.stringify(name)} && <${modalComp(name)} onClose={() => setModal(null)}${pass} />}`,
      );
      modalComponentDefs.push(
        '',
        `function ${modalComp(name)}(props) {`,
        `  return (`,
        `    <YourDialog title={${JSON.stringify(def.title || name)}} onClose={props.onClose}>`,
        ...body,
        `    </YourDialog>`,
        `  );`,
        `}`,
      );
    }

    return [
      `// npm install ${sdkInstallSpec(version)}`,
      ...(() => {
        const all = [...placeholders, ...(usesNav ? ['goTo'] : [])];
        return all.length
          ? ['',
             `// ${all.join(', ')} are YOURS — the SDK renders the embeds, you render the page.`,
             `// import { ${all.join(', ')} } from './components';`]
          : [];
      })(),
      ...(reactHooks.length ? [`import { ${reactHooks.join(', ')} } from 'react';`] : []),
      '',
      `// ─── once per app, at bootstrap — NOT per route ───`,
      `import { ${initImports.join(', ')} } from '@thoughtspot/visual-embed-sdk';`,
      '',
      initBody,
      '',
      `// ─── ${path} ───`,
      ...(hasEmbeds || modalClasses.size
        ? [`import { ${[...new Set([...reactImports, ...modalClasses]), ...preRenderImports].join(', ')}${needsHostEvent || handlerHostEvent ? `, HostEvent` : ''} } from '${pkg}';`]
        : [`// No embed block on this page yet — plain React. Add one and its`,
           `// component (and the matching SDK import) appears here.`]),
      '',
      ...defaultLines,
      ...(usesCode || usesVars ? ['', ...codeContextLines] : []),
      ...(codeDefs.length ? ['', ...codeDefs] : []),
      '',
      `export function ${componentName(path)}() {`,
      ...stateLines,
      ...hookStateLines,
      ...(usesModalState ? [`  const [modal, setModal] = useState(null);`] : []),
      ...(usesRemount ? [`  const [embedKey, setEmbedKey] = useState(0);`] : []),
      ...refs,
      ...(effectLines.length ? ['', ...effectLines] : []),
      ...(handlers.length ? ['', ...handlers, ''] : []),
      `  return (`,
      `    <>`,
      ...headerJsx,
      ...(usedPreRender.size
        ? [`      {/* Loads in the background, renders nothing. ${visible.length
             ? `The <${[...usedPreRender][0].replace('PreRendered', '')} /> below with the same preRenderId shows it.`
             : 'Pages that use the same preRenderId show it instantly.'} */}`,
           ...preRenderJsx]
        : []),
      `      <main>`,
      ...jsxLines.map((l) => `  ${l}`),
      `      </main>`,
      ...modalRenderLines,
      ...footerJsx,
      `    </>`,
      `  );`,
      `}`,
      ...modalComponentDefs,
      '',
    ].join('\n');
  }

  if (flavor === 'esm') {
    const pkg = '@thoughtspot/visual-embed-sdk';
    if (!includeInit) {
      return [
        `// npm install ${sdkInstallSpec(version)}`,
        `// Assumes init() has already been called once at app bootstrap.`,
        ...(hasEmbeds ? [`import { ${pageImports.join(', ')} } from '${pkg}';`] : []),
        '',
        `// ${path}`,
        pageBody,
        '',
      ].join('\n');
    }
    return [
      `// npm install ${sdkInstallSpec(version)}`,
      '',
      `// ─── once per app, at bootstrap — NOT per page ───`,
      `// init() is global. Calling it again for each page or route is redundant`,
      `// and can reset embed state, so do this where your app starts up.`,
      `import { ${initImports.join(', ')} } from '${pkg}';`,
      '',
      initBody,
      '',
      `// ─── ${path} ───`,
      ...(hasEmbeds ? [`import { ${pageImports.join(', ')} } from '${pkg}';`] : []),
      '',
      pageBody,
      '',
    ].join('\n');
  }

  // CDN flavour: a complete, standalone page — no build step, matches how this
  // sandbox itself loads the SDK.
  const containers = embeds
    .map((spec, i) => {
      const id = varOf.get(i)!;
      return spec.preRender
        ? `<div id="${id}" hidden></div> <!-- background copy: renders nothing -->`
        : `<div id="${id}"></div>`;
    })
    .join('\n  ');
  const btnHtml = buttons.length
    ? '\n  ' +
      buttons
        .map((b, i) => `<button id="btn-${i + 1}">${b.label.replace(/[<>&]/g, '')}</button>`)
        .join('\n  ')
    : '';
  const valueHtml = valueOuts.size
    ? '\n  ' +
      [...valueOuts.values()]
        .map((v) => `<span id="${v.id}">${v.placeholder.replace(/[<>&]/g, '')}</span>`)
        .join('\n  ')
    : '';

  if (!hasEmbeds) {
    // No SDK script, no init: loading a 500 KB SDK for a page with nothing to embed
    // would be code that lies about what the page needs. Custom code and button wiring
    // still belong to the page, so they are emitted — without the SDK.
    const plain = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
    const hasScript = usesCode || buttons.some((b) => (b.actions ?? []).length > 0);
    const scriptBody = usesCode
      ? `(async () => {\n${plain.split('\n').map((l) => (l.length ? '  ' + l : l)).join('\n')}\n})();`
      : plain;
    const script = hasScript
      ? `\n\n  <script>\n${scriptBody.split('\n').map((l) => (l.length ? '    ' + l : l)).join('\n')}\n  </script>`
      : '';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${(page.title || path).replace(/[<>&]/g, '')}</title>
</head>
<body>${btnHtml}${valueHtml}
  <!-- ${path} has no embed block yet, so nothing on this page needs the SDK.
       Add an embed block and this becomes a full Visual Embed SDK page. -->${script}
</body>
</html>
`;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${(page.title || path).replace(/[<>&]/g, '')}</title>
  <script src="${sdkUrl(version, origin)}"></script>
</head>
<body>${btnHtml}${valueHtml}
  ${containers}

  <script>
    const { ${imports.join(', ')} } = window.tsembed;

    // This file is the whole app, so init() lives here. In a real app it belongs
    // once at bootstrap, not per page — see the esm flavour.

${body
    .split('\n')
    .map((l) => (l.length ? '    ' + l : l))
    .join('\n')}
  </script>
</body>
</html>
`;
}

/**
 * The markup a page's JavaScript flavour targets, as real copyable HTML — shown as the
 * HTML half of the JS code view rather than buried in a comment.
 */
export function generateMarkup(page: PageConfig, path: string): string {
  const embeds = embedsIn(page);
  const buttons = buttonsIn(page);
  const visible = embeds.filter((e) => !e.preRender);
  const lines: string[] = [`<!-- the markup ${path}'s JavaScript targets -->`];
  let pre = 0;
  let vis = 0;
  embeds.forEach((spec) => {
    if (spec.preRender) {
      const id = embeds.filter((e) => e.preRender).length === 1 ? 'preRenderEmbed' : `preRenderEmbed${++pre}`;
      lines.push(`<div id="${id}" hidden></div>`);
    } else {
      const id = visible.length === 1 ? 'embed' : `embed${++vis}`;
      lines.push(`<div id="${id}"></div>`);
    }
  });
  buttons.forEach((b, i) => {
    lines.push(`<button id="btn-${i + 1}">${String(b.label || 'Button').replace(/[<>&]/g, '')}</button>`);
  });
  walk(page.blocks, (b) => {
    if (b.type === 'value') {
      lines.push(`<span id="out-${varName(b.key)}">${String(b.placeholder ?? '—').replace(/[<>&]/g, '')}</span>`);
    }
  });
  return lines.join('\n') + '\n';
}
