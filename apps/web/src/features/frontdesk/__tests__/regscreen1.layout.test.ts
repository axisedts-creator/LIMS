// T0D-REGSCREEN-1 — one-screen registration layout, proven from the CSS VALUES (jsdom has no layout engine; real pixels need a browser).
// Source: LD-310 + founder request 2026-11-17 04:49 NPT. done_when (1) and (5): three columns at >= 1280 px, totals bar fixed at the bottom,
// no page level scroll at 1366x768 and 1920x1080, the test list scrolls inside its own box. CONTRACT for the writer (frontdesk .css under features/frontdesk):
//   .lims-reg-layout           grid; 3 tracks in grid-template-columns at >= 1280 px; fewer below; height bound to the viewport (dvh/vh) so the PAGE never scrolls
//   .lims-reg-summary          the totals bar: position fixed|sticky + bottom 0 (or var()) at >= 1280 px
//   .lims-reg-tests-list       the cart box: overflow-y auto|scroll + a bounded height (max-height / flex with min-height 0)
//   tokens only: no hex colours in the feature css.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk, web } from './rs-c4.signature';

type Rule = { media: string; selectors: string[]; decls: Record<string, string> };

/** Tiny CSS reader: comments out, one nesting level of @media, declarations by property. Enough for the feature css (no nesting syntax, no @supports). */
function parse(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const block = (s: string, from: number): number => { let d = 0; for (let i = from; i < s.length; i++) { if (s[i] === '{') d++; else if (s[i] === '}' && --d === 0) return i; } return s.length; };
  const decls = (body: string) => Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const i = d.indexOf(':'); return [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()]; }));
  const run = (s: string, media: string) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open < 0) break;
      const head = s.slice(i, open).trim();
      const close = block(s, open);
      const body = s.slice(open + 1, close);
      if (head.startsWith('@media')) run(body, head.slice(6).trim());
      else if (!head.startsWith('@')) out.push({ media, selectors: head.split(',').map((x) => x.trim()), decls: decls(body) });
      i = close + 1;
    }
  };
  run(src, '');
  return out;
}
const mediaOn = (media: string, w: number) => !media || media.split(/\s+and\s+/i).every((q) => {
  const m = /\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/i.exec(q);
  if (!m) return /^(screen|all)$/i.test(q.trim());
  return m[1]!.toLowerCase() === 'min' ? w >= Number(m[2]) : w <= Number(m[2]);
});
const dir = join(web, 'src', 'features', 'frontdesk');
const files = walk(dir).filter((f) => f.endsWith('.css'));
const rules = files.flatMap((f) => parse(readFileSync(f, 'utf8')));
/** Cascade (source order) of every declaration that applies to exactly this selector at this viewport width. */
const styleOf = (sel: string, w: number): Record<string, string> => Object.assign({}, ...rules.filter((r) => mediaOn(r.media, w) && r.selectors.includes(sel)).map((r) => r.decls));
/** Number of tracks of a grid template, top level only (repeat(n, x) expands). */
function tracks(v = ''): number {
  const parts: string[] = []; let d = 0; let cur = '';
  for (const ch of v) { if (ch === '(') d++; if (ch === ')') d--; if (/\s/.test(ch) && d === 0) { if (cur) parts.push(cur); cur = ''; } else cur += ch; }
  if (cur) parts.push(cur);
  return parts.reduce((n, p) => { const m = /^repeat\(\s*(\d+)\s*,/.exec(p); return n + (m ? Number(m[1]) : 1); }, 0);
}

const VIEWPORTS = [{ w: 1366, h: 768 }, { w: 1920, h: 1080 }] as const;

describe('T0D-REGSCREEN-1 layout from the CSS values', () => {
  it('the feature css exists and declares the layout classes', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const c of ['.lims-reg-layout', '.lims-reg-summary', '.lims-reg-tests-list']) expect(rules.some((r) => r.selectors.includes(c)), `${c} has no rule`).toBe(true);
  });

  it.each(VIEWPORTS)('$w x $h: .lims-reg-layout is a grid with exactly three column tracks', ({ w }) => {
    const s = styleOf('.lims-reg-layout', w);
    expect(s['display']).toMatch(/grid/);
    expect(tracks(s['grid-template-columns'])).toBe(3);
  });

  it.each([1279, 1024, 800])('%i px (below 1280): not three columns; no horizontal scroll rule', (w) => {
    const s = styleOf('.lims-reg-layout', w);
    expect(tracks(s['grid-template-columns']) < 3 || !/grid/.test(s['display'] ?? 'grid')).toBe(true);
    expect(`${s['overflow-x'] ?? ''}${s['overflow'] ?? ''}`).not.toMatch(/scroll/);
  });

  it.each(VIEWPORTS)('$w x $h: the totals bar is fixed at the bottom (position fixed|sticky, bottom 0 or a token)', ({ w }) => {
    const s = styleOf('.lims-reg-summary', w);
    expect(s['position']).toMatch(/^(fixed|sticky)$/);
    expect(s['bottom']).toMatch(/^(0(px)?|var\(.+\)|calc\(.+\))$/);
    expect(s['top'], 'a bar pinned to the bottom must not also be pinned to the top').toBeUndefined();
  });

  it.each(VIEWPORTS)('$w x $h: no page level overflow rule; layout height is bound to the viewport', ({ w }) => {
    for (const sel of ['html', 'body', '.lims-reg-layout']) {
      const s = styleOf(sel, w);
      expect(`${s['overflow'] ?? ''} ${s['overflow-y'] ?? ''}`, `${sel} must not create page scroll`).not.toMatch(/scroll|auto/);
    }
    const l = styleOf('.lims-reg-layout', w);
    const bound = `${l['height'] ?? ''} ${l['max-height'] ?? ''}`;
    expect(bound, 'layout must be bound to the viewport height, not grow with its content').toMatch(/d?vh|%/);
  });

  it.each(VIEWPORTS)('$w x $h: the test list scrolls inside its own box (overflow-y, bounded height, room for 8 compact rows)', ({ w }) => {
    const s = styleOf('.lims-reg-tests-list', w);
    expect(s['overflow-y'] ?? s['overflow']).toMatch(/^(auto|scroll)$/);
    const bounded = !!s['max-height'] || /min-height\s*:\s*0/.test(JSON.stringify(s)) || s['min-height'] === '0' || !!s['flex'] || !!s['height'];
    expect(bounded, 'the cart box needs a bounded height (max-height, height or flex with min-height 0)').toBe(true);
    const mh = /^(\d+(?:\.\d+)?)px$/.exec(s['min-height'] ?? '');
    if (mh) expect(Number(mh[1]), '8 rows at 28 px + header').toBeGreaterThanOrEqual(8 * 28 + 28);
  });

  it('tokens only: no hex colour in the feature css (10-DESIGN-SYSTEM s6)', () => {
    const all = files.map((f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
    expect(all.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });
});
