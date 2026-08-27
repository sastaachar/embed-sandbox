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

  var VAR_LS = 'sb.var.' + M.projectId + '.';
  var INIT_LS = 'sb.init.' + M.projectId;
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

  function bindText(node, tpl) {
    node.textContent = interpolate(tpl);
    if (TOKEN.test(tpl)) textBindings.push({ node: node, tpl: tpl });
    TOKEN.lastIndex = 0;
    return node;
  }

  function refreshBindings() {
    textBindings = textBindings.filter(function (b) { return b.node.isConnected; });
    valueBindings = valueBindings.filter(function (b) { return b.node.isConnected; });
    textBindings.forEach(function (b) { b.node.textContent = interpolate(b.tpl); });
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

  document.addEventListener('click', function (ev) {
    var link = ev.target.closest && ev.target.closest('a[data-sb-to]');
    if (!link || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    go(link.getAttribute('data-sb-to'));
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
    if (block && block.style) node.setAttribute('style', block.style);
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
          container.appendChild(styled(bindText(el('p', 'sb-text'), block.text), block));
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

  function runEventAction(action, payload, scope) {
    var p = action.params || {};
    switch (action.type) {
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

  function runHandler(handler, payload, scope) {
    if (handler.id !== undefined) {
      var actionId =
        payload && payload.data && payload.data.id !== undefined
          ? String(payload.data.id)
          : payload && payload.id !== undefined
            ? String(payload.id)
            : null;
      if (String(handler.id) !== actionId) return;
    }
    (handler.actions || []).forEach(function (action) {
      try {
        runEventAction(action, payload, scope);
      } catch (err) {
        console.error('[' + NS + '] action ' + action.type + ' failed', err);
      }
    });
  }

  // Registered before render()/preRender() so no early events are missed.
  function wireHandlers(embed, handlers) {
    if (!handlers || !handlers.length) return;
    var events = sdk.EmbedEvent || {};
    var scope = active;
    handlers.forEach(function (handler) {
      if (!events[handler.type]) {
        console.warn(
          '[' + NS + '] SDK ' + (M.project.sdkVersion || 'latest') +
            ' has no EmbedEvent named "' + handler.type + '" — handler not wired.',
        );
        return;
      }
      try {
        embed.on(events[handler.type], function (payload) { runHandler(handler, payload, scope); });
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

  function slotFor(path, spec, idx) {
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
    var entry;
    try {
      entry = slotFor(path, spec, idx);
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
  var DEVF_LS = 'sb.devf.' + M.projectId;
  var DEV_CAP = 400;
  var devOn = false;
  var devFilter = { mode: 'only', q: '', dirs: { embed: true, host: true, reply: true } };
  var devEntries = [];
  var devUi = null;

  try { devOn = localStorage.getItem(DEV_LS) === '1'; } catch (e) { /* private mode */ }
  try {
    var savedF = JSON.parse(localStorage.getItem(DEVF_LS) || 'null');
    if (savedF && savedF.dirs) devFilter = savedF;
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

  function devPush(dir, name, target, payload) {
    if (!devOn) return;
    devEntries.push({ at: new Date(), dir: dir, name: String(name), target: target || '', payload: payload });
    if (devEntries.length > DEV_CAP) devEntries.splice(0, devEntries.length - DEV_CAP);
    if (devUi) devUi.append(devEntries[devEntries.length - 1]);
  }

  function devPasses(entry) {
    if (!devFilter.dirs[entry.dir]) return false;
    var terms = String(devFilter.q || '')
      .split(',')
      .map(function (t) { return t.trim().toLowerCase(); })
      .filter(Boolean);
    if (!terms.length) return true;
    var hay = (entry.name + ' ' + entry.target).toLowerCase();
    var hit = terms.some(function (t) { return hay.indexOf(t) !== -1; });
    // "only these" versus "everything but these" — the same box, two meanings.
    return devFilter.mode === 'hide' ? !hit : hit;
  }

  /**
   * THE place a host event leaves this page. Everything routes through here — buttons,
   * event-handler actions, the value store's sinks — so dev mode sees every fire, which
   * embed it went to, and what came back.
   */
  function triggerOn(embed, hostEvent, name, payload) {
    devPush('host', name, embedLabel(embed), payload);
    var out;
    try {
      out = embed.trigger(hostEvent, payload);
    } catch (err) {
      devPush('reply', name, embedLabel(embed), { error: String((err && err.message) || err) });
      throw err;
    }
    if (out && typeof out.then === 'function') {
      out.then(
        function (value) { devPush('reply', name, embedLabel(embed), value); },
        function (err) { devPush('reply', name, embedLabel(embed), { error: String((err && err.message) || err) }); },
      );
    } else {
      devPush('reply', name, embedLabel(embed), out);
    }
    return out;
  }

  /** One ALL listener per embed: it carries { type, data }, so names are real. */
  function wireDevEvents(embed) {
    if (!devOn || !sdk || !sdk.EmbedEvent || !sdk.EmbedEvent.ALL) return;
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
    var sent = false;
    embeds.forEach(function (embed) {
      try {
        var out = triggerOn(embed, events[name], name, payload);
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
  }

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
    var flavor = 'react';
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
    var closeBtn = el('button', null, 'Close');
    head.appendChild(seg); head.appendChild(partSeg); head.appendChild(pathEl);
    var spacer = el('span'); spacer.style.flex = '1'; head.appendChild(spacer);
    head.appendChild(copyBtn); head.appendChild(forkA); head.appendChild(closeBtn);
    var pre = el('pre', 'sb-code-pre');
    root.appendChild(head); root.appendChild(pre);
    document.body.appendChild(root);

    var raw = '';
    function load() {
      btnReact.className = flavor === 'react' ? 'on' : '';
      btnJs.className = flavor === 'esm' ? 'on' : '';
      partSeg.hidden = flavor !== 'esm';
      btnJsCode.className = part === 'js' ? 'on' : '';
      btnHtml.className = part === 'html' ? 'on' : '';
      var htmlPart = flavor === 'esm' && part === 'html';
      var path = currentPath();
      pathEl.textContent = path;
      pre.textContent = 'generating…';
      fetch('/api/projects/' + M.projectId + '/code?path=' + encodeURIComponent(path) +
          '&flavor=' + flavor + (htmlPart ? '&part=html' : ''))
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('could not generate')); })
        .then(function (body) {
          raw = body.code || '';
          pre.textContent = raw;
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

  function devOverlay() {
    var root = el('div', 'sb-dev');
    var head = el('div', 'sb-dev-head');
    head.appendChild(el('strong', null, 'Dev'));
    var q = el('input', 'sb-dev-q');
    q.placeholder = 'event names, comma separated';
    q.value = devFilter.q || '';
    head.appendChild(q);
    var seg = el('div', 'sb-code-seg sb-dev-seg');
    var onlyBtn = el('button', null, 'Only');
    var hideBtn = el('button', null, 'Hide');
    seg.appendChild(onlyBtn); seg.appendChild(hideBtn);
    head.appendChild(seg);
    var dirs = el('div', 'sb-dev-dirs');
    var boxes = {};
    ['embed', 'host', 'reply'].forEach(function (dir) {
      var lab = el('label');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = devFilter.dirs[dir] !== false;
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(dir));
      dirs.appendChild(lab);
      boxes[dir] = cb;
      cb.onchange = function () { devFilter.dirs[dir] = cb.checked; devSaveFilter(); redraw(); };
    });
    head.appendChild(dirs);
    var count = el('span', 'sb-dev-count');
    head.appendChild(count);
    var clearBtn = el('button', null, 'Clear');
    var closeBtn = el('button', null, 'Close');
    head.appendChild(clearBtn); head.appendChild(closeBtn);
    var list = el('div', 'sb-dev-list');
    root.appendChild(head); root.appendChild(list);
    document.body.appendChild(root);

    function preview(value) {
      if (value === undefined) return '';
      if (value === null) return 'null';
      if (typeof value !== 'object') return String(value);
      try {
        var s = JSON.stringify(value);
        return s.length > 90 ? s.slice(0, 89) + '…' : s;
      } catch (e) { return '[unserialisable]' }
    }

    function row(entry) {
      var line = el('div', 'sb-dev-row');
      line.setAttribute('data-dir', entry.dir);
      var t = entry.at;
      var hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') +
        ':' + String(t.getSeconds()).padStart(2, '0');
      line.appendChild(el('span', 'sb-dev-t', hh));
      line.appendChild(el('span', 'sb-dev-b', entry.dir === 'embed' ? '↓' : entry.dir === 'host' ? '↑' : '↳'));
      line.appendChild(el('span', 'sb-dev-n', entry.name));
      if (entry.target) line.appendChild(el('span', 'sb-dev-tg', entry.target));
      line.appendChild(el('span', 'sb-dev-p', preview(entry.payload)));
      line.onclick = function () {
        var open = line.nextSibling && line.nextSibling.className === 'sb-dev-full';
        if (open) { line.nextSibling.remove(); return; }
        var full = el('pre', 'sb-dev-full');
        try { full.textContent = JSON.stringify(entry.payload, null, 2); }
        catch (e) { full.textContent = String(entry.payload); }
        list.insertBefore(full, line.nextSibling);
      };
      return line;
    }

    function append(entry) {
      if (!devPasses(entry)) { count.textContent = String(devEntries.length); return; }
      var atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
      list.appendChild(row(entry));
      count.textContent = String(devEntries.length);
      if (atBottom) list.scrollTop = list.scrollHeight;
    }

    function redraw() {
      onlyBtn.className = devFilter.mode === 'only' ? 'on' : '';
      hideBtn.className = devFilter.mode === 'hide' ? 'on' : '';
      clear(list);
      devEntries.filter(devPasses).forEach(function (e) { list.appendChild(row(e)); });
      count.textContent = String(devEntries.length);
      list.scrollTop = list.scrollHeight;
    }

    var qTimer = null;
    q.oninput = function () {
      devFilter.q = q.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(function () { devSaveFilter(); redraw(); }, 150);
    };
    onlyBtn.onclick = function () { devFilter.mode = 'only'; devSaveFilter(); redraw(); };
    hideBtn.onclick = function () { devFilter.mode = 'hide'; devSaveFilter(); redraw(); };
    clearBtn.onclick = function () { devEntries = []; redraw(); };
    closeBtn.onclick = function () { root.remove(); devUi = null; };
    redraw();
    return { root: root, append: append, redraw: redraw };
  }

  function openDevPanel() {
    if (!devOn) return;
    if (!devUi) devUi = devOverlay();
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

    function build() {
      clear(body);
      fields = { vars: {} };
      var needs = initNeeds();

      var connH = el('p', 'sb-set-h', 'Connection');
      body.appendChild(connH);
      body.appendChild(el(
        'p',
        'sb-set-note',
        needs.length
          ? 'This page needs ' + needs.join(' and ') + ' before it can load.'
          : 'Already configured by the site. Override it here for your own browser if you want.',
      ));
      fields.host = field(body, 'ThoughtSpot host', M.project.thoughtSpotHost || '',
        'https://your.thoughtspot.cloud');
      var authWrap = el('div', 'sb-set-f');
      authWrap.appendChild(el('label', null, 'Auth type'));
      var sel = el('select');
      ['None', 'EmbeddedSSO', 'SAMLRedirect', 'OIDCRedirect', 'TrustedAuthTokenCookieless', 'TrustedAuthToken']
        .forEach(function (name) {
          var opt = el('option', null, name);
          opt.value = name;
          if ((M.project.authType || 'None') === name) opt.selected = true;
          sel.appendChild(opt);
        });
      authWrap.appendChild(sel);
      body.appendChild(authWrap);
      fields.authType = sel;

      var credWrap = el('div', 'sb-set-f');
      credWrap.style.gap = '10px';
      body.appendChild(credWrap);
      function syncCreds() {
        clear(credWrap);
        if (TOKEN_AUTH_TYPES.indexOf(sel.value) === -1) { fields.user = null; fields.secret = null; return; }
        var current = (M.project.auth && M.project.auth.tokenSource === 'credentials') ? M.project.auth : {};
        fields.user = field(credWrap, 'Username', current.username || '', 'embed user');
        fields.secret = field(credWrap, 'Password', current.secret || '', '••••••');
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
      devLab.appendChild(document.createTextNode('Dev mode — log host events, their replies, and embed events'));
      body.appendChild(devLab);
      fields.dev = devBox;

      var list = store.variables();
      if (list.length) {
        body.appendChild(el('p', 'sb-set-h', 'Variables'));
        body.appendChild(el('p', 'sb-set-note',
          'Used wherever the page writes {{name}} — including an embed\u2019s liveboard id.'));
        list.forEach(function (v) {
          var shown = typeof v.value === 'object' && v.value !== null ? JSON.stringify(v.value) : v.value;
          fields.vars[v.key] = field(body, v.label, shown, v.placeholder || v.key, v.source);
        });
      }
    }

    function apply() {
      var host = fields.host.value.trim().replace(/\/+$/, '');
      var authType = fields.authType.value;
      var patch = {};
      if (host) patch.thoughtSpotHost = host;
      if (authType) patch.authType = authType;
      if (fields.user && fields.secret && fields.user.value.trim() && fields.secret.value) {
        patch.auth = {
          tokenSource: 'credentials',
          username: fields.user.value.trim(),
          secret: fields.secret.value,
          secretType: 'password',
        };
      }
      writeInitOverride(Object.keys(patch).length ? patch : null);
      if (fields.dev) {
        var wantDev = !!fields.dev.checked;
        if (wantDev !== devOn) {
          devOn = wantDev;
          try { localStorage.setItem(DEV_LS, devOn ? '1' : '0'); } catch (e) { /* private mode */ }
          // Listeners attach as an embed mounts, so turning it on re-mounts.
          if (devOn) openDevPanel();
          else if (devUi) { devUi.root.remove(); devUi = null; }
          Object.keys(slots).forEach(releaseSlot);
        }
      }
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
      writeInitOverride(null);
      store.variables().forEach(function (v) { resetVar(v.key); });
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
