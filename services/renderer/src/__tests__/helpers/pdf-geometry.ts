// T0B-PRINTCFG-1 test helper (not a test file): where text sits on the page, and which colour / image operators a PDF uses. Built on pdf-text.ts (same Chromium/Skia assumptions: FlateDecode,
// Type0 fonts with /ToUnicode, no object streams). Positions: millimetres from the TOP LEFT of the page (the margin box checks of done_when 3). Skia nests `cm` inside q/Q, so the CTM stack is tracked.
import { inflateSync } from 'node:zlib';
import { decode, hexToBytes, inlineOrRef, litBytes, pageOrder, parseCMap, parseObjects, refs, type CMap, type Obj } from './pdf-text.js';

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const PT_MM = 25.4 / 72;
const nums = (s: string): number[] => s.trim().split(/\s+/).map(Number);

export interface Run { page: number; text: string; xMm: number; yMm: number; sizePt: number }
export function pageSizesMm(pdf: Uint8Array): Array<{ w: number; h: number }> {
  const objs = parseObjects(Buffer.from(pdf));
  return pageOrder(objs).map((n) => { const mb = /\/MediaBox\s*\[([^\]]*)\]/.exec(objs.get(n)!.dict)?.[1] ?? '0 0 595.28 841.89'; const [x0, y0, x1, y1] = nums(mb) as [number, number, number, number]; return { w: (x1 - x0) * PT_MM, h: (y1 - y0) * PT_MM }; });
}

/** Every text show operation with its origin (baseline start) in mm from the top left of its page. */
export function textRuns(pdf: Uint8Array): Run[] {
  const objs = parseObjects(Buffer.from(pdf));
  const sizes = pageSizesMm(pdf);
  const cmaps = new Map<number, CMap | undefined>();
  const fontCMap = (n: number) => {
    if (!cmaps.has(n)) { const tu = refs(/\/ToUnicode\s*(\d+ 0 R)/.exec(objs.get(n)?.dict ?? '')?.[1] ?? '')[0]; const st = tu ? objs.get(tu)?.stream : undefined; cmaps.set(n, st ? parseCMap(st.toString('latin1')) : undefined); }
    return cmaps.get(n);
  };
  const out: Run[] = [];
  pageOrder(objs).forEach((pn, pi) => {
    const page: Obj = objs.get(pn)!;
    const res = inlineOrRef(objs, page.dict, 'Resources');
    const fonts = new Map<string, number>();
    for (const f of inlineOrRef(objs, res, 'Font').matchAll(/\/([^\s/<>\[\]]+)\s+(\d+) 0 R/g)) fonts.set(f[1]!, Number(f[2]));
    const cont = /\/Contents\s*(\[[^\]]*\]|\d+ 0 R)/.exec(page.dict)?.[1] ?? '';
    const content = refs(cont).map((n) => objs.get(n)?.stream?.toString('latin1') ?? '').join('\n');
    const num = '-?(?:\\d+\\.?\\d*|\\.\\d+)';
    const six = `(${num}(?:\\s+${num}){5})`;
    const tok = new RegExp(`${six}\\s+cm\\b|${six}\\s+Tm\\b|(${num})\\s+(${num})\\s+Td\\b|(?<![\\w/])(q|Q)(?![\\w])|/([^\\s/<>\\[\\]()]+)\\s+(${num})\\s+Tf\\b|\\[((?:[^\\]\\\\]|\\\\.)*)\\]\\s*TJ|(<[0-9a-fA-F\\s]*>|\\((?:[^)\\\\]|\\\\.)*\\))\\s*Tj`, 'g');
    let ctm: M = [1, 0, 0, 1, 0, 0]; const stack: M[] = []; let tm: M = [1, 0, 0, 1, 0, 0]; let cur: CMap | undefined; let size = 0;
    const emit = (text: string) => {
      const x = ctm[0] * tm[4] + ctm[2] * tm[5] + ctm[4]; const y = ctm[1] * tm[4] + ctm[3] * tm[5] + ctm[5];
      const sz = Math.abs(tm[3] * ctm[3]) * size || 0;
      out.push({ page: pi + 1, text, xMm: x * PT_MM, yMm: sizes[pi]!.h - y * PT_MM, sizePt: sz });
    };
    for (const t of content.matchAll(tok)) {
      if (t[1] !== undefined) ctm = mul(nums(t[1]) as M, ctm);
      else if (t[2] !== undefined) tm = nums(t[2]) as M;
      else if (t[3] !== undefined) tm = mul([1, 0, 0, 1, Number(t[3]), Number(t[4])], tm);
      else if (t[5] !== undefined) { if (t[5] === 'q') stack.push(ctm); else ctm = stack.pop() ?? ctm; }
      else if (t[6] !== undefined) { const fn = fonts.get(t[6]); cur = fn !== undefined ? fontCMap(fn) : undefined; size = Number(t[7]); }
      else if (t[8] !== undefined) {
        let s = ''; for (const p of t[8].matchAll(/<([0-9a-fA-F\s]*)>|(\((?:[^)\\]|\\.)*\))/g)) s += decode(cur, p[1] !== undefined ? hexToBytes(p[1]) : litBytes(p[2]!));
        if (s) emit(s);
      } else if (t[9] !== undefined) { const s = decode(cur, t[9].startsWith('<') ? hexToBytes(t[9].slice(1, -1)) : litBytes(t[9])); if (s) emit(s); }
    }
  });
  return out;
}

export interface Line { page: number; text: string; xMm: number; yMm: number; sizePt: number }
/** Glyph runs grouped into visual lines (same page, baseline within 0.6 mm), left to right, top to bottom. */
export function textLines(pdf: Uint8Array): Line[] {
  const out: Line[] = [];
  for (const r of textRuns(pdf)) {
    const l = out.find((x) => x.page === r.page && Math.abs(x.yMm - r.yMm) < 0.6);
    if (l) { l.text += r.text; l.xMm = Math.min(l.xMm, r.xMm); l.sizePt = Math.max(l.sizePt, r.sizePt); } else out.push({ ...r });
  }
  return out.sort((a, b) => a.page - b.page || a.yMm - b.yMm).map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }));
}
/** The line of a page that contains `needle`. */
export const lineWith = (pdf: Uint8Array, needle: string, page?: number): Line | undefined => textLines(pdf).find((l) => (page === undefined || l.page === page) && l.text.includes(needle));

/** Every uncompressed 8 bit RGB image XObject has R = G = B in every pixel (a grayscale print). Images that cannot be inspected count as not gray. */
export function allImagesGray(pdf: Uint8Array): boolean {
  for (const o of parseObjects(Buffer.from(pdf)).values()) {
    if (!/\/Subtype\s*\/Image/.test(o.dict) || /\/ImageMask\s+true/.test(o.dict)) continue;
    if (/\/DeviceGray/.test(o.dict)) continue;
    if (!o.stream || !/\/DeviceRGB/.test(o.dict) || /DCTDecode|JPXDecode/.test(o.dict)) return false;
    const px = o.stream;
    for (let i = 0; i + 2 < px.length; i += 3) if (px[i] !== px[i + 1] || px[i + 1] !== px[i + 2]) return false;
  }
  return true;
}

/** The runs of one page whose text contains `needle` (whitespace collapsed). */
export const runsWith = (pdf: Uint8Array, needle: string, page?: number): Run[] =>
  textRuns(pdf).filter((r) => (page === undefined || r.page === page) && r.text.replace(/\s+/g, ' ').includes(needle));

function allStreams(pdf: Uint8Array): string[] {
  const objs = parseObjects(Buffer.from(pdf)); const out: string[] = [];
  for (const o of objs.values()) { if (o.stream && !/\/Subtype\s*\/Image/.test(o.dict) && !/\/FontFile|\/Length1/.test(o.dict)) out.push(o.stream.toString('latin1')); }
  return out;
}
/** Colour setting operators whose operands are not a pure gray (r=g=b, or c=m=y=0 for k). `0 0 0 rg` black and `1 1 1 rg` white are gray. */
export function nonGrayColourOps(pdf: Uint8Array): string[] {
  const found: string[] = []; const num = '-?(?:\\d+\\.?\\d*|\\.\\d+)';
  for (const s of allStreams(pdf)) {
    for (const m of s.matchAll(new RegExp(`(${num})\\s+(${num})\\s+(${num})\\s+(rg|RG)\\b`, 'g'))) { const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]; if (Math.abs(r - g) > 1e-6 || Math.abs(g - b) > 1e-6) found.push(m[0]); }
    for (const m of s.matchAll(new RegExp(`(${num})\\s+(${num})\\s+(${num})\\s+(${num})\\s+(k|K)\\b`, 'g'))) { if (Number(m[1]) !== 0 || Number(m[2]) !== 0 || Number(m[3]) !== 0) found.push(m[0]); }
    for (const m of s.matchAll(new RegExp(`(${num})\\s+(${num})\\s+(${num})\\s+(sc|SC|scn|SCN)\\b`, 'g'))) { const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]; if (Math.abs(r - g) > 1e-6 || Math.abs(g - b) > 1e-6) found.push(m[0]); }
  }
  return found;
}
/** Image XObjects, shadings, soft masks and ICC / colour-space objects that could carry colour. */
export function imageAndShadingObjects(pdf: Uint8Array): string[] {
  const s = Buffer.from(pdf).toString('latin1');
  return [...s.matchAll(/\/Subtype\s*\/Image\b|\/ShadingType\s*\d|\/PatternType\s*\d|\/SMask\b/g)].map((m) => m[0]);
}
/** Draw operations that paint an image: `Do` of an image XObject, pattern fills (`/Pattern cs ... scn`) and shadings (`sh`). Counts draws, not objects (Skia shares one object for equal images). */
export function imageDraws(pdf: Uint8Array): number {
  const objs = parseObjects(Buffer.from(pdf)); let n = 0;
  const isImage = new Set<string>();
  for (const [num, o] of objs) if (/\/Subtype\s*\/Image/.test(o.dict)) isImage.add(String(num));
  for (const o of objs.values()) {
    if (!o.stream || /\/Subtype\s*\/Image|\/FontFile|\/Length1/.test(o.dict)) continue;
    const s = o.stream.toString('latin1');
    n += (s.match(/\/Pattern\s+(?:cs|CS)\b/g) ?? []).length + (s.match(/(?<![\w/])sh(?![\w])/g) ?? []).length;
    for (const m of s.matchAll(/\/([^\s/<>\[\]()]+)\s+Do\b/g)) { const res = objs; void res; n += 1; }
  }
  return n;
}
/** Inflated page content streams (for raw operator assertions). */
export const contentStreams = (pdf: Uint8Array): string[] => allStreams(pdf);
export { inflateSync };
