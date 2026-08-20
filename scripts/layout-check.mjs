/**
 * Verifies row/column layout: validation limits, real side-by-side rendering, and
 * that embed indices stay in document order across columns.
 *   BASE=http://127.0.0.1:8899 node scripts/layout-check.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(
  process.env.PW_ROOT || '/Users/justin.mathew/Documents/source/Thoughtspot-theme-builder/',
);
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const api = (p, o) => fetch(BASE + p, o).then(r => r.json());

const proj = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'layout', namespace: 'Ether', thoughtSpotHost: BASE, sdkVersion: '1.51.0' }),
});
const PID = proj.projectId;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${proj.editToken}` };
const put = (path, page) => fetch(`${BASE}/api/projects/${PID}/pages`, {
  method: 'PUT', headers: auth, body: JSON.stringify({ path, page }),
}).then(r => r.status);

// ---- validation ----
const row = (columns, extra = {}) => ({ blocks: [{ type: 'row', columns, ...extra }] });
ok(await put('/ok', row([{ blocks: [{ type: 'text', text: 'a' }] }, { blocks: [{ type: 'text', text: 'b' }] }])) === 200,
  'a two-column row is accepted');
ok(await put('/spans', row([{ span: 8, blocks: [] }, { span: 4, blocks: [] }])) === 200, '12-grid spans accepted');
ok(await put('/bad0', row([])) === 400, 'a row with no columns is rejected');
ok(await put('/bad5', row([{ blocks: [] }, { blocks: [] }, { blocks: [] }, { blocks: [] }, { blocks: [] }])) === 400,
  'more than 4 columns is rejected');
ok(await put('/badspan', row([{ span: 13, blocks: [] }])) === 400, 'span above 12 is rejected');
ok(await put('/nested', row([{ blocks: [{ type: 'row', columns: [{ blocks: [] }] }] }])) === 400,
  'nested rows are rejected — drag targets would be ambiguous');
ok(await put('/badalign', row([{ blocks: [] }], { align: 'sideways' })) === 400, 'unknown align rejected');

// ---- two embeds side by side, indices in document order ----
ok(await put('/', {
  title: 'Side by side',
  blocks: [
    { type: 'heading', text: 'Two up', level: 1 },
    { type: 'row', gap: '16px', align: 'top', columns: [
      { span: 7, blocks: [{ type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-LEFT' } }] },
      { span: 5, blocks: [
        { type: 'embed', embed: { type: 'search', dataSource: 'ws-RIGHT' } },
        { type: 'text', text: 'under the right embed' },
      ] },
    ] },
    { type: 'buttons', items: [
      { label: 'Left', action: 'reload' },
      { label: 'Right', action: 'reload', embedIndex: 1 },
    ] },
  ],
}) === 200, 'page with two embeds in one row saved');

const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });
pg.on('dialog', d => d.dismiss().catch(() => {}));
await pg.goto(`${BASE}/p/${PID}/`, { waitUntil: 'domcontentloaded' });
await pg.waitForFunction(() => !!window.tsembed, { timeout: 30000 });
await pg.waitForTimeout(3500);

const geom = await pg.evaluate(() => {
  const rowEl = document.querySelector('.sb-row');
  const cols = [...document.querySelectorAll('.sb-col')];
  const hosts = [...document.querySelectorAll('.sb-embed .sb-embed-host')];
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width) }; };
  return {
    display: rowEl ? getComputedStyle(rowEl).display : null,
    template: rowEl ? getComputedStyle(rowEl).gridTemplateColumns : null,
    gap: rowEl ? getComputedStyle(rowEl).columnGap : null,
    cols: cols.map(r),
    hosts: hosts.map(r),
    ids: hosts.map(h => h.id),
    iframes: document.querySelectorAll('iframe').length,
  };
});

ok(geom.display === 'grid', `row is a CSS grid (${geom.display})`);
ok(geom.cols.length === 2, `two columns rendered (${geom.cols.length})`);
ok(geom.cols[0].y === geom.cols[1].y, `columns share a baseline — genuinely side by side (y=${geom.cols.map(c => c.y)})`);
ok(geom.cols[0].x < geom.cols[1].x, 'first column is to the left');
ok(geom.cols[0].w > geom.cols[1].w, `span 7 is wider than span 5 (${geom.cols[0].w} vs ${geom.cols[1].w})`);
ok(Math.abs(geom.cols[0].w / geom.cols[1].w - 7 / 5) < 0.15, 'widths track the 7:5 span ratio');
ok(geom.iframes >= 2, `both embeds mounted iframes (${geom.iframes})`);
ok(geom.hosts.length === 2 && geom.hosts[0].y === geom.hosts[1].y, 'the two embeds themselves are side by side');
ok(geom.ids[0].endsWith('_0') && geom.ids[1].endsWith('_1'),
  `embed slots numbered in document order across columns (${geom.ids.join(', ')})`);

// buttons target the right embed across the row
const targets = await pg.evaluate(() => {
  const got = [];
  for (const n of ['LiveboardEmbed', 'SearchEmbed']) {
    const C = window.tsembed[n];
    const orig = C.prototype.trigger;
    C.prototype.trigger = function (ev) { got.push(n); return orig.apply(this, arguments); };
  }
  document.querySelectorAll('.sb-btn').forEach(btn => btn.click());
  return got;
});
ok(targets[0] === 'LiveboardEmbed' && targets[1] === 'SearchEmbed',
  `embedIndex resolves across columns (${targets.join(' then ')})`);

// ---- responsive collapse ----
await pg.setViewportSize({ width: 600, height: 900 });
await pg.waitForTimeout(600);
const stacked = await pg.evaluate(() => {
  const cols = [...document.querySelectorAll('.sb-col')].map(c => Math.round(c.getBoundingClientRect().y));
  return cols;
});
ok(stacked[0] !== stacked[1], `columns stack on a narrow viewport (y=${stacked})`);

// ---- outline shows the structure ----
const o = await api(`/api/projects/${PID}/outline?path=/`);
const rowNode = o.nodes.find(n => n.tag === 'Row');
ok(!!rowNode, 'outline has a Row node');
ok(rowNode.summary.includes('columns={2}'), `row summary names its column count (${rowNode?.summary})`);
ok(rowNode.children.length === 2 && rowNode.children[0].tag === 'Col', 'row has Col children');
ok(rowNode.children[0].summary.includes('span={7}'), 'column shows its span');
ok(rowNode.children[0].children[0].tag === 'LiveboardEmbed', 'embeds nest under their column');

// ---- height and width reach the rendered site ----
ok(await put('/sized', { title: 'Sized', blocks: [
  { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-a', height: '480px', width: '300px' } },
  { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-b' } },
] }) === 200, 'height and width are accepted on an embed');
ok(await put('/badsize', { blocks: [
  { type: 'embed', embed: { type: 'liveboard', liveboardId: 'x', height: 'calc(100% - 10px)' } },
] }) === 400, 'height must be a length, not arbitrary CSS');
ok(await put('/numsize', { blocks: [
  { type: 'embed', embed: { type: 'liveboard', liveboardId: 'x', height: 520 } },
] }) === 200, 'a number of pixels is accepted');

await pg.goto(`${BASE}/p/${PID}/sized`, { waitUntil: 'domcontentloaded' });
await pg.waitForTimeout(1200);
const sized = await pg.evaluate(() => [...document.querySelectorAll('.sb-embed-host')].map(h => {
  const r = h.getBoundingClientRect();
  return { h: Math.round(r.height), w: Math.round(r.width), maxW: h.style.maxWidth };
}));
ok(sized[0] && sized[0].h === 480, `the sized embed is 480px tall on the real page (${sized[0] && sized[0].h})`);
ok(sized[0] && sized[0].maxW === '300px' && Math.abs(sized[0].w - 300) <= 2,
  `and capped at 300px wide (${sized[0] && sized[0].w}px)`);
ok(sized[1] && sized[1].w > sized[0].w,
  `while an unsized embed still spans its container (${sized[1] && sized[1].w}px vs ${sized[0] && sized[0].w}px)`);

const codeOut = await api(`/api/projects/${PID}/code?path=/sized`);
const flat = codeOut.code.replace(/\s+/g, ' ');
ok(/frameParams: \{ height: "480px"/.test(flat),
  'the generated code carries the height as frameParams.height');
ok(!/width: "300px"/.test(flat) && !flat.includes('height: "480px", liveboardId'),
  'and neither height nor width is passed to the SDK constructor as a stray key');

await b.close();
pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall layout checks passed');
console.log(`site: ${BASE}/p/${PID}/`);
process.exit(fail.length ? 1 : 0);
