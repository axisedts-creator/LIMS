// AUTH-MFA-QR-1 (LD-214, founder yes 2026-11-15 15:04 NPT; AUTH-SENSITIVE LD-189; E1: the QR carries the TOTP secret, so it is never logged, stored or echoed).
// GoTrue's totp.qr_code -> the `qr_svg_base64` of contracts/openapi/identity.yaml MfaEnrolmentStart (base64 of the SVG, no data: prefix, maxLength 20000).
// Tolerant in what it accepts (data URI image/svg+xml or img/svg+xml, ;utf-8 / ;charset params, ;base64 or percent-encoded or raw text, or a bare SVG);
// strict in what it returns; anything doubtful -> undefined, never sanitised. Pure; never throws.
// AUTH-MFA-COMPLETE-1 (LD-221 item 6): a PROLOG before <svg> (XML declaration, comments, a DOCTYPE WITHOUT an internal subset) is accepted and STRIPPED, so the
// output is the clean <svg> only; every UNSAFE check stays on the remaining body. qrOmitReason() gives ONE reason code (never any content) for the warn log.
// AUTH-MFA-QR-2 (LD-247): GoTrue's real QR is ONE <rect> per dark module (~1500, well over 100000 characters). An SVG with dark rects is re-drawn as ONE compact path
// built ONLY from the parsed modules (nothing of the input is copied); anything it cannot read exactly -> 'unsupported_qr' (omitted, never guessed). UNSAFE runs on input AND output.
const MAX_OUT = 20000;        // contract maxLength
const MAX_IN = 1_000_000;     // decoded SVG text (a real 57x57 QR is ~135000 chars; 10000 rects ~650000)
const MAX_RAW = 3 * MAX_IN;   // cheap guard before any decoding: percent-encoding makes the transport up to ~1.8x larger, base64 1.33x
const MAX_RECTS = 10_000;
const QUIET = 4;              // quiet zone, in modules
const DATA_URI = /^data:\s*(?:image|img)\/svg\+xml((?:;[^;,]*)*),/i;
const SVG_ROOT = /^<svg[\s/>]/i;
const SVG_END = /(?:<\/svg\s*>|\/>)\s*$/i;
const XML_DECL = /^<\?xml(?:\s[^>]*)?\?>/;   // not <?xml-stylesheet ... ?> or any other processing instruction
const Q = `(?:"[^"]*"|'[^']*')`;
const DOCTYPE = new RegExp(`^<!doctype\\s+[\\w:.-]+(?:\\s+(?:public\\s+${Q}(?:\\s+${Q})?|system\\s+${Q}))?\\s*>`, 'i');   // a "[" (internal subset) never matches
const UNSAFE: RegExp[] = [
  /<\s*(?:script|foreignobject|iframe|object|embed)/i,
  /<!\s*(?:doctype|entity)/i,
  /\bon[a-z]+\s*=/i,
  /javascript\s*:/i,
  /href\s*=\s*["']?\s*(?:https?:|\/\/|data:)/i,
  /url\(\s*["']?\s*(?:https?:|\/\/|data:)/i,
];

export type QrOmitReason = 'not_string' | 'empty' | 'too_long' | 'bad_data_uri' | 'bad_base64' | 'no_svg_root' | 'unsafe_content' | 'too_large' | 'unsupported_qr';

/** drop leading whitespace, XML declarations, comments and plain DOCTYPEs (any order); an unterminated or unknown construct stays and fails the root check */
function stripProlog(s: string): string {
  let r = s;
  for (;;) {
    const t = r.trimStart();
    if (t.startsWith('<!--')) { const e = t.indexOf('-->', 4); if (e < 0) return t; r = t.slice(e + 3); continue; }
    const m = XML_DECL.exec(t) ?? DOCTYPE.exec(t);
    if (!m) return t;
    r = t.slice(m[0].length);
  }
}

const ATTR = /\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** attributes of ONE start tag; undefined when anything is not a quoted name="value" pair or a name repeats */
function attrsOf(tag: string): Map<string, string> | undefined {
  const m = new Map<string, string>();
  for (const a of tag.matchAll(ATTR)) { if (m.has(a[1]!)) return undefined; m.set(a[1]!, a[2] ?? a[3] ?? ''); }
  return tag.replace(/^<[\w:-]+/, '').replace(ATTR, '').replace(/[\s/>]/g, '') === '' ? m : undefined;
}
const UINT = /^\d{1,9}$/;
const BLACK = /^(?:black|#000|#000000)$/i, WHITE = /^(?:white|#fff|#ffffff)$/i;
/** the fill of a rect style: exactly one `fill:` plus an optional `stroke:none` (goqrsvg writes "fill:black;stroke:none"); anything else -> undefined */
function styleFill(st: string): string | undefined {
  let fill: string | undefined, stroke = false;
  for (const part of st.split(';').map((p) => p.trim()).filter(Boolean)) {
    const m = /^([\w-]+)\s*:\s*(.*)$/.exec(part);
    if (!m) return undefined;
    const k = m[1]!.toLowerCase(), v = m[2]!.trim();
    if (k === 'fill' && fill === undefined && v !== '') fill = v;
    else if (k === 'stroke' && !stroke && v.toLowerCase() === 'none') stroke = true;
    else return undefined;
  }
  return fill;
}
const RECT_KEYS = ['x', 'y', 'width', 'height', 'fill', 'style'];
/** null = no dark rect (nothing to compact: pass through as today); string = the compact svg; 'unsupported_qr' = refused */
function compact(svg: string): string | null | 'unsupported_qr' {
  const body = svg.replace(/<!--[\s\S]*?-->/g, '');
  const tags = body.match(/<rect(?=[\s/>])[^>]*>/gi);
  if (!tags) return null;
  if (tags.length > MAX_RECTS) return 'unsupported_qr';
  const dark: Array<[number, number, number, number]> = [];
  let doubt = false;
  for (const t of tags) {
    const a = attrsOf(t);
    if (!a) return 'unsupported_qr';
    const st = a.get('style'), sf = st === undefined ? undefined : styleFill(st);
    if (st !== undefined && sf === undefined) return 'unsupported_qr';
    const fa = a.get('fill');
    if (fa !== undefined && sf !== undefined && fa.trim().toLowerCase() !== sf.toLowerCase()) return 'unsupported_qr';
    const fill = (fa ?? sf ?? '').trim();
    if (WHITE.test(fill)) continue;   // background: ignored (ponytail: a white rect drawn over a dark module is not modelled)
    if (fill === '') { doubt = true; continue; }   // no fill at all: refused below only if dark rects exist (a rect-only svg like <rect width=1 height=1/> passes through as before)
    if (!BLACK.test(fill)) return 'unsupported_qr';
    if ([...a.keys()].some((k) => !RECT_KEYS.includes(k))) return 'unsupported_qr';
    const g = ['x', 'y', 'width', 'height'].map((k) => a.get(k));
    if (!g.every((v) => v !== undefined && UINT.test(v))) return 'unsupported_qr';
    dark.push(g.map(Number) as [number, number, number, number]);
  }
  if (dark.length === 0) return null;
  if (doubt) return 'unsupported_qr';
  const root = attrsOf(/^<svg[^>]*>/i.exec(body.trimStart())?.[0] ?? '');
  const vb = root?.get('viewBox')?.trim().split(/[\s,]+/);
  const W = Number(root?.get('width') ?? vb?.[2]), H = Number(root?.get('height') ?? vb?.[3]);
  if (!root || !Number.isInteger(W) || !Number.isInteger(H) || W <= 0 || H <= 0 || W > 1e6 || H > 1e6) return 'unsupported_qr';
  if (vb && vb.join(' ') !== `0 0 ${W} ${H}`) return 'unsupported_qr';
  if ((body.match(/<\/?[a-z][\w:.-]*/gi) ?? []).some((n) => !/^<\/?(?:svg|rect|title|desc)$/i.test(n))) return 'unsupported_qr';
  const s = dark[0]![2];
  const rows = new Map<number, number[]>();
  let c0 = Infinity, c1 = -1, r0 = Infinity, r1 = -1;
  for (const [x, y, w, h] of dark) {
    if (w !== s || h !== s || s < 1 || x % s || y % s || x + w > W || y + h > H) return 'unsupported_qr';
    const c = x / s, r = y / s;
    (rows.get(r) ?? rows.set(r, []).get(r)!).push(c);
    c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r);
  }
  const side = Math.max(c1 - c0, r1 - r0) + 1 + 2 * QUIET;
  let d = '';
  for (const [r, cs] of rows) {   // horizontal runs of dark modules merged; row.5 = the stroke's centre line
    cs.sort((p, q) => p - q);
    for (let i = 0; i < cs.length;) {
      let j = i; while (j + 1 < cs.length && cs[j + 1]! <= cs[j]! + 1) j++;
      d += `M${cs[i]! - c0 + QUIET} ${r - r0 + QUIET}.5h${cs[j]! - cs[i]! + 1}`;
      i = j + 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#fff"/><path d="${d}" stroke="#000" stroke-width="1" fill="none"/></svg>`;
}

function analyse(input: unknown): { out: string } | { reason: QrOmitReason } {
  if (typeof input !== 'string') return { reason: 'not_string' };
  if (input.trim().length === 0) return { reason: 'empty' };
  if (input.length > MAX_RAW) return { reason: 'too_long' };
  let svg: string;
  if (/^\s*data:/i.test(input)) {
    const m = DATA_URI.exec(input.trimStart());
    if (!m) return { reason: 'bad_data_uri' };
    const body = input.trimStart().slice(m[0].length);
    if (/;\s*base64\s*$/i.test(m[1] ?? '') || /;\s*base64\s*;/i.test(m[1] ?? '')) {
      const t = body.replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t) || t.length % 4 !== 0) return { reason: 'bad_base64' };
      svg = Buffer.from(t, 'base64').toString('utf8');
    } else {
      try { svg = decodeURIComponent(body); } catch { svg = body; }   // a literal % in raw SVG (width="100%") is not an error
    }
  } else svg = input;
  if (svg.length > MAX_IN) return { reason: 'too_long' };
  svg = stripProlog(svg);
  if (!SVG_ROOT.test(svg) || !SVG_END.test(svg)) return { reason: 'no_svg_root' };
  if (UNSAFE.some((re) => re.test(svg))) return { reason: 'unsafe_content' };
  const c = compact(svg);
  if (c === 'unsupported_qr') return { reason: c };
  if (c !== null) { svg = c; if (UNSAFE.some((re) => re.test(svg))) return { reason: 'unsafe_content' }; }
  const out = Buffer.from(svg, 'utf8').toString('base64');
  return out.length > MAX_OUT ? { reason: 'too_large' } : { out };
}

/** undefined when the QR is usable, else ONE reason code (never any part of the input). */
export function qrOmitReason(input: unknown): QrOmitReason | undefined {
  try { const r = analyse(input); return 'reason' in r ? r.reason : undefined; } catch { return 'no_svg_root'; }
}

export function qrSvgToBase64(input: unknown): string | undefined {
  try { const r = analyse(input); return 'out' in r ? r.out : undefined; } catch { return undefined; }
}
