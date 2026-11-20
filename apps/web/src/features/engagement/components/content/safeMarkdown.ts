// T0D-CONTENT-1 (LD-313 d): copy of services/api/src/modules/engagement/service/safeMarkdown.ts from the next line on, so the staff preview
// renders exactly what the API validates and the patient app shows. Change both together (content1.screens.test.tsx compares the output).
// T0B-CONTENT-1 (LD-313 d): the ONE shared Markdown helper for portal content. Write side: validateMarkdown (the handlers answer 400 /body);
// read side: renderMarkdown (whitelisted HTML, safe to inject). Subset: headings #..######, **bold**, *italic* / _italic_, bullet and numbered lists,
// [text](https://...) links. No raw HTML ("<" anywhere), no images, no reference definitions, no numeric character references, no C0 controls.
// Hand written on purpose (no new dependency); every regex is bounded or anchored so hostile 20k inputs stay linear.

export const MARKDOWN_MAX_CHARS = 20000;

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_G = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const URL_CHAR = /[^\s"'<>()\\`]/;
const SAFE_URL = /^https:\/\/[^\s"'<>()\\`]+$/;

export type MarkdownCheck = { ok: true } | { ok: false; reason: string };

/** Write side: true only for the allowed subset (same rules as the contract pattern on PortalContentCreate.body, plus a strict link URL). */
export function validateMarkdown(src: string): MarkdownCheck {
  if (typeof src !== 'string') return { ok: false, reason: 'not a string' };
  if (src.length > MARKDOWN_MAX_CHARS) return { ok: false, reason: 'too long' };
  if (CONTROL.test(src)) return { ok: false, reason: 'control character' };
  if (src.includes('<')) return { ok: false, reason: 'raw HTML' };
  if (src.includes('![')) return { ok: false, reason: 'image' };
  if (src.includes(']:')) return { ok: false, reason: 'reference definition' };
  if (src.includes('&#')) return { ok: false, reason: 'numeric character reference' };
  // every "](" opens an https link whose URL runs to ")" with no space, quote or bracket; the first bad character ends the scan (linear)
  for (let i = src.indexOf(']('); i !== -1; i = src.indexOf('](', i + 2)) {
    const start = i + 2;
    if (!src.startsWith('https://', start)) return { ok: false, reason: 'link not https' };
    let j = start + 8;
    while (j < src.length && URL_CHAR.test(src[j]!)) j++;
    if (j === start + 8 || src[j] !== ')') return { ok: false, reason: 'bad link' };
    i = j - 1;
  }
  return { ok: true };
}

// text nodes: besides the HTML specials, ":" and "=" are escaped so no "javascript:" / "onx=" shape survives even as visible text
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', ':': '&#58;', '=': '&#61;' };
const esc = (s: string): string => s.replace(/[&<>"':=]/g, (c) => ESC[c]!);
const escAttr = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, '$1<em>$2</em>');
}

const LINK = /\[([^[\]\n]{0,1000})\]\(([^()\s]{0,2048})\)/g;
function inline(line: string): string {
  let out = ''; let last = 0;
  for (const m of line.matchAll(LINK)) {
    out += emphasis(esc(line.slice(last, m.index)));
    const [, text, url] = m as unknown as [string, string, string];
    out += SAFE_URL.test(url) ? `<a href="${escAttr(url)}" rel="noopener noreferrer" target="_blank">${esc(text)}</a>` : esc(m[0]);
    last = m.index! + m[0].length;
  }
  return out + emphasis(esc(line.slice(last)));
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const BULLET = /^[ \t]{0,3}[-*+][ \t]+(.*)$/;
const ORDERED = /^[ \t]{0,3}[0-9]{1,9}[.)][ \t]+(.*)$/;

/** Read side: stored text -> whitelisted HTML (h1-6, p, strong, em, ul, ol, li, a[href https, rel, target], br). Anything else is escaped text. Throws over the limit. */
export function renderMarkdown(src: string): string {
  if (typeof src !== 'string') return '';
  if (src.length > MARKDOWN_MAX_CHARS) throw new Error('markdown body over the limit');
  const lines = src.replace(CONTROL_G, '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = []; let para: string[] = []; let list: 'ul' | 'ol' | undefined;
  const flushPara = () => { if (para.length) out.push(`<p>${para.join('<br>')}</p>`); para = []; };
  const closeList = () => { if (list) out.push(`</${list}>`); list = undefined; };
  for (const line of lines) {
    if (line.trim() === '') { flushPara(); closeList(); continue; }
    const h = HEADING.exec(line);
    if (h) { flushPara(); closeList(); out.push(`<h${h[1]!.length}>${inline(h[2]!.trim())}</h${h[1]!.length}>`); continue; }
    const b = BULLET.exec(line); const o = b ? null : ORDERED.exec(line);
    if (b || o) {
      flushPara(); const want = b ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((b ?? o)![1]!.trim())}</li>`); continue;
    }
    closeList(); para.push(inline(line.trim()));
  }
  flushPara(); closeList();
  return out.join('\n');
}
