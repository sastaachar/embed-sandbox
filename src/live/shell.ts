import type { Page, Project } from '../common/db';
import type { Theme } from '../common/schema';
import { resolveTheme } from '../common/theme';
import { SDK_CDN_ORIGIN, sdkUrl } from '../common/sdkUrl';

export const RUNTIME_VERSION = '40';

const THEME_VAR: Record<keyof Theme, string> = {
  colorPrimary: '--sb-primary',
  colorPrimaryText: '--sb-primary-text',
  colorBg: '--sb-bg',
  colorSurface: '--sb-surface',
  colorText: '--sb-text',
  colorMuted: '--sb-muted',
  colorBorder: '--sb-border',
  fontFamily: '--sb-font',
  fontHeading: '--sb-font-heading',
  radius: '--sb-radius',
  maxWidth: '--sb-max',
  headerHeight: '--sb-header-h',
  space: '--sb-space',
};

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `<` is the only character that can terminate the enclosing <script> block. */
function escapeJson(json: string): string {
  return json.replace(/</g, '\\u003c');
}

/**
 * CSS custom properties only — never raw declarations, so a stored theme value
 * cannot close the rule and inject selectors of its own.
 */
function themeVars(theme: Theme | undefined): string {
  const merged = resolveTheme(theme);
  return (Object.keys(THEME_VAR) as Array<keyof Theme>)
    .map((key) => {
      const value = String(merged[key] ?? '').replace(/[;{}<>]/g, '');
      return `${THEME_VAR[key]}:${value}`;
    })
    .join(';');
}

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--sb-bg);color:var(--sb-text);font-family:var(--sb-font);
line-height:1.5;min-height:100vh;display:flex;flex-direction:column}
a{color:var(--sb-primary);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3{font-family:var(--sb-font-heading);margin:0;line-height:1.25}
h1{font-size:1.7rem;letter-spacing:-.02em}
h2{font-size:1.3rem;letter-spacing:-.01em}
h3{font-size:1.05rem}
.sb-wrap{width:100%;max-width:var(--sb-max);margin:0 auto;padding:0 var(--sb-space)}
.sb-header{border-bottom:1px solid var(--sb-border);background:var(--sb-bg);flex:0 0 auto}
.sb-header[data-sticky="1"]{position:sticky;top:0;z-index:20}
.sb-header-in{display:flex;align-items:center;gap:16px;min-height:var(--sb-header-h)}
.sb-header[data-align="center"] .sb-header-in{justify-content:center;text-align:center}
.sb-header[data-align="split"] .sb-header-in{justify-content:space-between}
.sb-brand{display:flex;align-items:center;gap:10px;min-width:0}
.sb-brand img{height:26px;width:auto;display:block}
.sb-title{font-weight:600;font-size:1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-subtitle{color:var(--sb-muted);font-size:.8rem}
.sb-nav{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.sb-nav a{color:var(--sb-muted);font-size:.875rem;padding:6px 10px;border-radius:var(--sb-radius)}
.sb-nav a:hover{background:var(--sb-surface);color:var(--sb-text);text-decoration:none}
.sb-nav a[aria-current="page"]{color:var(--sb-text);background:var(--sb-surface);font-weight:550}
.sb-main{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}
.sb-main>.sb-wrap{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;
padding-top:var(--sb-space);padding-bottom:var(--sb-space);gap:var(--sb-space)}
.sb-footer{border-top:1px solid var(--sb-border);color:var(--sb-muted);font-size:.8rem;flex:0 0 auto}
.sb-footer-in{display:flex;align-items:center;justify-content:space-between;gap:16px;
min-height:48px;flex-wrap:wrap}
.sb-footer a{color:var(--sb-muted)}
.sb-heading{margin:0;font-family:var(--sb-font-heading,inherit);color:var(--sb-text);
line-height:1.2;letter-spacing:-.01em}
.sb-text{margin:0;color:var(--sb-muted);max-width:70ch}
.sb-divider{height:1px;background:var(--sb-border);border:0;margin:0}
.sb-btns{display:flex;gap:8px;flex-wrap:wrap;width:fit-content;max-width:100%}
.sb-btns[data-align="center"]{width:100%;justify-content:center}
.sb-btns[data-align="right"]{width:100%;justify-content:flex-end}
.sb-btn{font:inherit;font-size:.875rem;font-weight:550;padding:7px 14px;border-radius:var(--sb-radius);
border:1px solid var(--sb-border);background:var(--sb-bg);color:var(--sb-text);cursor:pointer;
line-height:1.4;transition:filter .12s ease,background .12s ease}
.sb-btn:hover{filter:brightness(.97)}
.sb-btn:active{filter:brightness(.94)}
.sb-btn[data-variant="primary"]{background:var(--sb-primary);border-color:var(--sb-primary);
color:var(--sb-primary-text)}
.sb-btn[data-variant="ghost"]{background:transparent;border-color:transparent;color:var(--sb-muted)}
.sb-btn:disabled{opacity:.5;cursor:not-allowed}
.sb-code-fab{position:fixed;right:18px;bottom:18px;z-index:90;width:44px;height:44px;
border-radius:50%;border:1px solid var(--sb-border);background:var(--sb-surface);
color:var(--sb-text);font:600 15px/1 ui-monospace,Menlo,monospace;cursor:pointer;
box-shadow:0 4px 14px rgba(15,18,45,.18)}
.sb-code-fab:hover{border-color:var(--sb-primary);color:var(--sb-primary)}
.sb-code-overlay[hidden]{display:none}
.sb-code-overlay{position:fixed;inset:auto 18px 74px 18px;max-width:900px;margin-left:auto;
height:min(70vh,640px);z-index:95;display:flex;flex-direction:column;
background:var(--sb-surface);border:1px solid var(--sb-border);border-radius:12px;
box-shadow:0 18px 50px rgba(15,18,45,.25);overflow:hidden}
.sb-code-head{display:flex;align-items:center;gap:10px;padding:9px 12px;
border-bottom:1px solid var(--sb-border);font-size:13px}
.sb-code-head button{font:inherit;padding:4px 11px;border-radius:7px;cursor:pointer;
border:1px solid var(--sb-border);background:var(--sb-surface);color:var(--sb-text)}
.sb-code-seg{display:inline-flex;border:1px solid var(--sb-border);border-radius:8px;overflow:hidden}
.sb-code-seg button{border:0;border-radius:0}
.sb-code-seg button+button{border-left:1px solid var(--sb-border)}
.sb-code-seg button.on{background:var(--sb-primary);color:var(--sb-primary-text)}
.sb-code-path{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--sb-muted)}
.sb-code-fork{font-size:13px;padding:4px 11px;border-radius:7px;border:1px solid var(--sb-primary);
color:var(--sb-primary);text-decoration:none}
.sb-code-fork:hover{background:var(--sb-primary);color:var(--sb-primary-text);text-decoration:none}
.sb-code-pre{flex:1;margin:0;padding:14px 16px;overflow:auto;font:12.5px/1.6 ui-monospace,Menlo,monospace;
white-space:pre;background:#2d2d2d;color:#ccc}
.sb-modal-backdrop{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.45);
display:flex;align-items:flex-start;justify-content:center;padding:5vh 16px;overflow-y:auto}
.sb-modal-backdrop[hidden]{display:none}
.sb-modal{background:var(--sb-bg);color:var(--sb-text);border-radius:var(--sb-radius);
width:100%;max-width:900px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;
max-height:90vh}
.sb-modal-head{display:flex;align-items:center;gap:12px;padding:14px 18px;
border-bottom:1px solid var(--sb-border);flex:0 0 auto}
.sb-modal-title{font-weight:600;flex:1;min-width:0}
.sb-modal-x{font:inherit;font-size:1rem;line-height:1;background:none;border:0;color:var(--sb-muted);
cursor:pointer;padding:4px 6px;border-radius:6px}
.sb-modal-x:hover{background:var(--sb-surface);color:var(--sb-text)}
.sb-modal-body{padding:18px;overflow-y:auto;display:flex;flex-direction:column;
gap:var(--sb-space);flex:1 1 auto;min-height:0}
.sb-modal-pre{margin:0;max-height:45vh;overflow-y:auto;background:var(--sb-surface);border:1px solid var(--sb-border);
border-radius:var(--sb-radius);padding:12px 14px;overflow-x:auto;white-space:pre-wrap;
word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem}
.sb-value{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:10px 14px;
background:var(--sb-surface);border:1px solid var(--sb-border);border-radius:var(--sb-radius)}
.sb-value-label{color:var(--sb-muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;
font-weight:600}
.sb-value-out{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;
word-break:break-all;min-width:0}
.sb-row{display:grid;gap:var(--sb-space);align-items:stretch;width:100%}
.sb-row[data-align="top"]{align-items:start}
.sb-row[data-align="center"]{align-items:center}
.sb-col{display:flex;flex-direction:column;gap:var(--sb-space);min-width:0}
@media (max-width:760px){.sb-row{grid-template-columns:1fr !important}}
/* The iframe carries no chrome of its own, so without this the embed has no edge and
   reads as loose content rather than a panel. */
.sb-embed{position:relative;width:100%;border:1px solid var(--sb-border);
background:var(--sb-surface);border-radius:var(--sb-radius);overflow:hidden}
.sb-embed-host{position:relative;width:100%}
/* Inline by default, which leaves a few px of line-height under every embed. */
.sb-embed-host iframe{display:block;border:0}
.sb-attic{position:absolute;left:-100000px;top:0;width:1280px;height:820px;overflow:hidden;
visibility:visible;pointer-events:none}
.sb-attic .sb-embed-host{height:820px}
.sb-skeleton{display:flex;align-items:center;justify-content:center;min-height:420px;
background:var(--sb-surface);border-radius:var(--sb-radius);color:var(--sb-muted);font-size:.85rem}
.sb-note{background:var(--sb-surface);border:1px solid var(--sb-border);border-radius:var(--sb-radius);
padding:16px 18px;color:var(--sb-muted);font-size:.875rem}
.sb-note strong{color:var(--sb-text);display:block;margin-bottom:4px;font-weight:600}
.sb-note code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;
background:var(--sb-bg);padding:1px 5px;border-radius:4px;border:1px solid var(--sb-border)}
@media (max-width:640px){
.sb-header-in{flex-wrap:wrap;padding:10px 0;gap:8px}
h1{font-size:1.4rem}
}
/* The hidden ATTRIBUTE must beat any display rule above — a display:flex/inline-flex
   on the same element silently wins otherwise, which has hidden a Close button and
   shown a JS/HTML toggle in React mode. Last in the sheet, so ties go to it. */
.sb-set-fab{position:fixed;right:18px;bottom:70px;z-index:90;width:44px;height:44px;
border-radius:50%;border:1px solid var(--sb-border);background:var(--sb-surface);
color:var(--sb-text);font:22px/1 system-ui,sans-serif;cursor:pointer;
box-shadow:0 4px 14px rgba(15,18,45,.18)}
.sb-set-fab.sb-alone{bottom:18px}
.sb-set-fab:hover{border-color:var(--sb-primary);color:var(--sb-primary)}
.sb-set-body{flex:1;margin:0;padding:16px 18px;overflow-y:auto;display:flex;
flex-direction:column;gap:14px;background:var(--sb-bg)}
.sb-set-h{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;
color:var(--sb-muted);font-weight:700;margin:0}
.sb-set-note{margin:0;color:var(--sb-muted);font-size:.8rem}
.sb-set-f{display:flex;flex-direction:column;gap:4px}
.sb-set-f label{font-size:.78rem;color:var(--sb-muted);font-weight:600}
.sb-set-f .sb-set-src{font-weight:400;text-transform:none;letter-spacing:0;opacity:.8}
.sb-set-body input,.sb-set-body select{font:inherit;font-size:.85rem;padding:7px 10px;
border:1px solid var(--sb-border);border-radius:var(--sb-radius);background:var(--sb-bg);
color:var(--sb-text);width:100%}
.sb-set-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sb-set-foot{display:flex;gap:8px;align-items:center;padding:10px 18px;
border-top:1px solid var(--sb-border);flex:0 0 auto}
.sb-set-foot .sb-set-sp{flex:1}
.sb-dev{position:fixed;left:18px;bottom:18px;z-index:94;
width:min(600px,calc(100vw - 36px));max-height:46vh;display:flex;flex-direction:column;
background:var(--sb-surface);border:1px solid var(--sb-border);border-radius:12px;
box-shadow:0 18px 50px rgba(15,18,45,.25);overflow:hidden;font-size:12px}
.sb-dev-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:7px 10px;
border-bottom:1px solid var(--sb-border)}
.sb-dev-q{flex:1;min-width:130px;font:inherit;padding:4px 8px;border:1px solid var(--sb-border);
border-radius:7px;background:var(--sb-bg);color:var(--sb-text)}
.sb-dev-head button{font:inherit;font-size:11.5px;padding:3px 9px;border-radius:7px;
border:1px solid var(--sb-border);background:var(--sb-surface);color:var(--sb-text);cursor:pointer}
.sb-dev-seg{border-radius:7px}
.sb-dev-seg button.on{background:var(--sb-primary);color:var(--sb-primary-text)}
.sb-dev-dirs{display:flex;gap:7px;color:var(--sb-muted)}
.sb-dev-dirs label{display:flex;gap:3px;align-items:center;cursor:pointer}
.sb-dev-count{color:var(--sb-muted);font-variant-numeric:tabular-nums;min-width:2.5em;text-align:right}
.sb-dev-list{overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sb-dev-row{display:flex;gap:8px;align-items:baseline;padding:3px 10px;cursor:pointer;
border-top:1px solid var(--sb-border)}
.sb-dev-row:hover{background:var(--sb-bg)}
.sb-dev-t{color:var(--sb-muted)}
.sb-dev-b{width:10px;text-align:center;font-weight:700}
.sb-dev-row[data-dir="host"] .sb-dev-b{color:#2f6df6}
.sb-dev-row[data-dir="embed"] .sb-dev-b{color:#1c7c4a}
.sb-dev-row[data-dir="reply"] .sb-dev-b{color:var(--sb-muted)}
.sb-dev-n{font-weight:600;white-space:nowrap}
.sb-dev-tg{color:var(--sb-muted);white-space:nowrap}
.sb-dev-p{color:var(--sb-muted);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-dev-full{margin:0;padding:6px 10px 10px;background:var(--sb-bg);white-space:pre-wrap;
word-break:break-word;font-size:11.5px;max-height:210px;overflow:auto}
.sb-dev-menu{position:fixed;z-index:97;min-width:190px;padding:4px;
background:var(--sb-surface);border:1px solid var(--sb-border);border-radius:9px;
box-shadow:0 12px 32px rgba(15,18,45,.28);font-size:12px}
.sb-dev-menu button{display:block;width:100%;text-align:left;border:0;background:none;
padding:6px 10px;border-radius:6px;color:var(--sb-text);font:inherit;cursor:pointer;
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-dev-menu button:hover{background:var(--sb-bg);color:var(--sb-primary)}
.sb-dev-menu hr{border:0;border-top:1px solid var(--sb-border);margin:4px 0}
.sb-dev-row[data-dir="wire"] .sb-dev-b{color:#8a5cf6}
.sb-dev-empty{padding:10px;color:var(--sb-muted);font-family:var(--sb-font)}
[hidden]{display:none}
`;

export interface ShellInput {
  project: Project;
  pages: Page[];
  basePath: string;
  runtimeSrc: string;
}

/**
 * What the runtime renders from. Shared with /api/projects/:id/manifest so a live
 * update re-reads exactly what the shell inlined — theme derivation and all — instead
 * of the client re-deriving it and drifting.
 */
/** Keys the document interpolates: `{{liveboardId}}` in text, config, anywhere. */
function varsUsedIn(config: unknown, pages: Page[]): string[] {
  const found = new Set<string>();
  const scan = (value: unknown) => {
    const json = JSON.stringify(value ?? null) ?? '';
    const re = /\{\{\s*([A-Za-z_$][A-Za-z0-9_$-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(json)) !== null) found.add(m[1]);
  };
  scan(config);
  for (const page of pages) scan(page.config);
  return [...found];
}

export function buildManifest(project: Project, pages: Page[], basePath: string) {
  return {
    projectId: project.id,
    updatedAt: project.updatedAt,
    basePath,
    sdkUrl: sdkUrl(project.config.sdkVersion),
    project: project.config,
    pages: pages.map((p) => ({ path: p.path, ...p.config })),
    // Read by the builder and tests; the published page ignores it (the lock warns
    // in the builder only).
    lock: project.lock ?? null,
    // Every {{key}} the document interpolates, so the settings panel can offer a field
    // for a variable nobody declared — the page already depends on it.
    varsUsed: varsUsedIn(project.config, pages),
  };
}

export function renderShell({ project, pages, basePath, runtimeSrc }: ShellInput): string {
  const cfg = project.config;
  const title = cfg.header?.title || cfg.name || 'Embed sandbox';
  const manifest = escapeJson(JSON.stringify(buildManifest(project, pages, basePath)));

  const preconnects = [SDK_CDN_ORIGIN, cfg.thoughtSpotHost]
    .filter((origin): origin is string => Boolean(origin))
    .map((origin) => {
      const safe = escapeHtml(new URL(origin).origin);
      return `<link rel="preconnect" href="${safe}" crossorigin><link rel="dns-prefetch" href="${safe}">`;
    })
    .join('');

  const userCss = cfg.css ? `<style id="sb-project-css">${cfg.css}</style>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
${preconnects}
<link rel="preload" href="${escapeHtml(runtimeSrc)}" as="script">
<link rel="preload" href="${escapeHtml(sdkUrl(cfg.sdkVersion))}" as="script" crossorigin>
<style>:root{${themeVars(cfg.theme)}}${BASE_CSS}</style>
${userCss}
</head>
<body>
<header class="sb-header" id="sb-header" hidden></header>
<main class="sb-main"><div class="sb-wrap" id="sb-content"><div class="sb-skeleton">Loading…</div></div></main>
<footer class="sb-footer" id="sb-footer" hidden></footer>
<div class="sb-attic" id="sb-attic" aria-hidden="true"></div>
<script type="application/json" id="sb-manifest">${manifest}</script>
<script src="${escapeHtml(runtimeSrc)}" defer></script>
</body>
</html>`;
}

export function renderNotFound(message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not found</title>
<style>:root{${themeVars(undefined)}}${BASE_CSS}
.sb-center{flex:1;display:flex;align-items:center;justify-content:center;padding:40px}
</style></head>
<body><div class="sb-center"><div class="sb-note"><strong>Not found</strong>${escapeHtml(message)}</div></div></body></html>`;
}
