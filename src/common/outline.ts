import type { Block, ButtonSpec, Chrome, EmbedAction, EmbedSpec, Modal, PageConfig, ProjectConfig } from './schema';

/**
 * A structural view of a page — Header, each embed, Footer — rather than a dump of
 * generated code. Collapsed, each node is one JSX-ish line; expanded, it shows the
 * config it was built from and the real function bodies behind its handlers.
 */
export interface OutlineNode {
  tag: string;
  summary: string;
  /** Config to show when expanded. Omitted when there is nothing worth showing. */
  props?: Record<string, unknown>;
  /** Bulky config kept behind its own collapse, e.g. the 38 theme variables. */
  groups?: Array<{ label: string; props: Record<string, unknown> }>;
  /** The functions that actually run, as source. */
  handlers?: Array<{ name: string; source: string }>;
  children?: OutlineNode[];
}

const CLASS_FOR: Record<EmbedSpec['type'], string> = {
  liveboard: 'LiveboardEmbed',
  viz: 'LiveboardEmbed',
  search: 'SearchEmbed',
  searchbar: 'SearchBarEmbed',
  app: 'AppEmbed',
  spotter: 'SpotterEmbed',
  conversation: 'ConversationEmbed',
};

const HOST_EVENT_FOR: Record<string, string> = {
  reload: 'Reload',
  edit: 'Edit',
  save: 'Save',
  'download-pdf': 'DownloadAsPdf',
  'set-filter': 'UpdateFilters',
};

/** Props that identify an embed at a glance, in the order a reader scans for them. */
const IDENTIFYING = [
  'liveboardId',
  'vizId',
  'dataSource',
  'dataSources',
  'worksheetId',
  'answerId',
  'pageId',
  'searchOptions',
];
const FLAGS = ['fullHeight', 'preRender', 'frameParams', 'hiddenActions', 'visibleActions'];

function short(v: unknown, max = 28): string {
  if (typeof v === 'string') {
    return v.length > max ? `"${v.slice(0, max - 1)}…"` : `"${v}"`;
  }
  if (Array.isArray(v)) return `{${v.length} item${v.length === 1 ? '' : 's'}}`;
  if (v && typeof v === 'object') return `{${Object.keys(v).length} key${Object.keys(v).length === 1 ? '' : 's'}}`;
  return `{${String(v)}}`;
}

function jsx(tag: string, parts: string[], selfClosing = true): string {
  const attrs = parts.length ? ' ' + parts.join(' ') : '';
  return selfClosing ? `<${tag}${attrs} />` : `<${tag}${attrs}>`;
}

// ---------------------------------------------------------------- handlers

function actionSource(a: EmbedAction): string {
  const p = a.params as Record<string, any>;
  switch (a.type) {
    case 'set': {
      // The value path is left verbatim: a wrong path should read wrong here rather
      // than be tidied into something plausible that never resolves.
      const from = p.value ? `payload.${p.value}` : 'payload';
      return `  Ether.setVariable(${JSON.stringify(p.key)}, ${from});`;
    }
    case 'open-modal':
      return `  Ether.openModal(${JSON.stringify(p.name)});`;
    case 'close-modal':
      return `  Ether.closeModal();`;
    default: {
      const data = p.data === undefined ? '' : `, ${JSON.stringify(p.data)}`;
      const targets = Array.isArray(p.targets) && p.targets.length
        ? p.targets.map((x: string | number) => `embeds[${JSON.stringify(x)}]`).join(', ')
        : 'embed';
      return `  [${targets}].forEach((e) => e.trigger(HostEvent.${p.hostEvent}${data}));`;
    }
  }
}

function captureHandlers(spec: EmbedSpec): Array<{ name: string; source: string }> {
  return (spec.embedEventHandlers ?? []).map((h) => {
    const body: string[] = [];
    if (h.id !== undefined) {
      body.push(`  if (payload?.data?.id !== ${JSON.stringify(h.id)}) return;`);
    }
    h.actions.forEach((a) => body.push(actionSource(a)));
    // EmbedEvent *member* names, verbatim: a wrong one should look wrong here.
    const name = `on${h.type.charAt(0).toUpperCase()}${h.type.slice(1)}`;
    if (body.length === 1 && h.id === undefined) {
      return { name, source: `(payload) =>${body[0].replace(/^ {2}/, ' ').replace(/;$/, '')}` };
    }
    return { name, source: `(payload) => {\n${body.join('\n')}\n}` };
  });
}

function targetExpr(targets: unknown): { one: string | null; many: string } {
  const list = Array.isArray(targets) ? targets : [];
  if (!list.length) return { one: 'embed', many: '[embed]' };
  const refs = list.map((x) => (x === 'all' ? 'embeds' : `embeds[${JSON.stringify(x)}]`));
  return { one: list.length === 1 ? refs[0] : null, many: `[${refs.join(', ')}]` };
}

function buttonActionSource(a: EmbedAction): string {
  const p = a.params as Record<string, any>;
  switch (a.type) {
    case 'nav':
      return `Ether.go(${JSON.stringify(p.to)})`;
    case 'open-url':
      return `window.open(${JSON.stringify(p.url)}, ${JSON.stringify(p.target || '_blank')})`;
    case 'set':
      return `Ether.setVariable(${JSON.stringify(p.key)}, ${JSON.stringify(p.value)})`;
    case 'open-modal':
      return `Ether.openModal(${JSON.stringify(p.name)})`;
    case 'close-modal':
      return `Ether.closeModal()`;
    default: {
      const { one, many } = targetExpr(p.targets);
      const payload = p.payload === undefined
        ? ''
        : `, ${JSON.stringify(p.payload, null, 2).replace(/\n/g, '\n')}`;
      return one
        ? `${one}.trigger(HostEvent.${p.type}${payload})`
        : `${many}.forEach((e) => e.trigger(HostEvent.${p.type}${payload}))`;
    }
  }
}

function buttonSource(b: ButtonSpec): string {
  const actions = b.actions ?? [];
  if (!actions.length) return '() => {}';
  if (actions.length === 1) return `() => ${buttonActionSource(actions[0])}`;
  return `() => {\n${actions.map((a) => `  ${buttonActionSource(a)};`).join('\n')}\n}`;
}

// ---------------------------------------------------------------- nodes

function chromeNode(tag: string, cfg: Chrome | undefined): OutlineNode | null {
  if (!cfg || cfg.show === false) return null;
  const parts: string[] = [];
  if (cfg.title) parts.push(`title=${short(cfg.title)}`);
  if (cfg.text) parts.push(`text=${short(cfg.text)}`);
  if (cfg.logoUrl) parts.push('logo');
  if (cfg.nav?.length) parts.push(`nav={${cfg.nav.length}}`);
  if (cfg.links?.length) parts.push(`links={${cfg.links.length}}`);
  if (cfg.sticky) parts.push('sticky');
  return { tag, summary: jsx(tag, parts), props: cfg as Record<string, unknown> };
}

function embedNode(spec: EmbedSpec, project: ProjectConfig, index: number): OutlineNode {
  const tag = CLASS_FOR[spec.type] ?? 'Embed';
  // The SDK props are spec.config; preRender is the runtime's, but it reads as a prop.
  const merged: Record<string, unknown> = { ...(project.embedDefaults ?? {}), ...spec.config };
  if (spec.preRender) merged.preRender = true;

  const parts: string[] = [];
  for (const key of IDENTIFYING) if (merged[key] !== undefined) parts.push(`${key}=${short(merged[key])}`);
  for (const key of FLAGS) {
    const v = merged[key];
    if (v === true) parts.push(key);
    else if (v !== undefined && !IDENTIFYING.includes(key)) parts.push(`${key}=${short(v)}`);
  }

  // Theme variables are bulk, not signal — behind their own collapse.
  const groups: OutlineNode['groups'] = [];
  const customizations = merged.customizations as Record<string, any> | undefined;
  const vars = customizations?.style?.customCSS?.variables as Record<string, string> | undefined;
  if (vars && Object.keys(vars).length) {
    groups.push({ label: `theme variables (${Object.keys(vars).length})`, props: vars });
    const rest = JSON.parse(JSON.stringify(customizations));
    delete rest.style.customCSS.variables;
    if (Object.keys(rest.style.customCSS).length === 0) delete rest.style.customCSS;
    if (Object.keys(rest.style).length === 0) delete rest.style;
    if (Object.keys(rest).length === 0) delete merged.customizations;
    else merged.customizations = rest;
  }

  return {
    tag,
    summary: jsx(tag, parts),
    props: merged,
    groups: groups.length ? groups : undefined,
    handlers: captureHandlers(spec).length ? captureHandlers(spec) : undefined,
    children: undefined,
  };
}

function blockNodes(
  blocks: Block[] | undefined,
  project: ProjectConfig,
  counter = { n: 0 },
): OutlineNode[] {
  const out: OutlineNode[] = [];
  for (const block of blocks ?? []) {
    switch (block.type) {
      case 'heading':
        out.push({ tag: `H${block.level ?? 2}`, summary: jsx(`H${block.level ?? 2}`, [short(block.text, 40)]) });
        break;
      case 'text':
        out.push({ tag: 'Text', summary: jsx('Text', [short(block.text, 44)]) });
        break;
      case 'divider':
        out.push({ tag: 'Divider', summary: '<Divider />' });
        break;
      case 'spacer':
        out.push({ tag: 'Spacer', summary: jsx('Spacer', [`size=${short(block.size ?? '24px')}`]) });
        break;
      case 'value':
        out.push({ tag: 'Value', summary: jsx('Value', [`key=${short(block.key)}`]) });
        break;
      case 'buttons':
        out.push({
          tag: 'Buttons',
          summary: jsx('Buttons', [`{${block.items.length}}`]),
          children: block.items.map((b) => ({
            tag: 'Button',
            summary: jsx('Button', [short(b.label, 24), `action=${short(b.action)}`]),
            handlers: [{ name: 'onClick', source: buttonSource(b) }],
          })),
        });
        break;
      case 'embed':
        out.push(embedNode(block.embed, project, counter.n++));
        break;
      case 'row':
        out.push({
          tag: 'Row',
          summary: jsx('Row', [`columns={${block.columns.length}}`], false),
          children: block.columns.map((col, i) => ({
            tag: 'Col',
            summary: jsx('Col', col.span ? [`span={${col.span}}`] : [], false),
            children: blockNodes(col.blocks, project, counter),
          })),
        });
        break;
    }
  }
  return out;
}

function modalNode(name: string, modal: Modal, project: ProjectConfig): OutlineNode {
  const parts = [`name=${short(name)}`];
  if (modal.title) parts.push(`title=${short(modal.title)}`);
  if (modal.width) parts.push(`width=${short(modal.width)}`);
  return {
    tag: 'Modal',
    summary: jsx('Modal', parts, false),
    children: blockNodes(modal.blocks, project),
  };
}

export function buildOutline(project: ProjectConfig, page: PageConfig, path: string) {
  const header = chromeNode('Header', { ...project.header, ...page.header });
  const footer = chromeNode('Footer', { ...project.footer, ...page.footer });

  const nodes: OutlineNode[] = [];
  if (header) nodes.push(header);
  nodes.push(...blockNodes(page.blocks, project));
  if (footer) nodes.push(footer);

  const modals = { ...(project.modals ?? {}), ...(page.modals ?? {}) };
  const modalNodes = Object.entries(modals).map(([name, m]) => modalNode(name, m, project));

  const auth = project.auth;
  const initParts = [
    `host=${short(project.thoughtSpotHost ?? '(not set)')}`,
    `authType=${short(project.authType ?? 'None')}`,
  ];
  if (auth) initParts.push('getAuthToken');
  const init: OutlineNode = {
    tag: 'init',
    summary: jsx('init', initParts),
    props: {
      thoughtSpotHost: project.thoughtSpotHost,
      authType: project.authType ?? 'None',
      ...(auth ? { auth } : {}),
    },
    // The token fetch is generated from config, so show the function it becomes.
    handlers: auth
      ? [
          {
            name: 'getAuthToken',
            source:
              `() => fetch(${JSON.stringify(auth.tokenEndpoint)}` +
              (auth.tokenMethod && auth.tokenMethod !== 'GET'
                ? `, { method: ${JSON.stringify(auth.tokenMethod)} }`
                : '') +
              `)\n` +
              (auth.tokenField
                ? `  .then((r) => r.json())\n  .then((b) => b.${auth.tokenField})`
                : `  .then((r) => r.text())`),
          },
        ]
      : undefined,
  };

  return {
    path,
    title: page.title ?? null,
    // init is shown once, at project level, because it runs once per project.
    init,
    nodes,
    modals: modalNodes,
    pageScript: null,
  };
}
