// T0D-11 / AC-0D-8.1 + T0D-UI-R01 (10-DESIGN-SYSTEM s2.6, LD-140): every pair in tokens/contrast-pairs.json meets WCAG 2.2 AA,
// and the file lists every pair s2.6 requires.
// Own WCAG implementation = independent oracle (does not import the unit under test).
// Pair schema: [{ "fg": "color.neutral.900", "bg": "color.neutral.0", "kind": "text" | "large" | "ui" }, ...]  (or { "pairs": [...] })
// fg/bg are dot-paths into tokens.json; a leaf is a "#RRGGBB" string or { value | $value }; "{a.b}" aliases resolve.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

function resolve(tokens: any, path: string, depth = 0): string {
  let node = tokens;
  for (const k of path.split('.')) node = node?.[k];
  const v = typeof node === 'string' ? node : node?.value ?? node?.$value;
  if (typeof v !== 'string') throw new Error(`token not found or not a string: ${path}`);
  if (/^#[0-9A-Fa-f]{6}$/.test(v)) return v.toUpperCase();
  if (depth > 5) throw new Error(`alias loop at ${path}`);
  return resolve(tokens, v.replace(/^\{(.*)\}$/, '$1'), depth + 1); // alias "{color.accent.default}" or "color.accent.default"
}

describe('oracle self-check', () => {
  it('black/white = 21, same colour = 1', () => {
    expect(ratio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(ratio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
});

describe('contrast-pairs.json (AC-0D-8.1, 10-DESIGN-SYSTEM s2.6)', () => {
  it('files exist', () => {
    expect(existsSync(join(dir, 'tokens.json'))).toBe(true);
    expect(existsSync(join(dir, 'contrast-pairs.json'))).toBe(true);
  });

  const tokens = existsSync(join(dir, 'tokens.json')) ? read('tokens.json') : {};
  const raw = existsSync(join(dir, 'contrast-pairs.json')) ? read('contrast-pairs.json') : [];
  const pairs: { fg: string; bg: string; kind: 'text' | 'large' | 'ui' }[] = Array.isArray(raw) ? raw : raw.pairs ?? [];
  const val = (p: string) => resolve(tokens, p);

  // A required pair may be declared in either direction ("accent.default <-> accent.fg" in s2.6).
  const declared = (a: RegExp, b: RegExp, kind: 'text' | 'ui') =>
    pairs.some((p) => p.kind === kind && ((a.test(p.fg) && b.test(p.bg)) || (b.test(p.fg) && a.test(p.bg))));

  it('declares every pair of s2.6 and of the earlier 04-UI-UX s1.1/s1.2 list', () => {
    const missing: string[] = [];
    const T = 'text' as const;
    const U = 'ui' as const;
    const need: [string, RegExp, RegExp, 'text' | 'ui'][] = [
      ['neutral.900 on neutral.0', /neutral\.900$/, /neutral\.0$/, T],
      ['neutral.900 on neutral.50', /neutral\.900$/, /neutral\.50$/, T],
      ['neutral.600 on neutral.0', /neutral\.600$/, /neutral\.0$/, T],
      ['neutral.600 on neutral.50', /neutral\.600$/, /neutral\.50$/, T],
      ['neutral.700 on neutral.100', /neutral\.700$/, /neutral\.100$/, T],
      // s2.6 new rows
      ['neutral.500 on neutral.0 (text)', /neutral\.500$/, /neutral\.0$/, T],
      ['neutral.500 on neutral.50 (text)', /neutral\.500$/, /neutral\.50$/, T],
      ['neutral.500 on neutral.100 (text)', /neutral\.500$/, /neutral\.100$/, T],
      ['neutral.300 vs neutral.0 (non-text 3:1)', /neutral\.300$/, /neutral\.0$/, U],
      ['neutral.300 vs neutral.50 (non-text 3:1)', /neutral\.300$/, /neutral\.50$/, U],
      ['accent.default <-> accent.fg', /accent\.default$/, /accent\.fg$/, T],
      ['accent.default on accent.highlight', /accent\.default$/, /accent\.highlight$/, T],
      ['neutral.900 on accent.highlight', /neutral\.900$/, /accent\.highlight$/, T],
      ['neutral.900 on accent.brand', /neutral\.900$/, /accent\.brand$/, T],
      ['accent.default on neutral.0 (links)', /accent\.default$/, /neutral\.0$/, T],
      ['accent.default on accent.subtle', /accent\.default$/, /accent\.subtle$/, T],
      ['neutral.900 on accent.subtle', /neutral\.900$/, /accent\.subtle$/, T],
      ['focus.ring vs neutral.0', /focus\.ring$/, /neutral\.0$/, U],
      ['focus.ring vs neutral.50', /focus\.ring$/, /neutral\.50$/, U],
    ];
    for (const t of ['neutral', 'info', 'success', 'warning', 'danger', 'critical'])
      need.push([`${t} tone fg on bg`, new RegExp(`tone\\.${t}\\.fg$`), new RegExp(`tone\\.${t}\\.bg$`), T]);
    for (const [name, a, b, kind] of need) if (!declared(a, b, kind)) missing.push(name);
    // critical.solid <-> white text (s2.1: 6.57)
    const solid = pairs.some(
      (p) =>
        p.kind === 'text' &&
        ((/tone\.critical\.solid$/.test(p.fg) && val(p.bg) === '#FFFFFF') || (/tone\.critical\.solid$/.test(p.bg) && val(p.fg) === '#FFFFFF')),
    );
    if (!solid) missing.push('tone.critical.solid <-> #FFFFFF (text)');
    expect(missing).toEqual([]);
  });

  it('every pair has kind text|large|ui', () => {
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs) expect(['text', 'large', 'ui']).toContain(p.kind);
  });

  it('every pair meets AA: 4.5:1 text, 3:1 large text and UI parts', () => {
    expect(pairs.length).toBeGreaterThan(0);
    const failures = pairs
      .map((p) => ({ ...p, r: ratio(val(p.fg), val(p.bg)) }))
      .filter((p) => p.r < (p.kind === 'text' ? 4.5 : 3))
      .map((p) => `${p.fg} on ${p.bg} (${p.kind}) = ${p.r.toFixed(2)}`);
    expect(failures).toEqual([]);
  });

  it('accent.brand is never declared as text/icon colour on a light surface (2.13:1 on white, s2.1)', () => {
    const bad = pairs.filter((p) => /accent\.brand$/.test(p.fg) && /neutral\.(0|50|100)$/.test(p.bg));
    expect(bad).toEqual([]);
    expect(ratio(val('color.accent.brand'), val('color.neutral.0'))).toBeLessThan(3); // guards the rule's premise
  });

  it('ratios quoted in 10-DESIGN-SYSTEM s2.1 hold (catches a mistyped hex that still passes AA)', () => {
    const spec: [string, string, number][] = [
      ['color.neutral.500', 'color.neutral.0', 5.23],
      ['color.neutral.300', 'color.neutral.0', 3.38],
      ['color.neutral.300', 'color.neutral.50', 3.12],
      ['color.neutral.600', 'color.neutral.0', 6.47],
      ['color.neutral.900', 'color.neutral.0', 16.18],
      ['color.accent.default', 'color.neutral.0', 10.06],
      ['color.accent.default', 'color.accent.highlight', 7.93],
      ['color.neutral.900', 'color.accent.highlight', 12.76],
      ['color.neutral.900', 'color.accent.brand', 7.58],
      ['color.accent.brand', 'color.neutral.0', 2.13],
      ['color.tone.neutral.fg', 'color.tone.neutral.bg', 7.84],
      ['color.tone.info.fg', 'color.tone.info.bg', 7.0],
      ['color.tone.success.fg', 'color.tone.success.bg', 6.32],
      ['color.tone.warning.fg', 'color.tone.warning.bg', 7.35],
      ['color.tone.danger.fg', 'color.tone.danger.bg', 7.19],
      ['color.tone.critical.fg', 'color.tone.critical.bg', 5.92],
      ['color.tone.critical.solid', 'color.neutral.0', 6.57],
    ];
    for (const [a, b, want] of spec) expect(ratio(val(a), val(b)), `${a} on ${b}`).toBeCloseTo(want, 1);
  });
});
