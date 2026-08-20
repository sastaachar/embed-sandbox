/**
 * Verifies the visual builder: palette, selection, type-driven properties,
 * drag-and-drop into rows/columns, saving, and the metadata picker's fallback.
 *   BASE=http://127.0.0.1:8899 node scripts/builder-check.mjs
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

const c = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'builder', thoughtSpotHost: BASE, sdkVersion: '1.51.0' }),
});
const PID = c.projectId, TOKEN = c.editToken;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
await fetch(`${BASE}/api/projects/${PID}/pages`, { method: 'PUT', headers: auth,
  body: JSON.stringify({ path: '/', page: { title: 'Start', blocks: [
    { type: 'heading', text: 'First', level: 1 },
    { type: 'text', text: 'Second' },
  ] } }) });

const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const jsErrors = [];
pg.on('pageerror', e => { jsErrors.push(String(e)); console.log('  !! page error: ' + String(e).slice(0, 200)); });
pg.on('console', m => {
  if (m.type() !== 'error') return;
  if (/Failed to load resource|tsembed|thoughtspot|vesdk/i.test(m.text())) return;
  jsErrors.push(m.text());
});
pg.on('dialog', d => d.dismiss().catch(() => {}));

await pg.goto(`${BASE}/build/${PID}`, { waitUntil: 'domcontentloaded' });

// A syntax error in the page script shows up as everything below timing out, so
// fail loudly here instead. Template literals eat backslash escapes; this catches it.
await pg.waitForTimeout(300);
if (jsErrors.length) {
  console.log('  FAIL the builder page script did not parse: ' + jsErrors.join(' | '));
  await b.close();
  process.exit(1);
}
ok(true, 'the builder page script parses');

// ---- gate ----
ok(await pg.isVisible('#gate'), 'builder starts behind the token gate');
await pg.fill('#token', 'wrong-token');
await pg.click('#gateForm button');
await pg.waitForFunction(() => (document.getElementById('gateErr')?.textContent || '').length > 0, { timeout: 8000 });
ok((await pg.textContent('#gateErr')).includes('not valid'), 'a bad token is refused');
await pg.fill('#token', TOKEN);
await pg.click('#gateForm button');
await pg.waitForSelector('#work.on', { timeout: 10000 });
ok(true, 'correct token opens the builder');
ok(await pg.evaluate(() => localStorage.length === 1), 'the token is remembered by default, per project');
ok(await pg.evaluate(() => Object.keys(localStorage)[0].endsWith(window.__PID)),
  'under a per-project key, so one token cannot unlock another');
await pg.click('#forget');
ok(await pg.evaluate(() => localStorage.length === 0), 'Forget token clears it');

// ---- canvas reflects the saved page ----
await pg.waitForSelector('.card', { timeout: 8000 });
ok((await pg.locator('.card').count()) === 2, 'existing blocks render as cards');
ok((await pg.textContent('.card h1')) === 'First', 'heading renders its text');

// ---- palette adds blocks ----
const add = (label) => pg.locator('#palette button', { hasText: label }).first().click();
await add('+ Heading');
ok((await pg.locator('.card').count()) === 3, 'palette adds a block');
ok((await pg.locator('.card.sel').count()) === 1, 'the new block is selected');
ok((await pg.textContent('#status')).includes('unsaved'), 'adding marks the page dirty');

// ---- type-driven properties ----
await add('+ Embed');
await pg.waitForSelector('#mask:not([hidden])', { timeout: 5000 });
ok((await pg.textContent('#maskBody h3')) === 'Choose an embed type',
  'adding an Embed asks which type first');
ok((await pg.locator('#maskBody .pick button').count()) === 7, 'all seven embed types offered');
await pg.locator('#maskBody .pick button', { hasText: 'Liveboard' }).first().click();
await pg.waitForTimeout(400);
let labels = () => pg.evaluate(() => [...document.querySelectorAll('#props label')].map(l => l.textContent.trim()));
ok((await labels()).includes('liveboardId'), `liveboard embed asks for liveboardId (${(await labels()).join(', ')})`);
await pg.selectOption('#props select', 'search');
await pg.waitForTimeout(400);
ok((await labels()).includes('dataSource'), 'switching to search asks for dataSource instead');
await pg.selectOption('#props select', 'app');
await pg.waitForTimeout(400);
ok((await labels()).includes('pageId'), 'switching to app asks for pageId');
await pg.selectOption('#props select', 'liveboard');
await pg.waitForTimeout(300);

// ---- the picker degrades honestly with no cluster connection ----
await pg.locator('#props button', { hasText: 'Pick' }).click();
await pg.waitForSelector('#mask:not([hidden])', { timeout: 5000 });
await pg.waitForFunction(
  () => { const t = document.querySelector('.pick')?.textContent || ''; return t && !t.includes('loading'); },
  { timeout: 10000 },
);
const pickMsg = await pg.textContent('.pick');
ok(/not connected to a cluster/i.test(pickMsg) && /paste an id/i.test(pickMsg),
  `picker explains it needs a connection and what to do meanwhile: ${pickMsg.slice(0, 80)}`);
await pg.keyboard.press('Escape');
ok(await pg.isHidden('#mask'), 'Escape closes the picker');

// fill the id by hand and confirm the embed goes live
await pg.fill('#props input[type="text"], #props .field .row input', 'lb-manual');
await pg.keyboard.press('Enter');
await pg.waitForTimeout(600);
ok((await pg.locator('[data-embed]').count()) >= 1,
  'entering an id mounts the embed on the canvas without needing another click');
ok((await pg.inputValue('#props .field .row input')) === 'lb-manual', 'id can be typed when no picker is available');

// ---- embed boxes are resized with the browser's own handle ----
const hostBox = () => pg.evaluate(() => {
  const h = document.querySelector('.card.sel .embed-host, .embed-host');
  const r = h.getBoundingClientRect();
  return { h: Math.round(r.height), w: Math.round(r.width), resize: getComputedStyle(h).resize };
});
let box = await hostBox();
ok(Math.abs(box.h - 340) <= 2, `an embed box starts at the default height (${box.h}px)`);
ok(await pg.evaluate(() => typeof window.interact === 'function'), 'interact.js is loaded for resizing');

// By its own label, not substring: the SDK config box prints the whole config, and
// "fullHeight" inside that JSON matches a case-insensitive "Height".
const heightBox = () =>
  pg.locator('#props .field').filter({ has: pg.locator('label', { hasText: /^Height$/ }) });
const heightField = heightBox().locator('input');
ok(await heightField.count() === 1, 'a selected embed offers a Height field');
ok(await pg.locator('#props .field', { hasText: 'Width' }).locator('input').count() === 1,
  'and a Width field');
await heightField.fill('500px');
await heightField.press('Enter');
await pg.waitForTimeout(500);
box = await hostBox();
ok(Math.abs(box.h - 500) <= 2, `typing a height resizes the box (${box.h}px)`);

// drag the bottom-right corner. Scroll it into view first: a corner below the fold
// means the drag lands nowhere.
const hostLoc = pg.locator('.card.sel .embed-host, .embed-host').first();
await hostLoc.scrollIntoViewIfNeeded();
await pg.waitForTimeout(300);
const hb = await hostLoc.boundingBox();
await pg.mouse.move(hb.x + hb.width - 3, hb.y + hb.height - 3);
await pg.mouse.down();
await pg.mouse.move(hb.x + hb.width - 120, hb.y + hb.height + 90, { steps: 15 });
await pg.mouse.up();
await pg.waitForTimeout(900);
box = await hostBox();
ok(box.h > 540 && box.w < hb.width - 60,
  `dragging the corner resizes both ways (${box.w}×${box.h}, was ${Math.round(hb.width)}×${Math.round(hb.height)})`);
ok((await pg.textContent('#status')).includes('resized'), 'and the status line reports it');
const savedH = await heightBox().locator('input').inputValue();
ok(parseInt(savedH, 10) === box.h, `the drag lands in the Height field (${savedH} vs ${box.h}px)`);

// full height and a fixed height are mutually exclusive, and it says so
await pg.locator('#props label', { hasText: 'Full height' }).click();
await pg.waitForTimeout(400);
ok((await heightBox().count()) === 0, 'turning on Full height removes the Height field');
ok((await pg.textContent('#props')).includes('does not apply'), 'and explains why');
await pg.locator('#props label', { hasText: 'Full height' }).click();
await pg.waitForTimeout(400);
ok((await heightBox().locator('input').inputValue()) === savedH,
  'turning it back off restores the height that was set');

// ---- add a row and drag a block into a column ----
await add('+ Row: 2 side by side');
await pg.waitForTimeout(400);
ok((await pg.locator('.row-wrap').count()) === 1, 'row added');
ok(await pg.evaluate(() => {
  const b = [...document.querySelectorAll('.embed-head .eid')].map(e => e.textContent);
  return b.length > 0;
}), 'embed cards show their id in a clickable header strip');
ok((await pg.locator('.col-wrap').count()) === 2, 'row has two columns');
ok((await pg.locator('.col-wrap.empty').count()) === 2, 'empty columns invite a drop');

// ---- real mouse drag, driven through SortableJS ----
ok(await pg.evaluate(() => typeof window.Sortable === 'function'), 'SortableJS loaded');
ok(await pg.evaluate(() => !!document.querySelector('.sheet').dataset.key === true ||
  document.querySelector('.sheet').dataset.key === ''), 'the sheet is a registered drop container');

async function dragTo(handleSel, targetSel, dy = 20) {
  // Both ends must be on screen: a taller embed can push the drop target above the
  // fold, and then the drag lands on the toolbar and silently does nothing.
  await pg.locator(targetSel).first().scrollIntoViewIfNeeded();
  await pg.locator(handleSel).first().scrollIntoViewIfNeeded();
  await pg.waitForTimeout(150);
  const h = await pg.locator(handleSel).first().boundingBox();
  const t = await pg.locator(targetSel).first().boundingBox();
  await pg.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await pg.mouse.down();
  await pg.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + 8, { steps: 4 });
  await pg.mouse.move(t.x + t.width / 2, t.y + dy, { steps: 25 });
  await pg.mouse.up();
  await pg.waitForTimeout(700);
}

const emptyBefore = await pg.locator('.col-wrap.empty').count();
await dragTo('.sheet > .card .grip', '.col-wrap.empty');
ok((await pg.locator('.col-wrap.empty').count()) < emptyBefore,
  'a real mouse drag moved a block into an empty column');
ok((await pg.locator('.col-wrap .card').count()) >= 1, 'the block now lives inside a column');
ok((await pg.textContent('#status')).includes('unsaved'), 'the move marks the page dirty');

// reordering at the top level
console.log('  .. before reorder: body="' + (await pg.evaluate(() => document.body.className)) +
  '" sheetKey="' + (await pg.evaluate(() => document.querySelector('.sheet')?.dataset.key)) +
  '" cards=' + (await pg.locator('.sheet > .card').count()) +
  ' lastType=' + (await pg.evaluate(() => document.querySelector('.sheet > .card:last-child')?.dataset.type)));
const orderBefore = await pg.evaluate(() =>
  [...document.querySelectorAll('.sheet > .card')].map(c => c.dataset.type).join(','));
await dragTo('.sheet > .card:last-child .grip', '.sheet > .card', 4);
const orderAfter = await pg.evaluate(() =>
  [...document.querySelectorAll('.sheet > .card')].map(c => c.dataset.type).join(','));
ok(orderBefore !== orderAfter, `top-level reorder changed the order (${orderBefore} -> ${orderAfter})`);

// ---- one-click side by side ----
await pg.locator('.embed-head').first().click();
await pg.waitForTimeout(400);
const propBtns = await pg.evaluate(() =>
  [...document.querySelectorAll('#props button')].map(x => x.textContent.trim()));
const selType = await pg.evaluate(() => {
  const c = document.querySelector('.card.sel');
  return c ? c.dataset.type + '@' + c.dataset.loc : 'nothing selected';
});
const sideBtn = pg.locator('#props button', { hasText: 'Embed beside' });
ok(await sideBtn.count() === 1,
  `a selected embed offers "+ Embed beside" (selected=${selType}, buttons=[${propBtns.join(', ')}])`);
if (await sideBtn.count()) { await sideBtn.click(); await pg.waitForTimeout(700); }
ok((await pg.locator('.row-wrap').count()) >= 1, 'the embed got wrapped in a row');
ok((await pg.locator('.row-wrap').first().locator('.col-wrap').count()) === 2,
  'with two columns, so the embeds sit side by side');
ok((await pg.locator('.col-wrap .embed-head').count()) >= 2,
  'both embeds are inside columns of that row');

// ---- full width: the inverse of side by side ----
await pg.locator('.col-wrap .embed-head').first().click();
await pg.waitForTimeout(300);
const fullBtn = pg.locator('#props button', { hasText: 'Full width' });
ok(await fullBtn.count() === 1, 'a block inside a column offers "Full width"');
const rowsPre = await pg.locator('.row-wrap').count();
const rootPre = await pg.locator('.sheet > .card').count();
await fullBtn.click();
await pg.waitForTimeout(600);
ok((await pg.locator('.sheet > .card').count()) > rootPre,
  'the block moved up to the top level, where it spans the full width');
ok((await pg.textContent('#status')).includes('full width'), 'and it says what happened');
const rowsPost = await pg.locator('.row-wrap').count();
ok(rowsPost <= rowsPre, `an emptied row is cleaned up (${rowsPre} -> ${rowsPost})`);

// a top-level block has no Full width button, because it already is
await pg.locator('.sheet > .card').first().click();
await pg.waitForTimeout(300);
ok(await pg.locator('#props button', { hasText: 'Full width' }).count() === 0,
  'a top-level block is not offered Full width');

// ---- rows may not nest ----
await pg.locator('.col-wrap .card').first().click();
await pg.waitForTimeout(300);
const rowsBefore = await pg.locator('.row-wrap').count();
await add('+ Row: 2 side by side');
await pg.waitForTimeout(300);
ok((await pg.textContent('#status')).includes('cannot nest'),
  'adding a row inside a column is refused with an explanation');
ok((await pg.locator('.row-wrap').count()) === rowsBefore,
  `and the row count is unchanged (${rowsBefore})`);

// ---- the picker talks to the cluster itself, not through the Worker ----
const proxyHits = [];
pg.on('request', r => { if (/\/api\/projects\/[^/]+\/metadata/.test(r.url())) proxyHits.push(r.url()); });
const clusterHits = [];
await pg.route('**/api/rest/2.0/**', route => {
  const req = route.request();
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  clusterHits.push({ url: req.url(), body: req.postDataJSON(), auth: req.headers()['authorization'] });
  const body = req.url().includes('auth/token/full')
    ? { token: 'tok-from-browser', expiration_time_in_millis: Date.now() + 300000, valid_for_username: 'demo_user' }
    : [{ metadata_id: 'lb-direct', metadata_name: 'Direct liveboard' }];
  return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
});

await pg.click('#connect');
await pg.waitForSelector('#mask:not([hidden])', { timeout: 5000 });
// By label, not index: the dialog gains fields over time and an index-based fill
// silently puts the password somewhere else.
const connField = (label) => pg.locator('#maskBody .field', { hasText: label }).locator('input');
await connField('Cluster host').fill(BASE);   // same host the project already has: no reload here
await connField('Username').fill('demo_user');
await connField('Password or secret key').fill('letmein');
await pg.locator('#maskBody button', { hasText: 'Connect' }).click();
// The button now colours on the OUTCOME of init(): blue once a host is configured,
// green only on AuthStatus.SUCCESS, red on any other status. A stub cluster cannot
// produce SUCCESS, so do not wait for the tick.
//
// Wait on the tooltip naming the user, not on the class: this project already has a
// host, so it is "filled" before Connect is even opened and waiting on that returns
// immediately — which read the tooltip before the connect had happened.
await pg.waitForFunction(
  () => /as demo_user/.test(document.getElementById('connect')?.title || ''),
  { timeout: 10000 });
const login = clusterHits.find(h => h.url.includes('auth/token/full'));
ok(!!login, 'Connect logs in against the cluster from the browser');
ok(login && login.body.password === 'letmein' && login.body.validity_time_in_sec === 300,
  'sending the credential straight to the cluster, with a short validity');
const initBtn = await pg.textContent('#connect');
const initCls = await pg.getAttribute('#connect', 'class');
ok(initBtn.includes('Init'), `the toolbar button is the init() one (${initBtn.trim()})`);
ok(!initBtn.includes('demo_user'), 'and it does not put the username in the label');
const initTitle = (await pg.getAttribute('#connect', 'title')) || '';
ok(initTitle.includes('demo_user'), `who it connected as belongs in the tooltip (${initTitle})`);
ok(initCls !== 'linked', `no green without AuthStatus.SUCCESS against a stub cluster (${initCls})`);
ok(initBtn.trim() === 'Init', 'and no tick either');

await pg.locator('.embed-head').first().click();
await pg.waitForTimeout(300);
await pg.locator('#props button', { hasText: 'Pick' }).click();
await pg.waitForSelector('#mask:not([hidden])', { timeout: 5000 });
await pg.waitForFunction(
  () => (document.querySelector('.pick')?.textContent || '').includes('Direct liveboard'),
  { timeout: 10000 },
);
const search = clusterHits.find(h => h.url.includes('metadata/search'));
ok(!!search, 'Pick… searches the cluster directly');
ok(search && search.auth === 'Bearer tok-from-browser', 'using the token this tab just minted');
ok(search && search.body.metadata[0].type === 'LIVEBOARD', 'for the type the field needs');
ok(proxyHits.length === 0, `and never goes through the Worker proxy (${proxyHits.length} hits)`);
await pg.locator('.pick button').first().click();
await pg.waitForTimeout(300);
ok((await pg.inputValue('#props .field .row input')) === 'lb-direct', 'picking one fills the id in');

// ---- save round-trips ----
await pg.click('#save');
await pg.waitForFunction(() => document.getElementById('status')?.textContent === 'saved', { timeout: 10000 });
const saved = await api(`/api/projects/${PID}/pages?path=/`);
const kinds = saved.page.blocks.map(bl => bl.type);
ok(kinds.includes('row'), `row persisted (${kinds.join(', ')})`);
const rowBlock = saved.page.blocks.find(bl => bl.type === 'row');
ok(rowBlock.columns.some(col => (col.blocks || []).length > 0), 'the column keeps its dropped block');
ok(saved.page.blocks.some(bl => bl.type === 'embed') ||
   rowBlock.columns.some(col => col.blocks.some(x => x.type === 'embed')),
   'the embed persisted somewhere');

// ---- delete a block ----
const before = await pg.locator('.card').count();
await pg.locator('.sheet > .card').first().click();
await pg.locator('#props button', { hasText: 'Delete' }).click();
await pg.waitForTimeout(400);
ok((await pg.locator('.card').count()) < before, 'Delete removes the selected block');

// ---- JSON opens in place, and carries the full state of the current page ----
ok(await pg.locator('#json').count() === 1, 'the toolbar has a JSON button, not a link to another tab');
await pg.click('#json');
await pg.waitForSelector('#jsonText', { timeout: 5000 });
ok(await pg.locator('.sheet').count() === 0, 'it replaces the canvas in place rather than opening a tab');
const shownJson = JSON.parse(await pg.inputValue('#jsonText'));
ok(Array.isArray(shownJson.blocks), 'it shows the current page as JSON');
const flat = JSON.stringify(shownJson);
ok(flat.includes('"row"') && flat.includes('columns'), 'rows and their columns are in it');
ok(/"height":"\d+px"/.test(flat.replace(/\s/g, '')), 'so are embed sizes — enough to recreate the page');

shownJson.blocks.push({ type: 'text', text: 'added via JSON' });
await pg.fill('#jsonText', JSON.stringify(shownJson, null, 2));
await pg.click('#jsonApply');
await pg.waitForTimeout(1200);
const afterJson = await api(`/api/projects/${PID}/config`);
ok(JSON.stringify(afterJson.pages['/']).includes('added via JSON'), 'editing it saves through the document API');
await pg.fill('#jsonText', '{ not json');
await pg.click('#jsonApply');
ok((await pg.textContent('#jsonErr')).length > 0, 'and a parse error is shown instead of being swallowed');
await pg.locator('#jsonPane button', { hasText: 'Revert' }).click();
await pg.click('#json');
await pg.waitForTimeout(600);
ok(await pg.locator('.sheet').count() === 1, 'closing it returns to the canvas');
ok((await pg.textContent('.sheet')).includes('added via JSON'), 'and the canvas reflects the JSON edit');

// ---- pages ----
await pg.click('#newPage');
await pg.waitForSelector('#mask:not([hidden])', { timeout: 5000 });
await pg.fill('#maskBody input', '/from-builder');
await pg.locator('#maskBody button', { hasText: 'Create' }).click();
await pg.waitForFunction(() => (document.getElementById('status')?.textContent || '').includes('created'), { timeout: 10000 });
ok((await api(`/api/projects/${PID}`)).pages.includes('/from-builder'), 'a page can be created from the builder');
ok((await pg.locator('#pageSel option').count()) === 2, 'the page selector updates');

// ---- embeds do not steal clicks while arranging ----
ok(await pg.evaluate(() => {
  const w = document.querySelector('[id^="tsEmbed-pre-render-wrapper"]');
  return w ? getComputedStyle(w).pointerEvents === 'none' : true;
}), 'live embeds are click-through, so cards stay selectable');
await pg.click('#interact');
ok(await pg.evaluate(() => {
  const w = document.querySelector('[id^="tsEmbed-pre-render-wrapper"]');
  return w ? getComputedStyle(w).pointerEvents === 'auto' : true;
}), 'the Interact toggle hands clicks back to the embeds');
ok((await pg.getAttribute('#interact', 'aria-pressed')) === 'true', 'Interact reports its state');
await pg.click('#interact');

// ---- changing the cluster host repoints the demo, and says so ----
await pg.click('#connect');
await pg.waitForSelector('#mask:not([hidden])', { timeout: 5000 });
await connField('Cluster host').fill('https://other.example.test');
await connField('Username').fill('demo_user');
await connField('Password or secret key').fill('letmein');
// the SDK version is offered here too, and picking one reloads the builder
await connField('SDK version').fill('1.51.0');
// "Disconnect" also contains "Connect" once a connection exists
await pg.locator('#maskBody button.primary').click();
// Caught as it is set: the auth emitter overwrites the status moments later, because
// the fake host cannot authenticate.
const reinit = await pg.waitForFunction(
  () => /re-initialised/.test(document.getElementById('status')?.textContent || ''),
  { timeout: 10000 }).then(() => true, () => false);
let hostNow = '';
for (let i = 0; i < 20; i++) {
  hostNow = (await api(`/api/projects/${PID}/config`)).config?.thoughtSpotHost || '';
  if (hostNow.includes('other.example.test')) break;
  await pg.waitForTimeout(250);
}
ok(hostNow.includes('other.example.test'),
  `a new host in Connect becomes the demo's thoughtSpotHost (${hostNow})`);
// Re-init happens in place. A reload would drop back to the token gate AND throw away
// the cluster credential this tab holds in memory, which is what broke "Pick…".
await pg.waitForTimeout(1200);
ok(!(await pg.isVisible('#gate')), 'the builder stays open — no reload back to the token gate');
ok(reinit, 'and it says the embeds were re-initialised against the new host');

ok(jsErrors.length === 0, `no JS errors${jsErrors.length ? ': ' + jsErrors.join(' | ') : ''}`);

await b.close();
pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall builder checks passed');
console.log(`builder: ${BASE}/build/${PID}`);
process.exit(fail.length ? 1 : 0);
