export interface Theme {
  colorPrimary?: string;
  colorPrimaryText?: string;
  colorBg?: string;
  colorSurface?: string;
  colorText?: string;
  colorMuted?: string;
  colorBorder?: string;
  fontFamily?: string;
  fontHeading?: string;
  radius?: string;
  maxWidth?: string;
  headerHeight?: string;
  space?: string;
}

export interface Chrome extends Styled {
  show?: boolean;
  title?: string;
  subtitle?: string;
  logoUrl?: string;
  sticky?: boolean;
  align?: 'left' | 'center' | 'split';
  nav?: Array<{ label: string; to?: string; url?: string }>;
  text?: string;
  links?: Array<{ label: string; to?: string; url?: string }>;
}

/**
 * How the embed gets its auth token, declaratively — no user code. `getAuthToken`
 * is a function the SDK needs, so the runtime builds it from this.
 */
export interface AuthConfig {
  /**
   * 'endpoint'    — your own backend returns a token.
   * 'credentials' — the PAGE mints one straight from the cluster. The username and
   *                 secret are part of this config, so they are readable by anyone who
   *                 can open the site. Deliberate, and only sane for a demo.
   */
  tokenSource: 'endpoint' | 'credentials';
  tokenEndpoint?: string;
  tokenMethod?: 'GET' | 'POST';
  /**
   * Dot path to the token inside a JSON response, e.g. "data.token". Omit when the
   * response body is the bare token string.
   */
  tokenField?: string;
  /** credentials only. */
  username?: string;
  /** credentials only — PUBLIC. Shipped to every visitor of the rendered page. */
  secret?: string;
  /** credentials only. */
  secretType?: 'password' | 'secret_key';
  /** Scope the token to one object. Least privilege — prefer it. */
  objectId?: string;
  /** Short by default; the runtime re-mints as needed. */
  validitySeconds?: number;
  orgId?: number;
}

export interface Modal extends Styled {
  title?: string;
  width?: string;
  blocks?: Block[];
}

/** One reaction to an EmbedEvent: filter, copy payload fields out, open a modal. */
export interface EventRule {
  /** For CustomAction, the action id to match. Omit to match every occurrence. */
  id?: string;
  /** store key -> dotted path into the event payload */
  set?: Record<string, string>;
  openModal?: string;
  closeModal?: string;
}

export interface EmbedAction {
  type: 'set' | 'open-modal' | 'close-modal' | 'HostEvent' | 'nav' | 'open-url';
  params: Record<string, unknown>;
}

export interface EmbedEventHandler {
  /** EmbedEvent name, e.g. "Data". */
  type: string;
  /** For CustomAction, the action id to match. Omit to match every occurrence. */
  id?: string;
  actions: EmbedAction[];
}

export interface EmbedSpec {
  type: 'liveboard' | 'viz' | 'search' | 'searchbar' | 'app' | 'spotter' | 'conversation';
  /** How a host-event action addresses this embed. Defaults to its index on the page. */
  name?: string;
  preRender?: boolean;
  /** CSS length for the embed's box, e.g. "520px" or "60vh". Ignored when config.fullHeight. */
  height?: string;
  /** Caps the box's width, e.g. "800px" or "70%". Full width when unset. */
  width?: string;
  /** Passed to the SDK constructor verbatim — this is the whole embed config. */
  config: Record<string, unknown>;
  embedEventHandlers?: EmbedEventHandler[];
}

/** Inline CSS escape hatch for the rare layout that tokens cannot express. */
interface Styled {
  style?: string;
}

export type Block = Styled &
  (
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'text'; text: string }
  | { type: 'value'; key: string; label?: string }
  | { type: 'spacer'; size?: string }
  | { type: 'divider' }
  | { type: 'buttons'; align?: 'left' | 'center' | 'right'; items: ButtonSpec[] }
  | { type: 'embed'; embed: EmbedSpec }
  | { type: 'row'; columns: Column[]; gap?: string; align?: 'top' | 'center' | 'stretch' }
  );

/** A column in a row. `span` is out of 12; omit for equal widths. */
export interface Column {
  span?: number;
  blocks: Block[];
}

export interface ButtonSpec {
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  /** Legacy: superseded by `actions`, still accepted on read. */
  action?:
    | 'nav'
    | 'open-url'
    | 'reload'
    | 'edit'
    | 'save'
    | 'download-pdf'
    | 'set-filter'
    | 'set-value'
    | 'open-modal'
    | 'close-modal'
    | 'host-event';
  to?: string;
  url?: string;
  target?: string;
  column?: string;
  values?: Array<string | number>;
  hostEvent?: string;
  payload?: unknown;
  key?: string;
  value?: unknown;
  /** What the button does. The legacy single `action` normalises into this on read. */
  actions?: EmbedAction[];
  /** Zero-based index of the embed block this button acts on. Defaults to 0. */
  embedIndex?: number;
  /** Embed names or indices, or "all". Takes precedence over embedIndex. */
  targets?: Array<string | number>;
  modal?: string;
}

/**
 * What the cluster holds, cached as config. The browser fetches it — nothing here can
 * reach the cluster — so an agent over MCP can read real ids instead of guessing them.
 */
export interface CatalogItem {
  id: string;
  name: string;
  type: string;
}

export interface ProjectConfig {
  name?: string;
  namespace?: string;
  catalog?: { syncedAt?: number; items: CatalogItem[] };
  thoughtSpotHost?: string;
  sdkVersion?: string;
  authType?:
    | 'None'
    | 'EmbeddedSSO'
    | 'SSO'
    | 'SAML'
    | 'SAMLRedirect'
    | 'OIDC'
    | 'OIDCRedirect'
    | 'AuthServer'
    | 'TrustedAuthToken'
    | 'TrustedAuthTokenCookieless';
  auth?: AuthConfig;
  theme?: Theme;
  header?: Chrome;
  footer?: Chrome;
  css?: string;
  embedDefaults?: Record<string, unknown>;
  modals?: Record<string, Modal>;
  /** Show a modal when an embed reports an error. Default true — this is a debug tool. */
  showEmbedErrors?: boolean;
  /** The ‹/› toggle on the published site: page code + fork link. Default true. */
  showCode?: boolean;
  /** Push the derived palette into the embed as --ts-var-* variables. Default true. */
  themeEmbed?: boolean;
  /** Set false to stop a published page polling for document changes. Default: on. */
  live?: boolean;
}

export interface PageConfig {
  title?: string;
  header?: Chrome;
  footer?: Chrome;
  blocks?: Block[];
  css?: string;
  modals?: Record<string, Modal>;
}

const EMBED_TYPES = new Set([
  'liveboard',
  'viz',
  'search',
  'searchbar',
  'app',
  'spotter',
  'conversation',
]);

/**
 * Verified against AuthType in @thoughtspot/visual-embed-sdk 1.51.0. `Basic` is
 * deliberately excluded: it needs a username/password in the browser.
 */
const AUTH_TYPES = new Set([
  'None',
  'EmbeddedSSO',
  'SSO',
  'SAML',
  'SAMLRedirect',
  'OIDC',
  'OIDCRedirect',
  'AuthServer',
  'TrustedAuthToken',
  'TrustedAuthTokenCookieless',
]);

/** The types that need a token, and therefore an `auth` block. */
const TOKEN_AUTH_TYPES = new Set(['AuthServer', 'TrustedAuthToken', 'TrustedAuthTokenCookieless']);

const BUTTON_ACTIONS = new Set([
  'nav',
  'open-url',
  'reload',
  'edit',
  'save',
  'download-pdf',
  'set-filter',
  'set-value',
  'open-modal',
  'close-modal',
  'host-event',
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Keys you WRITE to are always top-level. */
const VALUE_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
/** Keys you READ may reach into a captured payload: route.data.currentPath */
const VALUE_PATH = /^[A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z0-9_$-]+)*$/;

export class ValidationError extends Error {}

function fail(msg: string): never {
  throw new ValidationError(msg);
}

function str(v: unknown, field: string, max = 2000): string {
  if (typeof v !== 'string') fail(`${field} must be a string`);
  if (v.length > max) fail(`${field} exceeds ${max} characters`);
  return v;
}

function optStr(v: unknown, field: string, max = 2000): string | undefined {
  return v === undefined || v === null ? undefined : str(v, field, max);
}

function optBool(v: unknown, field: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') fail(`${field} must be a boolean`);
  return v;
}

function plainObject(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${field} must be an object`);
  return v as Record<string, unknown>;
}

/**
 * `</` is the only sequence that can break out of a <style> element, and a
 * leading `@import` would let stored CSS pull in a third-party stylesheet.
 */
function safeCss(v: unknown, field: string): string | undefined {
  const css = optStr(v, field, 60_000);
  if (css === undefined) return undefined;
  return css.replace(/<\//g, '\\3C /').replace(/@import/gi, '/* import */');
}

/**
 * Inline styles cannot execute script in any current browser, but `<` would let a
 * value break the attribute, and url()/expression() are worth refusing outright.
 */
function safeInlineCss(v: unknown, field: string): string {
  const css = str(v, field, 2000);
  if (/[<>]/.test(css)) fail(`${field} may not contain < or >`);
  if (/javascript:|expression\s*\(/i.test(css)) fail(`${field} may not contain script`);
  return css;
}

function pick<T extends object>(src: Record<string, unknown>, keys: Array<keyof T & string>): T {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out as T;
}

const THEME_KEYS: Array<keyof Theme & string> = [
  'colorPrimary',
  'colorPrimaryText',
  'colorBg',
  'colorSurface',
  'colorText',
  'colorMuted',
  'colorBorder',
  'fontFamily',
  'fontHeading',
  'radius',
  'maxWidth',
  'headerHeight',
  'space',
];

function validateTheme(v: unknown): Theme {
  const raw = plainObject(v, 'theme');
  const theme = pick<Theme>(raw, THEME_KEYS);
  for (const [k, val] of Object.entries(theme)) str(val, `theme.${k}`, 200);
  return theme;
}

function validateLinks(v: unknown, field: string) {
  if (!Array.isArray(v)) fail(`${field} must be an array`);
  if (v.length > 20) fail(`${field} supports at most 20 entries`);
  return v.map((raw, i) => {
    const o = plainObject(raw, `${field}[${i}]`);
    const link: { label: string; to?: string; url?: string } = {
      label: str(o.label, `${field}[${i}].label`, 120),
    };
    if (o.to !== undefined) link.to = normalizePath(str(o.to, `${field}[${i}].to`, 500));
    if (o.url !== undefined) link.url = httpUrl(o.url, `${field}[${i}].url`);
    return link;
  });
}

function httpUrl(v: unknown, field: string): string {
  const s = str(v, field, 2000);
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return fail(`${field} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail(`${field} must use http(s)`);
  }
  return parsed.toString();
}

function validateAuth(v: unknown, field: string): AuthConfig {
  const raw = plainObject(v, field);
  const source = str(raw.tokenSource, `${field}.tokenSource`, 40);
  // The server never mints: it cannot reach a private-IP or self-signed cluster, and it
  // holds only the app's config. Either the page calls a token endpoint, or it mints
  // straight from the cluster with credentials that are part of this public config.
  if (source !== 'endpoint' && source !== 'credentials') {
    fail(`${field}.tokenSource must be "endpoint" or "credentials"`);
  }
  const out: AuthConfig = { tokenSource: source };

  if (source === 'endpoint') {
    out.tokenEndpoint = httpUrl(raw.tokenEndpoint, `${field}.tokenEndpoint`);
    if (raw.tokenMethod !== undefined) {
      const method = str(raw.tokenMethod, `${field}.tokenMethod`, 10).toUpperCase();
      if (method !== 'GET' && method !== 'POST') fail(`${field}.tokenMethod must be GET or POST`);
      out.tokenMethod = method;
    }
    if (raw.tokenField !== undefined) out.tokenField = valuePath(raw.tokenField, `${field}.tokenField`);
    return out;
  }

  if (source === 'credentials') {
    out.username = str(raw.username, `${field}.username`, 200);
    out.secret = str(raw.secret, `${field}.secret`, 400);
    const kind = raw.secretType === undefined ? 'password' : str(raw.secretType, `${field}.secretType`, 20);
    if (kind !== 'password' && kind !== 'secret_key') {
      fail(`${field}.secretType must be "password" or "secret_key"`);
    }
    out.secretType = kind;
  }
  if (raw.objectId !== undefined) out.objectId = str(raw.objectId, `${field}.objectId`, 200);
  if (raw.orgId !== undefined) {
    if (typeof raw.orgId !== 'number' || !Number.isInteger(raw.orgId)) {
      fail(`${field}.orgId must be an integer`);
    }
    out.orgId = raw.orgId;
  }
  if (raw.validitySeconds !== undefined) {
    const v = raw.validitySeconds;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 30 || v > 86400) {
      fail(`${field}.validitySeconds must be an integer from 30 to 86400`);
    }
    out.validitySeconds = v;
  }
  return out;
}

function validateChrome(v: unknown, field: string): Chrome {
  const raw = plainObject(v, field);
  const out: Chrome = {};
  if (raw.show !== undefined) out.show = optBool(raw.show, `${field}.show`);
  if (raw.sticky !== undefined) out.sticky = optBool(raw.sticky, `${field}.sticky`);
  if (raw.title !== undefined) out.title = str(raw.title, `${field}.title`, 200);
  if (raw.subtitle !== undefined) out.subtitle = str(raw.subtitle, `${field}.subtitle`, 300);
  if (raw.text !== undefined) out.text = str(raw.text, `${field}.text`, 1000);
  if (raw.logoUrl !== undefined) out.logoUrl = httpUrl(raw.logoUrl, `${field}.logoUrl`);
  if (raw.align !== undefined) {
    const a = str(raw.align, `${field}.align`, 20);
    if (a !== 'left' && a !== 'center' && a !== 'split') {
      fail(`${field}.align must be left, center or split`);
    }
    out.align = a;
  }
  if (raw.nav !== undefined) out.nav = validateLinks(raw.nav, `${field}.nav`);
  if (raw.links !== undefined) out.links = validateLinks(raw.links, `${field}.links`);
  if (raw.style !== undefined) out.style = safeInlineCss(raw.style, `${field}.style`);
  return out;
}

/**
 * Control keys are consumed by the runtime; every other key is forwarded to the
 * SDK constructor untouched, so a project can use params this schema predates.
 */
const EMBED_CONTROL_KEYS = new Set(['type', 'preRender', 'capture', 'on', 'height', 'width']);

// A length, not arbitrary CSS: this value reaches a style attribute.
const CSS_LENGTH = /^\d{1,5}(\.\d{1,3})?(px|vh|rem|em|%)$/;

function cssLength(v: unknown, field: string): string {
  const raw = typeof v === 'number' ? `${v}px` : str(v, field, 20).trim();
  if (!CSS_LENGTH.test(raw)) {
    fail(`${field} must be a CSS length like "520px", "60vh" or a number of pixels`);
  }
  return raw;
}

/** One vocabulary for both button clicks and embed events. */
const ACTION_TYPES = new Set(['set', 'open-modal', 'close-modal', 'HostEvent', 'nav', 'open-url']);
const ACTION_ALIASES: Record<string, string> = { 'host-event': 'HostEvent' };

/** A path into the event payload. A leading "payload" segment is optional. */
function payloadPath(v: unknown, field: string): string {
  const raw = valuePath(v, field);
  return raw === 'payload' ? '' : raw.replace(/^payload\./, '');
}

/**
 * `inEvent` is the one semantic difference: a set inside an event handler reads a path
 * out of the payload, while a set on a button writes the literal it was given.
 */
function validateAction(v: unknown, field: string, inEvent: boolean): EmbedAction {
  const raw = plainObject(v, field);
  const named = str(raw.type, `${field}.type`, 40);
  const type = ACTION_ALIASES[named] ?? named;
  if (!ACTION_TYPES.has(type)) {
    fail(`${field}.type must be one of ${[...ACTION_TYPES].join(', ')}`);
  }
  const params = raw.params === undefined ? {} : plainObject(raw.params, `${field}.params`);
  const out: Record<string, unknown> = {};

  if (type === 'set') {
    out.key = valueKey(params.key, `${field}.params.key`);
    out.value = inEvent
      ? payloadPath(params.value === undefined ? 'payload' : params.value, `${field}.params.value`)
      : params.value;
  } else if (type === 'open-modal' || type === 'close-modal') {
    if (params.name !== undefined) out.name = modalName(params.name, `${field}.params.name`);
    else if (type === 'open-modal') fail(`${field}.params.name is required`);
  } else if (type === 'nav') {
    out.to = normalizePath(str(params.to, `${field}.params.to`, 500));
  } else if (type === 'open-url') {
    out.url = httpUrl(params.url, `${field}.params.url`);
    const target = optStr(params.target, `${field}.params.target`, 20);
    if (target !== undefined) out.target = target;
  } else {
    // Accept the older spelling so documents written this morning still load.
    const name = str(params.type ?? params.hostEvent, `${field}.params.type`, 60);
    if (!IDENTIFIER.test(name)) fail(`${field}.params.type must be a HostEvent name`);
    out.type = name;
    const payload = params.payload ?? params.data;
    if (payload !== undefined) out.payload = payload;
    if (params.targets !== undefined) out.targets = validateTargets(params.targets, `${field}.params.targets`);
    // GetFilters and friends answer; `store` is where that answer lands.
    if (params.store !== undefined) out.store = valueKey(params.store, `${field}.params.store`);
  }
  return { type: type as EmbedAction['type'], params: out };
}

/** Names or indices. Omitted means every embed on the page. */
function validateTargets(v: unknown, field: string): Array<string | number> {
  const list = Array.isArray(v) ? v : [v];
  if (list.length > 20) fail(`${field} supports at most 20 targets`);
  return list.map((item, i) => {
    if (typeof item === 'number') {
      if (!Number.isInteger(item) || item < 0) fail(`${field}[${i}] must be a non-negative embed index`);
      return item;
    }
    return str(item, `${field}[${i}]`, 60);
  });
}

function validateHandlers(v: unknown, field: string): EmbedEventHandler[] {
  if (!Array.isArray(v)) fail(`${field} must be an array of handlers`);
  if (v.length > 40) fail(`${field} supports at most 40 handlers`);
  return v.map((raw, i) => {
    const o = plainObject(raw, `${field}[${i}]`);
    const name = str(o.type, `${field}[${i}].type`, 60);
    if (!IDENTIFIER.test(name)) fail(`${field}[${i}].type must be an EmbedEvent name`);
    const actionsRaw = o.actions === undefined ? [] : (Array.isArray(o.actions) ? o.actions : [o.actions]);
    if (actionsRaw.length > 20) fail(`${field}[${i}].actions supports at most 20 actions`);
    const handler: EmbedEventHandler = {
      type: name,
      actions: actionsRaw.map((a, j) => validateAction(a, `${field}[${i}].actions[${j}]`, true)),
    };
    if (o.id !== undefined) handler.id = str(o.id, `${field}[${i}].id`, 200);
    return handler;
  });
}

/**
 * The old flat shape put SDK params beside the runtime's own keys and split event
 * wiring across "capture" and "on". Both are still accepted on read so stored projects
 * keep working; everything is normalised to { config, embedEventHandlers } here, and
 * only the new shape is ever written back.
 */
const EMBED_OWN_KEYS = new Set([
  'type', 'name', 'preRender', 'height', 'width', 'config', 'embedEventHandlers', 'capture', 'on',
]);

function legacyHandlers(raw: Record<string, unknown>, field: string): EmbedEventHandler[] {
  const out: EmbedEventHandler[] = [];
  if (raw.capture !== undefined) {
    const capture = plainObject(raw.capture, `${field}.capture`);
    for (const [event, storeKey] of Object.entries(capture)) {
      if (!IDENTIFIER.test(event)) fail(`${field}.capture key "${event}" must be an EmbedEvent name`);
      out.push({
        type: event,
        actions: [{ type: 'set', params: { key: valueKey(storeKey, `${field}.capture.${event}`), value: '' } }],
      });
    }
  }
  if (raw.on !== undefined) {
    const onObj = plainObject(raw.on, `${field}.on`);
    for (const [event, rules] of Object.entries(onObj)) {
      if (!IDENTIFIER.test(event)) fail(`${field}.on key "${event}" must be an EmbedEvent name`);
      for (const rule of validateEventRules(rules, `${field}.on.${event}`)) {
        const actions: EmbedAction[] = [];
        if (rule.set) {
          for (const [key, path] of Object.entries(rule.set)) {
            actions.push({ type: 'set', params: { key, value: path } });
          }
        }
        if (rule.closeModal) actions.push({ type: 'close-modal', params: { name: rule.closeModal } });
        if (rule.openModal) actions.push({ type: 'open-modal', params: { name: rule.openModal } });
        const handler: EmbedEventHandler = { type: event, actions };
        if (rule.id !== undefined) handler.id = rule.id;
        out.push(handler);
      }
    }
  }
  return out;
}

/**
 * Stored pages predate { config, embedEventHandlers } and are never rewritten on read,
 * so reshape them on the way out. Tolerant by design: a read is not the place to reject
 * a document, and anything malformed is caught by validation on the next write.
 */
export function normalizeStoredPage(page: PageConfig): PageConfig {
  const walk = (blocks: Block[] | undefined): void => {
    for (const block of blocks ?? []) {
      if (block.type === 'embed' && block.embed) {
        block.embed = normalizeEmbedShape(block.embed as unknown as Record<string, unknown>);
      } else if (block.type === 'buttons') {
        for (const item of block.items ?? []) {
          if (!item.actions) item.actions = legacyButtonActions(item);
        }
      } else if (block.type === 'row') {
        for (const col of block.columns ?? []) walk(col.blocks);
      }
    }
  };
  walk(page.blocks);
  for (const modal of Object.values(page.modals ?? {})) walk(modal.blocks);
  return page;
}

/** Project-level modals hold blocks too, and are read straight off the project row. */
export function normalizeStoredProject(project: ProjectConfig): ProjectConfig {
  for (const modal of Object.values(project.modals ?? {})) {
    normalizeStoredPage({ blocks: modal.blocks } as PageConfig);
  }
  return project;
}

function normalizeEmbedShape(raw: Record<string, unknown>): EmbedSpec {
  if (raw.config !== undefined && raw.embedEventHandlers !== undefined) return raw as unknown as EmbedSpec;

  const spec = { ...raw } as Record<string, unknown>;
  if (spec.config === undefined) {
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!EMBED_OWN_KEYS.has(k)) {
        config[k] = v;
        delete spec[k];
      }
    }
    spec.config = config;
  }
  if (spec.embedEventHandlers === undefined) {
    const handlers: EmbedEventHandler[] = [];
    const capture = raw.capture as Record<string, string> | undefined;
    for (const [event, key] of Object.entries(capture ?? {})) {
      handlers.push({ type: event, actions: [{ type: 'set', params: { key, value: '' } }] });
    }
    const on = raw.on as Record<string, EventRule[]> | undefined;
    for (const [event, rules] of Object.entries(on ?? {})) {
      for (const rule of rules ?? []) {
        const actions: EmbedAction[] = [];
        for (const [key, path] of Object.entries(rule.set ?? {})) {
          actions.push({ type: 'set', params: { key, value: path } });
        }
        if (rule.closeModal) actions.push({ type: 'close-modal', params: { name: rule.closeModal } });
        if (rule.openModal) actions.push({ type: 'open-modal', params: { name: rule.openModal } });
        const handler: EmbedEventHandler = { type: event, actions };
        if (rule.id !== undefined) handler.id = rule.id;
        handlers.push(handler);
      }
    }
    if (handlers.length) spec.embedEventHandlers = handlers;
  }
  delete spec.capture;
  delete spec.on;
  return spec as unknown as EmbedSpec;
}

function validateEmbed(v: unknown, field: string): EmbedSpec {
  const raw = plainObject(v, field);
  const type = str(raw.type, `${field}.type`, 40);
  if (!EMBED_TYPES.has(type)) {
    fail(`${field}.type must be one of ${[...EMBED_TYPES].join(', ')}`);
  }
  const spec: EmbedSpec = { type: type as EmbedSpec['type'], config: {} };
  if (raw.name !== undefined) spec.name = str(raw.name, `${field}.name`, 60);
  if (raw.preRender !== undefined) spec.preRender = optBool(raw.preRender, `${field}.preRender`);
  if (raw.height !== undefined && raw.height !== '') spec.height = cssLength(raw.height, `${field}.height`);
  if (raw.width !== undefined && raw.width !== '') spec.width = cssLength(raw.width, `${field}.width`);

  const cfg = raw.config !== undefined
    ? plainObject(raw.config, `${field}.config`)
    : Object.fromEntries(Object.entries(raw).filter(([k]) => !EMBED_OWN_KEYS.has(k)));
  for (const [k, val] of Object.entries(cfg)) {
    if (typeof val === 'function') fail(`${field}.config.${k} must be JSON`);
    spec.config[k] = val;
  }

  // preRenderId is required by the SDK's PreRendered*Embed components, and generating
  // one here would hide the mistake worth catching: two blocks meant to share a
  // pre-render silently getting different ids.
  if (spec.preRender && !spec.config.preRenderId) {
    fail(`${field}.preRender needs ${field}.config.preRenderId — the id another embed uses to connect to it`);
  }

  const handlers = raw.embedEventHandlers !== undefined
    ? validateHandlers(raw.embedEventHandlers, `${field}.embedEventHandlers`)
    : legacyHandlers(raw, field);
  if (handlers.length) spec.embedEventHandlers = handlers;

  return spec;
}

function valueKey(v: unknown, field: string): string {
  const key = str(v, field, 80);
  if (!VALUE_KEY.test(key)) {
    fail(`${field} must start with a letter and contain only letters, numbers, _ or -`);
  }
  return key;
}

function valuePath(v: unknown, field: string): string {
  const key = str(v, field, 200);
  if (!VALUE_PATH.test(key)) {
    fail(`${field} must be a value key, optionally dotted, e.g. "route.data.currentPath"`);
  }
  return key;
}

const MODAL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function modalName(v: unknown, field: string): string {
  const name = str(v, field, 60);
  if (!MODAL_NAME.test(name)) fail(`${field} must be a simple name, e.g. "detail"`);
  return name;
}

function validateEventRules(v: unknown, field: string): EventRule[] {
  if (!Array.isArray(v)) fail(`${field} must be an array of rules`);
  if (v.length > 20) fail(`${field} supports at most 20 rules`);
  return v.map((raw, i) => {
    const o = plainObject(raw, `${field}[${i}]`);
    const rule: EventRule = {};
    if (o.id !== undefined) rule.id = str(o.id, `${field}[${i}].id`, 200);
    if (o.set !== undefined) {
      const setObj = plainObject(o.set, `${field}[${i}].set`);
      const out: Record<string, string> = {};
      for (const [key, path] of Object.entries(setObj)) {
        out[valueKey(key, `${field}[${i}].set key`)] = valuePath(
          path,
          `${field}[${i}].set.${key}`,
        );
      }
      rule.set = out;
    }
    if (o.openModal !== undefined) rule.openModal = modalName(o.openModal, `${field}[${i}].openModal`);
    if (o.closeModal !== undefined) {
      rule.closeModal = modalName(o.closeModal, `${field}[${i}].closeModal`);
    }
    return rule;
  });
}

function validateModals(v: unknown, field: string): Record<string, Modal> {
  const raw = plainObject(v, field);
  const keys = Object.keys(raw);
  if (keys.length > 20) fail(`${field} supports at most 20 modals`);
  const out: Record<string, Modal> = {};
  for (const key of keys) {
    modalName(key, `${field} key "${key}"`);
    const m = plainObject(raw[key], `${field}.${key}`);
    const modal: Modal = {};
    if (m.title !== undefined) modal.title = str(m.title, `${field}.${key}.title`, 200);
    if (m.width !== undefined) modal.width = str(m.width, `${field}.${key}.width`, 40);
    if (m.style !== undefined) modal.style = safeInlineCss(m.style, `${field}.${key}.style`);
    if (m.blocks !== undefined) {
      if (!Array.isArray(m.blocks)) fail(`${field}.${key}.blocks must be an array`);
      if (m.blocks.length > 40) fail(`${field}.${key}.blocks supports at most 40 entries`);
      modal.blocks = m.blocks.map((b, i) => validateBlock(b, `${field}.${key}.blocks[${i}]`));
    }
    out[key] = modal;
  }
  return out;
}

/** The legacy single `action` plus its loose fields, expressed as the shared actions. */
function legacyButtonActions(btn: ButtonSpec): EmbedAction[] {
  const targets = btn.targets ?? (btn.embedIndex !== undefined ? [btn.embedIndex] : undefined);
  const hostEvent = (name: string, payload?: unknown): EmbedAction => ({
    type: 'HostEvent',
    params: {
      type: name,
      ...(payload === undefined ? {} : { payload }),
      ...(targets === undefined ? {} : { targets }),
    },
  });
  switch (btn.action) {
    case 'nav': return [{ type: 'nav', params: { to: btn.to } }];
    case 'open-url':
      return [{ type: 'open-url', params: { url: btn.url, ...(btn.target ? { target: btn.target } : {}) } }];
    case 'reload': return [hostEvent('Reload')];
    case 'edit': return [hostEvent('Edit')];
    case 'save': return [hostEvent('Save')];
    case 'download-pdf': return [hostEvent('DownloadAsPdf')];
    case 'set-filter':
      return [hostEvent('UpdateFilters', { filters: [{ columnName: btn.column, operator: 'IN', values: btn.values }] })];
    case 'set-value': return [{ type: 'set', params: { key: btn.key, value: btn.value } }];
    case 'open-modal': return [{ type: 'open-modal', params: { name: btn.modal } }];
    case 'close-modal':
      return [{ type: 'close-modal', params: btn.modal ? { name: btn.modal } : {} }];
    case 'host-event': return [hostEvent(btn.hostEvent as string, btn.payload)];
    default: return [];
  }
}

function validateButton(v: unknown, field: string): ButtonSpec {
  const raw = plainObject(v, field);
  if (raw.actions !== undefined) {
    const list = Array.isArray(raw.actions) ? raw.actions : [raw.actions];
    if (list.length > 20) fail(`${field}.actions supports at most 20 actions`);
    const btn: ButtonSpec = {
      label: str(raw.label, `${field}.label`, 120),
      actions: list.map((a, i) => validateAction(a, `${field}.actions[${i}]`, false)),
    };
    if (raw.variant !== undefined) {
      const variant = str(raw.variant, `${field}.variant`, 20);
      if (variant !== 'primary' && variant !== 'secondary' && variant !== 'ghost') {
        fail(`${field}.variant must be primary, secondary or ghost`);
      }
      btn.variant = variant;
    }
    return btn;
  }
  const action = str(raw.action, `${field}.action`, 40);
  if (!BUTTON_ACTIONS.has(action)) {
    fail(`${field}.action must be one of ${[...BUTTON_ACTIONS].join(', ')}`);
  }
  const btn: ButtonSpec = {
    label: str(raw.label, `${field}.label`, 120),
    action: action as ButtonSpec['action'],
  };
  if (raw.targets !== undefined) {
    btn.targets = validateTargets(raw.targets, `${field}.targets`);
  }
  if (raw.embedIndex !== undefined) {
    if (
      typeof raw.embedIndex !== 'number' ||
      !Number.isInteger(raw.embedIndex) ||
      raw.embedIndex < 0
    ) {
      fail(`${field}.embedIndex must be a non-negative integer (embed block index)`);
    }
    btn.embedIndex = raw.embedIndex;
  }
  if (raw.variant !== undefined) {
    const variant = str(raw.variant, `${field}.variant`, 20);
    if (variant !== 'primary' && variant !== 'secondary' && variant !== 'ghost') {
      fail(`${field}.variant must be primary, secondary or ghost`);
    }
    btn.variant = variant;
  }
  if (action === 'nav') btn.to = normalizePath(str(raw.to, `${field}.to`, 500));
  if (action === 'open-url') {
    btn.url = httpUrl(raw.url, `${field}.url`);
    btn.target = optStr(raw.target, `${field}.target`, 20);
  }
  if (action === 'set-filter') {
    btn.column = str(raw.column, `${field}.column`, 200);
    if (!Array.isArray(raw.values) || raw.values.length === 0) {
      fail(`${field}.values must be a non-empty array`);
    }
    btn.values = raw.values.map((val, i) => {
      if (typeof val !== 'string' && typeof val !== 'number') {
        fail(`${field}.values[${i}] must be a string or number`);
      }
      return val;
    });
  }
  if (action === 'host-event') {
    btn.hostEvent = str(raw.hostEvent, `${field}.hostEvent`, 80);
    if (raw.payload !== undefined) btn.payload = raw.payload;
  }
  if (action === 'set-value') {
    btn.key = valueKey(raw.key, `${field}.key`);
    btn.value = raw.value;
  }
  if (action === 'open-modal') btn.modal = modalName(raw.modal, `${field}.modal`);
  if (action === 'close-modal' && raw.modal !== undefined) {
    btn.modal = modalName(raw.modal, `${field}.modal`);
  }
  btn.actions = legacyButtonActions(btn);
  return btn;
}

const MAX_COLUMNS = 4;

function validateColumn(v: unknown, field: string, depth: number): Column {
  const raw = plainObject(v, field);
  const col: Column = { blocks: [] };
  if (raw.span !== undefined) {
    if (typeof raw.span !== 'number' || !Number.isInteger(raw.span) || raw.span < 1 || raw.span > 12) {
      fail(`${field}.span must be an integer from 1 to 12`);
    }
    col.span = raw.span;
  }
  if (raw.blocks !== undefined) {
    if (!Array.isArray(raw.blocks)) fail(`${field}.blocks must be an array`);
    if (raw.blocks.length > 30) fail(`${field}.blocks supports at most 30 entries`);
    col.blocks = raw.blocks.map((b, i) => validateBlock(b, `${field}.blocks[${i}]`, depth + 1));
  }
  return col;
}

function validateBlock(v: unknown, field: string, depth = 0): Block {
  const raw = plainObject(v, field);
  const block = validateBlockBody(raw, field, depth);
  if (raw.style !== undefined) {
    return { ...block, style: safeInlineCss(raw.style, `${field}.style`) };
  }
  return block;
}

function validateBlockBody(raw: Record<string, unknown>, field: string, depth = 0): Block {
  const type = str(raw.type, `${field}.type`, 40);
  switch (type) {
    case 'heading': {
      const level = raw.level === undefined ? 2 : raw.level;
      if (level !== 1 && level !== 2 && level !== 3) fail(`${field}.level must be 1, 2 or 3`);
      return { type: 'heading', text: str(raw.text, `${field}.text`, 300), level };
    }
    case 'text':
      return { type: 'text', text: str(raw.text, `${field}.text`, 5000) };
    case 'value':
      return {
        type: 'value',
        key: valuePath(raw.key, `${field}.key`),
        label: optStr(raw.label, `${field}.label`, 200),
      };
    case 'spacer':
      return { type: 'spacer', size: optStr(raw.size, `${field}.size`, 40) };
    case 'divider':
      return { type: 'divider' };
    case 'buttons': {
      if (!Array.isArray(raw.items)) fail(`${field}.items must be an array`);
      if (raw.items.length > 24) fail(`${field}.items supports at most 24 buttons`);
      const align = raw.align === undefined ? undefined : str(raw.align, `${field}.align`, 20);
      if (align && align !== 'left' && align !== 'center' && align !== 'right') {
        fail(`${field}.align must be left, center or right`);
      }
      return {
        type: 'buttons',
        align: align as 'left' | 'center' | 'right' | undefined,
        items: raw.items.map((b, i) => validateButton(b, `${field}.items[${i}]`)),
      };
    }
    case 'embed':
      return { type: 'embed', embed: validateEmbed(raw.embed, `${field}.embed`) };
    case 'row': {
      // One level only. Nested rows make the drag targets ambiguous and the
      // responsive collapse impossible to reason about.
      if (depth > 0) fail(`${field}: rows cannot be nested inside a column`);
      if (!Array.isArray(raw.columns)) fail(`${field}.columns must be an array`);
      if (raw.columns.length < 1 || raw.columns.length > MAX_COLUMNS) {
        fail(`${field}.columns must hold 1 to ${MAX_COLUMNS} columns`);
      }
      const row: Extract<Block, { type: 'row' }> = {
        type: 'row',
        columns: raw.columns.map((c, i) => validateColumn(c, `${field}.columns[${i}]`, depth)),
      };
      if (raw.gap !== undefined) row.gap = str(raw.gap, `${field}.gap`, 40);
      if (raw.align !== undefined) {
        const align = str(raw.align, `${field}.align`, 20);
        if (align !== 'top' && align !== 'center' && align !== 'stretch') {
          fail(`${field}.align must be top, center or stretch`);
        }
        row.align = align;
      }
      return row;
    }
    default:
      return fail(`${field}.type "${type}" is not a known block type`);
  }
}

export function normalizePath(input: string): string {
  let p = input.trim();
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9\-._/]*$/.test(p)) {
    fail('path may only contain letters, numbers, - . _ and /');
  }
  if (p.includes('..')) fail('path may not contain ".."');
  if (p.length > 300) fail('path exceeds 300 characters');
  return p;
}

export function validateProjectConfig(v: unknown): ProjectConfig {
  const raw = plainObject(v, 'project');
  const out: ProjectConfig = {};
  if (raw.name !== undefined) out.name = str(raw.name, 'name', 200);
  if (raw.namespace !== undefined) {
    const ns = str(raw.namespace, 'namespace', 40);
    if (!IDENTIFIER.test(ns)) fail('namespace must be a valid JS identifier, e.g. "Ether"');
    out.namespace = ns;
  }
  if (raw.thoughtSpotHost !== undefined) {
    out.thoughtSpotHost = httpUrl(raw.thoughtSpotHost, 'thoughtSpotHost');
  }
  if (raw.sdkVersion !== undefined) {
    const version = str(raw.sdkVersion, 'sdkVersion', 40);
    if (!/^(latest|next|beta|\d+(\.\d+){0,2}(-[A-Za-z0-9.]+)?)$/.test(version)) {
      fail('sdkVersion must be a semver range like 1.51.0, or latest/next/beta');
    }
    out.sdkVersion = version;
  }
  if (raw.authType !== undefined) {
    const authType = str(raw.authType, 'authType', 40);
    if (!AUTH_TYPES.has(authType)) fail(`authType must be one of ${[...AUTH_TYPES].join(', ')}`);
    out.authType = authType as ProjectConfig['authType'];
  }
  if (raw.auth !== undefined) out.auth = validateAuth(raw.auth, 'auth');
  if (out.auth && out.authType !== undefined && !TOKEN_AUTH_TYPES.has(out.authType)) {
    fail(
      `auth is only used by token-based authTypes (${[...TOKEN_AUTH_TYPES].join(', ')}); ` +
        `got authType "${out.authType}"`,
    );
  }
  if (raw.theme !== undefined) out.theme = validateTheme(raw.theme);
  if (raw.header !== undefined) out.header = validateChrome(raw.header, 'header');
  if (raw.footer !== undefined) out.footer = validateChrome(raw.footer, 'footer');
  if (raw.css !== undefined) out.css = safeCss(raw.css, 'css');
  if (raw.embedDefaults !== undefined) {
    out.embedDefaults = plainObject(raw.embedDefaults, 'embedDefaults');
  }
  if (raw.modals !== undefined) out.modals = validateModals(raw.modals, 'modals');
  if (raw.catalog !== undefined) {
    const cat = plainObject(raw.catalog, 'catalog');
    const items = Array.isArray(cat.items) ? cat.items : [];
    if (items.length > 2000) fail('catalog.items supports at most 2000 entries');
    out.catalog = {
      items: items.map((entry, i) => {
        const o = plainObject(entry, `catalog.items[${i}]`);
        return {
          id: str(o.id, `catalog.items[${i}].id`, 200),
          name: str(o.name, `catalog.items[${i}].name`, 400),
          type: str(o.type, `catalog.items[${i}].type`, 40),
        };
      }),
    };
    if (cat.syncedAt !== undefined) {
      if (typeof cat.syncedAt !== 'number') fail('catalog.syncedAt must be a number');
      out.catalog.syncedAt = cat.syncedAt;
    }
  }
  if (raw.showCode !== undefined) out.showCode = optBool(raw.showCode, 'showCode');
  if (raw.showEmbedErrors !== undefined) {
    out.showEmbedErrors = optBool(raw.showEmbedErrors, 'showEmbedErrors');
  }
  if (raw.themeEmbed !== undefined) out.themeEmbed = optBool(raw.themeEmbed, 'themeEmbed');
  if (raw.live !== undefined) out.live = optBool(raw.live, 'live');
  return out;
}

export function validatePageConfig(v: unknown): PageConfig {
  const raw = plainObject(v, 'page');
  const out: PageConfig = {};
  if (raw.title !== undefined) out.title = str(raw.title, 'title', 200);
  if (raw.header !== undefined) out.header = validateChrome(raw.header, 'header');
  if (raw.footer !== undefined) out.footer = validateChrome(raw.footer, 'footer');
  if (raw.css !== undefined) out.css = safeCss(raw.css, 'css');
  if (raw.blocks !== undefined) {
    if (!Array.isArray(raw.blocks)) fail('blocks must be an array');
    if (raw.blocks.length > 60) fail('blocks supports at most 60 entries');
    out.blocks = raw.blocks.map((b, i) => validateBlock(b, `blocks[${i}]`));
  }
  if (raw.modals !== undefined) out.modals = validateModals(raw.modals, 'modals');
  return out;
}

export const DEFAULT_PROJECT: ProjectConfig = {
  name: 'Embed sandbox',
  sdkVersion: 'latest',
  authType: 'None',
  theme: {},
  header: { show: true, title: 'Embed sandbox', sticky: true, align: 'split' },
  footer: { show: true, text: 'Built with embed-sandbox' },
};

export const STARTER_PAGE: PageConfig = {
  title: 'Home',
  blocks: [
    { type: 'heading', text: 'Your embed goes here', level: 1 },
    {
      type: 'text',
      text: 'Connect an AI agent over MCP and ask it to change this page. Set thoughtSpotHost on the project, then point this block at a liveboard.',
    },
  ],
};
