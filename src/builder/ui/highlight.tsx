import React from 'react';

/**
 * Just enough JavaScript/TypeScript tokenising to colour the run-code editor. Rendered
 * into a layer *behind* a transparent textarea, so the browser keeps doing the editing
 * and this only has to paint. Both layers must share font, padding and wrapping or the
 * text drifts apart — see .codefn-body / .codefn-hl.
 */

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'if',
  'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'super', 'switch', 'this',
  'throw', 'try', 'typeof', 'var', 'void', 'while', 'yield',
]);

const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

/** What the framework hands the block: worth spotting at a glance. */
const PROVIDED = new Set(['payload', 'context', 'getVariable', 'setVariable']);

const TOKEN = new RegExp([
  '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)',                              // 1 comment
  '(\'(?:\\\\.|[^\'\\\\\\n])*\'|"(?:\\\\.|[^"\\\\\\n])*"|`(?:\\\\.|[^`\\\\])*`)', // 2 string
  '(\\b\\d[\\d_]*(?:\\.\\d+)?\\b)',                                      // 3 number
  '([A-Za-z_$][\\w$]*)',                                                 // 4 word
].join('|'), 'g');

function classOf(word: string, before: string, after: string): string | null {
  if (KEYWORDS.has(word)) return 'c-kw';
  if (LITERALS.has(word)) return 'c-lit';
  // A provided name only counts on its own, not as someone's property.
  if (PROVIDED.has(word) && !before.endsWith('.')) return 'c-fw';
  if (after.startsWith('(')) return 'c-fn';
  if (before.endsWith('.')) return 'c-prop';
  return null;
}

export function highlight(src: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  const push = (text: string, cls?: string) => {
    if (!text) return;
    out.push(cls ? <span key={key++} className={cls}>{text}</span> : text);
  };

  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(src)) !== null) {
    push(src.slice(last, m.index));
    const [raw, comment, string, num, word] = m;
    if (comment) push(raw, 'c-com');
    else if (string) push(raw, 'c-str');
    else if (num) push(raw, 'c-num');
    else if (word) {
      const cls = classOf(word, src.slice(Math.max(0, m.index - 2), m.index).trimEnd(),
        src.slice(m.index + raw.length).trimStart());
      push(raw, cls ?? undefined);
    }
    last = m.index + raw.length;
  }
  push(src.slice(last));
  // A trailing newline needs something after it or the layer is one line short.
  out.push('\n');
  return out;
}
