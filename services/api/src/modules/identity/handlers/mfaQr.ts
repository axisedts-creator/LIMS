// AUTH-MFA-QR-1 (LD-214, founder yes 2026-11-15 15:04 NPT; AUTH-SENSITIVE LD-189; E1: the QR carries the TOTP secret, so it is never logged, stored or echoed).
// GoTrue's totp.qr_code -> the `qr_svg_base64` of contracts/openapi/identity.yaml MfaEnrolmentStart (base64 of the SVG, no data: prefix, maxLength 20000).
// Tolerant in what it accepts (data URI image/svg+xml or img/svg+xml, ;utf-8 / ;charset params, ;base64 or percent-encoded or raw text, or a bare SVG);
// strict in what it returns; anything doubtful -> undefined, never sanitised. Pure; never throws.
const MAX_OUT = 20000;        // contract maxLength
const MAX_IN = 100_000;       // cheap guard before any decoding (percent-encoded 15000-byte SVG is <= ~45000 chars)
const DATA_URI = /^data:\s*(?:image|img)\/svg\+xml((?:;[^;,]*)*),/i;
const SVG_DOC = /^\s*(?:<\?xml[^>]*\?>\s*)?<svg[\s/>]/i;
const SVG_END = /(?:<\/svg\s*>|\/>)\s*$/i;
const UNSAFE: RegExp[] = [
  /<\s*(?:script|foreignobject|iframe|object|embed)/i,
  /<!\s*(?:doctype|entity)/i,
  /\bon[a-z]+\s*=/i,
  /javascript\s*:/i,
  /href\s*=\s*["']?\s*(?:https?:|\/\/|data:)/i,
  /url\(\s*["']?\s*(?:https?:|\/\/|data:)/i,
];

export function qrSvgToBase64(input: string | undefined): string | undefined {
  try {
    if (typeof input !== 'string' || input.length === 0 || input.length > MAX_IN) return undefined;
    let svg: string;
    if (/^\s*data:/i.test(input)) {
      const m = DATA_URI.exec(input.trimStart());
      if (!m) return undefined;
      const body = input.trimStart().slice(m[0].length);
      if (/;\s*base64\s*$/i.test(m[1] ?? '') || /;\s*base64\s*;/i.test(m[1] ?? '')) {
        const t = body.replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t) || t.length % 4 !== 0) return undefined;
        svg = Buffer.from(t, 'base64').toString('utf8');
      } else {
        try { svg = decodeURIComponent(body); } catch { svg = body; }   // a literal % in raw SVG (width="100%") is not an error
      }
    } else svg = input;
    if (!SVG_DOC.test(svg) || !SVG_END.test(svg) || UNSAFE.some((re) => re.test(svg))) return undefined;
    const out = Buffer.from(svg, 'utf8').toString('base64');
    return out.length > MAX_OUT ? undefined : out;
  } catch { return undefined; }
}
