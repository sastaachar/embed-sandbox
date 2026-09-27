/**
 * Verifies the dev console: its own ›_ button, close-and-reopen, the ? legend, the
 * filter grammar (glob + regex + ! exclusion), and that one event is one row.
 *   BASE=http://127.0.0.1:8899 node e2e/dev-check.mjs
 * Hermetic: aims the SDK at the local worker, so no live cluster is needed.
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
const status = (p, o) => fetch(BASE + p, o).then(r => r.status);

const c = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Dev console check', thoughtSpotHost: BASE, sdkVersion: '1.51.0' }),
});
const PID = c.projectId;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${c.editToken}` };

// Four host events whose NAMES are what the filter grammar gets tested against:
// two Update*, one Navigate*, and one that neither pattern should reach.
ok(
  await status(`/api/projects/${PID}/pages`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ path: '/', page: { title: 'Dev', blocks: [
      { type: 'buttons', items: [
        { label: 'UF', action: 'host-event', hostEvent: 'UpdateFilters' },
        { label: 'URF', action: 'host-event', hostEvent: 'UpdateRuntimeFilters' },
        { label: 'NAV', action: 'host-event', hostEvent: 'Navigate' },
        { label: 'PIN', action: 'host-event', hostEvent: 'Pin' },
        { label: 'RLD', action: 'host-event', hostEvent: 'Reload' },
      ]},
      { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-AAA' } },
      { type: 'text', text: 'Go to [the second page](/two) from Markdown.' },
    ] } }),
  }) === 200,
  'page with 5 host-event buttons + an embed saved',
);

ok(
  await status(`/api/projects/${PID}/pages`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ path: '/two', page: { title: 'Two', blocks: [
      { type: 'text', text: 'Back to [the first page](/) from Markdown.' },
    ] } }),
  }) === 200,
  'a second page saved, linked from the first in Markdown',
);

const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage();
pg.on('dialog', d => d.dismiss().catch(() => {}));
// Dev mode is per visitor, per project, and lives in localStorage — so preset it
// rather than clicking through the settings panel.
// The saved filter is cleared on the FIRST load only — a reload later in this suite is
// how "the filter is remembered" gets checked.
await pg.addInitScript(`
  localStorage.setItem('sb.dev.${PID}', '1');
  if (!localStorage.getItem('sb.seeded.${PID}')) {
    localStorage.removeItem('sb.devf.${PID}');
    localStorage.setItem('sb.seeded.${PID}', '1');
  }
`);

await pg.goto(`${BASE}/p/${PID}/`, { waitUntil: 'domcontentloaded' });
await pg.waitForFunction(() => !!window.tsembed, { timeout: 30000 });
await pg.waitForTimeout(3000);

const panel = pg.locator('.sb-dev');
const fab = pg.locator('.sb-dev-fab');
const rows = pg.locator('.sb-dev-row');

// --- the console has its own button, like ⚙ and ‹/› ---
ok(await fab.count() === 1, 'dev mode adds one ›_ console button');
ok((await fab.textContent())?.includes('_'), 'the button reads as a console (›_)');
const fabBox = await fab.boundingBox();
const setBox = await pg.locator('.sb-set-fab').boundingBox();
ok(fabBox && setBox && fabBox.x < setBox.x, 'it sits on the LEFT, opposite settings and code');
ok(await panel.isVisible(), 'the panel is open on load when dev mode is on');
ok(fabBox && (await panel.boundingBox()).y + (await panel.boundingBox()).height <= fabBox.y + 2,
  'the panel clears its own button instead of covering it');

// --- close, then reopen from the button, with the log intact ---
await pg.click('.sb-dev-head button:text-is("UF")').catch(() => {});
for (const l of ['UF', 'URF', 'NAV', 'PIN']) { await pg.click(`.sb-btn:text-is("${l}")`); await pg.waitForTimeout(120); }
const beforeClose = await rows.count();
ok(beforeClose > 0, `events are logged (${beforeClose} rows)`);

await pg.click('.sb-dev-head button:text-is("Close")');
ok(!(await panel.isVisible()), 'Close hides the panel');
ok(await fab.count() === 1, 'the button survives a close — it is the way back in');
await pg.click('.sb-btn:text-is("PIN")');
await pg.waitForTimeout(200);
ok(await fab.getAttribute('data-new') !== null, 'an event arriving while closed marks the button');
await fab.click();
ok(await panel.isVisible(), 'the button reopens the panel — no dev-mode off/on round trip');
ok(await fab.getAttribute('data-new') === null, 'opening it clears the mark');
ok(await rows.count() >= beforeClose, `the log survived the close (${await rows.count()} rows)`);
await fab.click();
ok(!(await panel.isVisible()), 'the button closes it again');
await fab.click();

// --- one event is one row ---
// Several classes in the SDK's chain own a trigger() that delegates to the next, and each
// one used to log: four distinct clicks produced eight rows.
const hostNames = await pg.locator('.sb-dev-row[data-dir="host"] .sb-dev-n').allTextContents();
const once = n => hostNames.filter(x => x === n).length;
ok(once('UpdateFilters') === 1, `one click on UF is one row (got ${once('UpdateFilters')}) — ${hostNames.join(',')}`);
ok(once('UpdateRuntimeFilters') === 1, `one click on URF is one row (got ${once('UpdateRuntimeFilters')})`);
ok(once('Navigate') === 1, `one click on NAV is one row (got ${once('Navigate')})`);

// A genuine burst is a different thing from a double-log, and keeps one row with a count.
await pg.evaluate(() => {
  const btn = [...document.querySelectorAll('.sb-btn')].find(b => b.textContent.trim() === 'UF');
  btn.click(); btn.click(); btn.click();
});
await pg.waitForTimeout(300);
const rep = pg.locator('.sb-dev-row[data-dir="host"]:has(.sb-dev-n:text-is("UpdateFilters")) .sb-dev-x');
ok(await rep.count() === 1, `a burst of identical events counts up on ONE row (got ${await rep.count()} counters)`);
const repText = (await rep.first().textContent()).trim();
ok(repText === '×3', `the counter says how many (got "${repText}", expected ×3)`);

// --- a new row arrives marked, and a redraw does not re-mark the log ---
await pg.click('.sb-btn:text-is("NAV")');
await pg.waitForTimeout(150);
ok(await pg.locator('.sb-dev-row[data-fresh]').count() >= 1, 'a row that just arrived is marked fresh');
// Read the row that just arrived, not the first one ever marked — the attribute stays on
// the element, so an old row reports the animation's END state and looks like no colour.
const fresh = await pg.locator('.sb-dev-row[data-fresh]').last().evaluate(e => {
  const cs = getComputedStyle(e);
  const m = /[\d.]+\)$/.exec(cs.backgroundColor.replace(/\s/g, ''));
  return { anim: cs.animationName, alpha: m ? parseFloat(m[0]) : 1, bar: cs.boxShadow };
});
ok(fresh.anim === 'sb-dev-fresh', `and it is the fading animation that runs (${fresh.anim})`);
// The tint is a palette mix, so pin the behaviour rather than one literal colour: it has
// to be PAINTED on arrival (asserting only the animation name let a run pass while the
// row rendered no colour at all), it has to be fading already, and it has to end clear.
ok(fresh.alpha > 0.2, `and the flash is actually painted on arrival (alpha ${fresh.alpha})`);
ok(!!fresh.bar && fresh.bar !== 'none', `with an accent bar down the left (${fresh.bar})`);
await pg.waitForTimeout(500);
const mid = await pg.locator('.sb-dev-row[data-fresh]').last().evaluate(e => {
  const m = /[\d.]+\)$/.exec(getComputedStyle(e).backgroundColor.replace(/\s/g, ''));
  return m ? parseFloat(m[0]) : 1;
});
ok(mid < fresh.alpha, `it starts fading from the first frame, no hold (${fresh.alpha} -> ${mid})`);
await pg.waitForTimeout(1700);
ok(await pg.locator('.sb-dev-row[data-fresh]').last()
  .evaluate(e => getComputedStyle(e).backgroundColor) === 'rgba(0, 0, 0, 0)',
  'and it ends completely clear');
await pg.fill('.sb-dev-q', 'Navigate');
await pg.waitForTimeout(320);
ok(await pg.locator('.sb-dev-row[data-fresh]').count() === 0,
  'a redraw does not re-mark rows you have already seen');
await pg.fill('.sb-dev-q', '');
await pg.waitForTimeout(320);

// --- the ? legend ---
// --- only the two directions worth reading are on out of the box ---
const boxOn = d => pg.locator(`.sb-dev-dirs label:has-text("${d}") input`).isChecked();
ok(await boxOn('host'), 'host is on by default');
ok(await boxOn('embed'), 'embed is on by default');
ok(!(await boxOn('reply')), 'reply is OFF by default — it buried the two lines anyone reads');
ok(!(await boxOn('wire')), 'wire is OFF by default');
ok(!(await boxOn('code')), 'code is OFF by default');
ok(await pg.locator('.sb-dev-seg').count() === 0, 'there is no Only/Hide switch — one box, one meaning');

// An unticked direction must not be RECORDED, or its traffic silently spends the 400-entry
// budget and evicts the host/embed rows you are watching — which reads as "the log cleared".
// Reload is the probe: it logs `host` (ticked) and `reply` (unticked) as one synchronous
// pair, so the received count says exactly how many of the two were kept.
const received = async () => Number((await pg.locator('.sb-dev-count').textContent()).split('/')[1]);
const replyBox = pg.locator('.sb-dev-dirs label:has-text("reply") input');
ok(!(await replyBox.isChecked()), 'reply starts unticked');

// Reload also rebuilds the iframe, so it stirs up embed rows too — compare the DELTA
// between the two phases rather than a fixed number. The one difference is the reply.
let mark = await received();
await pg.click('.sb-btn:text-is("RLD")');
await pg.waitForTimeout(600);
const without = await received() - mark;

await replyBox.check();
await pg.waitForTimeout(300);
ok(await pg.locator('.sb-dev-row[data-dir="reply"]').count() === 0,
  'ticking a direction on cannot recover what already fired — it was never recorded');

mark = await received();
await pg.click('.sb-btn:text-is("RLD")');
await pg.waitForTimeout(600);
const wth = await received() - mark;
ok(wth === without + 1,
  `an unticked direction costs nothing: the same click records one extra row once reply is on (${without} -> ${wth})`);
ok(await pg.locator('.sb-dev-row[data-dir="reply"]').count() >= 1, 'and the reply row is on screen');

await replyBox.uncheck();
await pg.waitForTimeout(200);

ok(!(await pg.locator('.sb-dev-help').isVisible()), 'the legend starts closed');
await pg.click('.sb-dev-qm');
const help = pg.locator('.sb-dev-help');
ok(await help.isVisible(), '? opens the legend');
const helpText = await help.textContent();
ok(/an amber row/.test(helpText), 'the legend explains the fade');
ok(/Stops RECORDING it/.test(helpText), 'the legend says unticking a direction stops recording it');
ok(/something chatty is pushing your rows out/.test(helpText),
  'and explains what a pegged count means');
ok(/A reload starts it fresh/.test(helpText), 'and says a reload starts the log fresh');
ok(!/dashed rule/.test(helpText), 'and no longer promises a cross-reload log');
for (const word of ['host', 'reply', 'embed', 'wire', 'code'])
  ok(helpText.includes(word), `the legend explains "${word}"`);
ok(/HostEvent/.test(helpText), 'it says what a host event is in SDK terms');
ok(/EmbedEvent\.ALL/.test(helpText), 'it says where embed events come from');
ok(/postMessage/.test(helpText), 'it says what wire traffic is');
ok(helpText.includes('2000'), 'it explains the 2000 cap behind the count');
ok(/turns amber when it is full/.test(helpText), 'and that a full log is dropping rows');
ok(/shown/.test(helpText) && /received/.test(helpText), 'it explains the shown/received count');
ok(/!Subscribed/.test(helpText), 'it documents ! exclusion');
ok(/starts with Update/.test(helpText), 'it documents Update* as starts-with');
ok(/ends with Filters/.test(helpText), 'it documents *Filters as ends-with');
ok(/the same as plain text/.test(helpText), 'it says *Filter* and plain text are the same thing');
ok(/\/\^Update\//.test(helpText), 'it documents regex');
ok(/Off by default/.test(helpText), 'it says which directions start off');
ok(!/Only \/ Hide/.test(helpText), 'it no longer mentions a mode that does not exist');
await pg.click('.sb-dev-qm');
ok(!(await help.isVisible()), '? closes it again');

// --- the count reads as shown/received ---
const countText = () => pg.locator('.sb-dev-count').textContent();
ok(/^\d+\/\d+$/.test(await countText()), `the count is shown/received, not a bare number (${await countText()})`);
// Silent eviction is what made a busy page look like it had cleared the log.
ok(await pg.locator('.sb-dev-count[data-full]').count() === 0, 'and it is not flagged full yet');
const capped = await pg.evaluate(() => {
  const c = document.querySelector('.sb-dev-count');
  return { title: c.title, marksFull: /DROPPED/.test(c.title) };
});
ok(!capped.marksFull && /received/.test(capped.title),
  `its tooltip explains the number (${capped.title.slice(0, 60)}…)`);

// --- the filter grammar ---
const shownNames = async () => {
  await pg.waitForTimeout(320);
  return pg.locator('.sb-dev-row .sb-dev-n').allTextContents();
};
const setFilter = async q => {
  await pg.fill('.sb-dev-q', q);
  return shownNames();
};

// The example from the ask, verbatim in spirit: those two, but never that one.
let names = await setFilter('Update*, Navigate*, !Runtime');
ok(names.includes('UpdateFilters'), 'Update* matches UpdateFilters');
ok(names.includes('Navigate'), 'Navigate* matches Navigate');
ok(!names.includes('UpdateRuntimeFilters'), '!Runtime drops UpdateRuntimeFilters even though Update* matched it');
ok(!names.includes('Pin'), 'Pin matches no plain term, so it stays out');

// --- where the * is, is the whole rule ---
names = await setFilter('Update*');
ok(names.includes('UpdateFilters') && names.includes('UpdateRuntimeFilters'),
  'a TRAILING * is "starts with"');
ok(!names.includes('Navigate') && !names.includes('Pin'), 'and it anchors — nothing else gets in');

names = await setFilter('*Filters');
ok(names.includes('UpdateFilters') && names.includes('UpdateRuntimeFilters'),
  'a LEADING * is "ends with"');
ok(!names.includes('Navigate'), 'and Navigate does not end with Filters');

names = await setFilter('*Runtime*');
ok(names.includes('UpdateRuntimeFilters') && !names.includes('UpdateFilters'),
  'a * at BOTH ends is "contains"');

names = await setFilter('Runtime');
ok(names.includes('UpdateRuntimeFilters') && !names.includes('UpdateFilters'),
  'plain text is the same as a * at both ends — matches anywhere');

names = await setFilter('Update*Filters');
ok(names.includes('UpdateFilters') && names.includes('UpdateRuntimeFilters'),
  'a * in the MIDDLE is "starts with … and ends with …"');
ok(!names.includes('Navigate'), 'and still anchors at both ends');

names = await setFilter('/^Nav/');
ok(names.includes('Navigate') && !names.includes('Pin'), 'a regex works and defaults to case-insensitive');

// --- ! takes the same forms ---
names = await setFilter('!Pin');
ok(!names.includes('Pin') && names.includes('UpdateFilters'),
  'an exclusion on its own means "everything but that"');

names = await setFilter('!Update*');
ok(!names.includes('UpdateFilters') && !names.includes('UpdateRuntimeFilters'),
  '!Update* drops everything starting with Update');
ok(names.includes('Navigate') && names.includes('Pin'), 'and leaves the rest alone');

names = await setFilter('!*Filters');
ok(!names.includes('UpdateFilters') && names.includes('Navigate'),
  '!*Filters drops everything ending with Filters');

names = await setFilter('/unterminated(/');
ok(names.length > 0, 'a half-typed regex is ignored rather than blanking the log');
const border = await pg.locator('.sb-dev-q').evaluate(e => e.style.borderColor);
ok(!!border, 'and the box says so');

// --- right-click composes with the grammar ---
await setFilter('');
await pg.locator('.sb-dev-row[data-dir="host"] .sb-dev-n:text-is("Pin")').first().click({ button: 'right' });
await pg.click('.sb-dev-menu button:text-is("Hide Pin")');
await pg.waitForTimeout(320);
ok((await pg.locator('.sb-dev-q').inputValue()) === '!Pin', 'right-click > Hide writes !Pin, the same grammar you would type');
ok(!(await shownNames()).includes('Pin'), 'and it takes effect');

// --- moving around the site does not clear the log; a reload does ---
// The filter stays as the right-click left it, so the later "remembered" check still has
// something to check.
const logged = await rows.count();
ok(logged > 0, `the log has rows to lose (${logged})`);

// A Markdown link into this same site used to be a full page load, which took the log
// with it — and since authors write the project-relative "/two", it was a load of a path
// that is not a page of anything. It routes in place now.
await pg.evaluate(() => { window.__sameDoc = true; });
await pg.click('.sb-text a:text-is("the second page")');
await pg.waitForFunction(() => !!window.Sandbox && window.Sandbox.path === '/two', { timeout: 20000 });
ok(await panel.isVisible(), 'the console is still open after a Markdown link');
ok(await rows.count() >= logged, `the log survived a Markdown link (${await rows.count()} rows)`);
ok(await pg.evaluate(() => window.__sameDoc === true),
  'and it routed in place — the document was never reloaded');
ok(new URL(pg.url()).pathname === `/p/${PID}/two`,
  `and the URL is the project's own page, not a bare /two (${new URL(pg.url()).pathname})`);

await pg.click('.sb-text a:text-is("the first page")');
await pg.waitForFunction(() => !!window.Sandbox && window.Sandbox.path === '/', { timeout: 20000 });
ok(await rows.count() >= logged, `and again coming back (${await rows.count()} rows)`);

// A reload is a fresh start: the log lives in the page, and nothing mirrors it anywhere.
await pg.reload({ waitUntil: 'domcontentloaded' });
await pg.waitForTimeout(2500);
const kept = await pg.evaluate(() => Object.keys(sessionStorage).concat(Object.keys(localStorage))
  .filter(k => k.indexOf('devlog') !== -1));
ok(kept.length === 0, `a reload stores nothing of the log (${JSON.stringify(kept)})`);
ok(await pg.locator('.sb-dev-row .sb-dev-n:text-is("Pin")').count() === 0,
  'and the rows from before the reload are gone');

// --- filter survives a reload, dev mode survives a reload ---
await pg.reload({ waitUntil: 'domcontentloaded' });
await pg.waitForTimeout(2500);
ok(await fab.count() === 1, 'the console button comes back on reload');
ok((await pg.locator('.sb-dev-q').inputValue()) === '!Pin', 'the filter is remembered');

// Dev mode off throws the log away for good — the one thing that should.
await pg.evaluate(() => { document.querySelector('.sb-set-fab').click(); });
await pg.waitForTimeout(400);
await pg.click('#sb-dev-toggle');
await pg.waitForTimeout(300);
ok(await pg.locator('.sb-dev').count() === 0, 'dev mode off removes the panel');
ok(await fab.count() === 0, 'and its button');

await b.close();
pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
