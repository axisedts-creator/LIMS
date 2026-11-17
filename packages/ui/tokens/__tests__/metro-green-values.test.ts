// T0D-MSERIES-1 (LD-246, LD-251; spec/program/13-M-SERIES.md s2.1-2.3): tokens.json carries the M series values.
// (File keeps its T0D-UI-R01 name; its Metro Green expectations are replaced by the M series ones in this change.)
// Token names are unchanged; the ONLY new token is color.accent.pop (13 s2.1, "token names unchanged; accent.pop is the one new token").
//
// ASSUMPTIONS where 13 gives a value but not the token it lands in (writer: follow them, or file a dispute):
//   - radius.xl is the 24 of "cards, panels, dialogs, drawers" (names unchanged: sm 8, md 12, lg 16 = icon tiles/tooltips, xl 24, full).
//   - touchTarget.web becomes 48 ("Button height 48 (also the touch target)"); touchTarget.flutter stays 48.
//   - motion.duration.fast = 150 (hover, press), motion.duration.normal = 450 (content enter), motion.easing = cubic-bezier(0.2, 0.7, 0.2, 1).
//   - elevation 1/2/3 keep their geometry; the tint moves from rgb(14 75 59 / a) to rgb(0 90 82 / a) with a = .06 / .10 / .18.
//   - tone border values are not pinned (13 gives fg/bg only); contrast.test.ts guards what they must satisfy.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf8'));

const get = (path: string): unknown => path.split('.').reduce((n: any, k) => n?.[k], tokens);
const leaves = (node: any, path: string[] = []): string[] =>
  Object.entries(node).flatMap(([k, v]) => (v !== null && typeof v === 'object' ? leaves(v, [...path, k]) : [[...path, k].join('.')]));

// Names that existed before LD-140 plus the four LD-140 additions (T0D-UI-R01). Values may change, names may not.
const range = (prefix: string, keys: string[], subs: string[] = ['']) => keys.flatMap((k) => subs.map((s) => `${prefix}.${k}${s ? '.' + s : ''}`));
const BASELINE = [
  ...range('color.neutral', ['0', '50', '100', '200', '300', '500', '600', '700', '900']),
  ...range('color.accent', ['default', 'fg', 'subtle']),
  'color.focus.ring',
  ...range('color.tone', ['neutral', 'info', 'success', 'warning', 'danger', 'critical'], ['fg', 'bg', 'border']),
  'font.family.sans',
  'font.family.mono',
  ...range('font.size', ['xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl'], ['size', 'lineHeight']),
  ...range('font.weight', ['regular', 'medium', 'semibold', 'bold']),
  ...range('space', ['0', '0_5', '1', '2', '3', '4', '5', '6', '8', '10', '12', '16']),
  ...range('radius', ['sm', 'md', 'lg', 'xl', 'full']),
  ...range('elevation', ['0', '1', '2', '3']),
  'motion.duration.fast',
  'motion.duration.normal',
  'motion.easing',
  ...range('breakpoint', ['sm', 'md', 'lg', 'xl', '2xl']),
  ...range('z', ['base', 'sticky', 'nav', 'dropdown', 'drawer', 'dialog', 'toast']),
  'touchTarget.web',
  'touchTarget.flutter',
];
const LD140 = ['color.accent.hover', 'color.accent.highlight', 'color.accent.brand', 'color.tone.critical.solid'];
const MSERIES_NEW = ['color.accent.pop'];

const up = (p: string) => String(get(p)).toUpperCase();
// Spec writes ".06"; tolerate "0.06" and spacing differences, nothing else.
const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/(^|[^\d])0\./g, '$1.').trim();

describe('token names (13 s2.1: names unchanged, accent.pop is the one new token)', () => {
  it('exactly the previous names plus color.accent.pop: nothing renamed, removed or invented', () => {
    expect(leaves(tokens).sort()).toEqual([...BASELINE, ...LD140, ...MSERIES_NEW].sort());
  });
});

describe('colour values (13 s2.1)', () => {
  it.each([
    // changed by 13
    ['color.accent.default', '#005A52'],
    ['color.accent.hover', '#014D3C'],
    ['color.accent.subtle', '#ECF3D7'],
    ['color.accent.highlight', '#A0C032'],
    ['color.accent.brand', '#A0C032'],
    ['color.accent.pop', '#E4F239'],
    ['color.neutral.50', '#F3F3F3'],
    ['color.neutral.200', '#ECECEC'],
    ['color.neutral.500', '#5C6A66'],
    ['color.neutral.900', '#0A1A17'],
    // unchanged by 13
    ['color.accent.fg', '#FFFFFF'],
    ['color.neutral.0', '#FFFFFF'],
    ['color.neutral.100', '#EEF3EF'],
    ['color.neutral.300', '#7A9185'], // the control border stays neutral.300; the board's #D3D8D0 (1.45:1) is NOT used
    ['color.neutral.600', '#4D6359'],
    ['color.neutral.700', '#2F463C'],
    ['color.tone.critical.solid', '#B42318'],
    ['color.tone.critical.fg', '#B42318'],
    ['color.tone.critical.bg', '#FEF0EE'],
  ])('%s = %s', (path, want) => {
    expect(up(path)).toBe(want);
  });

  it('focus.ring is still an alias of accent.default (so it follows the new green)', () => {
    expect(get('color.focus.ring')).toBe('{color.accent.default}');
  });

  it.each([
    ['success', '#14612F', '#E4F4DE'],
    ['info', '#1A4F8B', '#E3EEFB'],
    ['warning', '#7A4B00', '#FFF1D0'],
    ['danger', '#9C1C12', '#FDE7E4'],
    ['neutral', '#46524E', '#EEF0EC'],
  ])('tone.%s fg/bg', (tone, fg, bg) => {
    expect(up(`color.tone.${tone}.fg`)).toBe(fg);
    expect(up(`color.tone.${tone}.bg`)).toBe(bg);
  });

  it('every tone keeps its border token (tone + border + icon + word, never colour alone)', () => {
    for (const t of ['neutral', 'info', 'success', 'warning', 'danger', 'critical']) expect(String(get(`color.tone.${t}.border`))).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('every colour leaf is #RRGGBB or an alias to one (no named colours, no rgb(), no url())', () => {
    const bad = leaves(tokens.color).filter((p) => !/^(#[0-9A-Fa-f]{6}|\{color(\.\w+)+\})$/.test(String(get(`color.${p.replace(/^color\./, '')}`))));
    expect(bad).toEqual([]);
  });
});

describe('type (13 s2.2)', () => {
  it('sans: Poppins first, Noto Sans Devanagari second, then system-ui, sans-serif', () => {
    expect(get('font.family.sans')).toBe('"Poppins", "Noto Sans Devanagari", system-ui, sans-serif');
  });
  it('mono stays Noto Sans Mono', () => {
    expect(String(get('font.family.mono'))).toMatch(/^"Noto Sans Mono"/);
  });
  // Dense staff screens keep the 10 scale (13 s2.2); the larger display/title sizes live in kit.css (kit tests), not as new tokens.
  it.each([
    ['xs', 12, 16],
    ['sm', 13, 18],
    ['base', 14, 20],
    ['md', 16, 24],
    ['lg', 18, 28],
    ['xl', 20, 28],
    ['2xl', 24, 32],
    ['3xl', 30, 36],
  ])('scale %s = %i/%i', (k, size, lh) => {
    expect(get(`font.size.${k}`)).toEqual({ size, lineHeight: lh });
  });
  it('weights 400/500/600/700', () => {
    expect(get('font.weight')).toEqual({ regular: 400, medium: 500, semibold: 600, bold: 700 });
  });
});

describe('shape, size, motion (13 s2.3)', () => {
  it('radius ladder 8/12/16/24/full (xl = the 24 of cards, panels, dialogs, drawers)', () => {
    expect(get('radius')).toEqual({ sm: 8, md: 12, lg: 16, xl: 24, full: 9999 });
  });
  it('elevation 1/2/3 are tinted rgb(0 90 82 / .06 | .10 | .18); 0 is none', () => {
    expect(get('elevation.0')).toBe('none');
    expect(norm(String(get('elevation.1')))).toBe('0 1px 2px rgb(0 90 82 / .06)');
    expect(norm(String(get('elevation.2')))).toBe('0 4px 12px rgb(0 90 82 / .10)');
    expect(norm(String(get('elevation.3')))).toBe('0 12px 32px rgb(0 90 82 / .18)');
  });
  it('motion: 150 ms hover/press, 450 ms enter, easing cubic-bezier(0.2, 0.7, 0.2, 1)', () => {
    expect(get('motion.duration.fast')).toBe(150);
    expect(get('motion.duration.normal')).toBe(450);
    expect(String(get('motion.easing')).replace(/\s+/g, '')).toBe('cubic-bezier(0.2,0.7,0.2,1)');
  });
  it('touch target: web 48 (the button height), flutter 48', () => {
    expect(get('touchTarget.web')).toBe(48);
    expect(get('touchTarget.flutter')).toBe(48);
  });
});

describe('Metro Green and the old slate/blue themes are gone', () => {
  it('no leftover value from the Metro Green palette (10 s2.1) that 13 replaced', () => {
    const metro = ['#0E4B3B', '#0A3328', '#E6F2EA', '#D9EE8C', '#9DBE2E', '#F3F7F4', '#DCE8E0', '#5C7167', '#13241D', '#3A4F45', '#1B566F', '#14633F', '#7A4300', '#8A2E2E'];
    const all = JSON.stringify(tokens).toUpperCase();
    expect(metro.filter((h) => all.includes(h))).toEqual([]);
    expect(JSON.stringify(tokens)).not.toMatch(/rgb\(14 75 59/);
  });
  it('no leftover value from the slate/blue palette', () => {
    const old = ['#F8FAFC', '#F1F5F9', '#E2E8F0', '#8794A6', '#64748B', '#475569', '#334155', '#0F172A', '#1D4ED8', '#EFF6FF', '#CBD5E1', '#BFDBFE', '#7F1D1D'];
    const all = JSON.stringify(tokens).toUpperCase();
    expect(old.filter((h) => all.includes(h))).toEqual([]);
    expect(JSON.stringify(tokens)).not.toContain('"Noto Sans", "Noto Sans Devanagari"');
    expect(JSON.stringify(tokens)).not.toMatch(/jakarta/i);
  });
});
