/**
 * Verifies the named value store: Ether.set/get/on, {{key}} bindings,
 * value blocks, set-value buttons, and EmbedEvent capture.
 *   BASE=http://127.0.0.1:8899 node scripts/store-check.mjs
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
const code = (p, o) => fetch(BASE + p, o).then(r => r.status);

const c = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'tse-ether', namespace: 'Ether',
    thoughtSpotHost: BASE, sdkVersion: '1.51.0',
    header: { title: 'tse-ether', subtitle: 'route: {{route.data.currentPath}}' },
    footer: { text: 'last set: {{demo}}' },
  }),
});
const PID = c.projectId;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${c.editToken}` };

// namespace must be a JS identifier
ok(await code('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ namespace: 'not valid!' }) }) === 400, 'invalid namespace rejected');

ok(await code(`/api/projects/${PID}/pages`, { method: 'PUT', headers: auth,
  body: JSON.stringify({ path: '/', page: { title: 'Store', blocks: [
    { type: 'heading', text: 'Route is {{route.data.currentPath}}', level: 1 },
    { type: 'text', text: 'demo={{demo}} missing={{nope}}' },
    { type: 'value', key: 'route.data.currentPath', label: 'Current route' },
    { type: 'value', key: 'demo', label: 'Demo' },
    { type: 'buttons', items: [
      { label: 'Set demo', action: 'set-value', key: 'demo', value: 42 },
      { label: 'Set obj', action: 'set-value', key: 'obj', value: { a: 1 } },
    ]},
    { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-1',
      capture: { RouteChange: 'route', NoSuchEvent: 'ignored' } } },
  ] } }) }) === 200, 'page with value bindings + capture saved');

// bad store key is refused
ok(await code(`/api/projects/${PID}/pages`, { method: 'PUT', headers: auth,
  body: JSON.stringify({ path: '/bad', page: { blocks: [{ type: 'value', key: '1nope' }] } }) }) === 400,
  'invalid value key rejected');

const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage();
pg.on('dialog', d => d.dismiss().catch(() => {}));
const warns = [];
pg.on('console', m => { if (m.type() === 'warning') warns.push(m.text()); });

await pg.goto(`${BASE}/p/${PID}/`, { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('.sb-value-out', { state: 'attached', timeout: 8000 });

// --- exposed under the project's own namespace ---
ok(await pg.evaluate(() => typeof window.Ether === 'object'), 'store exposed as window.Ether');
ok(await pg.evaluate(() => typeof window.Sandbox), 'default name not leaked when namespace is set');
for (const fn of ['set', 'get', 'all', 'keys', 'on', 'clear', 'init', 'go']) {
  ok(await pg.evaluate(f => typeof window.Ether[f] === 'function', fn), `Ether.${fn}() exists`);
}

// --- unset keys render as empty / em dash, not "undefined" ---
ok(!(await pg.textContent('p.sb-text')).includes('undefined'), 'unset {{key}} renders empty, not "undefined"');
ok((await pg.locator('.sb-value-out').first().textContent()) === '—', 'unset value block shows —');

// --- set from the console reaches every binding ---
await pg.evaluate(() => window.Ether.set('demo', 'hello'));
ok((await pg.textContent('p.sb-text')).includes('demo=hello'), '{{demo}} updated in text block');
ok((await pg.locator('.sb-value-out').nth(1).textContent()) === 'hello', 'value block updated');
ok((await pg.textContent('.sb-footer')).includes('last set: hello'), 'footer {{demo}} updated');
ok(await pg.evaluate(() => window.Ether.get('demo') === 'hello'), 'Ether.get returns the value');

// --- nested/dotted keys, the route case from the brief ---
await pg.evaluate(() => window.Ether.set('route', { data: { currentPath: '/liveboard/abc' } }));
ok((await pg.textContent('h1')) === 'Route is /liveboard/abc', 'dotted {{route.data.currentPath}} resolves');
ok((await pg.locator('.sb-value-out').first().textContent()) === '/liveboard/abc', 'dotted value block resolves');
ok((await pg.textContent('.sb-subtitle')) === 'route: /liveboard/abc', 'header subtitle interpolates too');
ok(await pg.evaluate(() => window.Ether.get('route.data.currentPath') === '/liveboard/abc'),
  'Ether.get supports dotted paths');

// --- objects render as JSON rather than [object Object] ---
await pg.evaluate(() => window.Ether.set('demo', { a: 1 }));
ok((await pg.textContent('p.sb-text')).includes('demo={"a":1}'), 'object value renders as JSON');

// --- subscriptions ---
const notified = await pg.evaluate(() => {
  const seen = [];
  const off = window.Ether.on('demo', v => seen.push(v));
  window.Ether.set('demo', 'one');
  off();
  window.Ether.set('demo', 'two');
  return seen;
});
ok(JSON.stringify(notified) === JSON.stringify(['one']), 'Ether.on fires, and unsubscribe works');

// --- set-value buttons ---
await pg.click('.sb-btn:text-is("Set demo")');
ok(await pg.evaluate(() => window.Ether.get('demo') === 42), 'set-value button sets a number');
await pg.click('.sb-btn:text-is("Set obj")');
ok(await pg.evaluate(() => JSON.stringify(window.Ether.get('obj')) === '{"a":1}'), 'set-value button sets an object');

// --- keys()/all()/clear() ---
ok(await pg.evaluate(() => window.Ether.keys().includes('route') && window.Ether.keys().includes('demo')),
  'Ether.keys() lists what was set');
await pg.evaluate(() => window.Ether.clear('demo'));
ok(await pg.evaluate(() => window.Ether.get('demo') === undefined), 'Ether.clear(key) removes one key');
ok((await pg.locator('.sb-value-out').nth(1).textContent()) === '—', 'cleared key re-renders as —');

// --- capture wiring: real event subscribed, bogus one warned about ---
await pg.waitForFunction(() => !!window.tsembed, { timeout: 30000 });
await pg.waitForTimeout(2500);
ok(warns.some(w => w.includes('NoSuchEvent') && w.includes('EmbedEvent')),
  'unknown EmbedEvent in capture logs a warning instead of failing silently');
const subscribed = await pg.evaluate(() => {
  const E = window.tsembed.EmbedEvent;
  return !!(E && E.RouteChange);
});
ok(subscribed, 'RouteChange is a real EmbedEvent in this SDK, so capture is wired to something real');

// --- init is one per project, exposed on the namespace ---
ok(await pg.evaluate(() => window.Ether.initialized === true), 'Ether.initialized reflects the single init');
const cfg = await pg.evaluate(() => window.Ether.config);
ok(cfg.namespace === 'Ether' && cfg.sdkVersion === '1.51.0', 'Ether.config exposes the project init settings');
ok(await pg.evaluate(async () => {
  const a = await window.Ether.init();
  const b = await window.Ether.init();
  return a.thoughtSpotHost === b.thoughtSpotHost;
}), 'Ether.init() is idempotent — one init per project');
ok(await pg.evaluate(() => window.Ether.embed !== null), 'Ether.embed exposes the current page embed');
ok(await pg.evaluate(() => window.Ether.embeds().length === 1), 'Ether.embeds() lists all page embeds');
ok(await pg.evaluate(() => window.Ether.path === '/'), 'Ether.path reports the current route');

await b.close();
pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall value-store checks passed');
console.log(`site: ${BASE}/p/${PID}/`);
process.exit(fail.length ? 1 : 0);
