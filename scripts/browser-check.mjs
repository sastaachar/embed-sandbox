import { createRequire } from 'node:module';
const require = createRequire(
  process.env.PW_ROOT || '/Users/justin.mathew/Documents/source/Thoughtspot-theme-builder/',
);
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8899';
// Hermetic by default: the SDK points at the local worker, so iframes resolve to
// our own 404 page. Exercises load/init/preRender/attic without a live cluster.
const TS_HOST = process.env.TS_HOST || BASE;
const LB = 'd084c256-e284-4fc4-b80c-111cb606449a';

const pass = [];
const fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * `pre` adds a WARMING counterpart, which is what preRender means: a block that renders
 * nothing and holds a preRenderId hot. The visible embed is an ordinary one that
 * connects to it by carrying the same id.
 */
function page(title, pre, id) {
  const blocks = [
    { type: 'heading', text: title, level: 1 },
    { type: 'text', text: 'Rendered from JSON.' },
    { type: 'buttons', items: [{ label: 'Reload', action: 'reload', variant: 'primary' }] },
  ];
  if (pre) {
    blocks.push({ type: 'embed', embed: { type: 'liveboard', preRender: true,
      config: { liveboardId: LB, preRenderId: id } } });
  }
  blocks.push({ type: 'embed', embed: { type: 'liveboard', fullHeight: true,
    config: { liveboardId: LB, ...(pre ? { preRenderId: id } : {}) } } });
  return { title, blocks };
}

const created = await api('/api/projects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Browser check',
    thoughtSpotHost: TS_HOST,
    sdkVersion: '1.51.0',
    theme: { colorPrimary: '#7b3fe4' },
    header: {
      title: 'Acme Analytics',
      nav: [
        { label: 'Home', to: '/' },
        { label: 'Sales', to: '/sales' },
        { label: 'Q3', to: '/sales/q3' },
      ],
    },
    footer: { text: 'Acme demo footer' },
  }),
});
const pid = created.body.projectId;
const token = created.body.editToken;
console.log('project', pid);

// Each page warms its own id, so navigation exercises several wrappers.
for (const [p, t, pre, id] of [
  ['/', 'Home', true, 'warm-home'],
  ['/sales', 'Sales', true, 'warm-sales'],
  ['/sales/q3', 'Q3 detail', true, 'warm-q3'],
]) {
  await api(`/api/projects/${pid}/pages`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ path: p, page: page(t, pre, id) }),
  });
}

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pg = await ctx.newPage();
process.on('unhandledRejection', () => {});
ctx.on('page', (p) => p.on('dialog', (d) => d.dismiss().catch(() => {})));
pg.on('dialog', (d) => d.dismiss().catch(() => {}));

const runtimeErrors = [];
pg.on('pageerror', (e) => runtimeErrors.push(String(e)));
pg.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // ThoughtSpot auth/network noise from an unauthenticated cluster is expected here.
  if (/tsembed|thoughtspot|401|403|CORS|net::|Failed to load resource|authentication/i.test(t)) return;
  runtimeErrors.push('console: ' + t);
});

const t0 = Date.now();
await pg.goto(`${BASE}/p/${pid}/`, { waitUntil: 'domcontentloaded' });
const domReady = Date.now() - t0;

await pg.waitForSelector('.sb-header:not([hidden]) .sb-title', { timeout: 5000 });
const chromeAt = Date.now() - t0;

ok((await pg.textContent('.sb-title')) === 'Acme Analytics', 'header title renders');
ok((await pg.locator('.sb-nav a').count()) === 3, 'nav has 3 links');
ok((await pg.textContent('.sb-footer')).includes('Acme demo footer'), 'footer renders');
ok((await pg.textContent('h1')) === 'Home', 'page heading renders');
ok((await pg.locator('.sb-btn').count()) === 1, 'button block renders');
ok(
  (await pg.locator('.sb-nav a[aria-current="page"]').first().textContent()) === 'Home',
  'active nav item marked',
);

const perf = await pg.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0] || {};
  const paint = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
  return {
    ttfb: Math.round(n.responseStart || 0),
    domContentLoaded: Math.round(n.domContentLoadedEventEnd || 0),
    fcp: paint ? Math.round(paint.startTime) : null,
    transferHtml: n.transferSize || 0,
  };
});

// SDK + embed lifecycle
let sdkLoaded = false;
try {
  await pg.waitForFunction(() => !!window.tsembed, { timeout: 25000 });
  sdkLoaded = true;
} catch {}
ok(sdkLoaded, 'SDK global loaded from jsDelivr');

let wrapperCount = 0;
let iframeCount = 0;
if (sdkLoaded) {
  try {
    await pg.waitForSelector('[id^="tsEmbed-pre-render-wrapper"]', { timeout: 20000 });
  } catch {}
  await pg.waitForTimeout(4000);
  wrapperCount = await pg.locator('[id^="tsEmbed-pre-render-wrapper"]').count();
  iframeCount = await pg.locator('iframe').count();
}
ok(wrapperCount >= 1, `pre-render wrapper created (found ${wrapperCount})`);
ok(iframeCount >= 1, `embed iframe created (found ${iframeCount})`);

const hostInContent = await pg.locator('.sb-embed .sb-embed-host').count();
ok(hostInContent === 1, 'active page host is mounted in content');

// client-side navigation
await pg.click('.sb-nav a[data-sb-to="/sales"]');
await pg.waitForFunction(() => document.querySelector('h1')?.textContent === 'Sales', { timeout: 5000 });
ok(new URL(pg.url()).pathname === `/p/${pid}/sales`, 'URL updated by pushState');
ok((await pg.textContent('h1')) === 'Sales', 'nav swapped page content');
ok((await pg.locator('.sb-embed .sb-embed-host').count()) === 1, 'host moved to new page');
const atticAfterNav = await pg.locator('#sb-attic .sb-embed-host').count();
ok(atticAfterNav >= 1, `previous page parked in attic (${atticAfterNav})`);

await pg.goBack();
await pg.waitForFunction(() => document.querySelector('h1')?.textContent === 'Home', { timeout: 5000 });
ok((await pg.textContent('h1')) === 'Home', 'back button restores page');

const wrappersAfter = await pg.locator('[id^="tsEmbed-pre-render-wrapper"]').count();
ok(wrappersAfter >= 2, `pre-render warmed other pages too (${wrappersAfter} wrappers)`);

ok(runtimeErrors.length === 0, `no runtime JS errors${runtimeErrors.length ? ': ' + runtimeErrors.join(' | ') : ''}`);

// no-host project renders a helpful note instead of a broken embed
const noHost = await api('/api/projects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'No host' }),
});
const pg2 = await ctx.newPage();
await pg2.goto(`${BASE}/p/${noHost.body.projectId}/`, { waitUntil: 'domcontentloaded' });
await pg2.waitForSelector('h1', { timeout: 5000 });
ok((await pg2.textContent('h1')).length > 0, 'project with no host still renders chrome');

// ---- an UNRELEASED SDK: pkg.pr.new ships a tarball, so we unwrap and serve it ----
const prProj = await api('/api/projects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'pr sdk', thoughtSpotHost: BASE, sdkVersion: 'pr:641' }),
});
ok(prProj.body.projectId !== undefined, 'a project can pin an SDK PR build');
const pg3 = await ctx.newPage();
await pg3.goto(`${BASE}/p/${prProj.body.projectId}/`, { waitUntil: 'domcontentloaded' });
const prSrc = await pg3.evaluate(() =>
  JSON.parse(document.getElementById('sb-manifest').textContent).sdkUrl);
ok(prSrc === '/sdk/pr/641/tsembed.js', `the manifest points at this site's unwrapper (${prSrc})`);
// The SDK script is injected on init(), not at page load, so ask for it.
const prLoaded = await pg3
  .evaluate(() => window.Sandbox.init().then(() => !!window.tsembed, () => !!window.tsembed))
  .catch(() => false);
ok(prLoaded, 'and that PR build really boots — window.tsembed is there');

await browser.close();

console.log('\ntimings (local dev, cold):');
console.log('  TTFB              ', perf.ttfb + 'ms');
console.log('  first paint (FCP) ', perf.fcp + 'ms');
console.log('  DOMContentLoaded  ', perf.domContentLoaded + 'ms');
console.log('  chrome visible    ', chromeAt + 'ms  (header/footer/buttons painted)');
console.log('  html transfer     ', perf.transferHtml + ' bytes');

console.log('\npassed:');
pass.forEach((m) => console.log('  ok   ' + m));
if (fail.length) {
  console.log('\nFAILED:');
  fail.forEach((m) => console.log('  FAIL ' + m));
  process.exit(1);
}
console.log('\nall browser checks passed');
