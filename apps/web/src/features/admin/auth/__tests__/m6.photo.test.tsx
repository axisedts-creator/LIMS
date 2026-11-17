// @vitest-environment jsdom
// T0D-MSERIES-6 (LD-287, founder 2026-11-16 20:00 NPT; 13-M-SERIES s5; board spec/program/design-m-series/M1-entry.png): the Metro Labs laboratory photo
// is the background of the right hand hero panel on every entry screen. PRESENTATION ONLY: the plate, chips, mark and tagline stay as T0D-MSERIES-5 built them.
// CONTRACT chosen by the tester (writer: follow it, or dispute in .orchestra/notes). Class names are the ONLY coupling to the writer:
//   packages/ui EntryHero({ markSrc, photoSrc? }): with a non-empty photoSrc the FIRST TWO children of the hero fragment (so the first two children of aside.lims-auth-panel) are
//       1. <img class="lims-auth-photo" src={photoSrc} alt="" aria-hidden="true" loading="lazy" decoding="async" width="768" height="512">   (no tabindex, no style, no srcset)
//       2. <div class="lims-auth-photo-overlay" aria-hidden="true"></div>   (the dark green gradient)
//     with no photoSrc (or an empty one) neither element exists. Everything after them is exactly what M5 rendered. width/height = the real pixel size of lab-hero.webp.
//   apps/web core/shell/brand.ts: `export const HERO_PHOTO = url(heroPhoto)` from a STATIC import of packages/ui/assets/brand/lab-hero.webp, like LOGO_ON_LIGHT and MARK.
//   (auth)/layout.tsx: <EntryHero markSrc={MARK} photoSrc={HERO_PHOTO} />.
//   CSS (shell.css or any css under apps/web/src or packages/ui/src): .lims-auth-photo { position:absolute; inset:0 (or four sides 0); width:100%; height:100%; object-fit:cover;
//       object-position near the middle, no px/rem size, no animation } and .lims-auth-photo-overlay { position:absolute; inset:0; background: linear-gradient(... tokens only ...) }.
//       DOM order puts both behind the plate (no z-index above 0). The panel keeps its M5 145deg gradient (the fallback behind the photo).
//   Contrast: every stop of the overlay, composited over a WHITE photo pixel (worst case), keeps the white tagline AND the lime kicker at >= 4.5:1. The overlay must stay see-through
//       somewhere (alpha < 1 on at least one stop), so the photo is really visible.
// Not testable in jsdom (see e2e/m6-photo.e2e.ts, needs a running app): real paint, mobile download, screenshots.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AuthLayout from '@/app/(auth)/layout';
import * as brand from '@/core/shell/brand';
import { ConfirmLanding } from '../ConfirmLanding';
import { ForgotPasswordForm } from '../ForgotPasswordForm';
import { LoginForm } from '../LoginForm';
import { MfaChallengeForm } from '../MfaChallengeForm';
import { MfaEnrolment } from '../MfaEnrolment';
import { SessionExpiredCard } from '../SessionExpiredCard';
import { SetPasswordForm } from '../SetPasswordForm';

vi.mock('@/features/admin/auth/actions', () => ({ logoutAction: vi.fn(), loginStaffAction: vi.fn() }));

afterEach(cleanup);

const WEB = join(import.meta.dirname, '..', '..', '..', '..', '..'); // apps/web
const REPO = join(WEB, '..', '..');
const ASSET = join(REPO, 'packages', 'ui', 'assets', 'brand', 'lab-hero.webp');
const PLATE_LABEL = 'Illustration: a 96-well plate tilted in 3D with wells lighting up in a wave';
const ok = async () => ({ ok: true as const });
const start = async () => ({ ok: true as const, factor_id: '0190f3a2-7b1c-7d3e-8a4f-5b6c7d8e9f01', otpauth_uri: 'otpauth://totp/LIMS:u', qr_svg_base64: 'PHN2Zy8+', secret_base32: 'JBSWY3DPEHPK3PXP' });
const HERO_PHOTO = (brand as Record<string, unknown>).HERO_PHOTO as string | undefined;
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

interface Screen { id: string; ui: () => ReactElement }
const SCREENS: Screen[] = [
  { id: 'login', ui: () => <LoginForm action={ok} /> },
  { id: 'forgot password', ui: () => <ForgotPasswordForm action={ok} /> },
  { id: 'set password (invitation)', ui: () => <SetPasswordForm action={ok} variant="invite" tenantName="Alpha Diagnostics" /> },
  { id: 'set password (reset)', ui: () => <SetPasswordForm action={ok} variant="recovery" /> },
  { id: 'email confirmation landing', ui: () => <ConfirmLanding action={async () => ({ ok: false as const, code: 'auth.invite_invalid' })} tokenHash="used" type="invite" /> },
  { id: 'MFA challenge', ui: () => <MfaChallengeForm action={ok} logoutAction={ok} /> },
  { id: 'MFA enrolment', ui: () => <MfaEnrolment startAction={start} completeAction={ok} /> },
  { id: 'session expired', ui: () => <SessionExpiredCard minutes={30} /> },
];
const inLayout = (ui: ReactElement) => render(<AuthLayout><main>{ui}</main></AuthLayout>);
const panel = (c: HTMLElement) => c.querySelector('.lims-auth-panel') as HTMLElement;
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
const SAME_ORIGIN = /^(?!(?:[a-z][a-z0-9+.-]*:)?\/\/)(?!data:)(?!blob:)(?![a-z][a-z0-9+.-]*:)\S+$/i;

// ---------------------------------------------------------------- css helpers (same method as m5.entry.test.tsx)
const cssFiles = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (!['node_modules', '__tests__', '.next', 'dist', 'fixtures'].includes(n)) cssFiles(p, out); } else if (n.endsWith('.css')) out.push(p);
  }
  return out;
};
const CSS = [...cssFiles(join(WEB, 'src')), ...cssFiles(join(REPO, 'packages', 'ui', 'src'))].map((f) => readFileSync(f, 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
interface Rule { ctx: string; sel: string[]; body: string }
const block = (s: string, from: number) => {
  let d = 0, j = from;
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}' && --d === 0) break; }
  return { body: s.slice(from + 1, j), end: j + 1 };
};
const parse = (s: string): Rule[] => {
  const out: Rule[] = [];
  let i = 0;
  while (i < s.length) {
    const o = s.indexOf('{', i);
    if (o < 0) break;
    const pre = s.slice(i, o).trim();
    const { body, end } = block(s, o);
    if (/^@(media|supports|container)\b/.test(pre)) for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ ctx: pre, sel: m[1]!.split(',').map((x) => x.trim().replace(/\s+/g, ' ')), body: m[2]! });
    else if (!pre.startsWith('@')) out.push({ ctx: '', sel: pre.split(',').map((x) => x.trim().replace(/\s+/g, ' ')), body });
    i = end;
  }
  return out;
};
const RULES = parse(CSS);
const cls = (c: string) => new RegExp(`\\.${c}(?![\\w-])`);
const rulesOf = (c: string) => RULES.filter((r) => r.sel.some((s) => cls(c).test(s)));
const allDecl = (rules: Rule[], p: string) => rules.flatMap((r) => [...r.body.matchAll(new RegExp(`(?:^|[;\\s])${p}\\s*:\\s*([^;]+)`, 'g'))].map((m) => m[1]!.trim()));
const decl = (rules: Rule[], p: string) => allDecl(rules, p).at(-1);
const PHOTO = rulesOf('lims-auth-photo');
const OVERLAY = rulesOf('lims-auth-photo-overlay');

// ---------------------------------------------------------------- token + contrast helpers (tokens.json is the source; dist css is generated from it)
const TOKENS = JSON.parse(readFileSync(join(REPO, 'packages', 'ui', 'tokens', 'tokens.json'), 'utf8')).color as Record<string, Record<string, string>>;
const hexOf = (name: string): string | undefined => {
  const m = /^lims-([a-z]+)(?:-(.+))?$/.exec(name);
  if (!m) return undefined;
  const v = TOKENS[m[1]!]?.[m[2] ?? 'default'];
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined;
};
type RGB = [number, number, number];
const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const lum = (c: RGB) => { const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }) as RGB; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: RGB, b: RGB) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
const splitTop = (s: string) => { const out: string[] = []; let d = 0, cur = ''; for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
const gradientOf = (rules: Rule[]) => [...allDecl(rules, 'background'), ...allDecl(rules, 'background-image')].find((v) => /linear-gradient\(/.test(v));
/** every colour stop of the overlay as { rgb, alpha } or an error string naming the unparseable stop */
const stopsOf = (g: string): { c: RGB; a: number; src: string }[] | string => {
  const inner = g.slice(g.indexOf('linear-gradient(') + 'linear-gradient('.length, g.lastIndexOf(')'));
  const parts = splitTop(inner).filter((p) => !/^(to\s|-?[\d.]+(deg|turn|rad|grad)\b)/.test(p));
  const out: { c: RGB; a: number; src: string }[] = [];
  for (const p of parts) {
    const stop = p.replace(/\s+-?[\d.]+%\s*$/, '').trim();
    let m = /^var\(--(lims-[\w-]+)\)$/.exec(stop);
    if (m) { const h = hexOf(m[1]!); if (!h) return `unknown token --${m[1]} in "${p}"`; out.push({ c: rgb(h), a: 1, src: p }); continue; }
    m = /^color-mix\(\s*in srgb\s*,\s*var\(--(lims-[\w-]+)\)\s*([\d.]+)%\s*,\s*transparent\s*\)$/.exec(stop);
    if (m) { const h = hexOf(m[1]!); if (!h) return `unknown token --${m[1]} in "${p}"`; out.push({ c: rgb(h), a: parseFloat(m[2]!) / 100, src: p }); continue; }
    m = /^color-mix\(\s*in srgb\s*,\s*var\(--(lims-[\w-]+)\)\s*(?:([\d.]+)%)?\s*,\s*var\(--(lims-[\w-]+)\)\s*\)$/.exec(stop);
    if (m) {
      const [h1, h2] = [hexOf(m[1]!), hexOf(m[3]!)];
      if (!h1 || !h2) return `unknown token in "${p}"`;
      const w = m[2] === undefined ? 0.5 : parseFloat(m[2]) / 100;
      const [a, b] = [rgb(h1), rgb(h2)];
      out.push({ c: [0, 1, 2].map((i) => a[i]! * w + b[i]! * (1 - w)) as RGB, a: 1, src: p });
      continue;
    }
    return `unsupported stop "${p}" (use var(--lims-token), color-mix(in srgb, var(--lims-token) N%, transparent) or color-mix(in srgb, var(--lims-a) N%, var(--lims-b)))`;
  }
  return out;
};

// ================================================================ the asset and the one export
describe('asset and brand.ts (done_when 1, 2, 5)', () => {
  it('HERO_PHOTO is exported by brand.ts: a same-origin URL of lab-hero.webp, different from the logo and the mark', () => {
    expect(typeof HERO_PHOTO).toBe('string');
    expect(HERO_PHOTO).toMatch(SAME_ORIGIN);
    expect(HERO_PHOTO).toMatch(/lab-hero[^/]*\.webp(\?.*)?$/);
    expect(HERO_PHOTO).not.toBe(brand.LOGO_ON_LIGHT);
    expect(HERO_PHOTO).not.toBe(brand.MARK);
  });

  it('brand.ts builds it like LOGO_ON_LIGHT and MARK: static import from packages/ui/assets/brand/lab-hero.webp, url() helper, no remote URL, no data URI', () => {
    const src = readFileSync(join(WEB, 'src', 'core', 'shell', 'brand.ts'), 'utf8');
    const code = stripComments(src);
    expect(code).toMatch(/^import \w+ from '(?:\.\.\/)+packages\/ui\/assets\/brand\/lab-hero\.webp';$/m);
    expect(code).toMatch(/^export const HERO_PHOTO = url\(\w+\);$/m);
    expect(code).toMatch(/^export const LOGO_ON_LIGHT = url\(onLight\);$/m); // the existing exports stay
    expect(code).toMatch(/^export const MARK = url\(mark\);$/m);
    expect(code).not.toMatch(/https?:\/\/|\bdata:|\bfetch\(|require\(|import\(/);
  });

  it('CSP img-src is unchanged: self and data: only (no new origin for the photo)', () => {
    const mw = readFileSync(join(WEB, 'src', 'middleware.ts'), 'utf8');
    const lines = mw.split('\n').filter((l) => l.includes('img-src'));
    expect(lines.some((l) => l.includes(`"img-src 'self' data:",`))).toBe(true);
    expect(mw).not.toMatch(/img-src[^\n]*https?:/);
  });

  it('the layout passes it: <EntryHero markSrc={MARK} photoSrc={HERO_PHOTO} />, no inline style, no raw colour', () => {
    const code = stripComments(readFileSync(join(WEB, 'src', 'app', '(auth)', 'layout.tsx'), 'utf8'));
    expect(code).toMatch(/import \{[^}]*\bHERO_PHOTO\b[^}]*\} from '@\/core\/shell\/brand'/);
    expect(code).toMatch(/<EntryHero\b[^>]*\bmarkSrc=\{MARK\}[^>]*\bphotoSrc=\{HERO_PHOTO\}|<EntryHero\b[^>]*\bphotoSrc=\{HERO_PHOTO\}[^>]*\bmarkSrc=\{MARK\}/);
    expect(/\bstyle\s*=\s*(\{|["'])|#[0-9a-fA-F]{3,8}\b|\brgba?\(|https?:\/\//.test(code)).toBe(false);
  });
});

// ================================================================ the photo on every entry screen
describe.each(SCREENS)('entry screen: $id', ({ id, ui }) => {
  it('the hero panel starts with the decorative photo (empty alt, aria-hidden, lazy, async, 768 x 512, same-origin src) and its overlay', () => {
    const { container } = inLayout(ui());
    const p = panel(container);
    const photos = p.querySelectorAll('img.lims-auth-photo');
    expect(photos, `${id}: exactly one photo`).toHaveLength(1);
    const img = photos[0] as HTMLImageElement;
    expect(p.children[0]).toBe(img);
    const overlay = p.children[1] as HTMLElement;
    expect(overlay.tagName).toBe('DIV');
    expect(overlay.classList.contains('lims-auth-photo-overlay')).toBe(true);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.children).toHaveLength(0);
    expect(img.getAttribute('alt')).toBe(''); // present and empty (decorative), not missing
    expect(img.getAttribute('aria-hidden')).toBe('true');
    expect(img.hasAttribute('tabindex')).toBe(false);
    expect(img.hasAttribute('role')).toBe(false);
    expect(img.hasAttribute('style')).toBe(false);
    expect(img.hasAttribute('srcset')).toBe(false);
    expect(img.closest('a, button')).toBeNull();
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['768', '512']);
    expect(img.getAttribute('src')).toBe(HERO_PHOTO);
    expect(img.getAttribute('src')).toMatch(SAME_ORIGIN);
  });

  it('only the background changed: rings, plate, mark, three chips, tagline follow in the M5 order; still no focusable element, one plate role=img, two images announced (logo, plate)', () => {
    const { container } = inLayout(ui());
    const p = panel(container);
    expect([...p.children].map((c) => (c.getAttribute('class') ?? '').split(' ')[0]).filter((c) => !/^lims-auth-photo/.test(c))).toEqual(
      ['lims-auth-rings', 'lims-auth-scene', 'lims-auth-mark', 'lims-auth-chip', 'lims-auth-chip', 'lims-auth-chip', 'lims-auth-tagline'],
    );
    expect(p.querySelectorAll('.lims-auth-well')).toHaveLength(96);
    expect(p.querySelectorAll(FOCUSABLE)).toHaveLength(0);
    expect([...p.querySelectorAll('[role]')].map((r) => r.getAttribute('role'))).toEqual(['img']);
    expect(screen.getAllByRole('img').map((i) => i.getAttribute('aria-label') ?? i.getAttribute('alt'))).toEqual(['Metro Labs', PLATE_LABEL]);
    expect(p.querySelector('.lims-auth-mark img')?.getAttribute('alt')).toBe('');
    expect(container.querySelectorAll('.lims-auth-page > *')).toHaveLength(2);
  });
});

it('every other entry screen too: logout page gets the photo from the same layout', async () => {
  const { default: LogoutPage } = await import('@/app/(auth)/auth/logout/page');
  const { container } = render(<AuthLayout><LogoutPage /></AuthLayout>);
  expect(panel(container).querySelectorAll('img.lims-auth-photo')).toHaveLength(1);
});

describe('axe on the sign-in screen with the photo (done_when 7)', () => {
  it('no violation of any impact (colour contrast is gated by the contrast test below, not jsdom)', async () => {
    const { container } = inLayout(<LoginForm action={ok} />);
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes[0]?.html.slice(0, 100)}`)).toEqual([]);
    expect(container.querySelector('img.lims-auth-photo'), 'the photo must be in the audited tree').not.toBeNull();
  });
});

// ================================================================ css contract
describe('css: photo and overlay (done_when 3, 4, 5, 6)', () => {
  it('photo: absolute, fills the panel, object-fit cover, object-position near the middle; no px/rem size, no animation, never display:none', () => {
    expect(PHOTO.length, 'a .lims-auth-photo rule').toBeGreaterThan(0);
    expect(decl(PHOTO, 'position')).toBe('absolute');
    const inset = decl(PHOTO, 'inset');
    const sides = ['top', 'right', 'bottom', 'left'].every((s) => /^0(px|rem)?$/.test(decl(PHOTO, s) ?? 'x'));
    expect(/^0(px|rem)?$/.test(inset ?? 'x') || sides, 'inset: 0 (or all four sides 0)').toBe(true);
    expect(decl(PHOTO, 'width')).toBe('100%');
    expect(decl(PHOTO, 'height')).toBe('100%');
    expect(decl(PHOTO, 'object-fit')).toBe('cover');
    const pos = (decl(PHOTO, 'object-position') ?? '').split(/\s+/);
    expect(pos.length).toBeGreaterThan(0);
    for (const v of pos) {
      const n = v === 'center' ? 50 : /^(\d+(?:\.\d+)?)%$/.test(v) ? parseFloat(v) : NaN;
      expect(n, `object-position "${decl(PHOTO, 'object-position')}" must be centre or percentages between 30% and 70% so the technicians stay visible`).toBeGreaterThanOrEqual(30);
      expect(n).toBeLessThanOrEqual(70);
    }
    const body = PHOTO.map((r) => r.body).join(';');
    expect(/(?<![\w.-])\d*\.?[1-9]\d*(px|rem|em|vw|vh)\b/.test(body), 'no fixed size in the photo rule: replacing the file with a larger one must need no css change').toBe(false);
    expect(allDecl([...PHOTO, ...OVERLAY], 'animation').join(' ') + allDecl([...PHOTO, ...OVERLAY], 'animation-name').join(' ')).not.toMatch(/\S/); // static: nothing to stop for reduced motion
    expect(PHOTO.concat(OVERLAY).some((r) => /display\s*:\s*none/.test(r.body)), 'the panel stays stacked, not hidden, on small screens (M5 behaviour); lazy loading keeps it cheap').toBe(false);
  });

  it('overlay: absolute, fills the panel, a linear-gradient built only from var(--lims-*) tokens (no hex, rgb, hsl, named colour), at least one dark green stop', () => {
    expect(OVERLAY.length, 'a .lims-auth-photo-overlay rule').toBeGreaterThan(0);
    expect(decl(OVERLAY, 'position')).toBe('absolute');
    const sides = ['top', 'right', 'bottom', 'left'].every((s) => /^0(px|rem)?$/.test(decl(OVERLAY, s) ?? 'x'));
    expect(/^0(px|rem)?$/.test(decl(OVERLAY, 'inset') ?? 'x') || sides, 'inset: 0').toBe(true);
    const body = OVERLAY.map((r) => r.body).join(';');
    expect(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\bhwb\(|\blab\(|\boklch\(|\b(black|white|green|darkgreen|forestgreen)\b/i.test(body), 'raw colour in the overlay').toBe(false);
    expect(/\burl\(|https?:\/\/|@import/.test(body)).toBe(false);
    const g = gradientOf(OVERLAY);
    expect(g, 'background: linear-gradient(...)').toBeTruthy();
    const tokens = [...g!.matchAll(/var\(--(lims-[\w-]+)\)/g)].map((m) => m[1]!);
    expect(tokens.length).toBeGreaterThan(1);
    for (const t of tokens) expect(hexOf(t), `--${t} must be a colour token of tokens.json`).toBeTruthy();
    expect(tokens.some((t) => /^lims-(accent|accent-hover|neutral-900)$/.test(t)), 'dark green stops from accent / accent-hover / neutral-900').toBe(true);
  });

  it('z-order: photo and overlay sit behind the plate, chips, mark and tagline (first in the DOM, no z-index above 0)', () => {
    for (const z of allDecl([...PHOTO, ...OVERLAY], 'z-index')) expect(parseInt(z, 10)).toBeLessThanOrEqual(0);
    const panelRules = rulesOf('lims-auth-panel').filter((r) => r.sel.some((s) => /^\.lims-auth-panel$/.test(s)));
    expect(decl(panelRules, 'position')).toBe('relative');
    expect(decl(panelRules, 'overflow')).toMatch(/hidden|clip/);
    const bg = [...allDecl(panelRules, 'background'), ...allDecl(panelRules, 'background-image')].join(' ');
    expect(bg, 'the M5 145deg gradient stays on the panel as the fallback behind the photo').toMatch(/linear-gradient\(\s*145deg/);
  });

  it('contrast: on the WORST case photo pixel (pure white) every overlay stop keeps the white tagline and the lime kicker at >= 4.5:1, and the photo stays visible (alpha < 1 somewhere)', () => {
    const g = gradientOf(OVERLAY);
    expect(g, 'overlay gradient').toBeTruthy();
    const opacity = parseFloat(decl(OVERLAY, 'opacity') ?? '1');
    expect(Number.isFinite(opacity) && opacity > 0 && opacity <= 1).toBe(true);
    const stops = stopsOf(g!);
    expect(typeof stops, String(stops)).toBe('object');
    const white = rgb(hexOf('lims-neutral-0')!);
    const lime = rgb(hexOf('lims-accent-pop')!);
    const report: string[] = [];
    for (const s of stops as { c: RGB; a: number; src: string }[]) {
      const a = s.a * opacity;
      const over = [0, 1, 2].map((i) => s.c[i]! * a + 255 * (1 - a)) as RGB;
      const [tw, tl] = [ratio(white, over), ratio(lime, over)];
      report.push(`${s.src}: white ${tw.toFixed(2)}, lime ${tl.toFixed(2)}`);
      expect(tw, `tagline white on ${s.src} over a white photo pixel (${report.join(' | ')})`).toBeGreaterThanOrEqual(4.5);
      expect(tl, `kicker lime on ${s.src} over a white photo pixel (${report.join(' | ')})`).toBeGreaterThanOrEqual(4.5);
    }
    expect((stops as { a: number }[]).some((s) => s.a * opacity < 0.98), 'a fully opaque overlay hides the photo').toBe(true);
  });

  it('reduced motion: nothing about the photo moves, and the M5 rule that zeroes every animation on the auth page is still there', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.lims-auth-page \*/);
    expect(RULES.some((r) => /prefers-reduced-motion/.test(r.ctx) && r.sel.some((s) => /lims-auth-photo/.test(s)) && /animation\s*:\s*(?!none)/.test(r.body))).toBe(false);
  });

  it('no raw colour, inline style or url() in any css rule that mentions the photo (T0D-UI-R07 also runs in the verify)', () => {
    const lines = CSS.split('\n').filter((l) => /lims-auth-photo/.test(l)).join('\n');
    expect(lines).toMatch(/lims-auth-photo/);
    expect(/(?<![\w&.])#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d|\burl\(|https?:\/\//.test(lines)).toBe(false);
  });
});

// ================================================================ no remote image anywhere in the sources
describe('no remote image URL in apps/web/src or packages/ui/src (done_when 2, 7)', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!existsSync(dir)) return out;
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) { if (!['node_modules', '__tests__', '.next', 'dist', 'fixtures', 'coverage'].includes(n)) walk(p, out); } else if (/\.(tsx?|jsx?|mjs|css)$/.test(n) && !/\.(test|spec)\./.test(n)) out.push(p);
    }
    return out;
  };
  const files = [...walk(join(WEB, 'src')), ...walk(join(REPO, 'packages', 'ui', 'src'))];
  it('scans a real set of source files', () => { expect(files.length).toBeGreaterThan(50); });
  it('no <img>/src/srcSet/poster/url()/image-set() points at http(s)://, //host or blob:', () => {
    const bad: string[] = [];
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf8'));
      const re = [
        /<img\b[^>]*\bsrc\s*=\s*["'{`]\s*["'`]?\s*(?:https?:)?\/\/[^\s"'`}]/i,
        /\bsrc(?:Set)?\s*[=:]\s*["'`]\s*(?:https?:)?\/\/[a-z0-9]/i,
        /\burl\(\s*["']?\s*(?:https?:)?\/\/[a-z0-9]/i,
        /\bimage-set\(/i,
        /\bsrc\s*[=:]\s*\{?\s*["'`]blob:/i,
      ];
      for (const r of re) if (r.test(code)) bad.push(`${f.replace(REPO, '')}: ${r}`);
    }
    expect(bad).toEqual([]);
  });
  it('the hero and the layout carry no image URL literal at all: the photo comes only through photoSrc', () => {
    for (const f of [join(REPO, 'packages', 'ui', 'src', 'components', 'EntryHero', 'EntryHero.tsx'), join(WEB, 'src', 'app', '(auth)', 'layout.tsx')]) {
      const code = stripComments(readFileSync(f, 'utf8'));
      expect(/["'`][^"'`\s]*\.(webp|png|jpe?g|gif|avif|svg)["'`]/i.test(code.replace(/^import .*$/gm, '')), `${f}: image file literal`).toBe(false);
      expect(/https?:\/\/|\bdata:image/.test(code), `${f}: remote URL or data URI`).toBe(false);
    }
  });
});
