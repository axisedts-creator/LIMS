// T0D-UI-R02 (LD-140, CR-UI-R-001) tests that stay after T0D-MSERIES-1 (LD-251; 13-M-SERIES s2.2):
// the WEB Plus Jakarta Sans parts (fonts.css faces, woff2 files, web licence, Devanagari walk) moved to poppins.test.ts and now
// assert the opposite (Poppins present, Plus Jakarta Sans absent). What remains here is NOT part of MSERIES-1 and must keep passing:
//   - the Flutter side still ships Plus Jakarta Sans TTFs until T0D-MSERIES-3 (lane C0-0F) replaces them; those TTFs are made by
//     packages/ui-flutter/tool/woff2ttf.py from the @fontsource/plus-jakarta-sans devDependency, so that devDependency and its
//     lock entry STAY in packages/ui until MSERIES-3 (MSERIES-1 removes only the web woff2 files, the web OFL file and the fonts.css rules);
//   - the CSP / no-egress guard (font-agnostic), the parser self-check, and the Flutter licence file.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONTS, ROOT, SAMPLE_DEVA, SAMPLE_LATIN, UI, WEIGHTS, css, faces, fontOf, read } from './_font-utils';

const FLUTTER = join(ROOT, 'packages', 'ui-flutter');

describe('T0D-UI-R02 dependency pin kept for the Flutter TTF tool (until T0D-MSERIES-3)', () => {
  const pkg = JSON.parse(read(join(UI, 'package.json')));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  it('@lims/ui still pins @fontsource/plus-jakarta-sans to exactly 5.3.0 (source of the Flutter TTFs)', () => {
    expect(all['@fontsource/plus-jakarta-sans']).toBe('5.3.0');
  });
  it('pnpm-lock.yaml still resolves it to 5.3.0 only, with an integrity hash', () => {
    const lock = read(join(ROOT, 'pnpm-lock.yaml'));
    expect(lock).toMatch(/'@fontsource\/plus-jakarta-sans':\s*\n\s+specifier: 5\.3\.0\s*\n\s+version: 5\.3\.0/);
    expect(lock).toMatch(/'@fontsource\/plus-jakarta-sans@5\.3\.0':\s*\n\s+resolution: \{integrity: sha512-/);
    expect(lock).not.toMatch(/plus-jakarta-sans@(?!5\.3\.0)/);
  });
});

describe('T0D-UI-R02 parser self-check (guards the test tooling, runs on the already-bundled Noto Sans latin woff2)', () => {
  it('reads cmap + OS/2 of a real woff2: covers A/z/7, not Devanagari, weight 400', () => {
    const f = fontOf(join(FONTS, 'noto-sans-latin-400-normal.woff2'));
    expect([f.covers(0x41), f.covers(0x7a), f.covers(0x37), f.covers(0x0928)]).toEqual([true, true, true, false]);
    expect(f.weight).toBe(400);
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

describe('T0D-UI-R02 Flutter licence: SIL OFL file for the Plus Jakarta Sans TTFs stays until T0D-MSERIES-3', () => {
  it('packages/ui-flutter/assets/fonts has an OFL/LICENSE file that names Plus Jakarta Sans and the SIL Open Font License 1.1', () => {
    const dir = join(FLUTTER, 'assets', 'fonts');
    const lic = readdirSync(dir).filter((n) => /OFL|LICEN[CS]E/i.test(n) && !/\.(woff2?|ttf)$/i.test(n));
    expect(lic.length).toBeGreaterThan(0);
    const hit = lic.find((n) => /Plus Jakarta/i.test(read(join(dir, n))) && /SIL OPEN FONT LICENSE Version 1\.1/i.test(read(join(dir, n))));
    expect(hit, 'no licence file in packages/ui-flutter/assets/fonts mentions "Plus Jakarta"').toBeTruthy();
  });
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
