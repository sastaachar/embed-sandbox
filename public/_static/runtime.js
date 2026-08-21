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
      b.node.textContent = v === undefined ? '—' : display(v);
    });
  }

  var store = {
    set: function (key, value) {
      if (typeof key !== 'string' || !key) throw new TypeError(NS + '.set(key, value): key must be a string');
      values[key] = value;
      refreshBindings();
      (listeners[key] || []).slice().forEach(function (fn) {
        try { fn(value, key); } catch (err) { console.error('[' + NS + '] listener failed', err); }
      });
      return value;
    },
    get: function (key) {
      return key === undefined ? undefined : lookup(key);
    },
    /** Named alias for the pairing a "set" action creates. */
    setVariable: function (key, value) { return store.set(key, value); },
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
    clear: function (key) {
      if (key === undefined) values = {};
      else delete values[key];
      refreshBindings();
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
          valueBindings.push({ node: out, key: block.key });
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

  // Distinct from the button runner below: same idea, different vocabulary.
  /** The SDK loading and the SDK being configurable are different failures. */
  function sdkErrorTitle(err) {
    return err && err.configError ? 'Embed not configured' : 'SDK failed to load';
  }

  function runEventAction(action, payload, scope) {
    var p = action.params || {};
    switch (action.type) {
      case 'set':
        return store.set(p.key, readPath(payload, p.value));
      case 'open-modal':
        return openModal(p.name);
      case 'close-modal':
        return closeModal();
      case 'host-event':
        return trigger(p.hostEvent, p.data, p.targets, scope, p.store);
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
    // The host is the rect showPreRender() syncs to, so it carries the height even
    // while parked in the attic — a host sized differently from the frame is the 0×0
    // class of bug all over again.
    if (spec.height && !(spec.config || {}).fullHeight) host.style.height = spec.height;
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
    // render() is the whole story: with a preRenderId it connects to the background
    // copy and shows it, without one it builds its own iframe. On a REVISIT to a
    // connected embed the wrapper is hidden, not gone, so showPreRender() un-hides it —
    // that is the one place the call belongs.
    if (!entry.rendered) {
      entry.rendered = true;
      entry.embed.render();
    } else if (entry.spec.config && entry.spec.config.preRenderId) {
      entry.embed.showPreRender();
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
        var out = embed.trigger(events[name], payload);
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

    if (!projectCfg.thoughtSpotHost) {
      mounts.forEach(function (m) {
        clear(m.wrapper);
        m.wrapper.appendChild(
          note(
            'No ThoughtSpot host set',
            'Set thoughtSpotHost on this project (via MCP set_site or the API) and the embed will render here.',
          ),
        );
      });
      return;
    }

    ensureSdk().then(
      function () {
        mounts.forEach(function (m) {
          mountEmbed(path, m.spec, m.wrapper, m.idx);
        });
        preRenderOtherPages();
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
                  throw new Error(
                    'the cluster refused to mint a token (' + res.status + ')' +
                      (res.status === 401 || res.status === 403 ? ' — check the username and secret' : ''),
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

  var preRenderedOthers = false;
  function preRenderOtherPages() {
    if (preRenderedOthers) return;
    preRenderedOthers = true;
    var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 200); };
    idle(function () {
      Object.keys(pages).forEach(function (path) {
        if (path === active) return;
        embedSpecsOf(pages[path]).forEach(function (s) {
          if (!s.spec.preRender) return;
          if (slots[slotKey(path, s.idx)]) return;
          try {
            slotFor(path, s.spec, s.idx);
          } catch (err) {
            console.warn('[sandbox] pre-render skipped for ' + path, err);
          }
        });
      });
    });
  }

  console.info(
    '[' + NS + '] ready — ' + NS + ".set('k', v) / " + NS + ".get('k') / " + NS + '.all() · ' +
      NS + '.init() resolves the one-per-project SDK init · ' + NS + '.config, ' + NS + '.embeds()',
  );

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

  var CODE_KEYWORDS = /\b(import|export|from|const|let|var|function|return|new|async|await|if|else|for|of|in|typeof|class|extends|true|false|null|undefined|default)\b/g;

  function highlight(src) {
    var esc = String(src)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var out = '';
    var rest = esc;
    // one pass, longest-match-first: comments, strings, then everything else
    var token = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d.]*\b)/g;
    var last = 0, m;
    while ((m = token.exec(esc)) !== null) {
      out += plain(esc.slice(last, m.index));
      if (m[1]) out += '<i class="c-com">' + m[1] + '</i>';
      else if (m[2]) out += '<i class="c-str">' + m[2] + '</i>';
      else out += '<i class="c-num">' + m[3] + '</i>';
      last = m.index + m[0].length;
    }
    out += plain(esc.slice(last));
    return out;

    function plain(chunk) {
      // Keywords FIRST: "class" is a keyword, and running it after the tag wrapping
      // rewrites the injected <i class="..."> markup itself into garbage.
      return chunk
        .replace(CODE_KEYWORDS, '<i class="c-kw">$&</i>')
        .replace(/&lt;(\/?)([A-Z][A-Za-z0-9]*)/g, '&lt;$1<i class="c-cmp">$2</i>')
        .replace(/&lt;(\/?)([a-z][a-z0-9]*)/g, '&lt;$1<i class="c-tag">$2</i>');
    }
  }

  function codeOverlay() {
    var flavor = 'react';
    var root = el('div', 'sb-code-overlay');
    root.hidden = true;
    var head = el('div', 'sb-code-head');
    var seg = el('div', 'sb-code-seg');
    var btnReact = el('button', null, 'React');
    var btnJs = el('button', null, 'JavaScript');
    seg.appendChild(btnReact); seg.appendChild(btnJs);
    var pathEl = el('span', 'sb-code-path');
    var copyBtn = el('button', null, 'Copy');
    var forkA = el('a', 'sb-code-fork', 'Fork & edit');
    forkA.href = '/fork/' + M.projectId;
    forkA.target = '_blank';
    forkA.rel = 'noopener';
    var closeBtn = el('button', null, 'Close');
    head.appendChild(seg); head.appendChild(pathEl);
    var spacer = el('span'); spacer.style.flex = '1'; head.appendChild(spacer);
    head.appendChild(copyBtn); head.appendChild(forkA); head.appendChild(closeBtn);
    var pre = el('pre', 'sb-code-pre');
    root.appendChild(head); root.appendChild(pre);
    document.body.appendChild(root);

    var raw = '';
    function load() {
      btnReact.className = flavor === 'react' ? 'on' : '';
      btnJs.className = flavor === 'esm' ? 'on' : '';
      var path = currentPath();
      pathEl.textContent = path;
      pre.textContent = 'generating…';
      fetch('/api/projects/' + M.projectId + '/code?path=' + encodeURIComponent(path) + '&flavor=' + flavor)
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('could not generate')); })
        .then(function (body) { raw = body.code || ''; pre.innerHTML = highlight(raw); })
        .catch(function (err) { pre.textContent = String(err.message || err); });
    }
    btnReact.onclick = function () { flavor = 'react'; load(); };
    btnJs.onclick = function () { flavor = 'esm'; load(); };
    copyBtn.onclick = function () {
      navigator.clipboard.writeText(raw).then(function () {
        copyBtn.textContent = 'Copied';
        setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1400);
      });
    };
    closeBtn.onclick = function () { root.hidden = true; };
    return { root: root, load: load };
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
