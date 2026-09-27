/**
 * Verifies the site map: pages become nodes, nav actions and shared value-store keys
 * become edges, and a link to a page that does not exist is reported rather than drawn.
 *   BASE=http://127.0.0.1:8899 node e2e/graph-check.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const api = (p, o) => fetch(BASE + p, o).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const created = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'graph', thoughtSpotHost: BASE }),
});
const PID = created.body.projectId, TOKEN = created.body.editToken;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

const put = await api(`/api/projects/${PID}/config`, {
  method: 'PUT', headers: auth,
  body: JSON.stringify({
    config: {
      thoughtSpotHost: BASE,
      // Chrome links from every page, so they must not drown the real ones.
      header: { show: true, nav: [{ label: 'Home', to: '/' }, { label: 'Detail', to: '/detail' }] },
    },
    pages: {
      '/': { title: 'Home', blocks: [
        { type: 'embed', embed: { type: 'liveboard', config: { liveboardId: 'lb-1' },
          embedEventHandlers: [{ type: 'Data', actions: [{ type: 'set', params: { key: 'region', value: 'payload.region' } }] }] } },
        { type: 'buttons', items: [
          { label: 'Go detail', actions: [{ type: 'nav', params: { to: '/detail' } }] },
          { label: 'Nowhere', actions: [{ type: 'nav', params: { to: '/missing' } }] },
        ]},
      ]},
      '/detail': { title: 'Detail', blocks: [
        { type: 'value', key: 'region', label: 'Region' },
        { type: 'text', text: 'Region is {{region}}.' },
      ]},
      '/other': { title: 'Other', blocks: [{ type: 'text', text: 'Also {{region}}.' }] },
    },
  }),
});
ok(put.status === 200, `document saved (${put.status})`);

const g = (await api(`/api/projects/${PID}/graph`)).body;
const find = (kind, from, to) => g.edges.find(e => e.kind === kind && e.from === from && e.to === to);

ok(g.nodes.length === 3, `one node per page (${g.nodes.length})`);
const home = g.nodes.find(n => n.path === '/');
ok(home.embeds === 1, `nodes count their embeds (${home.embeds})`);
ok(home.writes.join() === 'region', `a set action makes the page a writer (${home.writes})`);
ok(g.nodes.find(n => n.path === '/detail').reads.join() === 'region',
  'a value block and a {{token}} make the page a reader');

ok(!!find('nav', '/', '/detail'), 'a nav action becomes an edge');
ok(find('nav', '/', '/detail').source === 'button', 'tagged with where it came from');
ok(!!find('var', '/', '/detail'), 'writer -> reader becomes a shared-value edge');
ok(!!find('var', '/', '/other'), 'and reaches every reader of that key');
const readerPair = find('var', '/detail', '/other') || find('var', '/other', '/detail');
ok(!!readerPair, 'two pages that only READ the same key are still linked');
ok(readerPair && !find('var', '/other', '/detail') !== !find('var', '/detail', '/other'),
  'and only once, not both ways');

ok(g.danglingLinks.length === 1 && g.danglingLinks[0].to === '/missing',
  `a link to a page that does not exist is reported (${JSON.stringify(g.danglingLinks)})`);
ok(!g.edges.some(e => e.to === '/missing'), 'and never drawn as an edge');

const chrome = g.edges.filter(e => e.source === 'chrome');
ok(chrome.length > 0, `site chrome still produces edges (${chrome.length})`);
ok(chrome.every(e => e.kind === 'nav'), 'all of them nav');

console.log('');
pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall site-map checks passed');
process.exit(fail.length ? 1 : 0);
