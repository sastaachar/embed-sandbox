/**
 * Verifies declarative token auth (step 1: customer's own token endpoint) and that
 * only real AuthType members are accepted.
 *   BASE=http://127.0.0.1:8899 node scripts/auth-check.mjs
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
const code = (p, o) => fetch(BASE + p, o).then(r => r.status);
const mk = (body) => code('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// ---- only real AuthType members are accepted ----
ok(await mk({ authType: 'TrustedAuthTokenCookieless' }) === 201, 'TrustedAuthTokenCookieless accepted');
ok(await mk({ authType: 'EmbeddedSSO' }) === 201, 'EmbeddedSSO accepted');
ok(await mk({ authType: 'OIDC' }) === 201, 'OIDC accepted (real member)');
ok(await mk({ authType: 'Cookieless' }) === 400, 'the invented "Cookieless" is now rejected');
ok(await mk({ authType: 'Basic' }) === 400, 'Basic rejected — it would need credentials in the browser');
ok(await mk({ authType: 'Nonsense' }) === 400, 'unknown authType rejected');

// ---- auth block validation ----
const authBody = (auth, authType = 'TrustedAuthTokenCookieless') => ({
  name: 'auth', thoughtSpotHost: BASE, sdkVersion: '1.51.0', authType, auth,
});
ok(await mk(authBody({ tokenSource: 'endpoint', tokenEndpoint: 'https://acme.test/token' })) === 201,
  'endpoint token source accepted');
ok(await mk(authBody({ tokenSource: 'credentials', username: 'u' })) === 400,
  'credentials source not accepted yet (step 2)');
ok(await mk(authBody({ tokenSource: 'endpoint', tokenEndpoint: 'not-a-url' })) === 400,
  'tokenEndpoint must be an absolute URL');
ok(await mk(authBody({ tokenSource: 'endpoint', tokenEndpoint: 'https://a.test/t', tokenMethod: 'DELETE' })) === 400,
  'tokenMethod limited to GET/POST');
ok(await mk(authBody({ tokenSource: 'endpoint', tokenEndpoint: 'https://a.test/t' }, 'None')) === 400,
  'auth rejected when authType does not use a token');
ok(await mk(authBody({ tokenSource: 'endpoint', tokenEndpoint: 'https://a.test/t' }, 'TrustedAuthToken')) === 201,
  'auth accepted for cookie-based TrustedAuthToken too');

// ---- the runtime builds getAuthToken and actually calls the endpoint ----
// Point the token endpoint at our own worker so the call is observable: /api/projects
// responds 405 to GET, which proves the fetch happened without needing a real IdP.
const proj = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'auth runtime', namespace: 'Ether', thoughtSpotHost: BASE, sdkVersion: '1.51.0',
    authType: 'TrustedAuthTokenCookieless',
    auth: { tokenSource: 'endpoint', tokenEndpoint: `${BASE}/__token`, tokenField: 'data.token' },
  }),
});
const PID = proj.projectId;
await api(`/api/projects/${PID}/pages`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${proj.editToken}` },
  body: JSON.stringify({ path: '/', page: { blocks: [
    { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-1' } }] } }),
});

const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage();
pg.on('dialog', d => d.dismiss().catch(() => {}));

// stub the customer's token endpoint
let tokenCalls = 0;
await pg.route('**/__token', (route) => {
  tokenCalls += 1;
  route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: { token: 'tok-abc-123' } }) });
});

await pg.goto(`${BASE}/p/${PID}/`, { waitUntil: 'domcontentloaded' });
await pg.waitForFunction(() => !!window.tsembed, { timeout: 30000 });
await pg.waitForTimeout(2500);

const cfg = await pg.evaluate(() => {
  const c = window.Ether.initConfig || {};
  return { authType: c.authType, hasFn: typeof c.getAuthToken === 'function', host: c.thoughtSpotHost };
});
ok(cfg.hasFn, 'runtime built a getAuthToken function from config');
ok(cfg.authType === 'AuthServerCookieless',
  `authType resolved to the real enum value (${cfg.authType})`);

const token = await pg.evaluate(() => window.Ether.initConfig.getAuthToken());
ok(token === 'tok-abc-123', `getAuthToken returned the token from the endpoint (${token})`);
ok(tokenCalls > 0, `the customer endpoint was actually called (${tokenCalls}x)`);

// ---- failures surface instead of silently blanking the embed ----
await pg.unroute('**/__token');
await pg.route('**/__token', (route) => route.fulfill({ status: 500, body: 'nope' }));
const failed = await pg.evaluate(() =>
  window.Ether.initConfig.getAuthToken().then(() => 'resolved', (e) => String(e.message)));
ok(/returned 500/.test(failed), `a failing endpoint rejects with a clear message (${failed})`);
ok(/500/.test(String(await pg.evaluate(() => window.Ether.get('authError')))),
  'the failure is recorded at Ether.get("authError")');

// ---- a bad tokenField is reported, not returned as undefined ----
await pg.unroute('**/__token');
await pg.route('**/__token', (route) => route.fulfill({ status: 200,
  contentType: 'application/json', body: JSON.stringify({ nothing: true }) }));
const missing = await pg.evaluate(() =>
  window.Ether.initConfig.getAuthToken().then(() => 'resolved', (e) => String(e.message)));
ok(/no token at "data.token"/.test(missing), `missing token field is reported (${missing})`);

// ---- the token API's buried error is dug out, verbatim shape from a real cluster ----
const proj2 = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'auth-creds', namespace: 'Ether', thoughtSpotHost: 'https://stub.example.com',
    sdkVersion: '1.51.0', authType: 'TrustedAuthTokenCookieless',
    auth: { tokenSource: 'credentials', username: 'ghost', secret: 'nope', secretType: 'password' },
  }),
});
await api(`/api/projects/${proj2.projectId}/pages`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${proj2.editToken}` },
  body: JSON.stringify({ path: '/', page: { blocks: [
    { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-1' } }] } }),
});
const pg2 = await b.newPage();
pg2.on('dialog', d => d.dismiss().catch(() => {}));
await pg2.route('**/api/rest/2.0/auth/token/full', (route) => route.fulfill({
  status: 400, contentType: 'application/json',
  body: JSON.stringify({ error: { message: { debug: {
    code: 10002,
    incident_id_guid: '505acd96-0c00-41aa-b7b5-d6ce36b3e71b',
    trace_id_guid: '505acd96-0c00-41aa-b7b5-d6ce36b3e71b',
    debug: '["Invalid parameter values: {\\"username\\":\\"Specified user does not exist.\\"}"]',
  } } } }),
}));
await pg2.goto(`${BASE}/p/${proj2.projectId}/`, { waitUntil: 'domcontentloaded' });
await pg2.waitForFunction(() => !!window.tsembed, { timeout: 30000 });
await pg2.waitForFunction(() => typeof (window.Ether.initConfig || {}).getAuthToken === 'function',
  { timeout: 15000 });
const buried = await pg2.evaluate(() =>
  window.Ether.initConfig.getAuthToken().then(() => 'resolved', (e) => String(e.message)));
ok(buried.includes('username: Specified user does not exist.'),
  `the error.message.debug.debug blob is dug out into a human message (${buried})`);
ok(buried.includes('incident 505acd96'), 'and carries the incident id for support');
ok(String(await pg2.evaluate(() => window.Ether.get('authError'))).includes('does not exist'),
  'the clean message lands in Ether.get("authError") too');

// ---- the outline shows the generated fetch ----
const o = await api(`/api/projects/${PID}/outline?path=/`);
ok(o.init.summary.includes('getAuthToken'), 'outline flags that init has a getAuthToken');
const src = (o.init.handlers || []).find(h => h.name === 'getAuthToken')?.source || '';
ok(src.includes('__token') && src.includes('b.data.token'),
  `outline shows the real token fetch:\n        ${src.replace(/\n/g, '\n        ')}`);

await b.close();
pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall auth checks passed');
process.exit(fail.length ? 1 : 0);
