/**
 * Verifies the advisory edit lock: the API, the MCP tools, that the published page
 * is NOT touched by it, and the builder's veil with its Edit anyway escape hatch.
 *   BASE=http://127.0.0.1:8899 node e2e/lock-check.mjs
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

const c = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'lock-check', thoughtSpotHost: BASE, sdkVersion: '1.51.0' }),
});
const PID = c.body.projectId;
const TOKEN = c.body.editToken;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

await api(`/api/projects/${PID}/pages`, { method: 'PUT', headers: auth,
  body: JSON.stringify({ path: '/', page: { title: 'Home', blocks: [{ type: 'text', text: 'hello' }] } }) });

// ---- the API ----
let g = await api(`/api/projects/${PID}/lock`);
ok(g.status === 200 && g.body.locked === false, 'a fresh project is unlocked');
ok((await api(`/api/projects/${PID}/lock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 401,
  'acquiring needs the edit token');
const acq = await api(`/api/projects/${PID}/lock`, { method: 'POST', headers: auth,
  body: JSON.stringify({ holder: 'Claude', note: 'adding a Search page' }) });
ok(acq.status === 200 && acq.body.lock.holder === 'Claude', 'lock acquired with a holder');
ok(acq.body.lock.expiresAt - acq.body.lock.at === 300000, 'expiry is 5 minutes from acquisition');
g = await api(`/api/projects/${PID}/lock`);
ok(g.body.locked === true && g.body.lock.note === 'adding a Search page', 'GET shows holder and note publicly');
const v = await api(`/api/projects/${PID}/version`);
ok(v.body.lock && v.body.lock.holder === 'Claude', '/version carries the lock, so pages need no extra request');
const man = await api(`/api/projects/${PID}/manifest`);
ok(man.body.lock && man.body.lock.holder === 'Claude', 'the manifest carries the lock for first paint');

// ---- the published page is NOT touched by the lock (builder-only warning) ----
const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage();
await pg.goto(`${BASE}/p/${PID}/`, { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('.sb-btn, .sb-text, h1', { timeout: 8000 }).catch(() => {});
await pg.evaluate(() => window.dispatchEvent(new Event('focus')));
await pg.waitForTimeout(1500);
ok((await pg.locator('.sb-lock-banner').count()) === 0,
  'a held lock shows nothing on the published page — viewers are not the audience');

// ---- MCP speaks it ----
const rpc = async (name, args) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: { projectId: PID, token: TOKEN, ...args } } }),
  });
  const body = await res.json();
  const text = body?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : body;
};
const mcpLock = await rpc('lock_project', { holder: 'MCP agent' });
ok(mcpLock.ok === true && mcpLock.lock.holder === 'MCP agent', 'lock_project takes the lock over MCP');
const beforeSave = mcpLock.lock.at;
await new Promise((r) => setTimeout(r, 30));
await rpc('save_config', { config: { name: 'lock-check', thoughtSpotHost: BASE, sdkVersion: '1.51.0' } });
const afterSave = await api(`/api/projects/${PID}/lock`);
ok(afterSave.body.locked && afterSave.body.lock.at > beforeSave, 'save_config refreshes a held lock');
const mcpUnlock = await rpc('unlock_project', {});
ok(mcpUnlock.locked === false, 'unlock_project releases it');
ok((await api(`/api/projects/${PID}/lock`)).body.locked === false, 'and the API agrees');

// ---- the builder veil and Edit anyway ----
await api(`/api/projects/${PID}/lock`, { method: 'POST', headers: auth, body: JSON.stringify({ holder: 'Claude' }) });
const pg2 = await b.newPage();
await pg2.goto(`${BASE}/build/${PID}`, { waitUntil: 'domcontentloaded' });
await pg2.fill('#token', TOKEN);
await pg2.click('#gateForm button');
await pg2.waitForSelector('#work.on', { timeout: 10000 });
await pg2.waitForSelector('#lockChip', { timeout: 15000 });
ok((await pg2.textContent('#lockChip')).includes('Claude is editing'),
  'the builder shows a small toolbar chip while an agent holds the lock — no modal, no veil');
ok((await pg2.getAttribute('#lockChip', 'title')).includes('overwritten by the AI overlords'),
  'the risk lives in the tooltip');
ok((await pg2.locator('.lock-veil').count()) === 0, 'nothing overlays the canvas');
await pg2.click('#lockEditAnyway');
await pg2.waitForSelector('#lockChip', { state: 'detached', timeout: 5000 });
ok(true, 'the chip can be dismissed');
// the dismissal must hold across polls while the same lock stands
await pg2.waitForTimeout(5000);
ok(!(await pg2.isVisible('#lockChip').catch(() => false)), 'and stays dismissed while the same lock stands');
// release, then take a fresh lock: the chip must return
await api(`/api/projects/${PID}/lock`, { method: 'DELETE', headers: auth });
await pg2.waitForTimeout(5000);
await api(`/api/projects/${PID}/lock`, { method: 'POST', headers: auth, body: JSON.stringify({ holder: 'Claude' }) });
await pg2.waitForSelector('#lockChip', { timeout: 15000 });
ok(true, 'a fresh lock after release shows it again');

await api(`/api/projects/${PID}/lock`, { method: 'DELETE', headers: auth });
await b.close();
pass.forEach((m) => console.log('  ok   ' + m));
fail.forEach((m) => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall lock checks passed');
process.exit(fail.length ? 1 : 0);
