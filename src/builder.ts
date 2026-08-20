/**
 * Visual builder at /build/<projectId>.
 *
 * Three panes: palette, live canvas, properties. The canvas mounts REAL embeds, and
 * every embed is force-pre-rendered so a drag moves only the lightweight host div —
 * the iframe stays in the SDK's body-level wrapper and showPreRender() re-syncs it
 * on drop, so reordering never remounts an iframe.
 */
export function renderBuilder(projectId: string, sdkUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Build · ${projectId}</title>
<style>
:root{--bg:#fff;--panel:#f7f8fa;--ink:#15181d;--muted:#5c6470;--line:#e3e6ea;--accent:#2770ef;
--danger:#c0392b;--ok:#1f7a4d;--r:8px}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--panel:#1a1d22;--ink:#e8e6e1;--muted:#9aa0a8;
--line:#2a2d33;--accent:#5b95f5;--danger:#e06055;--ok:#4fae7d}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);
font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
button,select,input,textarea{font:inherit;color:inherit}
button{font-size:13px;padding:6px 11px;border-radius:var(--r);border:1px solid var(--line);
background:var(--bg);cursor:pointer}
button:hover{background:var(--panel)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:550}
button.danger{color:var(--danger);border-color:var(--danger)}
button:disabled{opacity:.5;cursor:not-allowed}
input,select,textarea{width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px;
background:var(--bg)}
textarea{font-family:ui-monospace,Menlo,monospace;font-size:12px;resize:vertical}
a{color:var(--accent)}

.top{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--line);
flex:0 0 auto}
.top h1{margin:0;font-size:14px;font-weight:600}
.top .id{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
.top .sp{flex:1}
.top select{width:auto;min-width:150px}
#status{font-size:12px;color:var(--muted)}
#status.ok{color:var(--ok)} #status.err{color:var(--danger)}

#gate{flex:1;display:flex;align-items:center;justify-content:center;padding:24px}
#gate form{max-width:380px;width:100%;display:flex;flex-direction:column;gap:10px}
#work{flex:1;display:none;min-height:0}
#work.on{display:flex}

.palette{width:170px;flex:0 0 auto;border-right:1px solid var(--line);padding:10px;overflow-y:auto;
background:var(--panel)}
.palette h2,.props h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
margin:0 0 8px;font-weight:700}
.palette button{width:100%;text-align:left;margin-bottom:5px;background:var(--bg)}

.stage{flex:1;overflow-y:auto;padding:20px;min-width:0;background:var(--bg)}
.sheet{max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:2px}

.props{width:290px;flex:0 0 auto;border-left:1px solid var(--line);padding:12px;overflow-y:auto;
background:var(--panel)}
.field{margin-bottom:10px}
.field label{display:block;font-size:11.5px;color:var(--muted);margin-bottom:3px}
.field .row{display:flex;gap:6px;align-items:center}
.check{display:flex;align-items:center;gap:7px;font-size:13px;margin-bottom:7px}
.check input{width:auto}

.card{position:relative;border:1px solid transparent;border-radius:var(--r);padding:6px}
.card:hover{border-color:var(--line)}
.card.sel{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in oklab,var(--accent) 22%,transparent)}
.tag{position:absolute;top:-9px;left:8px;font-size:10px;background:var(--accent);color:#fff;
padding:1px 6px;border-radius:4px;font-family:ui-monospace,Menlo,monospace;opacity:0;pointer-events:none}
.card.sel .tag,.card:hover .tag{opacity:1}
.grip{position:absolute;top:3px;right:4px;font-size:15px;line-height:1;color:var(--muted);
cursor:grab;padding:4px 8px;border-radius:5px;opacity:.45;background:var(--bg);
border:1px solid transparent}
.card:hover .grip,.card.sel .grip{opacity:1;border-color:var(--line)}
.grip:hover{background:var(--panel);color:var(--ink)}
.grip:active{cursor:grabbing}
.card.dragging{opacity:.4}

/* Sortable animates with transforms, so nothing here may affect layout during a drag. */
.sortable-ghost{opacity:.35}
.sortable-ghost>*{visibility:hidden}
.sortable-ghost{outline:3px dashed var(--accent);outline-offset:2px;border-radius:var(--r);
min-height:44px;background:color-mix(in oklab,var(--accent) 10%,transparent)}
.sortable-drag{opacity:.9}
.col-wrap.drop-hint{outline:2px dashed var(--accent);outline-offset:4px;border-radius:var(--r)}
.dragging-any .card{cursor:grabbing}
.dragging-any .embed-host{pointer-events:none}
body.dragging-any [id^="tsEmbed-pre-render-wrapper"]{visibility:hidden !important}
[id^="tsEmbed-pre-render-wrapper"]{pointer-events:none}
body.interact [id^="tsEmbed-pre-render-wrapper"]{pointer-events:auto}
body.interact .card{cursor:default}
#interact[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
.embed-host.stale{background:repeating-linear-gradient(45deg,var(--panel),var(--panel) 8px,
var(--bg) 8px,var(--bg) 16px)}

.row-wrap{display:grid;gap:14px;border:1px dashed var(--line);border-radius:var(--r);padding:8px}
.col-wrap{display:flex;flex-direction:column;gap:2px;min-height:60px;border-radius:6px}
.col-wrap.empty{border:1px dashed var(--line);align-items:center;justify-content:center;
color:var(--muted);font-size:12px}

.ph{padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--panel);
font-size:13px;color:var(--muted)}
.embed-host{width:100%;max-width:100%;min-height:120px;min-width:180px;border:1px solid var(--line);
border-radius:6px;background:var(--panel);position:relative;overflow:hidden;
touch-action:none;box-sizing:border-box}
.embed-host::after{content:'';position:absolute;right:2px;bottom:2px;width:14px;height:14px;
border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);border-radius:0 0 4px 0;
opacity:.5;pointer-events:none}
.embed-host:hover::after{opacity:1;border-color:var(--accent)}
.embed-head{position:relative;z-index:5;display:flex;align-items:center;gap:8px;padding:5px 8px;margin-bottom:4px;
border:1px solid var(--line);border-radius:6px;background:var(--panel);cursor:pointer;
font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--muted)}
.embed-head:hover{border-color:var(--accent);color:var(--ink)}
.card.sel .embed-head{border-color:var(--accent);color:var(--ink)}
.embed-head .eid{color:var(--ink)}
.embed-head .sp2{flex:1}
.embed-head .g{cursor:grab;padding:1px 5px;border-radius:4px}
.embed-head .g:hover{background:var(--bg)}
.embed-note{padding:14px;font-size:12.5px;color:var(--muted)}
h1.b,h2.b,h3.b{margin:0} p.b{margin:0;color:var(--muted)}
.btns{display:flex;gap:7px;flex-wrap:wrap}
.btns span{font-size:13px;padding:6px 12px;border:1px solid var(--line);border-radius:var(--r)}

.mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;
justify-content:center;padding:24px;z-index:50}
.mask[hidden]{display:none}
.sheet2{background:var(--bg);border:1px solid var(--line);border-radius:var(--r);padding:18px;
max-width:520px;width:100%;max-height:80vh;display:flex;flex-direction:column;gap:10px}
.sheet2 h3{margin:0;font-size:15px}
.pick{overflow-y:auto;display:flex;flex-direction:column;gap:3px}
.pick button{text-align:left;width:100%}
.pick .nm{font-weight:550}
.pick .gid{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted)}
#connect.linked{border-color:var(--ok);color:var(--ok)}
.dlg-note{font-size:12px;color:var(--muted);margin:0}
.dlg-err{font-size:12.5px;color:var(--danger);margin:0}
.dlg-ok{font-size:12.5px;color:var(--ok);margin:0}
.dlg-row{display:flex;gap:8px;justify-content:flex-end}
</style>
</head>
<body>
<div class="top">
  <h1>Build</h1><span class="id">${projectId}</span>
  <select id="pageSel" title="page"></select>
  <button id="newPage">+ Page</button>
  <span class="sp"></span>
  <span id="status"></span>
  <button id="save" class="primary">Save</button>
  <a href="/p/${projectId}/" target="_blank" rel="noopener">Site ↗</a>
  <a href="/edit/${projectId}" target="_blank" rel="noopener">JSON ↗</a>
  <button id="connect" title="Log in to the cluster so liveboards can be listed">Connect cluster</button>
  <button id="interact" aria-pressed="false" title="Let clicks reach the embeds instead of selecting cards">Interact</button>
  <button id="forget" hidden title="Remove the saved token from this browser">Forget token</button>
</div>

<div id="gate">
  <form id="gateForm">
    <h2 style="margin:0;font-size:16px">Edit token</h2>
    <p style="margin:0;color:var(--muted);font-size:13px">Kept in this tab only — never stored.</p>
    <input id="token" type="password" autocomplete="off" placeholder="edit token" required>
    <label class="check"><input id="remember" type="checkbox">
      Remember this token in this browser</label>
    <button class="primary" type="submit">Unlock</button>
    <p id="gateErr" style="color:var(--danger);margin:0"></p>
  </form>
</div>

<div id="work">
  <aside class="palette">
    <h2>Add</h2>
    <div id="palette"></div>
    <h2 style="margin-top:14px">Page</h2>
    <button id="delPage" class="danger">Delete page</button>
  </aside>
  <section class="stage">
    <div class="ph" id="emptyHint" hidden>Empty page — add a block from the left.</div>
    <div class="sheet" id="sheet"></div>
  </section>
  <aside class="props"><h2>Properties</h2><div id="props"></div></aside>
</div>

<div class="mask" id="mask" hidden><div class="sheet2" id="maskBody"></div></div>

<script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.7/Sortable.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/interactjs@1.10.27/dist/interact.min.js"></script>
<script src="${sdkUrl}"></script>
<script>
(function(){
'use strict';
var PID = ${JSON.stringify(projectId)};
var API = '/api/projects/' + PID;
var token = null;
var project = null;
var pages = [];
var path = '/';
var page = { title: '', blocks: [] };
var sel = null;          // location string of the selected block
var dirty = false;
var slots = {};          // location -> { embed, host, key }
var attic = null;

var $ = function (id) { return document.getElementById(id); };

// Opt-in token memory. Never written unless the box is ticked, scoped per project
// so one token cannot unlock another, and forgettable from the toolbar.
var STORE_KEY = 'sb-token:' + PID;
function rememberToken(t){ try { localStorage.setItem(STORE_KEY, t); } catch (e) {} }
function forgetToken(){ try { localStorage.removeItem(STORE_KEY); } catch (e) {} }
function storedToken(){ try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } }

function status(msg, kind){ var e = $('status'); e.textContent = msg || ''; e.className = kind || ''; }
function authH(extra){ var h = { authorization: 'Bearer ' + token };
  if (extra) Object.keys(extra).forEach(function(k){ h[k] = extra[k]; }); return h; }

// ─────────────────────────────── locations ───────────────────────────────
// "3" = blocks[3];  "1.0.2" = blocks[1].columns[0].blocks[2]
function listAt(loc){
  if (loc === '') return page.blocks;
  var p = loc.split('.');
  if (p.length === 1) return page.blocks;
  var row = page.blocks[+p[0]];
  return row && row.columns && row.columns[+p[1]] ? row.columns[+p[1]].blocks : null;
}
function indexAt(loc){ var p = loc.split('.'); return +p[p.length - 1]; }
function blockAt(loc){ var l = listAt(loc); return l ? l[indexAt(loc)] : null; }
function listKey(loc){ var p = loc.split('.'); return p.length === 1 ? '' : p[0] + '.' + p[1]; }
function listFromKey(key){
  if (key === '') return page.blocks;
  var p = key.split('.');
  var row = page.blocks[+p[0]];
  return row && row.columns && row.columns[+p[1]] ? row.columns[+p[1]].blocks : null;
}

// ─────────────────────────────── data ───────────────────────────────
/*
 * One JSON document is the whole app: site config, every page, the connection.
 * GET /config to read it, PUT /config to write it. Nothing here talks to a
 * per-page or per-connection endpoint, so a save is always the same call.
 */
function load(){
  return fetch(API + '/config').then(function(r){ return r.json(); }).then(function(d){
    project = d;
    if (!project.pages) project.pages = {};
    pages = Object.keys(project.pages).sort();
    var sels = $('pageSel'); sels.textContent = '';
    pages.forEach(function(p){
      var o = document.createElement('option'); o.value = p; o.textContent = p; sels.appendChild(o);
    });
    if (pages.indexOf(path) < 0) path = pages[0] || '/';
    sels.value = path;
    connectLabel();
    return loadPage(path);
  });
}
function loadPage(p){
  path = p; sel = null;
  releaseAll();
  page = project.pages[p] || { blocks: [] };
  if (!page.blocks) page.blocks = [];
  project.pages[p] = page;
  dirty = false; status('');
  render();
  return Promise.resolve();
}
/** Sends the document, whatever changed in it. */
function saveDoc(extra){
  project.pages[path] = page;
  var payload = { config: project.config, pages: project.pages };
  if (extra) { for (var k in extra) payload[k] = extra[k]; }
  return fetch(API + '/config', { method:'PUT', headers: authH({'content-type':'application/json'}),
    body: JSON.stringify(payload) })
    .then(function(res){ return res.json().then(function(b){ return { ok: res.ok, b: b }; }); })
    .then(function(r){
      if (!r.ok || !r.b.ok) throw new Error(r.b && r.b.error ? r.b.error : 'save failed');
      project.config = r.b.config;
      project.connection = r.b.connection;
      project.hasSecret = r.b.hasSecret;
      dirty = false;
      return r.b;
    });
}
function save(){
  status('saving…');
  return saveDoc(null)
    .then(function(){ status('saved', 'ok'); })
    .catch(function(e){ status(e.message, 'err'); });
}
function touched(){ dirty = true; status('unsaved changes'); }

// ─────────────────────────────── palette ───────────────────────────────
var PALETTE = [
  ['Embed',    function(){ return newEmbed(); }],
  ['Row: 2 side by side', function(){ return { type:'row', columns:[{ blocks:[] },{ blocks:[] }] }; }],
  ['Heading',  function(){ return { type:'heading', text:'Heading', level:2 }; }],
  ['Text',     function(){ return { type:'text', text:'Some copy.' }; }],
  ['Buttons',  function(){ return { type:'buttons', items:[{ label:'Reload', action:'reload' }] }; }],
  ['Value',    function(){ return { type:'value', key:'answerId', label:'Value' }; }],
  ['Divider',  function(){ return { type:'divider' }; }],
  ['Spacer',   function(){ return { type:'spacer', size:'24px' }; }],
];
function buildPalette(){
  var host = $('palette'); host.textContent = '';
  PALETTE.forEach(function(entry){
    var b = document.createElement('button');
    b.textContent = '+ ' + entry[0];
    b.addEventListener('click', function(){
      var target = sel ? listFromKey(listKey(sel)) : page.blocks;
      var block = entry[1]();
      if (block.type === 'row' && target !== page.blocks) {
        status('rows cannot nest inside a column', 'err'); return;
      }
      target.push(block);
      touched(); render();
      // select what was just added
      selectLast(target, block);
      if (block.type === 'embed') openEmbedType(sel);
    });
    host.appendChild(b);
  });
}
function selectLast(list, block){
  if (list === page.blocks) { sel = String(page.blocks.indexOf(block)); }
  else {
    page.blocks.forEach(function(b, i){
      if (b.type !== 'row') return;
      (b.columns || []).forEach(function(c, j){
        var k = (c.blocks || []).indexOf(block);
        if (k >= 0) sel = i + '.' + j + '.' + k;
      });
    });
  }
  render();
}

// ─────────────────────────────── canvas ───────────────────────────────
var sortables = [];

/** Index among .card siblings, ignoring hints and text nodes. */
function cardIndex(container, el){
  var n = 0;
  for (var i = 0; i < container.children.length; i++) {
    var ch = container.children[i];
    if (ch === el) return n;
    if (ch.classList.contains('card')) n++;
  }
  return n;
}

/**
 * Sortable has already moved the node, so the destination index is post-move and
 * must NOT be adjusted for the removal the way a from-scratch insert would be.
 */
function moveBlock(fromLoc, destKey, destIndex){
  var srcList = listAt(fromLoc);
  if (!srcList) return;
  var block = srcList[indexAt(fromLoc)];
  if (!block) return;
  var destList = listFromKey(destKey);
  if (!destList) return;
  if (block.type === 'row' && destKey !== '') { status('rows cannot nest', 'err'); render(); return; }
  srcList.splice(indexAt(fromLoc), 1);
  destList.splice(destIndex, 0, block);
  releaseAll();
  sel = null;
  touched();
  render();
}

function wireSortable(container, key){
  container.dataset.key = key;
  sortables.push(Sortable.create(container, {
    group: {
      name: 'sb-blocks',
      put: function (to, from, dragEl) {
        // rows may not nest, so a row cannot enter a column
        return !(dragEl.dataset.type === 'row' && to.el.dataset.key !== '');
      },
    },
    draggable: '.card',
    handle: '.grip, .embed-head .g',
    animation: 150,
    swapThreshold: 0.7,
    emptyInsertThreshold: 14,
    forceFallback: true,
    fallbackTolerance: 4,
    fallbackOnBody: true,
    onStart: function (evt) {
      dragFrom = evt.item.dataset.loc;
      // A body-level iframe cannot follow a moving card, so take it out of sight.
      document.body.classList.add('dragging-any');
      document.querySelectorAll('.col-wrap').forEach(function (c) { c.classList.add('drop-hint'); });
    },
    onEnd: function (evt) {
      document.body.classList.remove('dragging-any');
      document.querySelectorAll('.drop-hint').forEach(function (c) { c.classList.remove('drop-hint'); });
      var from = dragFrom;
      dragFrom = null;
      if (from == null) { resyncEmbeds(); return; }
      var destKey = evt.to.dataset.key;
      var destIndex = cardIndex(evt.to, evt.item);
      if (destKey === listKey(from) && destIndex === indexAt(from)) { resyncEmbeds(); return; }
      moveBlock(from, destKey, destIndex);
    },
  }));
}

function destroySortables(){
  sortables.forEach(function (s) { try { s.destroy(); } catch (e) {} });
  sortables = [];
}

var dragFrom = null;
function card(block, loc){
  var el = document.createElement('div');
  el.className = 'card' + (loc === sel ? ' sel' : '');
  el.dataset.loc = loc;
  el.dataset.type = block.type;
  var tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = block.type === 'embed' ? (block.embed.type + 'Embed') : block.type;
  el.appendChild(tag);

  var grip = document.createElement('span');
  grip.className = 'grip'; grip.textContent = '⠿'; grip.title = 'drag';
  el.appendChild(grip);

  el.addEventListener('click', function(ev){
    ev.stopPropagation(); sel = loc; render();
  });
  el.appendChild(body(block, loc));
  return el;
}

function body(block, loc){
  switch (block.type) {
    case 'heading': {
      var h = document.createElement('h' + (block.level || 2)); h.className = 'b';
      h.textContent = block.text || '(heading)'; return h;
    }
    case 'text': {
      var p = document.createElement('p'); p.className = 'b';
      p.textContent = block.text || '(text)'; return p;
    }
    case 'divider': { var hr = document.createElement('hr'); return hr; }
    case 'spacer': {
      var d = document.createElement('div'); d.className = 'ph';
      d.textContent = 'spacer ' + (block.size || '24px'); return d;
    }
    case 'value': {
      var v = document.createElement('div'); v.className = 'ph';
      v.textContent = (block.label ? block.label + ': ' : '') + '{{' + block.key + '}}'; return v;
    }
    case 'buttons': {
      var row = document.createElement('div'); row.className = 'btns';
      (block.items || []).forEach(function(it){
        var s = document.createElement('span'); s.textContent = it.label || '(button)'; row.appendChild(s);
      });
      return row;
    }
    case 'embed': return embedBody(block, loc);
    case 'row': {
      var wrap = document.createElement('div'); wrap.className = 'row-wrap';
      var cols = block.columns || [];
      wrap.style.gridTemplateColumns = cols.map(function(c){ return (c.span || 1) + 'fr'; }).join(' ');
      var rowIndex = indexAt(loc);
      cols.forEach(function(col, j){
        var cw = document.createElement('div');
        var blocks = col.blocks || [];
        cw.className = 'col-wrap' + (blocks.length ? '' : ' empty');
        var key = rowIndex + '.' + j;
        if (!blocks.length) cw.textContent = 'drop an embed here';
        blocks.forEach(function(b, k){ cw.appendChild(card(b, key + '.' + k)); });
        wrap.appendChild(cw);
        pendingContainers.push([cw, key]);
      });
      return wrap;
    }
  }
  var u = document.createElement('div'); u.className = 'ph'; u.textContent = block.type; return u;
}

var pendingContainers = [];

function render(){
  destroySortables();
  pendingContainers = [];
  var sheet = $('sheet'); sheet.textContent = '';
  page.blocks.forEach(function(b, i){ sheet.appendChild(card(b, String(i))); });
  $('emptyHint').hidden = page.blocks.length > 0;
  wireSortable(sheet, '');
  pendingContainers.forEach(function(entry){ wireSortable(entry[0], entry[1]); });
  pendingContainers = [];
  renderProps();
  mountEmbeds();
}


// ─────────────────────────────── live embeds ───────────────────────────────
var sdkReady = null;
function ensureSdk(){
  if (sdkReady) return sdkReady;
  sdkReady = new Promise(function(resolve, reject){
    if (!window.tsembed) return reject(new Error('SDK failed to load'));
    var lib = window.tsembed;
    var cfg = project.config || {};
    if (!cfg.thoughtSpotHost) return reject(new Error('no thoughtSpotHost on this project'));
    var named = cfg.authType || 'None';
    var at = (lib.AuthType && lib.AuthType[named]) || lib.AuthType.None;
    var init = { thoughtSpotHost: cfg.thoughtSpotHost, authType: at };
    // The canvas authenticates with the token THIS TAB minted, whenever the demo's own
    // auth would need the Worker (or nothing at all). Same reason as the pickers: the
    // browser can reach the cluster and the Worker often cannot.
    var useTabToken = clusterReady() &&
      (named === 'None' || (cfg.auth && cfg.auth.tokenSource === 'connection'));
    if (useTabToken) {
      init.authType = lib.AuthType.TrustedAuthTokenCookieless;
      init.getAuthToken = function(){ return clusterToken(); };
    } else if (cfg.auth && cfg.auth.tokenSource === 'connection') {
      init.getAuthToken = function(){
        return fetch(API + '/token', { method:'POST' }).then(function(r){ return r.json(); })
          .then(function(b){ if (!b.token) throw new Error(b.error || 'no token'); return b.token; });
      };
    }
    // init() returns an event emitter. Embeds already wait for auth internally, so this
    // does not gate the mount - it is the only place a FAILURE is visible at all.
    var authEE = lib.init(init);
    if (authEE && typeof authEE.on === 'function') {
      var S = lib.AuthStatus || {};
      if (S.FAILURE) {
        authEE.on(S.FAILURE, function(reason){
          var why = typeof reason === 'string' ? reason : (reason && reason.type) || 'unknown';
          status('cluster login failed in the embed: ' + why, 'err');
        });
      }
      if (S.SUCCESS) {
        authEE.on(S.SUCCESS, function(){ status('embeds authenticated', 'ok'); });
      }
    }
    resolve(lib);
  });
  return sdkReady;
}

function classFor(lib, type){
  return { liveboard:'LiveboardEmbed', viz:'LiveboardEmbed', search:'SearchEmbed',
    searchbar:'SearchBarEmbed', app:'AppEmbed', spotter:'SpotterEmbed',
    conversation:'ConversationEmbed' }[type];
}

function embedBody(block, loc){
  var wrap = document.createElement('div');
  var spec = block.embed || {};
  var idKey = { liveboard:'liveboardId', viz:'liveboardId', search:'dataSource',
    searchbar:'dataSource', app:'pageId', spotter:'worksheetId', conversation:'worksheetId' }[spec.type];

  // Clickable/draggable strip, because a live iframe covers the card below it.
  var head = document.createElement('div');
  head.className = 'embed-head';
  var label = document.createElement('span');
  label.textContent = spec.type + 'Embed';
  var idSpan = document.createElement('span');
  idSpan.className = 'eid';
  idSpan.textContent = spec[idKey] ? spec[idKey] : '(no ' + idKey + ')';
  var sp2 = document.createElement('span'); sp2.className = 'sp2';
  var g = document.createElement('span');
  g.className = 'g'; g.textContent = '⠿'; g.title = 'drag';
  head.appendChild(label); head.appendChild(idSpan); head.appendChild(sp2); head.appendChild(g);
  head.addEventListener('click', function(ev){ ev.stopPropagation(); sel = loc; render(); });
  wrap.appendChild(head);

  if (!spec[idKey]) {
    var n = document.createElement('div');
    n.className = 'embed-host';
    sizeHost(n, spec, loc);
    var m = document.createElement('div'); m.className = 'embed-note';
    m.textContent = spec.type + ': choose a ' + idKey + ' on the right to render it live.';
    n.appendChild(m); wrap.appendChild(n);
    return wrap;
  }
  var host = document.createElement('div');
  host.className = 'embed-host';
  host.id = 'bslot-' + loc.replace(/\\./g, '_');
  sizeHost(host, spec, loc);
  wrap.appendChild(host);
  wrap.setAttribute('data-embed', loc);
  return wrap;
}

var DEFAULT_EMBED_HEIGHT = '340px';

var RESIZE_CORNER = 20;

function sizeHost(host, spec, loc){
  host.dataset.loc = loc;
  host.style.height = spec.fullHeight ? '' : (spec.height || DEFAULT_EMBED_HEIGHT);
  host.style.width = spec.width || '';
  host.style.resize = 'none';
}

/*
 * Resizing is interact.js, wired once against a SELECTOR — so it keeps working across
 * every re-render without re-initialising, unlike Sortable which binds to elements.
 * The size is written to the element during the drag and committed to the block on
 * release, because committing remounts the iframe at the new frameParams.
 */
function wireResize(){
  if (!window.interact) return;
  interact('.embed-host[data-loc]').resizable({
    edges: { right: true, bottom: true, bottomRight: true },
    inertia: false,
    modifiers: [
      interact.modifiers.restrictSize({ min: { width: 180, height: 120 }, max: { width: 4000, height: 3000 } }),
    ],
    listeners: {
      start: function(){ document.body.classList.add('dragging-any'); },
      move: function(event){
        event.target.style.height = Math.round(event.rect.height) + 'px';
        event.target.style.width = Math.round(event.rect.width) + 'px';
      },
      end: function(event){
        document.body.classList.remove('dragging-any');
        var host = event.target;
        var block = blockAt(host.dataset.loc);
        if (!block || block.type !== 'embed') return;
        var spec = block.embed;
        var r = host.getBoundingClientRect();
        var h = Math.round(r.height) + 'px';
        var w = Math.round(r.width) + 'px';
        if (!spec.fullHeight) spec.height = h;
        // A box dragged back to its container's width is simply full width again.
        var parentW = host.parentNode.getBoundingClientRect().width;
        if (Math.abs(r.width - parentW) < 4) delete spec.width; else spec.width = w;
        releaseAll(); touched(); render();
        status('resized to ' + (spec.width ? spec.width + ' × ' : '') + h, 'ok');
      },
    },
  });
}

function mountEmbeds(){
  var wraps = document.querySelectorAll('[data-embed]');
  if (!wraps.length) return;
  ensureSdk().then(function(lib){
    wraps.forEach(function(wrap){
      var loc = wrap.getAttribute('data-embed');
      var block = blockAt(loc);
      if (!block || block.type !== 'embed') return;
      var host = wrap.querySelector('.embed-host');
      var existing = slots[loc];
      if (existing) { try { existing.embed.showPreRender(); } catch (e) {} return; }
      var Cls = lib[classFor(lib, block.embed.type)];
      if (!Cls) { host.textContent = 'this SDK has no ' + block.embed.type + ' embed'; return; }
      var cfg = {};
      Object.keys(block.embed).forEach(function(k){
        if (k !== 'type' && k !== 'preRender' && k !== 'height') cfg[k] = block.embed[k];
      });
      // Always pre-render in the builder: the iframe then lives in the SDK's
      // body-level wrapper, so dragging the host never remounts it.
      cfg.preRenderId = 'build-' + loc.replace(/\\./g, '_');
      if (!cfg.fullHeight && !cfg.frameParams) {
        cfg.frameParams = { height: block.embed.height || DEFAULT_EMBED_HEIGHT };
      }
      try {
        var embed = new Cls('#' + host.id, cfg);
        embed.preRender();
        embed.showPreRender();
        slots[loc] = { embed: embed, host: host };
      } catch (e) {
        host.textContent = 'could not mount: ' + e.message;
      }
    });
    resyncEmbeds();
  }, function(err){
    document.querySelectorAll('[data-embed] .embed-host').forEach(function(h){
      h.textContent = err.message;
    });
  });
}

/**
 * showPreRender() positions the body-level wrapper from the host's rect at call time.
 * Any later layout change — a re-render, a drag, a resize — leaves it stale, so
 * re-sync after the browser has settled rather than in the same frame.
 */
function resyncEmbeds(){
  requestAnimationFrame(function(){
    Object.keys(slots).forEach(function(k){
      try { slots[k].embed.showPreRender(); } catch (e) {}
    });
  });
}

var resizeTimer = null;
window.addEventListener('resize', function(){
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resyncEmbeds, 120);
});

function releaseAll(){
  Object.keys(slots).forEach(function(k){
    try { slots[k].embed.hidePreRender(); } catch (e) {}
    try { if (slots[k].embed.destroy) slots[k].embed.destroy(); } catch (e) {}
    delete slots[k];
  });
}

// ─────────────────────────────── properties ───────────────────────────────
function field(label, node){
  var f = document.createElement('div'); f.className = 'field';
  var l = document.createElement('label'); l.textContent = label;
  f.appendChild(l); f.appendChild(node); return f;
}
function textInput(value, onChange){
  var i = document.createElement('input'); i.value = value == null ? '' : value;
  i.addEventListener('input', function(){ onChange(i.value); });
  return i;
}

/**
 * Per keystroke for the cheap update, once more on blur/Enter for the expensive one.
 * Remounting an iframe on every character would be unusable, and would steal focus.
 */
function textCommit(value, onInput, onCommit){
  var i = textInput(value, onInput);
  i.addEventListener('change', function(){ onCommit(i.value); });
  i.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') i.blur(); });
  return i;
}
function selectInput(options, value, onChange){
  var s = document.createElement('select');
  options.forEach(function(o){
    var op = document.createElement('option');
    op.value = typeof o === 'string' ? o : o[0];
    op.textContent = typeof o === 'string' ? o : o[1];
    s.appendChild(op);
  });
  s.value = value;
  s.addEventListener('change', function(){ onChange(s.value); });
  return s;
}
function checkbox(label, value, onChange){
  var w = document.createElement('label'); w.className = 'check';
  var c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!value;
  c.addEventListener('change', function(){ onChange(c.checked); });
  w.appendChild(c); w.appendChild(document.createTextNode(label)); return w;
}

var ID_FOR = { liveboard:['liveboardId','LIVEBOARD'], viz:['liveboardId','LIVEBOARD'],
  search:['dataSource','LOGICAL_TABLE'], searchbar:['dataSource','LOGICAL_TABLE'],
  app:['pageId',null], spotter:['worksheetId','LOGICAL_TABLE'],
  conversation:['worksheetId','LOGICAL_TABLE'] };

function renderProps(){
  var host = $('props'); host.textContent = '';
  if (!sel) {
    host.appendChild(field('Page title', textInput(page.title || '', function(v){
      page.title = v; touched();
    })));
    var note = document.createElement('p');
    note.style.cssText = 'font-size:12.5px;color:var(--muted)';
    note.textContent = 'Select a block to edit it, or add one from the left.';
    host.appendChild(note);
    return;
  }
  var block = blockAt(sel);
  if (!block) { sel = null; return; }

  var head = document.createElement('div');
  head.style.cssText = 'display:flex;gap:6px;margin-bottom:10px';
  var del = document.createElement('button'); del.className = 'danger'; del.textContent = 'Delete';
  del.addEventListener('click', function(){
    var l = listAt(sel); l.splice(indexAt(sel), 1);
    releaseAll(); sel = null; touched(); render();
  });
  head.appendChild(del);

  var side = document.createElement('button');
  side.textContent = block.type === 'embed' ? '+ Embed beside' : 'Side by side';
  side.title = 'Put this block in a row so something can sit next to it';
  side.addEventListener('click', function(){ sideBySide(sel, block.type === 'embed'); });
  head.appendChild(side);

  if (listKey(sel) !== '') {
    var full = document.createElement('button');
    full.textContent = 'Full width';
    full.title = 'Lift this block out of its column so it spans the whole row';
    full.addEventListener('click', function(){ fullWidth(sel); });
    head.appendChild(full);
  }

  host.appendChild(head);

  if (block.type === 'heading') {
    host.appendChild(field('Text', textInput(block.text, function(v){ block.text = v; touched(); render(); })));
    host.appendChild(field('Level', selectInput([['1','H1'],['2','H2'],['3','H3']], String(block.level||2),
      function(v){ block.level = +v; touched(); render(); })));
  } else if (block.type === 'text') {
    var ta = document.createElement('textarea'); ta.rows = 4; ta.value = block.text || '';
    ta.addEventListener('input', function(){ block.text = ta.value; touched(); });
    host.appendChild(field('Text', ta));
  } else if (block.type === 'spacer') {
    host.appendChild(field('Size', textInput(block.size || '24px', function(v){ block.size = v; touched(); render(); })));
  } else if (block.type === 'value') {
    host.appendChild(field('Store key', textInput(block.key, function(v){ block.key = v; touched(); render(); })));
    host.appendChild(field('Label', textInput(block.label || '', function(v){ block.label = v; touched(); render(); })));
  } else if (block.type === 'row') {
    host.appendChild(field('Columns', selectInput(['1','2','3','4'], String((block.columns||[]).length),
      function(v){
        var n = +v; var cols = block.columns || [];
        while (cols.length < n) cols.push({ blocks: [] });
        while (cols.length > n) { var last = cols.pop(); (last.blocks||[]).forEach(function(b){ page.blocks.push(b); }); }
        block.columns = cols; releaseAll(); sel = null; touched(); render();
      })));
    (block.columns || []).forEach(function(c, j){
      host.appendChild(field('Column ' + (j+1) + ' width (ratio, blank = equal)', textInput(c.span || '', function(v){
        if (v === '') delete c.span; else c.span = Math.max(1, Math.min(12, +v || 1));
        touched(); render();
      })));
    });
  } else if (block.type === 'buttons') {
    (block.items || []).forEach(function(it, i){
      var wrap = document.createElement('div');
      wrap.style.cssText = 'border:1px solid var(--line);border-radius:6px;padding:8px;margin-bottom:8px';
      wrap.appendChild(field('Label', textInput(it.label, function(v){ it.label = v; touched(); render(); })));
      wrap.appendChild(field('Action', selectInput(
        ['reload','edit','save','download-pdf','set-filter','set-value','open-modal','close-modal','host-event','nav','open-url'],
        it.action, function(v){ it.action = v; touched(); renderProps(); })));
      if (it.action === 'nav') wrap.appendChild(field('To', textInput(it.to || '/', function(v){ it.to = v; touched(); })));
      if (it.action === 'host-event') wrap.appendChild(field('HostEvent', textInput(it.hostEvent || '', function(v){ it.hostEvent = v; touched(); })));
      if (it.action === 'set-filter') {
        wrap.appendChild(field('Column', textInput(it.column || '', function(v){ it.column = v; touched(); })));
        wrap.appendChild(field('Values (comma separated)', textInput((it.values||[]).join(','), function(v){
          it.values = v.split(',').map(function(x){ return x.trim(); }).filter(Boolean); touched();
        })));
      }
      var rm = document.createElement('button'); rm.className = 'danger'; rm.textContent = 'Remove';
      rm.addEventListener('click', function(){ block.items.splice(i,1); touched(); render(); });
      wrap.appendChild(rm);
      host.appendChild(wrap);
    });
    var add = document.createElement('button'); add.textContent = '+ Button';
    add.addEventListener('click', function(){
      (block.items = block.items || []).push({ label:'Button', action:'reload' }); touched(); render();
    });
    host.appendChild(add);
  } else if (block.type === 'embed') {
    var spec = block.embed;
    var typeRow = document.createElement('div'); typeRow.className = 'row';
    typeRow.appendChild(selectInput(
      ['liveboard','viz','search','searchbar','app','spotter','conversation'], spec.type,
      function(v){
        ID_KEYS.forEach(function(k){ if (k !== 'vizId') delete spec[k]; });
        spec.type = v; releaseAll(); touched(); render();
      }));
    var chooser = document.createElement('button');
    chooser.textContent = '…'; chooser.title = 'Choose with descriptions';
    chooser.addEventListener('click', function(){ openEmbedType(sel); });
    typeRow.appendChild(chooser);
    host.appendChild(field('Embed type', typeRow));

    var pair = ID_FOR[spec.type] || ['id', null];
    var idField = pair[0], mdType = pair[1];
    var row = document.createElement('div'); row.className = 'row';
    var inp = textCommit(spec[idField] || '',
      function(v){ spec[idField] = v; touched(); },
      function(){ releaseAll(); render(); });
    row.appendChild(inp);
    if (mdType) {
      var pick = document.createElement('button'); pick.textContent = 'Pick…';
      pick.addEventListener('click', function(){ openPicker(mdType, function(item){
        spec[idField] = item.id; releaseAll(); touched(); render();
      }); });
      row.appendChild(pick);
    }
    host.appendChild(field(idField, row));

    if (spec.type === 'viz') {
      host.appendChild(field('vizId', textInput(spec.vizId || '', function(v){ spec.vizId = v; touched(); })));
    }
    host.appendChild(checkbox('Full height', spec.fullHeight, function(v){
      if (v) spec.fullHeight = true; else delete spec.fullHeight; releaseAll(); touched(); render();
    }));
    var widthField = function(){
      return field('Width', textCommit(spec.width || 'full width',
        function(){},
        function(v){
          var next = String(v).trim();
          if (!next || next === 'full width') { delete spec.width; }
          else { spec.width = /^[0-9.]+$/.test(next) ? next + 'px' : next; }
          releaseAll(); touched(); render();
        }));
    };
    if (spec.fullHeight) {
      var fhNote = document.createElement('p');
      fhNote.style.cssText = 'font-size:12px;color:var(--muted);margin:0 0 8px';
      fhNote.textContent = 'Full height sizes the iframe to its content, so Height does not apply.';
      host.appendChild(fhNote);
      host.appendChild(widthField());
    } else {
      host.appendChild(field('Height', textCommit(spec.height || DEFAULT_EMBED_HEIGHT,
        function(){ /* committed on blur/Enter, so the iframe is not remounted per key */ },
        function(v){
          var next = String(v).trim();
          if (!next) { delete spec.height; }
          else { spec.height = /^[0-9.]+$/.test(next) ? next + 'px' : next; }
          releaseAll(); touched(); render();
        })));
      host.appendChild(widthField());
      var rzNote = document.createElement('p');
      rzNote.style.cssText = 'font-size:12px;color:var(--muted);margin:0 0 8px';
      rzNote.textContent = 'Or drag the bottom-right corner of the box on the canvas.';
      host.appendChild(rzNote);
    }
    host.appendChild(checkbox('Pre-render', spec.preRender, function(v){
      if (v) spec.preRender = true; else delete spec.preRender; touched();
    }));

    var known = { type:1, preRender:1, fullHeight:1, height:1, vizId:1 }; known[idField] = 1;
    var extra = {};
    Object.keys(spec).forEach(function(k){ if (!known[k]) extra[k] = spec[k]; });
    var adv = document.createElement('textarea'); adv.rows = 6;
    adv.value = Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '{}';
    adv.addEventListener('change', function(){
      var parsed;
      try { parsed = JSON.parse(adv.value || '{}'); }
      catch (e) { status('advanced JSON: ' + e.message, 'err'); return; }
      Object.keys(spec).forEach(function(k){ if (!known[k]) delete spec[k]; });
      Object.keys(parsed).forEach(function(k){ spec[k] = parsed[k]; });
      status(''); releaseAll(); touched(); render();
    });
    host.appendChild(field('Advanced SDK config (JSON)', adv));
  }
}

// ─────────────────────────── cluster connection ───────────────────────────
/*
 * The cluster is called from the BROWSER, not from the Worker. Your browser sits on
 * the network that can see the cluster; a Worker at Cloudflare's edge does not, so a
 * private IP or a self-signed cert makes the server-side path useless. The Worker
 * proxy stays only as a fallback for clusters it can actually reach.
 */
var cluster = { host:null, username:null, secret:null, secretType:'password', token:null, exp:0 };

function clusterReady(){ return Boolean(cluster.host && cluster.username && cluster.secret); }
// No regex: a backslash escape inside this template literal is eaten before it
// ever reaches the browser, and /\/+$/ silently becomes //+$/.
function trimSlash(u){
  var h = String(u || '');
  while (h.charAt(h.length - 1) === '/') h = h.slice(0, -1);
  return h;
}
function clusterUrl(path){ return trimSlash(cluster.host) + path; }

function clusterRead(what){
  return function(res){
    if (res.ok) return res.json();
    return res.text().then(function(t){
      var hint = (res.status === 401 || res.status === 403)
        ? ' — check the username and password/secret key'
        : (res.status === 404 ? ' — check the host' : '');
      throw new Error(what + ' failed (' + res.status + ')' + hint + (t ? ': ' + t.slice(0, 200) : ''));
    });
  };
}

/** A cross-origin fetch fails opaquely, so name the two things that actually block it. */
function clusterHint(err){
  var m = (err && err.message) ? err.message : String(err);
  if (!/Failed to fetch|NetworkError|Load failed/i.test(m)) return m;
  return 'the browser could not reach ' + cluster.host + '. If it uses a self-signed ' +
    'certificate, open ' + cluster.host + ' in a tab and accept it once. Otherwise add ' +
    location.origin + " to the cluster's CORS allowlist (Develop → Customizations → " +
    'Security settings).';
}

function clusterToken(){
  if (cluster.token && Date.now() < cluster.exp - 5000) return Promise.resolve(cluster.token);
  var body = { username: cluster.username, validity_time_in_sec: 300 };
  body[cluster.secretType === 'secret_key' ? 'secret_key' : 'password'] = cluster.secret;
  return fetch(clusterUrl('/api/rest/2.0/auth/token/full'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  }).then(clusterRead('Login')).then(function(b){
    if (!b || !b.token) throw new Error('the cluster returned no token');
    cluster.token = b.token;
    cluster.exp = b.expiration_time_in_millis || (Date.now() + 250000);
    return b.token;
  });
}

function clusterSearch(type, q){
  return clusterToken().then(function(tok){
    var body = { metadata: [{ type: type }], record_offset: 0, record_size: 50,
      sort_options: { field_name: 'MODIFIED', order: 'DESC' } };
    if (q) body.metadata[0].name_pattern = '%' + q + '%';
    return fetch(clusterUrl('/api/rest/2.0/metadata/search'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json',
        authorization: 'Bearer ' + tok },
      body: JSON.stringify(body),
    }).then(clusterRead('Metadata search'));
  }).then(function(rows){
    return (rows || []).map(function(r){
      var h = r.metadata_header || {};
      return { id: String(r.metadata_id || h.id || ''), name: String(r.metadata_name || h.name || '(unnamed)') };
    }).filter(function(r){ return r.id; });
  });
}

function connectLabel(){
  var btn = $('connect');
  var conn = project && project.connection;
  if (conn) {
    btn.textContent = '✓ ' + conn.username;
    btn.title = 'Connected to ' + conn.host + ' as ' + conn.username;
    btn.classList.add('linked');
  } else {
    btn.textContent = 'Connect cluster';
    btn.title = 'Log in to the cluster so liveboards can be listed';
    btn.classList.remove('linked');
  }
}

function openConnect(){
  var conn = (project && project.connection) || null;
  var body = $('maskBody'); body.textContent = '';

  var h = document.createElement('h3');
  h.textContent = conn ? 'Cluster connection' : 'Connect to a cluster';
  body.appendChild(h);

  var note = document.createElement('p');
  note.className = 'dlg-note';
  // Double quotes, not a backslash escape: this file is a template literal and the
  // escape would be eaten before the browser ever sees it.
  note.textContent = "Saved as soon as you click Connect. This host becomes the demo's " +
    'ThoughtSpot host as well, so changing it repoints the embeds. The secret is stored ' +
    'server-side and is never returned to the browser.';
  body.appendChild(note);

  var hostIn = textInput(
    (conn && conn.host) || (project.config && project.config.thoughtSpotHost) || '',
    function(){},
  );
  hostIn.placeholder = 'https://acme.thoughtspot.cloud';
  body.appendChild(field('Cluster host', hostIn));

  var userIn = textInput((conn && conn.username) || '', function(){});
  userIn.placeholder = 'embed_user';
  body.appendChild(field('Username', userIn));

  var typeSel = selectInput([['password','Password'],['secret_key','Secret key']],
    (conn && conn.secretType) || 'password', function(){});
  body.appendChild(field('Credential type', typeSel));

  var secretIn = document.createElement('input');
  secretIn.type = 'password';
  secretIn.placeholder = conn ? '(unchanged — type to replace)' : '';
  body.appendChild(field('Password or secret key', secretIn));

  var msg = document.createElement('p'); msg.className = 'dlg-note'; body.appendChild(msg);

  var row = document.createElement('div'); row.className = 'dlg-row';
  var cancel = document.createElement('button'); cancel.textContent = 'Cancel';
  cancel.addEventListener('click', function(){ $('mask').hidden = true; });
  row.appendChild(cancel);

  if (conn) {
    var dis = document.createElement('button');
    dis.className = 'danger'; dis.textContent = 'Disconnect';
    dis.addEventListener('click', function(){
      cluster = { host:null, username:null, secret:null, secretType:'password', token:null, exp:0 };
      saveDoc({ connection: null })
        .then(function(){ $('mask').hidden = true; return load(); })
        .then(function(){ connectLabel(); status('disconnected'); })
        .catch(function(e){ msg.className = 'dlg-err'; msg.textContent = e.message; });
    });
    row.appendChild(dis);
  }

  var go = document.createElement('button');
  go.className = 'primary'; go.textContent = 'Connect';
  go.addEventListener('click', function(){
    var host = hostIn.value.trim(), user = userIn.value.trim(), secret = secretIn.value;
    if (!host || !user || (!secret && !conn)) {
      msg.className = 'dlg-err';
      msg.textContent = 'Host, username and the password/secret key are all needed.';
      return;
    }
    // Blank on an existing connection means "keep the stored secret" — the browser
    // is never given it back, so it cannot resend it.
    var connBody = { host: host, username: user, secretType: typeSel.value };
    if (secret) connBody.secret = secret;
    go.disabled = true;
    msg.className = 'dlg-note';
    msg.textContent = 'logging in…';
    // One document, one save: the credential and the host it implies go together.
    // The host you type here IS the demo's host — adopting it only when the field was
    // empty meant changing clusters silently kept pointing the embeds at the old one.
    var hostChanged = trimSlash(project.config.thoughtSpotHost) !== trimSlash(host);
    project.config.thoughtSpotHost = host;
    cluster = { host: host, username: user, secretType: typeSel.value,
      secret: secret || cluster.secret, token: null, exp: 0 };
    // The login happens from this tab, which is the thing that can actually see the
    // cluster. Saving to the Worker is separate and does not gate on it.
    clusterToken()
      .then(function(){ msg.className = 'dlg-ok'; msg.textContent = 'Logged in. Saving…'; },
            function(e){ msg.className = 'dlg-note'; msg.textContent = 'Could not log in: ' + clusterHint(e); })
      .then(function(){ return saveDoc({ connection: connBody }); })
      .then(function(){
        go.disabled = false;
        return load();
      })
      .then(function(){
        connectLabel();
        var live = Boolean(cluster.token);
        // The SDK's init already ran against the old host and the pre-rendered iframes
        // were built from it, so a host change needs a clean page, not a re-render.
        if (hostChanged) {
          msg.className = 'dlg-ok';
          msg.textContent = 'Cluster host changed to ' + host + ' — reloading the builder.';
          status('cluster host changed — reloading', 'ok');
          setTimeout(function(){ location.reload(); }, 600);
          return;
        }
        status(live ? 'connected — Pick… lists real objects' : 'connection saved (not logged in)', live ? 'ok' : '');
        if (live) {
          msg.className = 'dlg-ok';
          msg.textContent = 'Connected as ' + user + '.';
          setTimeout(function(){ $('mask').hidden = true; }, 700);
        }
      })
      .catch(function(e){ go.disabled = false; msg.className = 'dlg-err'; msg.textContent = e.message; });
  });
  row.appendChild(go);
  body.appendChild(row);
  $('mask').hidden = false;
}

// ─────────────────────────── side by side ───────────────────────────
/**
 * Wraps the block at loc in a Row so something can sit next to it. Only valid at the
 * top level, because rows do not nest — a block already inside a column just needs
 * another block added to the row it is in.
 */
function sideBySide(loc, withEmbed){
  var lk = listKey(loc);
  if (lk !== '') {
    // Already in a column: add to the parent row instead of wrapping again.
    var rowIdx = +lk.split('.')[0];
    var row = page.blocks[rowIdx];
    if (!row || row.type !== 'row') return;
    if (row.columns.length >= 4) { status('a row holds at most 4 columns', 'err'); return; }
    row.columns.push({ blocks: withEmbed ? [newEmbed()] : [] });
    releaseAll(); sel = null; touched(); render();
    return;
  }
  var i = indexAt(loc);
  var block = page.blocks[i];
  if (!block || block.type === 'row') { status('that block is already a row', 'err'); return; }
  page.blocks[i] = {
    type: 'row',
    columns: [{ blocks: [block] }, { blocks: withEmbed ? [newEmbed()] : [] }],
  };
  releaseAll(); sel = null; touched(); render();
}

/**
 * The inverse of sideBySide: lifts a block out of its column back to the top level,
 * where it spans the full width. Drops the row if nothing is left in it.
 */
function fullWidth(loc){
  var lk = listKey(loc);
  if (lk === '') { status('already full width'); return; }
  var parts = lk.split('.');
  var rowIdx = +parts[0], colIdx = +parts[1];
  var row = page.blocks[rowIdx];
  if (!row || row.type !== 'row') return;
  var col = row.columns[colIdx];
  var block = (col.blocks || []).splice(indexAt(loc), 1)[0];
  if (!block) return;
  page.blocks.splice(rowIdx + 1, 0, block);
  var allEmpty = row.columns.every(function(c){ return (c.blocks || []).length === 0; });
  if (allEmpty) page.blocks.splice(rowIdx, 1);
  releaseAll(); sel = null; touched(); render();
  status('moved out of the row — it now spans the full width', 'ok');
}

function newEmbed(){
  return { type: 'embed', embed: { type: 'liveboard', liveboardId: '', preRender: true } };
}

// ─────────────────────────────── embed type picker ───────────────────────────────
var EMBED_TYPES = [
  ['liveboard',   'Liveboard', 'A whole liveboard, tabs and all.'],
  ['viz',         'Single viz', 'One visualisation from a liveboard.'],
  ['search',      'Search', 'The search experience over a model.'],
  ['searchbar',   'Search bar', 'Just the search bar, results elsewhere.'],
  ['app',         'Full app', 'The full ThoughtSpot application.'],
  ['spotter',     'Spotter', 'Conversational analytics.'],
  ['conversation','Conversation', 'Bodyless conversation embed.'],
];
var ID_KEYS = ['liveboardId','dataSource','pageId','worksheetId','vizId','answerId'];

function openEmbedType(loc){
  var block = blockAt(loc);
  if (!block || block.type !== 'embed') return;
  var body = $('maskBody'); body.textContent = '';
  var h = document.createElement('h3'); h.textContent = 'Choose an embed type'; body.appendChild(h);
  var list = document.createElement('div'); list.className = 'pick';
  EMBED_TYPES.forEach(function(t){
    var btn = document.createElement('button');
    var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = t[1];
    var ds = document.createElement('div'); ds.className = 'gid'; ds.textContent = t[2];
    btn.appendChild(nm); btn.appendChild(ds);
    if (block.embed.type === t[0]) btn.style.borderColor = 'var(--accent)';
    btn.addEventListener('click', function(){
      // Drop the previous type's id so a stale liveboardId cannot linger on a search.
      ID_KEYS.forEach(function(k){ if (k !== 'vizId') delete block.embed[k]; });
      block.embed.type = t[0];
      $('mask').hidden = true;
      releaseAll(); touched(); render();
    });
    list.appendChild(btn);
  });
  body.appendChild(list);
  var cancel = document.createElement('button'); cancel.textContent = 'Cancel';
  cancel.addEventListener('click', function(){ $('mask').hidden = true; });
  body.appendChild(cancel);
  $('mask').hidden = false;
}

// ─────────────────────────────── metadata picker ───────────────────────────────
function openPicker(type, onPick){
  var body = $('maskBody'); body.textContent = '';
  var h = document.createElement('h3'); h.textContent = 'Pick a ' + type.toLowerCase().replace('_',' ');
  body.appendChild(h);
  var search = textInput('', function(){});
  search.placeholder = 'filter by name…';
  body.appendChild(search);
  var list = document.createElement('div'); list.className = 'pick';
  body.appendChild(list);
  var close = document.createElement('button'); close.textContent = 'Cancel';
  close.addEventListener('click', function(){ $('mask').hidden = true; });
  body.appendChild(close);
  $('mask').hidden = false;

  function show(items){
    list.textContent = '';
    if (!items.length) { list.textContent = 'nothing found'; return; }
    items.forEach(function(item){
      var b = document.createElement('button');
      var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = item.name;
      var gid = document.createElement('div'); gid.className = 'gid'; gid.textContent = item.id;
      b.appendChild(nm); b.appendChild(gid);
      b.addEventListener('click', function(){ $('mask').hidden = true; onPick(item); });
      list.appendChild(b);
    });
  }
  function note(text){
    list.textContent = '';
    var p = document.createElement('p');
    p.style.cssText = 'color:var(--muted);font-size:12.5px';
    p.textContent = text;
    list.appendChild(p);
  }

  function fetchList(q){
    list.textContent = 'loading…';
    // Straight at the cluster from this tab. No proxy, no round trip through the Worker.
    if (clusterReady()) {
      clusterSearch(type, q).then(show).catch(function(e){ note(clusterHint(e)); });
      return;
    }
    // No credential in this tab: the Worker may still be able to reach the cluster.
    fetch(API + '/metadata?type=' + type + (q ? '&q=' + encodeURIComponent(q) : ''), { headers: authH() })
      .then(function(r){ return r.json().then(function(b){ return { ok: r.ok, b: b }; }); })
      .then(function(r){
        if (r.ok) { show(r.b.items || []); return; }
        note(r.b.needsConnection
          ? 'Not connected to a cluster yet — use “Connect cluster” in the toolbar, then this lists your real objects. Meanwhile you can paste an id.'
          : 'This tab has no cluster credential, and the server could not reach the cluster either (' +
            (r.b.error || 'no detail') + '). Re-enter the password in “Connect cluster” and the browser ' +
            'will call the cluster directly. Meanwhile you can paste an id.');
      })
      .catch(function(){ note('could not load'); });
  }
  var t = null;
  search.addEventListener('input', function(){
    clearTimeout(t); t = setTimeout(function(){ fetchList(search.value.trim()); }, 250);
  });
  fetchList('');
}

// ─────────────────────────────── wiring ───────────────────────────────
function unlockWith(cand, remember){
  return fetch(API + '/verify', { method:'POST', headers:{ authorization:'Bearer ' + cand } })
    .then(function(res){
      if (!res.ok) throw new Error(res.status === 401 ? 'That token is not valid.' : 'Server said ' + res.status);
      token = cand;
      if (remember) rememberToken(cand);
      $('forget').hidden = !storedToken();
      $('token').value = '';
      $('gate').style.display = 'none'; $('work').classList.add('on');
      buildPalette();
      wireResize();
      return load();
    });
}

$('gateForm').addEventListener('submit', function(ev){
  ev.preventDefault();
  var cand = $('token').value.trim();
  if (!cand) return;
  $('gateErr').textContent = '';
  unlockWith(cand, $('remember').checked).catch(function(e){ $('gateErr').textContent = e.message; });
});

$('connect').addEventListener('click', openConnect);

$('interact').addEventListener('click', function(){
  var on = document.body.classList.toggle('interact');
  $('interact').setAttribute('aria-pressed', String(on));
  status(on ? 'clicks go to the embeds — press Interact again to select cards' : '');
});

$('forget').addEventListener('click', function(){
  forgetToken();
  $('forget').hidden = true;
  status('token forgotten — you will be asked next time');
});

// A remembered token skips the gate entirely; if it has been revoked, fall back.
(function(){
  var saved = storedToken();
  if (!saved) return;
  unlockWith(saved, false).catch(function(){
    forgetToken();
    $('gateErr').textContent = 'The saved token is no longer valid.';
  });
})();
$('pageSel').addEventListener('change', function(){ loadPage($('pageSel').value); });
$('save').addEventListener('click', save);
$('newPage').addEventListener('click', function(){
  var p = prompt ? null : null;
  var body = $('maskBody'); body.textContent = '';
  var h = document.createElement('h3'); h.textContent = 'New page'; body.appendChild(h);
  var inp = textInput('/new-page', function(){}); body.appendChild(inp);
  var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
  var cancel = document.createElement('button'); cancel.textContent = 'Cancel';
  cancel.addEventListener('click', function(){ $('mask').hidden = true; });
  var ok = document.createElement('button'); ok.className = 'primary'; ok.textContent = 'Create';
  ok.addEventListener('click', function(){
    var np = inp.value.trim(); if (!np) return;
    if (np.charAt(0) !== '/') np = '/' + np;
    $('mask').hidden = true;
    project.pages[np] = { title: np, blocks: [] };
    saveDoc(null)
      .then(function(){ path = np; return load(); })
      .then(function(){ status('created ' + path, 'ok'); })
      .catch(function(e){ status(e.message, 'err'); });
  });
  row.appendChild(cancel); row.appendChild(ok); body.appendChild(row);
  $('mask').hidden = false;
});
$('delPage').addEventListener('click', function(){
  var body = $('maskBody'); body.textContent = '';
  var h = document.createElement('h3'); h.textContent = 'Delete ' + path + '?'; body.appendChild(h);
  var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
  var cancel = document.createElement('button'); cancel.textContent = 'Cancel';
  cancel.addEventListener('click', function(){ $('mask').hidden = true; });
  var ok = document.createElement('button'); ok.className = 'danger'; ok.textContent = 'Delete';
  ok.addEventListener('click', function(){
    $('mask').hidden = true;
    var gone = path;
    delete project.pages[gone];
    path = Object.keys(project.pages)[0] || '/';
    page = project.pages[path] || { blocks: [] };
    project.pages[path] = page;
    saveDoc(null)
      .then(function(){ return load(); })
      .then(function(){ status('deleted ' + gone, 'ok'); })
      .catch(function(e){ status(e.message, 'err'); });
  });
  row.appendChild(cancel); row.appendChild(ok); body.appendChild(row);
  $('mask').hidden = false;
});
document.addEventListener('keydown', function(ev){
  if (ev.key === 'Escape') { $('mask').hidden = true; }
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); if (token) save(); }
});
window.addEventListener('beforeunload', function(ev){
  if (dirty) { ev.preventDefault(); ev.returnValue = ''; }
});
$('mask').addEventListener('click', function(ev){ if (ev.target === $('mask')) $('mask').hidden = true; });
})();
</script>
</body>
</html>`;
}
