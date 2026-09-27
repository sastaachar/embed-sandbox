import { createRequire } from 'node:module';
const require = createRequire(
  process.env.PW_ROOT || '/Users/justin.mathew/Documents/source/agentgroups/',
);
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8899';
// Hermetic: the SDK points at the local worker, so the frame gets a real src without a
// cluster. Pinned SDK, because the guard exists to survive whatever the CDN publishes.
const TS_HOST = process.env.TS_HOST || BASE;
const SDK = process.env.SDK || '1.51.0';
const LB = 'd084c256-e284-4fc4-b80c-111cb606449a';

const pass = [];
const fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

/**
 * HostEvent.Reload blanks the frame and puts the URL back a tick later. The SDK's own
 * version blanks it with `src = ''`, which navigates the frame to the HOST page — and
 * reads back as that page URL too, so a second reload inside the window pins the host
 * page inside its own embed for good. `window`'s `online` fires in bursts on a VPN or
 * Wi-Fi transition and every one triggers a reload, so this is reachable by sitting
 * still. These assertions pin the runtime's replacement (safeReload).
 */
async function api(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}

const created = await api('/api/projects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Reload check', thoughtSpotHost: TS_HOST, sdkVersion: SDK }),
});
const pid = created.body.projectId;
const token = created.body.editToken;

await api(`/api/projects/${pid}/pages`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({
    path: '/',
    page: {
      title: 'Reload',
      blocks: [
        { type: 'heading', text: 'Reload', level: 1 },
        { type: 'buttons', items: [{ label: 'Reload', action: 'reload', variant: 'primary' }] },
        { type: 'embed', embed: { type: 'liveboard', config: { liveboardId: LB } } },
      ],
    },
  }),
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pg = await ctx.newPage();
const pageUrl = `${BASE}/p/${pid}/`;
await pg.goto(pageUrl, { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('#_thoughtspot-embed', { timeout: 20000 });

const attr = () => pg.evaluate(() => {
  const f = document.querySelector('#_thoughtspot-embed');
  return f && f.getAttribute('src');
});
const original = await attr();
ok(!!original && original.startsWith(TS_HOST), 'frame starts on the cluster URL');

// One reload: blanked with about:blank, never with the host page URL.
await pg.evaluate(() => window.dispatchEvent(new Event('online')));
const blanked = await attr();
ok(blanked === 'about:blank', `blanked with about:blank (got ${JSON.stringify(blanked)})`);
await pg.waitForTimeout(300);
ok((await attr()) === original, 'one reload restores the cluster URL');

// Two reloads inside the 100ms window — the shape that used to pin the host page.
await pg.evaluate(() => {
  window.dispatchEvent(new Event('online'));
  setTimeout(() => window.dispatchEvent(new Event('online')), 50);
});
await pg.waitForTimeout(500);
let now = await attr();
ok(now === original, `overlapping reloads restore the cluster URL (got ${now})`);
ok(!String(now).includes('/p/' + pid), 'the sandbox page is never pinned into its own frame');

// The same shape from the supported path: a visitor double-clicking the Reload button.
await pg.click('.sb-btn');
await pg.click('.sb-btn');
await pg.waitForTimeout(500);
now = await attr();
ok(now === original, `double-clicked Reload restores the cluster URL (got ${now})`);

// The frame really is reloadable again afterwards.
await pg.evaluate(() => window.dispatchEvent(new Event('online')));
ok((await attr()) === 'about:blank', 'a later reload still blanks the frame');
await pg.waitForTimeout(300);
ok((await attr()) === original, 'and restores it');

const inner = await pg.evaluate(() => {
  const f = document.querySelector('#_thoughtspot-embed');
  try { return f.contentWindow.location.pathname; } catch (e) { return 'cross-origin'; }
});
ok(inner !== `/p/${pid}/`, `the frame is not showing the host page (${inner})`);

await browser.close();

pass.forEach((m) => console.log('  ok   ' + m));
fail.forEach((m) => console.log('  FAIL ' + m));
console.log(`\n${pass.length}/${pass.length + fail.length} checks passed  ·  project ${pid}`);
process.exit(fail.length ? 1 : 0);
