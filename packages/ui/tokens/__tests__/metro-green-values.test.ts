// T0D-UI-R01 (LD-140, CR-UI-R-002): tokens.json carries the Metro Green values of spec/program/10-DESIGN-SYSTEM.md s2.1-2.3,
// token names are unchanged except the four additions accent.hover, accent.highlight, accent.brand, tone.critical.solid.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf8'));

const get = (path: string): unknown => path.split('.').reduce((n: any, k) => n?.[k], tokens);
const leaves = (node: any, path: string[] = []): string[] =>
  Object.entries(node).flatMap(([k, v]) => (v !== null && typeof v === 'object' ? leaves(v, [...path, k]) : [[...path, k].join('.')]));

// Names that existed before LD-140 (packages/ui/tokens/tokens.json at commit c5e3f207). Values may change, names may not.
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
const ADDED = ['color.accent.hover', 'color.accent.highlight', 'color.accent.brand', 'color.tone.critical.solid'];

describe('token names (CR-UI-R-002)', () => {
  it('exactly the previous names plus the four additions: nothing renamed, removed or invented', () => {
    expect(leaves(tokens).sort()).toEqual([...BASELINE, ...ADDED].sort());
  });
});

describe('colour values (s2.1)', () => {
  it.each([
    ['color.neutral.0', '#FFFFFF'],
    ['color.neutral.50', '#F3F7F4'],
    ['color.neutral.100', '#EEF3EF'],
    ['color.neutral.200', '#DCE8E0'],
    ['color.neutral.300', '#7A9185'],
    ['color.neutral.500', '#5C7167'], // NOT the prototype's #6B8076 (4.22:1, fails AA)
    ['color.neutral.600', '#4D6359'],
    ['color.neutral.700', '#2F463C'],
    ['color.neutral.900', '#13241D'],
    ['color.accent.default', '#0E4B3B'],
    ['color.accent.hover', '#0A3328'],
    ['color.accent.fg', '#FFFFFF'],
    ['color.accent.subtle', '#E6F2EA'],
    ['color.accent.highlight', '#D9EE8C'],
    ['color.accent.brand', '#9DBE2E'],
    ['color.focus.ring', '{color.accent.default}'],
  ])('%s = %s', (path, want) => {
    expect(String(get(path)).toUpperCase()).toBe(want.toUpperCase());
  });

  it.each([
    ['neutral', '#3A4F45', '#EEF3EF', '#CFDDD4'],
    ['info', '#1B566F', '#E5F1F6', '#BBD7E4'],
    ['success', '#14633F', '#E3F3E8', '#B9DEC6'],
    ['warning', '#7A4300', '#FFF4E5', '#F2D6A8'],
    ['danger', '#8A2E2E', '#FBEAEA', '#EBBFBF'],
    ['critical', '#B42318', '#FEF0EE', '#F1B5AE'],
  ])('tone.%s fg/bg/border', (tone, fg, bg, border) => {
    expect(String(get(`color.tone.${tone}.fg`)).toUpperCase()).toBe(fg);
    expect(String(get(`color.tone.${tone}.bg`)).toUpperCase()).toBe(bg);
    expect(String(get(`color.tone.${tone}.border`)).toUpperCase()).toBe(border);
  });

  it('tone.critical.solid = #B42318 (white text, blocking banner)', () => {
    expect(String(get('color.tone.critical.solid')).toUpperCase()).toBe('#B42318');
  });

  it('every colour leaf is #RRGGBB or an alias to one (no named colours, no rgb(), no url())', () => {
    const bad = leaves(tokens.color).filter((p) => !/^(#[0-9A-Fa-f]{6}|\{color(\.\w+)+\})$/.test(String(get(`color.${p.replace(/^color\./, '')}`))));
    expect(bad).toEqual([]);
  });
});

describe('type (s2.2)', () => {
  it('sans: Plus Jakarta Sans first, Devanagari fallback second, then system-ui, sans-serif', () => {
    expect(get('font.family.sans')).toBe('"Plus Jakarta Sans", "Noto Sans Devanagari", system-ui, sans-serif');
  });
  it('mono: Noto Sans Mono first', () => {
    expect(String(get('font.family.mono'))).toMatch(/^"Noto Sans Mono"/);
  });
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

describe('shape, depth, motion (s2.3)', () => {
  it('radius ladder 8/12/16/20/full', () => {
    expect(get('radius')).toEqual({ sm: 8, md: 12, lg: 16, xl: 20, full: 9999 });
  });
  // Spec writes ".06"; tolerate "0.06" and spacing differences, nothing else.
  const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/(^|[^\d])0\./g, '$1.').trim();
  it('elevation 1/2/3 are the green-tinted shadows; 0 is none', () => {
    expect(get('elevation.0')).toBe('none');
    expect(norm(String(get('elevation.1')))).toBe('0 1px 2px rgb(14 75 59 / .06)');
    expect(norm(String(get('elevation.2')))).toBe('0 4px 12px rgb(14 75 59 / .10)');
    expect(norm(String(get('elevation.3')))).toBe('0 12px 32px rgb(14 75 59 / .18)');
  });
  it('motion: 150 ms standard, none longer than 250 ms, easing cubic-bezier(0.2,0,0,1)', () => {
    expect(get('motion.duration.fast')).toBe(150);
    expect(get('motion.duration.normal') as number).toBeLessThanOrEqual(250);
    expect(String(get('motion.easing')).replace(/\s+/g, '')).toBe('cubic-bezier(0.2,0,0,1)');
  });
  it('touch target web stays 44', () => {
    expect(get('touchTarget.web')).toBe(44);
  });
});

describe('old slate/blue theme is gone', () => {
  it('no leftover value from the previous palette', () => {
    const old = ['#F8FAFC', '#F1F5F9', '#E2E8F0', '#8794A6', '#64748B', '#475569', '#334155', '#0F172A', '#1D4ED8', '#EFF6FF', '#CBD5E1', '#BFDBFE', '#7F1D1D'];
    const all = JSON.stringify(tokens).toUpperCase();
    expect(old.filter((h) => all.includes(h))).toEqual([]);
    expect(JSON.stringify(tokens)).not.toContain('"Noto Sans", "Noto Sans Devanagari"');
  });
});
