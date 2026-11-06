// T0D-11 / AC-0D-8.2: tenant accent derivation (04-UI-UX §1.6).
// ASSUMED API (name not in spec; see .orchestra/notes/T0D-11-tests.md):
//   export function deriveAccent(input?: string | null): { accent: string; fg: string; subtle: string; link: string }  // '#RRGGBB' upper-case
import { describe, expect, it } from 'vitest';
import { deriveAccent } from '../accent';

const DEFAULT = '#1D4ED8';
const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const HEX = /^#[0-9A-F]{6}$/;

describe('deriveAccent', () => {
  it('default accent: white fg, link = accent, valid subtle', () => {
    const d = deriveAccent(undefined);
    expect(d.accent).toBe(DEFAULT);
    expect(d.fg).toBe('#FFFFFF');
    expect(d.link).toBe(DEFAULT);
    expect(d.subtle).toMatch(HEX);
  });

  it.each([null, undefined, '', 'red', '#12345', '#1234567', '#GGGGGG', '1D4ED8', '#1D4ED8;color:red', 'javascript:alert(1)', ' #1D4ED8', '<script>'])(
    'invalid input %j falls back to default',
    (bad) => {
      expect(deriveAccent(bad as any).accent).toBe(DEFAULT);
      expect(deriveAccent(bad as any).fg).toBe('#FFFFFF');
    },
  );

  it('non-string input falls back to default', () => {
    for (const bad of [123, {}, [], true]) expect(deriveAccent(bad as any).accent).toBe(DEFAULT);
  });

  it('accepts lower-case hex and normalises to upper-case', () => {
    expect(deriveAccent('#1d4ed8').accent).toBe(DEFAULT);
  });

  it('dark accent keeps itself and gets white fg', () => {
    const d = deriveAccent('#0B3D91');
    expect(d.accent).toBe('#0B3D91');
    expect(d.fg).toBe('#FFFFFF');
  });

  it('light accent (yellow) keeps itself and gets dark fg #0F172A', () => {
    const d = deriveAccent('#FFEB3B');
    expect(d.accent).toBe('#FFEB3B');
    expect(d.fg).toBe('#0F172A');
    expect(ratio(d.fg, d.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('accent failing 4.5 with both white and #0F172A is darkened until white passes (AC-0D-8.2)', () => {
    const d = deriveAccent('#777777'); // white 4.48, #0F172A ~4.0
    expect(d.accent).not.toBe('#777777');
    expect(d.fg).toBe('#FFFFFF');
    expect(lum(d.accent)).toBeLessThan(lum('#777777'));
    expect(ratio('#FFFFFF', d.accent)).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#FFFFFF', d.accent)).toBeLessThan(5.5); // 0.02 OKLCH steps: not over-darkened
  });

  it('subtle = accent mixed 8% with white', () => {
    expect(deriveAccent('#000000').subtle).toBe('#141414'); // round(255 * 0.08) = 20
    expect(deriveAccent('#FFFFFF').subtle).toBe('#FFFFFF');
  });

  it('link: unchanged when it already passes 4.5 on white; darkened otherwise', () => {
    expect(deriveAccent('#0B3D91').link).toBe('#0B3D91');
    const l = deriveAccent('#FFEB3B').link;
    expect(l).not.toBe('#FFEB3B');
    expect(ratio(l, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
  });

  it('property: 600 spread colours always yield fg>=4.5 on accent and link>=4.5 on white, all hex', () => {
    let s = 12345;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0);
    const cols = ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#808080', '#767676', '#777777'];
    for (let i = 0; i < 600; i++) cols.push('#' + (rnd() & 0xffffff).toString(16).padStart(6, '0').toUpperCase());
    for (const c of cols) {
      const d = deriveAccent(c);
      expect(d.accent, c).toMatch(HEX);
      expect(d.subtle, c).toMatch(HEX);
      expect(['#FFFFFF', '#0F172A'], c).toContain(d.fg);
      expect(ratio(d.fg, d.accent), c).toBeGreaterThanOrEqual(4.5);
      expect(ratio(d.link, '#FFFFFF'), c).toBeGreaterThanOrEqual(4.5);
    }
  });
});
