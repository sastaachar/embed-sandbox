import { clampChroma, converter, formatHex, parse, wcagContrast } from 'culori';
import type { ProjectConfig, Theme } from './schema';

const toOklch = converter('oklch');

/** Used when no colorPrimary is given, and as the fallback hue when one is unparseable. */
export const DEFAULT_TOKENS: Required<Theme> = {
  colorPrimary: '#2770ef',
  colorPrimaryText: '#ffffff',
  colorBg: '#ffffff',
  colorSurface: '#f6f7f9',
  colorText: '#15181d',
  colorMuted: '#5c6470',
  colorBorder: '#e3e6ea',
  fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontHeading: 'inherit',
  radius: '8px',
  maxWidth: '1180px',
  headerHeight: '56px',
  space: '20px',
};

function hex(l: number, c: number, h: number): string {
  return formatHex(clampChroma({ mode: 'oklch', l, c, h }, 'oklch')) ?? '#000000';
}

/**
 * Derives the palette from one colour, in OKLCH so the steps are perceptually
 * even rather than evenly spaced in sRGB. Every token an author sets explicitly
 * wins over the derived value.
 */
export function resolveTheme(theme: Theme | undefined): Required<Theme> {
  const given = theme ?? {};
  const primaryInput = given.colorPrimary ?? DEFAULT_TOKENS.colorPrimary;
  const parsed = parse(primaryInput);
  const base = parsed ? toOklch(parsed) : toOklch(parse(DEFAULT_TOKENS.colorPrimary)!);

  const h = base?.h ?? 260;
  const chroma = base?.c ?? 0.16;
  // A grey primary should not tint the neutrals, so scale the hint by its chroma.
  const tint = Math.min(chroma, 0.16) / 0.16;

  const derived: Required<Theme> = {
    ...DEFAULT_TOKENS,
    colorPrimary: primaryInput,
    colorBg: hex(0.995, 0.004 * tint, h),
    colorSurface: hex(0.968, 0.013 * tint, h),
    colorBorder: hex(0.905, 0.019 * tint, h),
    colorText: hex(0.225, 0.022 * tint, h),
    colorMuted: hex(0.53, 0.026 * tint, h),
    colorPrimaryText: onColor(primaryInput),
  };

  // Explicit tokens override derived ones.
  const out = { ...derived };
  (Object.keys(given) as Array<keyof Theme>).forEach((k) => {
    const v = given[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  });
  return out;
}

/**
 * Text that sits directly on `background`. CSS cannot decide this — color-contrast()
 * is not shipped anywhere — so it is computed, picking whichever reads better.
 */
export function onColor(background: string): string {
  const bg = parse(background);
  if (!bg) return '#ffffff';
  const light = '#ffffff';
  const dark = '#101418';
  return wcagContrast(bg, light) >= wcagContrast(bg, dark) ? light : dark;
}

export function contrastOf(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  return Math.round(wcagContrast(pa, pb) * 100) / 100;
}

/**
 * A deliberately small slice of the SDK's 242 --ts-var-* names: enough that the
 * embed reads as part of the site, without asserting an opinion on every surface.
 * Verified against @thoughtspot/visual-embed-sdk 1.51.0 css-variables.d.ts.
 */
export function tsVarsFor(t: Required<Theme>): Record<string, string> {
  return {
    '--ts-var-root-background': t.colorBg,
    '--ts-var-root-color': t.colorText,
    '--ts-var-root-font-family': t.fontFamily,

    '--ts-var-viz-background': t.colorBg,
    '--ts-var-viz-title-color': t.colorText,
    '--ts-var-viz-description-color': t.colorMuted,
    '--ts-var-viz-border-radius': t.radius,

    '--ts-var-axis-title-color': t.colorMuted,
    '--ts-var-axis-data-label-color': t.colorMuted,

    '--ts-var-button--primary-background': t.colorPrimary,
    '--ts-var-button--primary-color': t.colorPrimaryText,
    '--ts-var-button--secondary-background': t.colorSurface,
    '--ts-var-button--secondary-color': t.colorText,
    '--ts-var-button-border-radius': t.radius,

    '--ts-var-chip-background': t.colorSurface,
    '--ts-var-chip-color': t.colorText,
    '--ts-var-chip--active-background': t.colorPrimary,
    '--ts-var-chip--active-color': t.colorPrimaryText,
    '--ts-var-chip-border-radius': t.radius,

    '--ts-var-liveboard-tile-background': t.colorBg,
    '--ts-var-liveboard-tile-border-color': t.colorBorder,
    '--ts-var-liveboard-header-background': t.colorBg,
    '--ts-var-liveboard-header-font-color': t.colorText,
    '--ts-var-liveboard-tab-active-border-color': t.colorPrimary,

    '--ts-var-search-bar-background': t.colorBg,
    '--ts-var-search-bar-text-font-color': t.colorText,
    '--ts-var-search-auto-complete-background': t.colorBg,
    '--ts-var-search-auto-complete-font-color': t.colorText,

    '--ts-var-menu-background': t.colorBg,
    '--ts-var-menu-color': t.colorText,
    '--ts-var-menu--hover-background': t.colorSurface,
    '--ts-var-list-hover-background': t.colorSurface,

    '--ts-var-dialog-body-background': t.colorBg,
    '--ts-var-dialog-body-color': t.colorText,
    '--ts-var-dialog-header-background': t.colorBg,
    '--ts-var-dialog-header-color': t.colorText,

    '--ts-var-checkbox-border-color': t.colorBorder,
    '--ts-var-application-color': t.colorPrimary,
  };
}

type Dict = Record<string, unknown>;

/**
 * The project as the runtime and codegen should see it: theme fully resolved, and
 * the --ts-var-* defaults folded into embedDefaults. Anything the author set on
 * their own customizations wins, so this only ever fills gaps.
 */
export function effectiveProject(cfg: ProjectConfig): ProjectConfig {
  const theme = resolveTheme(cfg.theme);
  if (cfg.themeEmbed === false) return { ...cfg, theme };

  const defaults = (cfg.embedDefaults ?? {}) as Dict;
  const customizations = (defaults.customizations ?? {}) as Dict;
  const style = (customizations.style ?? {}) as Dict;
  const customCSS = (style.customCSS ?? {}) as Dict;
  const authored = (customCSS.variables ?? {}) as Record<string, string>;

  return {
    ...cfg,
    theme,
    embedDefaults: {
      ...defaults,
      customizations: {
        ...customizations,
        style: {
          ...style,
          customCSS: {
            ...customCSS,
            variables: { ...tsVarsFor(theme), ...authored },
          },
        },
      },
    },
  };
}
