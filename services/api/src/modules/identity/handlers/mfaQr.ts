// AUTH-MFA-QR-1 (LD-214, founder yes 2026-11-15 15:04 NPT; AUTH-SENSITIVE LD-189; E1: the QR carries the TOTP secret, so it is never logged, stored or echoed).
// GoTrue's totp.qr_code -> the `qr_svg_base64` of contracts/openapi/identity.yaml MfaEnrolmentStart (base64 of the SVG, no data: prefix, maxLength 20000).
// Tolerant in what it accepts (data URI image/svg+xml or img/svg+xml, ;utf-8 / ;charset params, ;base64 or percent-encoded or raw text, or a bare SVG);
// strict in what it returns; anything doubtful -> undefined, never sanitised. Pure; never throws.
// AUTH-MFA-COMPLETE-1 (LD-221 item 6): a PROLOG before <svg> (XML declaration, comments, a DOCTYPE WITHOUT an internal subset) is accepted and STRIPPED, so the
// output is the clean <svg> only; every UNSAFE check stays on the remaining body. qrOmitReason() gives ONE reason code (never any content) for the warn log.
const MAX_OUT = 20000;        // contract maxLength
const MAX_IN = 100_000;       // cheap guard before any decoding (percent-encoded 15000-byte SVG is <= ~45000 chars)
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

export type QrOmitReason = 'not_string' | 'empty' | 'too_long' | 'bad_data_uri' | 'bad_base64' | 'no_svg_root' | 'unsafe_content' | 'too_large';

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

function analyse(input: unknown): { out: string } | { reason: QrOmitReason } {
  if (typeof input !== 'string') return { reason: 'not_string' };
  if (input.trim().length === 0) return { reason: 'empty' };
  if (input.length > MAX_IN) return { reason: 'too_long' };
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
  svg = stripProlog(svg);
  if (!SVG_ROOT.test(svg) || !SVG_END.test(svg)) return { reason: 'no_svg_root' };
  if (UNSAFE.some((re) => re.test(svg))) return { reason: 'unsafe_content' };
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
