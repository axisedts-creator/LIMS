// @vitest-environment jsdom
// T0D-MSERIES-5 (LD-276, LD-251, LD-250; 13-M-SERIES s5; board spec/program/design-m-series/M1-entry.png + sources/M1-entry.dc.html):
// every staff entry screen on the M1 layout, PRESENTATION ONLY. Actions, validation, session and MFA stay as they are (t12.* keep running).
// CONTRACT chosen by the tester (writer: follow it, or dispute in .orchestra/notes). Class names are the ONLY coupling to the writer:
//   (auth)/layout.tsx  : div.lims-auth-page (flex, wraps)  >  [ div.lims-auth-main  ,  aside.lims-auth-panel ]  (exactly these two children, no band header).
//     div.lims-auth-main  : the Metro Labs <img alt="Metro Labs"> FIRST (once, self-hosted), then {children}, then the footer links (only those whose route exists).
//     aside.lims-auth-panel = the hero. NOT aria-hidden as a whole (the plate keeps its role="img"); every other piece is aria-hidden="true":
//       svg.lims-auth-rings (3 <circle>), div.lims-auth-scene[role=img][aria-label=PLATE_LABEL] > div.lims-auth-plate > 96 x .lims-auth-well,
//       div.lims-auth-mark > (span.lims-auth-mark-ring + <img alt="">), 3 x .lims-auth-chip (Report released, Sample received, QC passed, in this DOM order),
//       div.lims-auth-tagline ("Tap. Test. Track." then "Every result, on time and on the record."). No focusable element inside the panel.
//   screens keep div.lims-auth-card as the form block (h1 inside). Sign-in only: a pill label "Staff sign-in" before the h1, label "Work email", button "Continue",
//     "Forgot password?" inside the Password .lims-label-row. Other screens keep their own h1 and text.
//   the stepper (ol.lims-auth-steps, "From sample to report"), the AuthArt line art (.lims-art), the slim band (.lims-auth-band) and the lockup/wordmark are GONE.
//   footer links + "Patient or partner portal" render only when their route is in contracts/routes.yaml; each missing one is listed in .orchestra/cr/T0D-MSERIES-5*.md (LD-250).
//   CSS (shell.css or any css under apps/web/src or packages/ui/src): see the 'css contract' block. Tokens only (the T0D-UI-R07 lint test runs in the same verify).
// Supersedes m2.entry.test.tsx's card / hero / pill-field assertions and the stepper/band/art/motion assertions of web-style-2/3/4 (see .orchestra/notes/T0D-MSERIES-5-tests.md).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AuthLayout from '@/app/(auth)/layout';
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
const PLATE_LABEL = 'Illustration: a 96-well plate tilted in 3D with wells lighting up in a wave';
const ok = async () => ({ ok: true as const });
const start = async () => ({ ok: true as const, factor_id: '0190f3a2-7b1c-7d3e-8a4f-5b6c7d8e9f01', otpauth_uri: 'otpauth://totp/LIMS:u', qr_svg_base64: 'PHN2Zy8+', secret_base32: 'JBSWY3DPEHPK3PXP' });
const norm = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- the entry screens (each inside the one layout, as the pages do)
interface Screen { id: string; h1: string | null; ui: () => ReactElement }
const SCREENS: Screen[] = [
  { id: 'login', h1: 'Welcome back', ui: () => <LoginForm action={ok} /> },
  { id: 'forgot password', h1: 'Reset your password', ui: () => <ForgotPasswordForm action={ok} /> },
  { id: 'set password (invitation)', h1: 'Welcome to Alpha Diagnostics', ui: () => <SetPasswordForm action={ok} variant="invite" tenantName="Alpha Diagnostics" /> },
  { id: 'set password (reset)', h1: 'Choose a new password', ui: () => <SetPasswordForm action={ok} variant="recovery" /> },
  { id: 'email confirmation landing', h1: null, ui: () => <ConfirmLanding action={async () => ({ ok: false as const, code: 'auth.invite_invalid' })} tokenHash="used" type="invite" /> },
  { id: 'MFA challenge', h1: 'Two-step verification', ui: () => <MfaChallengeForm action={ok} logoutAction={ok} /> },
  { id: 'MFA enrolment', h1: 'Set up two-step verification', ui: () => <MfaEnrolment startAction={start} completeAction={ok} /> },
  { id: 'session expired', h1: 'Session ended', ui: () => <SessionExpiredCard minutes={30} /> },
];
const inLayout = (ui: ReactElement) => render(<AuthLayout><main>{ui}</main></AuthLayout>);
const col = (c: HTMLElement) => c.querySelector('.lims-auth-main') as HTMLElement;
const panel = (c: HTMLElement) => c.querySelector('.lims-auth-panel') as HTMLElement;
const hidden = (el: Element) => el.closest('[aria-hidden="true"]') !== null;
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------- css helpers (rules from every non-test css under apps/web/src and packages/ui/src)
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
const KEYFRAMES = new Set([...CSS.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]!));
const RM = /prefers-reduced-motion\s*:\s*reduce/;
const rulesFor = (cls: RegExp, o: { rm?: boolean } = {}) => RULES.filter((r) => RM.test(r.ctx) === !!o.rm && r.sel.some((s) => cls.test(s)));
const decl = (rules: Rule[], p: string) => rules.flatMap((r) => [...r.body.matchAll(new RegExp(`(?:^|[;\\s])${p}\\s*:\\s*([^;]+)`, 'g'))].map((m) => m[1]!.trim())).at(-1);
const allDecl = (rules: Rule[], p: string) => rules.flatMap((r) => [...r.body.matchAll(new RegExp(`(?:^|[;\\s])${p}\\s*:\\s*([^;]+)`, 'g'))].map((m) => m[1]!.trim()));
const cls = (c: string) => new RegExp(`\\.${c}(?![\\w-])`);
const animOf = (rules: Rule[]) => [...allDecl(rules, 'animation'), ...allDecl(rules, 'animation-name')].join(' ');

// ================================================================ every entry screen: same two-column layout, same left-column style
describe.each(SCREENS)('entry screen: $id', ({ id, h1, ui }) => {
  it('two columns only: left .lims-auth-main + right .lims-auth-panel; no stepper, AuthArt line art, slim band, lockup or wordmark', async () => {
    const { container } = inLayout(ui());
    const page = container.querySelector('.lims-auth-page') as HTMLElement;
    expect([...page.children].map((c) => c.className.split(' ')[0])).toEqual(['lims-auth-main', 'lims-auth-panel']);
    expect(container.querySelector('.lims-auth-band, header.lims-auth-band, .lims-lockup, .lims-wordmark, svg.lims-art, .lims-art, .lims-auth-steps, ol, .lims-auth-panel-body')).toBeNull();
    expect(norm(container.textContent)).not.toMatch(/From sample to report|\bTo authorise\b|\bTo collect\b|\bTo receive\b/);
    expect(id).toBeTruthy();
  });

  it('left column: the Metro Labs logo is the first thing in it (once, self-hosted); the h1 follows with its own copy', async () => {
    const { container } = inLayout(ui());
    const main = col(container);
    const logos = screen.getAllByRole('img', { name: 'Metro Labs' }) as HTMLImageElement[];
    expect(logos).toHaveLength(1);
    expect(main.contains(logos[0]!)).toBe(true);
    expect(logos[0]!.getAttribute('src')).toBeTruthy();
    expect(logos[0]!.getAttribute('src')).not.toMatch(/^(https?:)?\/\//);
    expect(main.querySelector('img')).toBe(logos[0]);
    if (h1) {
      const heads = screen.getAllByRole('heading');
      expect(heads.map((h) => [h.tagName, norm(h.textContent)])).toEqual([['H1', h1]]); // the hero tagline is aria-hidden, so it adds no second heading
      expect(main.contains(heads[0]!)).toBe(true);
      expect(logos[0]!.compareDocumentPosition(heads[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(heads[0]!.closest('.lims-auth-card')).not.toBeNull();
    }
  });

  it('the hero panel is on every screen: rings, plate, mark, three chips in order, tagline', async () => {
    const { container } = inLayout(ui());
    const p = panel(container);
    expect(p).not.toBeNull();
    expect(p.querySelectorAll('.lims-auth-chip')).toHaveLength(3);
    expect(p.querySelector('.lims-auth-plate')).not.toBeNull();
    expect(p.querySelector('.lims-auth-mark')).not.toBeNull();
    expect(p.querySelector('.lims-auth-tagline')).not.toBeNull();
    expect(p.querySelectorAll('svg.lims-auth-rings circle')).toHaveLength(3);
  });

  it('keyboard: every tab stop is in the left column, in reading order; nothing in the hero is focusable', async () => {
    const { container } = inLayout(ui());
    expect(panel(container).querySelectorAll(FOCUSABLE)).toHaveLength(0);
    if (id === 'email confirmation landing') await waitFor(() => screen.getByRole('alert'));
    const u = userEvent.setup();
    const stops: HTMLElement[] = [];
    for (let i = 0; i < 25; i++) {
      await u.tab();
      const a = document.activeElement as HTMLElement;
      if (a === document.body || stops.includes(a)) break;
      stops.push(a);
    }
    for (const s of stops) expect(col(container).contains(s), `${id}: tab stop ${s.outerHTML.slice(0, 80)} is outside the left column`).toBe(true);
    const order = stops.map((s) => [...col(container).querySelectorAll(FOCUSABLE)].indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('axe: zero critical or serious violations (colour contrast is gated by the token build, not jsdom)', async () => {
    const { container } = inLayout(ui());
    if (id === 'email confirmation landing') await waitFor(() => screen.getByRole('alert'));
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 100)}`)).toEqual([]);
  });
});

it('logout page: the same layout, its own h1 "Log out", one primary button', async () => {
  const { default: LogoutPage } = await import('@/app/(auth)/auth/logout/page');
  const { container } = render(<AuthLayout><LogoutPage /></AuthLayout>);
  expect(screen.getAllByRole('heading').map((h) => norm(h.textContent))).toEqual(['Log out']);
  expect(col(container).querySelector('h1')).not.toBeNull();
  expect(container.querySelectorAll('.lims-btn-primary')).toHaveLength(1);
  expect(container.querySelector('.lims-auth-steps, .lims-auth-band, .lims-art')).toBeNull();
  expect(panel(container).querySelectorAll('.lims-auth-chip')).toHaveLength(3);
});

// ================================================================ sign-in exactly as the board
describe('sign-in (M1-entry.png): left column', () => {
  it('order: logo, Staff sign-in pill, Welcome back, the text, Work email, Password row with Forgot password?, Continue', () => {
    const { container } = inLayout(<LoginForm action={ok} />);
    const els = [
      screen.getByRole('img', { name: 'Metro Labs' }),
      screen.getByText('Staff sign-in', { exact: true }),
      screen.getByRole('heading', { level: 1, name: 'Welcome back' }),
      screen.getByText('Sign in with your work email. A one-time code confirms it is you.', { exact: true }),
      screen.getByLabelText(/^work email/i),
      screen.getByLabelText('Password', { exact: true }),
      screen.getByRole('link', { name: 'Forgot password?' }),
      screen.getByRole('button', { name: 'Continue' }),
    ];
    const pos = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    // Forgot password? sits on the label row, so it comes BEFORE the password input in the DOM, after the Work email input
    const [logo, pill, head, text, email, pw, forgot, btn] = els;
    for (const [a, b] of [[logo, pill], [pill, head], [head, text], [text, email], [email, forgot], [forgot, pw], [pw, btn]] as const) expect(pos(a!, b!), `${a!.outerHTML.slice(0, 40)} before ${b!.outerHTML.slice(0, 40)}`).toBe(true);
    expect(pill!.tagName).not.toMatch(/^H\d$/);
    expect(pill!.closest('.lims-auth-card')).not.toBeNull();
    expect(container.querySelectorAll('.lims-btn-primary')).toHaveLength(1);
  });

  it('"Forgot password?" is on the password label row and still points to /auth/forgot', () => {
    inLayout(<LoginForm action={ok} />);
    const row = screen.getByText('Password', { exact: true }).closest('.lims-label-row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByRole('link', { name: 'Forgot password?' }).getAttribute('href')).toBe('/auth/forgot');
    expect(screen.getAllByRole('link', { name: /forgot password/i })).toHaveLength(1);
  });

  it('fields keep names, types and autocomplete; the button submits', () => {
    const { container } = inLayout(<LoginForm action={ok} />);
    const email = container.querySelector('input[name="email"]') as HTMLInputElement;
    const pw = container.querySelector('input[name="password"]') as HTMLInputElement;
    expect([email.type, email.autocomplete, email.maxLength]).toEqual(['email', 'username', 254]);
    expect([pw.type, pw.autocomplete, pw.maxLength]).toEqual(['password', 'current-password', 128]);
    expect(screen.getByRole('button', { name: 'Continue' }).getAttribute('type')).toBe('submit');
  });

  it('keyboard order: Work email, Forgot password?, Password, (Show), Continue, nothing else', async () => {
    inLayout(<LoginForm action={ok} />);
    const u = userEvent.setup();
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      await u.tab();
      const a = document.activeElement as HTMLElement;
      if (a === document.body) break;
      seen.push(a.getAttribute('name') ?? norm(a.textContent));
    }
    expect(seen.filter((s) => s !== 'Show' && s !== 'Hide').slice(0, 4)).toEqual(['email', 'Forgot password?', 'password', 'Continue']);
    expect(seen.slice(4).filter((s) => !['Show', 'Hide', 'Continue'].includes(s))).toEqual([]); // footer / portal links only when their route exists (see the LD-250 block)
  });

  it('behaviour untouched: invalid input shows the same messages and never calls the action; valid input posts once', async () => {
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    inLayout(<LoginForm action={action} next="/lab/worklist" />);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(action).not.toHaveBeenCalled();
    await u.type(screen.getByLabelText(/^work email/i), 'tech@lab.test');
    await u.type(screen.getByLabelText('Password', { exact: true }), 'Synthetic-pass-101');
    await u.click(screen.getByRole('button', { name: 'Continue' }));
    expect(action).toHaveBeenCalledTimes(1);
    const fd = action.mock.calls[0]![0];
    expect([fd.get('email'), fd.get('password'), fd.get('next')]).toEqual(['tech@lab.test', 'Synthetic-pass-101', '/lab/worklist']);
  });
});

// ================================================================ right panel
describe('hero panel (M1-entry.png right side)', () => {
  const render1 = () => inLayout(<LoginForm action={ok} />).container;

  it('plate: ONE role=img with the source label; 96 wells in a tilted 3D plate; nothing else in the hero is announced', () => {
    const c = render1();
    const p = panel(c);
    const roles = p.querySelectorAll('[role]');
    expect([...roles].map((r) => r.getAttribute('role'))).toEqual(['img']);
    const scene = roles[0] as HTMLElement;
    expect(scene.getAttribute('aria-label')).toBe(PLATE_LABEL);
    expect(scene.classList.contains('lims-auth-scene')).toBe(true);
    expect(scene.querySelector('.lims-auth-plate')).not.toBeNull();
    expect(scene.querySelectorAll('.lims-auth-well')).toHaveLength(96);
    expect(p.querySelectorAll('.lims-auth-well')).toHaveLength(96);
    expect(screen.getAllByRole('img').map((i) => i.getAttribute('aria-label') ?? i.getAttribute('alt'))).toEqual(['Metro Labs', PLATE_LABEL]);
  });

  it('wells light up in a wave: staggered (inline custom delay in packages/ui, or nth-child rules)', () => {
    const c = render1();
    const wells = [...c.querySelectorAll('.lims-auth-well')] as HTMLElement[];
    const delays = new Set(wells.map((w) => w.getAttribute('style') ?? ''));
    const nth = rulesFor(/\.lims-auth-well:nth-(child|of-type)/);
    expect(delays.size >= 8 || nth.length >= 8, `distinct inline delays: ${delays.size}, nth rules: ${nth.length}`).toBe(true);
  });

  it('everything decorative is aria-hidden: rings, mark and its pulse ring, the three chips, the tagline', () => {
    const c = render1();
    const p = panel(c);
    for (const sel of ['svg.lims-auth-rings', '.lims-auth-mark', '.lims-auth-mark-ring', '.lims-auth-chip', '.lims-auth-tagline']) {
      const els = [...p.querySelectorAll(sel)];
      expect(els.length, sel).toBeGreaterThan(0);
      for (const e of els) expect(hidden(e), `${sel} must be aria-hidden`).toBe(true);
    }
    for (const img of p.querySelectorAll('img')) expect(img.getAttribute('alt')).toBe('');
    for (const svg of p.querySelectorAll('svg')) expect(hidden(svg) || svg.getAttribute('aria-hidden') === 'true').toBe(true);
  });

  it('the three concentric rings are three circles of different radius around one centre', () => {
    const circles = [...render1().querySelectorAll('.lims-auth-panel svg.lims-auth-rings circle')];
    expect(circles).toHaveLength(3);
    expect(new Set(circles.map((x) => `${x.getAttribute('cx')},${x.getAttribute('cy')}`)).size).toBe(1);
    expect(new Set(circles.map((x) => x.getAttribute('r'))).size).toBe(3);
    for (const x of circles) expect(x.getAttribute('stroke') ?? '').not.toMatch(/#|rgb|hsl/);
  });

  it('three chips in order with the source copy; the QC chip is the lime one; the mark uses a self-hosted image', () => {
    const c = render1();
    const chips = [...c.querySelectorAll('.lims-auth-chip')];
    expect(chips.map((x) => norm(x.textContent))).toEqual(['Report released', 'Sample received', 'QC passed']);
    const mark = c.querySelector('.lims-auth-mark') as HTMLElement;
    expect(mark.querySelector('.lims-auth-mark-ring')).not.toBeNull();
    const img = mark.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBeTruthy();
    expect(img.getAttribute('src')).not.toMatch(/^(https?:)?\/\//);
  });

  it('tagline: "Tap. Test. Track." above "Every result, on time and on the record."', () => {
    const t = render1().querySelector('.lims-auth-tagline') as HTMLElement;
    const text = norm(t.textContent);
    expect(text).toBe('Tap. Test. Track. Every result, on time and on the record.');
    expect(t.querySelector('h2, h1, h3')?.textContent ?? 'Every result, on time and on the record.').toBe('Every result, on time and on the record.');
  });

  it('the hero carries no stepper words and no claims', () => {
    const t = norm(panel(render1()).textContent);
    expect(t).not.toMatch(/Draft|To collect|To receive|In progress|To authorise|Authorised|From sample to report/);
    expect(t).not.toMatch(/\d/);
  });
});

// ================================================================ css contract (rules found in shell.css or any css under apps/web/src, packages/ui/src)
describe('css contract: layout, plate, motion, fields', () => {
  it('the page is a wrapping flex (or auto-fit grid) with a fixed-measure left column and a flexible, clipped hero', () => {
    const page = rulesFor(cls('lims-auth-page'));
    const d = (p: string) => allDecl(page, p).join(' ');
    const flexWrap = /\bflex\b/.test(d('display')) && /\bwrap\b/.test(d('flex-wrap'));
    const grid = /\bgrid\b/.test(d('display')) && /auto-(fit|fill)/.test(d('grid-template-columns'));
    expect(flexWrap || grid, 'wraps below ~1024 px the way the source does').toBe(true);
    expect(decl(rulesFor(cls('lims-auth-panel')), 'overflow')).toMatch(/hidden|clip/);
    expect(decl(rulesFor(cls('lims-auth-panel')), 'position')).toBe('relative');
    expect(decl(rulesFor(cls('lims-auth-panel')), 'min-width') ?? '0').toMatch(/^0/);
    expect(allDecl(rulesFor(cls('lims-auth-panel')), 'display').join(' ')).not.toMatch(/\bnone\b/); // the hero is no longer hidden below 64rem
    expect(RULES.some((r) => r.sel.some((s) => /lims-auth-panel/.test(s)) && /max-width\s*:\s*(63\.\d+|64)rem/.test(r.ctx) && /display\s*:\s*none/.test(r.body))).toBe(false);
  });

  it('hero background: a 145deg linear-gradient from accent (green) through to the lime (accent-brand / accent-highlight), tokens only', () => {
    const bg = [...allDecl(rulesFor(cls('lims-auth-panel')), 'background'), ...allDecl(rulesFor(cls('lims-auth-panel')), 'background-image')].join(' ');
    expect(bg).toMatch(/linear-gradient\(\s*145deg/);
    expect(bg).toMatch(/linear-gradient\((?:[^()]|\([^()]*\))*var\(--lims-accent\)(?:[^()]|\([^()]*\))*var\(--lims-accent-(brand|highlight)\)/);
    expect(bg).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it('plate: 3D (perspective on the scene, preserve-3d on the plate), a tilted resting transform, round wells', () => {
    expect(decl(rulesFor(cls('lims-auth-scene')), 'perspective')).toBeTruthy();
    expect(decl(rulesFor(cls('lims-auth-scene')), 'max-width')).toMatch(/100%/); // never wider than the column: no horizontal scroll at 390 px
    expect(decl(rulesFor(cls('lims-auth-plate')), 'transform-style')).toBe('preserve-3d');
    expect(`${decl(rulesFor(cls('lims-auth-well')), 'border-radius')}`).toMatch(/50%|var\(--lims-radius-full\)/);
  });

  it('the four looping animations exist (plate sway, well wave, chip bob, mark pulse ring) and use keyframes that are defined', () => {
    for (const c of ['lims-auth-plate', 'lims-auth-well', 'lims-auth-chip', 'lims-auth-mark-ring']) {
      const rules = rulesFor(cls(c));
      const a = animOf(rules);
      expect(allDecl(rules, 'animation').join(' ') + allDecl(rules, 'animation-iteration-count').join(' '), `${c} loops`).toMatch(/infinite/);
      const names = [...KEYFRAMES].filter((k) => new RegExp(`(^|[\\s,])${k}([\\s,]|$)`).test(a));
      expect(names.length, `${c}: animation ${a} must name a defined @keyframes (defined: ${[...KEYFRAMES].join(', ')})`).toBeGreaterThan(0);
    }
  });

  it('prefers-reduced-motion: plate stays tilted, plate / wells / chips / pulse ring stop', () => {
    for (const c of ['lims-auth-plate', 'lims-auth-well', 'lims-auth-chip', 'lims-auth-mark-ring']) {
      const rm = rulesFor(cls(c), { rm: true });
      expect(rm.length, `${c}: no rule inside @media (prefers-reduced-motion: reduce)`).toBeGreaterThan(0);
      expect(`${decl(rm, 'animation')} ${decl(rm, 'animation-name')}`, `${c} must stop`).toMatch(/\bnone\b/);
    }
    const t = decl(rulesFor(cls('lims-auth-plate'), { rm: true }), 'transform') ?? '';
    expect(t).toMatch(/rotateX\(/);
    expect(t).toMatch(/rotateZ\(/);
  });

  it('left column fields: 16 px radius token (radius-lg), neutral border, 3 px focus ring; primary button is a full-round pill', () => {
    const field = RULES.filter((r) => !RM.test(r.ctx) && r.sel.some((s) => /\.lims-auth-(card|main)\b.*\.lims-input$/.test(s) && !/:/.test(s.replace(/:not\([^)]*\)/g, ''))));
    expect(decl(field, 'border-radius')).toBe('var(--lims-radius-lg)');
    const bc = decl(field, 'border-color') ?? decl(field, 'border') ?? '';
    expect(bc).toMatch(/var\(--lims-neutral-(200|300|400)\)/);
    const focus = RULES.filter((r) => r.sel.some((s) => /\.lims-auth-(card|main)\b.*\.lims-input:focus(-visible)?$/.test(s)));
    const fb = focus.map((r) => r.body).join(';');
    expect(fb, 'visible 3 px ring on focus').toMatch(/outline\s*:\s*(3px|0?\.1875rem)\s+solid\s+(?!transparent)|box-shadow\s*:[^;]*\b(3px|0?\.1875rem)\b/);
    const btn = RULES.filter((r) => !RM.test(r.ctx) && r.sel.some((s) => /\.lims-auth-(card|main)\b.*\.lims-btn-primary$/.test(s)));
    expect(decl(btn, 'border-radius')).toBe('var(--lims-radius-full)');
    expect(decl(btn, 'width') ?? '100%').toBe('100%');
  });

  it('the white card is gone: the form block has no box border or card background (the board has no card)', () => {
    const card = RULES.filter((r) => !RM.test(r.ctx) && r.sel.some((s) => /^\.lims-auth-card$/.test(s) || /^\.lims-auth-main \.lims-auth-card$/.test(s)));
    expect(decl(card, 'border') ?? '0').toMatch(/^(0|none)\b/);
    expect(decl(card, 'box-shadow') ?? 'none').toBe('none');
  });

  it('no raw colour, pixel radius or inline style in the auth sources (T0D-UI-R07 also runs in the verify)', () => {
    const files = ['layout.tsx'].map((f) => join(WEB, 'src', 'app', '(auth)', f));
    const dir = join(WEB, 'src', 'features', 'admin', 'auth');
    for (const n of readdirSync(dir)) if (n.endsWith('.tsx')) files.push(join(dir, n));
    for (const p of ['login', 'forgot', 'set-password', 'confirm', 'logout', 'session-expired', 'mfa']) files.push(join(WEB, 'src', 'app', '(auth)', 'auth', p, 'page.tsx'));
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      expect(/(?<![\w&.])#[0-9a-fA-F]{3,8}(?![\w-])|\brgba?\(|\bhsla?\(/.test(code), `${f}: raw colour`).toBe(false);
      expect(/\bstyle\s*=\s*(\{|["'])/.test(code), `${f}: inline style`).toBe(false);
      expect(/border\w*Radius\s*:\s*['"]?\d*\.?\d+px/i.test(code), `${f}: pixel radius`).toBe(false);
    }
    const webCss = cssFiles(join(WEB, 'src')).map((f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');
    const authCss = webCss.split('\n').filter((l) => /lims-auth-(plate|well|chip|mark|scene|rings|tagline|panel)/.test(l)).join('\n');
    expect(/(?<![\w&.])#[0-9a-fA-F]{3,8}(?![\w-])|\brgba?\(\s*\d|\bhsla?\(\s*\d/.test(authCss), 'raw colour in a hero rule under apps/web/src (move it to a token or packages/ui)').toBe(false);
    expect(/border-radius\s*:[^;]*\b\d*\.?\d+px/.test(authCss), 'pixel radius in a hero rule under apps/web/src').toBe(false);
  });

  it('the layout no longer imports the AuthArt line art or the placeholder mark', () => {
    const src = readFileSync(join(WEB, 'src', 'app', '(auth)', 'layout.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(src).not.toMatch(/\bAuthArt\b|\bAuthMark\b|lims-auth-steps|lims-auth-band|lims-lockup/);
    expect(src).not.toMatch(/From sample to report/);
  });
});

// ================================================================ LD-250: no stub for a missing target
describe('footer links and the Patient or partner portal button render only when their route exists (LD-250)', () => {
  const routesYaml = readFileSync(join(REPO, 'contracts', 'routes.yaml'), 'utf8');
  const ROUTES = [...routesYaml.matchAll(/\bpath:\s*"?(\/[^"\s,}]*)/g)].map((m) => m[1]!);
  const routeExists = (href: string) => {
    const path = href.split(/[?#]/)[0]!;
    return ROUTES.some((r) => new RegExp(`^${r.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}/?$`).test(path));
  };
  const TARGETS = ['Privacy policy', 'Terms of use', 'Help and status', 'Patient or partner portal'] as const;

  it('a rendered target has a real same-origin href that is in routes.yaml; never "#", "", a javascript: or remote link', () => {
    const { container } = inLayout(<LoginForm action={ok} />);
    for (const t of TARGETS) {
      const a = within(container).queryByRole('link', { name: t }) as HTMLAnchorElement | null;
      if (!a) continue;
      const href = a.getAttribute('href') ?? '';
      expect(href, `${t} href`).toMatch(/^\/[A-Za-z0-9\-._~/{}]*([?#].*)?$/);
      expect(href).not.toBe('#');
      expect(routeExists(href), `${t} -> ${href} is not a route in contracts/routes.yaml (LD-250: no stubs)`).toBe(true);
      expect(col(container).contains(a)).toBe(true);
    }
  });

  it('no target is rendered as a dead control (button, span or disabled link) when its route is missing', () => {
    const { container } = inLayout(<LoginForm action={ok} />);
    for (const t of TARGETS) {
      const el = within(container).queryAllByText(t, { exact: true });
      for (const e of el) expect(e.closest('a[href]'), `${t} must be a real link or absent`).not.toBeNull();
    }
  });

  it('other screens: the footer follows the same rule (links only to existing routes)', () => {
    const { container } = inLayout(<ForgotPasswordForm action={ok} />);
    for (const t of TARGETS) {
      const a = within(container).queryByRole('link', { name: t });
      if (a) expect(routeExists(a.getAttribute('href') ?? ''), t).toBe(true);
    }
  });

  it('each missing target is listed in a nonblocking CR for the lead (.orchestra/cr/T0D-MSERIES-5*.md)', () => {
    const { container } = inLayout(<LoginForm action={ok} />);
    const missing = TARGETS.filter((t) => within(container).queryByRole('link', { name: t }) === null);
    const dir = join(REPO, '.orchestra', 'cr');
    const crs = readdirSync(dir).filter((n) => /^T0D-MSERIES-5.*\.md$/.test(n));
    if (missing.length === 0) return; // every target exists: no CR needed
    expect(crs.length, `missing targets ${missing.join(', ')} need a CR in .orchestra/cr/`).toBeGreaterThan(0);
    const text = crs.map((n) => readFileSync(join(dir, n), 'utf8')).join('\n');
    for (const t of missing) expect(text, `CR must list "${t}"`).toContain(t);
  });
});
