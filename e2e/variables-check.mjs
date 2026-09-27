/**
 * Verifies that the builder canvas resolves {{key}} from the project's declared variable
 * defaults — the same values a first-time visitor gets — instead of handing the braces
 * to the SDK. Covers embeds, text, headings and value blocks, host-event payloads, and
 * the published page it is supposed to be previewing.
 *   BASE=http://127.0.0.1:8899 node e2e/variables-check.mjs
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

const LB = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';

const created = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'variables', thoughtSpotHost: BASE, sdkVersion: '1.51.0' }),
});
const PID = created.body.projectId, TOKEN = created.body.editToken;

await api(`/api/projects/${PID}/config`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    config: {
      thoughtSpotHost: BASE,
      sdkVersion: '1.51.0',
      variables: {
        liveboardId: { label: 'Liveboard', default: LB },
        region: { label: 'Region', default: 'West' },
        // Declared but with NO default: the canvas must say so rather than pretend.
        answerId: { label: 'Answer', placeholder: 'pick one' },
      },
    },
    pages: {
      '/': {
        title: 'Vars',
        blocks: [
          { type: 'heading', text: 'Sales in {{region}}', level: 2 },
          { type: 'text', text: 'Showing **{{region}}** from `{{liveboardId}}`.' },
          { type: 'value', key: 'region', label: 'Region' },
          { type: 'buttons', items: [
            { label: 'Filter', actions: [{ type: 'HostEvent', params: { type: 'UpdateRuntimeFilters',
              payload: [{ columnName: 'Region', operator: 'EQ', values: ['{{region}}'] }] } }] },
            // Nothing declares "nope", so this one must refuse rather than filter on "".
            { label: 'Unset', actions: [{ type: 'HostEvent', params: { type: 'UpdateRuntimeFilters',
              payload: [{ columnName: 'Region', operator: 'EQ', values: ['{{nope}}'] }] } }] },
          ] },
          { type: 'embed', embed: { type: 'liveboard', config: { liveboardId: '{{liveboardId}}' }, height: '300px' } },
          { type: 'embed', embed: { type: 'liveboard', config: { liveboardId: '{{answerId}}' }, height: '300px' } },
        ],
      },
    },
  }),
});

const b = await chromium.launch({ channel: 'chrome' });

// --- the builder canvas ------------------------------------------------------------
const bp = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
bp.on('pageerror', (e) => errors.push(String(e)));
await bp.goto(`${BASE}/build/${PID}#t=${TOKEN}`, { waitUntil: 'domcontentloaded' });
await bp.waitForSelector('.card[data-type="embed"]', { timeout: 15000 });
await bp.waitForTimeout(1500); // let the SDK mount what it is going to mount

const canvas = await bp.evaluate((lb) => {
  const cards = Array.from(document.querySelectorAll('.card[data-type="embed"]'));
  const q = (s) => document.querySelector(s);
  return {
    heading: q('.card[data-type="heading"] .b')?.textContent,
    text: q('.card[data-type="text"] .sb-md')?.textContent,
    textStrong: q('.card[data-type="text"] .sb-md strong')?.textContent,
    value: q('.card[data-type="value"] .ph')?.textContent,
    eids: cards.map((c) => c.querySelector('.eid')?.textContent?.trim()),
    notes: cards.map((c) => c.querySelector('.embed-note')?.textContent?.trim() || ''),
    // Nothing anywhere should still be showing raw braces.
    bracesInSheet: (q('#sheet')?.textContent || '').includes('{{liveboardId}}'),
    lb,
  };
}, LB);

ok(canvas.heading === 'Sales in West', `heading resolves the default (${canvas.heading})`);
ok(canvas.textStrong === 'West', `text block resolves inside Markdown (${canvas.textStrong})`);
ok(canvas.text?.includes(LB), 'text block resolves a guid default too');
ok(canvas.value?.includes('West'), `value block previews the default (${canvas.value})`);
ok(canvas.value?.includes('{{region}}'), 'value block still names its key');
ok(canvas.eids[0] === LB, `embed header shows the RESOLVED id (${canvas.eids[0]})`);
ok(!canvas.bracesInSheet, 'no raw {{liveboardId}} left anywhere on the canvas');
ok(canvas.notes[0] === '', 'a resolvable variable is treated as a real id, not a missing one');

// NOTE: the canvas cannot be asserted to produce an *iframe* here. The builder only
// init()s the SDK once a cluster is connected ("not initialised — connect a cluster"),
// and these suites are hermetic by design. The published page below does init against
// the local worker, so the guid-reaches-the-SDK half is proved there.

// A variable with no default must NOT be mistaken for a set id, and must say why.
ok(/no default is declared/.test(canvas.notes[1]),
  `and the note names the real problem (${canvas.notes[1]})`);
ok(!/choose a liveboardId/.test(canvas.notes[1]),
  'not "choose a liveboardId" — the field is already set, to a variable');

ok(errors.length === 0, `no builder errors (${errors.join(' | ')})`);

// --- and the published page it is previewing ---------------------------------------
const pg = await b.newPage({ viewport: { width: 1100, height: 900 } });
const warnings = [];
pg.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });
await pg.goto(`${BASE}/p/${PID}/`, { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('.sb-text', { timeout: 10000 });
await pg.waitForFunction(() => document.querySelector('iframe') !== null, null, { timeout: 20000 })
  .catch(() => { /* asserted below */ });

const live = await pg.evaluate(() => ({
  heading: document.querySelector('.sb-heading')?.textContent,
  strong: document.querySelector('.sb-text strong')?.textContent,
  value: document.querySelector('.sb-value-out')?.textContent,
  srcs: Array.from(document.querySelectorAll('iframe')).map((f) => f.getAttribute('src') || ''),
}));

ok(live.heading === canvas.heading, 'published heading matches the canvas');
ok(live.strong === canvas.textStrong, 'published text matches the canvas');
ok(live.value === 'West', `published value block shows the default (${live.value})`);
// The end of the chain: a guid, not the braces, is what the SDK put in the iframe URL.
ok(live.srcs.some((s) => s.includes(LB)), `the SDK got the resolved guid (${live.srcs.join(' | ') || 'no iframe'})`);
ok(!live.srcs.some((s) => s.includes('%7B%7B') || s.includes('{{')), 'no braces reached the SDK');

// --- a host-event payload reads the store too --------------------------------------
await pg.waitForFunction(() => !!window.tsembed, null, { timeout: 30000 });
await pg.evaluate(() => {
  window.__t = [];
  const C = window.tsembed.LiveboardEmbed;
  const orig = C.prototype.trigger;
  C.prototype.trigger = function (ev, payload) {
    window.__t.push({ ev: String(ev), payload });
    try { return orig.apply(this, arguments); } catch { return null; }
  };
});
await pg.click('.sb-btn:text-is("Filter")');
await pg.waitForTimeout(300);
const fired = await pg.evaluate(() => window.__t.filter((t) => /RuntimeFilters/i.test(t.ev)));
ok(
  JSON.stringify(fired[0]?.payload) ===
    JSON.stringify([{ columnName: 'Region', operator: 'EQ', values: ['West'] }]),
  `host-event payload resolves {{region}} (${JSON.stringify(fired[0]?.payload)})`,
);

await pg.click('.sb-btn:text-is("Unset")');
await pg.waitForTimeout(300);
const afterUnset = await pg.evaluate(() => window.__t.filter((t) => /RuntimeFilters/i.test(t.ev)).length);
ok(afterUnset === 1, `a token with no value is not sent as "" (${afterUnset} fires)`);
ok(
  warnings.some((w) => w.includes('{{nope}}') && w.includes('not sent')),
  'and the refusal says which variable is unset',
);

await b.close();

pass.forEach((m) => console.log('  ok   ' + m));
fail.forEach((m) => console.log('  FAIL ' + m));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
