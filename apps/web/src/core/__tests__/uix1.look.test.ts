// T0D-UIX-1 (LD-442, LD-436, LD-437, LD-438): the staff web LOOK is measured by VALUES.
// Method: parse packages/ui kit.css (loaded first in app/layout.tsx) then apps/web shell.css (loaded after it) as text, build small DOM
// fixtures (the exact class lists the kit components render), and compute the winning declaration per property with a real cascade
// (important, specificity, source order). Element.matches (jsdom) decides which rules apply. No rendering, no real browser.
// Only shell.css may change; kit.css and tokens.json are guarded as unchanged (LD-438).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const KIT_CSS = readFileSync(join(ROOT, 'packages', 'ui', 'src', 'components', 'kit.css'), 'utf8');
const SHELL_CSS = readFileSync(join(import.meta.dirname, '..', 'shell', 'shell.css'), 'utf8');
const TOKENS = JSON.parse(readFileSync(join(ROOT, 'packages', 'ui', 'tokens', 'tokens.json'), 'utf8')) as {
  space: Record<string, number>; radius: Record<string, number>; font: { weight: Record<string, number>; size: Record<string, { size: number }> };
};

/* ---------- css parsing ---------- */
type Decl = { prop: string; value: string; important: boolean };
type Rule = { sels: string[]; decls: Decl[]; media: string; order: number };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

function close(s: string, open: number): number {
  let d = 0;
  for (let i = open; i < s.length; i++) { if (s[i] === '{') d++; else if (s[i] === '}' && --d === 0) return i; }
  return s.length - 1;
}
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []; let d = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') d++; else if (ch === ')' || ch === ']') d--;
    if (ch === sep && d === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
function parseCss(src: string, startOrder = 0): Rule[] {
  const out: Rule[] = []; let order = startOrder;
  const walk = (s: string, media: string) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open === -1) break;
      const prelude = s.slice(i, open).trim();
      const end = close(s, open);
      const body = s.slice(open + 1, end);
      if (/^@(media|supports)/.test(prelude)) walk(body, `${media} ${prelude}`.trim());
      else if (!prelude.startsWith('@')) {
        const decls: Decl[] = [];
        for (const d of splitTop(body, ';')) {
          const k = d.indexOf(':'); if (k <= 0) continue;
          let value = d.slice(k + 1).trim(); const important = /!\s*important\s*$/i.test(value);
          value = value.replace(/!\s*important\s*$/i, '').trim();
          decls.push({ prop: d.slice(0, k).trim().toLowerCase(), value, important });
        }
        out.push({ sels: splitTop(prelude, ',').map((x) => x.trim().replace(/\s+/g, ' ')), decls, media, order: order++ });
      }
      i = end + 1;
    }
  };
  walk(strip(src), '');
  return out;
}
const kitRules = parseCss(KIT_CSS, 0);
const shellRules = parseCss(SHELL_CSS, 100000); // shell.css is imported after kit.css
const allRules = [...kitRules, ...shellRules];

function mediaOk(media: string, w: number): boolean {
  if (!media) return true;
  return media.split('@').filter(Boolean).every((m) => {
    const conds = [...m.matchAll(/\((min|max)-width:\s*([\d.]+)(px|rem)\)/g)];
    const rest = m.replace(/^(media|supports)/, '').replace(/\((min|max)-width:\s*[\d.]+(px|rem)\)/g, '').replace(/\band\b/g, '').trim();
    if (rest !== '' || conds.length === 0) return false; // prefers-reduced-motion, supports(...) etc. are not modelled
    return conds.every((c) => { const v = Number(c[2]) * (c[3] === 'rem' ? 16 : 1); return c[1] === 'min' ? w >= v : w <= v; });
  });
}

/* ---------- specificity ---------- */
function specificity(sel: string): number {
  let s = sel.replace(/:where\([^)]*\)/g, '').replace(/::?[\w-]+\(\s*/g, (m) => (/^:(not|is|has)\(/.test(m) ? '(' : m));
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const attrs = (s.match(/\[[^\]]*\]/g) ?? []).length;
  s = s.replace(/\[[^\]]*\]/g, '');
  const cls = (s.match(/\.[\w-]+/g) ?? []).length;
  const pseudoEl = (s.match(/::[\w-]+/g) ?? []).length;
  const pseudoCls = (s.replace(/::[\w-]+/g, '').match(/:[\w-]+/g) ?? []).filter((p) => !/^:(where|not|is|has)$/.test(p)).length;
  const els = (s.replace(/\.[\w-]+|#[\w-]+|::?[\w-]+/g, ' ').match(/(^|[\s>+~(])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + (cls + attrs + pseudoCls) * 100 + els + pseudoEl;
}

/* ---------- cascade resolution on a DOM element ---------- */
const bad = new Set<string>();
function matches(el: Element, sel: string): boolean {
  try { return el.matches(sel); } catch { bad.add(sel); return false; }
}
const BOX = ['top', 'right', 'bottom', 'left'] as const;
function box(v: string): string[] {
  const p = splitTop(v.replace(/\s+/g, ' ').trim(), ' ');
  return p.length === 1 ? [p[0]!, p[0]!, p[0]!, p[0]!] : p.length === 2 ? [p[0]!, p[1]!, p[0]!, p[1]!] : p.length === 3 ? [p[0]!, p[1]!, p[2]!, p[1]!] : p.slice(0, 4);
}
function borderParts(v: string): { w: string; s: string; c: string } {
  let w = 'medium'; let s = 'none'; let c = 'currentcolor';
  for (const t of splitTop(v.trim(), ' ')) {
    if (/^(none|solid|dashed|dotted|hidden)$/.test(t)) s = t;
    else if (/^(-?[\d.]+(px|rem)?|thin|medium|thick)$/.test(t)) w = t;
    else if (t) c = t;
  }
  if (s === 'none' && v.trim() !== 'none' && v.trim() !== '0') s = 'solid'; // a width + colour with no style is not valid css, treat as visible
  return { w, s, c };
}
function setProp(m: Map<string, string>, prop: string, v: string) {
  const sides = (pre: string, suf: string, val: string) => box(val).forEach((x, i) => m.set(`${pre}-${BOX[i]}${suf}`, x));
  if (prop === 'padding' || prop === 'margin') sides(prop, '', v);
  else if (prop === 'padding-inline' || prop === 'margin-inline') { const b = box(v); m.set(`${prop.split('-')[0]}-left`, b[0]!); m.set(`${prop.split('-')[0]}-right`, b[1]!); }
  else if (prop === 'padding-block' || prop === 'margin-block') { const b = box(v); m.set(`${prop.split('-')[0]}-top`, b[0]!); m.set(`${prop.split('-')[0]}-bottom`, b[1]!); }
  else if (/^(padding|margin)-inline-start$/.test(prop)) m.set(`${prop.split('-')[0]}-left`, v);
  else if (/^(padding|margin)-inline-end$/.test(prop)) m.set(`${prop.split('-')[0]}-right`, v);
  else if (/^(padding|margin)-block-start$/.test(prop)) m.set(`${prop.split('-')[0]}-top`, v);
  else if (/^(padding|margin)-block-end$/.test(prop)) m.set(`${prop.split('-')[0]}-bottom`, v);
  else if (prop === 'inset-inline-end') m.set('right', v);
  else if (prop === 'inset-inline-start') m.set('left', v);
  else if (prop === 'border') { const b = borderParts(v); BOX.forEach((s) => { m.set(`border-${s}-width`, b.w); m.set(`border-${s}-style`, b.s); m.set(`border-${s}-color`, b.c); }); }
  else if (/^border-(top|right|bottom|left)$/.test(prop)) { const b = borderParts(v); m.set(`${prop}-width`, b.w); m.set(`${prop}-style`, b.s); m.set(`${prop}-color`, b.c); }
  else if (prop === 'border-inline-start') { const b = borderParts(v); m.set('border-left-width', b.w); m.set('border-left-style', b.s); m.set('border-left-color', b.c); }
  else if (prop === 'border-width' || prop === 'border-style' || prop === 'border-color') box(v).forEach((x, i) => m.set(`border-${BOX[i]}-${prop.slice(7)}`, x));
  else if (prop === 'border-radius') m.set('border-radius', v);
  else if (prop === 'gap') { const g = splitTop(v, ' '); m.set('row-gap', g[0]!); m.set('column-gap', g[1]! ?? g[0]); }
  else if (prop === 'background') m.set('background-color', v);
  else if (prop === 'font') { /* font: inherit only; size and weight come from their own declarations */ }
  else m.set(prop, v);
}
function resolve(el: Element, width = 1100): Map<string, string> {
  const hits: { d: Decl; spec: number; order: number; i: number }[] = [];
  for (const r of allRules) {
    if (!mediaOk(r.media, width)) continue;
    let spec = -1;
    for (const s of r.sels) if (matches(el, s)) spec = Math.max(spec, specificity(s));
    if (spec < 0) continue;
    r.decls.forEach((d, i) => hits.push({ d, spec, order: r.order, i }));
  }
  hits.sort((a, b) => Number(a.d.important) - Number(b.d.important) || a.spec - b.spec || a.order - b.order || a.i - b.i);
  const m = new Map<string, string>();
  for (const h of hits) setProp(m, h.d.prop, h.d.value);
  return m;
}

/* ---------- value helpers ---------- */
const shellRoot = new Map<string, number>();
for (const r of shellRules) if (r.sels.includes(':root')) for (const d of r.decls) { const mm = /^--lims-font-size-([\w]+)-size$/.exec(d.prop); if (mm) shellRoot.set(mm[1]!, len(d.value)); }
function len(v: string | undefined): number {
  if (v === undefined) return NaN;
  v = v.trim();
  let m = /^calc\(\s*-1\s*\*\s*(.+)\)$/.exec(v); if (m) return -len(m[1]);
  if (v === '0') return 0;
  if ((m = /^(-?[\d.]+)px$/.exec(v))) return Number(m[1]);
  if ((m = /^(-?[\d.]+)rem$/.exec(v))) return Number(m[1]) * 16;
  if ((m = /^var\(--lims-space-([\d-]+)\)$/.exec(v))) return TOKENS.space[m[1]!.replace('-', '_')] ?? NaN;
  if ((m = /^var\(--lims-radius-(\w+)\)$/.exec(v))) return TOKENS.radius[m[1]!] ?? NaN;
  if ((m = /^var\(--lims-font-size-(\w+)-size\)$/.exec(v))) return shellRoot.get(m[1]!) ?? TOKENS.font.size[m[1]!]?.size ?? NaN;
  if ((m = /^var\(--lims-touch-target-web\)$/.exec(v))) return 48;
  return NaN;
}
const weight = (v: string | undefined) => (v === undefined ? NaN : /^\d+$/.test(v) ? Number(v) : (TOKENS.font.weight[(/^var\(--lims-font-weight-(\w+)\)$/.exec(v) ?? [])[1]!] ?? NaN));
const px = (m: Map<string, string>, p: string) => len(m.get(p));
const col = (m: Map<string, string>, p: string) => m.get(p);
function bordered(m: Map<string, string>, side: string): { w: number; c: string } | null {
  const w = len(m.get(`border-${side}-width`)); const s = m.get(`border-${side}-style`) ?? 'none';
  if (s === 'none' || s === 'hidden' || !(w > 0)) return null;
  return { w, c: m.get(`border-${side}-color`) ?? '' };
}
function expectHeight(m: Map<string, string>, h: number, bothSet: boolean) {
  const height = px(m, 'height'); const min = px(m, 'min-height');
  if (bothSet) { expect(height, 'height').toBe(h); expect(min, 'min-height').toBe(h); return; }
  expect(height, 'height').toBe(h);
  expect(Number.isNaN(min) || min <= h, `min-height ${m.get('min-height')} must not exceed ${h}px`).toBe(true);
}
function expectPad(m: Map<string, string>, top: number, right: number, bottom: number, left: number) {
  expect([px(m, 'padding-top'), px(m, 'padding-right'), px(m, 'padding-bottom'), px(m, 'padding-left')]).toEqual([top, right, bottom, left]);
}
function expectBorder(m: Map<string, string>, widthPx: number, tok: string) {
  for (const s of BOX) { const b = bordered(m, s); expect(b, `border-${s}`).not.toBeNull(); expect(b!.w).toBe(widthPx); expect(b!.c).toBe(`var(--lims-${tok})`); }
}
function expectNoBorder(m: Map<string, string>) { for (const s of BOX) expect(bordered(m, s), `border-${s}`).toBeNull(); }
const radius = (m: Map<string, string>) => len(m.get('border-radius'));
const fs = (m: Map<string, string>) => len(m.get('font-size'));
const BASE = 12.6; const XS = 10.8;
const approx = (a: number, b: number) => Math.abs(a - b) < 0.01;

/* ---------- fixtures ---------- */
function mount(html: string): HTMLElement {
  document.body.innerHTML = `<div class="lims-density" data-density="regular"><div class="lims-shell"><div class="lims-shell-body"><main class="lims-shell-main"><div class="lims-card" id="card">${html}</div></main></div></div></div>`;
  return document.getElementById('card')!;
}
const q = (root: ParentNode, sel: string) => { const e = root.querySelector(sel); if (!e) throw new Error(`fixture: ${sel} not found`); return e; };

describe('guards: the kit and tokens are not edited (LD-438), the look is tokens only', () => {
  it('kit.css keeps its base pill button, 48px button, 40px tab and 46px input (m-series-kit stays green)', () => {
    expect(KIT_CSS).toMatch(/\.lims-btn \{[^}]*min-height: 48px;[^}]*border-radius: var\(--lims-radius-full\)/);
    expect(KIT_CSS).toMatch(/\.lims-tab \{[^}]*min-height: 40px;[^}]*border-radius: var\(--lims-radius-full\)/);
    expect(KIT_CSS).toMatch(/\.lims-input \{[^}]*min-height: 46px;/);
  });
  it('tokens.json radius and space scales are unchanged', () => {
    expect(TOKENS.radius).toEqual({ sm: 8, md: 12, lg: 16, xl: 24, full: 9999 });
    expect(TOKENS.space).toMatchObject({ '1': 4, '2': 8, '3': 12 });
  });
  it('shell.css has no hex or rgb colour literal (tokens only)', () => {
    const s = strip(SHELL_CSS);
    expect(s.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(s.match(/\b(rgb|rgba|hsl|hsla)\(/g) ?? []).toEqual([]);
  });
  it('the LD-340/344/352 shell values are not undone', () => {
    document.body.innerHTML = '<div class="lims-shell"><div class="lims-shell-body"><aside class="lims-shell-nav"><div class="lims-rail"><div class="lims-rail-brand"></div><a class="lims-rail-link"></a></div></aside></div></div>';
    expect(px(resolve(q(document, '.lims-shell-nav')), 'width')).toBe(232);
    expect(px(resolve(q(document, '.lims-rail-brand')), 'min-height')).toBe(44);
    expect(px(resolve(q(document, '.lims-rail-link')), 'min-height')).toBe(32);
    expect(shellRoot.get('base')).toBeCloseTo(BASE, 5);
    expect(shellRoot.get('xs')).toBeCloseTo(XS, 5);
  });
  it('every selector of the look layer can be evaluated (a selector the matcher cannot read would hide a rule)', () => {
    mount('<button class="lims-btn lims-btn-primary">x</button>');
    resolve(q(document, 'button'));
    const odd = [...bad].filter((s) => !/::|:hover|:focus|:active|:disabled|:checked|:placeholder|-webkit-|-moz-|:invalid|:read-only|:open|:indeterminate|:has\(/.test(s));
    expect(odd).toEqual([]);
  });
});

describe('(1) BUTTONS (LD-442 DONE WHEN 1)', () => {
  const variants: [string, string][] = [['default', 'lims-btn'], ['secondary', 'lims-btn lims-btn-secondary'], ['primary', 'lims-btn lims-btn-primary'], ['ghost', 'lims-btn lims-btn-ghost'], ['danger', 'lims-btn lims-btn-danger']];
  let m: Record<string, Map<string, string>>;
  beforeAll(() => {
    const c = mount(variants.map(([k, cls]) => `<button class="${cls}" data-k="${k}">b</button>`).join('') + '<button class="lims-btn lims-btn-sm" data-k="sm">s</button><button class="lims-btn lims-btn-primary lims-btn-sm" data-k="psm">s</button>');
    m = Object.fromEntries([...variants.map(([k]) => k), 'sm', 'psm'].map((k) => [k, resolve(q(c, `[data-k="${k}"]`))]));
  });
  it.each(variants.map(([k]) => k))('%s: height and min-height 30px, radius 8px, base size 12.6px, weight 500', (k) => {
    expectHeight(m[k]!, 30, true);
    expect(radius(m[k]!)).toBe(8);
    expect(fs(m[k]!)).toBeCloseTo(BASE, 5);
    expect(weight(m[k]!.get('font-weight'))).toBe(500);
  });
  it.each(['default', 'secondary', 'primary', 'danger'])('%s: padding 0 12px', (k) => expectPad(m[k]!, 0, 12, 0, 12));
  // T0D-UIX-6 (LD-444) replaces the secondary colours (accent tint, asserted in uix6.buttons.test.ts); the bare .lims-btn keeps the neutral look.
  it('default (bare .lims-btn): white fill, 1px neutral.300 border, neutral.700 text', () => {
    expect(col(m.default!, 'background-color')).toBe('var(--lims-neutral-0)');
    expectBorder(m.default!, 1, 'neutral-300');
    expect(col(m.default!, 'color')).toBe('var(--lims-neutral-700)');
  });
  // T0D-UIX-6 (LD-444 / done_when 1) replaces "no border" with a 1px accent border; the border itself is asserted in uix6.buttons.test.ts.
  it('primary: accent fill, white text', () => {
    expect(col(m.primary!, 'background-color')).toBe('var(--lims-accent)');
    expect(['var(--lims-accent-fg)', 'var(--lims-neutral-0)']).toContain(col(m.primary!, 'color'));
  });
  it('ghost: transparent fill, accent text, no border, padding 0 8px', () => {
    expect(['transparent', 'none']).toContain(col(m.ghost!, 'background-color'));
    expect(col(m.ghost!, 'color')).toBe('var(--lims-accent)');
    expectNoBorder(m.ghost!);
    expectPad(m.ghost!, 0, 8, 0, 8);
  });
  it('danger keeps the danger fill with the same height and radius as the others', () => {
    expect(col(m.danger!, 'background-color')).toBe('var(--lims-tone-danger-fg)');
  });
  it('small: 24px height and min-height', () => { expectHeight(m.sm!, 24, true); expectHeight(m.psm!, 24, true); });
  it('IconButton (ghost and secondary): 30 x 30, radius 8px, 1px neutral.200 border, white fill', () => {
    const c = mount('<button class="lims-btn lims-btn-ghost lims-icon-btn" data-k="g">i</button><button class="lims-btn lims-btn-secondary lims-icon-btn" data-k="s">i</button>');
    for (const k of ['g', 's']) {
      const r = resolve(q(c, `[data-k="${k}"]`));
      expect(px(r, 'width'), `${k} width`).toBe(30);
      expect(Number.isNaN(px(r, 'min-width')) || px(r, 'min-width') <= 30).toBe(true);
      expectHeight(r, 30, true);
      expect(radius(r)).toBe(8);
      expectBorder(r, 1, 'neutral-200');
      expect(col(r, 'background-color')).toBe('var(--lims-neutral-0)');
    }
  });
  it('no pill remains on a button, a chip-button or a tab (StatusChip, Badge and avatars stay pill)', () => {
    for (const k of Object.keys(m)) expect(radius(m[k]!), k).toBeLessThan(TOKENS.radius.full!);
    const c = mount('<div class="lims-tablist"><div class="lims-tab" data-selected="true" aria-selected="true">t</div><div class="lims-tab" aria-selected="false">u</div></div>');
    for (const t of c.querySelectorAll('.lims-tab')) expect(radius(resolve(t))).toBeLessThan(TOKENS.radius.full!);
  });
});

describe('(2) FORM CONTROLS (LD-442 DONE WHEN 2)', () => {
  const field = (inner: string) => `<div class="lims-field"><label class="lims-label" for="x">Label</label>${inner}</div>`;
  const controls: [string, string][] = [
    ['TextField', field('<input class="lims-input" id="x" type="text">')],
    ['Select', field('<button class="lims-input lims-select-trigger" id="x">s</button>')],
    ['Combobox', field('<input class="lims-input" id="x" role="combobox">')],
    ['search input', field('<input class="lims-input" id="x" type="search">')],
    ['DatePicker input', '<div class="lims-field lims-date-field"><label class="lims-label" for="x">Date</label><div class="lims-input-group"><input class="lims-input" id="x"><button class="lims-btn lims-btn-ghost lims-icon-btn" data-k="icon">c</button></div></div>'],
  ];
  it.each(controls)('%s: 30px high, 1px neutral.200 border, radius 8px, white fill, neutral.700 text, 12.6px', (_n, html) => {
    const c = mount(html);
    const r = resolve(q(c, '.lims-input'));
    expectHeight(r, 30, false);
    expect(radius(r)).toBe(8);
    expectBorder(r, 1, 'neutral-200');
    expect(col(r, 'background-color')).toBe('var(--lims-neutral-0)');
    expect(col(r, 'color')).toBe('var(--lims-neutral-700)');
    expect(fs(r)).toBeCloseTo(BASE, 5);
  });
  it.each(controls.slice(0, 4))('%s: padding 0 8px', (_n, html) => expectPad(resolve(q(mount(html), '.lims-input')), 0, 8, 0, 8));
  it('the top bar search input (padding-inline-end for its hint) is 30px high with 8px start padding', () => {
    document.body.innerHTML = '<div class="lims-shell"><div class="lims-search"><input class="lims-input lims-search-input" type="search"><kbd class="lims-search-hint"></kbd></div></div>';
    const r = resolve(q(document, '.lims-search-input'));
    expectHeight(r, 30, false);
    expect([px(r, 'padding-top'), px(r, 'padding-left'), px(r, 'padding-bottom')]).toEqual([0, 8, 0]);
    expect(radius(r)).toBe(8);
  });
  it('focus ring: accent, 2px (outline or box-shadow on the input focus state)', () => {
    const r = shellRules.filter((x) => x.sels.some((s) => /(^|[\s>])(\.lims-input|\.lims-field \.lims-input|input\.lims-input)(:focus-visible|:focus)$/.test(s) || /\.lims-input:focus(-visible)?$/.test(s)));
    const txt = r.flatMap((x) => x.decls.filter((d) => /^(outline|outline-color|box-shadow)$/.test(d.prop)).map((d) => d.value)).join(' ');
    expect(txt).toMatch(/var\(--lims-accent\)/);
    expect(txt).toMatch(/(^|[\s(])(2px|0\.125rem)/);
  });
  it('field label: 10.8px, weight 500, neutral.600, 4px gap above the control (also in a filter bar)', () => {
    for (const html of [field('<input class="lims-input" id="x">'), `<div class="lims-filter-bar">${field('<input class="lims-input" id="x">')}</div>`]) {
      const c = mount(html);
      const l = resolve(q(c, '.lims-label')); const f = resolve(q(c, '.lims-field'));
      expect(fs(l)).toBeCloseTo(XS, 5);
      expect(weight(l.get('font-weight'))).toBe(500);
      expect(col(l, 'color')).toBe('var(--lims-neutral-600)');
      expect(f.get('display')).toBe('flex'); expect(f.get('flex-direction')).toBe('column'); expect(px(f, 'row-gap')).toBe(4);
    }
  });
  it('the calendar icon of a date input sits inside the input at its right edge, not as a separate bordered box', () => {
    const c = mount(controls[4]![1]!);
    const grp = resolve(q(c, '.lims-input-group')); const icon = resolve(q(c, '[data-k="icon"]')); const inp = resolve(q(c, '.lims-input'));
    expect(grp.get('position')).toBe('relative');
    expect(icon.get('position')).toBe('absolute');
    expect(px(icon, 'right')).toBeGreaterThanOrEqual(0); expect(px(icon, 'right')).toBeLessThanOrEqual(8);
    expectNoBorder(icon);
    expect(['transparent', 'none']).toContain(col(icon, 'background-color'));
    expect(px(inp, 'padding-right'), 'room for the icon').toBeGreaterThanOrEqual(28);
    expect(px(inp, 'padding-left')).toBe(8);
  });
});

describe('(3) FILTERBAR (LD-442 DONE WHEN 3)', () => {
  const date = (n: string) => `<div class="lims-field lims-date-field"><label class="lims-label" for="${n}">${n}</label><div class="lims-input-group"><input class="lims-input" id="${n}" data-c="ctl"><button class="lims-btn lims-btn-ghost lims-icon-btn" data-c="icon">c</button></div></div>`;
  const bar = '<div class="lims-filter-bar" id="bar">'
    + '<div class="lims-field"><label class="lims-label" for="s">Status</label><button class="lims-input lims-select-trigger" id="s" data-c="ctl">s</button></div>'
    + '<div class="lims-field"><label class="lims-label" for="t">Search</label><input class="lims-input" id="t" type="search" data-c="ctl"></div>'
    + `<div class="lims-date-range" id="range"><div class="lims-inline" id="inline">${date('From')}${date('To')}</div></div>`
    + '<button class="lims-btn lims-btn-ghost" id="reset" data-c="btn">Reset</button><button class="lims-btn lims-btn-primary" id="apply" data-c="btn">Apply</button></div>';
  it('display flex, align-items flex-end, gap 8px', () => {
    const r = resolve(q(mount(bar), '#bar'));
    expect(r.get('display')).toBe('flex'); expect(r.get('align-items')).toBe('flex-end');
    expect(px(r, 'row-gap')).toBe(8); expect(px(r, 'column-gap')).toBe(8);
  });
  it('every control and button in the bar is 30px high, labels are above their controls', () => {
    const c = mount(bar);
    for (const e of c.querySelectorAll('[data-c="ctl"],[data-c="btn"]')) expectHeight(resolve(e), 30, false);
    for (const f of c.querySelectorAll('.lims-field')) expect(resolve(f).get('flex-direction')).toBe('column');
  });
  it('a From and To date pair is two 30px inputs on one baseline (the pair aligns to flex-end with the other controls)', () => {
    const c = mount(bar);
    const inline = resolve(q(c, '#inline'));
    expect(inline.get('display')).toBe('flex'); expect(inline.get('align-items')).toBe('flex-end'); expect(px(inline, 'column-gap')).toBe(8);
    expect(c.querySelectorAll('#inline input.lims-input').length).toBe(2);
    for (const i of c.querySelectorAll('#inline input.lims-input')) expectHeight(resolve(i), 30, false);
    expect(['flex-end', undefined]).toContain(resolve(q(c, '#range')).get('align-self'));
  });
  it('the reset action is a ghost button: transparent, accent text, no border', () => {
    const r = resolve(q(mount(bar), '#reset'));
    expect(['transparent', 'none']).toContain(col(r, 'background-color'));
    expect(col(r, 'color')).toBe('var(--lims-accent)'); expectNoBorder(r); expectHeight(r, 30, true);
  });
});

describe('(4) TABLES (LD-442 DONE WHEN 4)', () => {
  const table = (density: string, extra = '') => `<div class="lims-data-table"><div class="lims-table-scroll"><table class="lims-table lims-table-${density}${extra}"><thead><tr>`
    + '<th class="lims-col lims-align-start" data-k="th-start">Name</th><th class="lims-col lims-align-end lims-num" data-k="th-end">Amount</th><th class="lims-col lims-align-center" data-k="th-center">Flag</th><th class="lims-col" data-k="th-bare">Bare</th></tr></thead>'
    + '<tbody><tr class="lims-row" data-k="row"><td class="lims-cell lims-align-start" data-k="td-start">a</td><td class="lims-cell lims-align-end lims-num" data-k="td-end">1</td><td class="lims-cell lims-align-center">c</td><td class="lims-cell">d</td></tr>'
    + '<tr class="lims-row" data-selected="true" data-k="sel"><td class="lims-cell">a</td></tr><tr class="lims-row" data-hovered="true" data-k="hov"><td class="lims-cell">a</td></tr></tbody></table></div></div>';
  it.each(['compact', 'regular', 'comfortable'])('%s: th is start aligned, 0 12px, 10.8px / 14px, weight 500, neutral.600 on neutral.50, 1px neutral.200 under, nowrap', (d) => {
    const c = mount(table(d));
    for (const k of ['th-start', 'th-bare']) {
      const t = resolve(q(c, `[data-k="${k}"]`));
      expect(['start', 'left'], `${k} text-align`).toContain(t.get('text-align'));
    }
    const t = resolve(q(c, '[data-k="th-start"]'));
    expectPad(t, 0, 12, 0, 12);
    expect(fs(t)).toBeCloseTo(XS, 5);
    expect(px(t, 'line-height')).toBe(14);
    expect(weight(t.get('font-weight'))).toBe(500);
    expect(col(t, 'color')).toBe('var(--lims-neutral-600)');
    expect(col(t, 'background-color')).toBe('var(--lims-neutral-50)');
    const b = bordered(t, 'bottom'); expect(b).not.toBeNull(); expect(b!.w).toBe(1); expect(b!.c).toBe('var(--lims-neutral-200)');
    expect(t.get('white-space')).toBe('nowrap');
  });
  it('lims-align-end and lims-align-center keep their alignment on th and td, and lims-align-start exists (the centred header bug)', () => {
    const c = mount(table('regular'));
    expect(resolve(q(c, '[data-k="th-end"]')).get('text-align')).toBe('end');
    expect(resolve(q(c, '[data-k="th-center"]')).get('text-align')).toBe('center');
    expect(resolve(q(c, '[data-k="td-end"]')).get('text-align')).toBe('end');
    expect(['start', 'left']).toContain(resolve(q(c, '[data-k="th-start"]')).get('text-align'));
    expect(shellRules.some((r) => r.sels.some((s) => /\.lims-align-start\b/.test(s)) && r.decls.some((d) => d.prop === 'text-align' && /^(start|left)$/.test(d.value)))).toBe(true);
  });
  it.each(['compact', 'regular', 'comfortable'])('%s: td padding 0 12px, base size, 1px neutral.100 under, no own fill', (d) => {
    const c = mount(table(d));
    const t = resolve(q(c, '[data-k="td-start"]'));
    expectPad(t, 0, 12, 0, 12);
    expect(fs(t)).toBeCloseTo(BASE, 5);
    const b = bordered(t, 'bottom'); expect(b).not.toBeNull(); expect(b!.w).toBe(1); expect(b!.c).toBe('var(--lims-neutral-100)');
    expect(['transparent', 'none', undefined]).toContain(col(t, 'background-color'));
  });
  it('row height is 40px (regular) and 32px (compact); one height per table: header row and body row agree', () => {
    for (const [d, h] of [['regular', 40], ['compact', 32]] as const) {
      const c = mount(table(d));
      const body = resolve(q(c, '[data-k="row"]')); const head = resolve(q(c, 'thead tr'));
      for (const r of [body, head]) { expect(px(r, 'height')).toBe(h); expect(px(r, 'min-height')).toBe(h); }
      for (const k of ['td-start', 'th-start']) { const cell = resolve(q(c, `[data-k="${k}"]`)); expect(Number.isNaN(px(cell, 'height')) || px(cell, 'height') <= h).toBe(true); }
    }
  });
  it('the sticky header keeps neutral.50 (and the hairline)', () => {
    const c = mount(table('regular', ' lims-table-sticky'));
    const t = resolve(q(c, '[data-k="th-start"]'));
    expect(col(t, 'background-color')).toBe('var(--lims-neutral-50)');
    expect(bordered(t, 'bottom')?.c).toBe('var(--lims-neutral-200)');
  });
  it('numeric cells: end aligned with tabular figures', () => {
    const c = mount(table('regular'));
    const td = resolve(q(c, '[data-k="td-end"]'));
    expect(td.get('text-align')).toBe('end');
    const tab = [q(c, '[data-k="td-end"]'), q(c, 'table'), q(c, '.lims-data-table')].map((e) => resolve(e).get('font-variant-numeric'));
    expect(tab.some((v) => v === 'tabular-nums')).toBe(true);
  });
  it('row hover is neutral.50 and a selected row is accent.subtle (cells do not paint over it)', () => {
    const c = mount(table('regular'));
    expect(col(resolve(q(c, '[data-k="hov"]')), 'background-color')).toBe('var(--lims-neutral-50)');
    expect(col(resolve(q(c, '[data-k="sel"]')), 'background-color')).toBe('var(--lims-accent-subtle)');
    expect(['transparent', 'none', undefined]).toContain(col(resolve(q(c, '[data-k="sel"] td')), 'background-color'));
  });
  it('the table fills its card: width 100%, no outer border, and the header band runs edge to edge (card padding cancelled)', () => {
    const c = mount(table('regular'));
    const tb = resolve(q(c, 'table')); const dt = resolve(q(c, '.lims-data-table')); const sc = resolve(q(c, '.lims-table-scroll'));
    expect(tb.get('width')).toBe('100%');
    for (const r of [tb, dt, sc]) expectNoBorder(r);
    const cardPad = px(resolve(c), 'padding-left');
    const wrapMargin = [resolve(q(c, '.lims-data-table')), sc].map((r) => px(r, 'margin-left')).find((v) => !Number.isNaN(v) && v < 0);
    expect(wrapMargin !== undefined ? wrapMargin === -cardPad : cardPad === 0, `edge to edge: wrapper margin ${wrapMargin} vs card padding ${cardPad}`).toBe(true);
    const right = [resolve(q(c, '.lims-data-table')), sc].map((r) => px(r, 'margin-right')).find((v) => !Number.isNaN(v) && v < 0);
    expect(wrapMargin !== undefined ? right === -cardPad : true).toBe(true);
  });
  it('EmptyState, ErrorState and NotAvailable bodies sit in one full width row under the header', () => {
    const rules = shellRules.filter((r) => r.sels.some((s) => /\.lims-row-empty/.test(s)));
    expect(rules.length, 'a shell.css rule for .lims-row-empty (the one row the DataTable renders for these states)').toBeGreaterThan(0);
    const c = mount('<table class="lims-table lims-table-regular"><thead><tr><th>h</th></tr></thead><tbody><tr class="lims-row-empty" data-k="e"><td class="lims-cell" colspan="4" data-k="ec"><div class="lims-state"><p class="lims-state-title">t</p></div></td></tr></tbody></table>');
    const td = resolve(q(c, '[data-k="ec"]'));
    expect(td.get('overflow') === 'visible' || td.get('white-space') === 'normal' || td.has('padding-top')).toBe(true);
    expect(['start', 'left', 'center']).toContain(td.get('text-align') ?? 'start');
    expect(resolve(q(c, '[data-k="e"]')).get('display') ?? 'table-row').toBe('table-row');
  });
});

describe('(5) TABS (LD-442 DONE WHEN 5)', () => {
  const tabs = '<div class="lims-tablist" id="list"><div class="lims-tab" data-k="on" role="tab" aria-selected="true" data-selected="true">A<span class="lims-tab-badge" data-k="badge">3</span></div><div class="lims-tab" data-k="off" role="tab" aria-selected="false">B</div></div>';
  it('underline style: 32px high, no pill and no fill', () => {
    const c = mount(tabs);
    for (const k of ['on', 'off']) {
      const r = resolve(q(c, `[data-k="${k}"]`));
      expectHeight(r, 32, false);
      expect(radius(r)).toBeLessThan(TOKENS.radius.full!);
      expect(['transparent', 'none']).toContain(col(r, 'background-color'));
      for (const s of ['top', 'left', 'right']) expect(bordered(r, s), `${k} border-${s}`).toBeNull();
    }
  });
  it('selected tab: 2px accent underline, accent text, weight 500; other tabs neutral.600 and no visible underline', () => {
    const c = mount(tabs);
    const on = resolve(q(c, '[data-k="on"]')); const off = resolve(q(c, '[data-k="off"]'));
    const b = bordered(on, 'bottom'); const shadow = on.get('box-shadow') ?? '';
    const border = b !== null && b.w === 2 && b.c === 'var(--lims-accent)';
    const inset = /inset\s+0\s+-(2px|0\.125rem)\s+0\s+(0\s+)?var\(--lims-accent\)/.test(shadow);
    expect(border || inset, `underline: border-bottom ${JSON.stringify(b)} / box-shadow ${shadow}`).toBe(true);
    expect(col(on, 'color')).toBe('var(--lims-accent)');
    expect(weight(on.get('font-weight'))).toBe(500);
    expect(col(off, 'color')).toBe('var(--lims-neutral-600)');
    const ob = bordered(off, 'bottom'); expect(ob === null || ob.c === 'transparent').toBe(true);
    expect(/accent/.test(off.get('box-shadow') ?? '')).toBe(false);
  });
  it('count badge: small and neutral', () => {
    const r = resolve(q(mount(tabs), '[data-k="badge"]'));
    expect(fs(r)).toBeLessThanOrEqual(XS + 0.01);
    expect(col(r, 'background-color')).toBe('var(--lims-neutral-100)');
    expect(/accent/.test(col(r, 'color') ?? '')).toBe(false);
  });
  it('the tab strip has a 1px neutral.200 bottom hairline', () => {
    const b = bordered(resolve(q(mount(tabs), '#list')), 'bottom');
    expect(b).not.toBeNull(); expect(b!.w).toBe(1); expect(b!.c).toBe('var(--lims-neutral-200)');
  });
});

describe('(6) DESCRIPTIONLIST (LD-442 DONE WHEN 6)', () => {
  const dl = (cols: number) => `<dl class="lims-dl lims-cols-${cols}" id="dl"><div class="lims-dl-item" id="item"><dt id="dt">Label</dt><dd id="dd">Value</dd></div><div class="lims-dl-item"><dt>L2</dt><dd>V2</dd></div></dl>`;
  const cols = (m: Map<string, string>) => { const v = m.get('grid-template-columns') ?? ''; const r = /repeat\(\s*(\d+)/.exec(v); return r ? Number(r[1]) : splitTop(v, ' ').filter(Boolean).length; };
  it.each([1, 2, 3])('a grid of 2 columns below 80rem (columns prop %i)', (n) => {
    const r = resolve(q(mount(dl(n)), '#dl'), 1100);
    expect(r.get('display')).toBe('grid'); expect(cols(r)).toBe(2);
  });
  it.each([1, 2, 3])('3 columns from 80rem (columns prop %i)', (n) => {
    const r = resolve(q(mount(dl(n)), '#dl'), 1440);
    expect(r.get('display')).toBe('grid'); expect(cols(r)).toBe(3);
  });
  it('each pair: label (10.8px, weight 500, neutral.600) above value (base, weight 400, neutral.900)', () => {
    const c = mount(dl(2));
    const dt = resolve(q(c, '#dt')); const dd = resolve(q(c, '#dd')); const item = resolve(q(c, '#item'));
    expect(fs(dt)).toBeCloseTo(XS, 5); expect(weight(dt.get('font-weight'))).toBe(500); expect(col(dt, 'color')).toBe('var(--lims-neutral-600)');
    expect(fs(dd)).toBeCloseTo(BASE, 5); expect(weight(dd.get('font-weight'))).toBe(400); expect(col(dd, 'color')).toBe('var(--lims-neutral-900)');
    for (const e of [dt, dd]) expect(['inline', 'inline-block', 'inline-flex']).not.toContain(e.get('display'));
    expect(item.get('display') === 'flex' ? item.get('flex-direction') : 'column').toBe('column');
  });
  it('a 1px neutral.100 hairline under each row and equal row gaps', () => {
    const c = mount(dl(2));
    const item = resolve(q(c, '#item')); const grid = resolve(q(c, '#dl'));
    const b = bordered(item, 'bottom'); expect(b).not.toBeNull(); expect(b!.w).toBe(1); expect(b!.c).toBe('var(--lims-neutral-100)');
    expect(px(grid, 'row-gap')).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(px(grid, 'row-gap')), 'one explicit row gap').toBe(false);
    expect(Number.isNaN(px(item, 'margin-bottom')) || px(item, 'margin-bottom') === 0, 'no extra per row margin on top of the grid gap').toBe(true);
  });
});
