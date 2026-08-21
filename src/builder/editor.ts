/**
 * Token-gated JSON editor, served at /edit/<projectId>.
 *
 * Deliberately separate from /p/<projectId>/ — nothing on the public site links
 * here, and this page never renders an embed. The edit token lives in a closure
 * variable for the life of the tab and is never written to storage or a cookie.
 */
export function renderEditor(projectId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Edit · ${projectId}</title>
<style>
:root{--bg:#ffffff;--surface:#f6f7f9;--ink:#15181d;--muted:#5c6470;--line:#e3e6ea;
--accent:#2770ef;--danger:#c0392b;--ok:#1f7a4d;--radius:8px}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--surface:#1b1e23;--ink:#e8e6e1;
--muted:#9aa0a8;--line:#2a2d33;--accent:#5b95f5;--danger:#e06055;--ok:#4fae7d}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
height:100vh;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line);flex:0 0 auto}
header h1{font-size:14px;margin:0;font-weight:600}
header .id{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
header .sp{flex:1}
a{color:var(--accent)}
button{font:inherit;font-size:13px;padding:6px 12px;border-radius:var(--radius);border:1px solid var(--line);
background:var(--bg);color:var(--ink);cursor:pointer}
button:hover{background:var(--surface)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:550}
button.danger{color:var(--danger);border-color:var(--danger)}
button:disabled{opacity:.5;cursor:not-allowed}
input{font:inherit;font-size:13px;padding:7px 10px;border-radius:var(--radius);border:1px solid var(--line);
background:var(--bg);color:var(--ink)}
#gate{flex:1;display:flex;align-items:center;justify-content:center;padding:24px}
#gate form{max-width:380px;width:100%;display:flex;flex-direction:column;gap:10px}
#gate h2{margin:0;font-size:16px}
#gate p{margin:0;color:var(--muted);font-size:13px}
#app{flex:1;display:none;min-height:0}
#app.on{display:flex}
aside{width:240px;flex:0 0 auto;border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
aside .list{flex:1;overflow-y:auto;padding:8px}
aside .row{display:block;width:100%;text-align:left;border:0;background:none;padding:7px 10px;border-radius:var(--radius);
font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--ink);cursor:pointer}
aside .row:hover{background:var(--surface)}
aside .row[aria-current="true"]{background:var(--surface);font-weight:600}
aside .sect{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
padding:10px 10px 4px;font-weight:700}
aside .foot{border-top:1px solid var(--line);padding:8px;display:flex;gap:6px}
aside .foot input{flex:1;min-width:0;font-family:ui-monospace,Menlo,monospace;font-size:12px}
main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
main .bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line)}
main .bar .path{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;color:var(--muted);flex:1;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
textarea{flex:1;width:100%;border:0;outline:none;resize:none;padding:14px 16px;background:var(--bg);color:var(--ink);
font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;tab-size:2}
#status{padding:8px 14px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted);min-height:34px;
white-space:pre-wrap}
#status.err{color:var(--danger)}
#status.ok{color:var(--ok)}
.hint{color:var(--muted);font-size:12px;padding:0 14px 10px}
.tabs{display:flex;gap:4px;margin-right:4px}
.tab{font-size:12.5px;padding:5px 11px;border-radius:var(--radius);border:1px solid transparent;
background:none;color:var(--muted)}
.tab[aria-selected="true"]{background:var(--surface);border-color:var(--line);color:var(--ink);font-weight:600}
#codeWrap{flex:1;display:none;flex-direction:column;min-height:0}
#codeWrap.on{display:flex}
#code{flex:1;margin:0;overflow:auto;padding:14px 16px;background:var(--surface);
font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.55;
white-space:pre;tab-size:2}
#editor.off{display:none}
#outline{flex:1;overflow:auto;padding:12px 14px;display:none;flex-direction:column;gap:2px}
#outline.on{display:flex}
.ol-line{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;
padding:4px 6px;border-radius:5px;color:var(--ink);white-space:pre-wrap;word-break:break-word}
.ol-node>summary{list-style:none;cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
font-size:12.5px;padding:4px 6px;border-radius:5px;color:var(--ink);display:flex;gap:8px;align-items:baseline}
.ol-node>summary::-webkit-details-marker{display:none}
.ol-node>summary::before{content:"▸";color:var(--muted);font-size:10px;flex:0 0 auto}
.ol-node[open]>summary::before{content:"▾"}
.ol-node>summary:hover{background:var(--surface)}
.ol-body{margin:2px 0 6px 18px;padding-left:10px;border-left:1px solid var(--line);
display:flex;flex-direction:column;gap:4px}
.ol-body pre{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:6px;
padding:9px 11px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
font-size:12px;line-height:1.5;white-space:pre}
.ol-sub>summary{list-style:none;cursor:pointer;font-size:11.5px;color:var(--muted);padding:3px 6px;
border-radius:5px}
.ol-sub>summary::-webkit-details-marker{display:none}
.ol-sub>summary::before{content:"▸ ";font-size:9px}
.ol-sub[open]>summary::before{content:"▾ "}
.ol-sub>summary:hover{background:var(--surface);color:var(--ink)}
.ol-fn>summary{color:var(--accent)}
.ol-head{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
font-weight:700;margin:10px 0 2px;padding:0 6px}
.ol-head:first-child{margin-top:0}
.ed-modal-backdrop{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.45);
display:flex;align-items:center;justify-content:center;padding:24px}
.ed-modal-backdrop[hidden]{display:none}
.ed-modal{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);
padding:20px 22px;max-width:440px;width:100%;box-shadow:0 14px 44px rgba(0,0,0,.32)}
.ed-modal h2{margin:0 0 8px;font-size:15px;font-weight:600}
.ed-modal p{margin:0 0 18px;color:var(--muted);font-size:13px;line-height:1.5;word-break:break-word}
.ed-modal p .mono{color:var(--ink)}
.ed-modal-actions{display:flex;justify-content:flex-end;gap:8px}
button.solid-danger{background:var(--danger);border-color:var(--danger);color:#fff;font-weight:550}
button.solid-danger:hover{filter:brightness(1.08);background:var(--danger)}
</style>
</head>
<body>
<header>
  <h1>Edit</h1><span class="id">${projectId}</span>
  <span class="sp"></span>
  <a href="/p/${projectId}/" target="_blank" rel="noopener">Open site ↗</a>
  <a href="/fork/${projectId}" target="_blank" rel="noopener">Fork ↗</a>
  <a href="/build/${projectId}">Visual builder ↗</a>
  <button id="forget" hidden>Forget token</button>
</header>

<div id="gate">
  <form id="gateForm">
    <h2>Edit token</h2>
    <p>The token you got when this project was created. It stays in this tab only —
    it is never saved to storage or a cookie, so a refresh asks again.</p>
    <input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="edit token" required>
    <label style="display:flex;align-items:center;gap:7px;font-size:13px">
      <input id="remember" type="checkbox" style="width:auto">
      Remember this token in this browser</label>
    <button class="primary" type="submit">Unlock</button>
    <p id="gateErr" style="color:var(--danger)"></p>
  </form>
</div>

<div class="ed-modal-backdrop" id="askBackdrop" hidden>
  <div class="ed-modal" role="dialog" aria-modal="true" aria-labelledby="askTitle">
    <h2 id="askTitle"></h2>
    <p id="askMessage"></p>
    <div class="ed-modal-actions">
      <button id="askCancel" type="button">Cancel</button>
      <button id="askOk" type="button">Confirm</button>
    </div>
  </div>
</div>

<div id="app">
  <aside>
    <div class="list" id="list"></div>
    <div class="foot">
      <input id="newPath" placeholder="/new/page" spellcheck="false">
      <button id="add">Add</button>
    </div>
  </aside>
  <main>
    <div class="bar">
      <span class="path" id="curPath"></span>
      <div class="tabs">
        <button class="tab" id="tabConfig" aria-selected="true">Config</button>
        <button class="tab" id="tabCode" aria-selected="false">Code</button>
      </div>
      <span id="configActions">
        <button id="save" class="primary">Save</button>
        <button id="del" class="danger">Delete</button>
      </span>
      <span id="codeActions" style="display:none">
        <button id="flavor">outline</button>
        <button id="withInit" hidden>with init</button>
        <button id="copy" hidden>Copy</button>
        <button id="download" hidden>Download</button>
      </span>
    </div>
    <textarea id="editor" spellcheck="false"></textarea>
    <div id="codeWrap">
      <div id="outline"></div>
      <pre id="code"></pre>
    </div>
    <div class="hint" id="hint"></div>
    <div id="status"></div>
  </main>
</div>

<script>
(function(){
'use strict';
var PID = ${JSON.stringify(projectId)};
var API = '/api/projects/' + PID;
var token = null;
var current = null;      // '/path' or '__site__'
var pages = [];
var siteConfig = {};

var $ = function(id){ return document.getElementById(id); };

// Opt-in token memory. Never written unless the box is ticked, scoped per project
// so one token cannot unlock another, and forgettable from the toolbar.
var STORE_KEY = 'sb-token:' + PID;
function rememberToken(t){ try { localStorage.setItem(STORE_KEY, t); } catch (e) {} }
function forgetToken(){ try { localStorage.removeItem(STORE_KEY); } catch (e) {} }
function storedToken(){ try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } }

function status(msg, kind){
  var el = $('status');
  el.textContent = msg || '';
  el.className = kind || '';
}
function authHeaders(extra){
  var h = { authorization: 'Bearer ' + token };
  if (extra) Object.keys(extra).forEach(function(k){ h[k] = extra[k]; });
  return h;
}

function unlockWith(candidate, remember){
  return fetch(API + '/verify', { method: 'POST', headers: { authorization: 'Bearer ' + candidate } })
    .then(function(res){
      if (!res.ok) throw new Error(res.status === 401 ? 'That token is not valid for this project.' : 'Server said ' + res.status);
      token = candidate;
      if (remember) rememberToken(candidate);
      $('forget').hidden = !storedToken();
      $('token').value = '';
      $('gate').style.display = 'none';
      $('app').classList.add('on');
      return load();
    });
}

$('gateForm').addEventListener('submit', function(ev){
  ev.preventDefault();
  var candidate = $('token').value.trim();
  if (!candidate) return;
  $('gateErr').textContent = '';
  unlockWith(candidate, $('remember').checked)
    .catch(function(err){ $('gateErr').textContent = err.message; });
});

$('forget').addEventListener('click', function(){
  forgetToken();
  $('forget').hidden = true;
  status('token forgotten — you will be asked next time');
});

(function(){
  var saved = storedToken();
  if (!saved) return;
  unlockWith(saved, false).catch(function(){
    forgetToken();
    $('gateErr').textContent = 'The saved token is no longer valid.';
  });
})();

function load(){
  return fetch(API).then(function(r){ return r.json(); }).then(function(data){
    siteConfig = data.config || {};
    pages = data.pages || [];
    renderList();
    if (!current) return select(pages.indexOf('/') >= 0 ? '/' : (pages[0] || '__site__'));
    return null;
  });
}

function renderList(){
  var list = $('list');
  list.textContent = '';
  var s1 = document.createElement('div');
  s1.className = 'sect';
  s1.textContent = 'Site';
  list.appendChild(s1);
  list.appendChild(row('__site__', 'site config'));
  var s2 = document.createElement('div');
  s2.className = 'sect';
  s2.textContent = 'Pages (' + pages.length + ')';
  list.appendChild(s2);
  pages.forEach(function(p){ list.appendChild(row(p, p)); });
}

function row(key, label){
  var b = document.createElement('button');
  b.className = 'row';
  b.textContent = label;
  if (key === current) b.setAttribute('aria-current', 'true');
  b.addEventListener('click', function(){ select(key); });
  return b;
}

function setHint(){
  $('hint').textContent = current === '__site__'
    ? 'Keys you omit are left alone. thoughtSpotHost, sdkVersion, authType, theme, header, footer, css, embedDefaults.'
    : 'Replaces the whole page. Blocks: heading, text, divider, spacer, buttons, embed. ⌘S / Ctrl+S to save.';
}

function select(key){
  current = key;
  renderList();
  $('curPath').textContent = key === '__site__' ? 'site config (merged on save)' : key;
  $('del').disabled = key === '__site__';
  setHint();
  if (key === '__site__') {
    $('editor').value = JSON.stringify(siteConfig, null, 2);
    status('');
    return Promise.resolve();
  }
  status('loading…');
  // Returns its promise so callers can set a message that outlives this load
  // rather than racing the status('') below.
  return fetch(API + '/pages?path=' + encodeURIComponent(key))
    .then(function(r){ return r.json(); })
    .then(function(data){
      $('editor').value = JSON.stringify(data.page || {}, null, 2);
      status('');
      if (view === 'code') loadCode();
    })
    .catch(function(){ status('could not load ' + key, 'err'); });
}

function parseEditor(){
  try {
    return { value: JSON.parse($('editor').value) };
  } catch (err) {
    return { error: 'Not valid JSON — ' + err.message };
  }
}

function save(){
  var parsed = parseEditor();
  if (parsed.error) return status(parsed.error, 'err');
  status('saving…');
  var req = current === '__site__'
    ? fetch(API, {
        method: 'PATCH',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ config: parsed.value }),
      })
    : fetch(API + '/pages', {
        method: 'PUT',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ path: current, page: parsed.value }),
      });
  req.then(function(res){
    return res.json().then(function(body){ return { ok: res.ok, body: body }; });
  }).then(function(r){
    if (!r.ok) throw new Error(r.body && r.body.error ? r.body.error : 'save failed');
    return load().then(function(){
      status('saved — reload the site tab to see it', 'ok');
      if (view === 'code') loadCode();
    });
  }).catch(function(err){ status(err.message, 'err'); });
}

function del(){
  if (current === '__site__') return;
  var target = current;
  askConfirm({
    title: 'Delete page',
    message: target + ' will be removed from this project. This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  }).then(function (yes) {
    if (!yes) {
      status('delete cancelled');
      return;
    }
    return fetch(API + '/pages?path=' + encodeURIComponent(target), {
      method: 'DELETE',
      headers: authHeaders(),
    })
      .then(function(res){
        if (!res.ok) throw new Error('delete failed (' + res.status + ')');
        current = null;
        return load().then(function(){ status('deleted ' + target, 'ok'); });
      })
      .catch(function(err){ status(err.message, 'err'); });
  });
}

function add(){
  var p = $('newPath').value.trim();
  if (!p) return;
  status('creating…');
  fetch(API + '/pages', {
    method: 'PUT',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      path: p,
      page: { title: p, blocks: [{ type: 'heading', text: p, level: 1 }] },
    }),
  }).then(function(res){
    return res.json().then(function(body){ return { ok: res.ok, body: body }; });
  }).then(function(r){
    if (!r.ok) throw new Error(r.body && r.body.error ? r.body.error : 'create failed');
    $('newPath').value = '';
    var created = r.body.path;
    current = created;
    return load()
      .then(function(){ return select(created); })
      .then(function(){ status('created ' + created, 'ok'); });
  }).catch(function(err){ status(err.message, 'err'); });
}

// In-page confirmation. window.confirm() is never used: it is unstyleable, it
// blocks the event loop, and some embedded/iframe contexts suppress it entirely.
var askSettle = null;

function askConfirm(opts) {
  return new Promise(function (resolve) {
    askSettle = resolve;
    $('askTitle').textContent = opts.title || 'Are you sure?';
    $('askMessage').textContent = opts.message || '';
    $('askOk').textContent = opts.confirmLabel || 'Confirm';
    $('askOk').className = opts.danger ? 'solid-danger' : 'primary';
    $('askBackdrop').hidden = false;
    // Focus Cancel, so a stray Enter cannot confirm a destructive action.
    $('askCancel').focus();
  });
}

function settleAsk(answer) {
  if (!askSettle) return;
  var resolve = askSettle;
  askSettle = null;
  $('askBackdrop').hidden = true;
  resolve(answer);
}

$('askCancel').addEventListener('click', function () { settleAsk(false); });
$('askOk').addEventListener('click', function () { settleAsk(true); });
$('askBackdrop').addEventListener('click', function (ev) {
  if (ev.target === $('askBackdrop')) settleAsk(false);
});

var view = 'config';
// outline first: the structural view is what you usually want, not a code dump.
var flavor = 'outline';
var withInit = true;
var VIEWS = ['outline', 'cdn', 'esm'];

function setView(next){
  view = next;
  var isCode = next === 'code';
  $('tabConfig').setAttribute('aria-selected', String(!isCode));
  $('tabCode').setAttribute('aria-selected', String(isCode));
  $('editor').classList.toggle('off', isCode);
  $('codeWrap').classList.toggle('on', isCode);
  $('configActions').style.display = isCode ? 'none' : '';
  $('codeActions').style.display = isCode ? '' : 'none';
  if (isCode) loadCode(); else setHint();
}

function loadCode(){
  var isOutline = flavor === 'outline';
  $('withInit').hidden = flavor !== 'esm';
  $('withInit').textContent = withInit ? 'with init' : 'no init';
  $('copy').hidden = isOutline;
  $('download').hidden = isOutline;
  $('outline').classList.toggle('on', isOutline);
  $('code').style.display = isOutline ? 'none' : '';

  if (current === '__site__') {
    $('outline').textContent = '';
    $('code').textContent = 'Pick a page — code and outline are per page.';
    $('hint').textContent = '';
    return;
  }

  if (isOutline) return loadOutline();

  $('hint').textContent = flavor === 'cdn'
    ? 'A complete standalone page — no build step, so init() lives in the file.'
    : withInit
      ? 'npm + import. init() is shown separately because it belongs once at app bootstrap, not per page.'
      : 'npm + import, page code only — assumes init() already ran once at app bootstrap.';
  $('code').textContent = 'generating…';
  fetch(API + '/code?flavor=' + flavor + (withInit ? '' : '&init=0') + '&path=' + encodeURIComponent(current))
    .then(function(r){ return r.json(); })
    .then(function(d){ $('code').textContent = d.code || d.error || '(nothing)'; })
    .catch(function(){ $('code').textContent = 'could not generate code'; });
}

function pre(text){
  var el = document.createElement('pre');
  el.textContent = text;
  return el;
}

function sub(label, className, body){
  var d = document.createElement('details');
  d.className = 'ol-sub' + (className ? ' ' + className : '');
  var sm = document.createElement('summary');
  sm.textContent = label;
  d.appendChild(sm);
  d.appendChild(body);
  return d;
}

function outlineNode(node){
  var expandable = !!(node.props || node.groups || node.handlers ||
    (node.children && node.children.length));

  if (!expandable) {
    var line = document.createElement('div');
    line.className = 'ol-line';
    line.textContent = node.summary;
    return line;
  }

  var d = document.createElement('details');
  d.className = 'ol-node';
  var sm = document.createElement('summary');
  var code = document.createElement('span');
  code.textContent = node.summary;
  sm.appendChild(code);
  d.appendChild(sm);

  var body = document.createElement('div');
  body.className = 'ol-body';

  if (node.props && Object.keys(node.props).length) {
    body.appendChild(pre(JSON.stringify(node.props, null, 2)));
  }
  (node.groups || []).forEach(function(g){
    body.appendChild(sub(g.label, '', pre(JSON.stringify(g.props, null, 2))));
  });
  (node.handlers || []).forEach(function(h){
    body.appendChild(sub(h.name, 'ol-fn', pre(h.source)));
  });
  (node.children || []).forEach(function(c){
    body.appendChild(outlineNode(c));
  });

  d.appendChild(body);
  return d;
}

function heading(text){
  var h = document.createElement('div');
  h.className = 'ol-head';
  h.textContent = text;
  return h;
}

function loadOutline(){
  $('hint').textContent =
    'Structure of this page. Expand a node for its config; expand a handler for the function that actually runs.';
  var root = $('outline');
  root.textContent = 'loading…';
  fetch(API + '/outline?path=' + encodeURIComponent(current))
    .then(function(r){ return r.json(); })
    .then(function(o){
      root.textContent = '';
      if (o.error) { root.textContent = o.error; return; }

      root.appendChild(heading('project — runs once'));
      root.appendChild(outlineNode(o.init));

      root.appendChild(heading('page ' + o.path));
      if (o.pageScript) {
        root.appendChild(sub('script', 'ol-fn', pre(o.pageScript)));
      }
      (o.nodes || []).forEach(function(n){ root.appendChild(outlineNode(n)); });

      if (o.modals && o.modals.length) {
        root.appendChild(heading('modals'));
        o.modals.forEach(function(n){ root.appendChild(outlineNode(n)); });
      }
    })
    .catch(function(){ root.textContent = 'could not load outline'; });
}

$('tabConfig').addEventListener('click', function(){ setView('config'); });
$('tabCode').addEventListener('click', function(){ setView('code'); });
$('flavor').addEventListener('click', function(){
  flavor = VIEWS[(VIEWS.indexOf(flavor) + 1) % VIEWS.length];
  $('flavor').textContent = flavor;
  loadCode();
});
$('withInit').addEventListener('click', function(){
  withInit = !withInit;
  loadCode();
});
$('copy').addEventListener('click', function(){
  navigator.clipboard.writeText($('code').textContent).then(
    function(){ status('code copied', 'ok'); },
    function(){ status('clipboard blocked — select and copy manually', 'err'); },
  );
});
$('download').addEventListener('click', function(){
  if (current === '__site__') return;
  window.location.href =
    API + '/code?download=1&flavor=' + flavor + (withInit ? '' : '&init=0') +
    '&path=' + encodeURIComponent(current);
});

$('save').addEventListener('click', save);
$('del').addEventListener('click', del);
$('add').addEventListener('click', add);
$('newPath').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') add(); });
document.addEventListener('keydown', function(ev){
  if (askSettle) {
    if (ev.key === 'Escape') { ev.preventDefault(); settleAsk(false); }
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
    ev.preventDefault();
    if (token) save();
  }
});
})();
</script>
</body>
</html>`;
}
