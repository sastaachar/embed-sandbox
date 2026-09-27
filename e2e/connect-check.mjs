/**
 * The Connect dialog, in a real browser: how you get into it (a link that carries the
 * edit token in its fragment) and what comes out of it (the publish-credential toggle,
 * which used to be overwritten by its own save).
 *   BASE=http://127.0.0.1:8899 node e2e/connect-check.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(
  process.env.PW_ROOT || '/Users/justin.mathew/Documents/source/Thoughtspot-theme-builder/',
);
const { chromium } = require('playwright');
const { createServer } = await import('node:http');

const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const api = (p, o) => fetch(BASE + p, o).then(r => r.json());

const b = await chromium.launch({ channel: 'chrome' });
const fresh = async () => {
  const pg = await b.newPage({ viewport: { width: 1400, height: 900 } });
  pg.on('pageerror', e => console.log('  !! page error: ' + String(e).slice(0, 200)));
  pg.on('dialog', d => d.dismiss().catch(() => {}));
  return pg;
};

// =========================================================== the way in

const c = await api('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'connect-link', thoughtSpotHost: BASE, sdkVersion: '1.51.0' }) });
const PID = c.projectId, TOKEN = c.editToken;

// Connecting a cluster is a builder dialog, not a page of its own.
const urls = await api(`/api/projects/${PID}`);
ok(urls.connectUrl === `${BASE}/build/${PID}#connect=1`,
  `connectUrl points at the builder (${urls.connectUrl})`);

const pg1 = await fresh();
await pg1.goto(`${BASE}/build/${PID}#t=${TOKEN}&connect=1`, { waitUntil: 'domcontentloaded' });
await pg1.waitForSelector('#publishCred', { timeout: 20000 });
ok(true, 'the link opens the builder with the Connect dialog already up');
ok(!(await pg1.$('#gateForm')), 'and goes straight in — no token gate');
ok(pg1.url() === `${BASE}/build/${PID}`, `the token is gone from the address bar (${pg1.url()})`);
ok(await pg1.evaluate(() => location.hash === ''), 'the fragment is emptied, not just hidden');
ok(!(await pg1.content()).includes(TOKEN.slice(0, 20)), 'and the token is not left in the DOM');

// Stripping the URL would strand a refresh, so the link's token is remembered.
await pg1.reload({ waitUntil: 'domcontentloaded' });
await pg1.waitForSelector('#connect', { timeout: 20000 });
ok(!(await pg1.$('#gateForm')), 'a refresh does not bounce back to the gate');
ok(!(await pg1.$('#publishCred')), 'and the dialog does not reopen on its own');

// The old /connect/<id> link still lands somewhere useful.
const pg2 = await fresh();
await pg2.goto(`${BASE}/connect/${PID}#t=${TOKEN}`, { waitUntil: 'domcontentloaded' });
await pg2.waitForSelector('#publishCred', { timeout: 20000 });
ok(pg2.url() === `${BASE}/build/${PID}`, `the old connect URL forwards into the builder (${pg2.url()})`);
ok(!(await pg2.$('#gateForm')), 'carrying the token with it');

// A link is not a way past the gate.
const pg3 = await fresh();
await pg3.goto(`${BASE}/build/${PID}#connect=1`, { waitUntil: 'domcontentloaded' });
await pg3.waitForSelector('#gateForm', { timeout: 20000 });
ok(true, 'no token in the link still lands on the token gate');
ok(!(await pg3.$('#publishCred')), 'and no dialog leaks out behind it');

const pg4 = await fresh();
await pg4.addInitScript(([k, v]) => localStorage.setItem(k, v), [`sb.tok.${PID}`, TOKEN]);
await pg4.goto(`${BASE}/build/${PID}#t=deadbeefdeadbeef&connect=1`, { waitUntil: 'domcontentloaded' });
await pg4.waitForSelector('#connect', { timeout: 20000 });
ok(!(await pg4.$('#gateForm')), 'a bad link falls back to the remembered token instead of locking out');
ok(await pg4.evaluate(([k]) => !!localStorage.getItem(k), [`sb.tok.${PID}`]),
  'and the good remembered token survives the bad link');

// ==================================================== what comes out of it

// Regression: PUT /connection used to force tokenSource "proxy" unconditionally, so the
// publish toggle was overwritten by the very Connect click that set it — the live site
// kept calling the token proxy and the checkbox read back off.
const stub = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*',
    'access-control-allow-headers': '*' });
  res.end(JSON.stringify({ token: 'tok-1', expiration_time_in_millis: Date.now() + 300000 }));
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubHost = `http://localhost:${stub.address().port}`;

const c2 = await api('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'connect-publish', thoughtSpotHost: stubHost, sdkVersion: '1.51.0' }) });
const P2 = c2.projectId;

const pg5 = await fresh();
await pg5.goto(`${BASE}/build/${P2}#t=${c2.editToken}&connect=1`, { waitUntil: 'domcontentloaded' });
await pg5.waitForSelector('#publishCred', { timeout: 20000 });

const fill = async (label, value) => {
  const el = (await pg5.evaluateHandle((l) => {
    const f = [...document.querySelectorAll('label,.field')].find(x => x.textContent.trim().startsWith(l));
    return f ? f.querySelector('input,select') : null;
  }, label)).asElement();
  if (!el) throw new Error(`no field for ${label}`);
  await el.fill(value);
};
await fill('Cluster host', stubHost);
await fill('Username', 'svc_embed');
await fill('Password or secret key', 'super-secret-1');

// The toggle is meaningless without a token auth type, and says so rather than
// accepting a tick that quietly does nothing.
ok(await pg5.$eval('#publishCred', e => e.disabled), 'the toggle is disabled for a non-token auth type');
await pg5.evaluate(() => {
  const s = [...document.querySelectorAll('select')]
    .find(x => [...x.options].some(o => o.value === 'TrustedAuthTokenCookieless'));
  s.value = 'TrustedAuthTokenCookieless';
  s.dispatchEvent(new Event('change', { bubbles: true }));
});
await pg5.waitForTimeout(200);
ok(!(await pg5.$eval('#publishCred', e => e.disabled)), 'and enabled once one is picked');

await pg5.check('#publishCred');
// The toolbar has a "Connect" button too — this one has to be the dialog's.
await pg5.evaluate(() => {
  const scope = document.querySelector('#publishCred').closest('form, .modal, div[class*="dlg"]')
    || document.querySelector('#publishCred').parentElement.parentElement;
  [...scope.querySelectorAll('button.primary')].find(x => x.textContent.trim() === 'Connect').click();
});
await pg5.waitForTimeout(3000);

const cfg = await api(`/api/projects/${P2}/config`);
ok(cfg.config.auth?.tokenSource === 'credentials',
  `the toggle survives its own save (auth = ${JSON.stringify(cfg.config.auth)})`);
ok(cfg.config.auth?.secret === 'super-secret-1', 'the typed secret is what got published');

// A successful login closes the dialog. Reopening is the real test: the checkbox is
// prefilled from the SAVED config, which is exactly what used to read back off.
if (!(await pg5.$('#publishCred'))) {
  await pg5.click('#connect');
  await pg5.waitForSelector('#publishCred', { timeout: 10000 });
}
ok(await pg5.$eval('#publishCred', e => e.checked), 'and reopening Connect shows it still ticked');

stub.close();
await b.close();
pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(fail.length ? '\nFAILURES' : '\nall connect-dialog checks passed');
process.exit(fail.length ? 1 : 0);
