import type { Block, ButtonSpec, EmbedSpec, PageConfig, ProjectConfig } from './schema';
import { sdkUrl } from './shell';

export type Flavor = 'cdn' | 'esm';

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

function embedsIn(page: PageConfig): EmbedSpec[] {
  return (page.blocks || [])
    .filter((b): b is Extract<Block, { type: 'embed' }> => b.type === 'embed')
    .map((b) => b.embed);
}

function buttonsIn(page: PageConfig): ButtonSpec[] {
  return (page.blocks || [])
    .filter((b): b is Extract<Block, { type: 'buttons' }> => b.type === 'buttons')
    .flatMap((b) => b.items);
}

function embedConfigFor(spec: EmbedSpec, project: ProjectConfig, preRenderId: string | null) {
  const cfg: Record<string, unknown> = { ...(project.embedDefaults ?? {}), ...spec.config };
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
  const buttons = buttonsIn(page).filter((b) => (b.actions ?? []).some((a) => a.type === 'HostEvent'));
  const host = project.thoughtSpotHost || 'https://your-instance.thoughtspot.cloud';
  const authType = project.authType || 'None';
  const version = project.sdkVersion || 'latest';

  if (embeds.length === 0) {
    return `// ${path} has no embed block yet — add one and this becomes real SDK code.`;
  }

  const classes = [...new Set(embeds.map((e) => CLASS_FOR[e.type]))];
  const needsHostEvent = buttons.length > 0;
  const initImports = ['init', 'AuthType'];
  const pageImports = [...classes, ...(needsHostEvent ? ['HostEvent'] : [])];
  const imports = [...initImports, ...pageImports];

  // init() is global to the app, not to a page. Kept separate so the esm flavour
  // can place it at bootstrap and the per-page snippet can omit it entirely.
  const initLines = [
    `init({`,
    `  thoughtSpotHost: ${JSON.stringify(host)},`,
    `  authType: AuthType.${authType},`,
    `});`,
  ];

  const lines: string[] = [];

  // ---- one embed per block ----
  embeds.forEach((spec, i) => {
    const varName = embeds.length === 1 ? 'embed' : `embed${i + 1}`;
    const cls = CLASS_FOR[spec.type];
    const container = embeds.length === 1 ? '#embed' : `#embed-${i + 1}`;
    const preRenderId = spec.preRender ? `pre-${path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root'}-${i + 1}` : null;
    const cfg = embedConfigFor(spec, project, preRenderId);

    if (spec.type === 'viz' && !cfg.vizId) {
      lines.push(`// NOTE: type "viz" needs a vizId alongside liveboardId.`);
    }
    lines.push(`const ${varName} = new ${cls}(${JSON.stringify(container)}, ${literal(cfg, 0)});`);
    lines.push('');

    if (spec.preRender) {
      lines.push(`// Pre-render builds the iframe up front and keeps it warm. It must run`);
      lines.push(`// before ${container} is on screen — the SDK puts the frame in a wrapper at`);
      lines.push(`// document root, then showPreRender() syncs it onto the container's box.`);
      lines.push(`${varName}.preRender();`);
      lines.push('');
      lines.push(`// Call this once ${container} exists and has real dimensions.`);
      lines.push(`// A zero-size container here is the classic 0x0 pre-render stall.`);
      lines.push(`${varName}.showPreRender();`);
    } else {
      lines.push(`${varName}.render();`);
    }
    lines.push('');
  });

  // ---- buttons -> host events ----
  if (buttons.length) {
    lines.push(`// Buttons act on embed index 0 unless the action sets "targets".`);
    buttons.forEach((btn, i) => {
      const act = (btn.actions ?? []).find((a) => a.type === 'HostEvent');
      if (!act) return;
      const p = act.params as Record<string, unknown>;
      const targets = Array.isArray(p.targets) ? p.targets : [];
      const idx = typeof targets[0] === 'number' ? (targets[0] as number) : 0;
      const target = embeds.length === 1 ? 'embed' : `embed${idx + 1}`;
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

  if (flavor === 'esm') {
    const pkg = '@thoughtspot/visual-embed-sdk';
    if (!includeInit) {
      return [
        `// npm install ${pkg}@${version}`,
        `// Assumes init() has already been called once at app bootstrap.`,
        `import { ${pageImports.join(', ')} } from '${pkg}';`,
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
      `import { ${pageImports.join(', ')} } from '${pkg}';`,
      '',
      pageBody,
      '',
    ].join('\n');
  }

  // CDN flavour: a complete, standalone page — no build step, matches how this
  // sandbox itself loads the SDK.
  const containers = embeds
    .map((_, i) => (embeds.length === 1 ? `<div id="embed"></div>` : `<div id="embed-${i + 1}"></div>`))
    .join('\n  ');
  const btnHtml = buttons.length
    ? '\n  ' +
      buttons
        .map((b, i) => `<button id="btn-${i + 1}">${b.label.replace(/[<>&]/g, '')}</button>`)
        .join('\n  ')
    : '';

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
