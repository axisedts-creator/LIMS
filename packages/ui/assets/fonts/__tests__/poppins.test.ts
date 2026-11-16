// T0D-MSERIES-1 (LD-246, LD-251; spec/program/13-M-SERIES.md s2.2 and s6.2): Poppins 400/500/600/700 latin is self-hosted from
// @fontsource/poppins (OFL-1.1, exact pin), Plus Jakarta Sans is gone from packages/ui/assets/fonts, Noto Sans Devanagari is the
// Devanagari fallback, no CDN, and the .num class gives aligned digits (measured, not assumed).
// Node env. Real font files are parsed (WOFF2 -> cmap, hmtx); nothing is mocked.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONTS, ROOT, SAMPLE_DEVA, SAMPLE_LATIN, UI, WEIGHTS, css, faceFor, faces, fontOf, read } from './_font-utils';

const DIGITS = [...'0123456789'].map((c) => c.codePointAt(0)!);
const stackOf = () => {
  const stack = /--lims-font-family-sans:\s*([^;]+);/.exec(read(join(UI, 'dist', 'tokens.css')))?.[1] ?? '';
  return stack.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
};

describe('M-SERIES-1 dependency (13 s2.2: @fontsource/poppins, OFL-1.1, exact pin; CR-UI-R-001 dependency review)', () => {
  const pkg = JSON.parse(read(join(UI, 'package.json')));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  it('@lims/ui pins @fontsource/poppins to an exact version (no ^ ~ range)', () => {
    expect(all['@fontsource/poppins']).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('pnpm-lock.yaml resolves it, in the packages/ui importer, to that version only, with an integrity hash', () => {
    const v = all['@fontsource/poppins'] as string;
    const lock = read(join(ROOT, 'pnpm-lock.yaml'));
    expect(lock).toMatch(new RegExp(`'@fontsource/poppins':\\s*\\n\\s+specifier: ${v.replace(/\./g, '\\.')}\\s*\\n\\s+version: ${v.replace(/\./g, '\\.')}`));
    expect(lock).toMatch(new RegExp(`'@fontsource/poppins@${v.replace(/\./g, '\\.')}':\\s*\\n\\s+resolution: \\{integrity: sha512-`));
    expect(lock).not.toMatch(new RegExp(`poppins@(?!${v.replace(/\./g, '\\.')})\\d`));
  });
  it('the Noto Sans Devanagari / Noto Sans Mono pins stay (fallback and mono are still bundled)', () => {
    expect(all['@fontsource/noto-sans-devanagari']).toBe('5.3.0');
    expect(all['@fontsource/noto-sans-mono']).toBe('5.3.0');
  });
});

describe('M-SERIES-1 fonts.css declares Poppins 400/500/600/700 latin, self-hosted woff2', () => {
  it('has a normal-style @font-face for every weight with font-display: swap', () => {
    for (const w of WEIGHTS) {
      const f = faceFor('Poppins', w);
      expect(f, `Poppins ${w} @font-face`).toBeTruthy();
      expect(f!.style).toBe('normal');
      expect(f!.display).toBe('swap');
    }
  });
  it('each face points at its own existing woff2 file in assets/fonts (valid wOF2, not a stub), four different files', () => {
    const hashes = new Set<string>();
    for (const w of WEIGHTS) {
      const f = faceFor('Poppins', w)!;
      expect(f.urls, `weight ${w}: one url()`).toHaveLength(1);
      expect(f.urls[0], `weight ${w}`).toMatch(/^\.\/[\w.-]+\.woff2$/);
      expect(f.formats).toEqual(['woff2']);
      expect(existsSync(f.file), `${f.urls[0]} exists`).toBe(true);
      const b = readFileSync(f.file);
      expect(b.toString('latin1', 0, 4)).toBe('wOF2');
      expect(b.length).toBeGreaterThan(5000);
      hashes.add(createHash('sha256').update(b).digest('hex'));
    }
    expect(hashes.size).toBe(4);
  });
  it('the weight in each file (OS/2 usWeightClass) matches the weight fonts.css declares for it', () => {
    for (const w of WEIGHTS) expect(fontOf(faceFor('Poppins', w)!.file).weight, `weight ${w}`).toBe(w);
  });
  it('keeps the Noto Sans, Noto Sans Devanagari (400-700) and Noto Sans Mono 400 faces', () => {
    for (const w of WEIGHTS) {
      expect(existsSync(faceFor('Noto Sans Devanagari', w)?.file ?? ''), `Noto Sans Devanagari ${w}`).toBe(true);
      expect(existsSync(faceFor('Noto Sans', w)?.file ?? ''), `Noto Sans ${w}`).toBe(true);
    }
    expect(existsSync(faceFor('Noto Sans Mono', 400)?.file ?? '')).toBe(true);
  });
  it('no Poppins face declares a unicode-range that reaches Devanagari (U+0900-097F): Nepali must fall through', () => {
    for (const f of faces().filter((x) => x.family === 'Poppins')) {
      for (const m of (f.range ?? '').matchAll(/U\+([0-9A-F]+)(?:-([0-9A-F]+))?/gi)) {
        const lo = parseInt(m[1]!, 16);
        const hi = m[2] ? parseInt(m[2], 16) : lo;
        expect(lo <= 0x097f && hi >= 0x0900, `range ${m[0]}`).toBe(false);
      }
    }
  });
});

describe('M-SERIES-1 Plus Jakarta Sans is gone from packages/ui/assets/fonts (13 s2.2, s6.2)', () => {
  it('no Plus Jakarta Sans woff2 or licence file is left in the folder', () => {
    expect(readdirSync(FONTS).filter((n) => /jakarta/i.test(n))).toEqual([]);
  });
  it('fonts.css has no Plus Jakarta Sans rule, comment or filename', () => {
    expect(css()).not.toMatch(/jakarta/i);
    expect(faces().filter((f) => /jakarta/i.test(f.family))).toEqual([]);
  });
  it('the font.family.sans token and the generated CSS no longer name it', () => {
    expect(read(join(UI, 'tokens', 'tokens.json'))).not.toMatch(/jakarta/i);
    expect(read(join(UI, 'dist', 'tokens.css'))).not.toMatch(/jakarta/i);
    expect(read(join(UI, 'src', 'tokens.ts'))).not.toMatch(/jakarta/i);
  });
});

describe('M-SERIES-1 licence: SIL OFL 1.1 text for Poppins ships next to the fonts', () => {
  it('an OFL/LICENSE file in packages/ui/assets/fonts names Poppins and the SIL Open Font License 1.1', () => {
    const lic = readdirSync(FONTS).filter((n) => /OFL|LICEN[CS]E/i.test(n) && !/\.(woff2?|ttf)$/i.test(n));
    expect(lic.length).toBeGreaterThan(0);
    const hit = lic.find((n) => /Poppins/i.test(read(join(FONTS, n))) && /SIL OPEN FONT LICENSE Version 1\.1/i.test(read(join(FONTS, n))));
    expect(hit, 'no licence file mentions "Poppins" and the OFL 1.1').toBeTruthy();
  });
});

describe('M-SERIES-1 Devanagari falls back correctly (13 s2.2: Poppins, Noto Sans Devanagari, system-ui, sans-serif)', () => {
  it('generated --lims-font-family-sans is exactly that stack', () => {
    expect(stackOf()).toEqual(['Poppins', 'Noto Sans Devanagari', 'system-ui', 'sans-serif']);
  });
  it('Poppins woff2 (all 4 weights) covers Latin and digits but no Devanagari glyph (latin subset only)', () => {
    for (const w of WEIGHTS) {
      const { covers } = fontOf(faceFor('Poppins', w)!.file);
      for (const ch of SAMPLE_LATIN.replace(/ /g, '')) expect(covers(ch.codePointAt(0)!), `${w} ${ch}`).toBe(true);
      for (const ch of SAMPLE_DEVA.replace(/ /g, '')) expect(covers(ch.codePointAt(0)!), `${w} U+${ch.codePointAt(0)!.toString(16)} must NOT be in the Poppins files`).toBe(false);
    }
  });
  it('walking the stack per character: Latin -> Poppins, Devanagari -> Noto Sans Devanagari, never system-ui', () => {
    const families = stackOf();
    for (const w of WEIGHTS) {
      const cover = new Map(families.slice(0, 2).map((fam) => [fam, fontOf(faceFor(fam, w)!.file).covers]));
      const pick = (cp: number) => families.find((fam) => cover.get(fam)?.(cp)) ?? families[families.length - 1];
      for (const ch of SAMPLE_LATIN.replace(/ /g, '')) expect(pick(ch.codePointAt(0)!), `${w} ${ch}`).toBe('Poppins');
      for (const ch of SAMPLE_DEVA.replace(/ /g, '')) expect(pick(ch.codePointAt(0)!), `${w} U+${ch.codePointAt(0)!.toString(16)}`).toBe('Noto Sans Devanagari');
    }
  });
});

describe('M-SERIES-1 no CDN (13 s6.2; REQ-SEC-141, AC-0D-8.7)', () => {
  it('fonts.css: every url() is ./relative woff2; no @import, no scheme, no //host', () => {
    const src = css().replace(/\/\*[\s\S]*?\*\//g, '');
    for (const f of faces()) for (const u of f.urls) expect(u, f.family).toMatch(/^\.\/[\w.-]+\.woff2$/);
    expect(src).not.toMatch(/@import|https?:|\/\/[\w.-]+\.\w/i);
    expect(faces().filter((f) => f.family === 'Poppins')).toHaveLength(4);
  });
});

// 13 s2.2: ".num keeps tabular digits; a test renders a column of digits in Poppins and fails if the glyph widths differ,
// and if Poppins is not tabular the .num class switches that column to Noto Sans."
describe('M-SERIES-1 digit width: the .num class renders aligned digits', () => {
  it('tooling self-check: Noto Sans latin digits 0-9 have one advance width (tabular), so the reader can tell equal from unequal', () => {
    const f = fontOf(join(FONTS, 'noto-sans-latin-400-normal.woff2'));
    const w = DIGITS.map((cp) => f.advance(cp));
    expect(Math.min(...w)).toBeGreaterThan(0.3);
    expect(new Set(w.map((x) => x.toFixed(4))).size).toBe(1);
    expect(f.advance(0x57)).not.toBeCloseTo(f.advance(0x69), 2); // W vs i: letters are proportional, reader is not returning a constant
  });

  const poppinsTabular = (w: number) => new Set(DIGITS.map((cp) => fontOf(faceFor('Poppins', w)!.file).advance(cp).toFixed(4))).size === 1;
  const kit = read(join(UI, 'src', 'components', 'kit.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const numRule = [...kit.matchAll(/([^{}]+){([^{}]*)}/g)].filter((m) => m[1]!.split(',').some((s) => s.trim() === '.num'));
  const numDecls = numRule.map((m) => m[2]!).join(';');

  it('a .num rule exists in kit.css and sets font-variant-numeric: tabular-nums', () => {
    expect(numRule.length, 'no .num rule in packages/ui/src/components/kit.css').toBeGreaterThan(0);
    expect(numDecls).toMatch(/font-variant-numeric\s*:\s*[^;]*tabular-nums/);
  });

  it('measured: if the Poppins digits 0-9 differ in width at any weight, .num switches to Noto Sans; if equal, .num stays on the sans stack', () => {
    const tabular = WEIGHTS.every(poppinsTabular);
    const fam = /font-family\s*:\s*([^;]+)/.exec(numDecls)?.[1]?.trim() ?? '';
    if (tabular) {
      expect(fam, 'Poppins digits are aligned: .num must not switch family').not.toMatch(/Noto Sans(?! (Devanagari|Mono))/);
    } else {
      expect(fam, `Poppins digit widths differ: .num must use Noto Sans (got "${fam}")`).toMatch(/^["']?Noto Sans["']?\s*(,|$)/);
      // the switched-to face must itself be tabular, otherwise the switch fixes nothing
      for (const w of WEIGHTS) {
        const noto = fontOf(faceFor('Noto Sans', w)!.file);
        expect(new Set(DIGITS.map((cp) => noto.advance(cp).toFixed(4))).size, `Noto Sans ${w} digits`).toBe(1);
      }
    }
  });
});
