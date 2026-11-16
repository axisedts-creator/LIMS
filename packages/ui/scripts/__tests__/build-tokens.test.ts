// T0D-11 / AC-0D-9.1 + done_when "Dart tokens generated"; T0D-MSERIES-1 (LD-251, 13-M-SERIES s2): the generated outputs follow tokens.json
// (M series), regenerate with no diff, and carry accent.pop and the new radius / font / motion values.
// Runs scripts/build-tokens.ts (Node >= 22.18 strips types natively; script must run via `node <file>` with no args).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ui = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dart = join(ui, '..', 'ui-flutter', 'lib', 'src', 'tokens.g.dart');
const css = join(ui, 'dist', 'tokens.css');
const ts = join(ui, 'src', 'tokens.ts');
const tokensJson = join(ui, 'tokens', 'tokens.json');
const script = join(ui, 'scripts', 'build-tokens.ts');
const run = () => execFileSync(process.execPath, [script], { cwd: ui, encoding: 'utf8' });

// Independent oracle: resolve aliases in tokens.json ourselves.
const src = JSON.parse(readFileSync(tokensJson, 'utf8'));
const get = (path: string): any => path.split('.').reduce((n: any, k) => n?.[k], src);
const resolveAlias = (v: any): any => {
  const m = typeof v === 'string' ? /^\{([\w.]+)\}$/.exec(v) : null;
  return m ? resolveAlias(get(m[1]!)) : v;
};
const resolveTree = (n: any): any =>
  n !== null && typeof n === 'object' ? Object.fromEntries(Object.entries(n).map(([k, v]) => [k, resolveTree(v)])) : resolveAlias(n);

describe('build-tokens', () => {
  it('committed tokens.g.dart exists (AC-0D-9.1)', () => {
    expect(existsSync(dart)).toBe(true);
  });

  it('regenerated tokens.ts, tokens.g.dart (and tokens.css) equal the committed ones; idempotent (AC-0D-9.1, done_when "no diff")', () => {
    const before = { ts: readFileSync(ts, 'utf8'), dart: readFileSync(dart, 'utf8') };
    run();
    const first = { ts: readFileSync(ts, 'utf8'), dart: readFileSync(dart, 'utf8'), css: readFileSync(css, 'utf8') };
    expect(first.ts).toBe(before.ts);
    expect(first.dart).toBe(before.dart);
    run();
    expect({ ts: readFileSync(ts, 'utf8'), dart: readFileSync(dart, 'utf8'), css: readFileSync(css, 'utf8') }).toEqual(first);
  });

  it('dist/tokens.css: M series default accent, accent.pop, new radius / font / motion values', () => {
    run();
    const c = readFileSync(css, 'utf8');
    expect(c).toMatch(/--lims-accent\s*:\s*#005A52\s*;/i);
    expect(c).toMatch(/--lims-accent-hover\s*:\s*#014D3C\s*;/i);
    expect(c).toMatch(/--lims-accent-highlight\s*:\s*#A0C032\s*;/i);
    expect(c).toMatch(/--lims-accent-brand\s*:\s*#A0C032\s*;/i);
    expect(c).toMatch(/--lims-accent-pop\s*:\s*#E4F239\s*;/i);
    expect(c).toMatch(/--lims-neutral-50\s*:\s*#F3F3F3\s*;/i);
    expect(c).toMatch(/--lims-tone-critical-solid\s*:\s*#B42318\s*;/i);
    expect(c).toMatch(/--lims-focus-ring\s*:\s*#005A52\s*;/i); // alias resolved
    expect(c).toMatch(/--lims-radius-lg\s*:\s*16px\s*;/);
    expect(c).toMatch(/--lims-radius-xl\s*:\s*24px\s*;/);
    expect(c).toMatch(/--lims-radius-full\s*:\s*9999px\s*;/);
    expect(c).toMatch(/--lims-touch-target-web\s*:\s*48px\s*;/);
    expect(c).toMatch(/--lims-motion-duration-fast\s*:\s*150ms\s*;/);
    expect(c).toMatch(/--lims-motion-duration-normal\s*:\s*450ms\s*;/);
    expect(c).toMatch(/--lims-motion-easing\s*:\s*cubic-bezier\(0\.2, 0\.7, 0\.2, 1\)\s*;/);
    expect(c).toMatch(/--lims-font-family-sans\s*:\s*"Poppins", "Noto Sans Devanagari", system-ui, sans-serif\s*;/);
    expect(c).not.toMatch(/Jakarta/i);
    expect(c.toUpperCase()).not.toContain('#1D4ED8');
    expect(c.toUpperCase()).not.toContain('#0E4B3B');
    expect(c).not.toMatch(/https?:|url\(/i);
  });

  it('src/tokens.ts equals tokens.json with aliases resolved (as const object)', () => {
    run();
    const body = readFileSync(ts, 'utf8');
    const m = /export const tokens = ([\s\S]*) as const;\s*$/.exec(body);
    expect(m, 'tokens.ts shape: export const tokens = {...} as const;').not.toBeNull();
    const parsed = JSON.parse(m![1]!);
    expect(parsed).toEqual(resolveTree(src));
    expect(parsed.color.accent.default.toUpperCase()).toBe('#005A52');
    expect(parsed.color.focus.ring.toUpperCase()).toBe('#005A52');
    for (const k of ['hover', 'highlight', 'brand', 'pop']) expect(parsed.color.accent[k]).toMatch(/^#[0-9A-F]{6}$/i);
    expect(parsed.color.accent.pop.toUpperCase()).toBe('#E4F239');
    expect(parsed.color.tone.critical.solid.toUpperCase()).toBe('#B42318');
    expect(parsed.radius).toEqual({ sm: 8, md: 12, lg: 16, xl: 24, full: 9999 });
    expect(parsed.font.family.sans).toBe('"Poppins", "Noto Sans Devanagari", system-ui, sans-serif');
  });

  it('Dart output carries the M series accent, accent.pop, the radius ladder, Poppins; no URLs, no old blue', () => {
    run();
    const d = readFileSync(dart, 'utf8');
    expect(d).toMatch(/static const Color colorAccentDefault = Color\(0xFF005A52\);/i);
    expect(d).toMatch(/static const Color colorAccentHover = Color\(0xFF014D3C\);/i);
    expect(d).toMatch(/static const Color colorAccentHighlight = Color\(0xFFA0C032\);/i);
    expect(d).toMatch(/static const Color colorAccentBrand = Color\(0xFFA0C032\);/i);
    expect(d).toMatch(/static const Color colorAccentPop = Color\(0xFFE4F239\);/i);
    expect(d).toMatch(/static const Color colorToneCriticalSolid = Color\(0xFFB42318\);/i);
    expect(d).toMatch(/static const Color colorFocusRing = Color\(0xFF005A52\);/i);
    expect(d).toMatch(/static const double radiusSm = 8\.0;/);
    expect(d).toMatch(/static const double radiusMd = 12\.0;/);
    expect(d).toMatch(/static const double radiusLg = 16\.0;/);
    expect(d).toMatch(/static const double radiusXl = 24\.0;/);
    expect(d).toMatch(/static const String fontFamilySans = '[^\n]*Poppins[^\n]*Noto Sans Devanagari/);
    expect(d).not.toMatch(/Jakarta/i);
    expect(d.toUpperCase()).not.toMatch(/1D4ED8/);
    expect(d).not.toMatch(/https?:\/\//);
  });

  // 13 s2.3: "everything off under prefers-reduced-motion". The generated CSS zeroes every motion duration token in that media query,
  // so any transition written with the tokens stops (kit tests check that kit.css uses only the tokens).
  it('dist/tokens.css: under prefers-reduced-motion: reduce both motion durations (150 and 450) become 0ms', () => {
    run();
    const m = /@media \(prefers-reduced-motion: reduce\)\s*{\s*:root\s*{([^}]*)}/.exec(readFileSync(css, 'utf8'));
    expect(m, 'reduced-motion block').not.toBeNull();
    expect(m![1]).toMatch(/--lims-motion-duration-fast\s*:\s*0ms\s*;/);
    expect(m![1]).toMatch(/--lims-motion-duration-normal\s*:\s*0ms\s*;/);
  });

  it('tokens.g.dart has one declaration per token leaf (nothing dropped or duplicated)', () => {
    const d = readFileSync(dart, 'utf8');
    const count = (n: any): number => (n !== null && typeof n === 'object' ? Object.values(n).reduce((a: number, v) => a + count(v), 0) : 1);
    expect((d.match(/^\s+static const /gm) ?? []).length).toBe(count(src));
  });

  // Injection guard (token values flow into CSS and Dart): runs the script on a poisoned copy; real files untouched.
  it.each(['red;} body{display:none', 'url(https://evil.example/x)', '<script>x</script>'])('rejects an unsafe token value: %s', (evil) => {
    const root = mkdtempSync(join(tmpdir(), 'lims-tokens-'));
    try {
      mkdirSync(join(root, 'ui', 'scripts'), { recursive: true });
      mkdirSync(join(root, 'ui', 'tokens'), { recursive: true });
      cpSync(script, join(root, 'ui', 'scripts', 'build-tokens.ts'));
      const poisoned = JSON.parse(JSON.stringify(src));
      poisoned.color.accent.hover = evil;
      writeFileSync(join(root, 'ui', 'tokens', 'tokens.json'), JSON.stringify(poisoned));
      expect(() =>
        execFileSync(process.execPath, [join(root, 'ui', 'scripts', 'build-tokens.ts')], { cwd: join(root, 'ui'), stdio: 'pipe' }),
      ).toThrow();
      expect(existsSync(join(root, 'ui', 'dist', 'tokens.css'))).toBe(false);
      expect(existsSync(join(root, 'ui-flutter', 'lib', 'src', 'tokens.g.dart'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an alias that points at a missing token (no silent empty value)', () => {
    const root = mkdtempSync(join(tmpdir(), 'lims-tokens-'));
    try {
      mkdirSync(join(root, 'ui', 'scripts'), { recursive: true });
      mkdirSync(join(root, 'ui', 'tokens'), { recursive: true });
      cpSync(script, join(root, 'ui', 'scripts', 'build-tokens.ts'));
      const broken = JSON.parse(JSON.stringify(src));
      broken.color.focus.ring = '{color.accent.nope}';
      writeFileSync(join(root, 'ui', 'tokens', 'tokens.json'), JSON.stringify(broken));
      expect(() =>
        execFileSync(process.execPath, [join(root, 'ui', 'scripts', 'build-tokens.ts')], { cwd: join(root, 'ui'), stdio: 'pipe' }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
