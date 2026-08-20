/**
 * Drives the /edit/<projectId> UI in a real browser.
 * Self-provisioning, so it is safe to run repeatedly.
 *
 *   BASE=http://127.0.0.1:8899 node scripts/editor-check.mjs
 *
 * Needs `playwright` resolvable — point PW_ROOT at any repo that has it.
 */
import { createRequire } from 'node:module';
const require = createRequire(
  process.env.PW_ROOT || '/Users/justin.mathew/Documents/source/Thoughtspot-theme-builder/',
);
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8899';

const pass = [];
const fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

const api = (path, opts) => fetch(BASE + path, opts).then((r) => r.json());

const created = await api('/api/projects', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Editor check', sdkVersion: '1.51.0', header: { title: 'Editor check' } }),
});
const PID = created.projectId;
const TOKEN = created.editToken;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

await api(`/api/projects/${PID}/pages`, {
  method: 'PUT',
  headers: auth,
  body: JSON.stringify({
    path: '/sales/q3',
    page: { title: 'Q3 detail', blocks: [{ type: 'heading', text: 'Q3 detail', level: 1 }] },
  }),
});

const browser = await chromium.launch({ channel: 'chrome' });
const pg = await browser.newPage();

const nativeDialogs = [];
pg.on('dialog', (d) => { nativeDialogs.push(d.type() + ': ' + d.message()); d.dismiss().catch(() => {}); });

const jsErrors = [];
pg.on('pageerror', (e) => jsErrors.push('pageerror: ' + e));
pg.on('console', (m) => {
  if (m.type() !== 'error') return;
  // Deliberate negative tests below produce 400/401 responses; the browser logs
  // those as console errors. Only script-level failures matter here.
  if (/Failed to load resource/i.test(m.text())) return;
  jsErrors.push('console: ' + m.text());
});

/** Records a failure instead of throwing, so one bad wait doesn't hide the rest. */
async function waitOk(page, selector, opts, msg) {
  try {
    await page.waitForSelector(selector, opts);
    pass.push(msg);
    return true;
  } catch {
    fail.push(`${msg} — selector never settled: ${selector} ${JSON.stringify(opts)}`);
    return false;
  }
}

async function waitFnOk(page, fn, opts, msg) {
  try {
    await page.waitForFunction(fn, opts);
    pass.push(msg);
    return true;
  } catch {
    fail.push(`${msg} — condition never became true`);
    return false;
  }
}

async function waitSettled(what) {
  await pg.waitForFunction(
    () => {
      const c = document.getElementById('status').className;
      return c === 'ok' || c === 'err';
    },
    { timeout: 15000 },
  );
  const cls = await pg.evaluate(() => document.getElementById('status').className);
  const text = (await pg.textContent('#status')) || '';
  return { ok: cls === 'ok', text, what };
}

async function expectOk(what) {
  const r = await waitSettled(what);
  ok(r.ok, r.ok ? what : `${what} — editor said: ${r.text}`);
  return r;
}

await pg.goto(`${BASE}/edit/${PID}`, { waitUntil: 'domcontentloaded' });

// --- token gate -----------------------------------------------------------
await pg.fill('#token', 'definitely-not-the-token');
await pg.click('#gateForm button');
await pg.waitForFunction(() => document.getElementById('gateErr').textContent.length > 0, { timeout: 8000 });
ok((await pg.textContent('#gateErr')).includes('not valid'), 'wrong token rejected');
ok(!(await pg.locator('#app').evaluate((el) => el.classList.contains('on'))), 'stays locked on wrong token');

await pg.fill('#token', TOKEN);
await pg.click('#gateForm button');
await pg.waitForSelector('#app.on', { timeout: 8000 });
ok(true, 'correct token unlocks');

const stored = await pg.evaluate(() => ({
  ls: JSON.stringify(localStorage),
  ss: JSON.stringify(sessionStorage),
  cookie: document.cookie,
}));
ok(!stored.ls.includes(TOKEN), 'token NOT stored by default — remembering is opt-in');
ok(!stored.ss.includes(TOKEN), 'token not in sessionStorage');
ok(!stored.cookie.includes(TOKEN), 'token not in cookies');
ok((await pg.inputValue('#token')) === '', 'token input cleared');

// --- edit an existing page ------------------------------------------------
await pg.waitForFunction(() => document.querySelectorAll('#list .row').length > 1, { timeout: 8000 });
await pg.getByRole('button', { name: '/sales/q3', exact: true }).click();
await pg.waitForFunction(() => document.getElementById('editor').value.includes('Q3'), { timeout: 8000 });
const loaded = JSON.parse(await pg.inputValue('#editor'));
ok(loaded.title === 'Q3 detail', `page JSON loaded (got "${loaded.title}")`);

await pg.fill('#editor', JSON.stringify({ ...loaded, title: 'Q3 edited from the UI' }, null, 2));
await pg.click('#save');
await expectOk('page save succeeds');

const persisted = await api(`/api/projects/${PID}/pages?path=/sales/q3`);
ok(persisted.page.title === 'Q3 edited from the UI', 'edit persisted to D1');

const shell = await fetch(`${BASE}/p/${PID}/sales/q3`).then((r) => r.text());
ok(shell.includes('Q3 edited from the UI'), 'edge cache invalidated, site shows the edit');

// --- validation ----------------------------------------------------------
await pg.fill('#editor', '{ this is not json');
await pg.click('#save');
const badJson = await waitSettled('invalid JSON');
ok(!badJson.ok && badJson.text.includes('Not valid JSON'), 'invalid JSON caught client-side');

await pg.fill('#editor', JSON.stringify({ blocks: [{ type: 'embed', embed: { type: 'bogus' } }] }, null, 2));
await pg.click('#save');
const badEmbed = await waitSettled('bad embed type');
ok(
  !badEmbed.ok && badEmbed.text.toLowerCase().includes('embed'),
  `server validation surfaced (got "${badEmbed.text}")`,
);

// --- create --------------------------------------------------------------
await pg.fill('#newPath', '/from-ui');
await pg.click('#add');
const createdMsg = await expectOk('create page from UI');
ok(createdMsg.text.includes('/from-ui'), 'create confirmation survives the page load race');
ok((await api(`/api/projects/${PID}`)).pages.includes('/from-ui'), 'new page in project');

// --- site config merges, not replaces ------------------------------------
await pg.getByRole('button', { name: 'site config', exact: true }).click();
await pg.waitForFunction(() => document.getElementById('editor').value.includes('sdkVersion'), { timeout: 8000 });
const site = JSON.parse(await pg.inputValue('#editor'));
ok(!!site.header, 'site config loaded with header');
await pg.fill('#editor', JSON.stringify({ sdkVersion: '1.50.0' }, null, 2));
await pg.click('#save');
await expectOk('site config save');
const merged = await api(`/api/projects/${PID}`);
ok(merged.config.sdkVersion === '1.50.0', 'site config patch applied');
ok(!!merged.config.header, 'omitted site keys preserved (merge, not replace)');

// --- delete --------------------------------------------------------------
await pg.getByRole('button', { name: '/from-ui', exact: true }).click();
await pg.waitForTimeout(400);

// 1. the dialog appears, and it is ours
await pg.click('#del');
await waitOk(pg, '.ed-modal-backdrop:not([hidden])', { timeout: 5000 }, 'delete opens an in-page dialog');
ok((await pg.textContent('#askTitle').catch(() => '')) === 'Delete page', 'dialog has a real title');
ok(((await pg.textContent('#askMessage').catch(() => '')) || '').includes('/from-ui'),
  'dialog names the page being deleted');
ok(((await pg.textContent('#askMessage').catch(() => '')) || '').includes('cannot be undone'),
  'dialog states the consequence');
ok(await pg.evaluate(() => document.activeElement && document.activeElement.id === 'askCancel'),
  'focus lands on Cancel, so a stray Enter cannot delete');

// 2. Cancel really cancels
await pg.click('#askCancel');
await waitOk(pg, '.ed-modal-backdrop', { state: 'hidden', timeout: 5000 }, 'Cancel closes the dialog');
ok(((await pg.textContent('#status')) || '').includes('cancelled'), 'cancelling says so');
ok((await api(`/api/projects/${PID}`)).pages.includes('/from-ui'), 'cancelled delete left the page alone');

// 3. Escape also cancels
await pg.click('#del');
await pg.waitForSelector('.ed-modal-backdrop:not([hidden])', { timeout: 5000 });
await pg.keyboard.press('Escape');
await waitOk(pg, '.ed-modal-backdrop', { state: 'hidden', timeout: 5000 }, 'Escape cancels the dialog');
ok((await api(`/api/projects/${PID}`)).pages.includes('/from-ui'), 'Escape left the page alone');

// 4. confirming deletes
await pg.click('#del');
await pg.waitForSelector('.ed-modal-backdrop:not([hidden])', { timeout: 5000 });
await pg.click('#askOk');
await waitFnOk(pg, () => document.getElementById('status').textContent.includes('deleted'),
  { timeout: 10000 }, 'confirming performs the delete');
ok(!(await api(`/api/projects/${PID}`)).pages.includes('/from-ui'), 'page deleted from UI');

ok(nativeDialogs.length === 0,
  `no native browser dialog was ever raised${nativeDialogs.length ? ': ' + nativeDialogs.join(' | ') : ''}`);

// --- opt-in token memory ------------------------------------------------
const pg2 = await browser.newPage();
await pg2.goto(`${BASE}/edit/${PID}`, { waitUntil: 'domcontentloaded' });
await pg2.fill('#token', TOKEN);
await pg2.check('#remember');
await pg2.click('#gateForm button');
await pg2.waitForSelector('#app.on', { timeout: 8000 });
ok(await pg2.evaluate((t) => localStorage.getItem('sb-token:' + location.pathname.split('/').pop()) === t, TOKEN),
  'ticking the box stores the token, scoped to this project');

// a reload should skip the gate entirely
await pg2.reload({ waitUntil: 'domcontentloaded' });
await waitOk(pg2, '#app.on', { timeout: 8000 }, 'a remembered token skips the gate on reload');
ok(await pg2.evaluate(() => getComputedStyle(document.getElementById('gate')).display === 'none'),
  'the token prompt is not shown when one is remembered');
ok(await pg2.evaluate(() => !document.getElementById('forget').hidden),
  'a Forget control appears once a token is stored');

// forgetting really forgets
await pg2.click('#forget');
ok(await pg2.evaluate(() => localStorage.getItem('sb-token:' + location.pathname.split('/').pop()) === null),
  'Forget removes the stored token');
await pg2.reload({ waitUntil: 'domcontentloaded' });
await waitOk(pg2, '#gate #token', { timeout: 8000 }, 'after forgetting, the gate asks again');

// a stale stored token must not wedge the page
await pg2.evaluate(() => localStorage.setItem('sb-token:' + location.pathname.split('/').pop(), 'no-longer-valid'));
await pg2.reload({ waitUntil: 'domcontentloaded' });
await pg2.waitForFunction(() => document.getElementById('gateErr').textContent.length > 0, { timeout: 8000 });
ok((await pg2.textContent('#gateErr')).includes('no longer valid'),
  'a revoked stored token falls back to the gate with an explanation');
ok(await pg2.evaluate(() => localStorage.getItem('sb-token:' + location.pathname.split('/').pop()) === null),
  'and the dead token is cleared automatically');
await pg2.close();

ok(jsErrors.length === 0, `no JS errors${jsErrors.length ? ': ' + jsErrors.join(' | ') : ''}`);

await browser.close();

pass.forEach((m) => console.log('  ok   ' + m));
fail.forEach((m) => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall editor checks passed');
console.log(`editor: ${BASE}/edit/${PID}`);
process.exit(fail.length ? 1 : 0);
