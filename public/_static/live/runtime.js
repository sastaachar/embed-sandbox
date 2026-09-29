(function () {
  'use strict';

  var M = JSON.parse(document.getElementById('sb-manifest').textContent);
  var BASE = (M.basePath || '').replace(/\/+$/, '');
  var headerEl = document.getElementById('sb-header');
  var footerEl = document.getElementById('sb-footer');
  var contentEl = document.getElementById('sb-content');
  var atticEl = document.getElementById('sb-attic');
  var pageStyle = null;

  var pages = {};
  M.pages.forEach(function (p) {
    pages[p.path] = p;
  });

  var sdk = null;
  var sdkReady = null;
  var slots = {};
  var active = null;
  var NS = M.project.namespace || 'Sandbox';
  var values = {};
  // What THIS page load set, kept apart from what the visitor saved: a session value
  // wins, and clearing it must reveal the saved one rather than nothing.
  var session = {};
  var listeners = {};
  var textBindings = [];
  var valueBindings = [];
  var styleBindings = [];
  var modalEl = null;
  var openModalName = null;
  var initConfigUsed = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function keyOf(path) {
    return path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root';
  }

  function note(title, body) {
    var box = el('div', 'sb-note');
    box.appendChild(el('strong', null, title));
    box.appendChild(document.createTextNode(body));
    return box;
  }

  // ------------------------------------------------------------ value store
  //
  // ONE way in and out for every variable, because a value can come from four places
  // and the order matters: what this session set, what this visitor saved in their own
  // browser, what the project declares as a default, then nothing. The settings panel,
  // {{token}} interpolation, value blocks, event handlers and embed configs all read
  // and write through readVar/writeVar so that order holds everywhere.

  /*
   * Named configs. A visitor may keep several sets of host/auth/variables — one per
   * cluster, say — and switch between them. Rather than a parallel store, the profile name
   * is folded into the SAME localStorage keys everything already reads, so nothing
   * downstream changes: the unnamed default keeps today's exact keys, and a named one gets
   * an "@name" suffix.
   */
  var CFG_LS = 'sb.cfg.' + M.projectId;

  function readCfg() {
    try {
      var c = JSON.parse(localStorage.getItem(CFG_LS) || 'null');
      if (c && typeof c === 'object') {
        return { active: String(c.active || ''), names: Array.isArray(c.names) ? c.names : [] };
      }
    } catch (e) { /* private mode */ }
    return { active: '', names: [] };
  }

  function writeCfg(c) {
    try { localStorage.setItem(CFG_LS, JSON.stringify(c)); } catch (e) { /* private mode */ }
  }

  var cfg = readCfg();

  /*
   * ?config=name opens the page on a named config, so a demo link can carry which one.
   * The param is then STRIPPED from the address bar: left in place it re-pins that config
   * on every reload, and since switching and deleting both reload, neither could stick.
   */
  try {
    var url0 = new URL(window.location.href);
    var wanted = url0.searchParams.get('config');
    if (wanted !== null) {
      var name = wanted.trim().slice(0, 40);
      if (name && cfg.names.indexOf(name) === -1) cfg.names.push(name);
      cfg.active = name;
      writeCfg(cfg);
      url0.searchParams.delete('config');
      try {
        window.history.replaceState(null, '', url0.pathname + (url0.search || '') + url0.hash);
      } catch (e) { /* no history API */ }
    }
  } catch (e) { /* no URL API */ }

  /*
   * The Default config is read-only now, so overrides a browser saved on it before that
   * change would apply forever with no way to clear them. Move them into a config of their
   * own, "local", and open on it.
   */
  if (!cfg.active) {
    try {
      var legacyInit = 'sb.init.' + M.projectId;
      var legacyVars = 'sb.var.' + M.projectId + '.';
      var moved = [];
      for (var li = 0; li < localStorage.length; li++) {
        var lk = localStorage.key(li);
        if (lk === legacyInit || (lk && lk.indexOf(legacyVars) === 0)) moved.push(lk);
      }
      if (moved.length) {
        moved.forEach(function (k) {
          var v = localStorage.getItem(k);
          var to = k === legacyInit ? legacyInit + '@local' : legacyVars.slice(0, -1) + '@local.' + k.slice(legacyVars.length);
          if (v !== null && localStorage.getItem(to) === null) localStorage.setItem(to, v);
          localStorage.removeItem(k);
        });
        if (cfg.names.indexOf('local') === -1) cfg.names.push('local');
        cfg.active = 'local';
        writeCfg(cfg);
      }
    } catch (e) { /* private mode */ }
  }

  /** '' for the unnamed default — which keeps the keys this page has always used. */
  function cfgSuffix() { return cfg.active ? '@' + cfg.active : ''; }

  var VAR_LS = 'sb.var.' + M.projectId + cfgSuffix() + '.';
  var INIT_LS = 'sb.init.' + M.projectId + cfgSuffix();
  var declaredVars = (M.project && M.project.variables) || {};

  function lsRead(key) {
    try { return localStorage.getItem(VAR_LS + key); } catch (e) { return null; }
  }
  function lsWrite(key, value) {
    try { localStorage.setItem(VAR_LS + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
  function lsDrop(key) {
    try { localStorage.removeItem(VAR_LS + key); } catch (e) { /* private mode */ }
  }
  function decode(raw) {
    if (raw === null) return undefined;
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }

  /** Keys this visitor has saved, plus every key the project declares. */
  function knownVarKeys() {
    var keys = Object.keys(declaredVars);
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(VAR_LS) === 0) {
          var name = k.slice(VAR_LS.length);
          if (keys.indexOf(name) === -1) keys.push(name);
        }
      }
    } catch (e) { /* private mode */ }
    // Anything a page interpolates is settable too, even if nobody declared it.
    Object.keys(values).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); });
    (M.varsUsed || []).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); });
    return keys;
  }

  /** Where a key's current value came from — what the settings panel shows. */
  function varSource(key) {
    if (Object.prototype.hasOwnProperty.call(session, key)) return 'session';
    if (lsRead(key) !== null) return 'saved';
    if (declaredVars[key] && declaredVars[key].default !== undefined) return 'default';
    return 'unset';
  }

  /** session > saved in this browser > declared default > undefined. */
  function readVar(key) {
    if (Object.prototype.hasOwnProperty.call(session, key)) return session[key];
    var saved = decode(lsRead(key));
    if (saved !== undefined) return saved;
    var dec = declaredVars[key];
    return dec && dec.default !== undefined ? dec.default : undefined;
  }

  function writeVar(key, value, persist) {
    if (persist) { lsWrite(key, value); delete session[key]; }
    else session[key] = value;
    values[key] = readVar(key);
    refreshBindings();
    (listeners[key] || []).slice().forEach(function (fn) {
      try { fn(values[key], key); } catch (err) { console.error('[' + NS + '] listener failed', err); }
    });
    return values[key];
  }

  /** Drop this visitor's own value, falling back to the project's default. */
  function resetVar(key) {
    delete session[key];
    lsDrop(key);
    values[key] = readVar(key);
    refreshBindings();
    (listeners[key] || []).slice().forEach(function (fn) {
      try { fn(values[key], key); } catch (err) { console.error('[' + NS + '] listener failed', err); }
    });
    return values[key];
  }

  /** `values` is the resolved view every reader already uses; seed it once at boot. */
  function hydrateVars() {
    knownVarKeys().forEach(function (k) {
      var v = readVar(k);
      if (v !== undefined) values[k] = v;
    });
  }

  function lookup(path) {
    var parts = String(path).split('.');
    var cur = values[parts[0]];
    for (var i = 1; i < parts.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function display(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch (err) { return String(v); }
    }
    return String(v);
  }

  // {{key}} and {{key.nested.field}} inside any user-supplied text.
  var TOKEN = /\{\{\s*([A-Za-z_$][A-Za-z0-9_$-]*(?:\.[A-Za-z0-9_$-]+)*)\s*\}\}/g;

  function interpolate(tpl) {
    return String(tpl).replace(TOKEN, function (_, path) {
      return display(lookup(path));
    });
  }

  /**
   * Text blocks are Markdown; every other piece of author text on the page is literal.
   * The renderer lives in markdown.js so the builder canvas can paint exactly this —
   * and if that file ever fails to load the source stays readable as plain text rather
   * than disappearing.
   *
   * Tokens are resolved BEFORE the Markdown is parsed, so a variable can carry
   * formatting of its own — and, for the same reason, cannot carry markup: markdown.js
   * has no path from a string to an element.
   */
  function paint(node, tpl, markdown) {
    var text = interpolate(tpl);
    if (markdown && window.SBMarkdown) window.SBMarkdown.render(node, text);
    else node.textContent = text;
  }

  function bindText(node, tpl, markdown) {
    paint(node, tpl, markdown);
    if (TOKEN.test(tpl)) textBindings.push({ node: node, tpl: tpl, md: !!markdown });
    TOKEN.lastIndex = 0;
    return node;
  }

  function refreshBindings() {
    textBindings = textBindings.filter(function (b) { return b.node.isConnected; });
    valueBindings = valueBindings.filter(function (b) { return b.node.isConnected; });
    textBindings.forEach(function (b) { paint(b.node, b.tpl, b.md); });
    styleBindings = styleBindings.filter(function (b) { return b.node.isConnected; });
    styleBindings.forEach(function (b) { b.node.setAttribute('style', interpolate(b.tpl)); });
    valueBindings.forEach(function (b) {
      var v = lookup(b.key);
      b.node.textContent = v === undefined ? (b.placeholder || '—') : display(v);
    });
  }

  var store = {
    /**
     * `opts.persist` keeps the value in THIS visitor's browser for next time — what the
     * settings panel does. Without it the value lives for this page load only, which is
     * what an event handler wants.
     */
    set: function (key, value, opts) {
      if (typeof key !== 'string' || !key) throw new TypeError(NS + '.set(key, value): key must be a string');
      return writeVar(key, value, !!(opts && opts.persist));
    },
    /** Forget this visitor's value for a key; the project default applies again. */
    reset: function (key) {
      if (typeof key !== 'string' || !key) throw new TypeError(NS + '.reset(key): key must be a string');
      return resetVar(key);
    },
    /** Every settable key with its value and where that value came from. */
    variables: function () {
      return knownVarKeys().sort().map(function (k) {
        var dec = declaredVars[k] || {};
        return {
          key: k,
          label: dec.label || k,
          placeholder: dec.placeholder || '',
          value: readVar(k),
          source: varSource(k),
        };
      });
    },
    get: function (key) {
      return key === undefined ? undefined : lookup(key);
    },
    /** Named alias for the pairing a "set" action creates. */
    setVariable: function (key, value, opts) { return store.set(key, value, opts); },
    getVariable: function (key) {
      return key === undefined ? undefined : lookup(key);
    },
    all: function () {
      var copy = {};
      Object.keys(values).forEach(function (k) { copy[k] = values[k]; });
      return copy;
    },
    keys: function () { return Object.keys(values); },
    on: function (key, fn) {
      if (typeof fn !== 'function') throw new TypeError(NS + '.on(key, fn): fn must be a function');
      (listeners[key] = listeners[key] || []).push(fn);
      return function off() {
        listeners[key] = (listeners[key] || []).filter(function (f) { return f !== fn; });
      };
    },
    /**
     * Drops what THIS page load set, then re-resolves: a value saved in this browser or
     * a project default takes over again. Use reset() to drop the saved one too.
     */
    clear: function (key) {
      if (key === undefined) {
        session = {};
        values = {};
        hydrateVars();
        refreshBindings();
        return;
      }
      delete session[key];
      var next = readVar(key);
      if (next === undefined) delete values[key]; else values[key] = next;
      refreshBindings();
      (listeners[key] || []).slice().forEach(function (fn) {
        try { fn(values[key], key); } catch (err) { console.error('[' + NS + '] listener failed', err); }
      });
    },

    /**
     * The project's single SDK init. Idempotent by construction — every caller
     * shares one promise, so init() runs exactly once per project no matter how
     * many pages, embeds or modals ask for it. Config comes from the project,
     * not from the caller, which is why it takes no arguments.
     */
    init: function () {
      if (arguments.length) {
        console.warn(
          '[' + NS + '] init() takes no arguments — thoughtSpotHost, authType and ' +
            'sdkVersion are project settings. Change them with set_site or in the editor.',
        );
      }
      return ensureSdk().then(function () { return store.config; });
    },

    get initialized() {
      return sdk !== null;
    },

    /** The config init() actually received, including a built getAuthToken. */
    get initConfig() {
      return initConfigUsed;
    },

    get sdk() {
      return sdk;
    },

    get config() {
      return Object.freeze({
        namespace: NS,
        thoughtSpotHost: M.project.thoughtSpotHost || null,
        authType: M.project.authType || 'None',
        sdkVersion: M.project.sdkVersion || 'latest',
        sdkUrl: M.sdkUrl,
      });
    },

    /** The current page's first embed — the one buttons target by default. */
    get embed() {
      return activeEmbed(0);
    },

    /**
     * Every embed instance in a scope, in block order. Scope defaults to the
     * current page; pass "modal:<name>" for an open modal's embeds.
     */
    embeds: function (scope) {
      var prefix = (scope || active) + '#';
      var out = [];
      Object.keys(slots)
        .filter(function (k) { return k.indexOf(prefix) === 0; })
        .sort()
        .forEach(function (k) { out.push(slots[k].embed); });
      return out;
    },

    /** Client-side navigation, so demos can move between pages from code. */
    go: function (path) { go(path); },

    openModal: function (name) { openModal(name); },
    closeModal: function () { closeModal(); },

    /** Name of the currently open modal, or null. */
    get modal() { return openModalName; },

    get path() {
      return active;
    },
  };

  window[NS] = store;

  // ---------------------------------------------------------------- routing

  function currentPath() {
    var p = location.pathname;
    if (BASE && p.indexOf(BASE) === 0) p = p.slice(BASE.length);
    if (p.charAt(0) !== '/') p = '/' + p;
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return p;
  }

  function hrefFor(path) {
    return (BASE || '') + (path === '/' ? '/' : path);
  }

  function go(path) {
    if (path === active) return;
    history.pushState(null, '', hrefFor(path));
    render();
    window.scrollTo(0, 0);
  }

  window.addEventListener('popstate', render);

  function tidyPath(p) {
    if (!p) p = '/';
    if (p.charAt(0) !== '/') p = '/' + p;
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return p;
  }

  /**
   * The page of THIS project a link points at, or null — in which case the browser
   * handles it normally. Deliberately narrow: same origin, no query or hash (?config=
   * and anchors keep their meaning), and the result must name a page this project
   * actually has, so /build, /fork and every external link stay real navigations.
   *
   * Two spellings both count, because both are what people write. A link the site
   * generated carries the full /p/<id>/two. A link an author typed in Markdown says
   * "/two" — the same project-relative path they would put in `nav: [{ to }]` — and
   * that one was not merely losing the dev log: as a bare root path it pointed at
   * /two on the origin, which is not a page of anything. Routing it is what makes it
   * work at all.
   */
  function internalPath(a) {
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#') return null;
    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return null; }
    if (url.origin !== location.origin || url.search || url.hash) return null;
    if (BASE && url.pathname.indexOf(BASE) === 0) {
      var under = tidyPath(url.pathname.slice(BASE.length));
      if (pages[under]) return under;
    }
    var bare = tidyPath(url.pathname);
    return pages[bare] ? bare : null;
  }

  document.addEventListener('click', function (ev) {
    var link = ev.target.closest && ev.target.closest('a[href]');
    if (!link || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
    var to = link.getAttribute('data-sb-to');
    if (!to) {
      /*
       * A Markdown link — or any authored one — into a page of this same site is
       * navigation, not a new document. It used to be a full page load: the SDK re-init
       * and every iframe rebuilt for a move the router already does in place, and the dev
       * log thrown away with the old window. Nav links were always routed; these were the
       * ones that were not.
       */
      if (link.target && link.target !== '_self') return;
      to = internalPath(link);
      if (!to) return;
    }
    ev.preventDefault();
    go(to);
  });

  // ------------------------------------------------------------------ chrome

  function mergeChrome(base, override) {
    var out = {};
    if (base) Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    if (override) Object.keys(override).forEach(function (k) { out[k] = override[k]; });
    return out;
  }

  function linkNode(link, path) {
    var a = el('a', null, link.label);
    if (link.to) {
      a.href = hrefFor(link.to);
      a.setAttribute('data-sb-to', link.to);
      if (link.to === path) a.setAttribute('aria-current', 'page');
    } else if (link.url) {
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else {
      a.href = '#';
    }
    return a;
  }

  function renderHeader(cfg, path) {
    if (!cfg || cfg.show === false || (!cfg.title && !cfg.logoUrl && !cfg.nav)) {
      headerEl.hidden = true;
      return;
    }
    headerEl.hidden = false;
    headerEl.setAttribute('data-sticky', cfg.sticky === false ? '0' : '1');
    headerEl.setAttribute('data-align', cfg.align || 'split');
    if (cfg.style) headerEl.setAttribute('style', cfg.style);
    clear(headerEl);

    var wrap = el('div', 'sb-wrap');
    var inner = el('div', 'sb-header-in');
    var brand = el('div', 'sb-brand');

    if (cfg.logoUrl) {
      var img = el('img');
      img.src = cfg.logoUrl;
      img.alt = cfg.title || '';
      img.loading = 'eager';
      brand.appendChild(img);
    }
    if (cfg.title || cfg.subtitle) {
      var stack = el('div');
      if (cfg.title) stack.appendChild(bindText(el('div', 'sb-title'), cfg.title));
      if (cfg.subtitle) stack.appendChild(bindText(el('div', 'sb-subtitle'), cfg.subtitle));
      brand.appendChild(stack);
    }
    inner.appendChild(brand);

    if (cfg.nav && cfg.nav.length) {
      var nav = el('nav', 'sb-nav');
      cfg.nav.forEach(function (link) {
        nav.appendChild(linkNode(link, path));
      });
      inner.appendChild(nav);
    }

    wrap.appendChild(inner);
    headerEl.appendChild(wrap);
  }

  function renderFooter(cfg, path) {
    if (!cfg || cfg.show === false || (!cfg.text && !cfg.links)) {
      footerEl.hidden = true;
      return;
    }
    footerEl.hidden = false;
    if (cfg.style) footerEl.setAttribute('style', cfg.style);
    clear(footerEl);
    var wrap = el('div', 'sb-wrap');
    var inner = el('div', 'sb-footer-in');
    inner.appendChild(bindText(el('div'), cfg.text || ''));
    if (cfg.links && cfg.links.length) {
      var links = el('nav', 'sb-nav');
      cfg.links.forEach(function (link) {
        links.appendChild(linkNode(link, path));
      });
      inner.appendChild(links);
    }
    wrap.appendChild(inner);
    footerEl.appendChild(wrap);
  }

  // ------------------------------------------------------------------- blocks

  function renderButtons(block, scope) {
    var row = el('div', 'sb-btns');
    if (block.align) row.setAttribute('data-align', block.align);
    (block.items || []).forEach(function (item) {
      var btn = el('button', 'sb-btn', item.label);
      btn.type = 'button';
      btn.setAttribute('data-variant', item.variant || 'secondary');
      btn.addEventListener('click', function () {
        runButtonActions(item, btn, scope);
      });
      row.appendChild(btn);
    });
    return row;
  }

  function styled(node, block) {
    if (block && block.style) {
      node.setAttribute('style', interpolate(block.style));
      if (TOKEN.test(block.style)) styleBindings.push({ node: node, tpl: block.style });
      TOKEN.lastIndex = 0;
    }
    return node;
  }

  function renderBlocks(page) {
    return renderBlocksInto(contentEl, page.blocks, active);
  }

  function renderBlocksInto(container, blocks, scope) {
    clear(container);
    var embedMounts = [];
    appendBlocks(container, blocks, scope, embedMounts);
    return embedMounts;
  }

  /**
   * Recurses into rows/columns. `embedMounts.length` is the embed index, so it stays
   * document order across columns — which is what button `embedIndex` refers to.
   */
  function appendBlocks(container, blocks, scope, embedMounts) {
    (blocks || []).forEach(function (block) {
      switch (block.type) {
        case 'heading':
          // Classed like every other block, so page CSS can reach it by name.
          container.appendChild(styled(bindText(el('h' + (block.level || 2), 'sb-heading'), block.text), block));
          break;
        case 'text':
          // A div, not a p: Markdown can produce lists and code blocks, which a <p>
          // cannot legally contain. The .sb-text class is unchanged, so page CSS that
          // reaches for it still works.
          container.appendChild(styled(bindText(el('div', 'sb-text'), block.text, true), block));
          break;
        case 'value': {
          var vrow = el('div', 'sb-value');
          if (block.label) vrow.appendChild(el('span', 'sb-value-label', block.label));
          var out = el('span', 'sb-value-out');
          valueBindings.push({ node: out, key: block.key, placeholder: block.placeholder });
          vrow.appendChild(out);
          container.appendChild(styled(vrow, block));
          break;
        }
        case 'divider':
          container.appendChild(styled(el('hr', 'sb-divider'), block));
          break;
        case 'spacer': {
          var sp = el('div');
          sp.style.height = block.size || '24px';
          container.appendChild(sp);
          break;
        }
        case 'buttons':
          container.appendChild(styled(renderButtons(block, scope), block));
          break;
        case 'embed': {
          var wrapper = styled(el('div', 'sb-embed'), block);
          wrapper.appendChild(el('div', 'sb-skeleton', 'Loading embed…'));
          container.appendChild(wrapper);
          embedMounts.push({
            wrapper: wrapper,
            spec: block.embed,
            idx: embedMounts.length,
            scope: scope,
          });
          break;
        }
        case 'row': {
          var row = styled(el('div', 'sb-row'), block);
          var cols = block.columns || [];
          if (block.gap) row.style.gap = block.gap;
          if (block.align) row.setAttribute('data-align', block.align);
          row.style.gridTemplateColumns = cols
            .map(function (c) { return (c.span || 1) + 'fr'; })
            .join(' ');
          cols.forEach(function (col) {
            var cell = el('div', 'sb-col');
            appendBlocks(cell, col.blocks, scope, embedMounts);
            row.appendChild(cell);
          });
          container.appendChild(row);
          break;
        }
      }
    });
  }

  function applyPageCss(css) {
    if (!pageStyle) {
      pageStyle = document.createElement('style');
      pageStyle.id = 'sb-page-css';
      document.head.appendChild(pageStyle);
    }
    pageStyle.textContent = css || '';
  }

  // -------------------------------------------------------------------- modals

  function modalsFor(path) {
    var page = pages[path];
    var out = {};
    var site = M.project.modals || {};
    Object.keys(site).forEach(function (k) { out[k] = site[k]; });
    var local = (page && page.modals) || {};
    Object.keys(local).forEach(function (k) { out[k] = local[k]; });
    return out;
  }

  function ensureModalDom() {
    if (modalEl) return modalEl;
    modalEl = el('div', 'sb-modal-backdrop');
    modalEl.hidden = true;
    var dialog = el('div', 'sb-modal');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    var head = el('div', 'sb-modal-head');
    head.appendChild(el('span', 'sb-modal-title'));
    var x = el('button', 'sb-modal-x', '\u2715');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', closeModal);
    head.appendChild(x);
    dialog.appendChild(head);
    dialog.appendChild(el('div', 'sb-modal-body'));
    modalEl.appendChild(dialog);
    modalEl.addEventListener('click', function (ev) {
      if (ev.target === modalEl) closeModal();
    });
    document.body.appendChild(modalEl);
    return modalEl;
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && openModalName) closeModal();
  });

  function openModal(name) {
    if (!name) return;
    var modal = modalsFor(active)[name];
    if (!modal) {
      console.warn('[' + NS + '] no modal named "' + name + '" on this page or site.');
      return;
    }
    if (openModalName) closeModal();

    var root = ensureModalDom();
    var dialog = root.querySelector('.sb-modal');
    root.querySelector('.sb-modal-title').textContent = modal.title || name;
    dialog.setAttribute('style', 'max-width:' + (modal.width || '900px') + (modal.style ? ';' + modal.style : ''));

    var scope = 'modal:' + name;
    var body = root.querySelector('.sb-modal-body');
    var mounts = renderBlocksInto(body, modal.blocks, scope);
    openModalName = name;
    root.hidden = false;
    refreshBindings();

    if (mounts.length) {
      ensureSdk().then(
        function () {
          mounts.forEach(function (m) {
            mountEmbed(m.scope, m.spec, m.wrapper, m.idx);
          });
        },
        function (err) {
          mounts.forEach(function (m) {
            clear(m.wrapper);
            m.wrapper.appendChild(note(sdkErrorTitle(err), err.message));
          });
        },
      );
    }
  }

  function closeModal() {
    if (!openModalName) return;
    var scope = 'modal:' + openModalName;
    releaseEmbed(scope);
    openModalName = null;
    if (modalEl) {
      modalEl.hidden = true;
      clear(modalEl.querySelector('.sb-modal-body'));
    }
    refreshBindings();
  }

  // ------------------------------------------------------- embed event rules

  function readPath(payload, path) {
    if (!path) return payload;
    var parts = String(path).split('.');
    var cur = payload;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) break;
      cur = cur[parts[i]];
    }
    return cur;
  }

  /**
   * The token API buries its message: error.message.debug.debug is a JSON-encoded
   * array, whose entry may carry 'Invalid parameter values: {"field":"why"}'.
   */
  function tokenApiMessage(body) {
    try {
      var msg = body && body.error && body.error.message;
      if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return msg; } }
      var dbg = msg && msg.debug;
      var incident = dbg && dbg.incident_id_guid ? String(dbg.incident_id_guid).slice(0, 8) : null;
      var text = typeof dbg === 'string' ? dbg : dbg && dbg.debug;
      if (typeof text === 'string') {
        try {
          var arr = JSON.parse(text);
          if (Array.isArray(arr) && arr.length) text = arr.map(String).join('; ');
        } catch (e) { /* keep as is */ }
      }
      if (typeof text !== 'string' || !text) return null;
      var m = text.match(/^([^:{]+):\s*(\{[\s\S]*\})\s*$/);
      if (m) {
        try {
          var fields = JSON.parse(m[2]);
          var parts = Object.keys(fields).map(function (k) { return k + ': ' + String(fields[k]); });
          if (parts.length) text = m[1].replace(/\s+$/, '') + ' — ' + parts.join('; ');
        } catch (e) { /* keep the outer text */ }
      }
      return incident ? text + ' (incident ' + incident + ')' : text;
    } catch (e) { return null; }
  }

  // Distinct from the button runner below: same idea, different vocabulary.
  /** The SDK loading and the SDK being configurable are different failures. */
  function sdkErrorTitle(err) {
    return err && err.configError ? 'Embed not configured' : 'SDK failed to load';
  }

  // ------------------------------------------------------------ custom code
  //
  // A run-code action executes JavaScript in eval-sandbox: a cross-origin iframe that
  // cannot touch this page, its globals or its cookies. The code sees `payload`,
  // `variables` and `context`, may `await`, and `return`s a JSON value. The sandbox
  // only serialises a synchronous result, so the code is wrapped in an async function
  // whose settled value is written to the console under a marker and the run is ended
  // with "[DONE]" — which is how a Promise gets awaited across the iframe boundary.
  var CODE_RESULT_MARK = '__sb_result__';
  var CODE_ERROR_MARK = '__sb_error__';
  var VAR_RPC = '__sb_var_rpc__';
  var CODE_DEFAULT_TIMEOUT = 30000;
  var evaluatorPromise = null;
  var evaluator = null;
  var varRpcWired = false;

  /*
   * getVariable/setVariable inside the sandbox are a request/response over postMessage:
   * the code asks, this page reads or writes the real store, and answers. That is the only
   * way for a cross-origin iframe to reach the store, and it is why both are async.
   *
   * Guarded twice over: the message must come from the sandbox's own origin AND from the
   * sandbox iframe's window, so no other frame can drive the store through this channel.
   */
  function wireVarRpc(instance) {
    if (varRpcWired) return;
    varRpcWired = true;
    window.addEventListener('message', function (ev) {
      var d = ev.data;
      if (!d || d.kind !== VAR_RPC || !ev.source) return;
      var frame = instance && instance.iframe;
      if (!frame || ev.source !== frame.contentWindow) return;
      var sandboxOrigin;
      try { sandboxOrigin = new URL(frame.src, window.location.href).origin; } catch (e) { return; }
      if (ev.origin !== sandboxOrigin) return;

      var value = null;
      if (d.op === 'set') {
        store.set(d.key, d.value);
        value = d.value;
        devPush('code', 'setVariable', d.key, { value: d.value });
      } else {
        value = store.get(d.key);
      }
      try {
        ev.source.postMessage(
          { kind: VAR_RPC, id: d.id, value: value === undefined ? null : value },
          sandboxOrigin,
        );
      } catch (e) { /* the frame went away mid-run */ }
    });
  }

  function getEvaluator() {
    if (evaluatorPromise) return evaluatorPromise;
    var src = M.evalSandboxSrc || '/_static/live/eval-sandbox.js';
    evaluatorPromise = import(src).then(function (mod) {
      var opts = { fetch: true, timeout: CODE_DEFAULT_TIMEOUT };
      if (M.project.codeSandboxSrc) opts.src = M.project.codeSandboxSrc;
      return new mod.SandboxedEval(opts).init();
    }).then(function (instance) {
      evaluator = instance;
      wireVarRpc(instance);
      return instance;
    });
    evaluatorPromise.catch(function () { evaluatorPromise = null; });
    return evaluatorPromise;
  }

  function jsonSafe(value) {
    try { return JSON.stringify(value === undefined ? null : value) || 'null'; } catch (e) { return 'null'; }
  }

  /**
   * Where the code is running and what it may call — the same object the generated code
   * declares as `codeContext`. Nothing hook-specific belongs here: a marker the sandbox
   * sets but the export does not would make the same source behave differently in the two
   * places. What varies per run is the payload.
   */
  function codeContext() {
    var origin = (window.location && window.location.origin) || '';
    var api = origin + '/api/projects/' + M.projectId;
    return {
      path: active,
      project: { thoughtSpotHost: M.project.thoughtSpotHost || null, sdkVersion: M.project.sdkVersion || 'latest' },
      // Absolute, because the sandbox iframe is a different origin: a relative fetch
      // there would resolve against the sandbox page, not this site.
      tokenUrl: api + '/token',
      // Only reachable when the project sets clusterProxy; the way custom code
      // re-issues a call it intercepted without needing CORS on the cluster.
      clusterUrl: api + '/cluster',
    };
  }

  /** How long a getVariable/setVariable round trip may take before it gives up. */
  var VAR_RPC_TIMEOUT_MS = 5000;
  /** Everything the framework hands a code block, named in its signature. */
  var CODE_PARAMS = '{ payload, context, getVariable, setVariable }';

  function wrapCode(code, payload, context) {
    return (
      'var payload = ' + jsonSafe(payload) + ';\n' +
      'var context = ' + jsonSafe(context) + ';\n' +
      'var __sbRpcSeq = 0;\n' +
      // One round trip to the host page, which owns the store.
      'function __sbVarRpc(op, key, value) {\n' +
      '  return new Promise(function (resolve, reject) {\n' +
      '    var id = "v" + (++__sbRpcSeq) + "-" + Date.now();\n' +
      '    var timer = setTimeout(function () {\n' +
      '      window.removeEventListener("message", onMsg);\n' +
      '      reject(new Error(op + "Variable(" + key + ") got no answer from the page"));\n' +
      '    }, ' + VAR_RPC_TIMEOUT_MS + ');\n' +
      '    function onMsg(ev) {\n' +
      '      var d = ev.data;\n' +
      '      if (!d || d.kind !== ' + JSON.stringify(VAR_RPC) + ' || d.id !== id) return;\n' +
      '      clearTimeout(timer);\n' +
      '      window.removeEventListener("message", onMsg);\n' +
      '      resolve(d.value);\n' +
      '    }\n' +
      '    window.addEventListener("message", onMsg);\n' +
      '    parent.postMessage({ kind: ' + JSON.stringify(VAR_RPC) + ', id: id, op: op, key: key, value: value }, "*");\n' +
      '  });\n' +
      '}\n' +
      'function getVariable(key) { return __sbVarRpc("get", key); }\n' +
      'function setVariable(key, value) { return __sbVarRpc("set", key, value); }\n' +
      // The user's code runs as a function whose signature names everything the framework
      // provides — the same signature the generated code declares.
      'var __sbFn = async function (' + CODE_PARAMS + ') {\n' + code + '\n};\n' +
      'Promise.resolve().then(function () {\n' +
      '  return __sbFn({ payload: payload, context: context,' +
      ' getVariable: getVariable, setVariable: setVariable });\n' +
      '})' +
      '.then(function (v) { console.log(' + JSON.stringify(CODE_RESULT_MARK) + ', JSON.stringify(v === undefined ? null : v)); },' +
      ' function (e) { console.log(' + JSON.stringify(CODE_ERROR_MARK) + ', String((e && e.message) || e)); })' +
      '.then(function () { console.log("[DONE]"); });'
    );
  }

  /** Resolves with the code's return value; rejects with its error or a timeout. */
  function runCode(params, payload, label) {
    var started = Date.now();
    // The block's own name is what the author will recognise in a log.
    if (params.name) label = params.name;
    var timeout = params.timeout || CODE_DEFAULT_TIMEOUT;
    var context = codeContext();
    return getEvaluator()
      .then(function (ev) {
        return ev.run(wrapCode(params.code, payload, context), { module: false, done: 'signal', timeout: timeout });
      })
      .then(function (run) {
        var out = { ok: false, value: undefined, error: null, logs: [] };
        (run.logs || []).forEach(function (entry) {
          var a0 = entry.args && entry.args[0] && entry.args[0].value;
          if (a0 === CODE_RESULT_MARK) {
            var raw = entry.args[1] && entry.args[1].value;
            try { out.value = raw === undefined ? null : JSON.parse(raw); } catch (e) { out.value = raw; }
            out.ok = true;
          } else if (a0 === CODE_ERROR_MARK) {
            out.error = new Error((entry.args[1] && entry.args[1].value) || 'custom code failed');
          } else {
            out.logs.push(entry.text);
            console.log('[' + NS + ' code] ' + entry.text);
          }
        });
        if (run.timedOut) out.error = new Error('custom code timed out after ' + timeout + 'ms');
        else if (!out.ok && !out.error && run.error) out.error = new Error(run.error.message || 'custom code failed');
        else if (!out.ok && !out.error) out.error = new Error('custom code produced no result');
        devPush('code', label || 'run-code', out.error ? 'error' : 'sandbox', {
          ms: Date.now() - started,
          result: out.error ? undefined : out.value,
          error: out.error ? out.error.message : undefined,
          logs: out.logs,
        });
        if (out.error) throw out.error;
        return out.value;
      });
  }

  /** A hook's actions, in order; run-code values go to `store` and to onValue. */
  function runHookActions(actions, payload, label, onValue) {
    var chain = Promise.resolve();
    (actions || []).forEach(function (action) {
      chain = chain
        .then(function () {
          if (action.type === 'run-code') {
            var p = action.params || {};
            return runCode(p, payload, label).then(function (v) {
              if (p.store) store.set(p.store, v);
              if (onValue) onValue(v);
            });
          }
          return runEventAction(action, payload, active);
        })
        .catch(function (err) {
          console.error('[' + NS + '] ' + label + ' action ' + action.type + ' failed', err);
        });
    });
    return chain;
  }

  function deepMerge(base, patch) {
    var out = {};
    Object.keys(base || {}).forEach(function (k) { out[k] = base[k]; });
    Object.keys(patch || {}).forEach(function (k) {
      var pv = patch[k];
      var bv = out[k];
      var both = pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv);
      out[k] = both ? deepMerge(bv, pv) : pv;
    });
    return out;
  }

  function runEventAction(action, payload, scope) {
    var p = action.params || {};
    switch (action.type) {
      case 'run-code':
        return runCode(p, payload, 'run-code').then(function (v) {
          if (p.store) store.set(p.store, v);
          return v;
        });
      case 'set':
        // A literal writes that exact value; otherwise the value is a payload path.
        return store.set(
          p.key,
          Object.prototype.hasOwnProperty.call(p, 'literal') ? p.literal : readPath(payload, p.value),
        );
      case 'open-modal':
        return openModal(p.name);
      case 'close-modal':
        return closeModal();
      case 'nav':
        return go(p.to);
      case 'open-url':
        return window.open(p.url, p.target || '_blank', 'noopener,noreferrer');
      case 'remount':
        if (!reapplyAllowed(p, 'remount')) return false;
        return remountEmbeds(p.targets, scope);
      case 'update-embed':
        if (!reapplyAllowed(p, 'update-embed')) return false;
        return updateEmbedParams(p.targets, scope);
      case 'HostEvent':
      case 'host-event':
        return trigger(
          p.type || p.hostEvent,
          p.payload !== undefined ? p.payload : p.data,
          p.targets,
          scope,
          p.store,
        );
      default:
        console.warn('[' + NS + '] unknown action type "' + action.type + '"');
    }
  }

  function runHandler(handler, payload, scope, responder) {
    if (handler.id !== undefined) {
      var actionId =
        payload && payload.data && payload.data.id !== undefined
          ? String(payload.data.id)
          : payload && payload.id !== undefined
            ? String(payload.id)
            : null;
      if (String(handler.id) !== actionId) return;
    }
    /*
     * An event that WAITS is answered first, then the actions run. Answering is the
     * urgent part — the embed is blocked until it hears back — and an action with a side
     * effect (a remount, say) would otherwise tear down the frame the reply is owed to.
     */
    var chain = Promise.resolve();
    if (handler.respond) {
      chain = chain.then(function () {
        if (typeof responder !== 'function') {
          console.warn('[' + NS + '] ' + handler.type + ' has a respond block but the SDK passed no responder');
          return;
        }
        var p = handler.respond.params || {};
        return runCode(p, payload, handler.type + ' respond').then(
          function (v) { if (p.store) store.set(p.store, v); responder(v); },
          function (err) {
            console.error('[' + NS + '] respond code for ' + handler.type + ' failed', err);
            if (Object.prototype.hasOwnProperty.call(p, 'fallback')) responder(p.fallback);
          },
        );
      });
    }
    // Then the actions, in order, each run-code awaited before the next starts.
    (handler.actions || []).forEach(function (action) {
      chain = chain
        .then(function () { return runEventAction(action, payload, scope); })
        .catch(function (err) { console.error('[' + NS + '] action ' + action.type + ' failed', err); });
    });
    return chain;
  }

  // An EmbedEvent name, or the SDK's composed "<host event> Subscribed" — the event the
  // app fires once it has subscribed a listener for that host event, which is the only
  // race-free moment to trigger one at load time (SDK 1.48+ / 26.4). Both spellings of
  // the host event are accepted: the enum key ("Share") and its wire value ("share").
  function resolveEvent(type) {
    var events = sdk.EmbedEvent || {};
    var hostEvents = sdk.HostEvent || {};
    var version = M.project.sdkVersion || 'latest';
    var parts = /^(\S+) Subscribed$/.exec(type || '');
    if (parts) {
      if (!events.Subscribed) {
        console.warn(
          '[' + NS + '] SDK ' + version + ' has no EmbedEvent.Subscribed (needs 1.48+) — "' +
            type + '" handler not wired.',
        );
        return null;
      }
      var host = hostEvents[parts[1]] || parts[1];
      return host + ' ' + events.Subscribed;
    }
    if (!events[type]) {
      console.warn(
        '[' + NS + '] SDK ' + version + ' has no EmbedEvent named "' + type +
          '" — handler not wired.',
      );
      return null;
    }
    return events[type];
  }

  // Registered before render()/preRender() so no early events are missed.
  function wireHandlers(embed, handlers) {
    if (!handlers || !handlers.length) return;
    var scope = active;
    handlers.forEach(function (handler) {
      var evt = resolveEvent(handler.type);
      if (!evt) return;
      try {
        embed.on(evt, function (payload, responder) {
          runHandler(handler, payload, scope, responder);
        });
      } catch (err) {
        console.warn('[' + NS + '] could not subscribe to ' + handler.type, err);
      }
    });
  }

  // --------------------------------------------------- built-in error surface

  var CORS_HINT =
    /CORS|Content Security Policy|frame-ancestors|Refused to (frame|display|connect)|blocked by|X-Frame-Options/i;

  function showEmbedError(payload) {
    if (openModalName) {
      console.warn(
        '[' + NS + '] embed error arrived while "' + openModalName +
          '" was open — not replacing it. See ' + NS + ".get('embedError').",
      );
      return;
    }
    var root = ensureModalDom();
    var dialog = root.querySelector('.sb-modal');
    root.querySelector('.sb-modal-title').textContent = 'Embed error';
    dialog.setAttribute('style', 'max-width:680px');

    var body = root.querySelector('.sb-modal-body');
    clear(body);

    var text = display(payload);
    var host = M.project.thoughtSpotHost || '(no host set)';

    if (CORS_HINT.test(text)) {
      var box = el('div', 'sb-note');
      box.appendChild(el('strong', null, 'This looks like the cluster refusing to be embedded here'));
      box.appendChild(
        document.createTextNode(
          'Your ThoughtSpot cluster has to be told which origins may embed it. Add the origin ' +
            'below to the CSP visual-embed hosts allowlist for ' + host +
            ' (in ThoughtSpot: Develop \u2192 Security settings), and to the CORS allowlist as well if ' +
            'this demo calls REST APIs from the browser. Changes can take a minute to propagate.',
        ),
      );
      body.appendChild(box);

      var originRow = el('div', 'sb-value');
      originRow.appendChild(el('span', 'sb-value-label', 'Allowlist this origin'));
      originRow.appendChild(el('span', 'sb-value-out', location.origin));
      body.appendChild(originRow);

      var hostRow = el('div', 'sb-value');
      hostRow.appendChild(el('span', 'sb-value-label', 'On this cluster'));
      hostRow.appendChild(el('span', 'sb-value-out', host));
      body.appendChild(hostRow);
    } else {
      var generic = el('div', 'sb-note');
      generic.appendChild(el('strong', null, 'The embed reported an error'));
      generic.appendChild(
        document.createTextNode('Full payload below. It is also in ' + NS + ".get('embedError')."),
      );
      body.appendChild(generic);
    }

    var pre = el('pre', 'sb-modal-pre', text);
    body.appendChild(pre);

    openModalName = '__error';
    root.hidden = false;
  }

  /**
   * A token minted for N seconds expires after N seconds; the SDK says so and fetches
   * another. That is the system working, not a fault, so it never opens a modal —
   * it is logged and left in the store for anyone who wants it.
   */
  var EXPIRY_SIGNAL = /AuthExpire|ThoughtspotAuthExpired|IdleSessionTimeout|RefreshAuthToken|TOKEN_EXPIR|SESSION_EXPIR/i;

  function isExpirySignal(payload) {
    if (!payload) return false;
    var probe = [payload.errorType, payload.code, payload.type, payload.message]
      .filter(function (v) { return typeof v === 'string'; })
      .join(' ');
    return EXPIRY_SIGNAL.test(probe);
  }

  /*
   * The SDK fires EmbedEvent.Error for a lot of non-fatal things — a validation warning,
   * a failed viz API call, a transient network blip the SDK retries, a custom-action
   * mismatch. Popping a modal over the whole page for those is noise. We only interrupt
   * for "sev 1": the embed genuinely cannot show — auth/login failed, init failed, the
   * object id is missing/not found, or the cluster refuses to be framed (CSP). Everything
   * else is logged and left in NS.get('embedError'), never modal-ed.
   *
   * Payload shape varies by SDK version:
   *   old: { type:'Error', data:{ errorType, error:{ message, code } } }
   *   new: { errorType, message, code }
   */
  var FATAL_ERROR = /LOGIN_FAILED|INIT_ERROR|LIVEBOARD_ID_MISSING|WORKSHEET_ID_NOT_FOUND|SDK_NOT_INITIALIZED|INVALID_TOKEN|CSP|FRAME_HOST|frame-ancestors/i;

  function errorProbe(payload) {
    if (!payload) return '';
    var d = payload.data || {};
    var inner = d.error || payload.error || {};
    return [
      payload.errorType, payload.code, payload.message,
      d.errorType, d.code, d.message,
      inner.code, inner.message, inner.error,
      typeof payload === 'string' ? payload : null,
    ].filter(function (v) { return typeof v === 'string'; }).join(' ');
  }

  function isFatalError(payload) {
    var probe = errorProbe(payload) || display(payload);
    // The cluster refusing to be embedded is always fatal — nothing can render.
    return CORS_HINT.test(probe) || FATAL_ERROR.test(probe);
  }

  function wireErrorSurface(embed) {
    var events = sdk.EmbedEvent || {};
    // Subscribed even when error modals are off, so expiry is still visible in the log.
    if (events.AuthExpire) {
      try {
        embed.on(events.AuthExpire, function () {
          console.info('[' + NS + '] auth token expired — the SDK is refreshing it. Not an error.');
          store.set('authExpiredAt', Date.now());
        });
      } catch (err) { /* older SDKs may not emit it */ }
    }
    if (M.project.showEmbedErrors === false) return;
    if (!events.Error) return;
    try {
      embed.on(events.Error, function (payload) {
        store.set('embedError', payload);
        if (isExpirySignal(payload)) {
          console.info('[' + NS + '] ignoring an expiry signal on the Error channel', payload);
          return;
        }
        // Only "sev 1" errors interrupt with a modal; the rest are logged and parked in
        // the store. A site can still read every error via NS.get('embedError').
        if (!isFatalError(payload)) {
          console.warn(
            '[' + NS + '] embed reported a non-fatal error — modal suppressed. ' +
              'See ' + NS + ".get('embedError').",
            payload,
          );
          return;
        }
        // A site-defined "embed-error" modal wins, so this is overridable.
        if (modalsFor(active)['embed-error']) openModal('embed-error');
        else showEmbedError(payload);
      });
    } catch (err) {
      console.warn('[' + NS + '] could not subscribe to Error', err);
    }
  }

  // -------------------------------------------------------------------- embeds

  function embedClass(type) {
    var candidates = {
      liveboard: ['LiveboardEmbed'],
      viz: ['LiveboardEmbed'],
      search: ['SearchEmbed'],
      searchbar: ['SearchBarEmbed'],
      app: ['AppEmbed'],
      spotter: ['SpotterEmbed', 'ConversationEmbed'],
      conversation: ['ConversationEmbed', 'SpotterEmbed'],
    }[type] || [];
    for (var i = 0; i < candidates.length; i++) {
      if (sdk[candidates[i]]) return sdk[candidates[i]];
    }
    return null;
  }

  function buildConfig(spec) {
    var cfg = {};
    var defaults = M.project.embedDefaults || {};
    Object.keys(defaults).forEach(function (k) {
      cfg[k] = defaults[k];
    });
    // spec.config IS the SDK config; the runtime's own keys never sat in it.
    var own = spec.config || {};
    Object.keys(own).forEach(function (k) { cfg[k] = own[k]; });
    if (!cfg.fullHeight) {
      cfg.frameParams = cfg.frameParams || {};
      if (spec.height) cfg.frameParams.height = spec.height;
      if (cfg.frameParams.height === undefined) cfg.frameParams.height = 640;
    }
    return cfg;
  }

  // Slots are keyed per embed BLOCK, not per page — a page may declare several.
  function slotKey(path, idx) {
    return path + '#' + idx;
  }

  /**
   * Embed config may reference stored values: answerId: "{{answerId}}". Returns the
   * resolved config plus any tokens that had no value yet, so the caller can wait
   * instead of constructing an embed with a blank id.
   */
  function resolveTokens(value, missing) {
    if (typeof value === 'string') {
      return value.replace(TOKEN, function (_, path) {
        var got = lookup(path);
        if (got === undefined || got === null) {
          missing.push(path);
          return '';
        }
        return display(got);
      });
    }
    if (Array.isArray(value)) {
      return value.map(function (v) { return resolveTokens(v, missing); });
    }
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) { out[k] = resolveTokens(value[k], missing); });
      return out;
    }
    return value;
  }

  function slotFor(path, spec, idx, override) {
    var key = slotKey(path, idx);
    if (slots[key]) return slots[key];
    var Cls = embedClass(spec.type);
    if (!Cls) {
      throw new Error(
        'SDK ' + (M.project.sdkVersion || 'latest') + ' has no embed class for type "' + spec.type + '".',
      );
    }
    var host = el('div', 'sb-embed-host');
    host.id = 'sb-slot-' + keyOf(path) + '_' + idx;
    if (spec.width) host.style.maxWidth = spec.width;
    var missing = [];
    var cfg = resolveTokens(buildConfig(spec), missing);
    // What beforeRender code returned, merged over the resolved config.
    if (override) cfg = deepMerge(cfg, override);
    if (missing.length) {
      var waiting = new Error('waiting for ' + missing.join(', '));
      waiting.waitingFor = missing;
      throw waiting;
    }
    // preRender marks a PreRendered*Embed: it renders nothing itself, and exists so an
    // embed carrying the same preRenderId can attach to an iframe that already loaded.
    // Everything else is just new Cls(host, cfg).render().
    var isPreRender = !!spec.preRender && String(path).indexOf('modal:') !== 0;
    // The host is the rect showPreRender() syncs to. A *connecting* embed (has a
    // preRenderId but is not the PreRendered instance itself) never mounts an iframe
    // inside this host — the SDK floats the body-level pre-render wrapper over it — so
    // the host has nothing to give it height and collapses to 0, and showPreRender()
    // then syncs the wrapper to a 0-height rect: the embed loads but never shows. So a
    // connecting host must be sized to the frame explicitly. A plain embed fills its own
    // host, so spec.height alone is enough there.
    if (!cfg.fullHeight) {
      var frameH = cfg.frameParams && cfg.frameParams.height;
      var connecting = !isPreRender && cfg.preRenderId;
      var h = spec.height || (connecting ? frameH : null);
      if (h !== undefined && h !== null) host.style.height = typeof h === 'number' ? h + 'px' : h;
    }
    var entry = {
      host: host,
      spec: spec,
      embed: null,
      isPreRender: isPreRender,
      rendered: false,
      key: key,
    };

    if (isPreRender) {
      // Off-screen and never attached to the page: nothing here is meant to be seen.
      atticEl.appendChild(host);
      entry.embed = new Cls('#' + host.id, cfg);
      wireAll(entry.embed, spec);
      entry.embed.preRender();
      entry.rendered = true;
    } else {
      entry.embed = new Cls(host, cfg);
      wireAll(entry.embed, spec);
    }

    slots[key] = entry;
    return entry;
  }

  function wireAll(embed, spec) {
    wireHandlers(embed, spec.embedEventHandlers);
    wireErrorSurface(embed);
    wireDevEvents(embed);
  }

  /**
   * The id the SDK refuses to render without. Only these four: a SearchEmbed opens
   * blank quite happily, and AppEmbed defaults to Home.
   */
  var REQUIRED_ID = {
    liveboard: 'liveboardId',
    viz: 'liveboardId',
    spotter: 'worksheetId',
    conversation: 'worksheetId',
  };

  function missingId(spec) {
    // A PreRendered*Embed holds an id, not content. It may carry nothing else.
    if (spec.preRender) return null;
    var key = REQUIRED_ID[spec.type];
    if (!key) return null;
    var cfg = spec.config || {};
    return cfg[key] ? null : key;
  }

  function mountEmbed(path, spec, wrapper, idx) {
    // Nothing can load before init() has what it needs, and the visitor is the one who
    // can supply it — so say so where the embed would be, and open the panel once.
    var initMissing = initNeeds();
    if (initMissing.length) {
      clear(wrapper);
      var box = note(
        'Settings needed',
        'This embed needs ' + initMissing.join(' and ') + '. Open Settings, fill it in, ' +
          'and press Load — it stays in this browser.',
      );
      var openBtn = el('button', 'sb-btn', 'Open settings');
      openBtn.setAttribute('data-variant', 'primary');
      openBtn.style.marginTop = '10px';
      openBtn.onclick = function () { showSettings(); };
      box.appendChild(openBtn);
      wrapper.appendChild(box);
      autoOpenSettings();
      return;
    }
    // Constructing it anyway just produces LIVEBOARD_ID_MISSING in the error modal,
    // which says nothing the page cannot say better itself.
    var needs = missingId(spec);
    if (needs) {
      clear(wrapper);
      wrapper.appendChild(note(
        'No ' + needs + ' yet',
        'This ' + spec.type + ' embed has no ' + needs + '. Set one in the builder ' +
          '(select the block, then Pick…) or over MCP.',
      ));
      return;
    }
    // beforeRender runs once, before the embed is constructed, with the resolved config
    // as payload.config. Objects it returns are merged into that config. A wrapper
    // remembers the result so the re-entry below does not run the hook twice.
    if (!slots[slotKey(path, idx)] && spec.beforeRender && spec.beforeRender.length && !wrapper.__sbBeforeRender) {
      var hookMissing = [];
      var hookCfg = resolveTokens(buildConfig(spec), hookMissing);
      if (!hookMissing.length) {
        clear(wrapper);
        wrapper.appendChild(note('Preparing embed', 'Running before-render code…'));
        var override = {};
        runHookActions(
          spec.beforeRender,
          { config: hookCfg, type: spec.type, name: spec.name || null, path: path },
          'beforeRender',
          function (v) { if (v && typeof v === 'object' && !Array.isArray(v)) override = deepMerge(override, v); },
        ).then(function () {
          wrapper.__sbBeforeRender = override;
          if (wrapper.isConnected) mountEmbed(path, spec, wrapper, idx);
        });
        return;
      }
    }
    var entry;
    try {
      entry = slotFor(path, spec, idx, wrapper.__sbBeforeRender || null);
    } catch (err) {
      clear(wrapper);
      if (err.waitingFor) {
        wrapper.appendChild(
          note(
            'Waiting for a value',
            'This embed needs ' + err.waitingFor.join(', ') + '. It renders as soon as ' +
              NS + '.set() provides it.',
          ),
        );
        // Re-mount once the first missing key arrives.
        var root = String(err.waitingFor[0]).split('.')[0];
        var off = store.on(root, function () {
          off();
          if (wrapper.isConnected) mountEmbed(path, spec, wrapper, idx);
        });
        return;
      }
      wrapper.appendChild(note('Embed unavailable', err.message));
      return;
    }
    if (entry.isPreRender) {
      // A PreRendered*Embed occupies no space on the page. preRender() already ran.
      clear(wrapper);
      wrapper.setAttribute('data-prerender', entry.spec.config.preRenderId || '');
      return;
    }
    // Kept so a remount can rebuild this embed in the same place.
    entry.wrapper = wrapper;
    entry.idx = idx;
    clear(wrapper);
    wrapper.appendChild(entry.host);
    // A connecting embed (carries a preRenderId but is not the background PreRendered
    // instance) is revealed with showPreRender(): it attaches to the shared pre-rendered
    // iframe by id and shows it, syncing the wrapper to this host's rect. render() does
    // NOT call showPreRender() under the hood — ideally it would, but it doesn't — so
    // render()ing a connecting embed reveals nothing and the background iframe stays
    // hidden. This mirrors the SDK's own guard:
    //   if (preRenderId) { tsEmbed.showPreRender(); return; }
    //   tsEmbed.render();
    // A plain embed with no preRenderId builds its own iframe with render(). Both calls
    // are safe to repeat on a revisit (showPreRender re-shows after hidePreRender).
    if (entry.spec.config && entry.spec.config.preRenderId) {
      entry.rendered = true;
      entry.embed.showPreRender();
    } else if (!entry.rendered) {
      entry.rendered = true;
      entry.embed.render();
    }
  }

  function releaseEmbed(path) {
    var prefix = path + '#';
    Object.keys(slots).forEach(function (key) {
      if (key.indexOf(prefix) !== 0) return;
      var entry = slots[key];
      try {
        if (entry.isPreRender) {
          // Left alone on purpose — the wrapper never destroys these either.
        } else if (entry.spec.config && entry.spec.config.preRenderId) {
          // Connected to a PreRendered iframe: hide it, never destroy it. The slot is
          // dropped so a revisit reconnects with a fresh showPreRender().
          entry.embed.hidePreRender();
          if (entry.host.parentNode) entry.host.parentNode.removeChild(entry.host);
          delete slots[key];
        } else {
          if (entry.embed.destroy) entry.embed.destroy();
          if (entry.host.parentNode) entry.host.parentNode.removeChild(entry.host);
          delete slots[key];
        }
      } catch (err) {
        delete slots[key];
      }
    });
  }

  /** Drops one slot entirely, so the next render rebuilds it from the new config. */
  function releaseSlot(key) {
    var entry = slots[key];
    if (!entry) return;
    try {
      if (entry.isPreRender) { try { entry.embed.hidePreRender(); } catch (e) { /* never rendered */ } }
      if (entry.embed.destroy) entry.embed.destroy();
    } catch (err) {
      /* an embed that never rendered has nothing to tear down */
    }
    if (entry.host && entry.host.parentNode) entry.host.parentNode.removeChild(entry.host);
    delete slots[key];
  }

  function embedSpecsOf(page) {
    var out = [];
    walkEmbeds((page && page.blocks) || [], out);
    return out;
  }

  function walkEmbeds(blocks, out) {
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block.type === 'embed') out.push({ spec: block.embed, idx: out.length });
      else if (block.type === 'row') {
        (block.columns || []).forEach(function (col) { walkEmbeds(col.blocks || [], out); });
      }
    }
  }

  /**
   * A page (or an open modal) may hold several embed blocks; index 0 is the
   * default target. Scope is a page path, or "modal:<name>".
   */
  function embedsInScope(scope) {
    var prefix = scope + '#';
    return Object.keys(slots)
      .filter(function (k) { return k.indexOf(prefix) === 0; })
      .sort()
      .map(function (k) { return slots[k]; });
  }

  /**
   * Targets are embed names or indices, "all" for every embed in scope, or omitted
   * for index 0 — the default that existed when a page could only have one target.
   */
  /**
   * Rebuild an embed from scratch: destroy the instance, drop the slot, mount again. Its
   * beforeRender hook runs afresh, so a config the code decides (disabledActions and the
   * like) is re-decided without reloading the page. Public SDK only — no hidden host event.
   */
  /**
   * `when` names a variable that must be truthy. Rebuilding or re-configuring an embed
   * makes the app re-issue the calls a handler is watching, so an unguarded re-apply
   * inside an ApiIntercept handler reloads forever — which is exactly what happened.
   */
  function reapplyAllowed(p, label) {
    if (!p.when) return true;
    var go = !!lookup(p.when);
    if (!go) devPush('host', label + ' skipped', p.when, { when: p.when, value: lookup(p.when) });
    return go;
  }

  function remountEmbeds(targets, scope) {
    var sc = scope || active;
    var entries = slotsFor(targets, sc);
    if (!entries.length) {
      console.warn('[' + NS + '] remount: no embed matching ' + JSON.stringify(targets));
      return false;
    }
    entries.forEach(function (entry) {
      var wrapper = entry.wrapper;
      var spec = entry.spec;
      var idx = entry.idx;
      if (!wrapper || !wrapper.isConnected) return;
      try {
        if (entry.embed && entry.embed.destroy) entry.embed.destroy();
      } catch (err) { /* already gone */ }
      if (entry.host && entry.host.parentNode) entry.host.parentNode.removeChild(entry.host);
      delete slots[entry.key];
      // The memo of what beforeRender returned last time, so the hook runs again.
      delete wrapper.__sbBeforeRender;
      mountEmbed(sc, spec, wrapper, idx);
    });
    devPush('host', 'remount', entries.map(function (e) { return (e.spec && e.spec.name) || e.key; }).join(', '), {
      embeds: entries.length,
    });
    return true;
  }

  /**
   * Apply an embed's beforeRender decision to the LIVE frame, without rebuilding it.
   *
   * This leans on two members the SDK marks protected in TypeScript — `viewConfig` and
   * `getUpdateEmbedParamsObject()` — and on `UpdateEmbedParams`, a host event the SDK
   * documents as hidden and uses for pre-rendered embeds. None of it is public API, so it
   * can break on an SDK upgrade; `remount` is the supported equivalent. Offered because a
   * live update keeps the frame's scroll and state, which a rebuild loses.
   */
  function updateEmbedParams(targets, scope) {
    var sc = scope || active;
    var entries = slotsFor(targets, sc);
    if (!entries.length) {
      console.warn('[' + NS + '] update-embed: no embed matching ' + JSON.stringify(targets));
      return Promise.resolve(false);
    }
    return Promise.all(entries.map(function (entry) {
      var embed = entry.embed;
      var spec = entry.spec;
      if (!embed || typeof embed.getUpdateEmbedParamsObject !== 'function' || !embed.viewConfig) {
        console.warn(
          '[' + NS + '] update-embed: SDK ' + (M.project.sdkVersion || 'latest') +
            ' does not expose getUpdateEmbedParamsObject — rebuilding instead.',
        );
        return remountEmbeds(targets, sc);
      }
      // The patch comes from the same hook a rebuild would re-run, so both paths agree.
      var decide = Promise.resolve({});
      var hooks = spec && spec.beforeRender;
      if (hooks && hooks.length) {
        var override = {};
        var missing = [];
        var base = resolveTokens(buildConfig(spec), missing);
        decide = runHookActions(
          hooks,
          { config: base, type: spec.type, name: spec.name || null, path: sc },
          'beforeRender',
          function (v) { if (v && typeof v === 'object' && !Array.isArray(v)) override = deepMerge(override, v); },
        ).then(function () { return override; });
      }
      return decide.then(function (patch) {
        Object.keys(patch).forEach(function (k) { embed.viewConfig[k] = patch[k]; });
        // A key the patch drops must be cleared, or a restriction never lifts.
        ['disabledActions', 'disabledActionReason'].forEach(function (k) {
          if (!(k in patch)) delete embed.viewConfig[k];
        });
        return embed.getUpdateEmbedParamsObject().then(function (params) {
          triggerOn(embed, (sdk.HostEvent || {}).UpdateEmbedParams || 'updateEmbedParams',
            'UpdateEmbedParams', params);
          devPush('host', 'UpdateEmbedParams', (spec && spec.name) || entry.key, {
            disableAction: params.disableAction,
            disableHint: params.disableHint,
          });
          return true;
        });
      });
    })).then(function () { return true; }, function (err) {
      console.error('[' + NS + '] update-embed failed', err);
      return false;
    });
  }

  /** The same target vocabulary as a host event, resolved to slots. */
  function slotsFor(targets, scope) {
    var sc = scope || active;
    var list = targets === undefined || targets === null ? [] : (Array.isArray(targets) ? targets : [targets]);
    if (!list.length) {
      var first = slots[slotKey(sc, 0)];
      return first ? [first] : [];
    }
    var out = [];
    list.forEach(function (target) {
      if (target === 'all') {
        embedsInScope(sc).forEach(function (e) { out.push(e); });
        return;
      }
      if (typeof target === 'number') {
        var byIdx = slots[slotKey(sc, target)];
        if (byIdx) out.push(byIdx);
        return;
      }
      embedsInScope(sc).some(function (e) {
        if (e.spec && e.spec.name === target) { out.push(e); return true; }
        return false;
      });
    });
    return out;
  }

  function embedsFor(targets, scope) {
    var sc = scope || active;
    var list = targets === undefined || targets === null ? [] : (Array.isArray(targets) ? targets : [targets]);
    if (!list.length) {
      var first = slots[slotKey(sc, 0)];
      return first ? [first.embed] : [];
    }
    var out = [];
    list.forEach(function (target) {
      if (target === 'all') {
        embedsInScope(sc).forEach(function (e) { if (e.embed) out.push(e.embed); });
        return;
      }
      var entry = null;
      if (typeof target === 'number') {
        entry = slots[slotKey(sc, target)];
      } else {
        embedsInScope(sc).some(function (e) {
          if (e.spec && e.spec.name === target) { entry = e; return true; }
          return false;
        });
      }
      if (entry && entry.embed) out.push(entry.embed);
      else console.warn('[' + NS + '] no embed matching target ' + JSON.stringify(target));
    });
    return out;
  }

  function activeEmbed(idx, scope) {
    var found = embedsFor(idx === undefined ? [] : idx, scope);
    return found.length ? found[0] : null;
  }

  // ------------------------------------------------------------------ actions

  // ------------------------------------------------------------------- dev
  // Dev mode is per visitor, per project: it costs nothing when off, and what it
  // shows — every host event we fire, its reply, and every embed event received —
  // is only useful to whoever is building the demo.

  var DEV_LS = 'sb.dev.' + M.projectId;
  // Bumped when the saved shape changed: the grammar lost its Only/Hide mode and the
  // default directions shrank, so a filter saved under the old key is not worth keeping.
  var DEVF_LS = 'sb.devf2.' + M.projectId;
  /*
   * 400 was far too small. An embed that actually loads against a cluster is chatty
   * enough to fill it in seconds, and because eviction is silent and the text filter hides
   * most of the traffic, the rows you were watching just disappear — which reads as the log
   * clearing itself. Entries hold a reference to a payload that already exists, so the
   * cost of a bigger log is small; the DOM only ever holds what the filter shows.
   */
  var DEV_CAP = 2000;
  // Two events this close together with the same name and payload are one event seen
  // twice — the wire copy of an EmbedEvent, or the SDK firing the same thing again.
  var DEV_MERGE_MS = 800;
  var DEV_DIRS = ['host', 'reply', 'embed', 'wire', 'code'];
  var DEV_BADGE = { host: '\u2191', reply: '\u21b3', embed: '\u2193', wire: '\u21c4', code: '\u2699' };
  // The five words in the head are the whole mental model of this panel, so each one
  // carries its own explanation — on its checkbox, and in the ? legend.
  var DEV_WHAT = {
    host: 'A host event this page sent INTO an embed — HostEvent.UpdateFilters, Navigate, Reload. Ours and the SDK\u2019s own.',
    reply: 'What that host event resolved to, plus the answers this page sends back when the iframe asks it something.',
    embed: 'An EmbedEvent the embed sent OUT to this page — Load, Data, VizPointClick — as delivered by EmbedEvent.ALL.',
    wire: 'Raw postMessage traffic from the iframe that never became an EmbedEvent: the SDK\u2019s own internal chatter.',
    code: 'This page\u2019s own doing — a variable set, a run-code block.',
  };
  var devOn = false;
  /*
   * host and embed are the two you actually read: what this page sent, and what came back
   * out of the embed. reply, wire and code are the same traffic seen closer up, and on by
   * default they buried the two lines anyone was looking for.
   */
  var DEV_DIRS_ON = { host: true, embed: true, reply: false, wire: false, code: false };
  var devFilter = { q: '', dirs: { host: true, embed: true, reply: false, wire: false, code: false } };
  var devEntries = [];
  var devSeq = 0;
  var devUi = null;
  var devFab = null;

  try { devOn = localStorage.getItem(DEV_LS) === '1'; } catch (e) { /* private mode */ }
  try {
    var savedF = JSON.parse(localStorage.getItem(DEVF_LS) || 'null');
    if (savedF && savedF.dirs) {
      devFilter = savedF;
      // A filter saved before a direction existed falls back to that direction's default.
      DEV_DIRS.forEach(function (d) {
        if (devFilter.dirs[d] === undefined) devFilter.dirs[d] = DEV_DIRS_ON[d];
      });
    }
  } catch (e) { /* private mode */ }

  function devSaveFilter() {
    try { localStorage.setItem(DEVF_LS, JSON.stringify(devFilter)); } catch (e) { /* private mode */ }
  }

  /** The SDK sends wire values ("load"); the name you would write is the member. */
  function eventMemberName(wire) {
    var events = (sdk && sdk.EmbedEvent) || {};
    var keys = Object.keys(events);
    for (var i = 0; i < keys.length; i++) if (events[keys[i]] === wire) return keys[i];
    return String(wire);
  }

  /** Which embed on the page this instance is, for the log. */
  function embedLabel(embed) {
    var keys = Object.keys(slots);
    for (var i = 0; i < keys.length; i++) {
      var s = slots[keys[i]];
      if (s && s.embed === embed) return (s.spec && s.spec.name) || keys[i];
    }
    return 'embed';
  }

  function devPayloadText(payload) {
    if (payload === undefined || payload === null) return '';
    if (typeof payload !== 'object') return String(payload);
    var body;
    try { body = JSON.stringify(payload); } catch (e) { body = ''; }
    return body.length > 4000 ? body.slice(0, 4000) : body;
  }

  /**
   * Everything a filter reads, derived once per entry since filtering re-reads it on
   * every keystroke. The name and the embed stay SEPARATE from the payload text, so an
   * anchored pattern (`Update*`) matches the event name and not a stray word in the data.
   */
  function devFields(entry) {
    if (entry.f === undefined) {
      entry.f = { name: entry.name, target: entry.target || '', body: devPayloadText(entry.payload) };
    }
    return entry.f;
  }

  /** An event's identity, so the wire's "load" and the EmbedEvent "Load" are one event. */
  function devKey(dir, name) {
    return (dir === 'wire' ? eventMemberName(name) : String(name)).toLowerCase();
  }

  function devPush(dir, name, target, payload) {
    if (!devOn) return;
    /*
     * The direction boxes say what to CAPTURE, not merely what to show. They used to be a
     * display filter: every direction was recorded whatever the boxes said, so unticked
     * traffic still spent the DEV_CAP budget and evicted the host and embed rows you were
     * actually watching. On a chatty embed that empties the panel in seconds and looks
     * exactly like the log clearing itself — which is what it was reported as.
     * The split that makes sense: the boxes are coarse and sticky, so they gate recording;
     * the text query is retyped constantly, so it only ever gates display.
     */
    if (!devFilter.dirs[dir]) return;
    var entry = {
      id: ++devSeq,
      at: new Date(),
      dir: dir,
      name: String(name),
      target: target || '',
      payload: payload,
      key: devKey(dir, name),
      n: 1,
    };

    /*
     * One iframe message becomes one EmbedEvent, so the wire row and the embed row right
     * behind it are the SAME event logged twice — which is what made every event look
     * doubled. Fold the pair into the embed row, which is the better of the two (real
     * member name, real embed label), and mark that it was also seen on the wire. A wire
     * row nothing claims stays on its own line, and that is the only wire traffic worth
     * a line: SDK-internal messages that never surface as an EmbedEvent.
     */
    if (dir === 'embed') {
      for (var i = devEntries.length - 1; i >= 0 && i > devEntries.length - 12; i--) {
        var w = devEntries[i];
        if (entry.at - w.at > DEV_MERGE_MS) break;
        if (w.dir !== 'wire' || w.key !== entry.key) continue;
        w.dir = 'embed';
        w.name = entry.name;
        w.target = entry.target;
        w.payload = payload;
        w.wire = true;
        w.f = undefined;
        if (devUi) devUi.update(w); else devMarkNew();
        return;
      }
    }

    // Anything genuinely repeated — a burst of identical replies, an event the SDK fires
    // twice — counts up on one row rather than scrolling the log away.
    var last = devEntries[devEntries.length - 1];
    if (last && last.dir === entry.dir && last.key === entry.key && last.target === entry.target &&
        entry.at - last.at <= DEV_MERGE_MS &&
        devPayloadText(last.payload) === devPayloadText(payload)) {
      last.n += 1;
      last.at = entry.at;
      if (devUi) devUi.update(last); else devMarkNew();
      return;
    }

    devEntries.push(entry);
    if (devEntries.length > DEV_CAP) devEntries.splice(0, devEntries.length - DEV_CAP);
    if (devUi) devUi.append(entry); else devMarkNew();
  }

  /**
   * Comma-separated terms, and WHERE THE * IS says what a term means. That is the whole
   * grammar:
   *   Update       plain text — matches anywhere
   *   Update*      starts with Update
   *   *Filters     ends with Filters
   *   *Filter*     contains Filter (the same as plain text)
   *   Up*Filters   starts with Up and ends with Filters
   * A leading ! or - turns any of those into "drop these rows", so
   *   Update*, Navigate*, !Subscribed
   * reads exactly as it sounds. /regex/ is there too for the rare pattern that needs
   * more. Compiled once per filter string, not once per row.
   */
  var devMatchQ = null;
  var devMatchers = { inc: [], exc: [] };
  var devBadRe = false;

  /** A * on one end drops the anchor at that end — that is all "starts with" is. */
  function devGlob(pattern) {
    var loose0 = pattern.charAt(0) === '*';
    var loose1 = pattern.charAt(pattern.length - 1) === '*';
    var body = pattern
      .replace(/^\*+/, '')
      .replace(/\*+$/, '')
      .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
      .replace(/\*/g, '[\\s\\S]*');
    return new RegExp((loose0 ? '' : '^') + body + (loose1 ? '' : '$'), 'i');
  }

  function devCompile(raw) {
    var t = raw.trim();
    var neg = false;
    while (t && (t.charAt(0) === '!' || t.charAt(0) === '-')) { neg = true; t = t.slice(1).trim(); }
    if (!t) return null;
    var re = /^\/(.*)\/([a-z]*)$/.exec(t);
    var test;
    if (re) {
      try {
        var rx = new RegExp(re[1], re[2] || 'i');
        test = function (s) { return rx.test(s); };
      } catch (e) {
        // An unfinished pattern is a typo in progress, not a reason to blank the log.
        devBadRe = true;
        return null;
      }
    } else if (t.indexOf('*') !== -1) {
      var gx = devGlob(t);
      test = function (s) { return gx.test(s); };
    } else {
      var low = t.toLowerCase();
      test = function (s) { return s.toLowerCase().indexOf(low) !== -1; };
    }
    return { neg: neg, test: test };
  }

  function devTerms() {
    if (devFilter.q === devMatchQ) return devMatchers;
    devMatchQ = devFilter.q;
    devBadRe = false;
    var inc = [];
    var exc = [];
    String(devFilter.q || '').split(',').forEach(function (raw) {
      var term = devCompile(raw);
      if (term) (term.neg ? exc : inc).push(term);
    });
    devMatchers = { inc: inc, exc: exc };
    return devMatchers;
  }

  function devHit(term, entry) {
    var f = devFields(entry);
    return term.test(f.name) || term.test(f.target) || term.test(f.body);
  }

  function devPasses(entry) {
    if (!devFilter.dirs[entry.dir]) return false;
    var t = devTerms();
    // A ! term drops its rows outright — the "… but not that one" half of a filter.
    for (var i = 0; i < t.exc.length; i++) if (devHit(t.exc[i], entry)) return false;
    // With no plain terms there is nothing left to say yes to, so everything the ! terms
    // left behind stays. One box, one meaning — there is no mode to get wrong.
    if (!t.inc.length) return true;
    return t.inc.some(function (term) { return devHit(term, entry); });
  }

  /**
   * THE place a host event leaves this page. Everything routes through here — buttons,
   * event-handler actions, the value store's sinks — so dev mode sees every fire, which
   * embed it went to, and what came back.
   */
  function triggerOn(embed, hostEvent, name, payload) {
    // Logging lives in the patched prototype trigger(), which sees the SDK's internal
    // fires too — doing it here as well would print everything of ours twice.
    return embed.trigger(hostEvent, payload);
  }

  /** Which embed an iframe belongs to, matched by the window that sent the message. */
  function sourceLabel(source) {
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var win;
      try { win = f.contentWindow; } catch (e) { win = null; }
      if (win !== source) continue;
      var keys = Object.keys(slots);
      for (var k = 0; k < keys.length; k++) {
        var s = slots[keys[k]];
        if (s && s.host && s.host.contains(f)) return (s.spec && s.spec.name) || keys[k];
      }
      // A pre-rendered iframe lives in the SDK's body-level wrapper, not in a host.
      var wrap = f.closest('[id^="tsEmbed-pre-render-wrapper"]');
      return wrap ? wrap.id.replace('tsEmbed-pre-render-wrapper-', 'prerender:') : 'iframe';
    }
    return null;
  }

  /*
   * The wire itself. The SDK talks to the iframe over postMessage, and plenty of that
   * traffic never surfaces as an EmbedEvent — so a capture-phase listener on our own
   * window sees every message the iframe sends us, whatever the SDK does with it.
   *
   * Only this direction is interceptable. Host -> iframe goes through
   * iframe.contentWindow.postMessage on a CROSS-ORIGIN window, which cannot be patched:
   * the only hook is the contentWindow getter, and returning a wrapper there breaks the
   * `event.source === iframe.contentWindow` identity the SDK routes incoming events by,
   * which would kill the embed. Our own host events are logged at triggerOn instead.
   */
  // An embed event the host ANSWERS (EmbedIframeCenter, EmbedHeight,
  // RequestVisibleEmbedCoordinates…) is replied to through a responder the SDK builds
  // from the incoming message's port — not through trigger(). Remember which event a
  // port belongs to, so a send on it can be named.
  var portEvents = typeof WeakMap === 'function' ? new WeakMap() : null;

  window.addEventListener('message', function (ev) {
    if (!devOn) return;
    var d = ev.data;
    var name = (d && typeof d === 'object' && (d.type || d.eventName)) || '(message)';
    var from = sourceLabel(ev.source);
    // Recorded before the source check: a reply is worth naming even when the sender
    // is a window we cannot label.
    if (portEvents && ev.ports && ev.ports.length && ev.ports[0]) {
      portEvents.set(ev.ports[0], { name: String(name), target: from || 'iframe' });
    }
    if (!from) return;
    devPush('wire', String(name), from, d);
  }, true);

  /*
   * Every responder reply, whoever sends it — ours, or the SDK's own internal handler.
   * MessagePort is OUR realm's class even when the port arrived from the iframe, so
   * patching its prototype is safe, unlike the cross-origin contentWindow.
   */
  (function patchPortReplies() {
    if (typeof MessagePort !== 'function' || !MessagePort.prototype || MessagePort.prototype.__sbDevPort) return;
    MessagePort.prototype.__sbDevPort = true;
    var orig = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (data) {
      if (devOn) {
        var known = portEvents && portEvents.get(this);
        var name = (known && known.name)
          || (data && typeof data === 'object' && (data.type || data.eventName))
          || '(responder)';
        devPush('reply', String(name), (known && known.target) || 'iframe', data);
      }
      return orig.apply(this, arguments);
    };
  })();

  /** Wire value -> the HostEvent member name you would write in code. */
  function hostEventMemberName(wire) {
    var events = (sdk && sdk.HostEvent) || {};
    var keys = Object.keys(events);
    for (var i = 0; i < keys.length; i++) if (events[keys[i]] === wire) return keys[i];
    return String(wire);
  }

  /*
   * Every host event, including the SDK's OWN. The embed classes all inherit one
   * trigger(), and the SDK calls it internally a dozen times — UpdateEmbedParams on a
   * pre-render reveal, Navigate, DestroyEmbed, VisibleEmbedCoordinates — none of which
   * pass through our code. Patching the prototype that owns it catches the lot, and is
   * far simpler than trying to intercept postMessage on a cross-origin window.
   */
  /**
   * The SDK's own Reload blanks the frame with `iframe.src = ''` and puts the URL back
   * 100 ms later. Neither half is safe: `''` resolves against the document base URL, so
   * it navigates the frame to THIS page — and while the attribute is empty, reading
   * `iframe.src` hands back that same page URL. A second reload inside the window
   * therefore captures the sandbox page as the URL to restore and pins it there, so the
   * demo ends up loading itself inside its own embed. `window`'s `online` event fires in
   * bursts on a VPN or Wi-Fi transition and every one of them triggers a reload, which is
   * how a visitor hits this without touching anything.
   *
   * Ours blanks with about:blank and ignores a reload while one is in flight. Fixed in
   * the SDK too (processTrigger.reload), kept here because the site loads the SDK from
   * the CDN and gets whatever version is published.
   */
  var RELOAD_BLANK = 'about:blank';
  var RELOAD_BLANK_MS = 100;
  var reloading = typeof WeakSet === 'function' ? new WeakSet() : null;

  function safeReload(frame) {
    if (!frame || typeof frame.getAttribute !== 'function' || !reloading) return false;
    if (reloading.has(frame)) return true;
    var src = frame.getAttribute('src');
    // Nothing has been loaded into this frame, so there is nothing to reload.
    if (!src || src === RELOAD_BLANK) return true;
    reloading.add(frame);
    frame.src = RELOAD_BLANK;
    setTimeout(function () {
      reloading.delete(frame);
      frame.src = src;
    }, RELOAD_BLANK_MS);
    return true;
  }

  /*
   * More than one class in the chain owns its own trigger(), and each one delegates up to
   * the next: a LiveboardEmbed's call lands on V1Embed's trigger, which calls TsEmbed's.
   * Both have to be patched — SpotterEmbed and friends inherit only the second — so
   * without this guard every host event was logged once per level, which is why they all
   * appeared twice. Only the outermost call logs.
   */
  var devInTrigger = 0;

  function patchHostTriggers(lib) {
    var reloadWire = (lib.HostEvent && lib.HostEvent.Reload) || 'reload';
    ['LiveboardEmbed', 'SearchEmbed', 'SearchBarEmbed', 'AppEmbed', 'SpotterEmbed',
      'SpotterAgentEmbed', 'ConversationEmbed', 'PreRenderedLiveboardEmbed'].forEach(function (name) {
      var Cls = lib[name];
      if (!Cls || !Cls.prototype) return;
      var proto = Cls.prototype;
      while (proto && !Object.prototype.hasOwnProperty.call(proto, 'trigger')) {
        proto = Object.getPrototypeOf(proto);
      }
      if (!proto || proto.__sbDevTrigger) return;
      proto.__sbDevTrigger = true;
      var orig = proto.trigger;
      proto.trigger = function (event, payload) {
        if (devInTrigger) return orig.apply(this, arguments);
        var label = embedLabel(this);
        var evName = hostEventMemberName(event);
        devPush('host', evName, label, payload);
        if (event === reloadWire && safeReload(this.iFrame)) {
          devPush('reply', evName, label, null);
          return Promise.resolve(null);
        }
        var out;
        devInTrigger++;
        try {
          out = orig.apply(this, arguments);
        } catch (err) {
          devPush('reply', evName, label, { error: String((err && err.message) || err) });
          throw err;
        } finally {
          devInTrigger--;
        }
        if (out && typeof out.then === 'function') {
          out.then(
            function (value) { devPush('reply', evName, label, value); },
            function (err) { devPush('reply', evName, label, { error: String((err && err.message) || err) }); },
          );
        } else {
          devPush('reply', evName, label, out);
        }
        return out;
      };
    });
  }

  var devWired = typeof WeakSet === 'function' ? new WeakSet() : null;

  /**
   * One ALL listener per embed: it carries { type, data }, so names are real. Attached
   * once and left in place — devPush is what goes quiet when dev mode is off, so
   * toggling it back on never stacks a second listener.
   */
  function wireDevEvents(embed) {
    if (!devOn || !embed || !sdk || !sdk.EmbedEvent || !sdk.EmbedEvent.ALL) return;
    if (devWired) {
      if (devWired.has(embed)) return;
      devWired.add(embed);
    }
    try {
      embed.on(sdk.EmbedEvent.ALL, function (payload) {
        var wire = payload && payload.type;
        devPush('embed', wire ? eventMemberName(wire) : '(event)', embedLabel(embed), payload);
      });
    } catch (err) {
      console.warn('[' + NS + '] dev mode could not subscribe to EmbedEvent.ALL', err);
    }
  }

  function trigger(name, payload, targets, scope, storeKey) {
    var embeds = embedsFor(targets, scope);
    if (!embeds.length || !sdk) return false;
    var events = sdk.HostEvent || {};
    // Never forward an unmapped name: older SDKs would receive a string they do
    // not implement and fail silently, which looks like a broken button.
    if (!events[name]) {
      console.warn(
        '[sandbox] SDK ' + (M.project.sdkVersion || 'latest') + ' has no HostEvent named "' +
          name + '" — nothing sent.',
      );
      return false;
    }
    /*
     * A payload reads the value store the way an embed config does — values:
     * ["{{filterValue}}"] — resolved here, the one chokepoint every caller goes
     * through, rather than in each of buttons, event actions and the legacy forms.
     * A token with no value is refused instead of sent as "": a filter on an empty
     * string is a different request, and it would look like the embed ignored it.
     */
    var missing = [];
    var body = resolveTokens(payload, missing);
    if (missing.length) {
      var unset = missing.map(function (p) { return '{{' + p + '}}'; }).join(', ');
      console.warn('[sandbox] host event ' + name + ' not sent — no value for ' + unset);
      devPush('host', name + ' skipped', Array.isArray(targets) ? targets.join(', ') : targets, {
        missing: missing,
        payload: payload,
      });
      return false;
    }
    var sent = false;
    embeds.forEach(function (embed) {
      try {
        var out = triggerOn(embed, events[name], name, body);
        sent = true;
        // Some host events answer — GetFilters, GetParameters, GetTML. Keeping that
        // answer is the only way a page can show what the embed actually thinks.
        if (storeKey && out && typeof out.then === 'function') {
          out.then(
            function (value) { store.set(storeKey, value === undefined ? null : value); },
            function (err) { store.set(storeKey, { error: String((err && err.message) || err) }); },
          );
        } else if (storeKey) {
          store.set(storeKey, out === undefined ? null : out);
        }
      } catch (err) {
        console.warn('[sandbox] host event ' + name + ' failed', err);
        if (storeKey) store.set(storeKey, { error: String((err && err.message) || err) });
      }
    });
    return sent;
  }

  function buttonTargets(item) {
    return item.targets !== undefined ? item.targets : item.embedIndex;
  }

  function markUnsupported(btn, sent) {
    if (sent) return;
    btn.disabled = true;
    btn.title = 'Not available on SDK ' + (M.project.sdkVersion || 'latest') + ' — see the console.';
  }

  /**
   * Buttons and embed events share one action vocabulary. A "set" here writes the
   * literal it was given — there is no event payload to read a path out of.
   */
  function runButtonActions(item, btn, scope) {
    var actions = item.actions;
    if (!actions || !actions.length) return runLegacyButtonAction(item, btn, scope);
    actions.forEach(function (a) {
      var p = a.params || {};
      switch (a.type) {
        case 'nav': go(p.to); break;
        case 'open-url': window.open(p.url, p.target || '_blank', 'noopener,noreferrer'); break;
        case 'set': store.set(p.key, p.value); break;
        case 'open-modal': openModal(p.name); break;
        case 'close-modal': closeModal(); break;
        case 'HostEvent':
        case 'host-event':
          markUnsupported(btn, trigger(
            p.type || p.hostEvent,
            p.payload !== undefined ? p.payload : p.data,
            p.targets,
            scope,
            p.store,
          ));
          break;
        case 'remount':
          if (reapplyAllowed(p, 'remount')) remountEmbeds(p.targets, scope);
          break;
        case 'update-embed':
          if (reapplyAllowed(p, 'update-embed')) updateEmbedParams(p.targets, scope);
          break;
        case 'run-code':
          runCode(p, { button: item.label || null }, 'button ' + (item.label || ''))
            .then(
              function (v) { if (p.store) store.set(p.store, v); },
              function (err) { console.error('[' + NS + '] button code failed', err); },
            );
          break;
        default:
          console.warn('[' + NS + '] unknown button action "' + a.type + '"');
          btn.disabled = true;
      }
    });
  }

  function runLegacyButtonAction(item, btn, scope) {
    switch (item.action) {
      case 'open-modal':
        openModal(item.modal);
        return;
      case 'close-modal':
        closeModal();
        return;
      case 'nav':
        return go(item.to);
      case 'open-url':
        window.open(item.url, item.target || '_blank', 'noopener,noreferrer');
        return;
      case 'reload':
        return markUnsupported(btn, trigger('Reload', undefined, buttonTargets(item), scope));
      case 'edit':
        return markUnsupported(btn, trigger('Edit', undefined, buttonTargets(item), scope));
      case 'save':
        return markUnsupported(btn, trigger('Save', undefined, buttonTargets(item), scope));
      case 'download-pdf':
        return markUnsupported(btn, trigger('DownloadAsPdf', undefined, buttonTargets(item), scope));
      case 'set-filter':
        return markUnsupported(
          btn,
          trigger(
            'UpdateFilters',
            { filters: [{ columnName: item.column, operator: 'IN', values: item.values }] },
            buttonTargets(item),
            scope,
          ),
        );
      case 'set-value':
        store.set(item.key, item.value);
        return;
      case 'host-event':
        return markUnsupported(btn, trigger(item.hostEvent, item.payload, buttonTargets(item), scope));
      default:
        btn.disabled = true;
    }
  }

  // -------------------------------------------------------------------- render

  function render() {
    var path = currentPath();
    if (active && active !== path) {
      closeModal();
      releaseEmbed(active);
    }
    active = path;

    var page = pages[path];
    var projectCfg = M.project;

    textBindings = [];
    valueBindings = [];

    renderHeader(mergeChrome(projectCfg.header, page && page.header), path);
    renderFooter(mergeChrome(projectCfg.footer, page && page.footer), path);

    if (!page) {
      applyPageCss('');
      clear(contentEl);
      contentEl.appendChild(
        note('Page not found', 'No page is configured at ' + path + ' for this project.'),
      );
      document.title = 'Not found';
      return;
    }

    document.title = page.title || (projectCfg.header && projectCfg.header.title) || projectCfg.name || 'Embed sandbox';
    applyPageCss(page.css || '');

    // beforeLoad runs before any block of this page renders, with { path, variables }.
    // A navigation while it runs wins: the stale render is dropped, not painted late.
    var hooks = page.beforeLoad;
    if (hooks && hooks.length) {
      clear(contentEl);
      contentEl.appendChild(note('Loading', 'Running before-load code…'));
      var seq = ++renderSeq;
      runHookActions(hooks, { path: path }, 'beforeLoad').then(function () {
        if (seq !== renderSeq || active !== path) return;
        renderPageBody(page, path);
      });
      return;
    }
    renderPageBody(page, path);
  }

  var renderSeq = 0;

  function renderPageBody(page, path) {
    var specs = embedSpecsOf(page);
    var anyFullHeight = specs.some(function (s) { return !!(s.spec.config || {}).fullHeight; });
    document.body.setAttribute('data-fullheight', anyFullHeight ? '1' : '0');

    var mounts = renderBlocks(page);
    refreshBindings();
    if (!mounts.length) return;

    // Anything init() still lacks is asked for in ONE place — mountEmbed's gate, which
    // offers the settings panel. A separate no-host note here would pre-empt it and
    // leave the visitor with nothing to click.
    if (initNeeds().length) {
      mounts.forEach(function (m) { mountEmbed(path, m.spec, m.wrapper, m.idx); });
      return;
    }

    ensureSdk().then(
      function () {
        mounts.forEach(function (m) {
          mountEmbed(path, m.spec, m.wrapper, m.idx);
        });
      },
      function (err) {
        mounts.forEach(function (m) {
          clear(m.wrapper);
          m.wrapper.appendChild(note(sdkErrorTitle(err), err.message));
        });
      },
    );
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error('Could not load ' + src));
      };
      document.head.appendChild(s);
    });
  }

  /**
   * A visitor's own connection details, kept in THEIR browser only — never sent to us
   * and never part of the shared document. Merged over the project so everything
   * downstream (ensureSdk, the manifest's sdkUrl, generated code) sees one config.
   */
  function readInitOverride() {
    try { return JSON.parse(localStorage.getItem(INIT_LS) || 'null') || null; } catch (e) { return null; }
  }
  function writeInitOverride(patch) {
    try {
      if (patch) localStorage.setItem(INIT_LS, JSON.stringify(patch));
      else localStorage.removeItem(INIT_LS);
    } catch (e) { /* private mode */ }
  }
  function applyInitOverride() {
    var o = readInitOverride();
    if (!o) return;
    if (o.thoughtSpotHost) M.project.thoughtSpotHost = o.thoughtSpotHost;
    if (o.authType) M.project.authType = o.authType;
    if (o.auth) M.project.auth = o.auth;
    if (o.sdkVersion) {
      M.project.sdkVersion = o.sdkVersion;
      M.sdkUrl = sdkUrlFor(o.sdkVersion);
    }
  }

  /** Mirrors the worker's sdkUrl(): a pr: ref is a tarball, so it goes via our proxy. */
  function sdkUrlFor(version) {
    var v = String(version || '').trim();
    var pr = /^pr:([A-Za-z0-9._-]{1,64})$/.exec(v);
    if (pr) return '/sdk/pr/' + pr[1] + '/tsembed.js';
    return 'https://cdn.jsdelivr.net/npm/@thoughtspot/visual-embed-sdk@' + (v || 'latest') + '/dist/tsembed.js';
  }

  /**
   * What a version range actually resolves to. The bundle keeps its own version private,
   * so the CDN is the only one who can say what "latest" means today.
   */
  function resolveSdkVersion(version) {
    var v = String(version || 'latest').trim();
    if (/^pr:/.test(v) || /^\d+\.\d+\.\d+(-|$)/.test(v)) return Promise.resolve(null);
    return fetch('https://data.jsdelivr.com/v1/packages/npm/@thoughtspot/visual-embed-sdk/resolved?specifier='
      + encodeURIComponent(v))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (b) { return (b && b.version) || null; })
      .catch(function () { return null; });
  }

  var siteSdkVersion = (M.project && M.project.sdkVersion) || 'latest';
  /** The site's own connection, before applyInitOverride() rewrites M.project. */
  var siteConn = {};
  function captureSiteConn() {
    var p = M.project || {};
    siteConn = { thoughtSpotHost: p.thoughtSpotHost, authType: p.authType, auth: p.auth };
  }
  captureSiteConn();

  var TOKEN_AUTH_TYPES = ['TrustedAuthToken', 'TrustedAuthTokenCookieless'];

  /** What init() still lacks. Empty means the page can load embeds on its own. */
  function initNeeds() {
    var p = M.project || {};
    var missing = [];
    if (!p.thoughtSpotHost) missing.push('a ThoughtSpot host');
    if (TOKEN_AUTH_TYPES.indexOf(p.authType || 'None') !== -1) {
      var a = p.auth || {};
      var ok = (a.tokenSource === 'credentials' && a.username && a.secret) ||
        a.tokenSource === 'endpoint' || a.tokenSource === 'proxy';
      if (!ok) missing.push('a way to get a token for ' + p.authType);
    }
    return missing;
  }

  function ensureSdk() {
    if (sdkReady) return sdkReady;
    sdkReady = loadScript(M.sdkUrl).then(function () {
      var lib = window.tsembed;
      if (!lib || !lib.init) {
        throw new Error('The bundle at ' + M.sdkUrl + ' did not expose the tsembed global.');
      }
      sdk = lib;
      patchHostTriggers(lib);

      var wanted = M.project.authType || 'None';
      var TOKEN_AUTH = ['TrustedAuthToken', 'TrustedAuthTokenCookieless'];
      var authType = lib.AuthType && lib.AuthType[wanted];
      if (!authType) {
        console.warn(
          '[' + NS + '] SDK ' + (M.project.sdkVersion || 'latest') +
            ' has no AuthType named "' + wanted + '" — falling back to None.',
        );
        authType = (lib.AuthType && lib.AuthType.None) || 'None';
      }

      var cfg = { thoughtSpotHost: M.project.thoughtSpotHost, authType: authType };

      // getAuthToken is a function, which config cannot hold — so the runtime builds
      // it from the declarative `auth` block rather than executing user code.
      var auth = M.project.auth;
      if (auth && auth.tokenSource === 'credentials') {
        // The PAGE mints, straight from the cluster — the same call the builder makes
        // from your tab. The credential is in this page's config and therefore visible
        // to anyone who can open it; that is the trade this source exists to make.
        console.warn(
          '[' + NS + '] auth.tokenSource is "credentials": ' + auth.username +
            "'s secret is in this page and readable by anyone with the link. Demo only.",
        );
        cfg.getAuthToken = function () {
          var body = { username: auth.username, validity_time_in_sec: auth.validitySeconds || 300 };
          body[auth.secretType || 'password'] = auth.secret;
          if (auth.objectId) body.object_id = auth.objectId;
          if (auth.orgId !== undefined) body.org_id = auth.orgId;
          var base = String(M.project.thoughtSpotHost || '').replace(/\/+$/, '');
          var path = auth.objectId ? '/api/rest/2.0/auth/token/object' : '/api/rest/2.0/auth/token/full';
          return fetch(base + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
            .then(function (res) {
              return res.json().catch(function () { return {}; }).then(function (json) {
                if (!res.ok || !json.token) {
                  var nice = tokenApiMessage(json);
                  throw new Error(
                    'the cluster refused to mint a token (' + res.status + ')' +
                      (res.status === 401 || res.status === 403 ? ' — check the username and secret' : '') +
                      (nice ? ': ' + nice : ''),
                  );
                }
                return json.token;
              });
            })
            .catch(function (err) {
              console.error('[' + NS + '] getAuthToken failed', err);
              store.set('authError', String((err && err.message) || err));
              throw err;
            });
        };
      } else if (auth && auth.tokenSource === 'proxy') {
        // This site's token proxy mints server-side from the stored connection, so
        // the page never carries a credential.
        cfg.getAuthToken = function () {
          return fetch('/api/projects/' + M.projectId + '/token', {
            headers: { accept: 'application/json' },
          })
            .then(function (res) {
              return res.json().catch(function () { return {}; }).then(function (json) {
                if (!res.ok || !json.token) {
                  throw new Error(json.error || ('the token proxy returned ' + res.status));
                }
                return json.token;
              });
            })
            .catch(function (err) {
              console.error('[' + NS + '] getAuthToken failed', err);
              store.set('authError', String((err && err.message) || err));
              throw err;
            });
        };
      } else if (auth && auth.tokenSource === 'endpoint') {
        cfg.getAuthToken = function () {
          return fetch(auth.tokenEndpoint, {
            method: auth.tokenMethod || 'GET',
            // The customer's endpoint decides its own auth; never send ours.
            credentials: 'omit',
            headers: { accept: auth.tokenField ? 'application/json' : 'text/plain, */*' },
          })
            .then(function (res) {
              if (!res.ok) {
                throw new Error('token endpoint ' + auth.tokenEndpoint + ' returned ' + res.status);
              }
              if (!auth.tokenField) {
                return res.text().then(function (t) { return String(t).trim(); });
              }
              return res.json().then(function (body) {
                var cur = body;
                String(auth.tokenField).split('.').forEach(function (k) {
                  cur = cur === null || cur === undefined ? cur : cur[k];
                });
                if (typeof cur !== 'string' || !cur) {
                  throw new Error('no token at "' + auth.tokenField + '" in the endpoint response');
                }
                return cur;
              });
            })
            .catch(function (err) {
              // Surfaced rather than swallowed: a silent token failure looks like a
              // blank embed, which is the hardest kind of problem to diagnose.
              console.error('[' + NS + '] getAuthToken failed', err);
              store.set('authError', String((err && err.message) || err));
              throw err;
            });
        };
      }

      initConfigUsed = cfg;
      // init() returns an event emitter. The embed classes already wait for auth
      // internally (the SDK says so: "you need not wait for AuthStatus.SUCCESS"), so
      // this is NOT gating the mount — it is the only place a FAILURE is visible at
      // all. Without it a failed login is a blank iframe and no message anywhere.
      // The SDK refuses a token auth type with no getAuthToken, and its message
      // ("Either auth endpoint or getAuthToken function must be provided") does not say
      // which end is missing. Name it here, where the config is in hand.
      if (TOKEN_AUTH.indexOf(wanted) !== -1 && typeof cfg.getAuthToken !== 'function') {
        var why = 'authType "' + wanted + '" needs a token, but this project has no auth ' +
          'block. Set auth.tokenSource to "credentials" (this page mints from the cluster ' +
          'itself — the secret is then public) or "endpoint" with auth.tokenEndpoint, or ' +
          'use an authType that needs no token from us (None, EmbeddedSSO, SAMLRedirect, ' +
          'OIDCRedirect).';
        console.error('[' + NS + '] ' + why);
        store.set('authError', why);
        var configErr = new Error(why);
        configErr.configError = true;
        throw configErr;
      }
      var authEE = lib.init(cfg);
      if (authEE && typeof authEE.on === 'function') {
        var S = lib.AuthStatus || {};
        if (S.FAILURE) {
          authEE.on(S.FAILURE, function (reason) {
            var why = typeof reason === 'string' ? reason : (reason && reason.type) || 'unknown';
            console.error('[' + NS + '] authentication failed: ' + why);
            store.set('authError', 'authentication failed: ' + why);
          });
        }
        if (S.SUCCESS) {
          authEE.on(S.SUCCESS, function (sessionInfo) {
            store.set('authUser', (sessionInfo && sessionInfo.userGUID) || true);
          });
        }
      }
      return lib;
    });
    return sdkReady;
  }

  // A preRender:true block is pre-rendered when ITS OWN page renders — the same thing
  // the generated code does, and nothing more. We deliberately do NOT eagerly warm other
  // pages' pre-render blocks: two instances trying to own one preRenderId is what spawns
  // duplicate #tsEmbed-pre-render-wrapper-<id> nodes. Landing on a page that declares the
  // PreRendered component warms it; a page that shares the id shows it with
  // showPreRender(), which the SDK connects to the one existing wrapper.

  console.info(
    '[' + NS + '] ready — ' + NS + ".set('k', v) / " + NS + ".get('k') / " + NS + '.all() · ' +
      NS + '.init() resolves the one-per-project SDK init · ' + NS + '.config, ' + NS + '.embeds()',
  );

  // A visitor's own host/auth and saved variables are part of the config the first
  // render reads, so both land before it runs.
  applyInitOverride();
  hydrateVars();

  render();

  // ------------------------------------------------------------ live updates
  /*
   * A published page is not an editor, but the document behind it can change at any
   * moment — an agent over MCP, someone in the builder, another tab. So the page
   * watches its own version and re-renders in place rather than going stale until
   * someone presses reload.
   *
   * Only /version repeats (one number); the full manifest is fetched only when that
   * number moves. Polling pauses while the tab is hidden and catches up on focus,
   * so a background tab costs nothing.
   */
  var LIVE_POLL_MS = 4000;
  var liveVersion = M.updatedAt || 0;
  var liveTimer = null;
  var liveBusy = false;

  function specOf(path, idx) {
    var page = pages[path];
    if (!page) return null;
    var found = null;
    var i = 0;
    (function walk(blocks) {
      (blocks || []).forEach(function (b) {
        if (b.type === 'row') {
          (b.columns || []).forEach(function (c) { walk(c.blocks); });
          return;
        }
        if (b.type !== 'embed') return;
        if (i === idx) found = b.embed;
        i++;
      });
    })(page.blocks);
    return found;
  }

  /** Keep an iframe only when its config is byte-identical; anything else remounts. */
  function releaseChangedEmbeds(nextPages) {
    var before = {};
    Object.keys(slots).forEach(function (key) {
      before[key] = JSON.stringify(slots[key].spec || null);
    });
    var prevPages = pages;
    pages = nextPages;
    Object.keys(slots).forEach(function (key) {
      var parts = key.split('#');
      var next = JSON.stringify(specOf(parts[0], Number(parts[1])) || null);
      if (next !== before[key]) releaseSlot(key);
    });
    return prevPages;
  }

  function applyManifest(next) {
    var byPath = {};
    (next.pages || []).forEach(function (p) { byPath[p.path] = p; });
    M.project = next.project;
    captureSiteConn();
    M.sdkUrl = next.sdkUrl;
    // A live update replaces the project wholesale, which would drop this visitor's own
    // host/auth and any newly declared variable defaults.
    declaredVars = M.project.variables || {};
    M.varsUsed = next.varsUsed || M.varsUsed;
    applyInitOverride();
    hydrateVars();
    releaseChangedEmbeds(byPath);
    liveVersion = next.updatedAt || liveVersion;
    render();
  }

  function checkVersion() {
    if (liveBusy || document.hidden) return;
    liveBusy = true;
    fetch('/api/projects/' + M.projectId + '/version', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) {
        if (!body || !body.updatedAt || body.updatedAt === liveVersion) return null;
        return fetch('/api/projects/' + M.projectId + '/manifest', { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (next) {
            if (!next) return;
            applyManifest(next);
            console.info('[' + NS + '] updated to version ' + next.updatedAt);
          });
      })
      .catch(function () { /* offline or mid-deploy: try again on the next tick */ })
      .then(function () { liveBusy = false; });
  }

  if (M.project.live !== false) {
    liveTimer = setInterval(checkVersion, LIVE_POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkVersion();
    });
    window.addEventListener('focus', checkVersion);
  }

  // ------------------------------------------------------------- code viewer
  // Every published page can show the SDK code that would power it — the same
  // generator the builder uses — plus a fork link, so a viewer can take a demo
  // and make it theirs. config.showCode: false removes all of it.

  /*
   * The builder saves the edit token under sb.tok.<id> when the author ticks remember,
   * and it is served from this same origin, so a viewer who holds it IS the author of
   * this project. They get "Edit this" straight into the builder — forking a demo you
   * can already edit is the long way round — and Fork & edit stays for everyone else.
   * Presence is enough here: the builder verifies the token and drops a stale one.
   */
  var TOK_LS = 'sb.tok.' + M.projectId;

  function hasEditToken() {
    try { return Boolean(localStorage.getItem(TOK_LS)); } catch (e) { return false; }
  }

  // Prism does the colouring — loaded from jsDelivr only when the overlay first
  // opens, so a page that never shows its code never pays for it.
  var PRISM_BASE = 'https://cdn.jsdelivr.net/npm/prismjs@1.29.0';
  var prismReady = null;

  function ensurePrism() {
    if (prismReady) return prismReady;
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = PRISM_BASE + '/themes/prism-tomorrow.min.css';
    document.head.appendChild(css);
    var parts = ['/components/prism-core.min.js', '/components/prism-markup.min.js',
      '/components/prism-clike.min.js', '/components/prism-javascript.min.js',
      '/components/prism-jsx.min.js'];
    prismReady = parts.reduce(function (chain, part) {
      return chain.then(function () {
        return new Promise(function (resolve, reject) {
          var s = document.createElement('script');
          s.src = PRISM_BASE + part;
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
      });
    }, Promise.resolve());
    return prismReady;
  }

  function codeOverlay() {
    /*
     * A page may ship hand-written code for one flavour. Opening on React would show the
     * generated export instead and leave the author's version unfound, so the view opens
     * on whichever flavour is hand-written.
     */
    function authoredFlavor(path) {
      var page = pages[path];
      var over = page && page.codeOverride;
      if (!over) return null;
      var order = ['react', 'esm', 'cdn'];
      for (var i = 0; i < order.length; i++) if (over[order[i]]) return order[i];
      return null;
    }

    var flavor = authoredFlavor(currentPath()) || 'react';
    // The JS flavour has two halves: the code, and the markup it targets.
    var part = 'js';
    var root = el('div', 'sb-code-overlay');
    root.hidden = true;
    var head = el('div', 'sb-code-head');
    var seg = el('div', 'sb-code-seg');
    var btnReact = el('button', null, 'React');
    var btnJs = el('button', null, 'JavaScript');
    seg.appendChild(btnReact); seg.appendChild(btnJs);
    var partSeg = el('div', 'sb-code-seg');
    partSeg.hidden = true;
    var btnJsCode = el('button', null, 'JS');
    var btnHtml = el('button', null, 'HTML');
    partSeg.appendChild(btnJsCode); partSeg.appendChild(btnHtml);
    var pathEl = el('span', 'sb-code-path');
    var copyBtn = el('button', null, 'Copy');
    var forkA = el('a', 'sb-code-fork', 'Fork & edit');
    forkA.href = '/fork/' + M.projectId;
    forkA.target = '_blank';
    forkA.rel = 'noopener';
    var editA = null;
    if (hasEditToken()) {
      editA = el('a', 'sb-code-fork sb-code-edit', 'Edit this');
      editA.href = '/build/' + M.projectId;
      editA.target = '_blank';
      editA.rel = 'noopener';
    }
    var closeBtn = el('button', null, 'Close');
    head.appendChild(seg); head.appendChild(partSeg); head.appendChild(pathEl);
    var spacer = el('span'); spacer.style.flex = '1'; head.appendChild(spacer);
    head.appendChild(copyBtn);
    if (editA) head.appendChild(editA);
    head.appendChild(forkA); head.appendChild(closeBtn);
    var pre = el('pre', 'sb-code-pre');
    var noteEl = el('p', 'sb-code-note');
    noteEl.hidden = true;
    root.appendChild(head); root.appendChild(noteEl); root.appendChild(pre);
    document.body.appendChild(root);

    var raw = '';
    var shownPath = null;
    function load() {
      btnReact.className = flavor === 'react' ? 'on' : '';
      btnJs.className = flavor === 'esm' ? 'on' : '';
      partSeg.hidden = flavor !== 'esm';
      btnJsCode.className = part === 'js' ? 'on' : '';
      btnHtml.className = part === 'html' ? 'on' : '';
      var htmlPart = flavor === 'esm' && part === 'html';
      var path = currentPath();
      // Opened on another page since last time: honour that page's authored flavour.
      if (path !== shownPath) {
        shownPath = path;
        var authored = authoredFlavor(path);
        if (authored && authored !== flavor) { flavor = authored; part = 'js'; htmlPart = false; }
      }
      pathEl.textContent = path;
      // A dot marks a flavour the author wrote themselves, so the other one is findable.
      var over = (pages[path] && pages[path].codeOverride) || {};
      btnReact.textContent = 'React' + (over.react ? ' \u2022' : '');
      btnJs.textContent = 'JavaScript' + (over.esm ? ' \u2022' : '');
      pre.textContent = 'generating…';
      fetch('/api/projects/' + M.projectId + '/code?path=' + encodeURIComponent(path) +
          '&flavor=' + flavor + (htmlPart ? '&part=html' : ''))
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('could not generate')); })
        .then(function (body) {
          raw = body.code || '';
          pre.textContent = raw;
          // A page may ship hand-written code for the view; say so rather than let it
          // pass for the faithful export.
          if (noteEl) {
            var note = body.note || (body.overridden ? 'Hand-written for this demo, not the generated export.' : '');
            noteEl.textContent = note;
            noteEl.hidden = !note;
          }
          // Colour is an upgrade, never a requirement: if the CDN is unreachable the
          // plain text stands.
          ensurePrism().then(function () {
            var lang = htmlPart ? 'markup' : 'jsx';
            pre.innerHTML = window.Prism.highlight(raw, window.Prism.languages[lang], lang);
          }, function () { /* offline: plain text already shown */ });
        })
        .catch(function (err) { pre.textContent = String(err.message || err); });
    }
    btnReact.onclick = function () { flavor = 'react'; part = 'js'; load(); };
    btnJs.onclick = function () { flavor = 'esm'; load(); };
    btnJsCode.onclick = function () { part = 'js'; load(); };
    btnHtml.onclick = function () { part = 'html'; load(); };
    copyBtn.onclick = function () {
      navigator.clipboard.writeText(raw).then(function () {
        copyBtn.textContent = 'Copied';
        setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1400);
      });
    };
    closeBtn.onclick = function () { root.hidden = true; };
    return { root: root, load: load };
  }

  // ---------------------------------------------------------------- dev panel

  /**
   * The legend. Every symbol in this panel is explained here and nowhere else, because
   * "embed / host / reply / wire" and a bare row of arrows mean nothing on sight.
   */
  function devHelp() {
    var box = el('div', 'sb-dev-help');
    function section(title) { box.appendChild(el('p', 'sb-dev-help-h', title)); }
    function line(sym, name, text) {
      var r = el('div', 'sb-dev-help-row');
      r.appendChild(el('span', 'sb-dev-help-s', sym));
      r.appendChild(el('span', 'sb-dev-help-n', name));
      r.appendChild(el('span', 'sb-dev-help-d', text));
      box.appendChild(r);
    }
    section('Which way the event went \u2014 the checkboxes, and the badge on every row');
    DEV_DIRS.forEach(function (d) {
      line(DEV_BADGE[d], d, DEV_WHAT[d] + (DEV_DIRS_ON[d] ? '' : ' Off by default.'));
    });
    line('', 'unticking one', 'Stops RECORDING it, so all ' + DEV_CAP + ' slots go to what you are ' +
      'watching. Ticking it back on records from that moment \u2014 it cannot recover what already fired.');
    line('\u21c4', 'on a \u2193 row', 'That embed event was seen on the wire too. One event, one row \u2014 ' +
      'which is why it no longer appears twice.');
    line('\u00d73', 'a repeat', 'The same event with the same payload, fired that many times in a row.');
    line('', 'moving around', 'The log keeps going as you move between the pages of this site. ' +
      'A reload starts it fresh, and so does Clear.');
    line('', 'an amber row', 'It just arrived. The flash starts fading the moment it appears and is ' +
      'gone in under two seconds, so a burst reads as a band \u2014 newest strongest, oldest nearly clear.');
    section('A row');
    line('', 'columns', 'time \u00b7 badge \u00b7 event name \u00b7 which embed \u00b7 payload preview');
    line('', 'click', 'Opens the full payload underneath it. Click again to close.');
    line('', 'right-click', 'Filters straight off that row \u2014 only it, also it, hide it, only its direction.');
    section('The filter box \u2014 comma-separated, and where the * is says what it means');
    line('', 'Update', 'plain text: matches anywhere \u2014 the name, the embed, or the payload');
    line('', 'Update*', 'starts with Update');
    line('', '*Filters', 'ends with Filters');
    line('', '*Filter*', 'contains Filter \u2014 the same as plain text');
    line('', 'Up*Filters', 'starts with Up and ends with Filters');
    line('!', '!Subscribed', 'a leading ! or - drops those rows. !Sub* drops anything starting with Sub.');
    line('', '/^Update/', 'a regex, for the rare pattern that needs more. Flags optional, i by default.');
    line('', 'Update*, Navigate*, !Subscribed', 'reads as it sounds: those two, but never a Subscribed');
    section('The number in the head');
    line('', 'shown/received', 'rows the text filter lets through, out of everything the ticked ' +
      'directions captured since the page loaded. The log keeps the last ' + DEV_CAP + ' and drops ' +
      'older ones. It turns amber when it is full \u2014 that is the warning that something chatty is ' +
      'pushing your rows out, so untick a direction or Clear.');
    return box;
  }

  function devOverlay() {
    var root = el('div', 'sb-dev');
    var head = el('div', 'sb-dev-head');
    head.appendChild(el('strong', null, 'Dev'));
    var q = el('input', 'sb-dev-q');
    q.placeholder = 'Update*, Navigate*, !Subscribed';
    q.value = devFilter.q || '';
    head.appendChild(q);
    var dirs = el('div', 'sb-dev-dirs');
    var boxes = {};
    DEV_DIRS.forEach(function (dir) {
      var lab = el('label');
      lab.title = DEV_WHAT[dir];
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = devFilter.dirs[dir] !== false;
      lab.appendChild(cb);
      lab.appendChild(el('span', 'sb-dev-db', DEV_BADGE[dir]));
      lab.appendChild(document.createTextNode(dir));
      dirs.appendChild(lab);
      boxes[dir] = cb;
      cb.onchange = function () { devFilter.dirs[dir] = cb.checked; devSaveFilter(); redraw(); };
    });
    head.appendChild(dirs);
    var count = el('span', 'sb-dev-count');
    head.appendChild(count);
    var helpBtn = el('button', 'sb-dev-qm', '?');
    helpBtn.title = 'What the badges, the columns, the count and the filter box mean';
    var clearBtn = el('button', null, 'Clear');
    var closeBtn = el('button', null, 'Close');
    head.appendChild(helpBtn); head.appendChild(clearBtn); head.appendChild(closeBtn);
    var help = devHelp();
    help.hidden = true;
    var list = el('div', 'sb-dev-list');
    root.appendChild(head); root.appendChild(help); root.appendChild(list);
    document.body.appendChild(root);

    // Row elements by entry id, so a merged or counted-up entry can be redrawn in place
    // instead of forcing a full repaint of the log on every event.
    var rows = {};
    var dirty = false;

    function preview(value) {
      if (value === undefined) return '';
      if (value === null) return 'null';
      if (typeof value !== 'object') return String(value);
      try {
        var s = JSON.stringify(value);
        return s.length > 90 ? s.slice(0, 89) + '\u2026' : s;
      } catch (e) { return '[unserialisable]' }
    }

    var menuEl = null;
    function closeMenu() {
      if (!menuEl) return;
      menuEl.remove();
      menuEl = null;
    }
    /** Filter straight off a row: the noisy event you want gone is the one you clicked. */
    function openMenu(x, y, entry) {
      closeMenu();
      menuEl = el('div', 'sb-dev-menu');
      var add = function (label, fn) {
        var btn = el('button', null, label);
        btn.onclick = function () { closeMenu(); fn(); };
        menuEl.appendChild(btn);
      };
      var terms = function () {
        return String(devFilter.q || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
      };
      var setQ = function (next) {
        devFilter.q = next.join(', ');
        q.value = devFilter.q;
        devSaveFilter();
        redraw();
      };
      add('Only ' + entry.name, function () {
        setQ([entry.name]);
      });
      add('Also show ' + entry.name, function () {
        var keep = terms();
        if (keep.indexOf(entry.name) === -1) keep.push(entry.name);
        setQ(keep);
      });
      add('Hide ' + entry.name, function () {
        // Exclusions accumulate and sit alongside whatever is being shown, so silencing
        // three chatty events takes three clicks and keeps what you are watching intact.
        var keep = terms().filter(function (t) { return t !== entry.name; });
        if (keep.indexOf('!' + entry.name) === -1) keep.push('!' + entry.name);
        setQ(keep);
      });
      add('Only ' + entry.dir + ' events', function () {
        Object.keys(devFilter.dirs).forEach(function (d) { devFilter.dirs[d] = d === entry.dir; });
        Object.keys(boxes).forEach(function (d) { boxes[d].checked = devFilter.dirs[d]; });
        devSaveFilter();
        redraw();
      });
      menuEl.appendChild(el('hr'));
      add('Copy payload', function () {
        var text;
        try { text = JSON.stringify(entry.payload, null, 2); } catch (e) { text = String(entry.payload); }
        if (navigator.clipboard) navigator.clipboard.writeText(text);
      });
      add('Log to console', function () {
        console.log('[' + NS + '] ' + entry.dir + ' ' + entry.name, entry.payload);
      });
      menuEl.appendChild(el('hr'));
      add('Clear filter', function () {
        Object.keys(devFilter.dirs).forEach(function (d) { devFilter.dirs[d] = true; });
        Object.keys(boxes).forEach(function (d) { boxes[d].checked = true; });
        setQ([]);
      });
      document.body.appendChild(menuEl);
      // Place it at the pointer, pulled back inside the viewport when near an edge.
      var w = menuEl.offsetWidth;
      var h = menuEl.offsetHeight;
      menuEl.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
      menuEl.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
    }

    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeMenu(); });
    list.addEventListener('scroll', closeMenu);

    function row(entry) {
      var line = el('div', 'sb-dev-row');
      line.setAttribute('data-dir', entry.dir);
      var t = entry.at;
      var hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') +
        ':' + String(t.getSeconds()).padStart(2, '0');
      line.appendChild(el('span', 'sb-dev-t', hh));
      var badge = el('span', 'sb-dev-b', DEV_BADGE[entry.dir] || '\u00b7');
      badge.title = DEV_WHAT[entry.dir] || entry.dir;
      line.appendChild(badge);
      line.appendChild(el('span', 'sb-dev-n', entry.name));
      if (entry.n > 1) {
        var rep = el('span', 'sb-dev-x', '\u00d7' + entry.n);
        rep.title = 'Fired ' + entry.n + ' times in a row with the same payload';
        line.appendChild(rep);
      }
      if (entry.wire) {
        var w = el('span', 'sb-dev-w', '\u21c4');
        w.title = 'Also seen on the wire as a raw postMessage \u2014 the same event, not a second one';
        line.appendChild(w);
      }
      if (entry.target) line.appendChild(el('span', 'sb-dev-tg', entry.target));
      line.appendChild(el('span', 'sb-dev-p', preview(entry.payload)));
      line.oncontextmenu = function (ev) {
        ev.preventDefault();
        openMenu(ev.clientX, ev.clientY, entry);
      };
      line.onclick = function () {
        var open = line.nextSibling && line.nextSibling.className === 'sb-dev-full';
        if (open) { line.nextSibling.remove(); return; }
        var full = el('pre', 'sb-dev-full');
        try { full.textContent = JSON.stringify(entry.payload, null, 2); }
        catch (e) { full.textContent = String(entry.payload); }
        list.insertBefore(full, line.nextSibling);
      };
      rows[entry.id] = line;
      return line;
    }

    function tally() {
      var shown = devEntries.filter(devPasses).length;
      var full = devEntries.length >= DEV_CAP;
      count.textContent = shown + '/' + devEntries.length;
      if (full) count.setAttribute('data-full', ''); else count.removeAttribute('data-full');
      count.title = full
        ? 'Full: ' + DEV_CAP + ' events held and the oldest are being DROPPED to make room, ' +
          'which is why rows you were watching can vanish. Untick a chatty direction, or Clear.'
        : shown + ' shown \u00b7 ' + devEntries.length + ' received \u00b7 the log keeps the last ' +
          DEV_CAP + ' events';
    }

    /** The oldest entries fall off the log, so their rows have to go with them. */
    function trim() {
      var oldest = devEntries.length ? devEntries[0].id : 0;
      Object.keys(rows).forEach(function (id) {
        if (Number(id) >= oldest) return;
        var line = rows[id];
        if (line.nextSibling && line.nextSibling.className === 'sb-dev-full') line.nextSibling.remove();
        line.remove();
        delete rows[id];
      });
    }

    function append(entry) {
      // Nothing is worth rendering into a closed panel; the dot on the button says there
      // is something new, and opening it redraws from devEntries.
      if (root.hidden) { dirty = true; devMarkNew(); return; }
      if (!devPasses(entry)) { tally(); return; }
      var empty = list.querySelector('.sb-dev-empty');
      if (empty) empty.remove();
      var atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
      var line = row(entry);
      line.setAttribute('data-fresh', '');
      list.appendChild(line);
      trim();
      tally();
      if (atBottom) list.scrollTop = list.scrollHeight;
    }

    /** An entry that changed after it was logged — merged with its wire twin, or counted up. */
    function update(entry) {
      if (root.hidden) { dirty = true; devMarkNew(); return; }
      var existing = rows[entry.id];
      if (!existing) { if (devPasses(entry)) append(entry); else tally(); return; }
      var full = existing.nextSibling && existing.nextSibling.className === 'sb-dev-full'
        ? existing.nextSibling
        : null;
      if (!devPasses(entry)) {
        if (full) full.remove();
        existing.remove();
        delete rows[entry.id];
        tally();
        return;
      }
      // A merge or an \u00d7N bump IS a new event, so the replacement flashes like any other.
      var fresh = row(entry);
      fresh.setAttribute('data-fresh', '');
      existing.parentNode.replaceChild(fresh, existing);
      // An open payload belongs to the row above it and stays open, refreshed.
      if (full) {
        try { full.textContent = JSON.stringify(entry.payload, null, 2); }
        catch (e) { full.textContent = String(entry.payload); }
      }
      tally();
    }

    function redraw() {
      dirty = false;
      clear(list);
      rows = {};
      var shown = devEntries.filter(devPasses);
      shown.forEach(function (e) { list.appendChild(row(e)); });
      if (!shown.length) {
        // Turning dev mode on mid-session cannot recover what already fired, so say so
        // rather than showing an empty box that looks broken.
        list.appendChild(el(
          'div',
          'sb-dev-empty',
          devEntries.length
            ? 'Nothing matches this filter.'
            : 'Listening \u2014 events appear as they fire.',
        ));
      }
      tally();
      q.style.borderColor = devBadRe ? '#c0392b' : '';
      q.title = devBadRe
        ? 'That regex does not compile yet \u2014 ignoring that term for now'
        : 'Comma-separated. Update (anywhere) \u00b7 Update* (starts with) \u00b7 ' +
          '*Filters (ends with) \u00b7 !Subscribed (drop). Press ? for the legend.';
      list.scrollTop = list.scrollHeight;
    }

    var qTimer = null;
    q.oninput = function () {
      devFilter.q = q.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(function () { devSaveFilter(); redraw(); }, 150);
    };
    helpBtn.onclick = function () {
      help.hidden = !help.hidden;
      helpBtn.className = help.hidden ? 'sb-dev-qm' : 'sb-dev-qm on';
    };
    clearBtn.onclick = function () { devEntries = []; redraw(); };
    // Closing HIDES it. The ›_ button reopens it with the log intact — a close used to
    // destroy the panel, and the only way back was to toggle dev mode off and on again.
    closeBtn.onclick = function () { root.hidden = true; };
    redraw();
    return {
      root: root,
      append: append,
      update: update,
      redraw: redraw,
      isDirty: function () { return dirty; },
    };
  }

  function devMarkNew() {
    if (devFab) devFab.setAttribute('data-new', '');
  }

  /** The console’s own button, bottom left, opposite ⚙ and ‹/›. Dev mode only. */
  function devFabOn() {
    if (devFab || !devOn) return;
    devFab = el('button', 'sb-dev-fab', '\u203a_');
    devFab.title = 'Dev console \u2014 host events, their replies, and embed events';
    devFab.onclick = toggleDevPanel;
    document.body.appendChild(devFab);
  }

  function openDevPanel() {
    if (!devOn) return;
    devFabOn();
    if (!devUi) devUi = devOverlay();
    var wasHidden = devUi.root.hidden;
    devUi.root.hidden = false;
    if (devFab) devFab.removeAttribute('data-new');
    if (wasHidden || devUi.isDirty()) devUi.redraw();
  }

  function toggleDevPanel() {
    if (devUi && !devUi.root.hidden) { devUi.root.hidden = true; return; }
    openDevPanel();
  }

  /** Dev mode off: the panel and its button go away together. */
  function closeDevMode() {
    if (devUi) { devUi.root.remove(); devUi = null; }
    if (devFab) { devFab.remove(); devFab = null; }
  }

  if (devOn) openDevPanel();

  // ---------------------------------------------------------------- settings
  // Same shape as the ‹/› overlay, because it is the same kind of thing: a panel the
  // page owns, off to one side, that a visitor opens when they need it.

  var settingsPanel = null;
  var settingsAutoOpened = false;

  function settingsOverlay() {
    var root = el('div', 'sb-code-overlay sb-set-overlay');
    root.hidden = true;
    var head = el('div', 'sb-code-head');
    head.appendChild(el('strong', null, 'Settings'));
    head.appendChild(cfgTabs());
    var sp = el('span'); sp.style.flex = '1'; head.appendChild(sp);
    var closeBtn = el('button', null, 'Close');
    head.appendChild(closeBtn);
    var body = el('div', 'sb-set-body');
    var foot = el('div', 'sb-set-foot');
    var loadBtn = el('button', null, 'Load');
    loadBtn.className = 'sb-btn';
    loadBtn.setAttribute('data-variant', 'primary');
    var resetBtn = el('button', 'sb-btn', 'Reset all');
    var footSp = el('span', 'sb-set-sp');
    var msg = el('span', 'sb-set-note');
    foot.appendChild(loadBtn); foot.appendChild(resetBtn);
    foot.appendChild(footSp); foot.appendChild(msg);
    root.appendChild(head); root.appendChild(body); root.appendChild(foot);
    document.body.appendChild(root);

    var fields = {};

    function field(parent, label, value, placeholder, hint) {
      var wrap = el('div', 'sb-set-f');
      var lab = el('label', null, label);
      if (hint) {
        var src = el('span', 'sb-set-src', ' · ' + hint);
        lab.appendChild(src);
      }
      var input = el('input');
      input.value = value === undefined || value === null ? '' : String(value);
      if (placeholder) input.placeholder = placeholder;
      wrap.appendChild(lab); wrap.appendChild(input);
      parent.appendChild(wrap);
      return input;
    }

    /**
     * Switching config swaps the host, the auth and every saved variable at once, and
     * init() cannot be re-pointed after the SDK has booted — so a switch reloads, exactly
     * like pressing Load does.
     */
    function switchCfg(name) {
      if (name === cfg.active) return;
      cfg.active = name;
      if (name && cfg.names.indexOf(name) === -1) cfg.names.push(name);
      writeCfg(cfg);
      location.reload();
    }

    function addCfg(name) {
      if (!name) return;
      if (name === cfg.active || cfg.names.indexOf(name) !== -1) { switchCfg(name); return; }
      // A new config branches from what is on screen rather than starting from nothing,
      // which is what someone pointing a working demo at a second cluster wants.
      var seedInit = readInitOverride();
      var seedVars = store.variables().filter(function (v) { return v.source === 'saved'; });
      cfg.names.push(name);
      cfg.active = name;
      writeCfg(cfg);
      try {
        if (seedInit) localStorage.setItem('sb.init.' + M.projectId + '@' + name, JSON.stringify(seedInit));
        seedVars.forEach(function (v) {
          localStorage.setItem('sb.var.' + M.projectId + '@' + name + '.' + v.key, JSON.stringify(v.value));
        });
      } catch (e) { /* private mode */ }
      location.reload();
    }

    function dropCfg(gone) {
      if (!gone) return;
      // Keys are derived from the NAME being deleted, not from the prefix captured when
      // the page loaded: if the active config changed since (another tab, a switch
      // mid-flight), that prefix could be the default's and this would wipe it.
      var varPrefix = 'sb.var.' + M.projectId + '@' + gone + '.';
      try {
        localStorage.removeItem('sb.init.' + M.projectId + '@' + gone);
        var kill = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(varPrefix) === 0) kill.push(k);
        }
        kill.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) { /* private mode */ }
      cfg.names = cfg.names.filter(function (n) { return n !== gone; });
      if (cfg.active === gone) cfg.active = '';
      writeCfg(cfg);
      location.reload();
    }

    /** The configs as tabs beside the title, and a + that names a new one in place. */
    function cfgTabs() {
      var wrap = el('div', 'sb-set-tabs');

      function tab(value, label) {
        var b = el('button', value === cfg.active ? 'on' : null, label);
        b.title = value ? 'Config "' + value + '" — its own host, auth and variables'
          : 'The site\u2019s own settings';
        b.onclick = function () { switchCfg(value); };
        if (value && value === cfg.active) {
          var x = el('span', 'sb-set-x', '\u00d7');
          x.title = 'Delete "' + value + '"';
          x.onclick = function (e) { e.stopPropagation(); dropCfg(value); };
          b.appendChild(x);
        }
        wrap.appendChild(b);
      }

      tab('', 'Default');
      cfg.names.forEach(function (n) { tab(n, n); });

      var plus = el('button', 'sb-set-plus', '+');
      plus.title = 'Add a config, branched from this one';
      plus.onclick = function () {
        var input = el('input', 'sb-set-new');
        input.placeholder = 'name, then Enter';
        input.maxLength = 40;
        wrap.replaceChild(input, plus);
        input.focus();
        var done = false;
        var restore = function () {
          done = true;
          if (input.parentNode === wrap) wrap.replaceChild(plus, input);
        };
        var commit = function () {
          if (done) return;
          done = true;
          var name = input.value.trim();
          if (name) addCfg(name);
          else restore();
        };
        input.onkeydown = function (e) {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') restore();
        };
        // Clicking away commits rather than cancelling: typing a name and then reaching for
        // the mouse should not silently throw the name away, which is what a plain cancel did.
        input.onblur = commit;
      };
      wrap.appendChild(plus);
      return wrap;
    }

    function build() {
      clear(body);
      fields = { vars: {} };
      var needs = initNeeds();
      // A field shows only what THIS config overrides; the inherited value is the
      // placeholder, so an empty box reads as "using the default" rather than "unset".
      var own = readInitOverride() || {};
      var onDefault = !cfg.active;

      var connH = el('p', 'sb-set-h', 'Connection');
      body.appendChild(connH);
      body.appendChild(el(
        'p',
        'sb-set-note',
        onDefault
          ? 'The site\u2019s defaults, shown read-only. Press + above to make your own config and override them.'
          : needs.length
            ? 'This page needs ' + needs.join(' and ') + ' before it can load.'
            : 'Empty means the site\u2019s default, shown greyed. Type to override it in this browser.',
      ));
      fields.host = field(body, 'ThoughtSpot host', own.thoughtSpotHost || '',
        siteConn.thoughtSpotHost || 'https://your.thoughtspot.cloud');
      fields.sdk = field(body, 'SDK version', own.sdkVersion || '', siteSdkVersion);
      var sdkLab = fields.sdk.previousSibling;
      resolveSdkVersion(M.project.sdkVersion || 'latest').then(function (real) {
        if (real && fields.sdk && sdkLab) sdkLab.appendChild(el('span', 'sb-set-src', ' \u00b7 now ' + real));
      });
      // The version says which build was asked for. This is the file that actually loaded,
      // so a suspect bundle can be opened and read rather than guessed at. It sits in the
      // label, beside the resolved version, because the URL in full is too long to read and
      // the thing you want is one click.
      if (sdkLab && M.sdkUrl) {
        var sdkFile = el('a', 'sb-set-file', 'view build');
        sdkFile.href = M.sdkUrl;
        sdkFile.target = '_blank';
        sdkFile.rel = 'noopener';
        sdkFile.title = M.sdkUrl;
        sdkLab.appendChild(document.createTextNode(' \u00b7 ('));
        sdkLab.appendChild(sdkFile);
        sdkLab.appendChild(document.createTextNode(')'));
      }
      var authWrap = el('div', 'sb-set-f');
      authWrap.appendChild(el('label', null, 'Auth type'));
      var sel = el('select');
      var inherit = el('option', null, 'Default \u2014 ' + (siteConn.authType || 'None'));
      inherit.value = '';
      sel.appendChild(inherit);
      ['None', 'EmbeddedSSO', 'SAMLRedirect', 'OIDCRedirect', 'TrustedAuthTokenCookieless', 'TrustedAuthToken']
        .forEach(function (name) {
          var opt = el('option', null, name);
          opt.value = name;
          if (own.authType === name) opt.selected = true;
          sel.appendChild(opt);
        });
      if (!own.authType) inherit.selected = true;
      authWrap.appendChild(sel);
      body.appendChild(authWrap);
      fields.authType = sel;

      var credWrap = el('div', 'sb-set-f');
      credWrap.style.gap = '10px';
      body.appendChild(credWrap);
      function syncCreds() {
        clear(credWrap);
        // An empty select means "inherit", so the credential fields follow the site's type.
        var effective = sel.value || siteConn.authType || 'None';
        if (TOKEN_AUTH_TYPES.indexOf(effective) === -1) { fields.user = null; fields.secret = null; return; }
        var mine = (own.auth && own.auth.tokenSource === 'credentials') ? own.auth : {};
        var site = (siteConn.auth && siteConn.auth.tokenSource === 'credentials') ? siteConn.auth : {};
        fields.user = field(credWrap, 'Username', mine.username || '', site.username || 'embed user');
        fields.secret = field(credWrap, 'Password', mine.secret || '',
          site.secret ? '•••••• (site default)' : '••••••');
        fields.secret.type = 'password';
        credWrap.appendChild(el('p', 'sb-set-note',
          'Used from this browser to mint a token. Stored here only — never sent to the site.'));
      }
      sel.onchange = syncCreds;
      syncCreds();

      body.appendChild(el('p', 'sb-set-h', 'Developer'));
      var devLab = el('label', 'sb-set-row');
      var devBox = el('input');
      devBox.type = 'checkbox';
      devBox.id = 'sb-dev-toggle';
      devBox.checked = devOn;
      devBox.style.width = 'auto';
      devLab.appendChild(devBox);
      devLab.appendChild(document.createTextNode(
        'Dev mode — log host events, their replies, and embed events'));
      body.appendChild(devLab);
      body.appendChild(el('p', 'sb-set-note',
        'Adds a ›_ button at the bottom left that opens and closes the console. ' +
        'Closing the console keeps the log — only this switch throws it away.'));
      fields.dev = devBox;
      // Ticking it is the whole gesture: no Load, and embeds already on the page get
      // their listener now rather than after a re-mount.
      devBox.onchange = function () {
        devOn = !!devBox.checked;
        try { localStorage.setItem(DEV_LS, devOn ? '1' : '0'); } catch (e) { /* private mode */ }
        if (devOn) {
          openDevPanel();
          Object.keys(slots).forEach(function (k) { wireDevEvents(slots[k].embed); });
        } else {
          devEntries = [];
          closeDevMode();
        }
      };

      var list = store.variables();
      if (list.length) {
        body.appendChild(el('p', 'sb-set-h', 'Variables'));
        body.appendChild(el('p', 'sb-set-note',
          'Used wherever the page writes {{name}} — including an embed\u2019s liveboard id.'));
        list.forEach(function (v) {
          var mine = v.source === 'saved' || v.source === 'session';
          var shown = typeof v.value === 'object' && v.value !== null ? JSON.stringify(v.value) : v.value;
          var text = shown === undefined || shown === null ? '' : String(shown);
          fields.vars[v.key] = field(
            body, v.label,
            mine ? text : '',
            // Not overridden here: show what it is actually using, greyed.
            mine ? (v.placeholder || v.key) : (text || v.placeholder || v.key),
            mine ? v.source : null,
          );
        });
      }

      if (onDefault) {
        Array.prototype.forEach.call(body.querySelectorAll('input, select'), function (n) {
          if (n.id === 'sb-dev-toggle') return;
          n.disabled = true;
        });
      }
      loadBtn.disabled = onDefault;
      loadBtn.title = onDefault ? 'Create a config with + to override the defaults' : '';
      resetBtn.disabled = onDefault;
    }

    function apply() {
      if (!cfg.active) return;
      var host = fields.host.value.trim().replace(/\/+$/, '');
      var authType = fields.authType.value;
      var patch = {};
      // Every field is empty-means-inherit now, so clearing one hands it back to the site.
      if (host) patch.thoughtSpotHost = host;
      if (authType) patch.authType = authType;
      var sdkVer = fields.sdk.value.trim();
      if (sdkVer && sdkVer !== siteSdkVersion) patch.sdkVersion = sdkVer;
      if (fields.user && fields.secret && fields.user.value.trim() && fields.secret.value) {
        patch.auth = {
          tokenSource: 'credentials',
          username: fields.user.value.trim(),
          secret: fields.secret.value,
          secretType: 'password',
        };
      }
      writeInitOverride(Object.keys(patch).length ? patch : null);
      Object.keys(fields.vars).forEach(function (key) {
        var raw = fields.vars[key].value;
        if (raw === '') resetVar(key);
        else store.set(key, raw, { persist: true });
      });
      applyInitOverride();
      // init() runs once per page and cannot be re-pointed at another host, so a page
      // that already booted the SDK has to start over. One that has not can just render.
      if (sdk) { location.reload(); return; }
      msg.textContent = 'loading…';
      Object.keys(slots).forEach(releaseSlot);
      render();
      root.hidden = true;
    }

    loadBtn.onclick = apply;
    resetBtn.onclick = function () {
      if (!cfg.active) return;
      // Clears the config in view only; the others keep whatever they hold.
      // Sweeping the prefix rather than the known-keys list matters: a key the page no
      // longer declares or interpolates is invisible to store.variables(), so the old
      // per-key loop left it saved and "Reset all" looked like it had done nothing.
      writeInitOverride(null);
      store.variables().forEach(function (v) { resetVar(v.key); });
      try {
        var stale = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(VAR_LS) === 0) stale.push(k);
        }
        stale.forEach(function (k) { localStorage.removeItem(k); });
        localStorage.removeItem(INIT_LS);
      } catch (e) { /* private mode */ }
      location.reload();
    };
    closeBtn.onclick = function () { root.hidden = true; };
    return { root: root, build: build };
  }

  function showSettings() {
    if (M.project.showSettings === false) return;
    if (!settingsPanel) settingsPanel = settingsOverlay();
    settingsPanel.build();
    settingsPanel.root.hidden = false;
  }

  /** Open it unasked the first time a page cannot load without it — once. */
  function autoOpenSettings() {
    if (settingsAutoOpened || M.project.showSettings === false) return;
    settingsAutoOpened = true;
    showSettings();
  }

  if (M.project.showSettings !== false) {
    var setFab = el('button', 'sb-set-fab' + (M.project.showCode === false ? ' sb-alone' : ''), '\u2699');
    setFab.title = cfg.active ? 'Settings — config "' + cfg.active + '"' : 'Settings';
    if (cfg.active) setFab.setAttribute('data-cfg', cfg.active);
    setFab.title = 'Settings — connection and variables, kept in this browser';
    setFab.onclick = function () {
      if (settingsPanel && !settingsPanel.root.hidden) { settingsPanel.root.hidden = true; return; }
      showSettings();
    };
    document.body.appendChild(setFab);
  }

  if (M.project.showCode !== false) {
    var fab = el('button', 'sb-code-fab', '\u2039/\u203A');
    fab.title = 'The SDK code behind this page';
    var overlay = null;
    fab.onclick = function () {
      if (!overlay) overlay = codeOverlay();
      if (overlay.root.hidden) { overlay.root.hidden = false; overlay.load(); }
      else overlay.root.hidden = true;
    };
    document.body.appendChild(fab);
  }
})();
