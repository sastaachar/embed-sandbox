/**
 * Fork landing page, served at /fork/<projectId>.
 *
 * Its own route rather than anything on /p/<projectId>/, so a visitor to a shared
 * showcase still sees only the finished site. One button: forking hands you the builder
 * with the new token in the link, which is the only thing anyone wanted from here.
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
:root{--bg:#fff;--surface:#f6f7f9;--ink:#15181d;--muted:#5c6470;--line:#e3e6ea;--accent:#2770ef}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--surface:#1b1e23;--ink:#e8e6e1;--muted:#9aa0a8;
--line:#2a2d33;--accent:#5b95f5}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;padding:18vh 24px;background:var(--bg);color:var(--ink);
font:15px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center}
main{max-width:440px;width:100%}
h1{font-size:1.35rem;letter-spacing:-.02em;margin:0 0 8px}
p{color:var(--muted);margin:0 0 20px}
button{font:inherit;font-size:14px;font-weight:550;padding:9px 18px;border-radius:8px;
border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.55;cursor:not-allowed}
#err{color:#c0392b;margin:14px 0 0;min-height:1.6em}
</style>
</head>
<body><main>
<h1>Fork ${esc(name)}</h1>
<p>${pageCount} page${pageCount === 1 ? '' : 's'}, the theme and every embed config, copied into
a project of your own with its own edit token. The original is untouched.</p>
<button id="go">Fork it</button>
<p id="err"></p>
<script>
(function(){
  'use strict';
  var PID = ${JSON.stringify(projectId)};
  var btn = document.getElementById('go');
  var err = document.getElementById('err');
  btn.addEventListener('click', function(){
    btn.disabled = true;
    btn.textContent = 'Forking…';
    err.textContent = '';
    fetch('/api/projects/' + PID + '/fork', { method: 'POST' })
      .then(function(res){ return res.json().then(function(b){ return { ok: res.ok, body: b }; }); })
      .then(function(r){
        if (!r.ok) throw new Error(r.body && r.body.error ? r.body.error : 'fork failed');
        var b = r.body;
        // The token rides in the fragment, which never reaches the server; the builder
        // reads it and strips it from the address bar. Copy Token in there gets it back.
        var open = function(){ location.replace('/build/' + b.projectId + '#t=' + encodeURIComponent(b.editToken)); };
        try {
          navigator.clipboard.writeText(b.editToken).then(open, open);
        } catch (e) { open(); }
      })
      .catch(function(e){
        err.textContent = e.message;
        btn.disabled = false;
        btn.textContent = 'Fork it';
      });
  });
})();
</script>
</main></body></html>`;
}
