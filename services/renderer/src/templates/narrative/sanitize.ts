// Render-time re-sanitiser for narrative HTML and the smart fragment (REQ-SEC-088, 07-SECURITY T8; 02-TRD §5.3 "same sanitiser
// profile"). Defence in depth behind the server-side sanitiser: an allowlist of formatting tags, every attribute dropped,
// dangerous elements dropped with their content, all text re-escaped, output balanced so a fragment cannot leave its section.
import { esc } from '../lab/shared.js';

const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span']);
const VOID = new Set(['br']);
/** Removed together with everything up to their closing tag. */
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'noscript', 'template', 'textarea', 'select',
  'title', 'head', 'frameset', 'frame', 'noembed', 'noframes', 'xmp', 'plaintext', 'video', 'audio', 'canvas', 'applet']);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (t: string) =>
  t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? all;
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  });

const TOKEN = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<[!?][^>]*>?/g;

export function sanitizeHtml(html: string): string {
  const src = String(html ?? '');
  const stack: string[] = [];
  let out = '';
  let at = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(src); m; m = TOKEN.exec(src)) {
    out += esc(decode(src.slice(at, m.index)));
    at = TOKEN.lastIndex;
    const name = m[2]?.toLowerCase();
    if (!name) continue; // comment, doctype, processing instruction
    if (!m[1] && DROP.has(name)) {
      const close = new RegExp(`</${name}\\s*>`, 'ig');
      close.lastIndex = at;
      const c = close.exec(src);
      at = TOKEN.lastIndex = c ? close.lastIndex : src.length;
      continue;
    }
    if (!ALLOWED.has(name)) continue; // tag dropped, its text kept
    if (m[1]) {
      const k = stack.lastIndexOf(name);
      if (k === -1) continue;
      while (stack.length > k) out += `</${stack.pop()}>`;
    } else {
      out += `<${name}>`;
      if (!VOID.has(name)) stack.push(name);
    }
  }
  out += esc(decode(src.slice(at)));
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}
