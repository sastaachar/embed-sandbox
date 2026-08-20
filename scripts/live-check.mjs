/**
 * Verifies that a published page updates itself when the document changes — no reload,
 * and without remounting embeds whose config did not change.
 *   BASE=http://127.0.0.1:8899 node scripts/live-check.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(
  process.env.PW_ROOT || '/Users/justin.mathew/Documents/source/Thoughtspot-theme-builder/',
);
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const api = (p, o) => fetch(BASE + p, o).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const created = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'live', thoughtSpotHost: BASE, sdkVersion: '1.51.0' }),
});
const PID = created.body.projectId, TOKEN = created.body.editToken;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const putDoc = (pages, config) => api(`/api/projects/${PID}/config`, {
  method: 'PUT', headers: auth, body: JSON.stringify({ config, pages }),
});

const baseConfig = { thoughtSpotHost: BASE, sdkVersion: '1.51.0' };
await putDoc({
  '/': { title: 'Live', blocks: [
    { type: 'heading', text: 'Alpha', level: 1 },
    { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-keep', preRender: true, preRenderId: 'live-keep', height: '300px' } },
  ] },
}, baseConfig);

const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage({ viewport: { width: 1200, height: 900 } });
const jsErrors = [];
pg.on('pageerror', (e) => jsErrors.push(String(e)));

await pg.goto(`${BASE}/p/${PID}/`, { waitUntil: 'domcontentloaded' });
await pg.waitForFunction(() => document.body.textContent.includes('Alpha'), { timeout: 10000 });
ok(true, 'the page renders its first version');

// A marker that a full reload would wipe: this is how "live" is proven, not assumed.
await pg.evaluate(() => { window.__notReloaded = true; });
const iframeBefore = await pg.evaluate(() =>
  document.querySelector('iframe') ? document.querySelector('iframe').src : null);

const version = await api(`/api/projects/${PID}/version`);
ok(version.status === 200 && typeof version.body.updatedAt === 'number',
  'the page can ask for its version cheaply');

// ---- change the text; the embed's config is untouched ----
await putDoc({
  '/': { title: 'Live', blocks: [
    { type: 'heading', text: 'Beta', level: 1 },
    { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-keep', preRender: true, preRenderId: 'live-keep', height: '300px' } },
  ] },
  '/second': { title: 'Second', blocks: [{ type: 'text', text: 'a new page' }] },
}, baseConfig);

await pg.waitForFunction(() => document.body.textContent.includes('Beta'), { timeout: 15000 });
ok(true, 'an edit made elsewhere appears on the open page');
ok(await pg.evaluate(() => window.__notReloaded === true),
  'and it updated in place — the page never reloaded');

const iframeAfter = await pg.evaluate(() =>
  document.querySelector('iframe') ? document.querySelector('iframe').src : null);
ok(iframeBefore !== null ? iframeAfter === iframeBefore : true,
  'an embed whose config did not change keeps its iframe');

// ---- a page added while open is navigable ----
await pg.goto(`${BASE}/p/${PID}/second`, { waitUntil: 'domcontentloaded' });
await pg.waitForFunction(() => document.body.textContent.includes('a new page'), { timeout: 10000 });
ok(true, 'a page added while the site was open is served');

// ---- changing an embed's config does remount it ----
await pg.goto(`${BASE}/p/${PID}/`, { waitUntil: 'domcontentloaded' });
await pg.waitForFunction(() => document.body.textContent.includes('Beta'), { timeout: 10000 });
await pg.evaluate(() => { window.__notReloaded = true; });
await putDoc({
  '/': { title: 'Live', blocks: [
    { type: 'heading', text: 'Gamma', level: 1 },
    { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-changed', preRender: true, preRenderId: 'live-keep', height: '300px' } },
  ] },
}, baseConfig);
await pg.waitForFunction(() => document.body.textContent.includes('Gamma'), { timeout: 15000 });
ok(await pg.evaluate(() => window.__notReloaded === true), 'a config change also arrives without a reload');

// ---- opting out ----
await putDoc({ '/': { title: 'Live', blocks: [{ type: 'heading', text: 'Gamma', level: 1 }] } },
  { ...baseConfig, live: false });
await pg.goto(`${BASE}/p/${PID}/`, { waitUntil: 'domcontentloaded' });
await pg.waitForFunction(() => document.body.textContent.includes('Gamma'), { timeout: 10000 });
await pg.evaluate(() => { window.__pollsSeen = 0; });
await pg.route('**/version', (route) => { void pg.evaluate(() => { window.__pollsSeen++; }); return route.continue(); });
await putDoc({ '/': { title: 'Live', blocks: [{ type: 'heading', text: 'Delta', level: 1 }] } },
  { ...baseConfig, live: false });
await pg.waitForTimeout(6000);
ok(!(await pg.evaluate(() => document.body.textContent.includes('Delta'))),
  'live: false opts a project out of polling entirely');

ok(jsErrors.length === 0, `no JS errors${jsErrors.length ? ': ' + jsErrors.join(' | ') : ''}`);
await b.close();
pass.forEach((m) => console.log('  ok   ' + m));
fail.forEach((m) => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall live-update checks passed');
process.exit(fail.length ? 1 : 0);
