/**
 * Verifies forking: full copy, new token, source untouched, lineage recorded.
 *   BASE=http://127.0.0.1:8899 node scripts/fork-check.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const api = (p, o) => fetch(BASE + p, o).then(r => r.json());
const code = (p, o) => fetch(BASE + p, o).then(r => r.status);

// --- source project with a nested structure and per-page embed configs ---
const src = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Original showcase', thoughtSpotHost: BASE, sdkVersion: '1.51.0',
    theme: { colorPrimary: '#7b3fe4' },
    header: { title: 'Original', nav: [{ label: 'Home', to: '/' }] },
  }),
});
const A = src.projectId, TA = src.editToken;
const authA = { 'content-type': 'application/json', authorization: `Bearer ${TA}` };
for (const [path, title] of [['/', 'Home'], ['/sales', 'Sales'], ['/sales/q3', 'Q3']]) {
  await api(`/api/projects/${A}/pages`, {
    method: 'PUT', headers: authA,
    body: JSON.stringify({ path, page: { title, blocks: [
      { type: 'heading', text: title, level: 1 },
      { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-' + title, preRender: true } },
    ] } }),
  });
}
const before = await api(`/api/projects/${A}`);
ok(before.pages.length === 3, `source has 3 pages (got ${before.pages.length})`);
ok(before.forkedFrom === null, 'source reports no lineage');
ok(typeof before.forkUrl === 'string' && before.forkUrl.includes('/fork/'), 'forkUrl advertised');

// --- fork it, with NO token ---
const res = await fetch(`${BASE}/api/projects/${A}/fork`, { method: 'POST' });
ok(res.status === 201, `fork returns 201 without a token (got ${res.status})`);
const f = await res.json();
const B = f.projectId, TB = f.editToken;
ok(!!B && B !== A, `fork got a new project id (${B})`);
ok(!!TB && TB !== TA, 'fork got a NEW edit token');
ok(f.copiedPages === 3, `fork copied 3 pages (got ${f.copiedPages})`);
ok(f.forkedFrom === A, 'response records lineage');

// --- the copy is faithful ---
const forked = await api(`/api/projects/${B}`);
ok(JSON.stringify(forked.pages) === JSON.stringify(before.pages), 'same page paths');
ok(forked.forkedFrom === A, 'fork reports forkedFrom');
ok(forked.config.thoughtSpotHost === before.config.thoughtSpotHost, 'host copied');
ok(forked.config.sdkVersion === '1.51.0', 'sdkVersion copied');
ok(forked.config.theme.colorPrimary === '#7b3fe4', 'theme copied');
ok(forked.config.name === 'Original showcase (fork)', `name marked as fork ("${forked.config.name}")`);
for (const path of before.pages) {
  const a = await api(`/api/projects/${A}/pages?path=${encodeURIComponent(path)}`);
  const b = await api(`/api/projects/${B}/pages?path=${encodeURIComponent(path)}`);
  ok(JSON.stringify(a.page) === JSON.stringify(b.page), `page ${path} copied byte-for-byte`);
}

// --- tokens are not interchangeable ---
const editB = { 'content-type': 'application/json', authorization: `Bearer ${TB}` };
ok(
  await code(`/api/projects/${A}/pages`, { method: 'PUT', headers: editB,
    body: JSON.stringify({ path: '/hack', page: {} }) }) === 401,
  "fork's token cannot write to the source",
);
ok(
  await code(`/api/projects/${B}/pages`, { method: 'PUT', headers: authA,
    body: JSON.stringify({ path: '/hack', page: {} }) }) === 401,
  "source's token cannot write to the fork",
);

// --- editing the fork leaves the source untouched ---
await api(`/api/projects/${B}/pages`, { method: 'PUT', headers: editB,
  body: JSON.stringify({ path: '/sales', page: { title: 'Changed in fork', blocks: [] } }) });
const srcSales = await api(`/api/projects/${A}/pages?path=/sales`);
const forkSales = await api(`/api/projects/${B}/pages?path=/sales`);
ok(srcSales.page.title === 'Sales', 'source page unchanged after fork edit');
ok(forkSales.page.title === 'Changed in fork', 'fork page changed independently');

// --- fork of a fork ---
const f2 = await api(`/api/projects/${B}/fork`, { method: 'POST' });
ok(f2.forkedFrom === B, 'fork of a fork records the immediate parent');

// --- surfaces ---
ok(await code(`/fork/${A}`) === 200, 'fork landing page serves');
ok(await code(`/fork/zzzzzzzzzzzz`) === 404, 'fork page 404s for unknown project');
ok(await code(`/api/projects/${A}/fork`, { method: 'GET' }) === 405, 'fork rejects GET');

const tools = await api(`/mcp/${B}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TB}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
ok(
  tools.result.tools.some(t => t.name === 'fork_site'),
  `fork_site exposed over MCP (${tools.result.tools.length} tools)`,
);

pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall fork checks passed');
process.exit(fail.length ? 1 : 0);
