/**
 * Verifies palette derivation from a single colour, contrast guarantees,
 * explicit-token precedence, and the --ts-var-* defaults pushed to the embed.
 *   BASE=http://127.0.0.1:8899 node scripts/theme-check.mjs
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8899';
const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const api = (p, o) => fetch(BASE + p, o).then(r => r.json());

const make = (theme, extra = {}) => api('/api/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'theme', thoughtSpotHost: BASE, sdkVersion: '1.51.0', theme, ...extra }),
});

// ---- one colour in, full palette out ----
const p1 = await make({ colorPrimary: '#7b3fe4' });
const g1 = await api(`/api/projects/${p1.projectId}`);
const t = g1.resolvedTheme;
console.log('derived from #7b3fe4:', JSON.stringify({
  bg: t.colorBg, surface: t.colorSurface, border: t.colorBorder,
  text: t.colorText, muted: t.colorMuted, onPrimary: t.colorPrimaryText,
}));

for (const k of ['colorBg','colorSurface','colorBorder','colorText','colorMuted','colorPrimaryText']) {
  ok(/^#[0-9a-f]{6}$/i.test(t[k]), `${k} derived to a hex colour (${t[k]})`);
}
ok(g1.config.theme.colorBg === undefined, 'stored config stays sparse — only colorPrimary was saved');
ok(t.colorPrimary === '#7b3fe4', 'colorPrimary passes through untouched');

// neutrals should be tinted toward the primary hue, not flat grey
ok(t.colorSurface.toLowerCase() !== '#f6f7f9', 'surface is derived, not the default grey');
ok(t.colorBg !== t.colorSurface && t.colorSurface !== t.colorBorder, 'bg/surface/border are distinct steps');

// ---- contrast is guaranteed, not hoped for ----
ok(g1.contrast.primaryTextOnPrimary >= 4.5,
  `on-primary text meets WCAG AA (${g1.contrast.primaryTextOnPrimary}:1)`);
ok(g1.contrast.textOnBg >= 7, `body text meets AAA on background (${g1.contrast.textOnBg}:1)`);
ok(g1.contrast.mutedOnBg >= 4.5, `muted text meets AA on background (${g1.contrast.mutedOnBg}:1)`);

// a light primary must flip the on-colour to dark
const p2 = await make({ colorPrimary: '#ffd400' });
const g2 = await api(`/api/projects/${p2.projectId}`);
ok(g2.resolvedTheme.colorPrimaryText !== '#ffffff',
  `light primary flips on-colour to dark (${g2.resolvedTheme.colorPrimaryText})`);
ok(g2.contrast.primaryTextOnPrimary >= 4.5,
  `yellow primary still meets AA (${g2.contrast.primaryTextOnPrimary}:1)`);

// a grey primary should not tint the neutrals
const p3 = await make({ colorPrimary: '#808080' });
const g3 = await api(`/api/projects/${p3.projectId}`);
const grey = g3.resolvedTheme.colorSurface;
ok(grey[1] === grey[3] && grey[3] === grey[5],
  `achromatic primary yields untinted neutrals (${grey})`);

// ---- explicit tokens win ----
const p4 = await make({ colorPrimary: '#7b3fe4', colorBg: '#000000', colorText: '#00ff00' });
const g4 = await api(`/api/projects/${p4.projectId}`);
ok(g4.resolvedTheme.colorBg === '#000000', 'explicit colorBg overrides the derived one');
ok(g4.resolvedTheme.colorText === '#00ff00', 'explicit colorText overrides the derived one');
ok(g4.resolvedTheme.colorSurface !== '#000000', 'unset tokens are still derived alongside');

// ---- garbage primary degrades instead of throwing ----
const p5 = await make({ colorPrimary: 'not-a-colour' });
const g5 = await api(`/api/projects/${p5.projectId}`);
ok(/^#[0-9a-f]{6}$/i.test(g5.resolvedTheme.colorSurface),
  'unparseable primary falls back to the default hue rather than failing');

// ---- --ts-var-* pushed into the embed ----
const vars = g1.tsVars;
ok(vars && Object.keys(vars).length >= 30, `${vars ? Object.keys(vars).length : 0} --ts-var-* defaults emitted`);
ok(Object.keys(vars).every(k => k.startsWith('--ts-var-')), 'every emitted key is a --ts-var-* name');
ok(vars['--ts-var-button--primary-background'] === t.colorPrimary, 'primary button background = colorPrimary');
ok(vars['--ts-var-button--primary-color'] === t.colorPrimaryText, 'primary button text = colorPrimaryText');
ok(vars['--ts-var-root-background'] === t.colorBg, 'root background = colorBg');
ok(vars['--ts-var-viz-description-color'] === t.colorMuted, 'viz description = colorMuted');
ok(vars['--ts-var-liveboard-tile-border-color'] === t.colorBorder, 'tile border = colorBorder');

// they must actually reach the rendered page's manifest
const shell = await fetch(`${BASE}/p/${p1.projectId}/`).then(r => r.text());
ok(shell.includes('--ts-var-button--primary-background'), 'ts-vars inlined into the shell manifest');
ok(shell.includes('customCSS'), 'delivered via customizations.style.customCSS.variables');

// ---- and into generated code, so it matches what runs ----
await api(`/api/projects/${p1.projectId}/pages`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${p1.editToken}` },
  body: JSON.stringify({ path: '/', page: { blocks: [
    { type: 'embed', embed: { type: 'liveboard', liveboardId: 'lb-1' } }] } }),
});
const gen = await api(`/api/projects/${p1.projectId}/code?path=/`);
ok(gen.code.includes('--ts-var-button--primary-background'),
  'generated SDK code carries the same --ts-var-* variables');

// ---- opt-out ----
const p6 = await make({ colorPrimary: '#7b3fe4' }, { themeEmbed: false });
const g6 = await api(`/api/projects/${p6.projectId}`);
ok(g6.tsVars === null, 'themeEmbed:false stops the ts-var push');
const shell6 = await fetch(`${BASE}/p/${p6.projectId}/`).then(r => r.text());
ok(!shell6.includes('--ts-var-'), 'and nothing leaks into the shell');
ok(/^#[0-9a-f]{6}$/i.test(g6.resolvedTheme.colorSurface),
  'but site chrome is still themed from the one colour');

// ---- author overrides beat the defaults ----
const p7 = await make({ colorPrimary: '#7b3fe4' }, {
  embedDefaults: { customizations: { style: { customCSS: {
    variables: { '--ts-var-root-background': '#123456' } } } } },
});
const shell7 = await fetch(`${BASE}/p/${p7.projectId}/`).then(r => r.text());
ok(shell7.includes('#123456'), "author's own --ts-var value is preserved");
ok(shell7.includes('--ts-var-button--primary-background'), 'and the rest are still filled in');

pass.forEach(m => console.log('  ok   ' + m));
fail.forEach(m => console.log('  FAIL ' + m));
console.log(fail.length ? `\n${fail.length} failed` : '\nall theme checks passed');
process.exit(fail.length ? 1 : 0);
