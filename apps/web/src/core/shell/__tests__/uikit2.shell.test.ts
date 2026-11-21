// T0D-UIKIT-2 (LD-436 R8, LD-438 option C): the staff web card surface lives in apps/web shell.css, not in the kit.
// Static guard over shell.css text, built like r04.source.test.ts. No rendering.
// The kit base lims-card (packages/ui kit.css) stays radius 24, no border, no shadow (guarded in packages/ui uikit2.kit.test.tsx).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHELL_CSS = join(import.meta.dirname, '..', 'shell.css');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const src = strip(readFileSync(SHELL_CSS, 'utf8'));

type Rule = { sels: string[]; decls: Map<string, string>; media: string };
function parseCss(s: string): Rule[] {
  const out: Rule[] = [];
  const media: string[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    const close = s.indexOf('}', i);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) { media.pop(); i = close + 1; continue; }
    const prelude = s.slice(i, open).trim();
    if (/^@(media|supports)/.test(prelude)) { media.push(prelude); i = open + 1; continue; }
    const end = s.indexOf('}', open);
    const decls = new Map<string, string>();
    for (const d of s.slice(open + 1, end).split(';')) { const k = d.indexOf(':'); if (k > 0) decls.set(d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim()); }
    if (!prelude.startsWith('@')) out.push({ sels: prelude.split(',').map((x) => x.trim().replace(/\s+/g, ' ')), decls, media: media.join(' ') });
    i = end + 1;
  }
  return out;
}
const rules = parseCss(src);
const cardRules = rules.filter((r) => r.sels.includes('.lims-card'));
const last = (prop: string) => cardRules.filter((r) => r.decls.has(prop)).map((r) => r.decls.get(prop)!).at(-1);

describe('shell.css staff card surface (LD-436 R8, LD-438)', () => {
  it('the existing lims-card padding rule (LD-344/352) is still there, with the important flag', () => {
    expect(last('padding')).toBe('var(--lims-space-2) var(--lims-space-3) !important');
  });

  it('lims-card sets a 1px neutral.200 hairline, radius md and elevation.1, each with the important flag', () => {
    expect(last('border')).toBe('0.0625rem solid var(--lims-neutral-200) !important');
    expect(last('border-radius')).toBe('var(--lims-radius-md) !important');
    expect(last('box-shadow')).toBe('var(--lims-elevation-1) !important');
  });

  it('the card surface rule comes after the padding rule (same place, next to it)', () => {
    const idx = (prop: string) => rules.findIndex((r) => r.sels.includes('.lims-card') && r.decls.has(prop));
    expect(idx('padding')).toBeGreaterThanOrEqual(0);
    expect(idx('border')).toBeGreaterThanOrEqual(idx('padding'));
  });

  it('the card rules are tokens only: no hex, rgb/hsl, gradient, and no px', () => {
    expect(cardRules.length).toBeGreaterThan(0);
    for (const r of cardRules) {
      for (const [k, v] of r.decls) {
        expect(v, `.lims-card { ${k} }`).not.toMatch(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch)\(|gradient\(/i);
        const px = v.match(/\b\d+(\.\d+)?px\b/);
        expect(px, `.lims-card { ${k}: ${v} } literal px`).toBeNull();
      }
    }
  });

  it('the card background stays white (neutral.0) when shell.css sets one, and no gradient or shadow glow is added', () => {
    const bg = last('background');
    if (bg !== undefined) expect(bg).toMatch(/^var\(--lims-neutral-0\)( !important)?$/);
    expect(last('box-shadow')).not.toMatch(/\d+(\.\d+)?(px|rem|em)\b|\b(rgba?|hsla?|oklch)\(|#[0-9a-f]{3,8}\b/i);
  });

  it('no rule in shell.css changes lims-dialog or lims-drawer (they keep radius 24 and elevation.3)', () => {
    const bad = rules.filter((r) => r.sels.some((s) => /lims-(dialog|drawer)/.test(s)));
    expect(bad.map((r) => r.sels.join(','))).toEqual([]);
  });

  it('the card surface is not scoped to dialog or drawer descendants', () => {
    for (const r of cardRules) expect(r.sels.join(' ')).not.toMatch(/dialog|drawer/);
  });
});
