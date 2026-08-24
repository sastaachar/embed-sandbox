/**
 * Verifies the whole-app document API: GET /config returns the entire project as
 * one JSON object, PUT /config writes it back. Hermetic — no cluster needed.
 *   BASE=http://127.0.0.1:8899 node scripts/config-check.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const api = async (p, o) => {
  const r = await fetch(BASE + p, o);
  let body = null;
  try { body = await r.json(); } catch { /* empty */ }
  return { status: r.status, body };
};

const created = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'doc', thoughtSpotHost: 'https://acme.thoughtspot.cloud' }),
});
const PID = created.body.projectId, TOKEN = created.body.editToken;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const doc = () => api(`/api/projects/${PID}/config`);
const put = (body, headers = auth) =>
  api(`/api/projects/${PID}/config`, { method: 'PUT', headers, body: JSON.stringify(body) });

// ---- read the whole thing in one call ----
const got = await doc();
ok(got.status === 200, `GET /config succeeds (${got.status})`);
ok(/acme\.thoughtspot\.cloud/.test(got.body.config.thoughtSpotHost || ''), 'the document carries site config');
ok(typeof got.body.pages === 'object' && !Array.isArray(got.body.pages),
  'pages come back as an object keyed by path, not a list of names');
ok(got.body.connection === undefined && got.body.hasSecret === undefined,
  'and no connection state — credentials are not the backend\'s business');

// ---- write the whole thing in one call ----
const saved = await put({
  config: { thoughtSpotHost: 'https://acme.thoughtspot.cloud', header: { title: 'Docs demo' } },
  pages: {
    '/': { title: 'Home', blocks: [{ type: 'heading', text: 'Hi', level: 1 }] },
    '/sales/q3': { title: 'Q3', blocks: [{ type: 'text', text: 'numbers' }] },
  },
});
ok(saved.status === 200 && saved.body.ok, `PUT /config succeeds (${saved.status})`);
ok(saved.body.config.header.title === 'Docs demo', 'the response echoes the saved config');
ok(Object.keys(saved.body.pages).sort().join(',') === '/,/sales/q3', 'both pages are in the document');

const after = await doc();
ok(after.body.pages['/sales/q3'].blocks[0].text === 'numbers', 'a nested page round-trips');
const rendered = await fetch(`${BASE}/p/${PID}/sales/q3`).then(r => r.text());
ok(rendered.includes('numbers'), 'and the public site serves it immediately');

// ---- pages missing from the document are deleted, because PUT means replace ----
await put({ config: after.body.config, pages: { '/': after.body.pages['/'] } });
const pruned = await doc();
ok(Object.keys(pruned.body.pages).join(',') === '/', 'a page left out of the document is removed');
ok(!(await fetch(`${BASE}/p/${PID}/sales/q3`).then(r => r.text())).includes('numbers'),
  'and its content stops being served');

// ---- config is replaced, not merged ----
await put({ config: { thoughtSpotHost: 'https://acme.thoughtspot.cloud' }, pages: pruned.body.pages });
ok((await doc()).body.config.header === undefined || (await doc()).body.config.header.title === undefined,
  'a key dropped from the document is really dropped');

// ---- a bad page rejects the whole write ----
const before = await doc();
const bad = await put({
  config: before.body.config,
  pages: { '/': before.body.pages['/'], '/broken': { blocks: [{ type: 'no-such-block' }] } },
});
ok(bad.status === 400, `an invalid block is rejected (${bad.status})`);
ok(Object.keys((await doc()).body.pages).join(',') === '/',
  'and nothing is half-written — the valid page in the same request did not land either');

// ---- auth ----
ok((await put({ config: {} }, { 'content-type': 'application/json' })).status === 401,
  'writing the document needs the edit token');
ok((await doc()).status === 200, 'reading it does not, because the site is meant to be shared');

// ---- the backend holds app config and nothing else ----
// Credentials live in the browser: the Worker cannot reach a private-IP or self-signed
// cluster anyway, and storing a secret it can never use is pure liability.
ok((await put({ config: before.body.config, pages: before.body.pages,
  connection: { host: 'https://cluster.example.com', username: 'demo_user', secret: 'letmein' } })).status === 200,
  'a stray connection field is ignored rather than rejected');
ok(!JSON.stringify((await doc()).body).includes('letmein'),
  'and no secret is stored anywhere in the document');
ok(!(await fetch(`${BASE}/p/${PID}/`).then(r => r.text())).includes('letmein'),
  'nor in the rendered page, which is public');

ok((await fetch(`${BASE}/api/projects/${PID}/metadata`)).status === 404,
  '/metadata is gone — the backend does not proxy metadata');

// /token is back as the TOKEN PROXY: GET-only, public, minting from the write-only
// server-side connection so the page never carries a credential.
ok((await fetch(`${BASE}/api/projects/${PID}/token`, { method: 'POST', body: '{}' })).status === 405,
  '/token accepts only GET');
const noConn = await fetch(`${BASE}/api/projects/${PID}/token`);
ok(noConn.status === 409 && (await noConn.json()).error.includes('/connect/'),
  'proxy without a stored connection explains the connect page');

// /connection is back for the standalone connect page: GET/PUT only, token-gated,
// secret write-only. It stores a design-time credential server-side; it never mints.
ok((await fetch(`${BASE}/api/projects/${PID}/connection`, {
  method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{}',
})).status === 405, '/connection accepts only GET and PUT');
ok((await fetch(`${BASE}/api/projects/${PID}/connection`)).status === 401,
  '/connection GET requires the edit token');
const connBody = await fetch(`${BASE}/api/projects/${PID}/connection`, {
  headers: { authorization: `Bearer ${TOKEN}` },
}).then((r) => r.text());
ok(!connBody.includes('letmein') && !JSON.parse(connBody).secret,
  '/connection GET never returns a secret');

// ---- shape errors are explained ----
ok((await put({ pages: [] })).status === 400, 'pages must be an object, not an array');

console.log('');
pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall config-document checks passed');
process.exit(fail.length ? 1 : 0);
