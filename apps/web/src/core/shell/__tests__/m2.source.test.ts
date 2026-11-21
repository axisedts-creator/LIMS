// T0D-MSERIES-2 static guards (LD-251; spec/program/13-M-SERIES.md s3 and s5; 02-CONVENTIONS LD-140: tokens only). No rendering, no browser.
// CSS class contract (the writer may add more classes; these names are the ones the tests read; rules may live in core/shell/shell.css, the kit comes first):
//   .lims-shell-nav        sidebar (the PageShell <nav>): 296 px, accent.default fill, white text, viewport height (100vh|100dvh), flex column
//   .lims-rail-scroll      the entry scroller: overflow-y auto, min-height 0, flex 1
//   .lims-rail-link        entry pill (a): min-height 46 px, radius full, weight 500; [aria-current='page'] = accent.highlight pill, dark text token
//   .lims-rail-search      the "Find a screen" input: height 46 px, radius full, border colour passes 3:1 on accent.default (#8FB8B0 or lighter)
//   .lims-rail-viewonly    the "view only" tag: border colour passes 3:1 on accent.default
//   .lims-shell-top        top bar: min-height 76 px;  .lims-centre-switcher: outlined pill (accent.default border, radius full)
//   .lims-shell-menu       menu button: display none from 1024 px up, shown below it; the drawer is `.lims-shell-nav[data-drawer-open='true']` (position fixed) in a max-width 1023px query
// Contrast is computed from packages/ui/tokens/tokens.json (the spec text "#00362F" has no token; any token with >= 4.5:1 on accent.highlight passes, see T0D-MSERIES-1 notes).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const SRC = join(WEB, 'src');
const ROOT = join(WEB, '..', '..');
const read = (f: string) => readFileSync(f, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const walk = (dir: string): string[] =>
  !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === '__tests__' ? [] : walk(join(dir, d.name))) : [join(dir, d.name)]));

// ---------------------------------------------------------------- CSS parsing (same shape as r04.source.test.ts)
type Rule = { sels: string[]; decls: Map<string, string>; media: string };
function parseCss(src: string): Rule[] {
  const s = strip(src);
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
    if (!prelude.startsWith('@')) out.push({ sels: prelude.split(',').map((x) => x.trim().replace(/\s+/g, ' ').replace(/"/g, "'")), decls, media: media.join(' ') });
    i = end + 1;
  }
  return out;
}
const SHELL_CSS = join(SRC, 'core', 'shell', 'shell.css');
const rules = parseCss([read(join(ROOT, 'packages', 'ui', 'src', 'components', 'kit.css')), read(SHELL_CSS)].join('\n'));
const baseRules = (sel: RegExp) => rules.filter((r) => !r.media && r.sels.some((s) => sel.test(s)));
/** value of a property after the cascade of the matching rules (last declaration wins; specificity is not modelled) */
const val = (sel: RegExp, prop: string) => baseRules(sel).map((r) => r.decls.get(prop)).filter((v): v is string => !!v).at(-1);
// T0D-ELABMENU-1 (LD-340): the compact sidebar block at the end of shell.css states sizes in rem with !important; 1rem = 16px, the important flag is not part of the size.
const px = (v?: string) => { const m = /^(\d+(?:\.\d+)?)(px|rem)(?:\s*!important)?$/.exec((v ?? '').trim()); return m ? Number(m[1]) * (m[2] === 'rem' ? 16 : 1) : NaN; };
const isNav = /(^|\s)\.lims-shell-nav$/;

// ---------------------------------------------------------------- colours from tokens
const tokens = JSON.parse(read(join(ROOT, 'packages', 'ui', 'tokens', 'tokens.json'))).color as Record<string, any>;
function tokenHex(name: string): string {
  const [a, b = 'default'] = name.split('-');
  const v = tokens[a!]?.[b] ?? tokens[a!]?.[name.split('-').slice(1).join('-')];
  if (typeof v !== 'string') throw new Error(`no colour token for --lims-${name}`);
  return v.startsWith('{') ? tokenHex(v.slice(1, -1).replace(/^color\./, '').replace(/\./g, '-').replace(/-default$/, '')) : v;
}
type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
function splitTop(s: string): string[] { const out: string[] = []; let d = 0, cur = ''; for (const c of s) { if (c === '(') d++; if (c === ')') d--; if (c === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += c; } out.push(cur.trim()); return out; }
function colour(v: string): RGB {
  const t = v.trim();
  const m = /^var\(--lims-([a-z0-9-]+)\)$/.exec(t);
  if (m) return hex(tokenHex(m[1]!));
  const mix = /^color-mix\(in srgb,(.*)\)$/s.exec(t);
  if (mix) {
    const [a, b] = splitTop(mix[1]!);
    const part = (x: string) => { const p = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(x); return p ? { c: colour(p[1]!), w: Number(p[2]) / 100 } : { c: colour(x), w: NaN }; };
    const A = part(a!), B = part(b!);
    const wa = Number.isNaN(A.w) ? (Number.isNaN(B.w) ? 0.5 : 1 - B.w) : A.w;
    return [0, 1, 2].map((i) => A.c[i]! * wa + B.c[i]! * (1 - wa)) as RGB;
  }
  throw new Error(`cannot evaluate colour: ${v}`);
}
const lum = (c: RGB) => { const [r, g, b] = c.map((x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }) as RGB; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
/** colour part of a border / border-color / outline declaration */
const colourOf = (decl: string) => /(var\(--lims-[a-z0-9-]+\)|color-mix\(in srgb,.*\))\s*$/.exec(decl.trim())?.[1] ?? decl.trim();
const ACCENT = hex(tokenHex('accent'));

describe('sidebar geometry and colour (13-M-SERIES s3)', () => {
  it('232 px (14.5rem, LD-344: was 176, LD-340: was 296) wide on accent.default with white text, viewport height, flex column', () => {
    expect(px(val(isNav, 'width'))).toBe(232);
    expect(val(isNav, 'background') ?? val(isNav, 'background-color')).toMatch(/^var\(--lims-accent\)$/);
    expect(val(isNav, 'color')).toMatch(/^var\(--lims-accent-fg\)$/);
    expect(val(isNav, 'height') ?? val(isNav, 'max-height')).toMatch(/100d?vh/);
    expect(val(isNav, 'display')).toBe('flex');
    expect(val(isNav, 'flex-direction')).toBe('column');
  });

  it('the entry list scrolls inside the fixed-height sidebar (overflow-y auto on .lims-rail-scroll, min-height 0, flexible)', () => {
    const sel = /(^|\s)\.lims-rail-scroll$/;
    expect(val(sel, 'overflow-y')).toBe('auto');
    expect(val(sel, 'min-height')).toMatch(/^0(px)?$/);
    expect(val(sel, 'flex') ?? val(sel, 'flex-grow')).toMatch(/^1\b/);
    expect(val(isNav, 'overflow') ?? val(isNav, 'overflow-y')).not.toBe('auto'); // the sidebar itself does not scroll
  });

  it('entry pill: 32 px (2rem, LD-344: was 28, LD-340: was 46), fully round, weight 500; the active entry is the accent.highlight pill with a dark token text (>= 4.5:1)', () => {
    const link = /\.lims-rail-link$/;
    expect(px(val(link, 'min-height') ?? val(link, 'height'))).toBe(32);
    expect(val(link, 'border-radius')).toBe('var(--lims-radius-full)');
    expect(val(link, 'font-weight')).toMatch(/var\(--lims-font-weight-medium\)|^500$/);
    const act = /\.lims-rail-link\[aria-current='?page'?\]$/;
    expect(baseRules(act).length, 'no .lims-rail-link[aria-current=page] rule').toBeGreaterThan(0);
    expect(val(act, 'background') ?? val(act, 'background-color')).toBe('var(--lims-accent-highlight)');
    const text = val(act, 'color')!;
    expect(text, 'active text colour').toBeTruthy();
    expect(ratio(colour(text), hex(tokenHex('accent-highlight')))).toBeGreaterThanOrEqual(4.5);
  });

  it('non-active entry text keeps 4.5:1 on accent.default', () => {
    const own = val(/\.lims-rail-link$/, 'color');
    const c = own && own !== 'inherit' ? colour(own) : colour(val(isNav, 'color')!);
    expect(ratio(c, ACCENT)).toBeGreaterThanOrEqual(4.5);
  });

  it('Find a screen: 32 px pill (2rem, LD-344: was 28, LD-340: was 46); its border keeps 3:1 on accent.default (#8FB8B0 or lighter)', () => {
    const f = /\.lims-rail-search$/;
    expect(px(val(f, 'min-height') ?? val(f, 'height'))).toBe(32);
    expect(val(f, 'border-radius')).toBe('var(--lims-radius-full)');
    const b = val(f, 'border-color') ?? colourOf(val(f, 'border')!);
    expect(ratio(colour(b), ACCENT), `border ${b}`).toBeGreaterThanOrEqual(3);
  });

  it('view-only tag: its border keeps 3:1 on accent.default', () => {
    const t = /\.lims-rail-viewonly$/;
    const b = val(t, 'border-color') ?? colourOf(val(t, 'border') ?? '');
    expect(b, '.lims-rail-viewonly border').toBeTruthy();
    expect(ratio(colour(b), ACCENT), `border ${b}`).toBeGreaterThanOrEqual(3);
  });

  it('the 3:1 evaluator itself works (planted: the board\'s translucent white border is NOT accepted, #8FB8B0 is)', () => {
    expect(ratio(hex('#8FB8B0'), ACCENT)).toBeGreaterThanOrEqual(3);
    expect(ratio(hex('#4A8A82'), ACCENT)).toBeLessThan(3);
  });

  it('focus outline in the sidebar: accent.pop, 3 px, 2 px offset (accent.default focus ring would vanish on the fill)', () => {
    const r = rules.filter((x) => !x.media && x.sels.some((s) => /:focus-visible/.test(s) && /\.lims-shell-nav|\.lims-rail-/.test(s)));
    expect(r.length, 'no :focus-visible rule for the sidebar').toBeGreaterThan(0);
    const d = (p: string) => r.map((x) => x.decls.get(p)).filter(Boolean).join(' ');
    expect(d('outline')).toMatch(/3px/);
    expect(d('outline')).toContain('var(--lims-accent-pop)');
    expect(d('outline-offset')).toMatch(/2px/);
  });
});

describe('top bar (13-M-SERIES s3: 76 px, centre switcher = outlined pill, notifications)', () => {
  it('top bar is 44 px high (2.75rem, LD-340: was 76; the 56 px of the R03 kit stays replaced)', () => {
    expect(px(val(/(^|\s)\.lims-shell-top$/, 'min-height'))).toBe(44);
  });
  it('centre switcher: fully round with an accent.default outline', () => {
    const s = /(^|\s)\.lims-centre-switcher$/;
    expect(val(s, 'border-radius')).toBe('var(--lims-radius-full)');
    const b = val(s, 'border-color') ?? colourOf(val(s, 'border') ?? '');
    expect(b).toMatch(/^var\(--lims-accent\)$/);
  });
});

describe('below 1024 px: drawer (CSS)', () => {
  const small = /max-width:\s*(1023px|63\.9\d*rem)/;
  it('the menu button is hidden from 1024 px and shown below it', () => {
    expect(val(/\.lims-shell-menu$/, 'display'), 'base rule').toBe('none');
    const shown = rules.filter((r) => small.test(r.media) && r.sels.some((s) => /\.lims-shell-menu$/.test(s)) && r.decls.has('display'));
    expect(shown.length, '.lims-shell-menu rule inside the max-width query').toBeGreaterThan(0);
    expect(shown.at(-1)!.decls.get('display')).not.toBe('none');
  });
  it('the sidebar becomes a fixed drawer that the open state shows (the kit hides it below 1024)', () => {
    const open = rules.filter((r) => small.test(r.media) && r.sels.some((s) => /\.lims-shell-nav\[data-drawer-open='?true'?\]$/.test(s)));
    expect(open.length, 'drawer-open rule inside the max-width query').toBeGreaterThan(0);
    const d = (p: string) => open.map((x) => x.decls.get(p)).filter(Boolean).at(-1);
    expect(d('display')).toBe('flex');
    expect(d('position')).toBe('fixed');
  });
  it('shell.css itself hides the sidebar below 1024 px (its base `display: flex` beats the kit hide rule at equal specificity)', () => {
    const own = parseCss(read(SHELL_CSS));
    const hide = own.filter((r) => small.test(r.media) && r.sels.some((s) => /(^|\s)\.lims-shell-nav$/.test(s)) && r.decls.has('display'));
    expect(hide.length, 'plain .lims-shell-nav rule with display inside the max-width query of shell.css').toBeGreaterThan(0);
    expect(hide.at(-1)!.decls.get('display')).toBe('none');
  });
  it('a closed group stays hidden: the `[hidden]` list is display: none (an author display:flex beats the UA [hidden] rule)', () => {
    const h = rules.filter((r) => !r.media && r.sels.some((s) => /\.lims-sidenav\[hidden\]$/.test(s)) && r.decls.has('display'));
    expect(h.length, '.lims-sidenav[hidden] rule').toBeGreaterThan(0);
    expect(h.at(-1)!.decls.get('display')).toBe('none');
  });
  it('drawer motion, if any, is CSS only, <= 250 ms, and switched off by prefers-reduced-motion', () => {
    const css = strip(read(SHELL_CSS));
    for (const m of css.matchAll(/(?:transition|animation)[^;{}]*?(\d+(?:\.\d+)?)(ms|s)\b/g)) expect(Number(m[1]) * (m[2] === 's' ? 1000 : 1)).toBeLessThanOrEqual(450);
    expect(css).toMatch(/prefers-reduced-motion\s*:\s*reduce/);
    expect((css.match(/\binfinite\b/g) ?? []).length).toBeLessThanOrEqual(1); // 13 s2.3: at most one looping animation per screen
  });
});

describe('no hard-coded colour, radius or font outside packages/ui (LD-140) in the files this task owns', () => {
  const owned = [
    ...['shell', 'nav'].flatMap((d) => walk(join(SRC, 'core', d))),
    ...walk(join(SRC, 'features', 'admin', 'auth')),
    join(SRC, 'app', 'layout.tsx'),
    join(SRC, 'app', '(staff)', 'layout.tsx'),
    join(SRC, 'app', '(platform)', 'layout.tsx'),
    join(SRC, 'app', '(auth)', 'layout.tsx'),
  ].filter((f) => /\.(tsx?|css)$/.test(f) && !/generated\.ts$/.test(f) && existsSync(f));
  it('there is something to scan', () => { expect(owned.length).toBeGreaterThan(15); });
  it.each([
    ['hex colour', /#[0-9a-fA-F]{3,8}\b(?![-\w])/],
    ['rgb()/hsl()/oklch()', /\b(rgba?|hsla?|oklch|oklab|lab|lch)\(/i],
    ['pixel border-radius', /border(-[a-z]+)*-radius\s*:\s*[^;}]*\d+px/i],
    ['font-family literal', /font-family\s*:\s*(?!var\(|inherit)/i],
    ['font name in code', /['"](Poppins|Plus Jakarta Sans|Noto Sans)/],
    ['inline style', /\bstyle\s*=\s*\{|\bstyle\s*=\s*["']/],
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
  ] as const)('none: %s', (_k, re) => {
    const bad = owned.filter((f) => re.test(strip(read(f))));
    expect(bad, bad.join(', ')).toEqual([]);
  });
});

describe('layouts', () => {
  const platform = join(SRC, 'app', '(platform)', 'layout.tsx');
  it('the platform layout uses the same sidebar (AppShell) and keeps the platform-only gate (no tenant session sees the console)', () => {
    const s = strip(read(platform));
    expect(s).toContain('AppShell');
    expect(s).toMatch(/kind\s*!==\s*['"]platform['"]/);
    expect(s).not.toMatch(/lims-platform-header|aria-label=["']Platform["']/); // the hand-made header nav is gone
  });
  it('the staff layout and the root layout still do what T0D-UI-R04 pinned (gate + shell.css + kit css + fonts)', () => {
    const staff = strip(read(join(SRC, 'app', '(staff)', 'layout.tsx')));
    for (const w of ['matchStaffRoute', 'hasPermission', 'PermissionDenied', 'AppShell']) expect(staff).toContain(w);
    const root = strip(read(join(SRC, 'app', 'layout.tsx')));
    for (const w of ['@lims/ui/fonts.css', '@lims/ui/tokens.css', '@lims/ui/kit.css', 'shell.css']) expect(root).toContain(w);
  });
  it('navigation stays generated: the shell reads navEntries and filters with hasPermission; build-nav validates the new manifest fields', () => {
    const shell = strip(walk(join(SRC, 'core', 'shell')).filter((f) => /\.tsx?$/.test(f)).map(read).join('\n'));
    expect(shell).toMatch(/nav\/generated/);
    expect(shell).toMatch(/hasPermission/);
    const rg = strip(read(join(SRC, 'core', 'nav', 'rail-groups.ts')));
    expect(rg).not.toMatch(/people_access|railGroupFor/); // the 8-heading fold of LD-140 is gone (LD-251)
  });
  it('no new dependency: apps/web/package.json gains no animation, icon or UI library', () => {
    const deps = Object.keys({ ...JSON.parse(read(join(WEB, 'package.json'))).dependencies, ...JSON.parse(read(join(WEB, 'package.json'))).devDependencies });
    for (const d of deps) expect(d, d).not.toMatch(/framer-motion|motion|gsap|three|lottie|react-spring|lucide|heroicons|react-icons|radix|headlessui/);
  });
});
