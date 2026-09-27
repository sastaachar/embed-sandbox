/**
 * Verifies the settings panel's config model: the Default config is read-only, a named
 * config shows only its own overrides with the site's values greyed as placeholders,
 * Reset all clears every key of the config in view, and overrides a browser saved on
 * Default before it became read-only are moved into a "local" config.
 *   BASE=http://127.0.0.1:8899 node e2e/settings-check.mjs
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
  body: JSON.stringify({ name: 'settings', thoughtSpotHost: BASE, sdkVersion: '1.51.0' }),
});
const PID = created.body.projectId, TOKEN = created.body.editToken;
await api(`/api/projects/${PID}/config`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    config: {
      thoughtSpotHost: BASE, sdkVersion: '1.51.0', authType: 'None',
      variables: { lbId: { label: 'Liveboard', default: 'SITE-LB' } },
    },
    pages: { '/': { title: 'Settings', blocks: [{ type: 'text', text: 'id={{lbId}}' }] } },
  }),
});

const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
pg.on('pageerror', (e) => errors.push(String(e)));
const URL_ = `${BASE}/p/${PID}/`;

const open = async () => {
  await pg.waitForSelector('.sb-set-fab', { timeout: 15000 });
  await pg.click('.sb-set-fab');
  await pg.waitForSelector('.sb-set-overlay:not([hidden])');
};
const panel = () => pg.evaluate(() => {
  const root = document.querySelector('.sb-set-overlay');
  const inputs = [...root.querySelectorAll('.sb-set-body input, .sb-set-body select')];
  const f = (label) => {
    const lab = [...root.querySelectorAll('.sb-set-f label')].find((l) => l.textContent.startsWith(label));
    const inp = lab && lab.parentNode.querySelector('input, select');
    return inp ? { value: inp.value, placeholder: inp.placeholder || '', disabled: inp.disabled, hint: lab.querySelector('.sb-set-src')?.textContent || '' } : null;
  };
  const btn = (t) => [...root.querySelectorAll('.sb-set-foot button')].find((x) => x.textContent === t);
  return {
    disabledAll: inputs.filter((i) => i.id !== 'sb-dev-toggle').every((i) => i.disabled),
    enabledAll: inputs.every((i) => !i.disabled),
    dev: root.querySelector('#sb-dev-toggle').disabled,
    load: btn('Load').disabled, reset: btn('Reset all').disabled,
    note: root.querySelector('.sb-set-body .sb-set-note')?.textContent || '',
    host: f('ThoughtSpot host'), auth: f('Auth type'), lb: f('Liveboard'),
    authOptions: [...root.querySelector('.sb-set-f select').options].map((o) => o.textContent),
    tabs: [...root.querySelectorAll('.sb-set-tabs button')].map((x) => x.textContent.replace('×', '')),
    activeTab: root.querySelector('.sb-set-tabs button.on')?.textContent.replace('×', ''),
  };
});
const ls = () => pg.evaluate((pid) => Object.keys(localStorage).filter((k) => k.includes(pid)).sort(), PID);
const text = () => pg.evaluate(() => document.body.innerText);

// --- Default is read-only --------------------------------------------------------------
await pg.goto(URL_, { waitUntil: 'domcontentloaded' });
await open();
let p = await panel();
ok(p.activeTab === 'Default', `opens on the Default tab (${p.activeTab})`);
ok(p.disabledAll, 'every input and select is disabled on Default');
ok(!p.dev, 'the dev-mode checkbox stays usable');
ok(p.load && p.reset, 'Load and Reset all are disabled on Default');
ok(p.note.includes('read-only'), `the note says so (${p.note})`);
ok(p.host.value === '' && p.host.placeholder.replace(/\/$/, "") === BASE, `host shows the site value as placeholder (${p.host.placeholder})`);
ok(p.lb.value === '' && p.lb.placeholder === 'SITE-LB', `variable shows the site default as placeholder (${p.lb.placeholder})`);
ok(p.authOptions[0] === 'Default — None', `auth select leads with the inherited type (${p.authOptions[0]})`);
ok((await text()).includes('id=SITE-LB'), 'page renders the site default');

// --- a named config: own overrides only, site values greyed -------------------------------
await pg.click('.sb-set-plus');
await pg.fill('.sb-set-new', 'mine');
await pg.press('.sb-set-new', 'Enter');
await pg.waitForLoadState('domcontentloaded');
await pg.waitForSelector('.sb-set-fab[data-cfg="mine"]', { timeout: 15000 });
await open();
p = await panel();
ok(p.activeTab === 'mine', `new config is active (${p.activeTab})`);
ok(p.enabledAll && !p.load && !p.reset, 'everything is editable on a named config');
ok(p.host.value === '' && p.host.placeholder.replace(/\/$/, "") === BASE, 'host is empty with the site value greyed');
ok(p.lb.value === '' && p.lb.placeholder === 'SITE-LB' && p.lb.hint === '', 'variable is empty with the site default greyed, no source hint');
ok(p.auth.value === '', 'auth type is on the inherited option');
ok(p.note.includes('Empty means'), `the note explains empty = default (${p.note})`);

await pg.fill('.sb-set-f:has(label:text-is("Liveboard")) input', 'MINE-LB');
await pg.click('.sb-set-foot button:text-is("Load")');
await pg.waitForFunction(() => document.body.innerText.includes('id=MINE-LB'), null, { timeout: 15000 });
ok(true, 'Load applies the override');
let keys = await ls();
ok(keys.includes(`sb.var.${PID}@mine.lbId`), `override saved under the config's own key (${keys.join(', ')})`);
ok(!keys.some((k) => k === `sb.init.${PID}` || k.startsWith(`sb.var.${PID}.`)), 'nothing written to the Default keys');
await open();
p = await panel();
ok(p.lb.value === 'MINE-LB' && p.lb.hint.includes('saved'), `reopened: own value shown, marked saved (${p.lb.value} ${p.lb.hint})`);
ok(p.host.value === '' && p.host.placeholder.replace(/\/$/, "") === BASE, 'host still shows as inherited — Load did not copy the site value in');

// --- Reset all sweeps the whole prefix ------------------------------------------------------
await pg.evaluate((pid) => {
  localStorage.setItem(`sb.var.${pid}@mine.ghost`, '"stale"');
  localStorage.setItem(`sb.init.${pid}@mine`, JSON.stringify({ sdkVersion: '1.40.0' }));
  localStorage.setItem(`sb.var.${pid}@other.lbId`, '"keep"');
}, PID);
await pg.click('.sb-set-foot button:text-is("Reset all")');
await pg.waitForLoadState('domcontentloaded');
await pg.waitForSelector('.sb-set-fab', { timeout: 15000 });
keys = await ls();
ok(!keys.some((k) => k.startsWith(`sb.var.${PID}@mine.`) || k === `sb.init.${PID}@mine`),
  `Reset all removed every key of "mine", undeclared ones included (${keys.join(', ')})`);
ok(keys.includes(`sb.var.${PID}@other.lbId`), 'another config\'s keys are untouched');
ok((await text()).includes('id=SITE-LB'), 'page is back on the site default');

// --- Default tab is still read-only after switching back -----------------------------------
await open();
await pg.click('.sb-set-tabs button:text-is("Default")');
await pg.waitForLoadState('domcontentloaded');
await pg.waitForSelector('.sb-set-fab:not([data-cfg])', { timeout: 15000 });
await open();
p = await panel();
ok(p.activeTab === 'Default' && p.disabledAll && p.load, 'switching back to Default is read-only again');

// --- legacy overrides on Default move to "local" -----------------------------------------
const pg2 = await b.newPage();
pg2.on('pageerror', (e) => errors.push(String(e)));
await pg2.addInitScript((pid) => {
  if (localStorage.getItem(`sb.cfg.${pid}`)) return;
  localStorage.setItem(`sb.var.${pid}.lbId`, '"OLD-LB"');
  localStorage.setItem(`sb.init.${pid}`, JSON.stringify({ thoughtSpotHost: 'https://legacy.example' }));
}, PID);
await pg2.goto(`${BASE}/p/${PID}/?fresh=${Date.now()}`, { waitUntil: 'domcontentloaded' });
await pg2.waitForSelector('.sb-set-fab', { timeout: 15000 });
const mig = await pg2.evaluate((pid) => ({
  keys: Object.keys(localStorage).filter((k) => k.includes(pid)).sort(),
  cfg: JSON.parse(localStorage.getItem(`sb.cfg.${pid}`)),
  fab: document.querySelector('.sb-set-fab').getAttribute('data-cfg'),
  text: document.body.innerText,
}), PID);
ok(mig.cfg?.active === 'local' && mig.cfg.names.includes('local'), `legacy Default overrides land in a "local" config (${JSON.stringify(mig.cfg)})`);
ok(mig.keys.includes(`sb.var.${PID}@local.lbId`) && mig.keys.includes(`sb.init.${PID}@local`), `keys were moved (${mig.keys.join(', ')})`);
ok(!mig.keys.includes(`sb.var.${PID}.lbId`) && !mig.keys.includes(`sb.init.${PID}`), 'and the Default keys are gone');
ok(mig.fab === 'local' && mig.text.includes('id=OLD-LB'), `the page opens on "local" and still uses the old value (${mig.fab})`);

ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
await b.close();
console.log(`${pass.length} ok, ${fail.length} failed`);
fail.forEach((m) => console.log('  FAIL', m));
process.exit(fail.length ? 1 : 0);
