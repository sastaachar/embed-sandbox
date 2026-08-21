/**
 * Fork landing page, served at /fork/<projectId>.
 *
 * Its own route rather than anything on /p/<projectId>/, so a visitor to a shared
 * showcase still sees only the finished site.
 */
function esc(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderForkPage(projectId: string, name: string, pageCount: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Fork · ${esc(name)}</title>
<style>
:root{--bg:#fff;--surface:#f6f7f9;--ink:#15181d;--muted:#5c6470;--line:#e3e6ea;--accent:#2770ef;--ok:#1f7a4d}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--surface:#1b1e23;--ink:#e8e6e1;--muted:#9aa0a8;
--line:#2a2d33;--accent:#5b95f5;--ok:#4fae7d}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;padding:48px 24px;background:var(--bg);color:var(--ink);
font:15px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center}
main{max-width:620px;width:100%}
h1{font-size:1.5rem;letter-spacing:-.02em;margin:0 0 6px}
p{color:var(--muted);margin:0 0 16px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:0 0 18px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}
button{font:inherit;font-size:14px;font-weight:550;padding:9px 18px;border-radius:8px;border:1px solid var(--accent);
background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.55;cursor:not-allowed}
pre{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;margin:0 0 14px;
white-space:pre-wrap;word-break:break-all}
a{color:var(--accent)}
#out{display:none}
#out.on{display:block}
.warn{border-left:3px solid var(--accent);padding-left:12px;color:var(--ink);font-size:13.5px}
.ok{color:var(--ok);font-weight:600}
#err{color:#c0392b}
</style>
</head>
<body><main>
<h1>Fork this showcase</h1>
<p>You are about to copy <strong>${esc(name)}</strong> — ${pageCount} page${pageCount === 1 ? '' : 's'},
plus its theme, header, footer and every embed config.</p>

<div class="card">
  <p style="margin:0">You get a <strong>new project id</strong> and your <strong>own edit token</strong>.
  The original is untouched, and your copy is yours to change.</p>
</div>

<button id="go">Fork it</button>
<p id="err"></p>

<div id="out">
  <p class="ok">Forked. Save the token below — it is shown once and cannot be recovered.</p>
  <pre id="details"></pre>
  <p class="warn">Lose the edit token and your fork becomes permanently read-only.</p>
  <p><a id="site" href="#" target="_blank" rel="noopener">Open your copy ↗</a> ·
     <a id="edit" href="#" target="_blank" rel="noopener">Edit it ↗</a></p>
</div>

<script>
(function(){
  'use strict';
  var PID = ${JSON.stringify(projectId)};
  var btn = document.getElementById('go');
  btn.addEventListener('click', function(){
    btn.disabled = true;
    btn.textContent = 'Forking…';
    document.getElementById('err').textContent = '';
    fetch('/api/projects/' + PID + '/fork', { method: 'POST' })
      .then(function(res){
        return res.json().then(function(body){ return { ok: res.ok, body: body }; });
      })
      .then(function(r){
        if (!r.ok) throw new Error(r.body && r.body.error ? r.body.error : 'fork failed');
        var b = r.body;
        document.getElementById('details').textContent =
          'project id : ' + b.projectId + '\\n' +
          'edit token : ' + b.editToken + '\\n' +
          'site       : ' + b.siteUrl + '\\n' +
          'editor     : ' + b.editUrl + '\\n' +
          'mcp        : ' + b.mcpUrl + '\\n' +
          'pages      : ' + b.copiedPages + ' copied from ' + b.forkedFrom;
        document.getElementById('site').href = b.siteUrl;
        document.getElementById('edit').href = b.editUrl;
        document.getElementById('out').classList.add('on');
        btn.textContent = 'Forked';
      })
      .catch(function(err){
        document.getElementById('err').textContent = err.message;
        btn.disabled = false;
        btn.textContent = 'Fork it';
      });
  });
})();
</script>
</main></body></html>`;
}
