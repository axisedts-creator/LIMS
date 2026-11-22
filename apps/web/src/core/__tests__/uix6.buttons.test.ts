// T0D-UIX-6 (LD-444, LD-442, LD-438; founder order 2026-11-22 11:07 NPT "buttons colourful on every screen"): staff web button colour BY ROLE.
// Same method as uix1.look.test.ts: parse kit.css then shell.css as text, build DOM fixtures with the kit's real class lists, compute the winning
// declaration per property with a real cascade (important, specificity, source order) for four states: rest, hover, focus (focus-visible), visited.
// Only shell.css may change (kit.css and tokens.json are NOT edited). Values are asserted, never the selector spelling.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const KIT_CSS = readFileSync(join(ROOT, 'packages', 'ui', 'src', 'components', 'kit.css'), 'utf8');
const SHELL_CSS = readFileSync(join(import.meta.dirname, '..', 'shell', 'shell.css'), 'utf8');

/* ---------- css parsing (as uix1) ---------- */
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

/* ---------- cascade with element states ---------- */
type State = 'rest' | 'hover' | 'focus' | 'visited';
// A selector that names a state pseudo-class applies only in that state (the pseudo is then treated as true); :link/:any-link are always true on <a href>.
const STATE_RE = /:(hover|focus-visible|focus-within|focus|active|visited)(?![\w-])/g;
const LINK_RE = /:(any-link|link)(?![\w-])/g;
const stateOf = (p: string): State | 'other' => (p === 'hover' ? 'hover' : p === 'focus-visible' || p === 'focus' ? 'focus' : p === 'visited' ? 'visited' : 'other');
function applies(sel: string, state: State): string | null {
  const pseudos = [...sel.matchAll(STATE_RE)].map((m) => stateOf(m[1]));
  if (pseudos.some((p) => p !== state)) return null;
  return sel.replace(STATE_RE, '').replace(LINK_RE, '');
}
function matches(el: Element, sel: string): boolean { try { return el.matches(sel); } catch { return false; } }
const BOX = ['top', 'right', 'bottom', 'left'] as const;
function box(v: string): string[] {
  const p = splitTop(v.replace(/\s+/g, ' ').trim(), ' ');
  return p.length === 1 ? [p[0], p[0], p[0], p[0]] : p.length === 2 ? [p[0], p[1], p[0], p[1]] : p.length === 3 ? [p[0], p[1], p[2], p[1]] : p.slice(0, 4);
}
function borderParts(v: string): { w: string; s: string; c: string } {
  let w = 'medium'; let s = 'none'; let c = 'currentcolor';
  for (const t of splitTop(v.trim(), ' ')) {
    if (/^(none|solid|dashed|dotted|hidden)$/.test(t)) s = t;
    else if (/^(-?[\d.]+(px|rem)?|thin|medium|thick)$/.test(t)) w = t;
    else if (t) c = t;
  }
  if (s === 'none' && v.trim() !== 'none' && v.trim() !== '0') s = 'solid';
  return { w, s, c };
}
function setProp(m: Map<string, string>, prop: string, v: string) {
  const sides = (pre: string, val: string) => box(val).forEach((x, i) => m.set(`${pre}-${BOX[i]}`, x));
  if (prop === 'padding' || prop === 'margin') sides(prop, v);
  else if (prop === 'border') { const b = borderParts(v); BOX.forEach((s) => { m.set(`border-${s}-width`, b.w); m.set(`border-${s}-style`, b.s); m.set(`border-${s}-color`, b.c); }); }
  else if (/^border-(top|right|bottom|left)$/.test(prop)) { const b = borderParts(v); m.set(`${prop}-width`, b.w); m.set(`${prop}-style`, b.s); m.set(`${prop}-color`, b.c); }
  else if (prop === 'border-width' || prop === 'border-style' || prop === 'border-color') box(v).forEach((x, i) => m.set(`border-${BOX[i]}-${prop.slice(7)}`, x));
  else if (prop === 'background') m.set('background-color', v);
  else if (prop === 'text-decoration') { m.set('text-decoration-line', v.split(' ')[0]); }
  else if (prop === 'outline') { const b = borderParts(v); m.set('outline-width', b.w); m.set('outline-style', b.s); m.set('outline-color', b.c); }
  else m.set(prop, v);
}
function resolve(el: Element, state: State = 'rest'): Map<string, string> {
  const isButton = el.tagName === 'BUTTON';
  const added: string[] = [];
  if (isButton && state === 'hover') { el.setAttribute('data-hovered', 'true'); added.push('data-hovered'); } // react-aria sets this next to :hover
  if (isButton && state === 'focus') { el.setAttribute('data-focus-visible', 'true'); added.push('data-focus-visible'); }
  const hits: { d: Decl; spec: number; order: number; i: number }[] = [];
  for (const r of allRules) {
    if (r.media) continue; // button rules are not media dependent
    let spec = -1;
    for (const s of r.sels) {
      const test = applies(s, state);
      if (test !== null && matches(el, test)) spec = Math.max(spec, specificity(s));
    }
    if (spec < 0) continue;
    r.decls.forEach((d, i) => hits.push({ d, spec, order: r.order, i }));
  }
  added.forEach((a) => el.removeAttribute(a));
  hits.sort((a, b) => Number(a.d.important) - Number(b.d.important) || a.spec - b.spec || a.order - b.order || a.i - b.i);
  const m = new Map<string, string>();
  for (const h of hits) setProp(m, h.d.prop, h.d.value);
  return m;
}

/* ---------- value helpers ---------- */
const len = (v: string | undefined): number => { const m = /^(-?[\d.]+)px$/.exec((v ?? '').trim()); return m ? Number(m[1]) : (v ?? '').trim() === '0' ? 0 : NaN; };
const bg = (m: Map<string, string>) => m.get('background-color');
const fg = (m: Map<string, string>) => m.get('color');
function side(m: Map<string, string>, s: string): { w: number; c: string } | null {
  const w = len(m.get(`border-${s}-width`)); const st = m.get(`border-${s}-style`) ?? 'none';
  if (st === 'none' || st === 'hidden' || !(w > 0)) return null;
  return { w, c: m.get(`border-${s}-color`) ?? '' };
}
const expectBorderOf = (m: Map<string, string>, ok: (c: string) => boolean, label: string) => {
  for (const s of BOX) { const b = side(m, s); expect(b, `${label} border-${s}`).not.toBeNull(); expect(b!.w, `${label} border-${s} width`).toBe(1); expect(ok(b!.c), `${label} border-${s} colour ${b!.c}`).toBe(true); }
};
const expectNoBorder = (m: Map<string, string>, label: string) => { for (const s of BOX) expect(side(m, s), `${label} border-${s}`).toBeNull(); };
const tok = (...names: string[]) => (c: string) => names.some((n) => c === `var(--lims-${n})`);
// "accent tint": the subtle / highlight / brand tokens, or a colour-mix of the accent token (the kit has no tint steps between accent.subtle and accent)
const isTint = (c: string | undefined) => !!c && (/^var\(--lims-accent-(subtle|highlight|brand)\)$/.test(c) || /^color-mix\(.*var\(--lims-accent(-subtle|-highlight|-brand)?\).*\)$/.test(c));
const isTone = (c: string | undefined) => !!c && c !== 'var(--lims-accent-subtle)' && isTint(c); // a tint that is not the plain subtle fill
const BASE = 12.6;
const fsize = (m: Map<string, string>) => { const v = m.get('font-size'); return v === 'var(--lims-font-size-base-size)' ? BASE : len(v); }; // shell.css :root sets base-size to 12.6px (pinned by uix1)

/* ---------- fixtures ---------- */
function mount(html: string, shell = true): HTMLElement {
  document.body.innerHTML = shell
    ? `<div class="lims-density" data-density="regular"><div class="lims-shell"><div class="lims-shell-body"><main class="lims-shell-main"><div class="lims-card" id="card">${html}</div></main></div></div></div>`
    : `<div class="lims-auth-card" id="card">${html}</div>`;
  return document.getElementById('card')!;
}
const first = (root: ParentNode) => root.firstElementChild as HTMLElement;
const btn = (cls: string, extra = '') => `<button class="lims-btn ${cls}" ${extra}>b</button>`;
const link = (cls: string) => `<a class="lims-btn ${cls}" href="/x">a</a>`;
const R = (html: string, state: State = 'rest') => resolve(first(mount(html)), state);

describe('guards: kit untouched, tokens only, no new !important on buttons (LD-444)', () => {
  it('kit.css has no secondary tint and still has its base pill button (display only change lives in shell.css)', () => {
    expect(KIT_CSS).toMatch(/\.lims-btn \{[^}]*min-height: 48px;[^}]*border-radius: var\(--lims-radius-full\)/);
    expect(KIT_CSS).not.toMatch(/lims-btn-secondary[^{]*\{[^}]*accent-subtle/);
  });
  it('shell.css button rules use no hex, rgb or hsl literal', () => {
    const s = strip(SHELL_CSS);
    expect(s.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(s.match(/\b(rgb|rgba|hsl|hsla)\(/g) ?? []).toEqual([]);
  });
  it('no !important on any button rule (.lims-btn* / .lims-icon-btn) in shell.css', () => {
    const offenders = shellRules.filter((r) => r.sels.some((s) => /\.lims-(btn|icon-btn)/.test(s)) && r.decls.some((d) => d.important)).map((r) => r.sels.join(', '));
    expect(offenders).toEqual([]);
  });
  it('the look is staff web only: outside .lims-shell (auth card) a secondary button keeps the kit white fill and the pill', () => {
    const m = resolve(first(mount(btn('lims-btn-secondary'), false)));
    expect(bg(m)).toBe('var(--lims-neutral-0)');
    expect(m.get('border-radius')).toBe('var(--lims-radius-full)');
    expect(m.get('height')).toBeUndefined();
  });
});

describe('(1) primary: solid accent fill, white text, 1px accent border, hover one step darker', () => {
  it.each(['button', 'link'])('%s rest', (k) => {
    const m = R(k === 'button' ? btn('lims-btn-primary') : link('lims-btn-primary'));
    expect(bg(m)).toBe('var(--lims-accent)');
    expect(['var(--lims-accent-fg)', 'var(--lims-neutral-0)']).toContain(fg(m));
    expectBorderOf(m, tok('accent'), 'primary');
  });
  it.each(['button', 'link'])('%s hover: accent.hover fill, white text, 1px accent or accent.hover border', (k) => {
    const m = R(k === 'button' ? btn('lims-btn-primary') : link('lims-btn-primary'), 'hover');
    expect(bg(m)).toBe('var(--lims-accent-hover)');
    expect(['var(--lims-accent-fg)', 'var(--lims-neutral-0)']).toContain(fg(m));
    expectBorderOf(m, tok('accent', 'accent-hover'), 'primary hover');
  });
  it('small primary keeps the accent fill and 24px height', () => {
    const m = R(btn('lims-btn-primary lims-btn-sm'));
    expect(bg(m)).toBe('var(--lims-accent)');
    expect(m.get('height')).toBe('24px');
  });
});

describe('(3) secondary (the default variant): accent.subtle fill, accent text, 1px accent tint border, hover one step darker', () => {
  it.each(['button', 'link'])('%s rest: accent.subtle fill, accent text, 1px accent tint border (not the neutral grey, not the fill itself)', (k) => {
    const m = R(k === 'button' ? btn('lims-btn-secondary') : link('lims-btn-secondary'));
    expect(bg(m)).toBe('var(--lims-accent-subtle)');
    expect(fg(m)).toBe('var(--lims-accent)');
    expectBorderOf(m, (c) => isTone(c), 'secondary');
  });
  it.each(['button', 'link'])('%s hover: a darker tint than the rest fill, still an accent tint, accent (or accent.hover) text, 1px accent tint border', (k) => {
    const el = k === 'button' ? btn('lims-btn-secondary') : link('lims-btn-secondary');
    const m = R(el, 'hover');
    expect(isTone(bg(m)), `hover fill ${bg(m)}`).toBe(true);
    expect(bg(m)).not.toBe(bg(R(el)));
    expect(['var(--lims-accent)', 'var(--lims-accent-hover)']).toContain(fg(m));
    expectBorderOf(m, (c) => isTint(c) || tok('accent', 'accent-hover')(c), 'secondary hover');
  });
  it('disabled: neutral.100 fill, neutral.500 text, no accent tint anywhere, also on hover', () => {
    for (const state of ['rest', 'hover'] as const) {
      const m = R(btn('lims-btn-secondary', 'disabled data-disabled="true"'), state);
      expect(bg(m), `${state} fill`).toBe('var(--lims-neutral-100)');
      expect(fg(m), `${state} text`).toBe('var(--lims-neutral-500)');
      for (const s of BOX) { const b = side(m, s); expect(b === null || /neutral/.test(b.c), `${state} border-${s} ${b?.c}`).toBe(true); }
    }
  });
  it('native disabled without data-disabled (kit DataTable pager) keeps neutral.100 / neutral.500 on hover too', () => {
    for (const state of ['rest', 'hover'] as const) {
      const m = R(btn('lims-btn-secondary lims-btn-sm', 'disabled'), state);
      expect(bg(m), `${state} fill`).toBe('var(--lims-neutral-100)');
      expect(fg(m), `${state} text`).toBe('var(--lims-neutral-500)');
    }
  });
  it('small secondary (pagination Previous / Next) keeps the tint and 24px height', () => {
    const m = R(btn('lims-btn-secondary lims-btn-sm'));
    expect(bg(m)).toBe('var(--lims-accent-subtle)');
    expect(m.get('height')).toBe('24px');
  });
});

describe('(4) ghost: accent text, no border, hover accent.subtle', () => {
  it.each(['button', 'link'])('%s rest: transparent, accent text, no border', (k) => {
    const m = R(k === 'button' ? btn('lims-btn-ghost') : link('lims-btn-ghost'));
    expect(['transparent', 'none']).toContain(bg(m));
    expect(fg(m)).toBe('var(--lims-accent)');
    expectNoBorder(m, 'ghost');
  });
  it.each(['button', 'link'])('%s hover: accent.subtle fill, accent text, still no border', (k) => {
    const m = R(k === 'button' ? btn('lims-btn-ghost') : link('lims-btn-ghost'), 'hover');
    expect(bg(m)).toBe('var(--lims-accent-subtle)');
    expect(fg(m)).toBe('var(--lims-accent)');
    expectNoBorder(m, 'ghost hover');
  });
});

describe('(5) danger: solid danger fill with white text', () => {
  it.each(['button', 'link'])('%s rest and hover: tone.danger.fg fill, white text, border none or 1px the same colour', (k) => {
    for (const state of ['rest', 'hover'] as const) {
      const m = R(k === 'button' ? btn('lims-btn-danger') : link('lims-btn-danger'), state);
      expect(bg(m), `${state} fill`).toBe('var(--lims-tone-danger-fg)');
      expect(fg(m), `${state} text`).toBe('var(--lims-neutral-0)');
      for (const s of BOX) { const b = side(m, s); expect(b === null || (b.w === 1 && b.c === 'var(--lims-tone-danger-fg)'), `${state} border-${s}`).toBe(true); }
    }
  });
});

describe('(6) icon buttons: accent icon, hover accent.subtle', () => {
  it.each(['lims-btn-ghost', 'lims-btn-secondary'])('%s lims-icon-btn: accent colour at rest (the icon draws with currentColor), accent.subtle on hover', (v) => {
    const el = btn(`${v} lims-icon-btn`);
    expect(fg(R(el))).toBe('var(--lims-accent)');
    const h = R(el, 'hover');
    expect(bg(h)).toBe('var(--lims-accent-subtle)');
    expect(fg(h)).toBe('var(--lims-accent)');
  });
  it('the calendar button inside a date field stays an accent icon inside the input, no box of its own', () => {
    const c = mount('<div class="lims-field lims-date-field"><div class="lims-input-group"><input class="lims-input"><button class="lims-btn lims-btn-ghost lims-icon-btn" data-k="i">c</button></div></div>');
    const m = resolve(c.querySelector('[data-k="i"]')!);
    expect(fg(m)).toBe('var(--lims-accent)');
    expectNoBorder(m, 'calendar icon');
  });
});

describe('(2) link-buttons are never underlined (rest, hover, focus, visited)', () => {
  const variants = ['', 'lims-btn-primary', 'lims-btn-secondary', 'lims-btn-ghost', 'lims-btn-danger', 'lims-btn-secondary lims-btn-sm'];
  const states: State[] = ['rest', 'hover', 'focus', 'visited'];
  it.each(variants.flatMap((v) => states.map((s) => [v || 'lims-btn', s] as const)))('a.lims-btn %s in %s: text-decoration none', (v, state) => {
    const m = R(link(v === 'lims-btn' ? '' : v), state);
    expect(m.get('text-decoration-line'), `text-decoration in ${state}`).toBe('none');
  });
  it('a.lims-btn-primary alone (without the .lims-btn class) is not underlined either', () => {
    for (const state of states) expect(R('<a class="lims-btn-primary" href="/x">a</a>', state).get('text-decoration-line'), state).toBe('none');
  });
});

describe('(7) focus-visible on every button: 2px accent outline, 1px offset', () => {
  const kinds: [string, string][] = [
    ['primary', btn('lims-btn-primary')], ['secondary', btn('lims-btn-secondary')], ['ghost', btn('lims-btn-ghost')], ['danger', btn('lims-btn-danger')],
    ['icon ghost', btn('lims-btn-ghost lims-icon-btn')], ['icon secondary', btn('lims-btn-secondary lims-icon-btn')], ['small', btn('lims-btn-secondary lims-btn-sm')],
    ['link primary', link('lims-btn-primary')], ['link secondary', link('lims-btn-secondary')], ['link ghost', link('lims-btn-ghost')],
  ];
  it.each(kinds)('%s', (_n, html) => {
    const m = R(html, 'focus');
    expect(m.get('outline-style'), 'outline-style').toBe('solid');
    expect(len(m.get('outline-width')), 'outline-width').toBe(2);
    expect(['var(--lims-accent)', 'var(--lims-focus-ring)']).toContain(m.get('outline-color')); // --lims-focus-ring is the accent alias in tokens.json
    expect(len(m.get('outline-offset')), 'outline-offset').toBe(1);
  });
});

describe('(8) size, radius, type stay exactly as T0D-UIX-1 set them on every variant, button and link', () => {
  const variants = ['lims-btn-primary', 'lims-btn-secondary', 'lims-btn-ghost', 'lims-btn-danger'];
  it.each(variants.flatMap((v) => [[v, 'button'], [v, 'link']] as const))('%s %s: 30px, radius 8px, 12.6px, weight 500; small 24px', (v, k) => {
    const mk = (extra: string) => (k === 'button' ? btn(`${v}${extra}`) : link(`${v}${extra}`));
    for (const state of ['rest', 'hover'] as const) {
      const m = R(mk(''), state);
      expect(len(m.get('height')), `${state} height`).toBe(30);
      expect(len(m.get('min-height')), `${state} min-height`).toBe(30);
      expect(m.get('border-radius'), `${state} radius`).toBe('var(--lims-radius-sm)');
      expect(fsize(m), `${state} font-size`).toBeCloseTo(BASE, 5);
      expect(m.get('font-weight'), `${state} weight`).toBe('var(--lims-font-weight-medium)');
    }
    const s = R(mk(' lims-btn-sm'));
    expect(len(s.get('height'))).toBe(24); expect(len(s.get('min-height'))).toBe(24);
  });
});
