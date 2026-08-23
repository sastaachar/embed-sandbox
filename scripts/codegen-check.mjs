/**
 * Verifies generated SDK code: flavours, app-level init separation, preRender
 * ordering, HostEvent wiring, multi-embed, ts-vars, download headers.
 *   BASE=http://127.0.0.1:8899 node scripts/codegen-check.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const api = (p, o) => fetch(BASE + p, o).then(r => r.json());
const count = (s, sub) => s.split(sub).length - 1;

const proj = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'codegen', thoughtSpotHost: 'https://acme.thoughtspot.cloud',
    sdkVersion: '1.51.0', authType: 'EmbeddedSSO', theme: { colorPrimary: '#7b3fe4' },
  }),
});
const PID = proj.projectId;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${proj.editToken}` };
const put = (path, page) => fetch(`${BASE}/api/projects/${PID}/pages`, {
  method: 'PUT', headers: auth, body: JSON.stringify({ path, page }),
}).then(r => r.status);

await put('/lb', { title: 'LB', blocks: [
  { type: 'buttons', items: [
    { label: 'Reload', action: 'reload' },
    { label: 'West', action: 'set-filter', column: 'Region', values: ['West'] },
    { label: 'Elsewhere', action: 'nav', to: '/' },
  ]},
  // The real pattern: a PreRender block loading in the background, and the visible
  // embed connecting to it by id.
  { type: 'embed', embed: { type: 'liveboard', name: 'bg', preRender: true,
    config: { liveboardId: 'lb-1', preRenderId: 'gen-home' } } },
  { type: 'embed', embed: { type: 'liveboard', name: 'main',
    config: { liveboardId: 'lb-1', preRenderId: 'gen-home', fullHeight: true } } },
]});
await put('/two', { blocks: [
  { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-a' } },
  { type: 'embed', embed: { type: 'search', dataSource: 'ws-b' } },
  { type: 'buttons', items: [{ label: 'Second', action: 'reload', embedIndex: 1 }] },
]});
await put('/empty', { blocks: [{ type: 'text', text: 'nothing to embed' }] });

const code = (q) => api(`/api/projects/${PID}/code?${q}`).then(r => r.code || '');

// ---- cdn: a standalone page, so init belongs in it ----
const cdn = await code('path=/lb');
ok(cdn.startsWith('<!doctype html>'), 'cdn flavour is a complete HTML document');
ok(cdn.includes('visual-embed-sdk@1.51.0/dist/tsembed.js'), 'cdn pins the project SDK version in the script tag');
ok(count(cdn, 'init({') === 1, `cdn calls init exactly once (${count(cdn, 'init({')})`);
ok(cdn.includes('the whole app, so init() lives here'), 'cdn explains why init is in the file');
ok(cdn.includes('window.tsembed'), 'cdn destructures from the UMD global');
ok(cdn.includes('<div id="embed"></div>'), 'cdn emits the container');
ok(cdn.includes('AuthType.EmbeddedSSO'), 'cdn carries the project authType');

// ---- esm: init is app-level, separated ----
const esm = await code('path=/lb&flavor=esm');
ok(count(esm, 'init({') === 1, `esm calls init exactly once (${count(esm, 'init({')})`);
ok(esm.includes('once per app, at bootstrap — NOT per page'), 'esm labels init as app-level, not per page');
ok(esm.includes("import { init, AuthType } from '@thoughtspot/visual-embed-sdk'"),
  'esm imports init separately from the page classes');
ok(esm.includes("import { LiveboardEmbed, HostEvent } from '@thoughtspot/visual-embed-sdk'"),
  'esm imports the page classes in their own statement');
ok(esm.includes('npm install @thoughtspot/visual-embed-sdk@1.51.0'), 'esm shows the pinned install line');
ok(esm.indexOf('init({') < esm.indexOf('new LiveboardEmbed'), 'init appears before the embed');

// ---- esm without init: page code only ----
const noInit = await code('path=/lb&flavor=esm&init=0');
// `init(` also appears in the explanatory comment, so match the actual call.
ok(count(noInit, 'init({') === 0, 'init=0 omits the init call entirely');
ok(!/^init\(/m.test(noInit), 'no top-level init statement remains');
ok(!noInit.includes('AuthType'), 'init=0 drops the now-unused AuthType import');
ok(noInit.includes('already been called once at app bootstrap'), 'init=0 states the assumption');
ok(noInit.includes('new LiveboardEmbed'), 'init=0 still emits the page code');
ok(noInit.includes('HostEvent.Reload'), 'init=0 still wires the buttons');

// cdn ignores init=0, because a standalone page without init cannot work
const cdnNoInit = await code('path=/lb&flavor=cdn&init=0');
ok(count(cdnNoInit, 'init({') === 1, 'cdn keeps init even with init=0, since it is standalone');

// ---- preRender ordering is explained, not just emitted ----
// Two instances, one call each: the PreRender block gets preRender(); a visible embed
// carrying a preRenderId reveals the shared wrapper with showPreRender() — render()
// does not connect it (runtime v20; DX-82 tracks moving that into the SDK).
ok(cdn.includes('preRenderEmbed.preRender();'), 'the PreRender block gets its own instance and preRender()');
ok(/\bembed(\d+)?\.showPreRender\(\);/.test(cdn), 'the connecting embed calls showPreRender()');
ok(cdn.indexOf('.preRender();') < cdn.indexOf('.showPreRender();'), 'background instance is created first');
ok(cdn.includes('preRenderId'), 'a preRenderId is generated');
ok(cdn.includes('preRenderId'), 'the connecting id is in the visible embed config');
ok(cdn.includes('fullHeight: true'), 'fullHeight carried through');

// ---- buttons -> HostEvents, nav excluded ----
ok(cdn.includes('HostEvent.Reload'), 'reload maps to HostEvent.Reload');
ok(cdn.includes('HostEvent.UpdateFilters'), 'set-filter maps to HostEvent.UpdateFilters');
ok(cdn.includes('columnName') && cdn.includes('filters'),
  'set-filter payload is emitted');
ok(!cdn.includes("HostEvent.undefined"), 'nav/open-url buttons produce no HostEvent');

// ---- several embeds on one page ----
const two = await code('path=/two&flavor=esm');
ok(two.includes('const embed1') && two.includes('const embed2'), 'multi-embed pages get numbered vars');
// Containers carry the variable names now, so HTML and JS read as one.
ok(two.includes('#embed1') && two.includes('#embed2'), 'each embed gets its own container id');
ok(two.includes('new SearchEmbed'), 'the second block uses its own embed class');
ok(two.includes('embed2.trigger'), 'embedIndex:1 targets the second embed in generated code');

// ---- theme vars ride along, so code matches what runs ----
ok(cdn.includes('--ts-var-button--primary-background'), 'generated code carries the derived --ts-var values');

// ---- a page with no embed still yields real code, minus the SDK ----
const empty = await code('path=/empty');
ok(empty.includes('<!doctype html>'), 'no-embed cdn is still a complete standalone page');
ok(empty.includes('no embed block yet'), 'and says why no SDK code is in it');
ok(!empty.includes('init({') && !empty.includes('window.tsembed'),
  'cdn without an embed neither loads nor inits the SDK');
const emptyEsm = await code('path=/empty&flavor=esm');
ok(emptyEsm.includes('init({'), 'no-embed esm keeps the app-level init');
ok(!/import \{\s*\} from/.test(emptyEsm), 'no-embed esm emits no empty import');
ok(emptyEsm.includes('no embed block yet'), 'and carries the note');
const emptyReact = await code('path=/empty&flavor=react');
ok(/export function \w+\(\)/.test(emptyReact), 'no-embed react still emits the page component');
ok(emptyReact.includes('nothing to embed'), 'with the page content in its JSX');
ok(!emptyReact.includes("from '@thoughtspot/visual-embed-sdk/react'"),
  'and no react-wrapper import it does not use');
ok(!emptyReact.includes('embedDefaults'),
  'no-embed react drops embedDefaults — nothing exists to spread them into');

// ---- trusted auth: init() must carry a getAuthToken, or the SDK refuses it ----
const mk = async (authBlock) => {
  const p = await api('/api/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'codegen-auth', thoughtSpotHost: 'https://acme.thoughtspot.cloud',
      sdkVersion: '1.51.0', authType: 'TrustedAuthTokenCookieless',
      ...(authBlock ? { auth: authBlock } : {}),
    }),
  });
  await fetch(`${BASE}/api/projects/${p.projectId}/pages`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.editToken}` },
    body: JSON.stringify({ path: '/', page: { blocks: [
      { type: 'embed', embed: { type: 'liveboard', config: { liveboardId: 'lb-1' } } }] } }),
  });
  return api(`/api/projects/${p.projectId}/code?path=/&flavor=esm`).then((r) => r.code || '');
};
const credCode = await mk({ tokenSource: 'credentials', username: 'demo', secret: 's3cret', secretType: 'password' });
ok(credCode.includes('getAuthToken:'), 'trusted auth + credentials: init() carries getAuthToken');
ok(credCode.includes('/api/rest/2.0/auth/token/full') && credCode.includes('"username":"demo"'),
  'and it mints from the cluster the way the runtime does');
ok(credCode.includes('VISIBLE in this file'), 'with the public-secret trade-off stated');
const bareCode = await mk(null);
ok(bareCode.includes('getAuthToken:') && bareCode.includes('REQUIRED for AuthType.TrustedAuthTokenCookieless'),
  'trusted auth with no token source: a stub getAuthToken that names the requirement');
const ep = await mk({ tokenSource: 'endpoint', tokenEndpoint: 'https://api.acme.com/ts-token', tokenField: 'data.token' });
ok(ep.includes('fetch("https://api.acme.com/ts-token")') && ep.includes('b.data.token'),
  'endpoint source: the generated fetch hits the service and reads the token field');
const ssoCode = await code('path=/lb&flavor=esm');
ok(!ssoCode.includes('getAuthToken'), 'EmbeddedSSO init() stays clean — no token, nothing to fetch');

// ---- download headers ----
const dl = await fetch(`${BASE}/api/projects/${PID}/code?path=/lb&download=1`);
ok(dl.headers.get('content-disposition')?.includes('lb.html'), 'cdn download is named lb.html');
ok(dl.headers.get('content-type')?.includes('text/html'), 'cdn download is text/html');
const dlEsm = await fetch(`${BASE}/api/projects/${PID}/code?path=/lb&flavor=esm&download=1`);
ok(dlEsm.headers.get('content-disposition')?.includes('lb.js'), 'esm download is named lb.js');
ok(dlEsm.headers.get('content-type')?.includes('javascript'), 'esm download is javascript');

// ---- bad input ----
ok(await fetch(`${BASE}/api/projects/${PID}/code?path=/lb&flavor=bogus`).then(r => r.status) === 400,
  'unknown flavour is rejected');
ok(await fetch(`${BASE}/api/projects/${PID}/code?path=/nope`).then(r => r.status) === 404,
  'unknown page is 404');

pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall codegen checks passed');
process.exit(fail.length ? 1 : 0);
