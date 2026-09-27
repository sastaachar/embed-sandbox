/**
 * Verifies that a text block renders Markdown — and ONLY Markdown — on the published
 * page and in the builder canvas, from the one markdown.js both of them load.
 *   BASE=http://127.0.0.1:8899 node e2e/markdown-check.mjs
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

const SOURCE = [
  '# Title',
  '',
  'A **bold** word, an *italic* one, some `code`, a [link](https://example.com/x),',
  'and a second line.',
  '',
  'Not markup: <b>hi</b> <script>alert(1)</script> &amp;',
  '',
  '- one',
  '  - nested',
  '- two',
  '',
  '1. first',
  '2. second',
  '',
  '> quoted',
  '',
  '```json',
  '{ "a": 1 }',
  '```',
  '',
  '---',
  '',
  'Bad link: [click](javascript:alert(1)) — and worksheet_id_here keeps its underscores.',
  '',
  'Variable: {{who}}',
].join('\n');

const created = await api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'markdown', thoughtSpotHost: BASE, sdkVersion: '1.51.0' }),
});
const PID = created.body.projectId, TOKEN = created.body.editToken;
const auth = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

await api(`/api/projects/${PID}/config`, {
  method: 'PUT',
  headers: auth,
  body: JSON.stringify({
    config: {
      thoughtSpotHost: BASE,
      sdkVersion: '1.51.0',
      variables: { who: { label: 'Who', default: '**Ada**' } },
    },
    pages: {
      '/': {
        title: 'Markdown',
        blocks: [
          { type: 'heading', text: '**not** markdown here', level: 2 },
          { type: 'text', text: SOURCE },
        ],
      },
    },
  }),
});

const b = await chromium.launch({ channel: 'chrome' });
const pg = await b.newPage({ viewport: { width: 1200, height: 900 } });
const jsErrors = [];
pg.on('pageerror', (e) => jsErrors.push(String(e)));

await pg.goto(`${BASE}/p/${PID}/`, { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('.sb-text', { timeout: 10000 });

const live = await pg.evaluate(() => {
  const el = document.querySelector('.sb-text');
  return {
    tag: el.tagName,
    cls: el.className,
    html: el.innerHTML,
    text: el.textContent,
    tags: Array.from(el.querySelectorAll('*')).map((n) => n.tagName.toLowerCase()),
    links: Array.from(el.querySelectorAll('a')).map((a) => ({ href: a.getAttribute('href'), rel: a.rel, target: a.target })),
    heading: document.querySelector('.sb-heading').textContent,
    scripts: el.querySelectorAll('script').length,
  };
});

ok(live.tag === 'DIV', `text block is a <div> (was ${live.tag}) — a <p> cannot hold a list`);
ok(/\bsb-md\b/.test(live.cls), `wrapper carries .sb-md (${live.cls})`);
ok(live.tags.includes('strong'), '**bold** -> <strong>');
ok(live.tags.includes('em'), '*italic* -> <em>');
ok(live.tags.includes('code') && live.tags.includes('pre'), '`code` and ``` fence render');
ok(live.tags.includes('h1'), '# heading renders');
ok(live.tags.includes('ul') && live.tags.includes('ol'), 'both list kinds render');
ok(live.html.includes('<ul><li>nested</li></ul>') || /<li>one<ul>/.test(live.html), 'lists nest by indent');
ok(live.tags.includes('blockquote'), '> blockquote renders');
ok(live.tags.includes('hr'), '--- renders a rule');
ok(live.tags.includes('br'), 'a single newline is a line break');

// The whole point: nothing an author writes can become an element.
ok(live.scripts === 0, 'no <script> element from a text block');
ok(!live.tags.includes('b'), '<b>hi</b> did NOT become an element');
ok(live.text.includes('<b>hi</b>'), '<b>hi</b> shows as literal text');
ok(live.text.includes('<script>alert(1)</script>'), '<script> shows as literal text');
ok(live.text.includes('&amp;'), 'HTML entities are not decoded');

const hrefs = live.links.map((l) => l.href);
ok(hrefs.includes('https://example.com/x'), 'https link resolves');
ok(!hrefs.some((h) => /javascript:/i.test(h)), `javascript: never becomes an href (${hrefs.join(', ')})`);
ok(live.text.includes('[click](javascript:alert(1))'), 'a refused link shows as literal text');
ok(live.links.every((l) => !/^https?:/.test(l.href) || /noopener/.test(l.rel)), 'external links get rel=noopener');
ok(live.text.includes('worksheet_id_here'), 'snake_case survives _emphasis_ parsing');

ok(live.heading === '**not** markdown here', `heading block stays literal (${live.heading})`);

// {{key}} resolves before the Markdown is parsed, so a variable can carry formatting.
ok(/Variable:\s*Ada/.test(live.text) && live.html.includes('<strong>Ada</strong>'),
  'a variable is interpolated, then parsed as Markdown');

ok(jsErrors.length === 0, `no page errors (${jsErrors.join(' | ')})`);

// --- the builder canvas paints from the SAME renderer -----------------------------
const bp = await b.newPage({ viewport: { width: 1400, height: 900 } });
const builderErrors = [];
bp.on('pageerror', (e) => builderErrors.push(String(e)));
await bp.goto(`${BASE}/build/${PID}#t=${TOKEN}`, { waitUntil: 'domcontentloaded' });
await bp.waitForSelector('.card[data-type="text"] .sb-md', { timeout: 15000 });

const canvas = await bp.evaluate(() => {
  const el = document.querySelector('.card[data-type="text"] .sb-md');
  return {
    tags: Array.from(el.querySelectorAll('*')).map((n) => n.tagName.toLowerCase()),
    text: el.textContent,
    // Any styled input in the panel must be ours, not the browser's default chrome.
    bareInputs: Array.from(document.querySelectorAll('input:not([type=checkbox]):not([type=radio])'))
      .filter((i) => getComputedStyle(i).borderRadius === '0px').length,
  };
});

ok(canvas.tags.includes('strong') && canvas.tags.includes('ul'),
  'canvas previews Markdown, not raw asterisks');
ok(!canvas.tags.includes('b') && canvas.text.includes('<b>hi</b>'),
  'canvas keeps HTML literal too');
ok(canvas.bareInputs === 0, `every text input is styled (${canvas.bareInputs} unstyled)`);
ok(builderErrors.length === 0, `no builder errors (${builderErrors.join(' | ')})`);

await b.close();

pass.forEach((m) => console.log('  ok   ' + m));
fail.forEach((m) => console.log('  FAIL ' + m));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
