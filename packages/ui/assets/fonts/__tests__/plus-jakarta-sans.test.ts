// T0D-UI-R02 (LD-140, CR-UI-R-001; 10-DESIGN-SYSTEM s2.2): Plus Jakarta Sans 400/500/600/700 latin, self-hosted from
// @fontsource/plus-jakarta-sans 5.3.0 (exact pin), Noto Sans Devanagari as fallback in the same stack, no font CDN,
// Flutter TTFs of the same weights made by packages/ui-flutter/tool/woff2ttf.py and declared in pubspec, OFL files present.
// Node env. The font files are parsed for real (WOFF2 -> cmap, TTF -> cmap/OS/2), nothing is mocked.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const FONTS = fileURLToPath(new URL('..', import.meta.url)); // packages/ui/assets/fonts
const UI = resolve(FONTS, '..', '..'); // packages/ui
const ROOT = resolve(UI, '..', '..');
const FLUTTER = join(ROOT, 'packages', 'ui-flutter');
const WEIGHTS = [400, 500, 600, 700];
const read = (p: string) => readFileSync(p, 'utf8');

// ---------- minimal sfnt / woff2 readers (cmap + OS/2 only) ----------
type Tables = Map<string, Buffer>;

const sfntTables = (b: Buffer): Tables => {
  const n = b.readUInt16BE(4);
  const out: Tables = new Map();
  for (let i = 0; i < n; i++) {
    const r = 12 + 16 * i;
    out.set(b.toString('latin1', r, r + 4), b.subarray(b.readUInt32BE(r + 8), b.readUInt32BE(r + 8) + b.readUInt32BE(r + 12)));
  }
  return out;
};

const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep'];
const woff2Tables = (b: Buffer): Tables => {
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
  const dir: { tag: string; len: number }[] = [];
  for (let i = 0; i < n; i++) {
    const flags = b[p++]!;
    const idx = flags & 0x3f;
    const tag = idx === 63 ? b.toString('latin1', p, (p += 4)) : (KNOWN[idx] ?? `#${idx}`);
    const orig = base128();
    const version = flags >> 6;
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    dir.push({ tag, len: transformed ? base128() : orig });
  }
  const data = brotliDecompressSync(b.subarray(p, p + compressed));
  const out: Tables = new Map();
  let o = 0;
  for (const d of dir) {
    out.set(d.tag, data.subarray(o, o + d.len));
    o += d.len;
  }
  return out;
};

/** returns covers(codepoint) from the best Unicode cmap subtable (format 4 or 12). */
const cmapCovers = (cmap: Buffer): ((cp: number) => boolean) => {
  const n = cmap.readUInt16BE(2);
  const subs: { off: number; fmt: number; rank: number }[] = [];
  for (let i = 0; i < n; i++) {
    const plat = cmap.readUInt16BE(4 + 8 * i);
    const enc = cmap.readUInt16BE(6 + 8 * i);
    const off = cmap.readUInt32BE(8 + 8 * i);
    const fmt = cmap.readUInt16BE(off);
    const unicode = plat === 0 || (plat === 3 && (enc === 1 || enc === 10));
    if (unicode && (fmt === 4 || fmt === 12)) subs.push({ off, fmt, rank: fmt === 12 ? 2 : 1 });
  }
  expect(subs.length, 'no unicode cmap subtable (format 4/12)').toBeGreaterThan(0);
  const fns = subs.map(({ off, fmt }) => {
    if (fmt === 12) {
      const groups = cmap.readUInt32BE(off + 12);
      return (cp: number) => {
        for (let g = 0; g < groups; g++) {
          const r = off + 16 + 12 * g;
          if (cp >= cmap.readUInt32BE(r) && cp <= cmap.readUInt32BE(r + 4)) return true;
        }
        return false;
      };
    }
    const segs = cmap.readUInt16BE(off + 6) / 2;
    const end = off + 14;
    const start = end + 2 * segs + 2;
    const delta = start + 2 * segs;
    const range = delta + 2 * segs;
    return (cp: number) => {
      if (cp > 0xffff) return false;
      for (let s = 0; s < segs; s++) {
        if (cp > cmap.readUInt16BE(end + 2 * s)) continue;
        const st = cmap.readUInt16BE(start + 2 * s);
        if (cp < st) return false;
        const ro = cmap.readUInt16BE(range + 2 * s);
        const d = cmap.readUInt16BE(delta + 2 * s);
        if (ro === 0) return ((cp + d) & 0xffff) !== 0;
        const gid = cmap.readUInt16BE(range + 2 * s + ro + 2 * (cp - st));
        return gid !== 0 && ((gid + d) & 0xffff) !== 0;
      }
      return false;
    };
  });
  return (cp) => fns.some((f) => f(cp));
};

const weightClass = (t: Tables) => t.get('OS/2')!.readUInt16BE(4);
const fontOf = (path: string) => {
  const buf = readFileSync(path);
  const t = buf.toString('latin1', 0, 4) === 'wOF2' ? woff2Tables(buf) : sfntTables(buf);
  expect(t.has('cmap'), `${path}: cmap table`).toBe(true);
  return { buf, covers: cmapCovers(t.get('cmap')!), weight: weightClass(t) };
};

// ---------- fonts.css ----------
const css = () => read(join(FONTS, 'fonts.css'));
type Face = { family: string; weight: number; style: string; display: string; urls: string[]; formats: string[]; range: string | null; file: string };
const faces = (): Face[] =>
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
const faceFor = (family: string, weight: number) => faces().find((f) => f.family === family && f.weight === weight);

const SAMPLE_LATIN = 'Lab 123 Hb'; // latin text, digits, space
const SAMPLE_DEVA = 'नेपाल रक्त परीक्षण ०१२३४५६७८९ ।'; // Nepali words, Devanagari digits and danda

// ---------- tests ----------
describe('T0D-UI-R02 web: dependency pin (CR-UI-R-001)', () => {
  const pkg = JSON.parse(read(join(UI, 'package.json')));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  it('@lims/ui pins @fontsource/plus-jakarta-sans to exactly 5.3.0 (no ^ ~ range)', () => {
    expect(all['@fontsource/plus-jakarta-sans']).toBe('5.3.0');
  });
  it('pnpm-lock.yaml resolves it to 5.3.0 only, with an integrity hash, in the packages/ui importer', () => {
    const lock = read(join(ROOT, 'pnpm-lock.yaml'));
    expect(lock).toMatch(/'@fontsource\/plus-jakarta-sans':\s*\n\s+specifier: 5\.3\.0\s*\n\s+version: 5\.3\.0/);
    expect(lock).toMatch(/'@fontsource\/plus-jakarta-sans@5\.3\.0':\s*\n\s+resolution: \{integrity: sha512-/);
    expect(lock).not.toMatch(/plus-jakarta-sans@(?!5\.3\.0)/);
  });
  it('the Noto Devanagari / Mono pins stay (fallback and mono are still bundled)', () => {
    expect(all['@fontsource/noto-sans-devanagari']).toBe('5.3.0');
    expect(all['@fontsource/noto-sans-mono']).toBe('5.3.0');
  });
});

describe('T0D-UI-R02 web: fonts.css declares Plus Jakarta Sans 400/500/600/700 latin, self-hosted woff2', () => {
  it('has a normal-style @font-face for every weight 400, 500, 600, 700 with font-display: swap', () => {
    for (const w of WEIGHTS) {
      const f = faceFor('Plus Jakarta Sans', w);
      expect(f, `Plus Jakarta Sans ${w} @font-face`).toBeTruthy();
      expect(f!.style).toBe('normal');
      expect(f!.display).toBe('swap');
    }
  });
  it('each face points at its own existing woff2 file in assets/fonts (valid wOF2, not a stub)', () => {
    const files = new Set<string>();
    for (const w of WEIGHTS) {
      const f = faceFor('Plus Jakarta Sans', w)!;
      expect(f.urls, `weight ${w}: one url()`).toHaveLength(1);
      expect(f.urls[0], `weight ${w}`).toMatch(/^\.\/[\w.-]+\.woff2$/);
      expect(f.formats).toEqual(['woff2']);
      expect(existsSync(f.file), `${f.urls[0]} exists`).toBe(true);
      const b = readFileSync(f.file);
      expect(b.toString('latin1', 0, 4)).toBe('wOF2');
      expect(b.length).toBeGreaterThan(5000);
      files.add(createHash('sha256').update(b).digest('hex'));
    }
    expect(files.size, 'four different weight files').toBe(4);
  });
  it('the weight in each file (OS/2 usWeightClass) matches the weight fonts.css declares for it', () => {
    for (const w of WEIGHTS) expect(fontOf(faceFor('Plus Jakarta Sans', w)!.file).weight, `weight ${w}`).toBe(w);
  });
  it('keeps the Noto Sans Devanagari 400/500/600/700 and Noto Sans Mono 400 faces (fallback and mono stay)', () => {
    for (const w of WEIGHTS) {
      const f = faceFor('Noto Sans Devanagari', w);
      expect(f, `Noto Sans Devanagari ${w}`).toBeTruthy();
      expect(existsSync(f!.file)).toBe(true);
    }
    expect(existsSync(faceFor('Noto Sans Mono', 400)?.file ?? '')).toBe(true);
  });
  it('no Plus Jakarta Sans face declares a unicode-range that reaches Devanagari (U+0900-097F)', () => {
    for (const f of faces().filter((x) => x.family === 'Plus Jakarta Sans')) {
      for (const m of (f.range ?? '').matchAll(/U\+([0-9A-F]+)(?:-([0-9A-F]+))?/gi)) {
        const lo = parseInt(m[1]!, 16);
        const hi = m[2] ? parseInt(m[2], 16) : lo;
        expect(lo <= 0x097f && hi >= 0x0900, `range ${m[0]}`).toBe(false);
      }
    }
  });
});

describe('T0D-UI-R02 parser self-check (guards the test tooling, runs on the already-bundled Noto Sans latin woff2)', () => {
  it('reads cmap + OS/2 of a real woff2: covers A/z/7, not Devanagari, weight 400', () => {
    const f = fontOf(join(FONTS, 'noto-sans-latin-400-normal.woff2'));
    expect([f.covers(0x41), f.covers(0x7a), f.covers(0x37), f.covers(0x0928)]).toEqual([true, true, true, false]);
    expect(f.weight).toBe(400);
  });
});

describe('T0D-UI-R02 web: Devanagari falls back correctly (10-DESIGN-SYSTEM s2.2: order matters)', () => {
  const stack = /--lims-font-family-sans:\s*([^;]+);/.exec(read(join(UI, 'dist', 'tokens.css')))?.[1] ?? '';
  const families = stack.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
  it('font.family.sans is exactly "Plus Jakarta Sans", "Noto Sans Devanagari", system-ui, sans-serif', () => {
    expect(families).toEqual(['Plus Jakarta Sans', 'Noto Sans Devanagari', 'system-ui', 'sans-serif']);
  });
  it('Plus Jakarta Sans woff2 (all 4 weights) has no Devanagari glyphs but covers Latin and digits', () => {
    for (const w of WEIGHTS) {
      const { covers } = fontOf(faceFor('Plus Jakarta Sans', w)!.file);
      for (const ch of SAMPLE_LATIN.replace(/ /g, '')) expect(covers(ch.codePointAt(0)!), `${w} ${ch}`).toBe(true);
      for (const ch of SAMPLE_DEVA.replace(/ /g, '')) expect(covers(ch.codePointAt(0)!), `${w} U+${ch.codePointAt(0)!.toString(16)} must NOT be in Plus Jakarta`).toBe(false);
    }
  });
  it('Noto Sans Devanagari woff2 (all 4 weights) covers every Devanagari sample character', () => {
    for (const w of WEIGHTS) {
      const { covers } = fontOf(faceFor('Noto Sans Devanagari', w)!.file);
      for (const ch of SAMPLE_DEVA.replace(/ /g, '')) expect(covers(ch.codePointAt(0)!), `${w} U+${ch.codePointAt(0)!.toString(16)}`).toBe(true);
    }
  });
  it('walking the stack per character: Latin -> Plus Jakarta Sans, Devanagari -> Noto Sans Devanagari, never system-ui', () => {
    for (const w of WEIGHTS) {
      const cover = new Map(families.slice(0, 2).map((fam) => [fam, fontOf(faceFor(fam, w)!.file).covers]));
      const pick = (cp: number) => families.find((fam) => cover.get(fam)?.(cp)) ?? families[families.length - 1];
      for (const ch of SAMPLE_LATIN.replace(/ /g, '')) expect(pick(ch.codePointAt(0)!), `${w} ${ch}`).toBe('Plus Jakarta Sans');
      for (const ch of SAMPLE_DEVA.replace(/ /g, '')) expect(pick(ch.codePointAt(0)!), `${w} U+${ch.codePointAt(0)!.toString(16)}`).toBe('Noto Sans Devanagari');
    }
  });
});

describe('T0D-UI-R02 CSP / no-egress: fonts load from self only (REQ-SEC-141, REQ-SEC-089, AC-0D-8.7)', () => {
  const walk = (d: string): string[] =>
    existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === '.next' || e.name === '__tests__' ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : [];
  const FOREIGN = /fonts\.(googleapis|gstatic|bunny)\.|use\.typekit|use\.fontawesome|cdn\.jsdelivr|unpkg\.com|cdnjs|next\/font\/google|@import\s+url|@import\s+['"]https?:/i;
  it('fonts.css: every src url() is ./relative (no scheme, no //host), no @import, no absolute URL anywhere', () => {
    const src = css().replace(/\/\*[\s\S]*?\*\//g, '');
    expect(faces().length).toBeGreaterThanOrEqual(9);
    for (const f of faces()) for (const u of f.urls) expect(u, f.family).toMatch(/^\.\/[\w.-]+\.woff2$/);
    expect(src).not.toMatch(/@import|https?:|\/\/[\w.-]+\.\w/i);
  });
  it('no font CDN or next/font/google in packages/ui, apps/web or apps/portal source, css or config', () => {
    const files = [UI, join(ROOT, 'apps', 'web'), join(ROOT, 'apps', 'portal')]
      .flatMap((d) => walk(d))
      .filter((f) => /\.(css|ts|tsx|mjs|js|json)$/.test(f) && !/[\\/](dist|\.turbo|coverage|\.next)[\\/]/.test(f) && !/package(-lock)?\.json$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => FOREIGN.test(read(f)))).toEqual([]);
  });
  it('both apps still import the bundled @lims/ui/fonts.css', () => {
    for (const app of ['web', 'portal']) expect(read(join(ROOT, 'apps', app, 'src', 'app', 'layout.tsx'))).toContain("@lims/ui/fonts.css");
  });
  it("both middleware CSPs keep font-src 'self' (no remote font origin, no data:)", () => {
    for (const app of ['web', 'portal']) {
      const m = /font-src ([^"'`;]*(?:'self')[^"`;]*)/.exec(read(join(ROOT, 'apps', app, 'src', 'middleware.ts')));
      expect(m, `${app} font-src`).toBeTruthy();
      expect(m![1]!.trim()).toBe("'self'");
    }
  });
});

describe('T0D-UI-R02 licences: SIL OFL files present next to the fonts', () => {
  for (const [name, dir] of [
    ['packages/ui/assets/fonts', FONTS],
    ['packages/ui-flutter/assets/fonts', join(FLUTTER, 'assets', 'fonts')],
  ] as const) {
    it(`${name} has an OFL/LICENSE file that names Plus Jakarta Sans and the SIL Open Font License 1.1`, () => {
      const lic = readdirSync(dir).filter((n) => /OFL|LICEN[CS]E/i.test(n) && !/\.(woff2?|ttf)$/i.test(n));
      expect(lic.length).toBeGreaterThan(0);
      const hit = lic.find((n) => /Plus Jakarta/i.test(read(join(dir, n))) && /SIL OPEN FONT LICENSE Version 1\.1/i.test(read(join(dir, n))));
      expect(hit, `no licence file in ${name} mentions "Plus Jakarta"`).toBeTruthy();
    });
  }
});

// ---------- Flutter ----------
describe('T0D-UI-R02 Flutter: TTFs declared in pubspec (flutter asset declaration)', () => {
  const pubspec = read(join(FLUTTER, 'pubspec.yaml'));
  const lines = pubspec.split(/\r?\n/);
  const familyBlock = (family: string) => {
    const i = lines.findIndex((l) => new RegExp(`^\\s+-\\s+family:\\s*${family}\\s*$`).test(l));
    if (i < 0) return [];
    const indent = lines[i]!.search(/\S/);
    const out: string[] = [];
    for (const l of lines.slice(i + 1)) {
      if (l.trim() && l.search(/\S/) <= indent) break;
      out.push(l);
    }
    return out;
  };
  const declared = (family: string) => {
    const res: { asset: string; weight: number }[] = [];
    for (const l of familyBlock(family)) {
      const a = /-\s*asset:\s*(\S+)/.exec(l);
      if (a) res.push({ asset: a[1]!, weight: 400 });
      const w = /^\s+weight:\s*(\d+)/.exec(l);
      if (w && res.length) res[res.length - 1]!.weight = Number(w[1]);
    }
    return res;
  };
  const jak = declared('Plus Jakarta Sans');

  it('pubspec declares family Plus Jakarta Sans with weights 400, 500, 600, 700, each a .ttf under assets/fonts/', () => {
    expect(jak.map((j) => j.weight).sort()).toEqual(WEIGHTS);
    for (const j of jak) expect(j.asset).toMatch(/^assets\/fonts\/[\w-]+\.ttf$/);
    expect(new Set(jak.map((j) => j.asset)).size).toBe(4);
  });
  it('every declared asset exists and is a TrueType (sfnt) file, not WOFF', () => {
    expect(jak).toHaveLength(4);
    for (const j of jak) {
      const p = join(FLUTTER, j.asset);
      expect(existsSync(p), `${j.asset} exists`).toBe(true);
      const b = readFileSync(p);
      expect(b.length).toBeGreaterThan(5000);
      expect([0x00010000, 0x74727565]).toContain(b.readUInt32BE(0)); // 0x00010000 or 'true'
    }
  });
  it('each TTF weight (OS/2 usWeightClass) matches the weight pubspec declares; latin only, no Devanagari', () => {
    expect(jak).toHaveLength(4);
    for (const j of jak) {
      const f = fontOf(join(FLUTTER, j.asset));
      expect(f.weight, j.asset).toBe(j.weight);
      for (const ch of SAMPLE_LATIN.replace(/ /g, '')) expect(f.covers(ch.codePointAt(0)!), `${j.asset} ${ch}`).toBe(true);
      expect(f.covers(0x0928), `${j.asset} has no U+0928`).toBe(false);
    }
  });
  it('Noto Sans, Noto Sans Devanagari (400/600/700) and Noto Sans Mono stay declared, files present (fallback chain)', () => {
    expect(declared('Noto Sans Devanagari').map((d) => d.weight).sort()).toEqual([400, 600, 700]);
    expect(declared('Noto Sans Mono').length).toBeGreaterThan(0);
    for (const fam of ['Noto Sans', 'Noto Sans Devanagari', 'Noto Sans Mono']) for (const d of declared(fam)) expect(existsSync(join(FLUTTER, d.asset)), d.asset).toBe(true);
    const deva = fontOf(join(FLUTTER, declared('Noto Sans Devanagari')[0]!.asset));
    for (const ch of SAMPLE_DEVA.replace(/ /g, '')) expect(deva.covers(ch.codePointAt(0)!), `U+${ch.codePointAt(0)!.toString(16)}`).toBe(true);
  });
  it('no google_fonts / CDN font in pubspec', () => {
    expect(pubspec).not.toMatch(/google_fonts|fonts\.googleapis|https?:\/\//i);
  });
});

describe('T0D-UI-R02 Flutter: TTFs are exactly what tool/woff2ttf.py makes from the pinned @fontsource woff files', () => {
  const tool = join(FLUTTER, 'tool', 'woff2ttf.py');
  const woffDir = join(UI, 'node_modules', '@fontsource', 'plus-jakarta-sans', 'files');
  it('woff2ttf.py stays stdlib-only', () => {
    const mods = [...read(tool).matchAll(/^(?:import|from)\s+([\w.]+)/gm)].map((m) => m[1]!.split('.')[0]);
    for (const m of mods) expect(['struct', 'sys', 'zlib', 'os', 'argparse', 'pathlib', '__future__']).toContain(m);
  });
  it('for weights 400/500/600/700: python woff2ttf.py <latin woff> -> bytes identical to the committed TTF', () => {
    expect(existsSync(woffDir), `${woffDir} missing: run pnpm install (dep pinned in packages/ui)`).toBe(true);
    const jak = (() => {
      const text = read(join(FLUTTER, 'pubspec.yaml'));
      return [...text.matchAll(/asset:\s*(assets\/fonts\/[\w-]*(?:Jakarta)[\w-]*\.ttf)/gi)].map((m) => m[1]!);
    })();
    expect(jak).toHaveLength(4);
    const tmp = mkdtempSync(join(tmpdir(), 'r02-'));
    try {
      const byWeight = new Map(jak.map((a) => [fontOf(join(FLUTTER, a)).weight, a]));
      for (const w of WEIGHTS) {
        const woff = join(woffDir, `plus-jakarta-sans-latin-${w}-normal.woff`);
        expect(existsSync(woff), `${woff}`).toBe(true);
        const out = join(tmp, `${w}.ttf`);
        const r = spawnSync('python', ['-I', tool, woff, out], { encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        expect(readFileSync(out).equals(readFileSync(join(FLUTTER, byWeight.get(w)!))), `weight ${w} TTF differs from tool output`).toBe(true);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
