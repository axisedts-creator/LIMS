// Shared test tooling for the font tests (T0D-UI-R02, T0D-MSERIES-1): minimal sfnt / woff2 readers (cmap, OS/2, head, hhea, hmtx)
// and a fonts.css reader. Not a test file. Nothing is mocked: the real font files are parsed.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { expect } from 'vitest';

export const FONTS = fileURLToPath(new URL('..', import.meta.url)); // packages/ui/assets/fonts
export const UI = resolve(FONTS, '..', '..'); // packages/ui
export const ROOT = resolve(UI, '..', '..');
export const WEIGHTS = [400, 500, 600, 700];
export const read = (p: string) => readFileSync(p, 'utf8');

export const SAMPLE_LATIN = 'Lab 123 Hb';
export const SAMPLE_DEVA = 'नेपाल रक्त परीक्षण ०१२३४५६७८९ ।'; // Nepali words, Devanagari digits and danda

export type Tables = Map<string, Buffer>;

export const sfntTables = (b: Buffer): Tables => {
  const n = b.readUInt16BE(4);
  const out: Tables = new Map();
  for (let i = 0; i < n; i++) {
    const r = 12 + 16 * i;
    out.set(b.toString('latin1', r, r + 4), b.subarray(b.readUInt32BE(r + 8), b.readUInt32BE(r + 8) + b.readUInt32BE(r + 12)));
  }
  return out;
};

const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep'];
export const woff2Tables = (b: Buffer): Tables & { transformed?: Set<string> } => {
  expect(b.toString('latin1', 0, 4)).toBe('wOF2');
  const n = b.readUInt16BE(12);
  const compressed = b.readUInt32BE(20);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const c = b[p++]!;
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new Error('bad UIntBase128');
  };
  const dir: { tag: string; len: number; transformed: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const flags = b[p++]!;
    const idx = flags & 0x3f;
    const tag = idx === 63 ? b.toString('latin1', p, (p += 4)) : (KNOWN[idx] ?? `#${idx}`);
    const orig = base128();
    const version = flags >> 6;
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    dir.push({ tag, len: transformed ? base128() : orig, transformed });
  }
  const data = brotliDecompressSync(b.subarray(p, p + compressed));
  const out: Tables & { transformed?: Set<string> } = new Map();
  out.transformed = new Set(dir.filter((d) => d.transformed).map((d) => d.tag));
  let o = 0;
  for (const d of dir) {
    out.set(d.tag, data.subarray(o, o + d.len));
    o += d.len;
  }
  return out;
};

/** returns gid(codepoint) from the best Unicode cmap subtable (format 4 or 12); 0 = not in the font. */
export const cmapLookup = (cmap: Buffer): ((cp: number) => number) => {
  const n = cmap.readUInt16BE(2);
  const subs: { off: number; fmt: number }[] = [];
  for (let i = 0; i < n; i++) {
    const plat = cmap.readUInt16BE(4 + 8 * i);
    const enc = cmap.readUInt16BE(6 + 8 * i);
    const off = cmap.readUInt32BE(8 + 8 * i);
    const fmt = cmap.readUInt16BE(off);
    const unicode = plat === 0 || (plat === 3 && (enc === 1 || enc === 10));
    if (unicode && (fmt === 4 || fmt === 12)) subs.push({ off, fmt });
  }
  expect(subs.length, 'no unicode cmap subtable (format 4/12)').toBeGreaterThan(0);
  const fns = subs.map(({ off, fmt }) => {
    if (fmt === 12) {
      const groups = cmap.readUInt32BE(off + 12);
      return (cp: number) => {
        for (let g = 0; g < groups; g++) {
          const r = off + 16 + 12 * g;
          const lo = cmap.readUInt32BE(r);
          if (cp >= lo && cp <= cmap.readUInt32BE(r + 4)) return cmap.readUInt32BE(r + 8) + (cp - lo);
        }
        return 0;
      };
    }
    const segs = cmap.readUInt16BE(off + 6) / 2;
    const end = off + 14;
    const start = end + 2 * segs + 2;
    const delta = start + 2 * segs;
    const range = delta + 2 * segs;
    return (cp: number) => {
      if (cp > 0xffff) return 0;
      for (let s = 0; s < segs; s++) {
        if (cp > cmap.readUInt16BE(end + 2 * s)) continue;
        const st = cmap.readUInt16BE(start + 2 * s);
        if (cp < st) return 0;
        const ro = cmap.readUInt16BE(range + 2 * s);
        const d = cmap.readUInt16BE(delta + 2 * s);
        if (ro === 0) return (cp + d) & 0xffff;
        const gid = cmap.readUInt16BE(range + 2 * s + ro + 2 * (cp - st));
        return gid === 0 ? 0 : (gid + d) & 0xffff;
      }
      return 0;
    };
  });
  return (cp) => fns.map((f) => f(cp)).find((g) => g !== 0) ?? 0;
};

export const fontOf = (path: string) => {
  const buf = readFileSync(path);
  const woff2 = buf.toString('latin1', 0, 4) === 'wOF2';
  const t = woff2 ? woff2Tables(buf) : sfntTables(buf);
  expect(t.has('cmap'), `${path}: cmap table`).toBe(true);
  const gid = cmapLookup(t.get('cmap')!);
  return {
    buf,
    gid,
    covers: (cp: number) => gid(cp) !== 0,
    weight: t.get('OS/2')!.readUInt16BE(4),
    /** advance width of a codepoint in em (hmtx / unitsPerEm). */
    advance: (cp: number) => {
      expect((t as { transformed?: Set<string> }).transformed?.has('hmtx') ?? false, `${path}: hmtx is woff2-transformed; reader does not support it`).toBe(false);
      const g = gid(cp);
      const hhea = t.get('hhea')!;
      const hmtx = t.get('hmtx')!;
      const upm = t.get('head')!.readUInt16BE(18);
      const metrics = hhea.readUInt16BE(34);
      return hmtx.readUInt16BE(4 * Math.min(g, metrics - 1)) / upm;
    },
  };
};

// ---------- fonts.css ----------
export const css = () => read(join(FONTS, 'fonts.css'));
export type Face = { family: string; weight: number; style: string; display: string; urls: string[]; formats: string[]; range: string | null; file: string };
export const faces = (): Face[] =>
  [...css().replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => {
    const body = m[1]!;
    const get = (p: string) => new RegExp(`${p}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1]?.trim() ?? '';
    const urls = [...body.matchAll(/url\(\s*['"]?([^'")]+)/g)].map((u) => u[1]!);
    return {
      family: get('font-family').replace(/['"]/g, ''),
      weight: Number(get('font-weight')),
      style: get('font-style'),
      display: get('font-display'),
      urls,
      formats: [...body.matchAll(/format\(\s*['"]?([^'")]+)/g)].map((f) => f[1]!),
      range: /unicode-range\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim() ?? null,
      file: urls[0] ? resolve(FONTS, urls[0]) : '',
    };
  });
export const faceFor = (family: string, weight: number) => faces().find((f) => f.family === family && f.weight === weight);
