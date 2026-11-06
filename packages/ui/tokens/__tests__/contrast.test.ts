// T0D-11 / AC-0D-8.1: every pair in tokens/contrast-pairs.json meets WCAG 2.2 AA.
// Own WCAG implementation = independent oracle (does not import the unit under test).
// Assumed pair schema (flagged in .orchestra/notes/T0D-11-tests.md):
//   [{ "fg": "color.neutral.900", "bg": "color.neutral.0", "kind": "text" | "large" | "ui" }, ...]  (or { "pairs": [...] })
// fg/bg are dot-paths into tokens.json; a leaf is a "#RRGGBB" string or { value | $value }.
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

describe('contrast-pairs.json (AC-0D-8.1)', () => {
  it('files exist', () => {
    expect(existsSync(join(dir, 'tokens.json'))).toBe(true);
    expect(existsSync(join(dir, 'contrast-pairs.json'))).toBe(true);
  });

  const tokens = existsSync(join(dir, 'tokens.json')) ? read('tokens.json') : {};
  const raw = existsSync(join(dir, 'contrast-pairs.json')) ? read('contrast-pairs.json') : [];
  const pairs: { fg: string; bg: string; kind: 'text' | 'large' | 'ui' }[] = Array.isArray(raw) ? raw : raw.pairs ?? [];

  it('declares the required pairs (04-UI-UX §1.1/§1.2)', () => {
    const has = (f: RegExp, b: RegExp) => pairs.some((p) => f.test(p.fg) && b.test(p.bg));
    const missing: string[] = [];
    const need: [string, RegExp, RegExp][] = [
      ['neutral.900 on neutral.0', /neutral\.900$/, /neutral\.0$/],
      ['neutral.600 on neutral.0', /neutral\.600$/, /neutral\.0$/],
      ['accent.fg on accent.default', /accent\.fg$/, /accent\.default$/],
      ['accent.default on neutral.0 (links/focus ring)', /accent\.default$/, /neutral\.0$/],
      ['neutral.300 on neutral.0 (input border, ui)', /neutral\.300$/, /neutral\.0$/],
    ];
    for (const t of ['neutral', 'info', 'success', 'warning', 'danger', 'critical'])
      need.push([`${t} tone fg on bg`, new RegExp(`${t}[._-]fg$`), new RegExp(`${t}[._-]bg$`)]);
    for (const [name, f, b] of need) if (!has(f, b)) missing.push(name);
    expect(missing).toEqual([]);
  });

  it('every pair has kind text|large|ui', () => {
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs) expect(['text', 'large', 'ui']).toContain(p.kind);
  });

  it('every pair meets AA: 4.5:1 text, 3:1 large text and UI parts', () => {
    expect(pairs.length).toBeGreaterThan(0);
    const failures = pairs
      .map((p) => ({ ...p, r: ratio(resolve(tokens, p.fg), resolve(tokens, p.bg)) }))
      .filter((p) => p.r < (p.kind === 'text' ? 4.5 : 3))
      .map((p) => `${p.fg} on ${p.bg} (${p.kind}) = ${p.r.toFixed(2)}`);
    expect(failures).toEqual([]);
  });
});
