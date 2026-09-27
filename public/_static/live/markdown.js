/**
 * The ONE Markdown implementation.
 *
 * Both the published runtime and the builder canvas load this file, so a text block
 * looks the same while you are writing it and after you share the link. It is a plain
 * script that hangs `SBMarkdown` off the window — no build step, no module system,
 * because runtime.js has neither either.
 *
 * MARKDOWN ONLY. HTML IS NOT A FEATURE HERE, AND CANNOT BECOME ONE BY ACCIDENT.
 * Every element below comes from document.createElement and every character of author
 * text lands in a text node. Nothing here parses markup — no assignment that takes an
 * HTML string exists in this file — so `<b>bold</b>` in a text block cannot turn into
 * an element. It comes out as the eleven characters that were typed. That is deliberate:
 * page content is stored, shared and edited by whoever holds the token, so "Markdown,
 * not HTML" is a property of the renderer rather than a promise about the input.
 *
 * Supported, and nothing else:
 *   # ... ######   headings
 *   - * +          bullet lists, nested by indentation
 *   1.  1)         numbered lists
 *   >              blockquote
 *   ```lang        fenced code
 *   ---            horizontal rule
 *   **b** __b__ *i* _i_ ~~s~~ `code` [text](url) ![alt](url) \\escape
 *   a single newline inside a paragraph is a line break
 */
(function (global) {
  'use strict';

  /** Stops nested lists, quotes and emphasis from recursing without end. */
  var MAX_DEPTH = 8;

  var LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  var HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
  var FENCE = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/;
  var RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
  var QUOTE = /^ {0,3}>/;
  var WORD = /[A-Za-z0-9_]/;

  // Precedence, left to right: an escape wins over everything, then code (whose body is
  // never looked at again), then the two link forms, then the emphasis runs.
  //   1 escaped char · 2 code · 3,4,5 image alt/src/title · 6,7,8 link label/href/title
  //   9,10 strong · 11,12 em · 13 strike
  var INLINE = [
    '\\\\([\\\\`*_~\\[\\]()!>#+.-])',
    '`([^`\\n]+)`',
    '!\\[([^\\]]*)\\]\\(\\s*([^\\s)]*)(?:\\s+"([^"]*)")?\\s*\\)',
    '\\[([^\\]]*)\\]\\(\\s*([^\\s)]*)(?:\\s+"([^"]*)")?\\s*\\)',
    '(\\*\\*|__)(?=\\S)([\\s\\S]*?\\S)\\9',
    '(\\*|_)(?=\\S)([\\s\\S]*?\\S)\\11',
    '~~(?=\\S)([\\s\\S]*?\\S)~~',
  ].join('|');

  /**
   * A URL is either scheme-less (a path, a query, a #anchor) or one of the few schemes
   * that cannot execute anything. `javascript:`, `data:` and friends fall through to
   * null and the caller renders the link as the literal text that was typed.
   */
  function safeUrl(raw) {
    var url = String(raw == null ? '' : raw).trim();
    if (!url) return null;
    var scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
    if (!scheme) return url;
    return /^(https?|mailto|tel)$/i.test(scheme[1]) ? url : null;
  }

  /** `_` only opens emphasis between non-word characters, so snake_case_ids survive. */
  function underscoreOk(src, start, end) {
    var before = start > 0 ? src.charAt(start - 1) : ' ';
    var after = end < src.length ? src.charAt(end) : ' ';
    return !WORD.test(before) && !WORD.test(after);
  }

  /** A newline inside a paragraph is a line break — what someone typing into a box means. */
  function appendText(parent, text) {
    if (!text) return;
    var parts = text.split('\n');
    for (var i = 0; i < parts.length; i++) {
      if (i) parent.appendChild(document.createElement('br'));
      if (parts[i]) parent.appendChild(document.createTextNode(parts[i]));
    }
  }

  function inlineInto(parent, src, depth) {
    src = String(src == null ? '' : src);
    if (depth > MAX_DEPTH) { appendText(parent, src); return; }

    // Fresh regex per call: inlineInto recurses, and a shared /g regex would carry its
    // lastIndex into the nested scan and skip half the text.
    var re = new RegExp(INLINE, 'g');
    var last = 0;
    var m;

    while ((m = re.exec(src)) !== null) {
      if (m[0] === '') { re.lastIndex++; continue; }

      var marker = m[9] || m[11];
      if (marker && marker.charAt(0) === '_' && !underscoreOk(src, m.index, re.lastIndex)) {
        continue; // leave it in the pending text and keep scanning
      }

      appendText(parent, src.slice(last, m.index));
      last = re.lastIndex;

      if (m[1] !== undefined) {
        parent.appendChild(document.createTextNode(m[1]));
      } else if (m[2] !== undefined) {
        var code = document.createElement('code');
        code.textContent = m[2];
        parent.appendChild(code);
      } else if (m[4] !== undefined) {
        var imgSrc = safeUrl(m[4]);
        if (imgSrc === null) { appendText(parent, m[0]); continue; }
        var img = document.createElement('img');
        img.src = imgSrc;
        img.alt = m[3] || '';
        if (m[5]) img.title = m[5];
        img.loading = 'lazy';
        parent.appendChild(img);
      } else if (m[7] !== undefined) {
        var href = safeUrl(m[7]);
        if (href === null) { appendText(parent, m[0]); continue; }
        var a = document.createElement('a');
        a.href = href;
        if (m[8]) a.title = m[8];
        // Off-site links leave the demo; same-page ones are the runtime's own router.
        if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        inlineInto(a, m[6], depth + 1);
        parent.appendChild(a);
      } else if (m[10] !== undefined) {
        parent.appendChild(wrap('strong', m[10], depth));
      } else if (m[12] !== undefined) {
        parent.appendChild(wrap('em', m[12], depth));
      } else if (m[13] !== undefined) {
        parent.appendChild(wrap('del', m[13], depth));
      }
    }

    appendText(parent, src.slice(last));
  }

  function wrap(tag, body, depth) {
    var node = document.createElement(tag);
    inlineInto(node, body, depth + 1);
    return node;
  }

  function startsBlock(line) {
    return !line.trim()
      || FENCE.test(line)
      || HEADING.test(line)
      || RULE.test(line)
      || QUOTE.test(line)
      || LIST.test(line);
  }

  /** One flat pass over the marker lines; nesting is rebuilt from the indents after. */
  function listItems(lines) {
    var items = [];
    lines.forEach(function (line) {
      var m = LIST.exec(line);
      if (m) {
        items.push({
          indent: m[1].length,
          ordered: /\d/.test(m[2]),
          num: parseInt(m[2], 10) || 1,
          lines: [m[3]],
        });
      } else if (items.length && line.trim()) {
        items[items.length - 1].lines.push(line.trim());
      }
    });
    return items;
  }

  /** Consumes every item at `indent` (and deeper) into one <ul>/<ol>. */
  function listAt(items, cursor, indent, depth) {
    var first = items[cursor.i];
    var list = document.createElement(first.ordered ? 'ol' : 'ul');
    if (first.ordered && first.num > 1) list.start = first.num;

    while (cursor.i < items.length) {
      var it = items[cursor.i];
      if (it.indent < indent) break;
      if (it.indent > indent) {
        var host = list.lastChild;
        if (!host || depth >= MAX_DEPTH) { cursor.i++; continue; }
        host.appendChild(listAt(items, cursor, it.indent, depth + 1));
        continue;
      }
      if (it.ordered !== first.ordered) break; // a different kind of list starts here
      cursor.i++;
      var li = document.createElement('li');
      inlineInto(li, it.lines.join('\n').trim(), depth + 1);
      list.appendChild(li);
    }
    return list;
  }

  function buildList(lines, depth) {
    var items = listItems(lines);
    var frag = document.createDocumentFragment();
    var cursor = { i: 0 };
    while (cursor.i < items.length) {
      var before = cursor.i;
      frag.appendChild(listAt(items, cursor, items[cursor.i].indent, depth));
      if (cursor.i === before) cursor.i++; // a malformed run must never spin
    }
    return frag;
  }

  function blocksInto(parent, src, depth) {
    var lines = String(src == null ? '' : src)
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '    ')
      .split('\n');
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }

      var fence = FENCE.exec(line);
      if (fence) {
        var closeRe = new RegExp('^ {0,3}' + fence[1].charAt(0) + '{' + fence[1].length + ',}\\s*$');
        var body = [];
        i++;
        while (i < lines.length && !closeRe.test(lines[i])) { body.push(lines[i]); i++; }
        i++; // the closing fence, or the end of the input
        var pre = document.createElement('pre');
        var codeEl = document.createElement('code');
        if (fence[2]) codeEl.className = 'language-' + fence[2];
        codeEl.textContent = body.join('\n');
        pre.appendChild(codeEl);
        parent.appendChild(pre);
        continue;
      }

      var head = HEADING.exec(line);
      if (head) {
        var h = document.createElement('h' + head[1].length);
        inlineInto(h, head[2].trim(), depth);
        parent.appendChild(h);
        i++;
        continue;
      }

      if (RULE.test(line)) {
        parent.appendChild(document.createElement('hr'));
        i++;
        continue;
      }

      if (QUOTE.test(line)) {
        var quoted = [];
        while (i < lines.length && (QUOTE.test(lines[i]) || (quoted.length && lines[i].trim()))) {
          quoted.push(lines[i].replace(/^ {0,3}>[ \t]?/, ''));
          i++;
        }
        var bq = document.createElement('blockquote');
        if (depth < MAX_DEPTH) blocksInto(bq, quoted.join('\n'), depth + 1);
        else appendText(bq, quoted.join('\n'));
        parent.appendChild(bq);
        continue;
      }

      if (LIST.test(line)) {
        var start = i;
        while (i < lines.length) {
          var l = lines[i];
          if (LIST.test(l)) { i++; continue; }
          if (!l.trim()) {
            // A blank line ends the list unless the next line carries it on.
            var next = lines[i + 1];
            if (next && (LIST.test(next) || /^\s{2,}\S/.test(next))) { i++; continue; }
            break;
          }
          if (/^\s{2,}\S/.test(l)) { i++; continue; } // wrapped item text
          break;
        }
        parent.appendChild(buildList(lines.slice(start, i), depth));
        continue;
      }

      var para = [];
      while (i < lines.length && !startsBlock(lines[i])) { para.push(lines[i]); i++; }
      if (!para.length) { para.push(lines[i]); i++; } // belt and braces: never stall
      var p = document.createElement('p');
      inlineInto(p, para.join('\n').trim(), depth);
      parent.appendChild(p);
    }
  }

  function toFragment(src) {
    var frag = document.createDocumentFragment();
    blocksInto(frag, src, 0);
    return frag;
  }

  /** Replaces `node`'s children with the rendered Markdown and marks it for the CSS. */
  function render(node, src) {
    while (node.firstChild) node.removeChild(node.firstChild);
    node.classList.add('sb-md');
    node.appendChild(toFragment(src));
    return node;
  }

  global.SBMarkdown = { render: render, toFragment: toFragment, safeUrl: safeUrl };
}(typeof window !== 'undefined' ? window : this));
