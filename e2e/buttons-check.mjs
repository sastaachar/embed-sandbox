/**
 * Verifies button -> HostEvent wiring and multiple embed blocks per page.
 *   BASE=http://127.0.0.1:8899 node e2e/buttons-check.mjs
 * Hermetic: aims the SDK at the local worker, so no live cluster is needed.
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
const status = (p, o) => fetch(BASE + p, o).then(r => r.status);

const c = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Buttons check', thoughtSpotHost: BASE, sdkVersion: '1.51.0' }),
});
const PID = c.projectId;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${c.editToken}` };

// the removed phantom action must now be refused
ok(
  await status(`/api/projects/${PID}/pages`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ path: '/x', page: { blocks: [
      { type: 'buttons', items: [{ label: 'R', action: 'reset-filters' }] }] } }),
  }) === 400,
  'reset-filters is rejected (no such HostEvent exists)',
);

// page with a full button row AND two embed blocks of different types
ok(
  await status(`/api/projects/${PID}/pages`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ path: '/', page: { title: 'Buttons', blocks: [
      { type: 'buttons', items: [
        { label: 'Reload', action: 'reload' },
        { label: 'Edit', action: 'edit' },
        { label: 'Save', action: 'save' },
        { label: 'PDF', action: 'download-pdf' },
        { label: 'West', action: 'set-filter', column: 'Region', values: ['West', 'East'] },
        { label: 'Pin', action: 'host-event', hostEvent: 'Pin' },
        { label: 'ResetView', action: 'host-event', hostEvent: 'ResetLiveboardPersonalisedView' },
        { label: 'Bogus', action: 'host-event', hostEvent: 'NoSuchEventExists' },
      ]},
      { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-AAA' } },
      { type: 'embed', embed: { type: 'search', dataSource: 'ws-BBB' } },
    ] } }),
  }) === 200,
  'page with 8 buttons + 2 embed blocks saved',
);

const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage();
pg.on('dialog', d => d.dismiss().catch(() => {}));
const warnings = [];
pg.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });

await pg.goto(`${BASE}/p/${PID}/`, { waitUntil: 'domcontentloaded' });
await pg.waitForFunction(() => !!window.tsembed, { timeout: 30000 });

await pg.evaluate(() => {
  window.__t = [];
  for (const n of ['LiveboardEmbed', 'SearchEmbed', 'AppEmbed']) {
    const C = window.tsembed[n];
    if (!C) continue;
    const orig = C.prototype.trigger;
    C.prototype.trigger = function (ev, payload) {
      window.__t.push({ cls: n, ev: String(ev), payload });
      try { return orig.apply(this, arguments); } catch { return null; }
    };
  }
});

await pg.waitForTimeout(4000);

// --- multiple embeds per page ---
const wrappers = await pg.locator('.sb-embed').count();
const hosts = await pg.locator('.sb-embed .sb-embed-host').count();
const iframes = await pg.locator('iframe').count();
ok(wrappers === 2, `2 embed wrappers rendered (got ${wrappers})`);
ok(hosts === 2, `both embed blocks mounted a host (got ${hosts})`);
ok(iframes >= 2, `each embed block got its own iframe (got ${iframes})`);
const hostIds = await pg.locator('.sb-embed .sb-embed-host').evaluateAll(els => els.map(e => e.id));
ok(new Set(hostIds).size === hostIds.length, `host ids are distinct: ${hostIds.join(', ')}`);

// --- buttons fire host events ---
const labels = await pg.locator('.sb-btn').allTextContents();
ok(labels.length === 8, `8 buttons rendered (got ${labels.length})`);
for (const l of labels) { await pg.click(`.sb-btn:text-is("${l}")`); await pg.waitForTimeout(150); }

const fired = await pg.evaluate(() => window.__t);
const evs = fired.map(f => f.ev);
for (const [label, ev] of [
  ['Reload', 'reload'], ['Edit', 'edit'], ['Save', 'save'],
  ['PDF', 'downloadAsPdf'], ['West', 'updateFilters'], ['Pin', 'pin'],
  ['ResetView', 'ResetLiveboardPersonalisedView'],
]) ok(evs.includes(ev), `${label} -> HostEvent "${ev}"`);

const filterCall = fired.find(f => f.ev === 'updateFilters');
// The embed validates this shape itself: { filters: [{ column, oper, values }] } —
// its own error message spells it out. A bare array, or columnName/operator keys,
// fail HOST_EVENT_VALIDATION, which reads as "the filter is not changed".
ok(
  JSON.stringify(filterCall?.payload) ===
    JSON.stringify({ filters: [{ columnName: 'Region', operator: 'IN', values: ['West', 'East'] }] }),
  'set-filter sends { filters: [{ columnName, operator, values }] } — verified live against a cluster',
);

ok(fired.every(f => f.cls === 'LiveboardEmbed'), 'buttons act on the FIRST embed block only');

// --- unknown host event is not sent, and the button says so ---
ok(!evs.includes('NoSuchEventExists'), 'unknown hostEvent is never forwarded to the SDK');
ok(
  warnings.some(w => w.includes('NoSuchEventExists') && w.includes('no HostEvent')),
  'unknown hostEvent logs a clear warning',
);
ok(
  await pg.locator('.sb-btn:text-is("Bogus")').isDisabled(),
  'unsupported button disables itself',
);
const title = await pg.locator('.sb-btn:text-is("Bogus")').getAttribute('title');
ok(!!title && title.includes('1.51.0'), `disabled button explains why: "${title}"`);

await b.close();
pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall button/multi-embed checks passed');
process.exit(fail.length ? 1 : 0);
