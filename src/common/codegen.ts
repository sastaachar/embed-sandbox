import type { Block, ButtonSpec, EmbedSpec, PageConfig, ProjectConfig } from './schema';
import { sdkUrl } from './sdkUrl';

export type Flavor = 'cdn' | 'esm' | 'react';

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
  if (typeof value === 'string') return [`${pad}${key}=${JSON.stringify(value)}`];
  const rendered = literal(value, 0).split('\n');
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

/** "data-id" is not an identifier; "dataId" is. */
function varName(key: string): string {
  return key.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^[0-9]/, (d) => `_${d}`);
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
  const needsHostEvent = hostEventButtons.length > 0 && hasEmbeds;
  const initImports = ['init', 'AuthType'];
  const pageImports = [...classes, ...(needsHostEvent ? ['HostEvent'] : [])];
  const imports = [...initImports, ...pageImports];

  // init() is global to the app, not to a page. Kept separate so the esm flavour
  // can place it at bootstrap and the per-page snippet can omit it entirely.
  // The trusted-auth types refuse to init without a getAuthToken, so the generated
  // code carries the same one the runtime builds from the declarative `auth` block.
  const tokenAuth = authType === 'TrustedAuthTokenCookieless' || authType === 'TrustedAuthToken';
  const auth = project.auth as Record<string, any> | undefined;
  const getAuthTokenLines = (() => {
    if (!tokenAuth) return [];
    if (auth?.tokenSource === 'credentials') {
      const mintBody: Record<string, unknown> = {
        username: auth.username,
        validity_time_in_sec: auth.validitySeconds ?? 300,
      };
      mintBody[auth.secretType === 'secret_key' ? 'secret_key' : 'password'] = auth.secret;
      if (auth.objectId) mintBody.object_id = auth.objectId;
      const mintUrl = host.replace(/\/+$/, '') +
        (auth.objectId ? '/api/rest/2.0/auth/token/object' : '/api/rest/2.0/auth/token/full');
      return [
        `  // Must return a valid token for the embed user.`,
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
      `  getAuthToken: () => fetch("/your-token-service").then((r) => r.text()),`,
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
    const cfgLines = literal(cfg, 0).split('\n');
    const spread = hasSharedDefaults ? '  ...embedDefaults,' : null;
    if (cfgLines.length === 1) {
      lines.push(`const ${varName} = new ${cls}(${JSON.stringify(container)}, ` +
        (spread ? `{ ...embedDefaults, ...${cfgLines[0]} });` : `${cfgLines[0]});`));
    } else {
      lines.push(`const ${varName} = new ${cls}(${JSON.stringify(container)}, {`);
      if (spread) lines.push(spread);
      lines.push(...cfgLines.slice(1, -1));
      lines.push(`});`);
    }
    lines.push('');

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

  // ---- buttons -> host events ----
  if (hostEventButtons.length && hasEmbeds) {
    lines.push(`// Buttons act on embed index 0 unless the action sets "targets".`);
    hostEventButtons.forEach((btn, i) => {
      const act = (btn.actions ?? []).find((a) => a.type === 'HostEvent');
      if (!act) return;
      const p = act.params as Record<string, unknown>;
      const targets = Array.isArray(p.targets) ? p.targets : [];
      const target = (targets.length ? varForTarget(targets[0]) : null) ?? firstVisibleVar;
      const payload = p.payload === undefined ? '' : `, ${literal(p.payload, 2)}`;
      lines.push(
        `document.querySelector('#btn-${i + 1}') // ${JSON.stringify(btn.label)}`,
      );
      lines.push(
        `  .addEventListener('click', () => ${target}.trigger(HostEvent.${p.type}${payload}));`,
      );
    });
    lines.push('');
  }

  const pageBody = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  const initBody = initLines.join('\n');
  // The standalone page is the whole app, so it always carries its own init.
  const body = `${initBody}\n\n${pageBody}`;

  if (flavor === 'react') {
    const pkg = '@thoughtspot/visual-embed-sdk/react';
    // The React wrappers take the same config as props, and useEmbedRef gives the
    // trigger() a button needs — so a page is a component, not a pile of imperative
    // constructor calls.
    const comps = [...new Set(visible.map((e) => CLASS_FOR[e.type]))];
    const reactImports = [...comps, ...(needsHostEvent ? ['useEmbedRef'] : [])];
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
    const statementFor = (a: { type: string; params: Record<string, unknown> }): string | null => {
      const pr = a.params;
      switch (a.type) {
        case 'HostEvent': {
          if (!visible.length) {
            return `console.warn('HostEvent.${pr.type} needs an embed block on this page');`;
          }
          const payload = pr.payload === undefined ? '' : `, ${literal(pr.payload, 4)}`;
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
        case 'nav':
          usesNav = true;
          return `goTo(${JSON.stringify(pr.to)});`;
        case 'set':
          return `set${varName(String(pr.key)).replace(/^./, (c) => c.toUpperCase())}(${literal(pr.value ?? '', 4)});`;
        case 'open-url':
          return `window.open(${JSON.stringify(pr.url)}, ${JSON.stringify(pr.target || '_blank')});`;
        case 'open-modal':
          return `openModal(${JSON.stringify(pr.name)});`;
        case 'close-modal':
          return `closeModal();`;
        default:
          return null;
      }
    };


    // An embed's event handlers become on<Event> props — the state the page declares
    // is dead weight unless something actually sets it.
    const eventProps = (spec: EmbedSpec, pad: string): string[] => {
      const out: string[] = [];
      for (const h of spec.embedEventHandlers ?? []) {
        const stmts: string[] = [];
        for (const a of h.actions ?? []) {
          const pr = a.params as Record<string, any>;
          if (a.type === 'set') {
            const setter = `set${varName(String(pr.key)).replace(/^./, (c) => c.toUpperCase())}`;
            const arg = 'literal' in pr
              ? literal(pr.literal, 0)
              : pr.value ? `payload.${pr.value}` : 'payload';
            stmts.push(`${setter}(${arg})`);
          } else {
            const s = statementFor(a as any);
            if (s) stmts.push(s.replace(/;$/, ''));
          }
        }
        if (!stmts.length) continue;
        const guard = h.id !== undefined ? `payload?.data?.id === ${JSON.stringify(h.id)} && ` : '';
        const body = stmts.length === 1 && !h.id
          ? `(payload) => ${stmts[0]}`
          : `(payload) => { ${guard ? `if (!(${guard.slice(0, -4)})) return; ` : ''}${stmts.join('; ')}; }`;
        out.push(`${pad}on${h.type}={${body}}`);
      }
      return out;
    };

    // The whole page, not just its embeds. Chrome and blocks the SDK does not own
    // become placeholders named for what they are, so the shape is obvious and the
    // reader knows exactly which parts are theirs to write.
    let embedSeen = 0;
    const usedPreRender = new Set<string>();
    const btnName = (label: string, i: number) =>
      `on${(label || 'Button').replace(/[^A-Za-z0-9]/g, '') || `Btn${i}`}`;

    const jsxFor = (blocks: Block[] | undefined, pad: string): string[] => {
      const out: string[] = [];
      for (const block of blocks ?? []) {
        switch (block.type) {
          case 'heading':
            out.push(`${pad}<h${block.level || 2}>${escapeJsx(block.text)}</h${block.level || 2}>`);
            break;
          case 'text':
            out.push(`${pad}<p>${escapeJsx(block.text)}</p>`);
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
            out.push(`${pad}<${cls}`);
            if (needsHostEvent) out.push(`${pad}  ref={${ref}}`);
            if (Object.keys(project.embedDefaults ?? {}).length) out.push(`${pad}  {...embedDefaults}`);
            for (const [k, v] of Object.entries(cfg)) out.push(...jsxProp(`${pad}  `, k, v));
            out.push(...eventProps(spec, `${pad}  `));
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
        if (stmts.length === 1) return `  const ${name} = () =>\n    ${stmts[0]}`;
        return [`  const ${name} = () => {`, ...stmts.map((s) => `    ${s}`), '  };'].join('\n');
      })
      .filter(Boolean) as string[];

    const refs = needsHostEvent
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
    walk(page.blocks, (b) => {
      if (b.type === 'value') {
        readKeys.add(b.key);
        if (b.placeholder) seedFor.set(b.key, b.placeholder);
      }
      if (b.type === 'buttons') {
        for (const item of b.items ?? []) {
          for (const a of item.actions ?? []) {
            if (a.type === 'set' && typeof (a.params as any).key === 'string') {
              writeKeys.add((a.params as any).key);
            }
          }
        }
      }
      if (b.type === 'embed') {
        for (const h of b.embed.embedEventHandlers ?? []) {
          for (const a of h.actions ?? []) {
            if (a.type === 'set' && typeof (a.params as any).key === 'string') {
              writeKeys.add((a.params as any).key);
            }
          }
        }
      }
    });
    const stateKeys = [...new Set([...readKeys, ...writeKeys])];
    const stateLines = stateKeys.map((k) =>
      `  const [${varName(k)}, set${varName(k).replace(/^./, (c) => c.toUpperCase())}] = useState(${JSON.stringify(seedFor.get(k) ?? '')});`);

    const chrome = project.header?.show !== false || project.footer?.show !== false;
    // usesNav is set while building handlers, which happens below — recomputed there.
    const placeholders = [
      ...(readKeys.size ? ['YourStat'] : []),
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

    return [
      `// npm install @thoughtspot/visual-embed-sdk@${version}`,
      ...(() => {
        const all = [...placeholders, ...(usesNav ? ['goTo'] : [])];
        return all.length
          ? ['',
             `// ${all.join(', ')} are YOURS — the SDK renders the embeds, you render the page.`,
             `// import { ${all.join(', ')} } from './components';`]
          : [];
      })(),
      ...(stateKeys.length ? [`import { useState } from 'react';`] : []),
      '',
      `// ─── once per app, at bootstrap — NOT per route ───`,
      `import { ${initImports.join(', ')} } from '@thoughtspot/visual-embed-sdk';`,
      '',
      initBody,
      '',
      `// ─── ${path} ───`,
      ...(hasEmbeds
        ? [`import { ${[...reactImports, ...preRenderImports].join(', ')}${needsHostEvent ? `, HostEvent` : ''} } from '${pkg}';`]
        : [`// No embed block on this page yet — plain React. Add one and its`,
           `// component (and the matching SDK import) appears here.`]),
      '',
      ...defaultLines,
      '',
      `export function ${componentName(path)}() {`,
      ...stateLines,
      ...refs,
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
      ...footerJsx,
      `    </>`,
      `  );`,
      `}`,
      '',
    ].join('\n');
  }

  if (flavor === 'esm') {
    const pkg = '@thoughtspot/visual-embed-sdk';
    if (!includeInit) {
      return [
        `// npm install ${pkg}@${version}`,
        `// Assumes init() has already been called once at app bootstrap.`,
        ...(hasEmbeds ? [`import { ${pageImports.join(', ')} } from '${pkg}';`] : []),
        '',
        `// ${path}`,
        pageBody,
        '',
      ].join('\n');
    }
    return [
      `// npm install ${pkg}@${version}`,
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

  if (!hasEmbeds) {
    // No SDK script, no init: loading a 500 KB SDK for a page with nothing to embed
    // would be code that lies about what the page needs.
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${(page.title || path).replace(/[<>&]/g, '')}</title>
</head>
<body>${btnHtml}
  <!-- ${path} has no embed block yet, so nothing on this page needs the SDK.
       Add an embed block and this becomes a full Visual Embed SDK page. -->
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
  <script src="${sdkUrl(version)}"></script>
</head>
<body>${btnHtml}
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
