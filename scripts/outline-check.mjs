/**
 * Verifies the structural outline: node tags, collapsed bulk, and that handler
 * sources describe what actually runs.
 *   BASE=http://127.0.0.1:8899 node scripts/outline-check.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const api = (p, o) => fetch(BASE + p, o).then(r => r.json());

const c = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'outline', namespace: 'Ether', thoughtSpotHost: 'https://acme.thoughtspot.cloud',
    sdkVersion: '1.51.0', theme: { colorPrimary: '#7b3fe4' },
    header: { title: 'Acme', nav: [{ label: 'Home', to: '/' }] }, footer: { text: '© Acme' },
  }),
});
const PID = c.projectId;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${c.editToken}` };
const put = (path, page) => fetch(`${BASE}/api/projects/${PID}/pages`, {
  method: 'PUT', headers: auth, body: JSON.stringify({ path, page }),
}).then(r => r.status);

ok(await put('/', { title: 'Sales',
  modals: { detail: { title: 'Answer detail', blocks: [
    { type: 'value', key: 'answerId' },
    { type: 'embed', embed: { type: 'search', answerId: '{{answerId}}' } }] } },
  blocks: [
    { type: 'heading', text: 'Sales', level: 1 },
    { type: 'buttons', items: [
      { label: 'Reload', action: 'reload' },
      { label: 'West', action: 'set-filter', column: 'Region', values: ['West'] },
      { label: 'Detail', action: 'open-modal', modal: 'detail' },
      { label: 'Pin2', action: 'host-event', hostEvent: 'Pin', embedIndex: 1 },
      { label: 'Home', action: 'nav', to: '/' }] },
    { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-123', fullHeight: true, preRender: true,
      on: { CustomAction: [{ id: 'open-detail', set: { answerId: 'data.embedAnswerData.sessionId' }, openModal: 'detail' }] },
      capture: { RouteChange: 'route' } } },
    { type: 'embed', embed: { type: 'search', dataSource: 'ws-9' } },
  ] }) === 200, 'page saved');

const o = await api(`/api/projects/${PID}/outline?path=/`);
const tags = o.nodes.map(n => n.tag);
const find = (t) => o.nodes.find(n => n.tag === t);

// ---- structure: Header, embeds, Footer ----
ok(tags[0] === 'Header', `Header is first (got ${tags[0]})`);
ok(tags[tags.length - 1] === 'Footer', `Footer is last (got ${tags[tags.length - 1]})`);
ok(tags.filter(t => t.endsWith('Embed')).join(',') === 'LiveboardEmbed,SearchEmbed',
  `embeds tagged with their SDK class in order (${tags.filter(t => t.endsWith('Embed'))})`);
ok(find('LiveboardEmbed').summary === '<LiveboardEmbed liveboardId="lb-123" fullHeight preRender />',
  `collapsed line is a JSX one-liner: ${find('LiveboardEmbed').summary}`);
ok(find('SearchEmbed').summary.includes('dataSource="ws-9"'), 'second embed names its own identifying prop');

// ---- init is project-level and appears exactly once ----
ok(!!o.init, 'init node exists');
ok(!tags.includes('init'), 'init is NOT repeated among the page nodes');
ok(o.init.summary.includes('acme.thoughtspot.cl'), 'init line shows the host');

// ---- bulk is collapsed, not dumped ----
const lb = find('LiveboardEmbed');
const themeGroup = (lb.groups || []).find(g => g.label.startsWith('theme variables'));
ok(!!themeGroup, 'theme variables are a collapsed group');
ok(themeGroup.label === 'theme variables (38)', `group is labelled with a count (${themeGroup?.label})`);
ok(Object.keys(themeGroup.props).every(k => k.startsWith('--ts-var-')), 'group holds only ts-vars');
ok(!JSON.stringify(lb.props).includes('--ts-var-'), 'ts-vars are NOT inline in the main props');
ok(JSON.stringify(lb.props).includes('lb-123'), 'main props still carry the real config');

// ---- handlers show the function that runs ----
const names = (lb.handlers || []).map(h => h.name);
ok(names.includes('onCustomAction'), `on rule became onCustomAction (${names})`);
ok(names.includes('onRouteChange'), `capture became onRouteChange (${names})`);
const fn = lb.handlers.find(h => h.name === 'onCustomAction').source;
ok(fn.includes('payload?.data?.id !== "open-detail"'), 'handler shows the id guard');
ok(fn.includes('Ether.setVariable("answerId", payload.data.embedAnswerData.sessionId)'),
  'handler shows the exact store write, using the project namespace');
ok(fn.includes('Ether.openModal("detail")'), 'handler shows the modal it opens');
const cap = lb.handlers.find(h => h.name === 'onRouteChange').source;
ok(cap === '(payload) => Ether.setVariable("route", payload)', `capture handler is one line: ${cap}`);

// ---- buttons: each is a function ----
const btns = find('Buttons');
ok(btns.children.length === 5, `all buttons listed (${btns.children.length})`);
const src = (label) => btns.children.find(b => b.summary.includes(`"${label}"`)).handlers[0].source;
ok(src('Reload') === '() => embed.trigger(HostEvent.Reload)', `reload: ${src('Reload')}`);
ok(src('West').includes('HostEvent.UpdateFilters') && src('West').includes('"Region"'), 'set-filter shows its payload');
ok(src('Detail') === '() => Ether.openModal("detail")', `open-modal: ${src('Detail')}`);
ok(src('Pin2') === '() => embeds[1].trigger(HostEvent.Pin)', `embedIndex targets embeds[1]: ${src('Pin2')}`);
ok(src('Home') === '() => Ether.go("/")', `nav: ${src('Home')}`);

// ---- modals are their own section, with children ----
ok(o.modals.length === 1 && o.modals[0].tag === 'Modal', 'modal listed separately');
ok(o.modals[0].summary.includes('name="detail"'), 'modal names itself');
ok(o.modals[0].children.some(ch => ch.tag === 'SearchEmbed'), "modal's own embed appears as a child");

// ---- a bare page omits chrome it does not have ----
await put('/bare', { blocks: [{ type: 'text', text: 'just text' }] });
await fetch(`${BASE}/api/projects/${PID}`, { method: 'PATCH', headers: auth,
  body: JSON.stringify({ config: { header: { show: false }, footer: { show: false } } }) });
const bare = await api(`/api/projects/${PID}/outline?path=/bare`);
ok(!bare.nodes.some(n => n.tag === 'Header' || n.tag === 'Footer'),
  'hidden header/footer produce no nodes');
ok(bare.nodes.length === 1 && bare.nodes[0].tag === 'Text', 'bare page is just its content');

// ---- errors ----
ok(await fetch(`${BASE}/api/projects/${PID}/outline?path=/nope`).then(r => r.status) === 404,
  'unknown page is 404');
ok(await fetch(`${BASE}/api/projects/${PID}/outline?path=/`, { method: 'POST' }).then(r => r.status) === 405,
  'outline rejects POST');

pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall outline checks passed');
process.exit(fail.length ? 1 : 0);
