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
// Two instances, one call each: the PreRender block warms with preRender(); the
// visible embed carrying the same preRenderId shows with showPreRender().
ok(cdn.includes('preRenderEmbed.preRender();'), 'the PreRender block gets its own instance and preRender()');
ok(/\bembed(\d+)?\.showPreRender\(\);/.test(cdn), 'the visible embed attaches with showPreRender()');
ok(cdn.indexOf('.preRender();') < cdn.indexOf('.showPreRender();'), 'background instance is created first');
ok(cdn.includes('preRenderId'), 'a preRenderId is generated');
ok(/Attaches to the pre-rendered iframe/.test(cdn), 'the attach step is explained in a comment');
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

// ---- a page with no embed says so rather than emitting junk ----
const empty = await code('path=/empty');
ok(empty.includes('no embed block yet'), 'page without an embed returns an explanatory note');

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
