/**
 * Verifies run-code actions: schema, generated code, and the published runtime — a
 * page-level beforeLoad hook, a button, an embed beforeRender hook, a respond block.
 *   BASE=http://127.0.0.1:8898 node e2e/code-check.mjs
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

const created = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'code', thoughtSpotHost: BASE, sdkVersion: '1.51.0' }),
});
const PID = created.body.projectId, TOKEN = created.body.editToken;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const put = (path, page) => api(`/api/projects/${PID}/pages`, {
  method: 'PUT', headers: auth, body: JSON.stringify({ path, page }),
});
const code = (q) => api(`/api/projects/${PID}/code?${q}`).then((r) => r.body?.code || '');

// ---- schema: what is accepted and what is refused ----
const runCode = (c, extra = {}) => ({ type: 'run-code', params: { code: c, ...extra } });
const named = (name, c, extra = {}) => runCode(c, { name, ...extra });

let r = await put('/', {
  title: 'Code',
  beforeLoad: [named('loadGreeting', "return { greeting: 'hi ' + payload.path };", { store: 'boot' })],
  blocks: [
    { type: 'heading', text: 'Custom code', level: 1 },
    { type: 'text', text: 'Boot said: {{boot.greeting}}' },
    { type: 'buttons', items: [
      { label: 'Shout', actions: [named('shout', "const boot = await getVariable('boot');\nreturn (boot ? boot.greeting : 'none') + '!';", { store: 'shout' })] },
    ] },
    { type: 'value', key: 'shout', label: 'Shout', placeholder: '(click)' },
    { type: 'buttons', items: [
      { label: 'Stamp', actions: [named('stamp',
        "await setVariable('alpha', 1);\nawait setVariable('beta', (await getVariable('alpha')) + 1);\nreturn await getVariable('beta');",
        { store: 'stamped' })] },
      { label: 'Bump', actions: [named('bump',
        "const seen = await getVariable('alpha');\nawait setVariable('gamma', seen === 1 ? 'read across runs' : 'did not see it');\nreturn seen;",
        { store: 'bumped' })] },
    ] },
    { type: 'value', key: 'alpha', label: 'Alpha', placeholder: '(unset)' },
    { type: 'value', key: 'beta', label: 'Beta', placeholder: '(unset)' },
    { type: 'value', key: 'gamma', label: 'Gamma', placeholder: '(unset)' },
  ],
});
ok(r.status === 200, `page with beforeLoad + button run-code saves (${r.status})`);

r = await put('/embed', {
  blocks: [
    { type: 'embed', embed: {
      type: 'liveboard', name: 'main',
      config: { liveboardId: 'lb-static' },
      beforeRender: [named('pickLiveboard', "return { liveboardId: 'lb-from-code', frameParams: { height: 300 } };")],
      embedEventHandlers: [
        { type: 'ApiIntercept',
          actions: [named('noteUrl', 'return payload.input;', { store: 'lastUrl' })],
          respond: named('replyToIntercept', 'return { data: { execute: true } };', { fallback: { data: { execute: true } }, timeout: 5000 }) },
      ],
    } },
  ],
});
ok(r.status === 200, `embed with beforeRender + handler run-code + respond saves (${r.status})`);

r = await put('/bad1', { blocks: [{ type: 'buttons', items: [{ label: 'x', actions: [{ type: 'run-code', params: {} }] }] }] });
ok(r.status === 400, `run-code without code is refused (${r.status})`);
r = await put('/bad2', { blocks: [{ type: 'embed', embed: { type: 'liveboard', config: {}, embedEventHandlers: [{ type: 'Data', respond: { type: 'set', params: { key: 'k' } } }] } }] });
ok(r.status === 400, `respond that is not run-code is refused (${r.status})`);
r = await put('/bad3', { blocks: [{ type: 'buttons', items: [{ label: 'x', actions: [runCode('return 1', { timeout: 5 })] }] }] });
ok(r.status === 400, `timeout out of range is refused (${r.status})`);
r = await put('/bad4', { blocks: [{ type: 'buttons', items: [{ label: 'x', actions: [runCode('return 1', { name: 'not a name' })] }] }] });
ok(r.status === 400, `a name that is not an identifier is refused (${r.status})`);
r = await put('/bad5', { blocks: [{ type: 'buttons', items: [{ label: 'x', actions: [runCode('return 1', { name: 'payload' })] }] }] });
ok(r.status === 400, `a name that would shadow the wrapper is refused (${r.status})`);

const stored = await api(`/api/projects/${PID}/pages?path=${encodeURIComponent('/embed')}`);
const storedEmbed = stored.body?.page?.blocks?.[0]?.embed ?? stored.body?.blocks?.[0]?.embed;
ok(!!storedEmbed?.beforeRender?.length && storedEmbed?.embedEventHandlers?.[0]?.respond?.type === 'run-code',
  'beforeRender and respond survive the round trip');

// ---- a page can replace what the code view shows ----
r = await put('/override', {
  title: 'Override',
  codeOverride: { esm: 'const embed = new AppEmbed("#embed", { pageId: "home" });', note: 'trimmed for the demo' },
  blocks: [{ type: 'embed', embed: { type: 'app', config: { pageId: 'home' } } }],
});
ok(r.status === 200, `a page with a code override saves (${r.status})`);

const overEsm = await api(`/api/projects/${PID}/code?path=%2Foverride&flavor=esm`);
ok(overEsm.body?.overridden === true && overEsm.body.code.startsWith('const embed = new AppEmbed'),
  'the override is served for that flavour, flagged as overridden');
ok(overEsm.body?.note === 'trimmed for the demo', 'the note travels with it');
const overReact = await api(`/api/projects/${PID}/code?path=%2Foverride&flavor=react`);
ok(!overReact.body?.overridden && /export function OverridePage/.test(overReact.body?.code ?? ''),
  'a flavour with no override still comes from the generator');

r = await put('/bad6', { codeOverride: { esm: 42 }, blocks: [] });
ok(r.status === 400, `a non-string override is refused (${r.status})`);

// ---- graph knows what code writes ----
const graph = await api(`/api/projects/${PID}/graph`);
const home = (graph.body?.nodes || []).find((n) => n.path === '/');
ok(!home || (home.writes || []).includes('boot'), 'graph lists the beforeLoad store as a write');

// ---- generated code carries the code at the right place ----
const cdnHome = await code('path=/');
ok(cdnHome.includes("return { greeting: 'hi ' + payload.path"), 'cdn: beforeLoad source is emitted verbatim');
// The block takes the payload — the only thing that varies per call. The other three
// names the sandbox injects are module scope here, so the same body still runs.
ok(cdnHome.includes('async function loadGreeting(payload) {'),
  'cdn: a code block takes only what varies per call');
// cdn indents the page body inside an async IIFE, so these are not line-anchored.
ok(/\bconst context = \{/.test(cdnHome) && /\bfunction getVariable\(key\) \{/.test(cdnHome)
   && /\bfunction setVariable\(key, value\) \{/.test(cdnHome),
  'cdn: context and the store accessors are in scope at module level');
ok(!cdnHome.includes('codeArgs'), 'cdn: no codeArgs wrapper re-injecting what is already in scope');
ok(!/\bvariables\b/.test(cdnHome.slice(cdnHome.indexOf('const context'), cdnHome.indexOf('async function loadGreeting'))
   .replace(/appVariables|setVariable|getVariable/g, '')), 'cdn: no redundant variables snapshot is emitted');
ok(cdnHome.includes('await loadGreeting(payload);'), 'cdn: the call site passes the payload and nothing else');
ok(cdnHome.includes('(async () => {'), 'cdn: page body is wrapped for top-level await');
ok(cdnHome.includes("#out-shout") && cdnHome.includes('await shout('), 'cdn: button code is awaited by name and lands in its span');

const cdnEmbed = await code('path=/embed');
ok(cdnEmbed.includes('async function pickLiveboard(') && cdnEmbed.includes("lb-from-code"), 'cdn: beforeRender emitted under its own name');
ok(/Object\.assign\(embedConfig, result\)/.test(cdnEmbed) && cdnEmbed.includes('new LiveboardEmbed("#embed", embedConfig)'),
  'cdn: config is amended before the constructor');
ok(/embed\.on\(EmbedEvent\.ApiIntercept, async \(payload, responder\) =>/.test(cdnEmbed), 'cdn: responder handler is async with (payload, responder)');
ok(cdnEmbed.includes('responder(await replyToIntercept(payload))'), 'cdn: reply is the awaited return value of the named function');
ok(cdnEmbed.includes('responder({') && cdnEmbed.includes('execute: true'), 'cdn: fallback reply emitted in the catch');
ok(cdnEmbed.includes('await noteUrl(payload)') && cdnEmbed.includes('#out-lastUrl'), 'cdn: handler run-code awaited, store sunk');

const esm = await code('path=/embed&flavor=esm');
ok(esm.includes("import { LiveboardEmbed, EmbedEvent } from '@thoughtspot/visual-embed-sdk'") || esm.includes('EmbedEvent'), 'esm: EmbedEvent imported for the responder');
ok(!esm.includes('(async () => {\n  // Applied') && esm.includes('await (async (payload) => {'), 'esm: hooks awaited (module top-level await)');

const react = await code('path=/embed&flavor=react');
ok(react.includes("import { useState, useEffect } from 'react'"), 'react: useEffect imported for hooks');
ok(react.includes('embedRefBaseConfig') && react.includes('useEffect(() => {') && react.includes('async function pickLiveboard('),
  'react: beforeRender becomes state + effect, named');
ok(/onApiIntercept=\{async \(payload, responder\) =>/.test(react) && react.includes('responder(await'), 'react: responder prop is async and replies');
const reactHome = await code('path=/&flavor=react');
ok(reactHome.includes('await loadGreeting') && reactHome.includes('setBoot('), 'react: beforeLoad effect stores into state');

// ---- runtime: the sandbox actually runs the code ----
const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage({ viewport: { width: 1200, height: 900 } });
const jsErrors = [];
pg.on('pageerror', (e) => jsErrors.push(String(e)));
pg.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });

await pg.goto(`${BASE}/p/${PID}/`, { waitUntil: 'domcontentloaded' });
let booted = false;
try {
  await pg.waitForFunction(() => document.body.textContent.includes('Boot said: hi /'), { timeout: 45000 });
  booted = true;
} catch { /* reported below */ }
ok(booted, 'runtime: beforeLoad ran in the sandbox and its return value interpolates as {{boot.greeting}}');

if (booted) {
  await pg.click('button:has-text("Stamp")');
  let stamped = false;
  try {
    await pg.waitForFunction(
      // Value-block labels render upper-cased, so match without case.
      () => !!document.body && /alpha 1/i.test(document.body.innerText.replace(/\s+/g, ' '))
        && /beta 2/i.test(document.body.innerText.replace(/\s+/g, ' ')),
      { timeout: 40000 });
    stamped = true;
  } catch { /* reported */ }
  const stampText = await pg.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 260));
  ok(stamped, `runtime: setVariable writes reach the store, and getVariable sees a write from the same run${stamped ? '' : ` — saw "${stampText}"`}`);

  if (stamped) {
    await pg.click('button:has-text("Bump")');
    let across = false;
    try {
      await pg.waitForFunction(
        () => !!document.body && /gamma read across runs/i.test(document.body.innerText.replace(/\s+/g, ' ')),
        { timeout: 40000 });
      across = true;
    } catch { /* reported */ }
    ok(across, 'runtime: a later run reads a variable an earlier run wrote (real store, not a snapshot)');
  }

  await pg.click('button:has-text("Shout")');
  let shouted = false;
  try {
    await pg.waitForFunction(() => document.body.textContent.includes('hi /!'), { timeout: 30000 });
    shouted = true;
  } catch { /* reported below */ }
  ok(shouted, 'runtime: button run-code sees variables and stores its return value');
}

await pg.goto(`${BASE}/p/${PID}/embed`, { waitUntil: 'domcontentloaded' });
let src = null;
try {
  await pg.waitForFunction(() => {
    const f = document.querySelector('iframe');
    return f && f.src.includes('lb-from-code');
  }, { timeout: 45000 });
  src = await pg.evaluate(() => document.querySelector('iframe').src);
} catch {
  src = await pg.evaluate(() => (document.querySelector('iframe') || {}).src || document.body.textContent.slice(0, 300));
}
ok(!!src && src.includes('lb-from-code'), `runtime: beforeRender result replaced the liveboardId in the embed config (${String(src).slice(0, 120)})`);

const fatal = jsErrors.filter((e) => !/favicon|net::ERR|Failed to load resource|thoughtspot|SDK/i.test(e));
ok(fatal.length === 0, `no unexpected page errors (${fatal.slice(0, 2).join(' | ')})`);
await b.close();

for (const m of pass) console.log('  ok   ' + m);
for (const m of fail) console.log('  FAIL ' + m);
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
