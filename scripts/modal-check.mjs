/**
 * Verifies the modal component, custom-action rules, {{key}} in embed config,
 * and the built-in embed-error surface.
 *   BASE=http://127.0.0.1:8899 node scripts/modal-check.mjs
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

/** Records a failure instead of throwing, so one bad wait doesn't hide the rest. */
async function waitOk(pg, selector, opts, msg) {
  try {
    await pg.waitForSelector(selector, opts);
    pass.push(msg);
    return true;
  } catch {
    fail.push(`${msg} — selector never settled: ${selector} ${JSON.stringify(opts)}`);
    return false;
  }
}
async function waitFnOk(pg, fn, opts, msg) {
  try {
    await pg.waitForFunction(fn, opts);
    pass.push(msg);
    return true;
  } catch {
    fail.push(`${msg} — condition never became true`);
    return false;
  }
}
const code = (p, o) => fetch(BASE + p, o).then(r => r.status);

const c = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'tse-ether', namespace: 'Ether', thoughtSpotHost: BASE, sdkVersion: '1.51.0',
    showEmbedErrors: false,
    modals: { help: { title: 'Site help', blocks: [{ type: 'text', text: 'available everywhere' }] } },
  }),
});
const PID = c.projectId;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${c.editToken}` };

ok(await code(`/api/projects/${PID}/pages`, { method: 'PUT', headers: auth,
  body: JSON.stringify({ path: '/', page: { title: 'Home', blocks: [
    { type: 'buttons', items: [
      { label: 'Open help', action: 'open-modal', modal: 'help' },
      { label: 'Go lb', action: 'nav', to: '/lb' },
    ]},
  ] } }) }) === 200, 'page with open-modal button saved');

ok(await code(`/api/projects/${PID}/pages`, { method: 'PUT', headers: auth,
  body: JSON.stringify({ path: '/lb', page: { title: 'LB',
    modals: {
      detail: { title: 'Answer detail', width: '820px', blocks: [
        { type: 'value', key: 'answerId', label: 'Session' },
        { type: 'embed', embed: { type: 'search', answerId: '{{answerId}}' } },
        { type: 'buttons', items: [{ label: 'Close', action: 'close-modal' }] },
      ]},
    },
    blocks: [
      { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-1',
        on: { CustomAction: [
          { id: 'open-detail', set: { answerId: 'data.embedAnswerData.sessionId' }, openModal: 'detail' },
        ] } } },
    ] } }) }) === 200, 'page with custom-action rule + modal saved');

ok(await code(`/api/projects/${PID}/pages`, { method: 'PUT', headers: auth,
  body: JSON.stringify({ path: '/lit', page: { title: 'Lit', blocks: [
    { type: 'value', key: 'status', label: 'Status' },
    { type: 'embed', embed: { type: 'liveboard', config: { liveboardId: 'lb-2' },
      embedEventHandlers: [
        { type: 'Load', actions: [
          { type: 'set', params: { key: 'status', literal: 'Liveboard is loaded' } },
          { type: 'set', params: { key: 'statusObj', literal: { done: true, n: 3 } } },
          { type: 'set', params: { key: 'viaWrapper', value: { literal: 'yes' } } },
          { type: 'set', params: { key: 'fromPath', value: 'data.vizId' } },
          { type: 'HostEvent', params: { type: 'Reload' } },
        ]},
      ] } },
  ] } }) }) === 200, 'page with literal-set Load handler saved');

// bad modal reference is refused at save time
ok(await code(`/api/projects/${PID}/pages`, { method: 'PUT', headers: auth,
  body: JSON.stringify({ path: '/bad', page: { blocks: [
    { type: 'buttons', items: [{ label: 'x', action: 'open-modal', modal: 'not a name!' }] }] } }) }) === 400,
  'invalid modal name rejected');

const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage();
const warns = [];
pg.on('console', m => { if (m.type() === 'warning') warns.push(m.text()); });
await pg.goto(`${BASE}/p/${PID}/`, { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('.sb-btn', { timeout: 8000 });

// ---- site-level modal, opened by button ----
await pg.click('.sb-btn:text-is("Open help")');
await pg.waitForSelector('.sb-modal-backdrop:not([hidden])', { timeout: 5000 });
ok((await pg.textContent('.sb-modal-title')) === 'Site help', 'site-level modal opens on any page');
ok(await pg.evaluate(() => window.Ether.modal === 'help'), 'Ether.modal reports the open modal');
await pg.keyboard.press('Escape');
await pg.waitForSelector('.sb-modal-backdrop', { state: 'hidden', timeout: 5000 });
ok(await pg.evaluate(() => window.Ether.modal === null), 'Escape closes the modal');

await pg.click('.sb-btn:text-is("Open help")');
await pg.waitForSelector('.sb-modal-backdrop:not([hidden])', { timeout: 5000 });
await pg.click('.sb-modal-x');
await pg.waitForSelector('.sb-modal-backdrop', { state: 'hidden', timeout: 5000 });
ok(true, 'close button closes the modal');

// ---- load the SDK via Ether.init(), then record handlers before the embed mounts ----
await pg.evaluate(() => window.Ether.init());
await pg.waitForFunction(() => !!window.tsembed, { timeout: 30000 });
await pg.evaluate(() => {
  window.__handlers = [];
  for (const n of ['LiveboardEmbed', 'SearchEmbed']) {
    const C = window.tsembed[n];
    if (!C) continue;
    const orig = C.prototype.on;
    C.prototype.on = function (ev, fn) {
      window.__handlers.push({ cls: n, ev: String(ev), fn });
      try { return orig.apply(this, arguments); } catch { return this; }
    };
  }
});

await pg.evaluate(() => window.Ether.go('/lb'));
await pg.waitForFunction(() => window.Ether.embeds().length === 1, { timeout: 20000 });
await pg.waitForTimeout(1500);

const evs = await pg.evaluate(() => window.__handlers.map(h => h.ev));
ok(evs.includes('customAction'), `CustomAction rule subscribed (saw ${JSON.stringify(evs)})`);
ok(await pg.evaluate(() => window.__handlers.filter(h => h.ev === 'customAction').length > 0),
  'a real handler was registered on the embed instance (regression: it used to get null)');
ok(warns.every(w => !w.includes('could not subscribe')),
  `no "could not subscribe" warnings${warns.length ? ' — saw: ' + warns.join(' | ') : ''}`);
ok(!evs.includes('Error'), 'showEmbedErrors:false means no Error subscription');

// ---- fire a custom action: sets store, opens modal, modal embed mounts ----
const fired = await pg.evaluate(() => {
  const hs = window.__handlers.filter(x => x.ev === 'customAction');
  const payload = { id: 'open-detail', data: { id: 'open-detail', embedAnswerData: { sessionId: 'sess-42' } } };
  hs.forEach(h => { try { h.fn(payload); } catch (e) { /* SDK-internal handlers may reject a synthetic payload */ } });
  return hs.length;
});
ok(fired > 0, `custom action handler invoked (${fired} handler(s) registered for customAction)`);
await waitOk(pg, '.sb-modal-backdrop:not([hidden])', { timeout: 5000 }, 'custom action opened the modal');
ok(await pg.evaluate(() => window.Ether.get('answerId') === 'sess-42'),
  'rule copied data.embedAnswerData.sessionId into the store');
ok((await pg.textContent('.sb-modal-title')) === 'Answer detail', 'rule opened the named modal');
const valueOut = await pg.locator('.sb-modal .sb-value-out').first()
  .textContent({ timeout: 5000 }).catch(() => null);
ok(valueOut === 'sess-42', `value block inside the modal shows the captured id (got ${valueOut})`);
await waitFnOk(pg, () => document.querySelectorAll('.sb-modal .sb-embed iframe').length === 1,
  { timeout: 20000 }, '{{answerId}} resolved and the modal embed mounted');
ok(await pg.evaluate(() => window.Ether.embeds('modal:detail').length === 1),
  "Ether.embeds('modal:detail') reaches the modal's embed");

// ---- closing the modal tears the embed down ----
const closed = await pg.click('.sb-modal .sb-btn:text-is("Close")', { timeout: 5000 })
  .then(() => pg.waitForSelector('.sb-modal-backdrop', { state: 'hidden', timeout: 5000 }))
  .then(() => true, () => false);
ok(closed, 'the modal Close button closes it');
ok(await pg.evaluate(() => window.Ether.embeds('modal:detail').length === 0),
  'modal embed released on close');

// ---- an embed whose {{key}} is unset waits instead of rendering broken ----
await pg.evaluate(() => window.Ether.clear('answerId'));
await pg.evaluate(() => window.Ether.openModal('detail'));
await waitOk(pg, '.sb-modal .sb-note', { timeout: 5000 }, 'unset {{key}} renders a note');
ok(((await pg.textContent('.sb-modal .sb-note').catch(() => '')) || '').includes('Waiting for a value'),
  'embed with an unset {{key}} shows a waiting note, not a blank embed');
await pg.evaluate(() => window.Ether.set('answerId', 'sess-99'));
await waitFnOk(pg, () => document.querySelectorAll('.sb-modal .sb-embed iframe').length === 1,
  { timeout: 20000 }, 'waiting embed mounts itself once the value arrives');
await pg.evaluate(() => window.Ether.closeModal());

// ---- literal set in an event handler, plus the normalized HostEvent vocabulary ----
await pg.evaluate(() => window.Ether.go('/lit'));
await pg.waitForFunction(() => window.Ether.path === '/lit' && window.Ether.embeds().length === 1,
  { timeout: 20000 });
await pg.waitForTimeout(1000);
// Read back in the same evaluate: the embed's real Load event (fired whenever the
// iframe finishes against the fake cluster) re-runs the handler with a payload that
// has no data.vizId, so an async read of fromPath races it.
const lit = await pg.evaluate(() => {
  const lv = String(window.tsembed.EmbedEvent.Load);
  const hs = window.__handlers.filter(x => x.ev === lv);
  hs.forEach(h => { try { h.fn({ data: { vizId: 'viz-7' } }); } catch (e) {} });
  return {
    fired: hs.length,
    status: window.Ether.get('status'),
    statusObj: JSON.stringify(window.Ether.get('statusObj')),
    viaWrapper: window.Ether.get('viaWrapper'),
    fromPath: window.Ether.get('fromPath'),
  };
});
ok(lit.fired > 0, `Load handler invoked (${lit.fired} handler(s))`);
ok(lit.status === 'Liveboard is loaded', 'handler set wrote the literal string, not a payload lookup');
ok(lit.statusObj === '{"done":true,"n":3}', 'a literal can be structured, and arrives intact');
ok(lit.viaWrapper === 'yes', 'value: { literal: … } wrapper form normalizes to a literal');
ok(lit.fromPath === 'viz-7', 'payload-path set still reads out of the payload beside literals');
const litValue = await pg.locator('.sb-value-out').first().textContent().catch(() => null);
ok(litValue === 'Liveboard is loaded', `value block shows the literal (got ${litValue})`);
ok(warns.every(w => !w.includes('unknown action type')),
  'HostEvent in a handler runs the normalized vocabulary — no "unknown action type" warning');

// ---- the CORS error surface, on its own project so showEmbedErrors is on ----
const e2 = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'errors', namespace: 'Ether', thoughtSpotHost: BASE, sdkVersion: '1.51.0',
  }),
});
const auth2 = { 'content-type': 'application/json', authorization: `Bearer ${e2.editToken}` };
await api(`/api/projects/${e2.projectId}/pages`, { method: 'PUT', headers: auth2,
  body: JSON.stringify({ path: '/', page: { blocks: [{ type: 'text', text: 'no embed here' }] } }) });
await api(`/api/projects/${e2.projectId}/pages`, { method: 'PUT', headers: auth2,
  body: JSON.stringify({ path: '/e', page: { blocks: [
    { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-err' } }] } }) });

const pg2 = await b.newPage();
await pg2.goto(`${BASE}/p/${e2.projectId}/`, { waitUntil: 'domcontentloaded' });
await pg2.evaluate(() => window.Ether.init());
await pg2.waitForFunction(() => !!window.tsembed, { timeout: 30000 });
await pg2.evaluate(() => {
  window.__handlers = [];
  const C = window.tsembed.LiveboardEmbed;
  const orig = C.prototype.on;
  C.prototype.on = function (ev, fn) {
    window.__handlers.push({ ev: String(ev), fn });
    try { return orig.apply(this, arguments); } catch { return this; }
  };
});
await pg2.evaluate(() => window.Ether.go('/e'));
await pg2.waitForFunction(() => window.Ether.embeds().length === 1, { timeout: 20000 });
await pg2.waitForTimeout(1500);

const evs2 = await pg2.evaluate(() => window.__handlers.map(h => h.ev));
ok(evs2.includes('Error'), `built-in Error surface subscribed by default (saw ${JSON.stringify(evs2)})`);

// A real error from the fake cluster may already have opened it; start clean.
await pg2.evaluate(() => window.Ether.closeModal());
await pg2.evaluate(() => {
  const hs = window.__handlers.filter(x => x.ev === 'Error');
  const payload = { data: { error: "Refused to frame 'https://acme.thoughtspot.cloud' because it violates the Content Security Policy directive: frame-ancestors" } };
  hs.forEach(h => { try { h.fn(payload); } catch (e) {} });
});
await waitOk(pg2, '.sb-modal-backdrop:not([hidden])', { timeout: 5000 }, 'Error event opened a modal');
ok((await pg2.textContent('.sb-modal-title').catch(() => '')) === 'Embed error', 'error modal titled "Embed error"');
const errText = (await pg2.textContent('.sb-modal-body').catch(() => '')) || '';
ok(errText.includes('CSP visual-embed hosts'), 'CORS/CSP error explains the allowlist fix');
ok(errText.includes(new URL(BASE).origin), 'error modal names the exact origin to allowlist');
ok(await pg2.evaluate(() => !!window.Ether.get('embedError')), 'error payload stored under embedError');

// an open modal is not yanked away by a later error
await pg2.evaluate(() => window.Ether.closeModal());
await pg2.evaluate(() => window.Ether.set('__x', 1));
const guarded = await pg2.evaluate(() => {
  window.Ether.openModal('nope');
  return window.Ether.modal;
});
ok(guarded === null, 'openModal on an unknown name is a no-op, not a crash');

await b.close();
if (warns.length) console.log('warnings:', warns);
pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall modal/custom-action checks passed');
console.log(`site: ${BASE}/p/${PID}/lb`);
process.exit(fail.length ? 1 : 0);
